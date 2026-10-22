import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Ready } from '../shared/ready'
import { ReadyKeeper, type KeeperDeps, type KernelWatch } from './readiness'
import type { Runner } from './ready'

const root = mkdtempSync(join(tmpdir(), 'torno-readiness-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function bin(name: string, body = '#!/bin/sh\nexit 0\n'): string {
  const dir = mkdtempSync(join(root, 'bin-'))
  writeFileSync(join(dir, name), body)
  chmodSync(join(dir, name), 0o755)
  return dir
}

/** A kernel that answers when the test says. */
function kernel(): KernelWatch & { up: (versions: Record<string, string>) => void; fail: (message: string) => void; exit: () => void } {
  let up!: (r: { versions: Record<string, string> }) => void
  let fail!: (e: Error) => void
  let exit: (code: number | null) => void = () => {}
  const ready = new Promise<{ versions: Record<string, string> }>((resolve, reject) => {
    up = resolve
    fail = reject
  })
  return { ready, onExit: (cb) => (exit = cb), up: (versions) => up({ versions }), fail: (m) => fail(new Error(m)), exit: () => exit(1) }
}

function keeper(over: Partial<KeeperDeps> = {}, calls: string[] = []): ReadyKeeper {
  const run: Runner = async (file, args) => {
    calls.push([file, ...args].join(' '))
    return args.includes('status') ? { code: 0, out: '{"loggedIn":true}' } : { code: 0, out: '9.9.9' }
  }
  const dir = bin('claude')
  return new ReadyKeeper({
    probe: { command: join(dir, 'claude'), args: [] },
    path: () => dir,
    askCli: true,
    run,
    own: join(root, 'no-env'),
    make: { command: ['uv', 'sync'], env: {}, cwd: root },
    ...over
  })
}

const next = (k: ReadyKeeper): Promise<Ready> => new Promise((resolve) => k.once('changed', resolve))

describe('ReadyKeeper.get', () => {
  it('asks the CLI once, and again only when asked to', async () => {
    const calls: string[] = []
    const k = keeper({}, calls)
    await k.get()
    await k.get()
    const asked = calls.filter((c) => c.includes('--version') || c.includes('status')).length
    expect(asked).toBe(2)
    await k.get(true)
    expect(calls.filter((c) => c.includes('--version') || c.includes('status')).length).toBe(4)
  })

  it('has the PATH it looked on, the environment and no kernel without a workspace', async () => {
    const ready = await keeper().get()
    expect(ready.searched).toBeTruthy()
    expect(ready.environment).toMatchObject({ kind: 'torno', made: false })
    expect(ready.kernel).toEqual({ state: 'none' })
    expect(ready.making).toEqual({ state: 'idle' })
  })
})

describe('the kernel of the open workspace', () => {
  it('is starting, then ready with its versions, and each is told', async () => {
    const k = keeper()
    const watch = kernel()
    const starting = next(k)
    k.opened({ root, hasProject: false }, watch)
    expect((await starting).kernel).toEqual({ state: 'starting' })
    const up = next(k)
    watch.up({ build123d: '0.13.0', python: '3.12.1' })
    expect((await up).kernel).toEqual({ state: 'ready', versions: { build123d: '0.13.0', python: '3.12.1' } })
  })

  it('fails with the kernel\'s own words', async () => {
    const k = keeper()
    const watch = kernel()
    k.opened({ root, hasProject: false }, watch)
    await next(k)
    const failed = next(k)
    watch.fail('kernel stopped\ncould not run uv: spawn uv ENOENT')
    expect((await failed).kernel).toEqual({ state: 'failed', reason: 'kernel stopped\ncould not run uv: spawn uv ENOENT' })
  })

  it('says a workspace with a project and no .venv has no environment of its own', async () => {
    const k = keeper()
    const ws = mkdtempSync(join(root, 'ws-'))
    k.opened({ root: ws, hasProject: true }, kernel())
    const ready = await k.get()
    expect(ready.environment).toEqual({ kind: 'workspace', dir: join(ws, '.venv'), made: false })
  })

  it('hears nothing from a workspace that was left', async () => {
    const k = keeper()
    const old = kernel()
    k.opened({ root, hasProject: false }, old)
    k.closed()
    old.up({ build123d: '0.13.0' })
    await new Promise((r) => setTimeout(r, 20))
    expect((await k.get()).kernel).toEqual({ state: 'none' })
  })

  it('says it stopped when it was up and went', async () => {
    const k = keeper()
    const watch = kernel()
    k.opened({ root, hasProject: false }, watch)
    watch.up({ build123d: '0.13.0' })
    await new Promise((r) => setTimeout(r, 20))
    watch.exit()
    await new Promise((r) => setTimeout(r, 20))
    expect((await k.get()).kernel).toMatchObject({ state: 'failed' })
  })
})

describe('ReadyKeeper.makeNow', () => {
  /** A `uv` that prints two lines and makes the environment it is given as the kernel's would be. */
  const uvThatMakes = (own: string): string =>
    bin('uv', `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.9.1"; exit 0; fi\necho "Resolved 3 packages" >&2\nmkdir -p ${own}/lib/python3.12/site-packages/build123d\necho home > ${own}/pyvenv.cfg\necho "Installed 3 packages" >&2\n`)

  it('makes torno\'s own environment with uv and tells its lines, then is idle with the environment made', async () => {
    const own = join(root, 'made-env')
    const dir = uvThatMakes(own)
    const k = keeper({ own, path: () => dir, make: { command: ['uv', 'sync', '--frozen'], env: {}, cwd: root } })
    const seen: Ready[] = []
    k.on('changed', (r: Ready) => seen.push(r))
    await k.makeNow()
    await new Promise((r) => setTimeout(r, 30))
    const progress = seen.filter((r) => r.making.state === 'making').flatMap((r) => (r.making.state === 'making' ? r.making.lines : []))
    expect(progress).toContain('Resolved 3 packages')
    expect(existsSync(join(own, 'pyvenv.cfg'))).toBe(true)
    const ready = await k.get()
    expect(ready.making).toEqual({ state: 'idle' })
    expect(ready.environment.made).toBe(true)
  })

  it('refuses a workspace\'s own environment, and does nothing', async () => {
    const own = join(root, 'never-env')
    const dir = uvThatMakes(own)
    const ws = mkdtempSync(join(root, 'ws-'))
    const k = keeper({ own, path: () => dir })
    k.opened({ root: ws, hasProject: true }, kernel())
    await expect(k.makeNow()).rejects.toThrow(/torno never makes it/)
    expect(existsSync(own)).toBe(false)
  })

  it('refuses while the kernel is starting (it is making the environment itself) and without uv', async () => {
    const own = join(root, 'wait-env')
    const k = keeper({ own, path: () => bin('uv') })
    k.opened({ root, hasProject: false }, kernel())
    await expect(k.makeNow()).rejects.toThrow(/starting/)
    const none = keeper({ own, path: () => mkdtempSync(join(root, 'empty-')) })
    await expect(none.makeNow()).rejects.toThrow(/uv was not found on PATH/)
  })

  it('says why when uv fails, keeps the lines, and can be asked again', async () => {
    const own = join(root, 'failing-env')
    const dir = bin('uv', '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "error: failed to fetch build123d: network unreachable" >&2\nexit 2\n')
    const k = keeper({ own, path: () => dir })
    await expect(k.makeNow()).rejects.toThrow(/network unreachable/)
    const ready = await k.get()
    expect(ready.making).toMatchObject({ state: 'failed', reason: expect.stringContaining('network unreachable') })
    expect(existsSync(own)).toBe(false)
  })

  it('is not started twice', async () => {
    const own = join(root, 'twice-env')
    const dir = bin('uv', `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nsleep 0.3\nmkdir -p ${own}/lib/python3.12/site-packages/build123d\necho home > ${own}/pyvenv.cfg\n`)
    const k = keeper({ own, path: () => dir })
    const first = k.makeNow()
    await new Promise((r) => setTimeout(r, 100))
    await k.makeNow() // returns at once: one is under way
    expect((await k.get()).making.state).toBe('making')
    await first
    expect((await k.get()).environment.made).toBe(true)
  })

  it('does nothing when it is made already', async () => {
    const own = join(root, 'there-env')
    mkdirSync(join(own, 'lib', 'python3.12', 'site-packages', 'build123d'), { recursive: true })
    writeFileSync(join(own, 'pyvenv.cfg'), '')
    const dir = bin('uv', '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ntouch ' + join(root, 'uv-ran') + '\n')
    const k = keeper({ own, path: () => dir })
    await k.makeNow()
    expect(existsSync(join(root, 'uv-ran'))).toBe(false)
  })
})

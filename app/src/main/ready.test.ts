import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkTools, environmentOf, makeEnvironment, ownEnvironmentMade, runCommand, type Runner } from './ready'

const fakeAgent = resolve(__dirname, '../../test/fake-agent.mjs')
const root = mkdtempSync(join(tmpdir(), 'torno-ready-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A folder on a PATH with a script in it that is the command, executable. */
function binWith(name: string, body = '#!/bin/sh\nexit 0\n'): string {
  const dir = mkdtempSync(join(root, 'bin-'))
  writeFileSync(join(dir, name), body)
  chmodSync(join(dir, name), 0o755)
  return dir
}
const empty = (): string => mkdtempSync(join(root, 'empty-'))

/** The runner of a test of the check: the real one, the stand-in answering as the CLI does. */
const standIn =
  (env: Record<string, string> = {}): Runner =>
  (file, args, ms) =>
    runCommand(file, args, ms, { ...process.env, ...env })

const cli = { command: process.execPath, args: [fakeAgent] }
const base = { cli, uvCommand: 'uv', askCli: true, timeoutMs: 3000, tested: { min: '2.1.300', max: '2.1.301' } } as const

describe('checkTools', () => {
  it('finds neither claude nor uv on a PATH that has none, and runs nothing', async () => {
    const calls: string[] = []
    const run: Runner = async (file) => (calls.push(file), null)
    const found = await checkTools({ ...base, cli: { command: 'claude', args: [] }, path: empty(), run })
    expect(found.claude).toMatchObject({ command: 'claude', path: null })
    expect(found.uv).toEqual({ path: null })
    expect(calls).toEqual([])
  })

  it('finds a command named by a path that is not a file, as missing', async () => {
    const found = await checkTools({ ...base, cli: { command: join(root, 'no-such-claude'), args: [] }, path: empty(), run: standIn() })
    expect(found.claude.path).toBeNull()
    expect(found.claude.command).toBe(join(root, 'no-such-claude'))
  })

  it('finds both, with the version and the account the CLI gives', async () => {
    const dir = binWith('uv', '#!/bin/sh\necho "uv 0.9.1 (abc 2025-10-01)"\n')
    const found = await checkTools({ ...base, path: `${dir}:${join(process.execPath, '..')}`, run: standIn() })
    expect(found.claude).toMatchObject({ path: process.execPath, version: '2.1.300', account: 'signed-in' })
    expect(found.claude.range).toBeUndefined()
    expect(found.claude.silent).toBeUndefined()
    expect(found.uv).toEqual({ path: join(dir, 'uv'), version: '0.9.1' })
  })

  it('says signed out when the CLI says so, even though it exits with an error', async () => {
    const found = await checkTools({ ...base, path: empty(), run: standIn({ FAKE_AGENT_AUTH: 'out' }) })
    expect(found.claude.account).toBe('signed-out')
  })

  it('does not know the account from an answer that is no JSON, or has no say', async () => {
    const garbage = await checkTools({ ...base, path: empty(), run: standIn({ FAKE_AGENT_AUTH: 'garbage' }) })
    expect(garbage.claude.account).toBeUndefined()
    expect(garbage.claude.silent).toBeUndefined()
    const none = await checkTools({ ...base, path: empty(), run: async (_file, args) => (args.includes('status') ? { code: 0, out: '{}' } : { code: 0, out: '2.1.300 (Claude Code)' }) })
    expect(none.claude.account).toBeUndefined()
  })

  it('says a version outside the range torno was checked with, and a patch of the tested minor is quiet', async () => {
    const newer = await checkTools({ ...base, path: empty(), run: standIn({ FAKE_AGENT_VERSION: '2.2.0' }) })
    expect(newer.claude).toMatchObject({ version: '2.2.0', range: 'newer', tested: { min: '2.1.300', max: '2.1.301' } })
    const older = await checkTools({ ...base, path: empty(), run: standIn({ FAKE_AGENT_VERSION: '2.0.9' }) })
    expect(older.claude.range).toBe('older')
    const patch = await checkTools({ ...base, path: empty(), run: standIn({ FAKE_AGENT_VERSION: '2.1.307' }) })
    expect(patch.claude.range).toBeUndefined()
  })

  it('does not ask the CLI at all when it is not to be asked (a test of the app), and still finds it', async () => {
    const calls: string[] = []
    const run: Runner = async (file, args) => (calls.push(`${file} ${args.join(' ')}`), null)
    const found = await checkTools({ ...base, askCli: false, path: join(process.execPath, '..'), run })
    expect(found.claude.path).toBe(process.execPath)
    expect(found.claude.version).toBeUndefined()
    expect(found.claude.silent).toBeUndefined()
    expect(calls.filter((c) => c.includes(fakeAgent))).toEqual([])
  })

  it('goes on with the answer it has when the CLI hangs past the timeout, and says it was silent', async () => {
    const started = Date.now()
    const found = await checkTools({ ...base, timeoutMs: 400, path: empty(), run: standIn({ FAKE_AGENT_VERSION: 'hang', FAKE_AGENT_AUTH: 'hang' }) })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(found.claude).toMatchObject({ path: process.execPath, silent: true })
    expect(found.claude.version).toBeUndefined()
    expect(found.claude.account).toBeUndefined()
  })

  it('goes on when a runner never answers at all', async () => {
    const started = Date.now()
    const never: Runner = () => new Promise(() => {})
    const found = await checkTools({ ...base, timeoutMs: 300, path: empty(), run: never })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(found.claude.silent).toBe(true)
  })

  it('finds uv by the PATH and does not run it when it is not there', async () => {
    const dir = binWith('uv', '#!/bin/sh\nsleep 30\n')
    const started = Date.now()
    const found = await checkTools({ ...base, timeoutMs: 300, path: dir, run: standIn() })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(found.uv).toEqual({ path: join(dir, 'uv') })
  })
})

describe('runCommand', () => {
  it('kills what outlasts its time, and answers null', async () => {
    const script = join(binWith('slow', '#!/bin/sh\nsleep 30\n'), 'slow')
    const started = Date.now()
    expect(await runCommand(script, [], 300)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2500)
  })
  it('answers null for a command that cannot be run, and the exit code and output of one that can', async () => {
    expect(await runCommand(join(root, 'nothing-here'), [], 1000)).toBeNull()
    const bad = join(binWith('bad', '#!/bin/sh\necho hello\nexit 3\n'), 'bad')
    expect(await runCommand(bad, [], 1000)).toEqual({ code: 3, out: 'hello\n' })
  })
})

describe('the environment', () => {
  const made = (dir: string): void => {
    mkdirSync(join(dir, 'lib', 'python3.12', 'site-packages', 'build123d'), { recursive: true })
    writeFileSync(join(dir, 'pyvenv.cfg'), 'home = /usr/bin\n')
  }

  it('is made when it holds Python and build123d, and not when it is missing or half-made', () => {
    const none = join(root, 'env-none')
    expect(ownEnvironmentMade(none)).toBe(false)
    const half = join(root, 'env-half')
    mkdirSync(half)
    writeFileSync(join(half, 'pyvenv.cfg'), '')
    expect(ownEnvironmentMade(half)).toBe(false)
    const whole = join(root, 'env-whole')
    made(whole)
    expect(ownEnvironmentMade(whole)).toBe(true)
  })

  it("is torno's own without a workspace and for a workspace with no project, and the workspace's own .venv with one", () => {
    const own = join(root, 'own-env')
    expect(environmentOf({ own, workspace: null })).toEqual({ kind: 'torno', dir: own, made: false })
    expect(environmentOf({ own, workspace: { root: '/w', hasProject: false } })).toMatchObject({ kind: 'torno', dir: own })
    const ws = mkdtempSync(join(root, 'ws-'))
    expect(environmentOf({ own, workspace: { root: ws, hasProject: true } })).toEqual({ kind: 'workspace', dir: join(ws, '.venv'), made: false })
    mkdirSync(join(ws, '.venv'))
    writeFileSync(join(ws, '.venv', 'pyvenv.cfg'), '')
    expect(environmentOf({ own, workspace: { root: ws, hasProject: true } }).made).toBe(true)
  })
})

describe('makeEnvironment', () => {
  const script = (body: string): string[] => [process.execPath, '-e', body]

  it("runs the command and reports each line of its output, ending when it does", async () => {
    const lines: string[] = []
    await makeEnvironment({ command: script("console.error('Resolved 3 packages'); console.error('Installed 3 packages'); console.log('done')"), env: {}, cwd: root, onLine: (l) => lines.push(l) })
    expect(lines).toEqual(['Resolved 3 packages', 'Installed 3 packages', 'done'])
  })

  it('rejects with the last of what the command said when it fails', async () => {
    await expect(makeEnvironment({ command: script("console.error('No route to host'); process.exit(2)"), env: {}, cwd: root, onLine: () => {} })).rejects.toThrow(/No route to host/)
  })

  it('rejects saying uv could not be run when the command is not there', async () => {
    await expect(makeEnvironment({ command: [join(root, 'no-uv'), 'sync'], env: {}, cwd: root, onLine: () => {} })).rejects.toThrow(/could not run/)
  })

  it('has the environment it is given in the process', async () => {
    const lines: string[] = []
    await makeEnvironment({ command: script('console.log(process.env.UV_PROJECT_ENVIRONMENT)'), env: { UV_PROJECT_ENVIRONMENT: '/somewhere/kernel-env' }, cwd: root, onLine: (l) => lines.push(l) })
    expect(lines).toEqual(['/somewhere/kernel-env'])
  })
})


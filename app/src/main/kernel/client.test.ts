import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { kernelCommand, KernelError, type RunningKernel, startKernelCommand } from './client'

// These run the client against fake-kernel.mjs. client.itest.ts runs it against the real kernel.
const FAKE = join(__dirname, 'fake-kernel.mjs')

let kernel: RunningKernel | undefined
function start(mode = 'normal'): RunningKernel {
  kernel = startKernelCommand([process.execPath, FAKE, mode], tmpdir())
  return kernel
}
afterEach(async () => {
  await kernel?.dispose()
  kernel = undefined
})

function exitOf(k: RunningKernel): Promise<number | null> {
  return new Promise((resolve) => k.onExit(resolve))
}

describe('kernelCommand', () => {
  it('runs in the workspace project without syncing it, with the kernel layered on', () => {
    expect(kernelCommand({ workspaceRoot: '/ws', hasProject: true, kernelDir: '/repo/kernel' })).toEqual(
      ['uv', 'run', '--no-sync', '--project', '/ws', '--with-editable', '/repo/kernel', 'python', '-m', 'torno_kernel']
    )
  })

  it('runs in the kernel project when the workspace has none', () => {
    expect(kernelCommand({ workspaceRoot: '/ws', hasProject: false, kernelDir: '/repo/kernel' })).toEqual(
      ['uv', 'run', '--project', '/repo/kernel', 'python', '-m', 'torno_kernel']
    )
  })
})

describe('kernel client', () => {
  it('resolves a build with its scene and a blob of its own, after onStarted', async () => {
    const k = start()
    let started = 0
    const result = await k.build('/ws/a', 'a.py', { timeout: 7, onStarted: () => (started += 1) })
    expect(started).toBe(1)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.scene.model).toBe('a.py')
    expect(result.scene.seconds).toBe(7) // the fake echoes the timeout it was sent
    expect([...result.blob]).toEqual([1, 2, 3, 4, 5])
    expect(result.blob.byteLength).toBe(5)
  })

  it('runs the kernel in the workspace root', async () => {
    const result = await start().build('/ws/a', 'a.py')
    expect(result.ok && result.scene.output).toBe(tmpdir())
  })

  it('resolves a failed build with its error rather than rejecting', async () => {
    const result = await start().build('/ws/a', 'bad.py')
    expect(result).toEqual({ ok: false, error: { kind: 'exception', message: 'boom' } })
  })

  it('resolves the running build as cancelled when a newer one starts, or on cancel', async () => {
    const k = start()
    const first = k.build('/ws/a', 'hang.py')
    const second = k.build('/ws/a', 'hang.py')
    expect(await first).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    k.cancel()
    expect(await second).toMatchObject({ ok: false, error: { kind: 'cancelled', message: 'cancelled by request' } })
  })

  it('resolves a query with its result and rejects with the kernel\'s error kind', async () => {
    const k = start()
    expect(await k.query('echo', { ref: 'a:b' })).toMatchObject({ name: 'echo', args: { ref: 'a:b' } })
    const error = await k.query('bad-ref', {}).catch((e) => e)
    expect(error).toBeInstanceOf(KernelError)
    expect(error).toMatchObject({ kind: 'bad_ref', message: 'no part named x' })
  })

  it('retries a cancelled query once', async () => {
    const k = start()
    expect(await k.query('cancelled-once', {})).toMatchObject({ name: 'cancelled-once' })
    await expect(k.query('always-cancelled', {})).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('fails what is pending with kind crash when the kernel dies, and restarts it once', async () => {
    const k = start()
    const before = await k.query<{ pid: number }>('echo', {})
    const query = k.query('hang', {}).catch((e) => e)
    const build = await k.build('/ws/a', 'die.py')
    expect(build).toMatchObject({ ok: false, error: { kind: 'crash' } })
    expect(await query).toMatchObject({ kind: 'crash' })

    const after = await k.query<{ pid: number }>('echo', {})
    expect(after.pid).not.toBe(before.pid)
    expect(await k.build('/ws/a', 'a.py')).toMatchObject({ ok: true })
  })

  it('stops after a second exit, reports it with the stderr tail, and starts again for the next build', async () => {
    const k = start()
    const exit = exitOf(k)
    await k.build('/ws/a', 'die.py')
    expect(await k.build('/ws/a', 'die.py')).toMatchObject({ ok: false, error: { kind: 'crash' } })
    expect(await exit).toBe(3)
    expect(k.stderrTail()).toMatch(/fake kernel \d+ starting/)
    await expect(k.query('echo', {})).rejects.toMatchObject({ kind: 'crash', message: 'kernel stopped' })

    expect(await k.build('/ws/a', 'a.py')).toMatchObject({ ok: true })
  })

  it('rejects ready when the kernel never starts', async () => {
    const k = start('die-at-start')
    const exit = exitOf(k)
    const error = await k.ready.catch((e) => e)
    expect(error).toMatchObject({ kind: 'crash' })
    expect(error.message).toMatch(/^kernel stopped\n/)
    expect(error.message).toContain('ModuleNotFoundError: no module named build123d')
    expect(await exit).toBe(1)
  })

  it('reports a command that cannot be run the same way', async () => {
    kernel = startKernelCommand(['/nonexistent/torno-uv'], tmpdir())
    const exit = exitOf(kernel)
    await expect(kernel.ready).rejects.toMatchObject({ kind: 'crash' })
    expect(await exit).toBeNull()
    expect(kernel.stderrTail()).toContain('could not run /nonexistent/torno-uv')
  })

  it('keeps the last 200 lines of stderr', async () => {
    const k = start('noisy')
    await k.ready
    await k.query('echo', {})
    const lines = k.stderrTail().split('\n')
    expect(lines).toHaveLength(201) // 200 whole lines and the unfinished one
    expect(lines[0]).toBe('line 300')
    expect(lines.at(-1)).toBe('no newline at the end')
  })

  it('shuts the kernel down on dispose, cancelling what is pending, and does not restart it', async () => {
    const k = start()
    expect(await k.ready).toEqual({ versions: { fake: '1' } })
    const pid = k.pid!
    let exits = 0
    k.onExit(() => (exits += 1))
    const build = k.build('/ws/a', 'hang.py')
    await k.dispose()
    expect(await build).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(() => process.kill(pid, 0)).toThrow()
    expect(k.pid).toBeUndefined()
    expect(exits).toBe(0)
    expect(await k.build('/ws/a', 'a.py')).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    await expect(k.query('echo', {})).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

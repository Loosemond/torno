import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { BuildError } from '../../shared/build'
import type { Scene } from '../../shared/scene'
import { encodeFrame, FrameDecoder } from './frames'

const STDERR_LINES = 200
const RESTART_WINDOW_MS = 30_000 // a second unexpected exit this soon after the first is not retried
const SHUTDOWN_GRACE_MS = 3_000 // the kernel takes up to 1 s to flush its last replies

export type BuildResult = { ok: true; scene: Scene; blob: Buffer } | { ok: false; error: BuildError }

export class KernelError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(message)
    this.name = 'KernelError'
  }
}

export interface KernelClient {
  /** The first start. Rejects if the kernel stops for good before it is ever ready. */
  ready: Promise<{ versions: Record<string, string> }>
  /** Starting a build cancels the one running, which then resolves with kind `cancelled`. Never rejects. */
  build(dir: string, model: string, opts?: { timeout?: number; onStarted?: () => void }): Promise<BuildResult>
  query<T = unknown>(name: string, args: object): Promise<T> // rejects with KernelError(kind, message)
  cancel(): void
  dispose(): Promise<void>
  /** Called when the kernel has exited unexpectedly and was not restarted. */
  onExit(cb: (code: number | null) => void): void
  /** The last lines the kernel wrote to stderr. */
  stderrTail(): string
}

/** The command that runs the kernel for a workspace. */
export function kernelCommand(opts: { workspaceRoot: string; hasProject: boolean; kernelDir: string }): string[] {
  const run = opts.hasProject
    ? // The workspace's own environment, never synced, with the kernel layered on top.
      ['run', '--no-sync', '--project', opts.workspaceRoot, '--with-editable', opts.kernelDir]
    : ['run', '--project', opts.kernelDir]
  return ['uv', ...run, 'python', '-m', 'torno_kernel']
}

type Pending =
  | { type: 'build'; resolve: (r: BuildResult) => void; onStarted?: () => void }
  | { type: 'query'; resolve: (result: unknown) => void; reject: (e: KernelError) => void }

class Kernel implements KernelClient {
  readonly ready: Promise<{ versions: Record<string, string> }>
  private readyResolve!: (r: { versions: Record<string, string> }) => void
  private readyReject!: (e: KernelError) => void
  private readonly command: string[]
  private readonly cwd: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly stderr: string[] = []
  private stderrPartial = ''
  private readonly exitCbs: Array<(code: number | null) => void> = []
  private lastExitAt: number | null = null
  private stopped = false // exited twice in a row; started again by the next build
  private disposed: Promise<void> | null = null

  constructor(command: string[], cwd: string) {
    this.command = command
    this.cwd = cwd
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.ready.catch(() => {}) // reported through onExit as well; not every caller awaits `ready`
    this.spawn()
  }

  build(dir: string, model: string, opts?: { timeout?: number; onStarted?: () => void }): Promise<BuildResult> {
    if (this.disposed) return Promise.resolve(failure('cancelled', 'the kernel was shut down'))
    if (this.stopped) {
      this.stopped = false
      this.spawn()
    }
    return new Promise((resolve) => {
      const id = this.nextId++
      this.pending.set(id, { type: 'build', resolve, onStarted: opts?.onStarted })
      this.send({ id, op: 'build', dir, model, ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }) })
    })
  }

  async query<T = unknown>(name: string, args: object): Promise<T> {
    try {
      return (await this.queryOnce(name, args)) as T
    } catch (e) {
      // The build this query was sent to has just been replaced by a newer
      // one: ask the newer one.
      if (e instanceof KernelError && e.kind === 'cancelled' && !this.disposed) {
        return (await this.queryOnce(name, args)) as T
      }
      throw e
    }
  }

  cancel(): void {
    if (this.proc) this.send({ id: this.nextId++, op: 'cancel' })
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposed
    const proc = this.proc
    this.disposed = new Promise((resolve) => {
      if (!proc) return resolve()
      const kill = setTimeout(() => proc.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
      proc.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
    })
    if (proc) {
      this.send({ id: this.nextId++, op: 'shutdown' })
      proc.stdin.end()
    }
    this.failPending('cancelled', 'the kernel was shut down')
    return this.disposed
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb)
  }

  stderrTail(): string {
    return [...this.stderr, ...(this.stderrPartial ? [this.stderrPartial] : [])].join('\n')
  }

  /** The process started for the kernel (`uv`, whose child is Python). For diagnostics and tests. */
  get pid(): number | undefined {
    return this.proc?.pid
  }

  private queryOnce(name: string, args: object): Promise<unknown> {
    if (this.disposed) return Promise.reject(new KernelError('cancelled', 'the kernel was shut down'))
    if (!this.proc) return Promise.reject(new KernelError('crash', 'kernel stopped'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { type: 'query', resolve, reject })
      this.send({ id, op: 'query', name, args })
    })
  }

  private spawn(): void {
    const [file, ...args] = this.command
    // Three separate pipes: the kernel makes its stdout non-blocking, which
    // would break its stderr too if the two shared one.
    // No bytecode: Python would write __pycache__ beside every model and common/
    // module it imports, and a workspace is only ever written under .torno/.
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    const proc = spawn(file, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    const decoder = new FrameDecoder()
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const { header, blob } of decoder.push(chunk)) this.receive(header, blob)
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (text: string) => this.keepStderr(text))
    proc.stdin.on('error', () => {}) // a write to a dead kernel; its exit is handled below

    // 'error' alone when the process could not be started, 'exit' otherwise.
    // Not 'close': that waits for the pipes, which a child of `uv` may still hold.
    let ended = false
    const end = (code: number | null) => {
      if (ended) return
      ended = true
      this.exited(proc, code)
    }
    proc.once('error', (e) => {
      this.keepStderr(`could not run ${file}: ${e.message}\n`)
      end(null)
    })
    proc.once('exit', (code) => end(code))
  }

  private send(header: object): void {
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.write(encodeFrame(header))
  }

  private receive(header: any, blob: Buffer): void {
    if (header === null || typeof header !== 'object') return
    if (header.event === 'ready') {
      this.readyResolve({ versions: header.versions ?? {} })
      return
    }
    const request = this.pending.get(header.id)
    if (!request) {
      // A reply with no request: the kernel rejected a frame it could not match to an id.
      if (header.ok === false) this.keepStderr(`kernel: ${header.error?.kind}: ${header.error?.message}\n`)
      return
    }
    if (header.event === 'build.started') {
      if (request.type === 'build') request.onStarted?.()
      return
    }
    this.pending.delete(header.id)
    if (request.type === 'build') {
      // The blob is a view into the read buffer: give the scene one of its own.
      if (header.ok) request.resolve({ ok: true, scene: header.scene, blob: Buffer.from(blob) })
      else request.resolve({ ok: false, error: header.error ?? { kind: 'crash', message: 'the build failed' } })
    } else if (header.ok) {
      request.resolve(header.result)
    } else {
      request.reject(new KernelError(header.error?.kind ?? 'crash', header.error?.message ?? 'the query failed'))
    }
  }

  private exited(proc: ChildProcessWithoutNullStreams, code: number | null): void {
    // If `uv` died and Python did not, closing its stdin is what ends it.
    proc.stdin.destroy()
    if (this.proc !== proc) return
    this.proc = null
    if (this.disposed) return
    this.failPending('crash', `the kernel exited${code === null ? '' : ` with status ${code}`}; rebuild to carry on`)
    const now = Date.now()
    const again = this.lastExitAt !== null && now - this.lastExitAt < RESTART_WINDOW_MS
    this.lastExitAt = now
    if (!again) {
      this.spawn()
      return
    }
    this.stopped = true
    this.readyReject(new KernelError('crash', `kernel stopped\n${this.stderrTail()}`))
    for (const cb of this.exitCbs) cb(code)
  }

  private failPending(kind: string, message: string): void {
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const request of requests) {
      if (request.type === 'build') request.resolve(failure(kind, message))
      else request.reject(new KernelError(kind, message))
    }
  }

  private keepStderr(text: string): void {
    const lines = (this.stderrPartial + text).split('\n')
    this.stderrPartial = lines.pop() ?? ''
    this.stderr.push(...lines)
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES)
  }
}

function failure(kind: string, message: string): BuildResult {
  return { ok: false, error: { kind, message } }
}

export type RunningKernel = KernelClient & { readonly pid: number | undefined }

/** Start the kernel for a workspace. It is restarted once if it exits unexpectedly. */
export function startKernel(opts: { workspaceRoot: string; hasProject: boolean; kernelDir: string }): RunningKernel {
  return new Kernel(kernelCommand(opts), opts.workspaceRoot)
}

/** As `startKernel`, with the command given: tests run a stand-in for the kernel. */
export function startKernelCommand(command: string[], cwd: string): RunningKernel {
  return new Kernel(command, cwd)
}

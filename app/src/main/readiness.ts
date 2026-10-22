import { EventEmitter } from 'node:events'
import type { Making, Ready, KernelState } from '../shared/ready'
import { ASK_MS, checkTools, environmentOf, makeEnvironment, ownEnvironmentMade, runCommand, type Runner } from './ready'

export interface KeeperDeps {
  /** The command a session runs, to ask it its version and its account (`AgentAdapter.probe`). */
  probe: { command: string; args: string[] }
  tested?: { min: string; max: string }
  /** The PATH torno has now (after a Mac's login shell). */
  path: () => string
  /** False under `TORNO_TEST=1`: the CLI is looked for on the PATH and never run. */
  askCli: boolean
  run?: Runner
  /** torno's own Python environment: `kernel-env` under the app's data in a packaged app, `kernel/.venv` beside `app/` otherwise. */
  own: string
  /** What makes it: `uv sync` on torno's own kernel project, `--frozen` for a packaged app, never on a workspace. */
  make: { command: string[]; env: Record<string, string>; cwd: string }
  /** Looked up per call so that a test can put uv away. */
  uvCommand?: string
}

/** The kernel as the keeper sees it start: its first answer, and its leaving for good. */
export interface KernelWatch {
  ready: Promise<{ versions: Record<string, string> }>
  onExit(cb: (code: number | null) => void): void
}

/** The most of a failure's text that is kept to show. */
const REASON_CHARS = 600

const short = (text: string): string => (text.length > REASON_CHARS ? `…${text.slice(-REASON_CHARS)}` : text)

/**
 * What torno knows of what it needs, for the first screen, the empty workspace, the page of a new object and the
 * sheet that checks it. The CLI is asked once (version, account) and the answer kept until the person asks again;
 * what is on the disk, the kernel's start and the making of torno's environment are read as they are. It tells
 * `changed` with the whole of it whenever the kernel's state or the making changes.
 */
export class ReadyKeeper extends EventEmitter {
  private tools: Promise<Pick<Ready, 'claude' | 'uv'>> | null = null
  private workspace: { root: string; hasProject: boolean } | null = null
  private kernel: KernelState = { state: 'none' }
  private making: Making = { state: 'idle' }
  /** Which kernel's answers count: a workspace that is left, or replaced, no longer speaks. */
  private epoch = 0

  constructor(private readonly deps: KeeperDeps) {
    super()
  }

  private ask(): Promise<Pick<Ready, 'claude' | 'uv'>> {
    const { deps } = this
    return checkTools({
      path: deps.path(),
      cli: deps.probe,
      uvCommand: deps.uvCommand ?? 'uv',
      askCli: deps.askCli,
      run: deps.run ?? ((file, args, ms) => runCommand(file, args, ms)),
      timeoutMs: ASK_MS,
      ...(deps.tested ? { tested: deps.tested } : {})
    })
  }

  /** As things stand. `fresh` asks the CLI and looks on the PATH again; otherwise what was found at first is kept. */
  async get(fresh = false): Promise<Ready> {
    if (fresh || this.tools === null) this.tools = this.ask()
    const { claude, uv } = await this.tools
    return {
      searched: this.deps.path(),
      claude,
      uv,
      environment: environmentOf({ own: this.deps.own, workspace: this.workspace }),
      making: this.making,
      kernel: this.kernel
    }
  }

  private changed(): void {
    void this.get().then((ready) => this.emit('changed', ready))
  }

  /** A workspace was opened and its kernel is starting: its first answer, or its failure, is told. */
  opened(workspace: { root: string; hasProject: boolean }, kernel: KernelWatch): void {
    const mine = ++this.epoch
    this.workspace = workspace
    this.kernel = { state: 'starting' }
    this.changed()
    kernel.ready.then(
      ({ versions }) => this.kernelSaid(mine, { state: 'ready', versions }),
      (e: unknown) => this.kernelSaid(mine, { state: 'failed', reason: short(e instanceof Error ? e.message : String(e)) })
    )
    // A kernel that was up and has stopped for good: the first answer was heard already.
    kernel.onExit(() => this.kernelSaid(mine, { state: 'failed', reason: 'The kernel stopped. Rebuild to start it again.' }))
  }

  private kernelSaid(mine: number, state: KernelState): void {
    if (mine !== this.epoch) return
    this.kernel = state
    this.changed()
  }

  /** The workspace was left. */
  closed(): void {
    this.epoch += 1
    this.workspace = null
    this.kernel = { state: 'none' }
    this.changed()
  }

  /**
   * Makes torno's own Python environment, the way the first build would, so that the first build is not the one that
   * waits for 900 MB. Refused for anything but torno's own: a workspace's `.venv` is the person's, and torno never makes
   * it. Resolves when it is made, rejecting with why not; progress is told as `changed`.
   */
  async makeNow(): Promise<void> {
    const ready = await this.get()
    if (ready.environment.kind !== 'torno') throw new Error("The environment of a folder with its own pyproject.toml is its own: run `uv sync` in it. torno never makes it.")
    if (this.making.state === 'making') return
    if (this.kernel.state === 'starting') throw new Error("The kernel is starting, and is making the environment as it does.")
    if (ready.uv.path === null) throw new Error('uv was not found on PATH: install it from docs.astral.sh/uv.')
    if (ready.environment.made) return
    const lines: string[] = []
    this.making = { state: 'making', lines }
    this.changed()
    const { command, env, cwd } = this.deps.make
    try {
      await makeEnvironment({
        command: [ready.uv.path, ...command.slice(1)],
        env,
        cwd,
        onLine: (line) => {
          lines.push(line)
          if (lines.length > 6) lines.shift()
          this.making = { state: 'making', lines: [...lines] }
          this.changed()
        }
      })
    } catch (e) {
      const reason = short(e instanceof Error ? e.message : String(e))
      this.making = { state: 'failed', reason, lines: [...lines] }
      this.changed()
      throw new Error(reason)
    }
    if (!ownEnvironmentMade(this.deps.own)) {
      this.making = { state: 'failed', reason: 'uv finished, but the environment is not there.', lines: [...lines] }
      this.changed()
      throw new Error('uv finished, but the environment is not there.')
    }
    this.making = { state: 'idle' }
    // A kernel that gave up for want of it is started again by the next build; its old failure is not the word on it any more.
    if (this.kernel.state === 'failed') this.kernel = { state: 'none' }
    this.changed()
  }
}

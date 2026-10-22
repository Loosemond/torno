import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Ready } from '../shared/ready'
import { findCommand } from './sessions/choice'
import { outside } from './sessions/transcript'

/**
 * What torno needs before anything can run, found before it fails: Claude Code and uv on the PATH, and whether the
 * Python environment of the kernel is made. A lookup on the PATH runs nothing. The CLI is asked two things, once,
 * outside tests only (`askCli`): its version (`--version`) and whether it is signed in (`auth status`), each within
 * `ASK_MS`, nothing written; uv is asked its version. Nothing of the person's Claude Code configuration is read.
 */

/** How long a command asked about itself has to answer before it is killed. */
export const ASK_MS = 3000

/** What a command printed and how it ended; null when it could not be run or was not back in time. */
export type Run = { code: number | null; out: string } | null
/** How a command is run for the check: the real one is `runCommand`; a test gives the stand-in's. */
export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<Run>

/** Runs a command to its end within `timeoutMs`, its input closed; kills it after that and answers null. Its standard output is what is kept. */
export function runCommand(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', env, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
      if (error && (error as { killed?: boolean }).killed) return resolve(null)
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null) : 0
      // A command that did not start (not there, not executable) has a code that is no number.
      resolve(error && code === null ? null : { code, out: String(stdout) })
    })
    child.stdin?.end()
  })
}

export interface ToolsDeps {
  /** The PATH to look on. */
  path: string
  /** The command a session of the agent runs, and the arguments it is given before the rest (`AgentAdapter.probe`). */
  cli: { command: string; args: string[] }
  uvCommand: string
  /** Whether the CLI may be run to ask its version and its account: not under `TORNO_TEST=1`. */
  askCli: boolean
  run: Runner
  timeoutMs: number
  tested?: { min: string; max: string }
}

/** A run that is back in time, or null: the runner's own limit, and this one beside it for a runner that has none. */
function within(ms: number, run: Promise<Run>): Promise<Run> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms + 200)
    run.then(
      (done) => {
        clearTimeout(timer)
        resolve(done)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

const VERSION = /\b(\d+\.\d+\.\d+)\b/

/** From the JSON of `claude auth status`: signed out or in, or nothing where it says neither. */
function accountOf(out: string): 'signed-in' | 'signed-out' | undefined {
  let said: unknown
  try {
    said = JSON.parse(out)
  } catch {
    return undefined
  }
  if (typeof said !== 'object' || said === null) return undefined
  const { loggedIn, authMethod } = said as { loggedIn?: unknown; authMethod?: unknown }
  if (loggedIn === false || authMethod === 'none') return 'signed-out'
  return loggedIn === true ? 'signed-in' : undefined
}

/** Claude Code and uv: where each is on the PATH, and what the CLI says of its version and its account. */
export async function checkTools(deps: ToolsDeps): Promise<Pick<Ready, 'claude' | 'uv'>> {
  const { cli, path, run, timeoutMs } = deps
  const claudePath = findCommand(cli.command, path)
  const claude: Ready['claude'] = { command: cli.command, path: claudePath }
  const uvPath = findCommand(deps.uvCommand, path)
  const uv: Ready['uv'] = { path: uvPath }
  const asks: Promise<void>[] = []
  if (claudePath !== null && deps.askCli) {
    asks.push(
      within(timeoutMs, run(claudePath, [...cli.args, '--version'], timeoutMs)).then((done) => {
        const version = done ? VERSION.exec(done.out)?.[1] : undefined
        if (version === undefined) return void (claude.silent = true)
        claude.version = version
        const range = deps.tested ? outside(version, deps.tested) : null
        if (range && deps.tested) {
          claude.range = range
          claude.tested = deps.tested
        }
      }),
      within(timeoutMs, run(claudePath, [...cli.args, 'auth', 'status'], timeoutMs)).then((done) => {
        const account = done ? accountOf(done.out) : undefined
        if (account) claude.account = account
        else if (done === null) claude.silent = true
      })
    )
  }
  if (uvPath !== null) {
    asks.push(
      within(timeoutMs, run(uvPath, ['--version'], timeoutMs)).then((done) => {
        const version = done ? VERSION.exec(done.out)?.[1] : undefined
        if (version) uv.version = version
      })
    )
  }
  await Promise.all(asks)
  return { claude, uv }
}

/**
 * Whether torno's own Python environment is made: a Python in it and build123d installed. A folder uv began and did
 * not finish (a network that dropped) is not made.
 */
export function ownEnvironmentMade(dir: string): boolean {
  if (!existsSync(join(dir, 'pyvenv.cfg'))) return false
  try {
    const lib = join(dir, 'lib')
    return readdirSync(lib).some((name) => name.startsWith('python') && existsSync(join(lib, name, 'site-packages', 'build123d')))
  } catch {
    return false
  }
}

/**
 * The environment the kernel of a workspace runs in: its own `.venv` when it has a `pyproject.toml` (torno never makes
 * it: it says whether it is there), else torno's, `own`. With no workspace open, torno's: the one any folder without a
 * project will use.
 */
export function environmentOf(opts: { own: string; workspace: { root: string; hasProject: boolean } | null }): Ready['environment'] {
  const { own, workspace } = opts
  if (workspace?.hasProject) {
    const dir = join(workspace.root, '.venv')
    return { kind: 'workspace', dir, made: existsSync(join(dir, 'pyvenv.cfg')) }
  }
  return { kind: 'torno', dir: own, made: ownEnvironmentMade(own) }
}

/** The lines of what a command printed that are kept to be shown: no more than this many, the newest. */
const KEPT_LINES = 40

/**
 * Runs the command that makes torno's own Python environment (`uv sync` on torno's own kernel project, never on a
 * workspace) and tells each line it prints (uv writes its progress to standard error). Resolves when it exits 0;
 * rejects with what it last said when it fails, or with why it could not be run.
 */
export function makeEnvironment(opts: { command: string[]; env: Record<string, string>; cwd: string; onLine: (line: string) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = opts.command
    const tail: string[] = []
    const said = (line: string): void => {
      const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()
      if (plain === '') return
      tail.push(plain)
      if (tail.length > KEPT_LINES) tail.shift()
      opts.onLine(plain)
    }
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) {
      let partial = ''
      stream.setEncoding('utf8')
      stream.on('data', (text: string) => {
        const lines = (partial + text).split(/\r?\n|\r/)
        partial = lines.pop() ?? ''
        lines.forEach(said)
      })
      stream.on('end', () => said(partial))
    }
    let ended = false
    child.once('error', (e) => {
      if (ended) return
      ended = true
      reject(new Error(`could not run ${file}: ${e.message}`))
    })
    child.once('close', (code) => {
      if (ended) return
      ended = true
      if (code === 0) resolve()
      else reject(new Error(tail.length > 0 ? tail.slice(-4).join('\n') : `${file} stopped with status ${code}`))
    })
  })
}

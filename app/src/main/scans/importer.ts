import { type ChildProcess, spawn } from 'node:child_process'
import { number } from '../../shared/format'
import type { Vec3 } from '../../shared/marks'
import type { ScanUnit, ScanUp } from '../../shared/scans'

/** What the import process says it wrote (`kernel/src/torno_kernel/scans.py`): its last line on stdout. */
export interface ImportReply { unit: ScanUnit; up: ScanUp; assumed: { unit: boolean; up: boolean }; vertices: number; triangles: number; colours: 'texture' | 'vertex' | 'none'; bbox: { min: Vec3; max: Vec3 }; area: number; reduced: { from: number; cell: number } | null; source?: { bytes: number; sha256: string } }

export interface Importer {
  import(source: string, out: string, opts: { unit?: ScanUnit; up?: ScanUp }, onStage?: (stage: string) => void): Promise<ImportReply>
  convert(mesh: string, from: { unit: ScanUnit; up: ScanUp }, to: { unit: ScanUnit; up: ScanUp }): Promise<ImportReply>
  /** Ends whatever is running: the workspace is left. */
  stop(): void
}

export const IMPORT_TIMEOUT_MS = 300_000

const STOPPED = 'the import was stopped: the workspace was closed'
/** How much of what the process wrote on stderr is said when it gave no answer. */
const STDERR_LINES = 6
/** How much of stderr is kept at all: a library may write a great deal. */
const STDERR_KEPT = 64 * 1024

/**
 * The reply of an import process from all it wrote on stdout: its last line.
 * Throws an Error with the process's own message. A process that ended any
 * other way than by answering (uv could not make its environment, Python
 * died) is said with what it last wrote on stderr, its stages apart.
 *
 * What the reply holds is not checked here: whoever keeps it does that.
 */
export function replyOf(stdout: string, status: number | null, stderr: string): ImportReply {
  const last = stdout.trimEnd().split('\n').at(-1) ?? ''
  let said: unknown
  try {
    said = JSON.parse(last)
  } catch {
    // not an answer
  }
  if ((status === 0 || status === 1) && typeof said === 'object' && said !== null) {
    const { ok, error, ...reply } = said as { ok?: unknown; error?: { message?: unknown } }
    if (ok === true && status === 0) return reply as ImportReply
    if (ok === false && typeof error?.message === 'string' && error.message !== '') throw new Error(error.message)
  }
  const wrote = stderr.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '' && !STAGE.test(line))
  if (wrote.length === 0) throw new Error('the import process ended without an answer')
  throw new Error(`the import could not be started: ${wrote.slice(-STDERR_LINES).join('\n')}`)
}

const STAGE = /^stage: (.+)$/

/**
 * Runs the import process of the kernel package, once for each file: never
 * in this process, which would stop for the seconds a scan takes to read.
 * `command` gives the command line for the process's own arguments
 * (`scanCommand`); `cwd` is the workspace root. One at a time: a second
 * waits for the first. A process that takes more than `timeoutMs` is killed.
 *
 * The process is started in a group of its own and the group is killed:
 * what runs is `uv`, whose child is Python, and killing `uv` alone would
 * leave Python to write its file after the import was given up on.
 */
export function processImporter(command: (args: string[]) => string[], cwd: string, timeoutMs: number = IMPORT_TIMEOUT_MS): Importer {
  /** The last run asked for, which the next waits for. */
  let last: Promise<unknown> = Promise.resolve()
  /** Counts `stop`: what was asked for before one is not started after it. */
  let stops = 0
  /** Ends the run under way with a reason. */
  let end: ((reason: string) => void) | null = null

  const run = (args: string[], onStage?: (stage: string) => void): Promise<ImportReply> => {
    const asked = stops
    const turn = last
      .catch(() => {})
      .then(() => {
        if (asked !== stops) throw new Error(STOPPED)
        return once(command(args), cwd, timeoutMs, onStage, (ender) => (end = ender))
      })
      .finally(() => (end = null))
    last = turn
    return turn
  }

  return {
    import(source, out, opts, onStage) {
      return run(['import', source, out, ...(opts.unit ? ['--unit', opts.unit] : []), ...(opts.up ? ['--up', opts.up] : [])], onStage)
    },
    convert(mesh, from, to) {
      return run(['convert', mesh, '--from-unit', from.unit, '--to-unit', to.unit, '--from-up', from.up, '--to-up', to.up])
    },
    stop() {
      stops += 1
      end?.(STOPPED)
    }
  }
}

/** One run of the process. `ender` is given what ends it early, with the reason it is then rejected with. */
function once(command: string[], cwd: string, timeoutMs: number, onStage: ((stage: string) => void) | undefined, ender: (end: (reason: string) => void) => void): Promise<ImportReply> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command
    // No bytecode, as for the kernel: a workspace is only ever written under .torno/.
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    const proc = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let partial = ''
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle()
    }
    const kill = (reason: string): void =>
      finish(() => {
        killGroup(proc)
        reject(new Error(reason))
      })
    const timer = setTimeout(() => kill(`the import took more than ${number(timeoutMs / 1000)} s and was stopped`), timeoutMs)
    ender(kill)

    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (text: string) => (stdout += text))
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (text: string) => {
      stderr = (stderr + text).slice(-STDERR_KEPT)
      const lines = (partial + text).split('\n')
      partial = lines.pop() ?? ''
      // After it was given up on, nothing more is told of it.
      for (const line of lines) {
        const stage = STAGE.exec(line.trimEnd())?.[1]
        if (stage && !done) onStage?.(stage)
      }
    })
    // 'error' alone when the process could not be started. Otherwise 'close', not 'exit': all it wrote has then been read.
    proc.once('error', (e) => finish(() => reject(new Error(`the import could not be started: could not run ${file}: ${e.message}`))))
    proc.once('close', (status) =>
      finish(() => {
        try {
          resolve(replyOf(stdout, status, stderr))
        } catch (e) {
          reject(e)
        }
      })
    )
  })
}

/** Kills the process and whatever it started. */
function killGroup(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    // Gone already, or no group of its own: the process itself, then.
    proc.kill('SIGKILL')
  }
}

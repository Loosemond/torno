import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { GIT_MOST_FILES, type GitState } from '../shared/git'
import { FOLDER } from './own'

// What git says of an object's sources: `git status`, read. torno never runs a git command that writes: not a
// commit, not an add, and not a status that refreshes the index (`--no-optional-locks`, and `GIT_OPTIONAL_LOCKS=0`
// for whatever it starts). The agent commits when the person asks it to. No git, no repository, a git that takes
// too long: nothing is said, and nothing is wrong.

/** The longest a git command may take. */
export const GIT_TIMEOUT_MS = 5000
const MAX_BUFFER = 8 * 1024 * 1024

export interface GitOptions {
  /** The git to run; `git` on the PATH when left out. */
  git?: string
  timeoutMs?: number
}

/** The environment git is run in: the person's, without what would point it at another repository, and asked to prompt for nothing. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key]
  return env
}

/** Standard output of `git <args>` in `cwd`; null when it fails in any way (no git, not a repository, the time). */
function git(cwd: string, args: string[], opts: GitOptions): Promise<string | null> {
  return new Promise((resolve) => {
    // `--no-optional-locks` comes first: nothing here may write the index. No fsmonitor daemon is started.
    const full = ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args]
    execFile(opts.git ?? 'git', full, { cwd, env: gitEnv(), timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

/** The folder that holds the work tree `dir` is in, as the system names it; null for none. */
async function topLevel(dir: string, opts: GitOptions): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], opts)
  const line = out?.split('\n')[0]?.trim()
  return line ? realpath(line).catch(() => null) : null
}

/** The path of one entry of `status --porcelain=v2 -z`; null for one that is not a change. */
function pathOf(entry: string): string | null {
  const kind = entry[0]
  // `1 XY sub mH mI mW hH hI path`; `2 XY sub mH mI mW hH hI Xscore path` (the old path follows as an entry of its
  // own); `u XY sub m1 m2 m3 mW h1 h2 h3 path`; `? path`.
  if (kind === '?') return entry.slice(2)
  const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1
  if (fields < 0) return null
  let at = 0
  for (let i = 0; i < fields; i++) {
    const space = entry.indexOf(' ', at)
    if (space < 0) return null
    at = space + 1
  }
  return entry.slice(at)
}

/**
 * Parse `git status --porcelain=v2 --branch -z`: the commit and branch it heads with, and the paths changed
 * (from the work tree's top). A rename's old path is an entry of its own, passed over.
 */
export function parseStatus(text: string): { head: string | null; branch: string | null; paths: string[] } {
  let head: string | null = null
  let branch: string | null = null
  const paths: string[] = []
  const entries = text.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.startsWith('# branch.oid ')) {
      const oid = entry.slice('# branch.oid '.length)
      head = /^[0-9a-f]{7,64}$/.test(oid) ? oid.slice(0, 7) : null
    } else if (entry.startsWith('# branch.head ')) {
      const name = entry.slice('# branch.head '.length)
      branch = name === '(detached)' ? null : name
    } else if (entry !== '' && !entry.startsWith('#')) {
      const path = pathOf(entry)
      if (path !== null) paths.push(path)
      if (entry[0] === '2') i += 1
    }
  }
  return { head, branch, paths }
}

/**
 * What git says of an object's sources: its folder (without `.torno/`) and the `common/` folder beside it, in
 * the work tree they are in. Null where there is none to say: no git on the machine, not a work tree, or a
 * git that did not answer in time.
 */
export async function gitState(objectDir: string, opts: GitOptions = {}): Promise<GitState | null> {
  const dir = await realpath(objectDir).catch(() => null)
  if (dir === null) return null
  const top = await topLevel(dir, opts)
  if (top === null) return null
  const root = dirname(dir)
  const inside = (path: string): string | null => {
    const from = relative(top, path)
    return from === '' || from.startsWith('..') ? null : from.split(sep).join('/')
  }
  const own = inside(dir)
  const common = inside(join(root, 'common'))
  // A work tree that is the project itself has no `common/` in it.
  const specs = [...(own === null ? ['.'] : [own]), ...(common === null || common === own ? [] : [common])]
  const out = await git(top, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', ...specs], opts)
  if (out === null) return null
  const found = parseStatus(out)
  const torno = `${own === null ? '' : `${own}/`}${FOLDER}`
  const files = found.paths
    .filter((path) => path !== torno && !path.startsWith(`${torno}/`))
    .map((path) => relative(root, join(top, path)).split(sep).join('/'))
  return { head: found.head, branch: found.branch, files: files.slice(0, GIT_MOST_FILES), changed: files.length }
}

/** How long an answer is kept for whoever asks again (a page of cards and the status line ask together). */
const RECENT_MS = 1000
const recent = new Map<string, { at: number; state: Promise<GitState | null> }>()

/** `gitState`, but what was asked a moment ago (`RECENT_MS`) is answered again, so that many askers cost one run of git. */
export function gitStateRecently(objectDir: string, now: () => number = Date.now): Promise<GitState | null> {
  const held = recent.get(objectDir)
  if (held && now() - held.at < RECENT_MS) return held.state
  const state = gitState(objectDir)
  recent.set(objectDir, { at: now(), state })
  if (recent.size > 200) recent.delete(recent.keys().next().value as string)
  return state
}

import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { InstructionFile, InstructionKind } from '../shared/instructions'

// The instruction files Claude Code reads on its own when it starts in an object: what it says of them is in its
// documentation ("How Claude remembers your project"). torno lists them by path and size and never reads their text: a
// file's words are the person's and the agent's, and showing them is done only when the person opens the file in its
// folder. Only what loads at launch by default is listed. An `@path` import, a file of a subfolder (loaded when the
// agent works there), and the settings that leave files out (`claudeMdExcludes`, `--setting-sources`, the "Project
// instructions" setting) are not followed.
//
// A link is looked at with `lstat` and reported by its own path, as `trust.ts` does: a link to a network path can hang
// a stat, and what is behind a link is not what the person wrote there.

/** The most entries one `.claude/rules/` folder is walked for, and how deep. A folder past either is counted as far as it was seen. */
export const MOST_RULE_ENTRIES = 500
export const MOST_RULE_DEPTH = 5

/** The longest the whole lookup may take; a lookup that does not come back finds nothing. */
const DEADLINE_MS = 3000

/** Where an organisation's `CLAUDE.md` is on this system, or null where Claude Code has no such place that torno runs on. */
export function managedPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md'
  if (platform === 'linux') return '/etc/claude-code/CLAUDE.md'
  return null
}

/** The promise's value, or `fallback` should it not come within `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>((done) => {
    timer = setTimeout(() => done(fallback), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

type Seen = { link: true } | { file: number } | { folder: true } | null

/** What a path is, by itself: a link is a link whatever it points at. Null for what is not there or is neither (a socket, a pipe). */
async function seen(path: string): Promise<Seen> {
  const info = await lstat(path).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink()) return { link: true }
  if (info.isFile()) return { file: info.size }
  if (info.isDirectory()) return { folder: true }
  return null
}

/** The home folder as `~`; any other path as it is. */
function shownWith(path: string, homes: readonly string[]): string {
  for (const home of homes) {
    if (path === home) return '~'
    if (path.startsWith(home.endsWith(sep) ? home : home + sep)) return `~${sep}${path.slice(home.length + (home.endsWith(sep) ? 0 : 1))}`
  }
  return path
}

interface Finding {
  entry: InstructionFile
  /** Whether Claude Code reads an `AGENTS.md` only in the absence of this (a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`). */
  counts: boolean
}

/** Finds the entries; one lookup of one folder at a time so that none holds the others. */
class Finder {
  constructor(private readonly homes: readonly string[]) {}

  private entry(path: string, kind: InstructionKind, more: Partial<InstructionFile>): InstructionFile {
    return { path, shown: shownWith(path, this.homes), kind, ...more }
  }

  /** A file of instructions: itself, or a link; nothing for what is not a file. */
  async file(path: string, kind: InstructionKind): Promise<InstructionFile | null> {
    const found = await seen(path)
    if (!found) return null
    if ('link' in found) return this.entry(path, kind, { link: true })
    if ('file' in found) return this.entry(path, kind, { bytes: found.file })
    return null
  }

  /**
   * A `.claude/rules/` folder as one entry: the `.md` files under it, found without following a link and within
   * `MOST_RULE_ENTRIES` entries and `MOST_RULE_DEPTH` levels. A folder it cannot read is passed over. Nothing when it
   * holds no `.md` file and no link.
   */
  async rules(path: string, kind: InstructionKind): Promise<InstructionFile | null> {
    const found = await seen(path)
    if (!found) return null
    if ('link' in found) return this.entry(path, kind, { link: true })
    if (!('folder' in found)) return null
    let entries = 0
    let files = 0
    let size = 0
    let links = 0
    let partial = false
    const walk = async (dir: string, depth: number): Promise<void> => {
      const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const one of names) {
        if (partial && entries >= MOST_RULE_ENTRIES) return
        entries += 1
        if (entries > MOST_RULE_ENTRIES) {
          partial = true
          return
        }
        const at = join(dir, one.name)
        if (one.isSymbolicLink()) links += 1
        else if (one.isDirectory()) {
          if (depth >= MOST_RULE_DEPTH) partial = true
          else await walk(at, depth + 1)
        } else if (one.isFile() && one.name.endsWith('.md')) {
          const info = await lstat(at).catch(() => null)
          if (info?.isFile()) {
            files += 1
            size += info.size
          }
        }
      }
    }
    await walk(path, 0)
    if (files === 0 && links === 0) return null
    return this.entry(path, kind, { files, bytes: size, ...(links > 0 ? { links } : {}), ...(partial ? { partial: true as const } : {}) })
  }

  /** What a folder's own `.claude` holds, none of it looked into should `.claude` be a link. */
  async claude(base: string, kind: InstructionKind): Promise<{ link: InstructionFile | null; memory: InstructionFile | null; rules: InstructionFile | null; agents: InstructionFile | null }> {
    const dir = join(base, '.claude')
    const found = await seen(dir)
    const none = { link: null, memory: null, rules: null, agents: null }
    if (!found) return none
    if ('link' in found) return { ...none, link: this.entry(dir, kind, { link: true }) }
    if (!('folder' in found)) return none
    return {
      link: null,
      memory: await this.file(join(dir, 'CLAUDE.md'), kind),
      rules: await this.rules(join(dir, 'rules'), kind),
      agents: await this.file(join(dir, 'AGENTS.md'), 'agents')
    }
  }
}

/** The folders from the filesystem root down to `dir`. */
function chain(dir: string): string[] {
  const folders: string[] = []
  for (let at = resolve(dir); ; at = dirname(at)) {
    folders.push(at)
    if (dirname(at) === at) break
  }
  return folders.reverse()
}

/**
 * The instruction files Claude Code reads by default for an agent started in `dir`, in the order it loads them
 * (a later one is read after an earlier): the organisation's (`managed`), the person's `~/.claude/CLAUDE.md` and
 * `~/.claude/rules/`, then from the filesystem root down to `dir`, in each folder `CLAUDE.md`, `.claude/CLAUDE.md`,
 * `.claude/rules/` (one entry: the folder, its `.md` files and their size) and `CLAUDE.local.md`. `AGENTS.md` and
 * `.claude/AGENTS.md` of those folders only when none of `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` is in
 * `dir` or above it (the person's and the organisation's files do not count). The person's own `~/.claude` is
 * listed once, though the way up passes through their home folder. Paths and sizes only: no file is read. A link
 * is reported by its own path and not followed, and counts as a file that may be loaded.
 * `home` and `managed` (null: none) are parameters, so that a test gives its own.
 */
export async function findInstructions(dir: string, opts: { home?: string; managed?: string | null } = {}): Promise<InstructionFile[]> {
  const home = resolve(opts.home ?? homedir())
  const managed = opts.managed === undefined ? managedPath() : opts.managed
  const realHome = await realpath(home).catch(() => home)
  const finder = new Finder([...new Set([home, realHome])])
  const out: Finding[] = []
  const push = (entry: InstructionFile | null, counts = false): void => {
    if (entry) out.push({ entry, counts })
  }

  push(managed === null ? null : await finder.file(managed, 'managed'))
  const own = await finder.claude(home, 'user')
  push(own.link)
  push(own.memory)
  push(own.rules)

  const above: Finding[] = []
  for (const at of chain(dir)) {
    const atHome = at === home || (await realpath(at).catch(() => at)) === realHome
    const found: Finding[] = []
    const add = (entry: InstructionFile | null, counts = false): void => {
      if (entry) found.push({ entry, counts })
    }
    add(await finder.file(join(at, 'CLAUDE.md'), 'project'), true)
    const claude = await finder.claude(at, 'project')
    // The person's own `~/.claude` is listed above, once; its AGENTS.md is the folder's like any other.
    if (!atHome) {
      // A `.claude` that is a link may hold a `CLAUDE.md`: it counts for AGENTS.md, as a link does.
      add(claude.link, true)
      add(claude.memory, true)
      add(claude.rules)
    }
    add(await finder.file(join(at, 'CLAUDE.local.md'), 'local'), true)
    above.push(...found)
    // The folder's AGENTS.md come after its CLAUDE files, once it is known whether any CLAUDE file is above.
    const agents = [await finder.file(join(at, 'AGENTS.md'), 'agents'), claude.agents]
    for (const one of agents) if (one) above.push({ entry: one, counts: false })
  }

  const claudeAbove = above.some((one) => one.counts)
  return [...out, ...above.filter((one) => one.entry.kind !== 'agents' || !claudeAbove)].map((one) => one.entry)
}

/**
 * The files found for each object, as the window last asked for them: the window names a row by its place in the
 * list, never by a path, and `open` hands the system the path main found.
 */
export class InstructionList {
  private readonly lists = new Map<string, InstructionFile[]>()

  constructor(private readonly opts: { home?: string; managed?: string | null; deadlineMs?: number } = {}) {}

  /** What there is for an object folder, bounded in time; nothing when the lookup does not come back. */
  look(dir: string): Promise<InstructionFile[]> {
    return withDeadline(findInstructions(dir, this.opts).catch(() => []), this.opts.deadlineMs ?? DEADLINE_MS, [])
  }

  /** What there is for an object, kept as the list its rows are numbered by. */
  async find(objectId: string, dir: string): Promise<InstructionFile[]> {
    const files = await this.look(dir)
    this.lists.set(objectId, files)
    return files
  }

  of(objectId: string): InstructionFile[] {
    return this.lists.get(objectId) ?? []
  }

  /** The row at that place of the list last given for the object; null for any other index. */
  at(objectId: string, index: unknown): InstructionFile | null {
    const list = this.lists.get(objectId)
    return list && typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < list.length ? list[index] : null
  }
}

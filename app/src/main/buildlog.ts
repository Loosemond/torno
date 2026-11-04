import { createHash, randomBytes } from 'node:crypto'
import { appendFile, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { BuildIdentity } from '../shared/git'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { gitState } from './git'
import { ensureIgnored } from './ignored'
import { FOLDER, ownTorno, writeOwn } from './own'

// What a build was made from, kept so that a revision, which counts from 1 in every run, can be told from another
// of an earlier run. `<object>/.torno/builds.jsonl` has a line for each successful build of an object opened in this
// machine: ignored by git, being of this machine, and capped to the last `MOST_LINES`.

export const BUILDS_FILE = 'builds.jsonl'
export const MOST_LINES = 500
/** How many builds of an object are kept in memory, for whoever asks about a revision of this run. */
const KEPT = 40

/** One line of `builds.jsonl`. */
export interface BuildRecord extends BuildIdentity {
  revision: number
  /** When the build landed, ISO 8601. */
  at: string
  /** The run of torno it was made in: revisions are of one run alone. */
  run: string
}

/**
 * The hash of what a model is built from, as far as torno can tell without the kernel's word: the Python files
 * directly in the object's folder and in `common/` beside it (the two folders a change in which has it built
 * again), and the files the build says it imported from elsewhere in the workspace (`Scene.uses`, paths from the
 * workspace with `/`; one that is outside it, or not a `.py` file, is passed over). Each file by its path from the
 * workspace and its bytes, in the order of the paths; a file that cannot be read counts as absent. Twelve hex
 * characters.
 */
export async function sourcesHash(dir: string, uses: readonly string[] = []): Promise<string> {
  const root = dirname(dir)
  const own = async (folder: string): Promise<string[]> => (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.py')).map((name) => join(folder, name))
  const outside = uses.map((file) => resolve(root, file)).filter((file) => file.endsWith('.py') && !relative(root, file).startsWith('..'))
  const files = [...new Set([...(await own(dir)), ...(await own(join(root, 'common'))), ...outside])].sort()
  const hash = createHash('sha256')
  for (const file of files) {
    const bytes = await readFile(file).catch(() => null)
    if (bytes === null) continue
    hash.update(`${relative(root, file).split(sep).join('/')}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 12)
}

/** A line of the file as a record, or null for what is not one. */
export function recordOf(line: string): BuildRecord | null {
  try {
    const r = JSON.parse(line) as Partial<BuildRecord> | null
    if (!r || typeof r !== 'object' || !Number.isInteger(r.revision) || typeof r.at !== 'string' || typeof r.run !== 'string' || typeof r.sources !== 'string') return null
    return { revision: r.revision!, at: r.at, run: r.run, sources: r.sources, ...(typeof r.head === 'string' ? { head: r.head } : {}), ...(r.dirty === true ? { dirty: true as const } : {}) }
  } catch {
    return null
  }
}

/** The records on file for an object, oldest first; none when there is no file. */
export async function readBuilds(dir: string): Promise<BuildRecord[]> {
  const text = await readFile(join(dir, FOLDER, BUILDS_FILE), 'utf8').catch(() => '')
  return text.split('\n').flatMap((line) => {
    const record = line === '' ? null : recordOf(line)
    return record ? [record] : []
  })
}

/**
 * Records the successful builds of this run. Main alone writes the file; it only reads git (`gitState`).
 * One write at a time per object. What cannot be written (a link in place of `.torno`, a full disk) is
 * passed over: the memory still answers for this run.
 */
export class BuildLog {
  readonly run = randomBytes(6).toString('hex')
  private readonly kept = new Map<string, Map<number, BuildRecord>>()
  private readonly turns = new Map<string, Promise<void>>()

  /** What the build of this run with this revision was made from; undefined when none is known. */
  identity(objectId: string, revision: number): BuildIdentity | undefined {
    const record = this.kept.get(objectId)?.get(revision)
    if (!record) return undefined
    return { sources: record.sources, ...(record.head ? { head: record.head } : {}), ...(record.dirty ? { dirty: true as const } : {}) }
  }

  /** Forget an object (it was closed). */
  forget(objectId: string): void {
    this.kept.delete(objectId)
  }

  /** The build has landed: what it was made from is found, kept, and added to the file. Resolves with the record. */
  record(obj: ObjectInfo, revision: number, scene: Pick<Scene, 'uses'>, now: Date = new Date()): Promise<BuildRecord> {
    const made = (async (): Promise<BuildRecord> => {
      const [sources, git] = await Promise.all([sourcesHash(obj.dir, scene.uses), gitState(obj.dir)])
      const record: BuildRecord = { revision, at: now.toISOString(), run: this.run, sources, ...(git?.head ? { head: git.head } : {}), ...(git?.head && git.changed > 0 ? { dirty: true as const } : {}) }
      const byRevision = this.kept.get(obj.id) ?? new Map<number, BuildRecord>()
      byRevision.set(revision, record)
      for (const old of [...byRevision.keys()].slice(0, Math.max(0, byRevision.size - KEPT))) byRevision.delete(old)
      this.kept.set(obj.id, byRevision)
      return record
    })()
    // One write at a time per object, in the order the builds landed.
    const turn = (this.turns.get(obj.dir) ?? Promise.resolve()).then(() => made.then((record) => this.write(obj.dir, record))).catch(() => {})
    this.turns.set(obj.dir, turn)
    void turn.finally(() => {
      if (this.turns.get(obj.dir) === turn) this.turns.delete(obj.dir)
    })
    return made
  }

  /** Ends when every write asked for is done. */
  async settled(): Promise<void> {
    await Promise.all([...this.turns.values()])
  }

  private async write(dir: string, record: BuildRecord): Promise<void> {
    const folder = await ownTorno(dir)
    await ensureIgnored(dir, [BUILDS_FILE])
    const line = `${JSON.stringify(record)}\n`
    const path = join(folder, BUILDS_FILE)
    const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    const lines = text.split('\n').filter((l) => l !== '')
    // Within the cap, and whole lines: appended. Else the last lines, written whole or not at all.
    if (lines.length < MOST_LINES && (text === '' || text.endsWith('\n'))) {
      await appendFile(path, line)
      return
    }
    await writeOwn(dir, BUILDS_FILE, `${[...lines.slice(-(MOST_LINES - 1)), line.trimEnd()].join('\n')}\n`)
  }
}

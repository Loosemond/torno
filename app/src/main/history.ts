import { readFile, readdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { type HistoryDimensions, type HistoryEntry, HISTORY_ID, HISTORY_KEPT, changeLine, sceneFacts } from '../shared/history'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { writeFileAtomic } from './atomic'
import { type BuildRecord, hashOf, readSources } from './buildlog'
import { ensureIgnored } from './ignored'
import { ownTorno } from './own'
import { thumbnailRefusal } from './show/cards'

// The history of an object's builds (#56): `<object>/.torno/history/`, ignored by git (the copies duplicate what
// git is for, and are of this machine). Main alone writes it, `History` the one writer, one change at a time per
// object, each file whole or not at all.
//
//   index.json      { next, entries }: the kept builds, oldest first, and the number the next one is given
//   h41/scene.json  the scene of that build, without its mesh and what it printed (what `diff` compares)
//   h41/source/...  copies of the .py files it was made from, by their paths from the workspace
//   h41/thumb.png   a picture of it, when the window drew one
//
// A build's folder is written before the index names it, and the index is replaced whole: a crash leaves the
// index as it was and, at most, a folder no index names, which the next change sweeps away. Nothing here is
// ever written outside the object's `.torno/`; torno never restores a file of the person's from it.

export const HISTORY_FOLDER = 'history'
const INDEX = 'index.json'
/** The most bytes of one source file that is copied, and of the copies of one build. */
export const MOST_FILE_BYTES = 512 * 1024
export const MOST_COPY_BYTES = 2 * 1024 * 1024
/** A picture larger than this is not kept (the cards' own is at most 512 KB, and a hundred of those are no small thing). */
export const MOST_THUMB_BYTES = 160 * 1024

interface Index {
  next: number
  entries: HistoryEntry[]
}

const number = (id: string): number => Number(id.slice(1))

function entryOf(raw: unknown): HistoryEntry | null {
  const e = raw as Partial<HistoryEntry> | null
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !HISTORY_ID.test(e.id)) return null
  if (typeof e.at !== 'string' || typeof e.run !== 'string' || !Number.isInteger(e.revision) || typeof e.sources !== 'string' || typeof e.model !== 'string' || !Array.isArray(e.files) || typeof e.line !== 'string') return null
  return e as HistoryEntry
}

/** The path of a file of a kept build, when it is one of the build's copies (never a path that leaves the folder). */
function copyPath(folder: string, file: string): string | null {
  const clean = posix.normalize(file)
  if (clean.startsWith('..') || clean.startsWith('/') || clean.includes('\\') || clean.includes('\0')) return null
  return join(folder, 'source', ...clean.split('/'))
}

/** The folder `.torno/history/` of an object, when torno may write there (a link or a file in its place rejects). */
const folderOf = (dir: string): Promise<string> => ownTorno(dir, HISTORY_FOLDER)

/** A JSON file, or null when it is not there or does not parse. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function readIndex(dir: string): Promise<Index> {
  const path = join(dir, '.torno', HISTORY_FOLDER, INDEX)
  const found = await readJson<Partial<Index>>(path)
  const entries = Array.isArray(found?.entries) ? found.entries.flatMap((e) => entryOf(e) ?? []) : []
  // The next number is never below one a folder has already: an index lost or broken does not give a number twice.
  const folders = (await readdir(join(dir, '.torno', HISTORY_FOLDER)).catch(() => [] as string[])).filter((name) => HISTORY_ID.test(name)).map(number)
  const next = Math.max(Number.isInteger(found?.next) ? found!.next! : 1, ...entries.map((e) => number(e.id) + 1), ...folders.map((n) => n + 1), 1)
  return { next, entries }
}

/** The builds kept of an object, oldest first; none when there is no history. */
export async function readHistory(dir: string): Promise<HistoryEntry[]> {
  return (await readIndex(dir)).entries
}

/** The scene a kept build left (without its mesh), or null. */
export async function readHistoryScene(dir: string, id: string): Promise<Scene | null> {
  if (!HISTORY_ID.test(id)) return null
  return readJson<Scene>(join(dir, '.torno', HISTORY_FOLDER, id, 'scene.json'))
}

/** One copied source file of a kept build, as text; null when the build has no such copy. */
export async function readHistorySource(dir: string, entry: Pick<HistoryEntry, 'id' | 'files'>, file: string): Promise<string | null> {
  if (!HISTORY_ID.test(entry.id) || !entry.files.includes(file)) return null
  const path = copyPath(join(dir, '.torno', HISTORY_FOLDER, entry.id), file)
  return path === null ? null : readFile(path, 'utf8').catch(() => null)
}

/** The picture of a kept build, or null. */
export async function readHistoryThumb(dir: string, id: string): Promise<Buffer | null> {
  if (!HISTORY_ID.test(id)) return null
  return readFile(join(dir, '.torno', HISTORY_FOLDER, id, 'thumb.png')).catch(() => null)
}

/** Where the copy of a kept build's file lies on disk: what "Ask the agent to go back" names. Null for an id or file the build does not have. */
export function historySourcePath(dir: string, entry: Pick<HistoryEntry, 'id' | 'files'>, file: string): string | null {
  if (!HISTORY_ID.test(entry.id) || !entry.files.includes(file)) return null
  return copyPath(join(dir, '.torno', HISTORY_FOLDER, entry.id), file)
}

/**
 * Keeps the builds that landed: an entry for each (`keep`), its picture when the window has drawn one
 * (`thumbnail`), the person's stars (`star`). One change at a time per object, in the order they were asked for.
 * What cannot be written (a link in place of `.torno`, a full disk) is passed over: the history is a help, never a
 * reason for a build to fail.
 */
export class History {
  private readonly turns = new Map<string, Promise<unknown>>()
  private readonly listeners: Array<(dir: string) => void> = []

  /** Told, with the object's folder, whenever the history of an object changed. */
  onChange(cb: (dir: string) => void): void {
    this.listeners.push(cb)
  }

  private changed(dir: string): void {
    for (const cb of this.listeners) {
      try {
        cb(dir)
      } catch {
        // A listener is no reason for the history to fail.
      }
    }
  }

  /** Runs `job` after the ones asked for before it on this object. Its failure rejects its own promise only. */
  private turn<T>(dir: string, job: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(dir) ?? Promise.resolve()).catch(() => {}).then(job)
    this.turns.set(dir, run)
    void run.then(() => undefined, () => undefined).then(() => {
      if (this.turns.get(dir) === run) this.turns.delete(dir)
    })
    return run
  }

  /** Ends when every change asked for is done. */
  async settled(): Promise<void> {
    while (this.turns.size > 0) await Promise.all([...this.turns.values()].map((t) => t.catch(() => {})))
  }

  /**
   * The build that landed (`record`, as `BuildLog` found it) is kept. A build made from the sources the newest
   * entry was made from is not kept again: nothing is new in it. Resolves with the entry, the newest's when it was
   * that, and null when nothing could be written.
   */
  keep(obj: ObjectInfo, made: Promise<BuildRecord>, scene: Scene): Promise<HistoryEntry | null> {
    if (obj.model === null) return Promise.resolve(null)
    const model = obj.model
    return this.turn(obj.dir, async () => {
      try {
        const record = await made
        const index = await readIndex(obj.dir)
        const newest = index.entries.at(-1)
        if (newest && newest.sources === record.sources) return newest
        const sources = await readSources(obj.dir, scene.uses ?? [])
        // The copies are of what the build read only when the files are as they were when it was hashed.
        const total = sources.reduce((sum, f) => sum + f.bytes.length, 0)
        const copied = hashOf(sources) === record.sources && total <= MOST_COPY_BYTES && sources.every((f) => f.bytes.length <= MOST_FILE_BYTES) ? sources : []
        const before = newest ? await readHistoryScene(obj.dir, newest.id) : null
        const id = `h${index.next}`
        const entry: HistoryEntry = {
          id,
          at: record.at,
          run: record.run,
          revision: record.revision,
          sources: record.sources,
          ...(record.head ? { head: record.head } : {}),
          ...(record.dirty ? { dirty: true as const } : {}),
          model,
          files: copied.map((f) => f.path),
          ...sceneFacts(scene),
          line: changeLine(before ?? undefined, scene)
        }
        const folder = join(await folderOf(obj.dir), id)
        await ensureIgnored(obj.dir, [`${HISTORY_FOLDER}/`])
        for (const file of copied) {
          const to = copyPath(folder, file.path)
          if (to !== null) await writeFileAtomic(to, file.bytes)
        }
        // What `diff` needs, and no more: neither the mesh's bytes (they were never here) nor what the model printed.
        await writeFileAtomic(join(folder, 'scene.json'), JSON.stringify({ ...scene, output: '' }))
        const entries = [...index.entries, entry]
        const gone = pruned(entries)
        await writeFileAtomic(join(await folderOf(obj.dir), INDEX), `${JSON.stringify({ next: index.next + 1, entries: entries.filter((e) => !gone.includes(e)) })}\n`)
        await sweep(obj.dir, new Set(entries.filter((e) => !gone.includes(e)).map((e) => e.id)))
        this.changed(obj.dir)
        return entry
      } catch (e) {
        console.error(`cannot keep the build of ${obj.id} in its history: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    })
  }

  /** The window drew a picture of the build of this run with this revision: it is kept with its entry, when it has one and the picture is small enough. */
  thumbnail(obj: ObjectInfo, run: string, revision: number, png: Uint8Array): Promise<boolean> {
    return this.change(obj, (index) => {
      const entry = index.entries.findLast((e) => e.run === run && e.revision === revision)
      if (!entry || entry.thumb || png.length > MOST_THUMB_BYTES || thumbnailRefusal(png) !== null) return null
      return { entry: { ...entry, thumb: true as const }, write: async (folder) => writeFileAtomic(join(folder, entry.id, 'thumb.png'), png) }
    })
  }

  /** What the person's dimensions said of the build of this run with this revision, as the check that followed it left them. */
  dimensions(obj: ObjectInfo, run: string, revision: number, counts: HistoryDimensions): Promise<boolean> {
    return this.change(obj, (index) => {
      const entry = index.entries.findLast((e) => e.run === run && e.revision === revision)
      const now = entry?.dimensions
      if (!entry || (counts.pass + counts.fail + counts.none === 0 && !now) || (now && now.pass === counts.pass && now.fail === counts.fail && now.none === counts.none)) return null
      return { entry: { ...entry, dimensions: counts } }
    })
  }

  /** The person starred a kept build (or took the star away): a starred one is not pruned. False for an id that is not kept. */
  star(obj: ObjectInfo, id: string, starred: boolean): Promise<boolean> {
    return this.change(obj, (index) => {
      const entry = index.entries.find((e) => e.id === id)
      if (!entry || (entry.starred === true) === starred) return null
      const { starred: _was, ...rest } = entry
      return { entry: starred ? { ...rest, starred: true as const } : rest }
    })
  }

  /** One entry of the index replaced, after `job` has said which and what else to write; false when it said nothing. */
  private change(obj: ObjectInfo, job: (index: Index) => { entry: HistoryEntry; write?: (folder: string) => Promise<void> } | null): Promise<boolean> {
    return this.turn(obj.dir, async () => {
      try {
        const index = await readIndex(obj.dir)
        const asked = job(index)
        if (!asked) return false
        const folder = await folderOf(obj.dir)
        await asked.write?.(folder)
        const entries = index.entries.map((e) => (e.id === asked.entry.id ? asked.entry : e))
        await writeFileAtomic(join(folder, INDEX), `${JSON.stringify({ next: index.next, entries })}\n`)
        this.changed(obj.dir)
        return true
      } catch (e) {
        console.error(`cannot change the history of ${obj.id}: ${e instanceof Error ? e.message : String(e)}`)
        return false
      }
    })
  }
}

/** The entries to let go: the oldest that are not starred, beyond the newest `HISTORY_KEPT`; the newest is never one. */
function pruned(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const loose = entries.filter((e) => !e.starred)
  return loose.slice(0, Math.max(0, loose.length - HISTORY_KEPT)).filter((e) => e !== entries.at(-1))
}

/** Removes the folders of builds the index does not name: those pruned, and any a crash left. Only folders named like a build's. */
async function sweep(dir: string, kept: ReadonlySet<string>): Promise<void> {
  const folder = await folderOf(dir)
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (HISTORY_ID.test(name) && !kept.has(name)) await rm(join(folder, name), { recursive: true, force: true }).catch(() => {})
  }
}

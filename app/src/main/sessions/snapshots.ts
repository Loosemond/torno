import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type FileChange, MAX_FILE_BYTES, type TurnChanges } from '../../shared/changes'

// The text of the model's source files at two moments of a turn, for the sheet "See changes". Read, never written:
// the files are the person's and the agent's, and torno does not write the model. What is read is the `.py` files
// directly in the project's folder (as `sourceFolders` of `show/cards.ts` has it, the folder alone and not
// `<workspace>/common`), plain files only, and nothing is kept on disk.

/** The files of a folder looked at, at most: a folder with more is not a project's. */
export const MAX_FILES = 60

/** How many turns a session keeps the changes of, and how many characters of text in all (the oldest go first). */
export const MAX_TURNS = 20
export const MAX_KEPT_CHARS = 4 * 1024 * 1024

/** What a file was at one moment: its text, or, when it is too large to keep, only a signature to tell a change by. */
export type Snapshot = Map<string, { text: string } | { big: string }>

/** The text of a plain file of at most `MAX_FILE_BYTES`, or null when it is no plain file, is larger, or is not what `size` said. */
async function readSmall(path: string, size: number): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return null
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES || opened.size !== size) return null
    const bytes = Buffer.alloc(opened.size)
    let got = 0
    while (got < bytes.length) {
      const { bytesRead } = await handle.read(bytes, got, bytes.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return bytes.toString('utf8', 0, got)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The `.py` files directly in a folder as they are now. Anything unreadable is left out; a folder that is not there is empty. */
export async function snapshotSources(dir: string): Promise<Snapshot> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.py')).sort().slice(0, MAX_FILES)
  const snapshot: Snapshot = new Map()
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name)
      const stat = await lstat(path).catch(() => null)
      if (!stat?.isFile()) return
      if (stat.size > MAX_FILE_BYTES) {
        snapshot.set(name, { big: `${stat.size}:${stat.mtimeMs}` })
        return
      }
      const text = await readSmall(path, stat.size)
      if (text !== null) snapshot.set(name, { text })
    })
  )
  return snapshot
}

/** The files that differ between two snapshots, by name; a file larger than can be kept is said to have changed and holds no text. */
export function changesBetween(before: Snapshot, after: Snapshot): TurnChanges {
  const files: FileChange[] = []
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(file)
    const now = after.get(file)
    if ((was && 'big' in was) || (now && 'big' in now)) {
      const same = was && now && 'big' in was && 'big' in now && was.big === now.big
      if (!same) files.push({ file, before: null, after: null, tooLarge: true })
      continue
    }
    const a = was && 'text' in was ? was.text : null
    const b = now && 'text' in now ? now.text : null
    if (a !== b) files.push({ file, before: a, after: b })
  }
  return { files }
}

const sizeOf = (changes: TurnChanges): number => changes.files.reduce((n, f) => n + (f.before?.length ?? 0) + (f.after?.length ?? 0), 0)

/**
 * The changes of the last turns of one session, by the id of the turn's item: at most `MAX_TURNS` of them and
 * `MAX_KEPT_CHARS` of text, the oldest let go first. Held in memory and nowhere else.
 */
export class KeptChanges {
  private readonly kept = new Map<string, TurnChanges>()

  keep(turnId: string, changes: TurnChanges): void {
    this.kept.delete(turnId)
    this.kept.set(turnId, changes)
    let total = [...this.kept.values()].reduce((n, c) => n + sizeOf(c), 0)
    for (const [id, old] of this.kept) {
      if (this.kept.size <= MAX_TURNS && total <= MAX_KEPT_CHARS) break
      if (id === turnId) break
      this.kept.delete(id)
      total -= sizeOf(old)
    }
  }

  get(turnId: string): TurnChanges | undefined {
    return this.kept.get(turnId)
  }
}

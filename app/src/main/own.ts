import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

// `<object>/.torno/`: the one folder of a workspace torno writes into. Its name is said here and nowhere else,
// and so is the rule every write there is held to: it is a real folder inside the object. A link in its place
// (a workspace cloned or copied from elsewhere may hold one) would have torno write wherever it leads, outside
// the object; a file in its place is nothing to write into. Either is refused before anything is written, with
// a sentence the person can act on, and the window is told of it once for each folder.

/** The name of torno's own folder in an object's folder. */
export const FOLDER = '.torno'

/** The folders the window was told of. */
const told = new Set<string>()
let listener: ((dir: string, message: string) => void) | null = null

/** Who is told, once for each object's folder, that its `.torno` is not torno's own to write into. Null for no one, and whoever is named next is told anew. */
export function onNotOwn(cb: ((dir: string, message: string) => void) | null): void {
  listener = cb
  told.clear()
}

function refused(dir: string, message: string): Error {
  if (!told.has(dir)) {
    told.add(dir)
    try {
      listener?.(dir, message)
    } catch {
      // Whoever listens is not a reason to say something else of the folder.
    }
  }
  return new Error(message)
}

/**
 * `<dir>/.torno`, when torno may write there: it is a real folder, or not there yet (whoever writes makes it).
 * Rejects, with a plain reason, when a link or a file is in its place. Asked before every write under it.
 */
export async function ownTorno(dir: string): Promise<string> {
  const path = join(dir, FOLDER)
  const what = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (what?.isSymbolicLink()) throw refused(dir, `${path} is a link, not a folder of torno's own inside the object: torno writes nothing there. Put a real folder in its place.`)
  if (what && !what.isDirectory()) throw refused(dir, `${path} is a file, not a folder: torno writes nothing there. Remove it.`)
  return path
}

/** Writes `<dir>/.torno/<name>` whole or not at all (`writeFileAtomic`), once the folder is known to be torno's own. */
export async function writeOwn(dir: string, name: string, data: string | Uint8Array): Promise<void> {
  await writeFileAtomic(join(await ownTorno(dir), name), data)
}

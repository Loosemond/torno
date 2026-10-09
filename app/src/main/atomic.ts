import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The last write to each file, so that writes of one file land in the order they were made. */
const writes = new Map<string, Promise<void>>()

/**
 * Writes a file through a temp file beside it, creating its folder. Readers
 * see the old file or the new one, never half of one. A write that fails
 * leaves the old file and no temp file, and does not hold up the next.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const write = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      try {
        await writeFile(temp, data)
        await rename(temp, path)
      } catch (e) {
        await rm(temp, { force: true }).catch(() => {})
        throw e
      }
    })
    .finally(() => {
      if (writes.get(path) === write) writes.delete(path)
    })
  writes.set(path, write)
  return write
}

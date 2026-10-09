import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEEP = 20
const NUMBERED = /^(\d+)\.png$/

/** One save at a time for each folder, so that two pictures never take the same number. */
const saves = new Map<string, Promise<unknown>>()

/**
 * Keeps a picture the agent was given as `<dir>/.torno/views/<n>.png`, numbered
 * on from the last, and removes all but the newest 20. Returns the file's path.
 */
export function saveView(dir: string, png: Uint8Array): Promise<string> {
  const folder = join(dir, '.torno', 'views')
  const save = (saves.get(folder) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      const numbers = (await readdir(folder))
        .map((name) => NUMBERED.exec(name))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]))
        .sort((a, b) => a - b)
      const n = (numbers.at(-1) ?? 0) + 1
      const path = join(folder, `${n}.png`)
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, png)
      await rename(temp, path)
      for (const old of numbers.slice(0, Math.max(0, numbers.length - (KEEP - 1)))) {
        await rm(join(folder, `${old}.png`), { force: true })
      }
      return path
    })
    .finally(() => {
      if (saves.get(folder) === save) saves.delete(folder)
    })
  saves.set(folder, save)
  return save
}

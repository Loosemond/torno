import { mkdir, open, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { type ExportFormat, EXTENSIONS } from '../../shared/exportdata'
import { ensureIgnored } from '../ignored'
import { FOLDER, ownTorno } from '../own'

// Where an export goes. The person chooses the file in a save dialog, which opens in `<object>/.torno/exports/`;
// that folder is torno's to make. The file itself is the one thing torno ever writes outside `.torno/`: to the
// path the dialog answered with, once, through a file beside it that is gone when the write ends. No folder is
// made for it. A file of the model (STEP, STL, 3MF) is read back and checked in that file beside it, before it takes
// the name: one that fails is never named.

export const EXPORTS = 'exports'

/** `<dir>/.torno/exports/<name>-r<revision>.html` (or `.step`, `.stl`, `.3mf`); `<name>.html` for a file of several objects, which is of no one build. */
export function defaultExportPath(dir: string, name: string, revision?: number, format: ExportFormat = 'html'): string {
  return join(dir, FOLDER, EXPORTS, `${name}${revision === undefined ? '' : `-r${revision}`}.${EXTENSIONS[format][0]}`)
}

/** Makes `<dir>/.torno/exports/`, which git is told to pass over (`ensureIgnored`), so the dialog can open there. Refused where that folder, or `.torno`, is a link (`ownTorno`). */
export async function prepareExports(dir: string): Promise<string> {
  const folder = await ownTorno(dir, EXPORTS)
  await mkdir(folder, { recursive: true })
  await ensureIgnored(dir, [`${EXPORTS}/`])
  return folder
}

/** The path a dialog answered with, as the file is written: ending in the format's extension (`.html` or `.htm`, `.step` or `.stp`, `.stl`, `.3mf`), which is added when it does not. */
export function exportPath(path: string, format: ExportFormat): string {
  const ext = EXTENSIONS[format]
  return ext.some((one) => path.toLowerCase().endsWith(`.${one}`)) ? path : `${path}.${ext[0]}`
}

/** What an export still being written is told when torno quits: it is given up, and what it made removed. */
export const QUIT_MID_EXPORT = 'torno quit while the file was made: nothing was saved'

/** The writes under way, each with what gives it up: torno waits for them as it quits (`exportsUnderWay`). */
const underWay = new Set<{ written: Promise<unknown>; stop: () => void }>()

/** Every export still being written, settled once each is written or given up and its `.tmp` removed; null for none. */
export function exportsUnderWay(): Promise<unknown> | null {
  return underWay.size === 0 ? null : Promise.allSettled([...underWay].map((one) => one.written))
}

/** Gives up every export still being written (torno quits): a check waited on is not waited on, nothing takes its name, and each `.tmp` is removed. */
export function stopExports(): void {
  for (const one of underWay) one.stop()
}

/**
 * Writes a file to the path the person chose, whole or not at all: into a file beside it that torno makes
 * (`<path>.<random>.tmp`, never one that is there already), on the disk before it takes the chosen name. `check`,
 * when given, is given that file once it is whole and closed, and what it throws is what the write fails with: the
 * file never takes the name. A write that fails, or a file that fails its check, leaves whatever had that name as
 * it was, and removes what it made. No folder is made for it: one that is not there is an error, said in the sheet.
 * Until it ends it is among `exportsUnderWay`, and `stopExports` gives it up the same way.
 */
export async function writeExport(path: string, data: string | Uint8Array, check?: (beside: string) => Promise<void>): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${path} is no whole path: nothing was written`)
  let given = false
  let stop = (): void => {}
  const stopped = new Promise<never>((_, reject) => {
    stop = () => {
      given = true
      reject(new Error(QUIT_MID_EXPORT))
    }
  })
  stopped.catch(() => {})
  // A name of this write alone: what a crash left under another is not in its way.
  const beside = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const write = async (): Promise<void> => {
    const file = await open(beside, 'wx')
    try {
      try {
        await file.writeFile(data)
        await file.sync()
      } finally {
        await file.close()
      }
      if (check) await Promise.race([check(beside), stopped])
      if (given) throw new Error(QUIT_MID_EXPORT)
      await rename(beside, path)
    } catch (e) {
      await rm(beside, { force: true }).catch(() => {})
      throw e
    }
  }
  const written = write()
  const one = { written, stop }
  underWay.add(one)
  try {
    await written
  } finally {
    underWay.delete(one)
  }
}

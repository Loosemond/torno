import { mkdir, open, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ensureIgnored } from '../ignored'
import { FOLDER, ownTorno } from '../own'

// Where an export goes. The person chooses the file in a save dialog, which opens in `<object>/.torno/exports/`;
// that folder is torno's to make. The file itself is the one thing torno ever writes outside `.torno/`: to the
// path the dialog answered with, once, through a file beside it that is gone when the write ends. No folder is
// made for it.

export const EXPORTS = 'exports'

/** `<dir>/.torno/exports/<name>-r<revision>.html`; `<name>.html` for a file of several objects, which is of no one build. */
export function defaultExportPath(dir: string, name: string, revision?: number): string {
  return join(dir, FOLDER, EXPORTS, `${name}${revision === undefined ? '' : `-r${revision}`}.html`)
}

/** Makes `<dir>/.torno/exports/`, which git is told to pass over (`ensureIgnored`), so the dialog can open there. Refused where that folder, or `.torno`, is a link (`ownTorno`). */
export async function prepareExports(dir: string): Promise<string> {
  const folder = await ownTorno(dir, EXPORTS)
  await mkdir(folder, { recursive: true })
  await ensureIgnored(dir, [`${EXPORTS}/`])
  return folder
}

/** The path a dialog answered with, as the file is written: ending in `.html`. */
export function htmlPath(path: string): string {
  return /\.html?$/i.test(path) ? path : `${path}.html`
}

/**
 * Writes the page to the path the person chose, whole or not at all: into a file beside it that torno makes
 * (`<path>.<random>.tmp`, never one that is there already), on the disk before it takes the chosen name. A write
 * that fails leaves whatever had that name as it was, and removes what it made. No folder is made for it: one
 * that is not there is an error, said in the sheet.
 */
export async function writeExport(path: string, html: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${path} is no whole path: nothing was written`)
  // A name of this write alone: what a crash left under another is not in its way.
  const beside = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const file = await open(beside, 'wx')
  try {
    try {
      await file.writeFile(html)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(beside, path)
  } catch (e) {
    await rm(beside, { force: true }).catch(() => {})
    throw e
  }
}

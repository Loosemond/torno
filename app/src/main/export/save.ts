import { mkdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ensureIgnored } from '../ignored'

// Where an export goes. The person chooses the file in a save dialog, which opens in `<object>/.torno/exports/`;
// that folder is torno's to make. The file itself is the one thing torno ever writes outside `.torno/`: to the
// path the dialog answered with, that path only, once. No folder is made for it and no other file beside it.

export const EXPORTS = 'exports'

/** `<dir>/.torno/exports/<name>-r<revision>.html`; `<name>.html` for a file of several objects, which is of no one build. */
export function defaultExportPath(dir: string, name: string, revision?: number): string {
  return join(dir, '.torno', EXPORTS, `${name}${revision === undefined ? '' : `-r${revision}`}.html`)
}

/** Makes `<dir>/.torno/exports/`, which git is told to pass over (`ensureIgnored`), so the dialog can open there. */
export async function prepareExports(dir: string): Promise<string> {
  const folder = join(dir, '.torno', EXPORTS)
  await mkdir(folder, { recursive: true })
  await ensureIgnored(dir, [`${EXPORTS}/`])
  return folder
}

/** The path a dialog answered with, as the file is written: ending in `.html`. */
export function htmlPath(path: string): string {
  return /\.html?$/i.test(path) ? path : `${path}.html`
}

/**
 * Writes the page to the path the person chose: that one file, on the disk before this resolves, with no
 * temporary file beside it and no folder made for it (a folder that is not there is an error, said in the sheet).
 */
export async function writeExport(path: string, html: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${path} is no whole path: nothing was written`)
  const file = await open(path, 'w')
  try {
    await file.writeFile(html)
    await file.sync()
  } finally {
    await file.close()
  }
}

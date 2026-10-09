import { randomInt } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Scan } from '../../shared/scans'

/** What names a scan: `S1`. Its folder under `.torno/scans/` has this name, so nothing else is ever taken for one. */
export const SCAN_ID = /^S[1-9]\d{0,14}$/

/** The file a scan's mesh is first written to. A conversion writes the next (`mesh.1.bin`, `mesh.2.bin`), and the record says which is the scan's. */
export const MESH = 'mesh.bin'
/** What a mesh file may be named in a record: nothing but a name of torno's own, in the scan's folder. */
export const MESH_NAME = /^mesh(\.[1-9]\d{0,8})?\.bin$/
/** A mesh file, or the temp file the import process writes one through (`scanfile.write_bin`: `<mesh>.<pid>.tmp`). */
const MESH_FILE = /^mesh(\.\d+)?\.bin(\.\d+\.tmp)?$/
const MESH_TEMP = /^mesh(\.\d+)?\.bin\.\d+\.tmp$/
/**
 * In the folder of an import that is under way: written when the folder is
 * made, deleted once the scan is in `scans.json`. A folder that holds it and
 * has no scan is of an import that never ended, and is nothing to keep.
 */
export const IMPORTING = 'importing'

/** `<object>/.torno/scans/<id>/`: all that is ever written or deleted for a scan. The id is checked here, whoever gave it. */
export function scanFolder(dir: string, id: string): string {
  if (!SCAN_ID.test(id)) throw new RangeError(`${id} is no scan id`)
  return join(dir, '.torno', 'scans', id)
}

/** The file of a scan's mesh, in its folder. */
export function meshName(scan: Pick<Scan, 'imported'>): string {
  return scan.imported.mesh ?? MESH
}

/**
 * The file a new mesh of a scan is written to, beside the one it has: a name
 * that no file of the folder has. `number` draws its number, at random
 * unless a test says otherwise: an import process that outlived a torno
 * which was killed still holds the name it was given, and may put its file
 * there at any time. A name it cannot have been given is never the scan's.
 */
export async function freshMeshName(folder: string, number: () => number = () => randomInt(1, 1_000_000_000)): Promise<string> {
  const taken = new Set(await names(folder))
  for (;;) {
    const name = `mesh.${number()}.bin`
    if (!MESH_NAME.test(name)) throw new RangeError(`${name} is no name for a mesh`)
    if (!taken.has(name)) return name
  }
}

const names = (folder: string): Promise<string[]> => readdir(folder).catch(() => [])
/** What is in a folder, with what each is: a link is neither a file nor a folder here, whatever it leads to. */
const entries = (folder: string): Promise<Dirent[]> => readdir(folder, { withFileTypes: true }).catch(() => [])

/**
 * The first number no scan folder of the object has: an id is the name of a
 * folder, and one that is there is taken, whatever the scans file says or
 * has lost.
 */
export async function nextFolderId(dir: string): Promise<number> {
  let next = 1
  for (const name of await names(join(dir, '.torno', 'scans'))) if (SCAN_ID.test(name)) next = Math.max(next, Number(name.slice(1)) + 1)
  return next
}

/** Has the meshes left out of what git is given: a mesh is tens of megabytes, and can be made again from its source. What else is in .torno/ is safe to commit. */
export async function ignoreMeshes(dir: string): Promise<void> {
  await mkdir(join(dir, '.torno', 'scans'), { recursive: true })
  await writeFile(join(dir, '.torno', 'scans', '.gitignore'), 'mesh*.bin\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
}

/** Deletes a mesh file and the temp files of a process that was killed as it wrote it. */
export async function removeMesh(folder: string, name: string): Promise<void> {
  const mine = (await names(folder)).filter((found) => found === name || (found.startsWith(`${name}.`) && MESH_TEMP.test(found)))
  await Promise.all(mine.map((found) => rm(join(folder, found), { force: true }).catch(() => {})))
}

/**
 * Clears away what torno left behind when it was stopped in the middle of
 * something, as the scans of an object are first read:
 *
 * - in the folder of each scan, every temp file of a mesh, and every mesh
 *   file its record does not name (a conversion writes a new file, and the
 *   record is what says it was made): but those only while the mesh it does
 *   name is there. Where that is missing (an older `scans.json` was put
 *   back), another mesh in the folder may be all there is of the scan;
 * - the folder of an import that never ended (`IMPORTING`, and no scan);
 *   one that holds a region's `.mask` is kept, and only loses its temp files.
 *
 * `busy` are the ids with an import or a conversion under way: theirs is
 * left alone. A folder with no scan and no sign of an import is left too:
 * it is what remains of a scans file that was lost. Only real folders and
 * real files are looked at: nothing is deleted through a link, nor a link
 * itself.
 */
export async function sweep(dir: string, scans: readonly Scan[], busy: ReadonlySet<string>): Promise<void> {
  const known = new Map(scans.map((scan) => [scan.id, meshName(scan)]))
  const remove = (path: string): Promise<void> => rm(path, { recursive: true, force: true }).catch(() => {})
  for (const entry of await entries(join(dir, '.torno', 'scans'))) {
    const id = entry.name
    if (!entry.isDirectory() || !SCAN_ID.test(id) || busy.has(id)) continue
    const folder = scanFolder(dir, id)
    const files = (await entries(folder)).filter((found) => found.isFile()).map((found) => found.name)
    const mesh = known.get(id)
    const gone = (name: string): boolean => {
      if (mesh === undefined) return MESH_TEMP.test(name)
      return name === IMPORTING || MESH_TEMP.test(name) || (MESH_FILE.test(name) && name !== mesh && files.includes(mesh))
    }
    if (mesh === undefined && !files.includes(IMPORTING)) continue
    if (mesh === undefined && !(await names(folder)).some((name) => name.endsWith('.mask'))) await remove(folder)
    else await Promise.all(files.filter(gone).map((name) => remove(join(folder, name))))
  }
}

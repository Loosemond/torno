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

/** The file a conversion of the mesh in `current` is written to: the next number. */
export function nextMeshName(current: string): string {
  return `mesh.${Number(/^mesh\.(\d+)\.bin$/.exec(current)?.[1] ?? 0) + 1}.bin`
}

const names = (folder: string): Promise<string[]> => readdir(folder).catch(() => [])

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
 * - in the folder of each scan, every mesh file its record does not name
 *   (a conversion writes a new file, and the record is what says it was
 *   made), and every temp file of one;
 * - the folder of an import that never ended (`IMPORTING`, and no scan);
 *   one that holds a region's `.mask` is kept, and only loses its temp files.
 *
 * `busy` are the ids with an import or a conversion under way: theirs is
 * left alone. A folder with no scan and no sign of an import is left too:
 * it is what remains of a scans file that was lost.
 */
export async function sweep(dir: string, scans: readonly Scan[], busy: ReadonlySet<string>): Promise<void> {
  const known = new Map(scans.map((scan) => [scan.id, meshName(scan)]))
  const remove = (path: string): Promise<void> => rm(path, { recursive: true, force: true }).catch(() => {})
  for (const id of await names(join(dir, '.torno', 'scans'))) {
    if (!SCAN_ID.test(id) || busy.has(id)) continue
    const folder = scanFolder(dir, id)
    const found = await names(folder)
    const mesh = known.get(id)
    if (mesh !== undefined) await Promise.all(found.filter((name) => name === IMPORTING || (MESH_FILE.test(name) && name !== mesh)).map((name) => remove(join(folder, name))))
    else if (!found.includes(IMPORTING)) continue
    else if (found.some((name) => name.endsWith('.mask'))) await Promise.all(found.filter((name) => MESH_TEMP.test(name)).map((name) => remove(join(folder, name))))
    else await remove(folder)
  }
}

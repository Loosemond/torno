import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { bytesFor } from '../../shared/regions'
import { maskFile } from '../../shared/scans'
import { writeFileAtomic } from '../atomic'
import { linkedFolder, ownFolders, scanFolder } from './meshfiles'

// A region's mask on the disk: `<object>/.torno/scans/<scan>/<stem>.mask`, a bit a triangle of the scan's mesh.
// The path is made here, from the object's folder, the scan's id and the stem: never given. `ScanStore` calls
// these in the object's turn, of a scan its file has.

/** Said of a mask that is not on the disk: the region it was of has no triangles. Any other failure to read one is the disk's, and says nothing of the region. */
export class MaskGone extends Error {}

/** What a mask is called, less `.mask`: a mark's number, and after it was painted again, which painting (`M7`, `M7.2`). */
const MASK_STEM = /^M[1-9]\d{0,14}(\.[1-9]\d{0,8})?$/

/** Where the mask of a region of a scan is. Throws for what is no mask's name: nothing else names a file there. */
export function maskPath(dir: string, scan: string, stem: string): string {
  if (typeof stem !== 'string' || !MASK_STEM.test(stem)) throw new RangeError(`${stem} is no mark: a region's file is named by its mark`)
  return join(scanFolder(dir, scan), `${stem}.mask`)
}

/**
 * Writes the triangles of a region of a scan as `<scan>/<stem>.mask` (`maskStem`: the mark's number, and which
 * painting of it): a bit a triangle of the mesh the scan has, which has `triangles` of them. Through a temp file,
 * so the name is of a whole file whenever it is read. Refuses bits of another length than the mesh has triangles
 * for, and a bit past its last.
 */
export async function writeMaskFile(dir: string, scan: string, stem: string, bits: Uint8Array, triangles: number): Promise<void> {
  const path = maskPath(dir, scan, stem)
  await ownFolders(dir, scan)
  const mark = stem.split('.')[0]
  if (!(bits instanceof Uint8Array) || bits.length !== bytesFor(triangles)) throw new Error(`${mark} has ${bits?.length ?? 0} bytes of triangles, and ${scan} has ${triangles} triangles: ${bytesFor(triangles)} bytes`)
  if ((triangles & 7) !== 0 && bits[bits.length - 1] >> (triangles & 7) !== 0) throw new Error(`${mark} names a triangle past the last of ${scan}, which has ${triangles}`)
  await writeFileAtomic(path, maskFile(bits, triangles))
}

/** The `.mask` of a region of a scan, as the file is. Rejects with a `MaskGone` for one that is not there, and with what the disk said for one that could not be read. */
export async function readMaskFile(dir: string, scan: string, stem: string): Promise<Buffer> {
  const path = maskPath(dir, scan, stem)
  try {
    return await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    throw new MaskGone(`${stem.split('.')[0]} has no triangles on the disk: its file is gone from ${path}`)
  }
}

/** Deletes the mask of a region: that file only. One that is not there is nothing to delete. Rejects, and deletes nothing, through a link (`linkRefusal`). */
export async function removeMaskFile(dir: string, scan: string, stem: string): Promise<void> {
  const path = maskPath(dir, scan, stem)
  const refusal = await linkRefusal(dir, scan)
  if (refusal !== null) throw new Error(refusal)
  await rm(path, { force: true })
}

/**
 * Why nothing is deleted under an object's scans folder, or in the folder of one scan: `.torno`, `.torno/scans`
 * or that scan's folder is a link, and what is behind it is not torno's to delete. Null when none is. Writes are
 * refused for the same (`ownFolders`).
 */
export async function linkRefusal(dir: string, scan?: string): Promise<string | null> {
  const folder = await linkedFolder(dir, scan)
  return folder === null ? null : `${folder} is a link: torno deletes nothing through it`
}

/** The masks there are in a scan's folder, each by its stem: for whoever clears away those no mark names. */
export async function maskStems(dir: string, scan: string): Promise<string[]> {
  const names = await readdir(scanFolder(dir, scan)).catch(() => [] as string[])
  return names.filter((name) => name.endsWith('.mask') && MASK_STEM.test(name.slice(0, -5))).map((name) => name.slice(0, -5))
}

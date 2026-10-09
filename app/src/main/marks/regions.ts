import type { Mark, NewMark, NewRegion } from '../../shared/marks'
import { bitsRefused, popcount, regionStats } from '../../shared/regions'
import { type ScanInfo, maskBits, parseScanMesh } from '../../shared/scans'
import type { ScanStore } from '../scans/store'
import type { MarkStore } from './store'

// Regions of scans, kept: a region is a mark whose triangles are a mask beside its scan's mesh. What the window
// painted comes here as bits; everything said of the region is worked out here from the mesh, and the mask is
// written here, by the scan's and the mark's numbers alone. A region goes with its scan: without it, or on
// another mesh than it was painted on, it is orphaned and says so.

export interface RegionDeps {
  marks: Pick<MarkStore, 'add' | 'list' | 'remove' | 'orphanRegions' | 'restateRegions'>
  scans: Pick<ScanStore, 'list' | 'mesh' | 'mask' | 'writeMask' | 'removeMask' | 'problem'>
}

/** The bytes the window sent as a region's bits, whatever view of them crossed; null for anything else. */
function bytesOf(given: unknown): Uint8Array | null {
  if (given instanceof Uint8Array) return given
  if (ArrayBuffer.isView(given)) return new Uint8Array(given.buffer, given.byteOffset, given.byteLength)
  if (given instanceof ArrayBuffer) return new Uint8Array(given)
  return null
}

/** What says a scan's mesh is the one it was: when it was read, and into which file. */
const meshIs = (scan: ScanInfo): string => `${scan.imported.at}|${scan.imported.mesh ?? ''}|${scan.imported.triangles}`

/**
 * Keeps what the person painted on a scan as a region: a draft of theirs, like any mark made in the window.
 * The scan must be there with its mesh; the bits must be one a triangle of that mesh, none set past its last,
 * and one set at least. Its count, its area and where it is are worked out from the mesh (`regionStats`), and
 * the mask is written once the mark has its number and before the mark is. Rejects with a plain sentence, and
 * then nothing is kept: no mark, no mask.
 */
export async function addRegion(deps: RegionDeps, objectId: string, given: NewRegion): Promise<Mark> {
  const asked = Object(given) as Partial<NewRegion>
  const bits = bytesOf(asked.bits)
  if (!bits) throw new Error('a region is given as the bits of its triangles')
  const find = async (): Promise<ScanInfo> => {
    const scans = await deps.scans.list(objectId)
    const scan = scans.find((one) => one.id === asked.scan)
    if (!scan) throw new Error(`no scan ${String(asked.scan)}; scans: ${scans.map((one) => one.id).join(', ') || 'none'}`)
    return scan
  }
  const scan = await find()
  const refused = bitsRefused(bits, scan.imported.triangles)
  if (refused !== null) throw new Error(refused)
  if (popcount(bits) === 0) throw new Error('a region needs at least one triangle: paint some of the scan first')
  let blob: Buffer
  try {
    blob = await deps.scans.mesh(objectId, scan.id)
  } catch (e) {
    const gone = /^(.*'s mesh is gone from \S+)\./.exec(e instanceof Error ? e.message : '')
    throw gone ? new Error(`${gone[1]}: import it again before painting on it`) : e
  }
  const stats = regionStats(parseScanMesh(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer), bits)
  if (!stats) throw new Error('a region needs at least one triangle: paint some of the scan first')
  const mark = { kind: 'region', author: 'user', scan: scan.id, note: asked.note, layout: asked.layout, revision: asked.revision, camera: asked.camera } as NewMark
  let written: string | null = null
  try {
    return await deps.marks.add(objectId, mark, 'draft', undefined, {
      stats,
      before: async (id) => {
        // The mesh the numbers are of is still the scan's: it was not read again or removed while they were worked out.
        if (meshIs(await find()) !== meshIs(scan)) throw new Error(`${scan.id} was imported again while the region was being kept: paint it again`)
        await deps.scans.writeMask(objectId, scan.id, id, bits)
        written = id
      }
    })
  } catch (e) {
    if (written !== null) await deps.scans.removeMask(objectId, scan.id, written).catch(() => {})
    throw e
  }
}

/** Removes a mark, and with a region the mask that held its triangles. */
export async function removeMark(deps: RegionDeps, objectId: string, id: string): Promise<void> {
  const mark = (await deps.marks.list(objectId)).find((one) => one.id === id)
  await deps.marks.remove(objectId, id)
  if (mark?.kind === 'region') await deps.scans.removeMask(objectId, mark.scan, mark.id).catch((e) => console.error(`cannot delete the triangles of ${mark.id}: ${e instanceof Error ? e.message : String(e)}`))
}

/**
 * Orphans the regions that have nothing under them: those whose scan is not among the object's scans, and those
 * whose mask is gone or is of another triangle count than the scan's mesh now has. For what was done outside
 * torno, or left half done: a removal or a re-import in the window orphans its regions itself. Does nothing
 * while the object's scans file was set aside: the scans are then not known, and may be recovered.
 */
export async function orphanLost(deps: RegionDeps, objectId: string): Promise<void> {
  const regions = (await deps.marks.list(objectId)).filter((mark) => mark.kind === 'region' && mark.anchorState !== 'orphaned')
  if (regions.length === 0 || (await deps.scans.problem(objectId)) !== null) return
  const scans = await deps.scans.list(objectId)
  const lost = new Map<string, string[]>()
  for (const region of regions) {
    if (region.kind !== 'region') continue
    const scan = scans.find((one) => one.id === region.scan)
    let fits = false
    if (scan) {
      try {
        maskBits(await deps.scans.mask(objectId, scan.id, region.id), scan.imported.triangles)
        fits = true
      } catch {
        // Gone, or of another mesh: either way it says nothing of this one.
      }
    }
    if (!fits) lost.set(region.scan, [...(lost.get(region.scan) ?? []), region.id])
  }
  for (const [scan, ids] of lost) await deps.marks.orphanRegions(objectId, scan, ids)
}

/**
 * Works out anew what the regions of a scan are, from the mesh the scan has now and their masks: after the scan
 * was converted to another unit or up axis, which leaves its triangles as they were and puts them elsewhere.
 * A region whose mask is gone, or is not of that mesh, is orphaned.
 */
export async function restateRegions(deps: RegionDeps, objectId: string, scan: string): Promise<void> {
  const regions = (await deps.marks.list(objectId)).filter((mark) => mark.kind === 'region' && mark.scan === scan && mark.anchorState !== 'orphaned')
  if (regions.length === 0) return
  const info = (await deps.scans.list(objectId)).find((one) => one.id === scan)
  if (!info) return deps.marks.orphanRegions(objectId, scan)
  const blob = await deps.scans.mesh(objectId, scan)
  const mesh = parseScanMesh(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer)
  const said: Array<{ id: string; stats: NonNullable<ReturnType<typeof regionStats>> }> = []
  const lost: string[] = []
  for (const region of regions) {
    try {
      const stats = regionStats(mesh, maskBits(await deps.scans.mask(objectId, scan, region.id), mesh.triangles.length / 3))
      if (stats) said.push({ id: region.id, stats })
      else lost.push(region.id)
    } catch {
      lost.push(region.id)
    }
  }
  if (said.length > 0) await deps.marks.restateRegions(objectId, said)
  if (lost.length > 0) await deps.marks.orphanRegions(objectId, scan, lost)
}

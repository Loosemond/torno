import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mark, NewRegion, RegionMark } from '../../shared/marks'
import { popcount } from '../../shared/regions'
import { grid, meshBin, stl } from '../../test/scanFixtures'
import type { ImportReply, Importer } from '../scans/importer'
import { ScanStore } from '../scans/store'
import { MarkStore } from './store'
import { UNIT_MM } from '../../shared/scans'
import { addRegion, orphanLost, removeMark, restateRegions } from './regions'

// A region is kept by main from what the window painted: against the real stores, in a folder of the test's own.

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
// A sheet of 5 × 5 vertices 10 mm apart: 32 triangles of 50 mm² each.
let sheet = grid(5, 10)
const reply = (): ImportReply => ({ unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: sheet.vertices.length / 3, triangles: sheet.triangles.length / 3, colours: 'none', bbox: { min: [-20, -20, 0], max: [20, 20, 0] }, area: 1600, reduced: null, source: { bytes: 1, sha256: (sheet.triangles.length % 251).toString(16).padStart(2, '0').repeat(32) } })
const importer: Importer = {
  async import(_from, out) {
    writeFileSync(out, Buffer.from(meshBin(sheet)))
    return reply()
  },
  async convert(mesh, from, to) {
    // As the import process does: the same triangles, every coordinate in the new unit's millimetres.
    const by = UNIT_MM[to.unit] / UNIT_MM[from.unit]
    writeFileSync(mesh, Buffer.from(meshBin({ vertices: sheet.vertices.map((c) => c * by), triangles: sheet.triangles })))
    return { ...reply(), unit: to.unit, up: to.up, bbox: { min: [-20 * by, -20 * by, 0], max: [20 * by, 20 * by, 0] }, area: 1600 * by * by, source: undefined }
  },
  stop() {}
}
const bits = (triangles: number[], length = 4): Uint8Array => {
  const made = new Uint8Array(length)
  for (const t of triangles) made[t >> 3] |= 1 << (t & 7)
  return made
}

let root: string
let dir: string
let source: string
let marks: MarkStore
let scans: ScanStore
let told: Mark[][]
const deps = () => ({ marks, scans })
const region = (over: Partial<NewRegion> = {}): NewRegion => ({ scan: 'S1', note: '', layout: 'assembly', revision: 3, camera: CAMERA as never, bits: bits([0, 1]), ...over })
const maskOf = (mark: string, scan = 'S1'): string => join(dir, '.torno', 'scans', scan, `${mark}.mask`)

beforeEach(async () => {
  sheet = grid(5, 10)
  root = mkdtempSync(join(tmpdir(), 'torno-regions-'))
  dir = join(root, 'bracket')
  mkdirSync(dir)
  source = join(root, 'sheet.stl')
  writeFileSync(source, stl(sheet))
  marks = new MarkStore({ dirOf: (id) => (id === 'bracket' ? dir : undefined) })
  scans = new ScanStore({ dirOf: (id) => (id === 'bracket' ? dir : undefined), importer: () => importer })
  told = []
  marks.on('changed', (m) => told.push(m.marks))
  await scans.import('bracket', source)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('addRegion', () => {
  it('keeps what was painted as a draft of the person\'s, with what main works out of the mesh, and its triangles beside the mesh', async () => {
    const kept = (await addRegion(deps(), 'bracket', { ...region(), triangles: 999, area: 1, author: 'agent', local: { centroid: [9, 9, 9] } } as never)) as RegionMark
    expect(kept).toMatchObject({ id: 'M1', kind: 'region', scan: 'S1', author: 'user', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 3, triangles: 2 })
    expect(kept.area).toBeCloseTo(100, 9)
    expect(kept.local.bbox).toEqual({ min: [-20, -20, 0], max: [-10, -10, 0] })
    const mask = readFileSync(maskOf('M1'))
    expect(mask.length).toBe(16 + 4)
    expect([...mask.subarray(16)]).toEqual([0b11, 0, 0, 0])
    const file = readFileSync(join(dir, '.torno', 'marks.json'), 'utf8')
    expect(file).not.toContain('bits')
    expect(JSON.parse(file).marks[0]).toEqual(kept)
    // The bits cross from the window as the bytes they are, whatever view they came in.
    const again = await addRegion(deps(), 'bracket', region({ bits: bits([3]).buffer as never }))
    expect(again).toMatchObject({ id: 'M2', triangles: 1 })
    const plain = await addRegion(deps(), 'bracket', region({ bits: new DataView(bits([4, 5, 6]).buffer) as never }))
    expect(plain).toMatchObject({ id: 'M3', triangles: 3 })
  })

  it('keeps nothing of no triangle, of bits that are not of that mesh, or of a scan that is not there', async () => {
    const refused = async (over: object): Promise<string> => addRegion(deps(), 'bracket', { ...region(), ...over } as never).then(() => 'kept', (e: Error) => e.message)
    expect(await refused({ bits: bits([]) })).toBe('a region needs at least one triangle: paint some of the scan first')
    expect(await refused({ bits: bits([0], 5) })).toBe('5 bytes of triangles do not fit a mesh of 32 triangles: 4 bytes')
    expect(await refused({ bits: [3, 0, 0, 0] })).toBe('a region is given as the bits of its triangles')
    expect(await refused({ bits: undefined })).toBe('a region is given as the bits of its triangles')
    expect(await refused({ scan: 'S9' })).toBe('no scan S9; scans: S1')
    expect(await refused({ scan: '../S1' })).toBe('no scan ../S1; scans: S1')
    expect(await refused({ layout: 7 })).toBe('that is not a mark: its kind is unknown, or a field is missing or not a finite number')
    rmSync(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect(await refused({})).toMatch(/^S1's mesh is gone from .*: import it again before painting on it$/)
    expect(await marks.list('bracket')).toEqual([])
    expect(told).toEqual([])
    expect(existsSync(maskOf('M1'))).toBe(false)
    // The number a refused region would have had is the next mark's.
    writeFileSync(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'), Buffer.from(meshBin(sheet)))
    expect((await addRegion(deps(), 'bracket', region())).id).toBe('M1')
  })

  it('refuses a bit past the last triangle of a mesh whose count is no multiple of eight', async () => {
    sheet = { vertices: sheet.vertices, triangles: sheet.triangles.slice(0, 30 * 3) }
    await scans.import('bracket', source)
    await expect(addRegion(deps(), 'bracket', region({ scan: 'S2', bits: bits([30]) }))).rejects.toThrow('the region names a triangle past the last of the mesh (30 triangles)')
    expect((await addRegion(deps(), 'bracket', region({ scan: 'S2', bits: bits([29]) }))) as RegionMark).toMatchObject({ scan: 'S2', triangles: 1 })
  })

  it('leaves no mask behind when the mark could not be written', async () => {
    writeFileSync(join(dir, '.torno', 'marks.json'), JSON.stringify({ next: 1, marks: [] }))
    // The marks file's folder entry is in the way of its temp file: the write fails.
    mkdirSync(join(dir, '.torno', `marks.json.${process.pid}.tmp`))
    await expect(addRegion(deps(), 'bracket', region())).rejects.toThrow()
    expect(existsSync(maskOf('M1'))).toBe(false)
  })
})

describe('the life of a region with its scan and its mark', () => {
  it('removes the mask with the mark, and of no other', async () => {
    await addRegion(deps(), 'bracket', region())
    await addRegion(deps(), 'bracket', region({ bits: bits([7]) }))
    await removeMark(deps(), 'bracket', 'M1')
    expect([existsSync(maskOf('M1')), existsSync(maskOf('M2'))]).toEqual([false, true])
    expect((await marks.list('bracket')).map((m) => m.id)).toEqual(['M2'])
    await expect(removeMark(deps(), 'bracket', 'M1')).rejects.toThrow('no mark M1; marks: M2')
  })

  it('orphans the regions of a scan that is gone, and those whose mask is no longer of the mesh, and leaves the others', async () => {
    await scans.import('bracket', source) // S2
    await addRegion(deps(), 'bracket', region()) // M1 on S1
    await addRegion(deps(), 'bracket', region({ scan: 'S2' })) // M2 on S2
    await addRegion(deps(), 'bracket', region({ scan: 'S2', bits: bits([9]) })) // M3 on S2
    await orphanLost(deps(), 'bracket')
    expect((await marks.list('bracket')).map((m) => m.anchorState)).toEqual(['ok', 'ok', 'ok'])
    await scans.remove('bracket', 'S1')
    // Its mask is another mesh's: written for 16 triangles.
    const stale = readFileSync(maskOf('M3', 'S2'))
    stale.writeUInt32LE(16, 12)
    writeFileSync(maskOf('M3', 'S2'), stale.subarray(0, 18))
    await orphanLost(deps(), 'bracket')
    expect((await marks.list('bracket')).map((m) => m.anchorState)).toEqual(['orphaned', 'ok', 'orphaned'])
    // One whose mask is gone has no triangles to be of.
    rmSync(maskOf('M2', 'S2'))
    await orphanLost(deps(), 'bracket')
    expect((await marks.list('bracket')).map((m) => m.anchorState)).toEqual(['orphaned', 'orphaned', 'orphaned'])
  })

  it('orphans nothing while the scans file was set aside: what is in the folders may be all there is of them', async () => {
    await addRegion(deps(), 'bracket', region())
    writeFileSync(join(dir, '.torno', 'scans.json'), 'not json')
    scans.forget()
    marks.forget()
    await orphanLost(deps(), 'bracket')
    expect((await marks.list('bracket'))[0].anchorState).toBe('ok')
  })

  it('says a region anew from the mesh its scan has once that was converted: the same triangles, elsewhere', async () => {
    const kept = (await addRegion(deps(), 'bracket', region({ note: 'loom' }))) as RegionMark
    await marks.markSent('bracket')
    await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    await restateRegions(deps(), 'bracket', 'S1')
    const [now] = (await marks.list('bracket')) as RegionMark[]
    expect(now).toMatchObject({ id: 'M1', note: 'loom', status: 'sent', anchorState: 'ok', triangles: 2 })
    expect(now.area).toBeCloseTo(kept.area * 100, 6)
    expect(now.local.bbox).toEqual({ min: [-200, -200, 0], max: [-100, -100, 0] })
    expect(now.local.centroid.map((c) => Math.round(c))).toEqual([-150, -150, 0])
    // Said again of the same mesh: nothing is written.
    told = []
    await restateRegions(deps(), 'bracket', 'S1')
    expect(told).toEqual([])
    // One whose mask is not of the mesh the scan has is orphaned, not said of another's triangles.
    writeFileSync(maskOf('M1'), Buffer.alloc(18))
    await restateRegions(deps(), 'bracket', 'S1')
    expect((await marks.list('bracket'))[0].anchorState).toBe('orphaned')
  })

  it('counts what it keeps', () => {
    expect(popcount(bits([0, 1, 31]))).toBe(3)
  })
})

import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RegionMark } from '../../shared/marks'
import { popcount } from '../../shared/regions'
import { type ScanAlignment, maskFile, parseScanMesh } from '../../shared/scans'
import type { Scene } from '../../shared/scene'
import { TriangleSet, gatherSphere } from '../../renderer/viewport/scanPaint'
import { grid, meshBin, stl } from '../../test/scanFixtures'
import { type HttpRouter, SESSION_HEADER, startHttp } from '../http'
import { type RunningKernel, startKernel } from '../kernel/client'
import { addRegion, meshesOf, repaintRegion } from '../marks/regions'
import { MarkStore } from '../marks/store'
import type { ImportReply, Importer } from '../scans/importer'
import { ScanStore } from '../scans/store'
import { mountMcp } from './server'
import type { ToolDeps } from './tools'

// A region from the brush to the kernel: painted on a scan's mesh with the window's own brush, kept by main's
// own stores (the mark in marks.json, its triangles in a mask beside the mesh), and used by the agent's tools
// through the real MCP server, whose questions go to the real kernel.

const KERNEL_DIR = resolve(__dirname, '../../../../kernel')
/** A sheet in the tub's floor, which is 2 mm thick from z = 0: 400 vertices 1 mm apart, each 1 mm deep. */
const SHEET = grid(20, 1, () => 1)
const CAMERA = { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }
const TYPED: ScanAlignment = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { tub: [0, 0, 0], lid: [0, 0, 0] }, at: '2026-10-09T12:00:00.000Z' }

let root: string
let dir: string
let kernel: RunningKernel
let http: HttpRouter
let client: Client
let scene: Scene
let marks: MarkStore
let scans: ScanStore
let region: RegionMark
let painted: TriangleSet

type Content = Array<{ type: string; text?: string }>
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any }> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Content).find((block) => block.type === 'text')?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // An error is said in words.
  }
  return { isError: result.isError === true, text, data }
}

/** The brush, as the window sets it down: on the scan's mesh as main keeps it, through a bounds tree over it. */
async function brush(at: [number, number, number], radius: number): Promise<TriangleSet> {
  const blob = await scans.mesh('hollow', 'S1')
  const mesh = parseScanMesh(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1))
  const set = new TriangleSet(mesh.triangles.length / 3)
  gatherSphere(new MeshBVH(geometry, { indirect: true }), geometry, new THREE.Vector3(...at), radius, new THREE.Vector3(0, 0, 1), (t) => set.add(t))
  return set
}

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-regions-'))
  cpSync(join(KERNEL_DIR, 'tests/fixtures/ws'), root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  dir = join(root, 'hollow')
  const source = join(root, 'sheet.stl')
  writeFileSync(source, stl(SHEET))
  // The import process is not what is tried here: the mesh is written as it would write it.
  const reply: ImportReply = { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 400, triangles: 722, colours: 'none', bbox: { min: [-9.5, -9.5, 1], max: [9.5, 9.5, 1] }, area: 361, reduced: null, source: { bytes: 1, sha256: 'ab'.repeat(32) } }
  const importer: Importer = {
    async import(_from, out) {
      writeFileSync(out, Buffer.from(meshBin(SHEET)))
      return reply
    },
    convert: async () => reply,
    stop() {}
  }
  const dirOf = (id: string): string | undefined => (id === 'hollow' ? dir : undefined)
  scans = new ScanStore({ dirOf, importer: () => importer })
  marks = new MarkStore({ dirOf, meshes: meshesOf(scans) })
  await scans.import('hollow', source)
  await scans.align('hollow', 'S1', 'assembly', TYPED)
  await scans.checked('hollow', 'S1', 'assembly', { revision: 1, of: 0, off: 0, worst: 0, moved: [] })

  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  const built = await kernel.build(dir, 'hollow.py')
  if (!built.ok) throw new Error(`${built.error.kind}: ${built.error.message}`)
  scene = built.scene
  const never = (): never => {
    throw new Error('not expected')
  }
  const deps: ToolDeps = {
    object: (id) => (id === 'hollow' ? { id, name: id, dir, model: 'hollow.py' } : undefined),
    build: () => ({ objectId: 'hollow', status: 'ok', revision: 1, seconds: 1, stale: false }),
    scene: () => ({ revision: 1, scene }),
    view: () => undefined,
    openObjectId: () => null,
    look: never,
    saveImage: never,
    marks: (objectId) => marks.list(objectId),
    addMark: never,
    addDimension: never,
    updateMark: (objectId, id, patch) => marks.update(objectId, id, patch, 'agent'),
    describe: (_objectId, layout, ref) => kernel.query(dir, 'describe', { ref: `${layout}:${ref}` }),
    nearest: never,
    show: never,
    highlight: never,
    query: (_objectId, name, args) => kernel.query(dir, name, args),
    sectionDrawing: async () => Promise.reject(new Error('no window in this test')),
    scans: (objectId) => scans.list(objectId),
    scansBusy: (objectId) => scans.working(objectId),
    scanPaths: (objectId, id) => scans.paths(objectId, id),
    views: async () => [],
    saveView: async () => Promise.reject(new Error('no view was expected to be saved'))
  }
  http = await startHttp()
  mountMcp(http, deps)
  client = new Client({ name: 'torno-test', version: '0' })
  // With a token for the object, as the session of an agent working on it has.
  const headers = { [SESSION_HEADER]: http.grant(['/mcp/hollow']) }
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url('/mcp/hollow')), { requestInit: { headers } }))

  // One dab of a 3 mm brush on the sheet, off its middle, kept as the window would have it kept.
  painted = await brush([-5, -5, 1], 3)
  region = (await addRegion({ marks, scans }, 'hollow', { scan: 'S1', note: 'cable, can be pushed aside', layout: 'assembly', revision: 1, camera: CAMERA as never, bits: painted.bits })) as RegionMark
})

afterAll(async () => {
  await client?.close()
  http?.close()
  await kernel?.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('a painted region, through the MCP server and the real kernel', () => {
  it('is kept with what main works out of the mesh, and told to the agent where the scan stands', async () => {
    expect(painted.count).toBeGreaterThan(30)
    expect(region).toMatchObject({ id: 'M1', kind: 'region', scan: 'S1', status: 'draft', author: 'user', triangles: painted.count })
    // Half a square millimetre a triangle, about a disc of 3 mm.
    expect(region.area).toBeCloseTo(painted.count / 2, 6)
    expect(Math.abs(region.area - Math.PI * 9)).toBeLessThan(4)
    const { data } = await call('marks')
    expect(data.marks).toHaveLength(1)
    expect(data.marks[0]).toMatchObject({ id: 'M1', kind: 'region', scan: 'S1', triangles: painted.count, flat: true, plane: { rms: 0 } })
    expect(data.marks[0].local).toBeUndefined()
    expect(data.marks[0].centroid.map((c: number) => Math.round(c * 10) / 10)).toEqual([-5, -5, 1])
    expect(data.marks[0].line).toMatch(new RegExp(`^M1 region on scan S1: ${painted.count} triangles, ≈ [\\d.]+ mm², centre ≈ \\(-5, -5, 1\\), ≈ [\\d.]+ × [\\d.]+ × 0 mm(, its long side along \\([^)]*\\))?, within a box of ≈ 7 × 7 × 0 mm, flat about a plane with normal ≈ \\(0, 0, 1\\): "cable, can be pushed aside"$`))
    expect(data.marks[0]).toMatchObject({ toldIn: 'assembly', aligned: true, bbox: { min: [-8.5, -8.5, 1], max: [-1.5, -1.5, 1] } })
    for (const key of ['local', 'mesh', 'mask']) expect(data.marks[0]).not.toHaveProperty(key)
    expect(region.mesh).toBe(`${'ab'.repeat(32)}|400|722|mm|z`)
    const scansSaid = await call('scans')
    expect(scansSaid.data.scans[0].regions).toEqual(['M1 "cable, can be pushed aside"'])
    expect(scansSaid.data.reading).toContain('1 region')
  })

  it('is left out of a clash when the agent says so, and of nothing when it does not', async () => {
    const all = await call('scan_clash', { part: 'tub' })
    expect(all.data).toMatchObject({ points: { scan: 400, ignored: 0 }, inside: { count: 400 }, ignore: [] })
    const without = await call('scan_clash', { part: 'tub', ignore: ['M1'] })
    expect(without.isError).toBe(false)
    expect(without.data.ignore).toEqual(['M1'])
    // The points every triangle round which is painted: those inside its rim, which its neighbours share and so still count.
    expect(without.data.points.ignored).toBeGreaterThan(10)
    expect(without.data.points.ignored).toBeLessThan(painted.count)
    expect(without.data.inside.count).toBe(400 - without.data.points.ignored)
    expect(without.data.reading).toMatch(new RegExp(`≈ ${400 - without.data.points.ignored} scan points inside the part in 1 cluster, .*, ${without.data.points.ignored} points of M1 left out\\. `))
    expect(without.data.exact).toBe(false)
  })

  it('bounds a deviation to the scan points of the region', async () => {
    const without = await call('scan_clash', { part: 'tub', ignore: ['M1'] })
    const whole = await call('scan_deviation', { part: 'lid', from: 'scan', within: 100 })
    const only = await call('scan_deviation', { part: 'lid', from: 'scan', within: 100, region: 'M1' })
    expect(whole.data).toMatchObject({ samples: 400, region: null })
    expect(only.data).toMatchObject({ region: 'M1', exact: false })
    // Asked of the region alone, the points on its rim are its own too.
    expect(only.data.samples).toBeGreaterThan(without.data.points.ignored)
    expect(only.data.samples).toBeLessThan(painted.count + 20)
    expect(only.data.reading).toMatch(/^scan_deviation lid vs S1 region M1 \(assembly, r1\): /)
    // Every point told is one of the region's: within the brush of where it was set down.
    const [x, y] = only.data.worst.at
    expect(Math.hypot(x + 5, y + 5)).toBeLessThan(4.5)
  })

  it('stands for its middle as an end of a measurement, approximately', async () => {
    const measured = await call('measure', { kind: 'distance', a: 'M1', b: 'lid' })
    expect(measured.isError).toBe(false)
    // The sheet is at z = 1, the lid's underside at 38.
    expect(measured.data.value).toBeCloseTo(37, 6)
    expect(measured.data).toMatchObject({ exact: false, scan: 'S1' })
    expect(measured.data.reading).toMatch(/^S1 was placed by hand: no fit says how well\. ≈ 37 mm .*the centroid of region M1 \(S1\) at \(-5, -5, 1\) to lid\./)
  })

  it('is no end of a dimension, and neither is a point of a scan: a dimension is of the model', async () => {
    const said = 'a dimension is checked on every build against the model: an end on a scan cannot be one'
    const ofRegion = await call('add_mark', { kind: 'dimension', measure: 'distance', a: 'M1', b: { point: [0, 0, 10] }, expected: 10, note: 'clearance' })
    expect(ofRegion.isError).toBe(true)
    expect(ofRegion.text).toContain(said)
    expect(ofRegion.text).toContain('a is the centroid of region M1 (S1)')
    expect(ofRegion.text).toContain('use measure')
    const ofPoint = await call('add_mark', { kind: 'dimension', measure: 'distance', a: 'tub/F0', b: { scan: 'S1', point: [0, 0, 1] }, note: 'clearance' })
    expect(ofPoint.isError).toBe(true)
    expect(ofPoint.text).toContain(said)
    expect(ofPoint.text).toContain('b is a point of S1')
    expect((await call('marks')).data.marks).toHaveLength(1)
  })

  it('is what its mask now says: painted again, the same number leaves out other points', async () => {
    const before = (await call('scan_clash', { part: 'tub', ignore: ['M1'] })).data.points.ignored
    const larger = await brush([-5, -5, 1], 6)
    expect(larger.count).toBeGreaterThan(painted.count * 3)
    // As "Edit" and "Keep" do: a new file, then the mark, then the old file goes.
    const again = (await repaintRegion({ marks, scans }, 'hollow', 'M1', larger.bits)) as RegionMark
    expect(again).toMatchObject({ id: 'M1', triangles: larger.count, mask: 1 })
    const after = (await call('scan_clash', { part: 'tub', ignore: ['M1'] })).data
    expect(after.points.ignored).toBeGreaterThan(before * 2)
    expect(after.inside.count).toBe(400 - after.points.ignored)
    expect((await call('marks')).data.marks[0]).toMatchObject({ triangles: larger.count, status: 'draft' })
    await repaintRegion({ marks, scans }, 'hollow', 'M1', painted.bits)
    expect((await call('scan_clash', { part: 'tub', ignore: ['M1'] })).data.points.ignored).toBe(before)
  })

  it('is refused in the kernel’s words when its mask is of another mesh, and in main’s once it is orphaned', async () => {
    const path = scans.paths('hollow', 'S1')!.mask('M1.2')
    const kept = maskFile(painted.bits, 722)
    writeFileSync(path, maskFile(new Uint8Array(Math.ceil(700 / 8)), 700))
    const other = await call('scan_clash', { part: 'tub', ignore: ['M1'] })
    expect(other.isError).toBe(true)
    expect(other.text).toMatch(/700/)
    expect(other.text).toMatch(/722/)
    writeFileSync(path, kept)
    expect(popcount(kept.subarray(16))).toBe(painted.count)
    await marks.orphanRegions('hollow', 'S1')
    const gone = 'M1 no longer fits the mesh of S1 (the scan was imported again from a changed source since it was painted): the user paints it again'
    expect((await call('scan_clash', { part: 'tub', ignore: ['M1'] })).text).toBe(gone)
    expect((await call('scan_deviation', { part: 'lid', region: 'M1' })).text).toBe(gone)
    expect((await call('measure', { kind: 'distance', a: 'M1', b: 'lid' })).text).toContain(gone)
    expect((await call('marks')).data.marks[0].line).toBe('M1 region on scan S1 [the mesh of its scan is no longer the one it was painted on: the user paints it again]: "cable, can be pushed aside"')
    expect((await call('scans')).data.scans[0].regions).toEqual(['M1 "cable, can be pushed aside" (no longer fits the mesh: not usable)'])
  })
})

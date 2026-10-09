import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../../shared/align'
import type { Scene } from '../../shared/scene'
import type { ScanAlignment, ScanInfo } from '../../shared/scans'
import { grid, meshBin } from '../../test/scanFixtures'
import { type HttpRouter, startHttp } from '../http'
import { type RunningKernel, startKernel } from '../kernel/client'
import { mountMcp } from './server'
import type { ToolDeps } from './tools'

// The agent's tools for scans as an agent's CLI meets them: the SDK's client over HTTP against the real MCP
// server, whose questions go to the real kernel, of a scan that is a file on the disk. What torno knows of the
// scan (its record, where it is aligned) is given here, as main's store would give it.

const KERNEL_DIR = resolve(__dirname, '../../../../kernel')
let root: string
let dir: string
let kernel: RunningKernel
let http: HttpRouter
let client: Client
let scene: Scene
let scans: ScanInfo[]

const TYPED: ScanAlignment = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { tub: [0, 0, 0], lid: [0, 0, 0] }, at: '2026-10-09T12:00:00.000Z' }
/** A sheet in the tub's floor, which is 2 mm thick from z = 0: 400 vertices 1 mm apart, each 1 mm deep. */
const SHEET = grid(20, 1, () => 1)
const record = (alignments: Record<string, ScanAlignment>, more: Partial<ScanInfo> = {}): ScanInfo =>
  ({ id: 'S1', name: 'sheet.stl', source: { path: '/nowhere/sheet.stl', bytes: 1, mtimeMs: 1, sha256: '' }, imported: { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 400, triangles: 722, colours: 'none', bbox: { min: [-9.5, -9.5, 1], max: [9.5, 9.5, 1] }, area: 361, at: '' }, alignments, sourceState: 'missing', meshState: 'ok', checks: Object.fromEntries(Object.keys(alignments).map((layout) => [layout, { revision: 1, of: 0, off: 0, worst: 0, moved: [] }])), ...more }) as ScanInfo

type Content = Array<{ type: string; text?: string }>
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any; image: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Content
  const text = content.find((block) => block.type === 'text')?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // An error is said in words.
  }
  return { isError: result.isError === true, text, data, image: content.some((block) => block.type === 'image') }
}

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-scantools-'))
  cpSync(join(KERNEL_DIR, 'tests/fixtures/ws'), root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  dir = join(root, 'hollow')
  mkdirSync(join(dir, '.torno', 'scans', 'S1'), { recursive: true })
  writeFileSync(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'), Buffer.from(meshBin(SHEET)))
  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  const built = await kernel.build(dir, 'hollow.py')
  if (!built.ok) throw new Error(`${built.error.kind}: ${built.error.message}`)
  scene = built.scene
  scans = [record({ assembly: TYPED })]
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
    saveImage: async () => join(dir, '.torno', 'views', '1.png'),
    marks: async () => [],
    addMark: never,
    addDimension: never,
    updateMark: never,
    describe: (_objectId, layout, ref) => kernel.query(dir, 'describe', { ref: `${layout}:${ref}` }),
    nearest: never,
    show: never,
    highlight: never,
    query: (_objectId, name, args) => kernel.query(dir, name, args),
    // The window is not here: a section is answered with its outlines, and says why there is no drawing.
    sectionDrawing: async () => Promise.reject(new Error('no window in this test')),
    scans: async () => scans,
    scansBusy: () => [],
    scanPaths: (_objectId, id) => ({ mesh: join(dir, '.torno', 'scans', id, 'mesh.bin'), mask: (mark) => join(dir, '.torno', 'scans', id, `${mark}.mask`) })
  }
  http = await startHttp()
  mountMcp(http, deps)
  client = new Client({ name: 'torno-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url('/mcp/hollow'))))
})

afterAll(async () => {
  await client?.close()
  http?.close()
  await kernel?.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('the scan tools, through the MCP server and the real kernel', () => {
  it('scans lists the scan with how it is aligned, and that nothing of it is exact', async () => {
    const { data } = await call('scans')
    expect(data).toMatchObject({ layout: 'assembly', revision: 1, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(data.scans).toMatchObject([{ id: 'S1', triangles: 722, mesh: 'ok', source: { state: 'missing' }, alignment: { state: 'aligned', by: 'by hand (typed values)' }, size: [19, 19, 0], bbox: { min: [-9.5, -9.5, 1], max: [9.5, 9.5, 1] } }])
    expect(data.reading).toBe('S1 sheet.stl: 722 triangles, 19 × 19 × 0 mm, from mm, Z up (assumed), aligned in assembly by hand (typed values) (tied to no point of the model: not checked against builds), its source is missing.')
  })

  it('scan_clash counts the scan points inside a part, with the deepest taken on the B-rep, and is clear of another', async () => {
    const tub = await call('scan_clash', { part: 'tub' })
    expect(tub.isError).toBe(false)
    expect(tub.data).toMatchObject({ layout: 'assembly', revision: 1, scan: 'S1', part: 'tub', exact: false, alignment: { state: 'aligned' }, points: { scan: 400, candidates: 400, checked: 400, ignored: 0, touching: 0 }, inside: { count: 400, crossing: 0, crossingAtLeast: false, clustersOmitted: 0 } })
    expect(tub.data.inside.clusters).toHaveLength(1)
    expect(tub.data.deepest.depth).toBeCloseTo(1, 6)
    expect(tub.data.deepest.under).toMatch(/^tub\/F\d+$/)
    expect(tub.data.sampling).toMatchObject({ every: 1, partial: false, retakesFailed: 0 })
    expect(tub.data.reading).toMatch(/^scan_clash tub vs S1 \(assembly, r1\): S1 was placed by hand: no fit says how well\. ≈ 400 scan points inside the part in 1 cluster, deepest 1 mm at \(-?[\d.]+, -?[\d.]+, 1\) under tub\/F\d+; no scan triangle crosses its surface\. S1 is aligned by hand \(typed values\) \(tied to no point of the model: not checked against builds\)\.$/)
    const lid = await call('scan_clash', { part: 'lid', margin: 50 })
    expect(lid.data.inside.count).toBe(0)
    // The lid's underside is at z = 38: the sheet is 37 mm under it.
    expect(lid.data.nearest.distance).toBeCloseTo(37, 6)
    expect(lid.data.reading).toMatch(/^scan_clash lid vs S1 \(assembly, r1\): S1 was placed by hand: no fit says how well\. no scan point is inside the part \(≈ 400 checked within 50 mm of it\) and no scan triangle crosses its surface; nearest 37 mm from lid\/F\d+\. S1 is aligned by hand \(typed values\) \(tied to no point of the model: not checked against builds\)\.$/)
  })

  it('scan_deviation says how far a part lies from the scan, from either side, and of some faces', async () => {
    const far = await call('scan_deviation', { part: 'lid', from: 'scan', within: 100 })
    expect(far.isError).toBe(false)
    expect(far.data).toMatchObject({ layout: 'assembly', revision: 1, scan: 'S1', part: 'lid', from: 'scan', exact: false, samples: 400, compared: 400, beyond: 0, sampling: { asked: 10000, partial: false, unsure: 0 } })
    expect(far.data.distance.min).toBeCloseTo(37, 3)
    expect(far.data.reading).toMatch(/^scan_deviation lid vs S1 \(assembly, r1\): S1 was placed by hand: no fit says how well\. ≈ 37 mm median, 37 mm mean, 37 mm at most \(95 % within 37 mm\), from 400 scan points to the part \(10,000 were asked: no more are within 100 mm of it\); none of them are inside the part; furthest at \(.*\) from lid\/F\d+\. S1 is aligned by hand \(typed values\) \(tied to no point of the model: not checked against builds\)\.$/)
    // Within 10 mm only: most of the tub is further from the sheet in its floor than that.
    const near = await call('scan_deviation', { part: 'tub', samples: 500, within: 10 })
    expect(near.data).toMatchObject({ from: 'part', samples: 500, sampling: { asked: 500 } })
    expect(near.data.beyond).toBeGreaterThan(0)
    expect(near.data.reading).toMatch(/^scan_deviation tub vs S1 \(assembly, r1\): S1 was placed by hand: no fit says how well\. ≈ [\d.]+ mm median, .* from \d+ points of the part to the scan; the scan is inside the part at \d+ of them; \d+ more had no scan within 10 mm; furthest at /)
    // The lid's underside alone: the kernel is asked by the face's number, which describe gives.
    const faces = scene.parts.find((p) => p.key === 'assembly:lid')!.faceCount
    let under = -1
    for (let face = 0; face < faces && under < 0; face++) {
      const said = await kernel.query<{ center: number[]; normal: number[] | null }>(dir, 'describe', { ref: `assembly:lid/F${face}` })
      if (said.normal && said.normal[2] < -0.9) under = face
    }
    const face = await call('scan_deviation', { part: 'lid', faces: [`lid/F${under}`], within: 100, samples: 200 })
    expect(face.data).toMatchObject({ faces: [`lid/F${under}`], region: null, from: 'part', samples: 200 })
    expect(face.data.distance.min).toBeCloseTo(37, 3)
    expect(face.data.reading).toContain(`scan_deviation lid/F${under} vs S1 (assembly, r1): S1 was placed by hand: no fit says how well. ≈ `)
  })

  it('measure takes a point of the scan, and says the distance is approximate though the kernel took it exactly', async () => {
    const { data } = await call('measure', { kind: 'distance', a: { scan: 'S1', point: [0.5, 0.5, 1] }, b: 'lid' })
    expect(data).toMatchObject({ layout: 'assembly', revision: 1, kind: 'distance', exact: false, scan: 'S1', approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(data.value).toBeCloseTo(37, 6)
    expect(data.reading).toMatch(/^S1 was placed by hand: no fit says how well\. ≈ 37 mm .*, approximate \(S1 is a scan\), \(0\.5, 0\.5, 1\) given as a point of S1 to lid\. S1 is aligned by hand \(typed values\) \(tied to no point of the model: not checked against builds\)\.$/)
  })

  it('section cuts the scan by the same plane as the parts, and tells its line in the plane’s own axes', async () => {
    const { data, isError } = await call('section', { plane: { axis: 'x', at: 0.25 }, scan: 'S1' })
    expect(isError).toBe(false)
    expect(data.scan).toMatchObject({ id: 'S1', exact: false, alignment: { state: 'aligned' }, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(data.scan.polylines).toHaveLength(1)
    expect(data.scan.polylines[0].closed).toBe(false)
    // The sheet is 19 mm long across the plane, at z = 1.
    const us = data.scan.polylines[0].points.flat() as number[]
    expect(Math.max(...us.map(Math.abs))).toBeCloseTo(9.5, 6)
    expect(data.reading).toContain('≈ S1 (a scan, approximate) crosses the plane in 1 line. S1 is aligned by hand (typed values) (tied to no point of the model: not checked against builds).')
    expect(data.image).toBe('not drawn: no window in this test')
  })

  it('refuses a scan that is not aligned in the layout, and one whose mesh the kernel cannot read says so in the kernel’s words', async () => {
    scans = [record({})]
    const unaligned = await call('scan_clash', { part: 'tub' })
    expect(unaligned).toMatchObject({ isError: true, text: 'S1 is not aligned in layout assembly (it is aligned in no layout), so nothing is checked against it there: the user aligns it with the Align tool' })
    expect((await call('scan_deviation', { part: 'tub' })).text).toBe(unaligned.text)
    expect((await call('section', { plane: { axis: 'x', at: 0 }, scan: 'S1' })).text).toBe(unaligned.text)
    expect((await call('measure', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: 'lid' })).text).toBe(unaligned.text)
    // A scale the kernel will not take: its refusal reaches the agent as it is.
    scans = [record({ assembly: { ...TYPED, transform: { ...TYPED.transform, s: 1e9 } } })]
    const refused = await call('scan_clash', { part: 'tub' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe('the transform of S1 is not one: t is three numbers, q four that are not all zero, s more than zero')
    scans = [record({ assembly: TYPED })]
  })

  it('puts the scan where its alignment says: lifted 20 mm, only what of it is in the post is inside the tub', async () => {
    scans = [record({ assembly: { ...TYPED, transform: { ...TYPED.transform, t: [0, 0, 20] } } })]
    const { data } = await call('scan_clash', { part: 'tub' })
    // The post Ø6 stands 20 mm tall on the floor, to z = 22: the sheet at z = 21 goes through it.
    expect(data.inside.count).toBeGreaterThan(0)
    expect(data.inside.count).toBeLessThan(60)
    expect(data.deepest.depth).toBeLessThanOrEqual(1 + 1e-6)
    scans = [record({ assembly: TYPED })]
  })

  it('turns, scales and moves the scan as the window does: a quarter turn about X at twice the size, counted against the app\'s own arithmetic', async () => {
    // The sheet stood up in the plane y = 0, twice as large: through the floor, both walls and the post.
    const transform = { t: [0.5, 2, 18] as [number, number, number], q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number], s: 2 }
    const placed: Array<[number, number, number]> = []
    for (let n = 0; n < SHEET.vertices.length; n += 3) placed.push(apply(transform, [SHEET.vertices[n], SHEET.vertices[n + 1], SHEET.vertices[n + 2]]))
    // Where the app's own arithmetic puts it: every point in y = 0, x from -18.5 to 19.5, z from -1 to 37.
    for (const [, y] of placed) expect(y).toBeCloseTo(0, 9)
    expect([Math.min(...placed.map((p) => p[0])), Math.max(...placed.map((p) => p[0])), Math.min(...placed.map((p) => p[2])), Math.max(...placed.map((p) => p[2]))].map((c) => Math.round(c * 1e6) / 1e6)).toEqual([-18.5, 19.5, -1, 37])
    // The tub as its model makes it: a box 40 × 40 × 38 on z = 0, less a cavity 36 × 36 from z = 2, plus a post Ø6 to z = 22.
    const inTub = ([x, y, z]: [number, number, number]): boolean => {
      const inBox = Math.abs(x) < 20 && Math.abs(y) < 20 && z > 0 && z < 38
      const inCavity = Math.abs(x) < 18 && Math.abs(y) < 18 && z > 2
      const inPost = x * x + y * y < 9 && z > 2 && z < 22
      return inBox && (!inCavity || inPost)
    }
    const expected = placed.filter(inTub).length
    expect(expected).toBe(86)
    scans = [record({ assembly: { ...TYPED, transform, scaled: true } })]
    const { data, isError } = await call('scan_clash', { part: 'tub' })
    expect(isError).toBe(false)
    expect(data.inside.count).toBe(expected)
    expect(data.points).toMatchObject({ scan: 400, touching: 0 })
    expect(data.ignore).toEqual([])
    // The deepest are in the post, 0.5 mm from its axis: 2.5 mm under its side.
    expect(data.deepest.depth).toBeCloseTo(2.5, 6)
    scans = [record({ assembly: TYPED })]
  })
})

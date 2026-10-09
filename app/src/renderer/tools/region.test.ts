import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mark, NewRegion, Vec3 } from '../../shared/marks'
import { popcount } from '../../shared/regions'
import type { ScanInfo } from '../../shared/scans'
import type { Camera } from '../../shared/view'
import { alignStore } from '../state/align'
import { regionStore } from '../state/region'
import { store } from '../state/store'
import { grid } from '../../test/scanFixtures'
import type { BrushRing } from '../viewport/brushRing'
import type { TriangleSet } from '../viewport/scanPaint'
import type { ScanHit } from '../viewport/scans'
import type { ViewportPointer } from '../viewport/Viewport'
import { NOT_INDEXED, NOTHING_PAINTED, NO_SCAN, boxPlanes, clearRegion, growRegion, keepRegion, regionTool, undoStroke } from './regionTool'
import type { ToolContext } from './Tool'

// The Region tool, with a viewport that has a real tree over a sheet of 30 × 30 vertices a millimetre apart
// (1,682 triangles, from -14.5 to 14.5), seen from above.
const CAMERA: Camera = { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }
const SHEET = grid(30)
const scanInfo = (id: string, more: Partial<ScanInfo> = {}): ScanInfo =>
  ({ id, name: `${id}.stl`, source: { path: `/d/${id}.stl`, bytes: 1, mtimeMs: 1, sha256: '' }, imported: { unit: 'mm', up: 'z', assumed: { unit: false, up: false }, vertices: 900, triangles: 1682, colours: 'none', bbox: { min: [-14.5, -14.5, 0], max: [14.5, 14.5, 0] }, area: 841, at: '' }, alignments: {}, sourceState: 'present', meshState: 'ok', checks: {}, ...more }) as ScanInfo

function built() {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SHEET.vertices), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(SHEET.triangles), 1))
  const group = new THREE.Group()
  group.updateMatrix()
  return { tree: new MeshBVH(geometry, { indirect: true }), how: 'main' as const, built: { id: 'S1', group, mesh: new THREE.Mesh(geometry), own: null, plain: null as never, vertices: 900, triangles: 1682 } }
}

const onScan = (x: number, y: number, scan = 'S1'): ScanHit => ({ scan, triangle: 0, point: [x, y, 0], local: [x, y, 0], normal: [0, 0, 1], distance: 100 })
/** Where the pointer is on the sheet, or null beside it: what `pickScan` answers. */
let under: ScanHit | null = null
function pointer(type: ViewportPointer['type'], at: [number, number] | null, opts: { buttons?: number; shift?: boolean; alt?: boolean; ctrl?: boolean } = {}): ViewportPointer {
  under = at ? onScan(at[0], at[1]) : null
  const [x, y] = at ?? [99, 99]
  // Client pixels are the sheet's millimetres, y down the screen as up the sheet: enough for a box from above.
  return { type, hit: null, ray: { origin: [x, y, 100], direction: [0, 0, -1] }, client: [x, -y], buttons: opts.buttons ?? 0, shift: opts.shift ?? false, alt: opts.alt ?? false, ...(opts.ctrl ? { ctrl: true } : {}) }
}
const key = (name: string): KeyboardEvent => ({ key: name }) as KeyboardEvent

function fake(over: { tree?: boolean } = {}) {
  const made = built()
  const said: string[] = []
  const navigation: boolean[] = []
  const rings: Array<BrushRing | null> = []
  const notes: Mark[] = []
  const painted: { scan: string | null; set: TriangleSet | null; touched: number } = { scan: null, set: null, touched: 0 }
  const viewport = {
    setHover: () => {},
    setNavigation: (on: boolean) => void navigation.push(on),
    setDraft: () => {},
    lockedView: () => null,
    pick: () => null,
    pickScan: () => under,
    scanPatch: () => null,
    bounds: () => ({ min: [-20, -15, -3] as Vec3, max: [20, 15, 3] as Vec3 }),
    scanTree: (id: string) => (over.tree === false || id !== 'S1' ? null : made),
    paintScan: (scan: string | null, set: TriangleSet | null) => {
      painted.scan = scan
      painted.set = set
      return scan === null ? null : { touched: () => void (painted.touched += 1) }
    },
    showBrush: (ring: BrushRing | null) => void rings.push(ring)
  }
  const ctx = {
    viewport,
    readout: { show: () => {}, describe: () => {}, say: (_at: unknown, text: string) => void said.push(text), hide: () => {} },
    objectId: 'bracket',
    layout: 'assembly',
    revision: 4,
    camera: CAMERA,
    stale: null,
    descriptor: () => undefined,
    describe: async () => null,
    commit: async () => ({}) as Mark,
    openNote: (mark: Mark) => void notes.push(mark)
  } as unknown as ToolContext
  return { ctx, said, navigation, rings, notes, painted }
}

let asked: Array<{ objectId: string; region: NewRegion }> = []
let answer: (region: NewRegion) => Promise<Mark> = async () => ({ id: 'M1', kind: 'region', layout: 'assembly' }) as Mark

beforeEach(() => {
  asked = []
  answer = async () => ({ id: 'M1', kind: 'region', layout: 'assembly' }) as Mark
  vi.stubGlobal('window', { torno: { marks: { addRegion: (objectId: string, region: NewRegion) => (asked.push({ objectId, region }), answer(region)) } } })
  store.setState({ objectId: 'bracket', layout: 'assembly', revision: 4, scans: [scanInfo('S1')], scanViews: {} })
  alignStore.setState({ scan: null })
  clearRegion()
  regionStore.setState({ radius: 2, erase: false, mode: 'brush', refused: null, notice: null })
})
afterEach(() => {
  clearRegion()
  vi.unstubAllGlobals()
})

/** One stroke: a press and three moves along y = 0, then the release. */
function stroke(tool: ReturnType<typeof regionTool>, ctx: ToolContext, opts: { ctrl?: boolean } = {}): void {
  tool.onPointer(pointer('down', [-6, 0], { buttons: 1, ...opts }), ctx)
  for (const x of [-4, -2, 0]) tool.onPointer(pointer('move', [x, 0], { buttons: 1, ...opts }), ctx)
  tool.onPointer(pointer('up', [0, 0], opts), ctx)
}

describe('the brush', () => {
  it('adds the triangles under it with every event of a held press, tells the tint each time, and keeps the camera still meanwhile', () => {
    const { ctx, navigation, painted } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1 }), ctx)
    expect(navigation).toEqual([false])
    expect(painted.scan).toBe('S1')
    const counts = [painted.set!.count]
    const touched = [painted.touched]
    for (const x of [-4, -2, 0]) {
      tool.onPointer(pointer('move', [x, 0], { buttons: 1 }), ctx)
      counts.push(painted.set!.count)
      touched.push(painted.touched)
    }
    expect(counts.every((count, n) => n === 0 || count > counts[n - 1])).toBe(true)
    expect(touched).toEqual([1, 2, 3, 4])
    // Nothing of the stroke has reached the store.
    expect(regionStore.getState().count).toBe(0)
    tool.onPointer(pointer('up', [0, 0]), ctx)
    expect(navigation).toEqual([false, true])
    expect(regionStore.getState()).toMatchObject({ scan: 'S1', count: painted.set!.count, canUndo: true })
    // A band 4 mm high from -8 to 2: about 40 mm² of a sheet whose triangles are half a square millimetre each.
    expect(regionStore.getState().area).toBeCloseTo(painted.set!.count / 2, 6)
    expect(regionStore.getState().area).toBeGreaterThan(30)
    expect(regionStore.getState().area).toBeLessThan(50)
    // Every triangle within the brush of the path is in, none further than its radius from it.
    const index = SHEET.triangles
    for (let t = 0; t < 1682; t++) {
      const middle = [0, 1].map((axis) => (SHEET.vertices[index[t * 3] * 3 + axis] + SHEET.vertices[index[t * 3 + 1] * 3 + axis] + SHEET.vertices[index[t * 3 + 2] * 3 + axis]) / 3)
      const off = Math.hypot(Math.max(-6 - middle[0], 0, middle[0] - 0), middle[1])
      if (painted.set!.has(t)) expect(off).toBeLessThanOrEqual(2 + 1e-6)
      else if (off < 1.5) throw new Error(`triangle ${t} at ${middle} was left out`)
    }
  })

  it('takes them out again while Erase is on, or with Ctrl held', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const whole = painted.set!.count
    regionStore.setState({ erase: true })
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('move', [-4, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [-4, 0]), ctx)
    expect(painted.set!.count).toBeLessThan(whole)
    expect(painted.set!.count).toBeGreaterThan(0)
    regionStore.setState({ erase: false })
    stroke(tool, ctx, { ctrl: true })
    expect(painted.set!.count).toBe(0)
    expect(regionStore.getState().count).toBe(0)
    // E switches it, as the button does.
    expect(tool.onKey!(key('e'), ctx)).toBe(true)
    expect(regionStore.getState().erase).toBe(true)
  })

  it('leaves a press with Alt, or beside the scan, to the camera', () => {
    const { ctx, navigation, painted } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1, alt: true }), ctx)
    tool.onPointer(pointer('move', [0, 0], { buttons: 1, alt: true }), ctx)
    tool.onPointer(pointer('up', [0, 0]), ctx)
    tool.onPointer(pointer('down', null, { buttons: 1 }), ctx)
    tool.onPointer(pointer('move', [0, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [0, 0]), ctx)
    expect(navigation).toEqual([])
    expect(painted.set?.count ?? 0).toBe(0)
  })

  it('shows itself as a ring on the scan under the pointer, of the radius the bar says, which [ and ] change by a quarter', () => {
    const { ctx, rings } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('move', [3, 4]), ctx)
    expect(rings[rings.length - 1]).toEqual({ centre: [3, 4, 0], normal: [0, 0, 1], radius: 2, erase: false })
    expect(tool.onKey!(key(']'), ctx)).toBe(true)
    expect(regionStore.getState().radius).toBeCloseTo(2.5, 9)
    expect(tool.onKey!(key('['), ctx)).toBe(true)
    expect(tool.onKey!(key('['), ctx)).toBe(true)
    expect(regionStore.getState().radius).toBeCloseTo(1.6, 9)
    tool.onPointer(pointer('move', null), ctx)
    expect(rings[rings.length - 1]).toBeNull()
    // With no radius chosen it is 3 % of the scan's diagonal.
    regionStore.setState({ radius: null })
    tool.onPointer(pointer('move', [0, 0]), ctx)
    expect(rings[rings.length - 1]!.radius).toBeCloseTo(0.03 * Math.hypot(29, 29), 6)
  })

  it('takes back the last stroke, one at a time', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const first = painted.set!.count
    tool.onPointer(pointer('down', [0, 8], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [0, 8]), ctx)
    expect(painted.set!.count).toBeGreaterThan(first)
    stroke(tool, ctx, { ctrl: true })
    expect(painted.set!.count).toBeLessThan(first)
    // The erasing, then the dab, then the first stroke.
    expect(tool.onKey!(key('z'), ctx)).toBe(true)
    expect(painted.set!.count).toBeGreaterThan(first)
    undoStroke()
    expect(painted.set!.count).toBe(first)
    undoStroke()
    expect([painted.set!.count, regionStore.getState().canUndo]).toEqual([0, false])
    undoStroke()
    expect(painted.touched).toBeGreaterThan(6)
  })
})

describe('a box', () => {
  it('takes what a drag begun with Shift goes round and that faces the eye', () => {
    const { ctx, painted, navigation } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [0, -2], { buttons: 1, shift: true }), ctx)
    tool.onPointer(pointer('move', [2, 0], { buttons: 1, shift: true }), ctx)
    tool.onPointer(pointer('up', [3, 2]), ctx)
    expect(navigation).toEqual([false, true])
    let expected = 0
    for (let t = 0; t < 1682; t++) {
      const x = (SHEET.vertices[SHEET.triangles[t * 3] * 3] + SHEET.vertices[SHEET.triangles[t * 3 + 1] * 3] + SHEET.vertices[SHEET.triangles[t * 3 + 2] * 3]) / 3
      const y = (SHEET.vertices[SHEET.triangles[t * 3] * 3 + 1] + SHEET.vertices[SHEET.triangles[t * 3 + 1] * 3 + 1] + SHEET.vertices[SHEET.triangles[t * 3 + 2] * 3 + 1]) / 3
      if (x >= 0 && x <= 3 && y >= -2 && y <= 2) expected += 1
    }
    expect(painted.set!.count).toBe(expected)
    expect(expected).toBeGreaterThan(10)
    // The same in the bar's box mode, with no key held; and a press that goes nowhere takes nothing.
    clearRegion()
    regionStore.setState({ mode: 'box' })
    tool.onPointer(pointer('down', [0, -2], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [3, 2]), ctx)
    expect(painted.set!.count).toBe(expected)
    tool.onPointer(pointer('down', [5, 5], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [5, 5]), ctx)
    expect(painted.set!.count).toBe(expected)
  })

  it('is the frustum through its two corners, seen in perspective or not', () => {
    const inside = (planes: THREE.Plane[], p: Vec3): boolean => planes.every((plane) => plane.distanceToPoint(new THREE.Vector3(...p)) >= 0)
    const ortho = boxPlanes(CAMERA, { origin: [0, -2, 100], direction: [0, 0, -1] }, { origin: [3, 2, 100], direction: [0, 0, -1] })!
    expect([inside(ortho, [1, 0, 0]), inside(ortho, [1, 0, -50]), inside(ortho, [-0.1, 0, 0]), inside(ortho, [1, 2.1, 0]), inside(ortho, [3.1, 0, 0])]).toEqual([true, true, false, false, false])
    const eye: Vec3 = [0, 0, 100]
    const towards = (p: Vec3): Vec3 => {
      const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]
      const length = Math.hypot(...d)
      return [d[0] / length, d[1] / length, d[2] / length]
    }
    const seen = boxPlanes({ ...CAMERA, ortho: false }, { origin: eye, direction: towards([0, -2, 0]) }, { origin: eye, direction: towards([3, 2, 0]) })!
    expect([inside(seen, [1, 0, 0]), inside(seen, [-0.1, 0, 0]), inside(seen, [3.1, 0, 0]), inside(seen, [1, 2.1, 0])]).toEqual([true, false, false, false])
    // Half way to the eye the same box is half as wide.
    expect([inside(seen, [1.4, 0, 50]), inside(seen, [1.6, 0, 50])]).toEqual([true, false])
    // Two corners in one place go round nothing.
    expect(boxPlanes(CAMERA, { origin: [0, 0, 100], direction: [0, 0, -1] }, { origin: [0, 0, 100], direction: [0, 0, -1] })).toBeNull()
  })
})

describe('grow to flat', () => {
  it('spreads what is painted over what lies flat with it, as one step that can be taken back', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [0, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [0, 0]), ctx)
    const dab = painted.set!.count
    growRegion()
    // The whole sheet is flat.
    expect(painted.set!.count).toBe(1682)
    expect(regionStore.getState().count).toBe(1682)
    undoStroke()
    expect(painted.set!.count).toBe(dab)
  })
})

describe('keeping', () => {
  it('sends the scan, the layout, the build, the camera and the bits to main, opens the note of the mark, and has nothing in hand after', async () => {
    const { ctx, notes, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    expect(tool.onKey!(key('Enter'), ctx)).toBe(true)
    await vi.waitFor(() => expect(notes).toHaveLength(1))
    expect(asked).toHaveLength(1)
    const { objectId, region } = asked[0]
    expect(objectId).toBe('bracket')
    expect(region).toMatchObject({ scan: 'S1', note: '', layout: 'assembly', revision: 4, camera: CAMERA })
    expect(region.bits).toBeInstanceOf(Uint8Array)
    expect(region.bits).toHaveLength(Math.ceil(1682 / 8))
    expect(popcount(region.bits)).toBe(count)
    expect(notes[0]).toMatchObject({ id: 'M1' })
    expect(painted.scan).toBeNull()
    expect(regionStore.getState()).toMatchObject({ count: 0, area: 0, canUndo: false, sending: false })
  })

  it('says a refusal at the pointer and in the bar, and keeps what was painted', async () => {
    const { ctx, said, notes, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    answer = async () => Promise.reject(new Error('S1 was imported again while the region was being kept: paint it again'))
    await keepRegion(ctx)
    expect(said).toContain('S1 was imported again while the region was being kept: paint it again')
    expect(regionStore.getState()).toMatchObject({ refused: 'S1 was imported again while the region was being kept: paint it again', count, sending: false })
    expect(painted.set!.count).toBe(count)
    expect(notes).toEqual([])
  })

  it('keeps nothing of no triangle: main is not asked', async () => {
    const { ctx, said } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('move', [0, 0]), ctx)
    await keepRegion(ctx)
    expect(asked).toEqual([])
    expect(said).toContain(NOTHING_PAINTED)
  })

  it('is asked of main once however often Enter is pressed while it answers', async () => {
    const { ctx } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    let done: (mark: Mark) => void = () => {}
    answer = () => new Promise((resolve) => (done = resolve))
    tool.onKey!(key('Enter'), ctx)
    tool.onKey!(key('Enter'), ctx)
    expect(asked).toHaveLength(1)
    expect(regionStore.getState().sending).toBe(true)
    done({ id: 'M2', kind: 'region', layout: 'assembly' } as Mark)
    await vi.waitFor(() => expect(regionStore.getState().sending).toBe(false))
  })
})

describe('putting it down', () => {
  it('empties the set with Escape and leaves the tool to be put down; Clear empties it and stays', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    clearRegion()
    expect(painted.scan).toBeNull()
    expect(regionStore.getState()).toMatchObject({ count: 0, canUndo: false })
    stroke(tool, ctx)
    expect(painted.set!.count).toBeGreaterThan(0)
    // Not the tool's to keep: the pane then takes up Select.
    expect(tool.onKey!(key('Escape'), ctx)).toBe(false)
    expect(painted.scan).toBeNull()
    expect(regionStore.getState().count).toBe(0)
  })

  it('ends a stroke that is cut short, and keeps what was painted', () => {
    const { ctx, navigation, painted, rings } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('move', [-4, 0], { buttons: 1 }), ctx)
    tool.cancel(ctx)
    expect(navigation).toEqual([false, true])
    expect(rings[rings.length - 1]).toBeNull()
    expect(painted.set!.count).toBeGreaterThan(0)
    expect(regionStore.getState().count).toBe(painted.set!.count)
    // A move with no button held after it paints nothing more.
    const count = painted.set!.count
    tool.onPointer(pointer('move', [8, 8]), ctx)
    expect(painted.set!.count).toBe(count)
  })

  it('drops what was painted on a scan that is gone, or whose mesh is another', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    store.setState({ scans: [scanInfo('S1', { imported: { ...scanInfo('S1').imported, at: 'later' } })] })
    tool.onPointer(pointer('move', [0, 0]), ctx)
    expect(regionStore.getState()).toMatchObject({ count: 0, notice: 'S1 was read again: what was painted on it was of the mesh it had' })
    stroke(tool, ctx)
    expect(painted.set!.count).toBeGreaterThan(0)
    store.setState({ scans: [] })
    tool.onPointer(pointer('move', null), ctx)
    expect(regionStore.getState().count).toBe(0)
  })
})

describe('with nothing to paint on', () => {
  it('says to import a scan, or that the scan is still being indexed', () => {
    store.setState({ scans: [] })
    const none = fake()
    const tool = regionTool()
    tool.onPointer(pointer('move', null), none.ctx)
    tool.onPointer(pointer('down', null, { buttons: 1 }), none.ctx)
    expect(none.said).toContain(NO_SCAN)
    store.setState({ scans: [scanInfo('S1')] })
    const early = fake({ tree: false })
    tool.onPointer(pointer('down', [0, 0], { buttons: 1 }), early.ctx)
    expect(early.said).toContain(NOT_INDEXED)
    expect(early.navigation).toEqual([])
  })

  it('paints on the scan under the first press, and on no other until that is kept or cleared', () => {
    store.setState({ scans: [scanInfo('S1'), scanInfo('S2')] })
    const { ctx, painted, said } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    expect(painted.scan).toBe('S1')
    const count = painted.set!.count
    // A press on another scan while one is being painted.
    const elsewhere = pointer('down', [8, 8], { buttons: 1 })
    under = onScan(8, 8, 'S2')
    tool.onPointer(elsewhere, ctx)
    expect(painted.set!.count).toBe(count)
    expect(said).toContain('Painting on S1: keep or clear that first')
  })
})

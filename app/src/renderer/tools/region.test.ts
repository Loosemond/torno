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
import { toolStore } from '../state/tools'
import { CLEARED, IN_HAND, KEEPING, NOT_INDEXED, NOTHING_PAINTED, NO_SCAN, boxPlanes, clearRegion, connectRegion, editRegion, forgetPaintings, growRegion, keepRegion, regionTool, undoStroke, waiting } from './regionTool'
import { type ToolContext, routePointer } from './Tool'

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
function pointer(type: ViewportPointer['type'], at: [number, number] | null, opts: { buttons?: number; shift?: boolean; alt?: boolean; ctrl?: boolean; part?: number } = {}): ViewportPointer {
  under = at ? onScan(at[0], at[1]) : null
  const [x, y] = at ?? [99, 99]
  // A part seen at this pixel, so far along the ray: the scan is 100 along it.
  const part = opts.part === undefined ? null : ({ partKey: 'assembly:lid', part: 'lid', kind: 'face', index: 1, ref: 'lid/F1', point: [x, y, 100 - opts.part], normal: [0, 0, 1], distance: opts.part } as never)
  if (part) return { type, hit: part, ray: { origin: [x, y, 100], direction: [0, 0, -1] }, client: [x, -y], buttons: opts.buttons ?? 0, shift: opts.shift ?? false, alt: opts.alt ?? false }
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
  const cut: { plane: { origin: Vec3; normal: Vec3 } | null } = { plane: null }
  const viewport = {
    getSection: () => cut.plane,
    setRegions: () => {},
    getCamera: () => CAMERA,
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
  return { ctx, said, navigation, rings, notes, painted, cut }
}

let asked: Array<{ objectId: string; region: NewRegion }> = []
let answer: (region: NewRegion) => Promise<Mark> = async () => ({ id: 'M1', kind: 'region', layout: 'assembly' }) as Mark

beforeEach(() => {
  asked = []
  answer = async () => ({ id: 'M1', kind: 'region', layout: 'assembly' }) as Mark
  vi.stubGlobal('window', { torno: { marks: { addRegion: (objectId: string, region: NewRegion) => (asked.push({ objectId, region }), answer(region)) } } })
  store.setState({ objectId: 'bracket', layout: 'assembly', revision: 4, scans: [scanInfo('S1')], scanViews: {} })
  alignStore.setState({ scan: null })
  forgetPaintings()
  toolStore.setState({ tool: 'region' })
  regionStore.setState({ radius: 2, erase: false, through: false, mode: 'brush', refused: null, notice: null, editing: null, scan: null, count: 0, area: 0, canUndo: false, sending: false })
})
afterEach(() => {
  forgetPaintings()
  toolStore.setState({ tool: 'select' })
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
    const touched = painted.touched
    undoStroke()
    // Nothing left to take back: nothing is touched.
    expect([painted.set?.count ?? 0, painted.touched]).toEqual([0, touched])
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

describe('putting it down (I5): a painting is never lost by accident', () => {
  it('is discarded by Clear alone, and Undo brings that back', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    clearRegion()
    expect(painted.scan).toBeNull()
    expect(regionStore.getState()).toMatchObject({ count: 0, canUndo: true, notice: CLEARED })
    expect(tool.onKey!(key('z'), ctx)).toBe(true)
    expect(painted.scan).toBe('S1')
    expect(painted.set!.count).toBe(count)
    expect(regionStore.getState()).toMatchObject({ count, notice: null })
    // Its strokes can still be taken back one by one.
    undoStroke()
    expect(regionStore.getState().count).toBe(0)
    // Once something else is painted, what was cleared is gone for good.
    stroke(tool, ctx)
    clearRegion()
    tool.onPointer(pointer('down', [8, 8], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [8, 8]), ctx)
    const dab = painted.set!.count
    undoStroke()
    undoStroke()
    expect(painted.set!.count).toBe(0)
    expect(dab).toBeLessThan(count)
  })

  it('waits when Escape is pressed: the key is not the tool\'s, and what is painted is there when the tool is taken up again', () => {
    const { ctx, painted } = fake()
    const off = connectRegion(ctx.viewport as never)
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    expect(tool.onKey!(key('Escape'), ctx)).toBe(false)
    // As the pane then does.
    toolStore.setState({ tool: 'select' })
    expect(painted.scan).toBeNull()
    expect(regionStore.getState().count).toBe(count)
    toolStore.setState({ tool: 'region' })
    expect([painted.scan, painted.set!.count]).toEqual(['S1', count])
    expect(regionStore.getState().notice).toBe(waiting(count, 'S1'))
    expect(waiting(1204, 'S1')).toBe('A painting of 1,204 triangles on S1 is waiting: Keep or Clear, or paint on')
    off()
  })

  it('gives up only the stroke under way when Escape is pressed in the middle of one', () => {
    const { ctx, painted, navigation } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    tool.onPointer(pointer('down', [0, 8], { buttons: 1 }), ctx)
    tool.onPointer(pointer('move', [4, 8], { buttons: 1 }), ctx)
    expect(painted.set!.count).toBeGreaterThan(count)
    expect(tool.onKey!(key('Escape'), ctx)).toBe(true)
    expect(painted.set!.count).toBe(count)
    expect(navigation[navigation.length - 1]).toBe(true)
    // The moves that follow with the button still held paint nothing, and it was no step.
    tool.onPointer(pointer('move', [6, 8], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [6, 8]), ctx)
    expect(painted.set!.count).toBe(count)
    undoStroke()
    expect(painted.set!.count).toBe(0)
    // An erasing stroke given up puts back what it took.
    stroke(tool, ctx)
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1, ctrl: true }), ctx)
    tool.onPointer(pointer('move', [-2, 0], { buttons: 1, ctrl: true }), ctx)
    expect(painted.set!.count).toBeLessThan(count)
    tool.onKey!(key('Escape'), ctx)
    expect(painted.set!.count).toBe(count)
  })

  it('waits while another object is on show, and is in hand again when its own is back', () => {
    const { ctx, painted } = fake()
    const off = connectRegion(ctx.viewport as never)
    const tool = regionTool()
    stroke(tool, ctx)
    const set = painted.set!
    const count = set.count
    store.setState({ objectId: 'gear', scans: [scanInfo('S1')] })
    expect(painted.scan).toBeNull()
    expect(regionStore.getState()).toMatchObject({ count: 0, canUndo: false })
    // The other object has a painting of its own, on its own S1.
    const there = { ...ctx, objectId: 'gear' } as ToolContext
    tool.onPointer(pointer('down', [8, 8], { buttons: 1 }), there)
    tool.onPointer(pointer('up', [8, 8]), there)
    expect(painted.set).not.toBe(set)
    const other = painted.set!.count
    store.setState({ objectId: 'bracket', scans: [scanInfo('S1')] })
    expect(painted.set).toBe(set)
    expect(regionStore.getState()).toMatchObject({ count, scan: 'S1', notice: waiting(count, 'S1') })
    store.setState({ objectId: 'gear', scans: [scanInfo('S1')] })
    expect(regionStore.getState().count).toBe(other)
    off()
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

  it('goes only with its scan, or with the mesh it was painted on, and then says which', () => {
    const { ctx, painted } = fake()
    const off = connectRegion(ctx.viewport as never)
    const tool = regionTool()
    stroke(tool, ctx)
    store.setState({ scans: [scanInfo('S1', { imported: { ...scanInfo('S1').imported, at: 'later' } })] })
    expect(regionStore.getState()).toMatchObject({ count: 0, notice: 'S1 was read again: what was painted on it was of the mesh it had' })
    expect(painted.scan).toBeNull()
    stroke(tool, ctx)
    expect(painted.set!.count).toBeGreaterThan(0)
    store.setState({ scans: [] })
    expect(regionStore.getState()).toMatchObject({ count: 0, notice: 'S1 is gone: what was painted on it went with it' })
    off()
  })
})

describe('what is seen is what is painted (I1, M4)', () => {
  it('takes nothing of the scan where a part is in front of it: not at the press, not as the stroke goes, and shows no ring there', () => {
    const { ctx, painted, navigation, rings } = fake()
    const tool = regionTool()
    // The lid is 60 along the ray, the scan 100: the press is the camera's.
    tool.onPointer(pointer('down', [-6, 0], { buttons: 1, part: 60 }), ctx)
    tool.onPointer(pointer('up', [-6, 0], { part: 60 }), ctx)
    expect(navigation).toEqual([])
    expect(painted.set?.count ?? 0).toBe(0)
    tool.onPointer(pointer('move', [0, 0], { part: 60 }), ctx)
    expect(rings[rings.length - 1]).toBeNull()
    // A stroke that runs under the lid stops there, and goes on where the scan is seen again.
    tool.onPointer(pointer('down', [-10, 0], { buttons: 1 }), ctx)
    const open = painted.set!.count
    tool.onPointer(pointer('move', [-4, 0], { buttons: 1, part: 60 }), ctx)
    tool.onPointer(pointer('move', [0, 0], { buttons: 1, part: 60 }), ctx)
    expect(painted.set!.count).toBe(open)
    tool.onPointer(pointer('move', [10, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [10, 0]), ctx)
    // Two dabs, with nothing between them: not a band from -10 to 10.
    expect(painted.set!.count).toBeLessThan(open * 2 + 4)
    expect(painted.set!.count).toBeGreaterThan(open)
    // A part behind the scan is in nobody's way.
    clearRegion()
    tool.onPointer(pointer('down', [0, 0], { buttons: 1, part: 140 }), ctx)
    tool.onPointer(pointer('up', [0, 0], { part: 140 }), ctx)
    expect(painted.set!.count).toBeGreaterThan(0)
  })

  it('takes nothing of the half a section has taken away, with the brush or with a box', () => {
    const { ctx, painted, cut } = fake()
    const tool = regionTool()
    // What is at a greater x than 0 is cut away.
    cut.plane = { origin: [0, 0, 0], normal: [1, 0, 0] }
    tool.onPointer(pointer('down', [-0.5, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [-0.5, 0]), ctx)
    const middleX = (t: number): number => (SHEET.vertices[SHEET.triangles[t * 3] * 3] + SHEET.vertices[SHEET.triangles[t * 3 + 1] * 3] + SHEET.vertices[SHEET.triangles[t * 3 + 2] * 3]) / 3
    const all = (): number[] => Array.from({ length: 1682 }, (_, t) => t).filter((t) => painted.set!.has(t))
    expect(all().length).toBeGreaterThan(4)
    expect(all().every((t) => middleX(t) <= 1e-6)).toBe(true)
    clearRegion()
    tool.onPointer(pointer('down', [-3, -2], { buttons: 1, shift: true }), ctx)
    tool.onPointer(pointer('up', [3, 2]), ctx)
    expect(all().length).toBeGreaterThan(10)
    expect(all().every((t) => middleX(t) <= 1e-6)).toBe(true)
  })
})

describe('fix round 1, the smaller things', () => {
  it('takes a box on the scan pressed on before the one the Align tool had (M1)', () => {
    store.setState({ scans: [scanInfo('S1'), scanInfo('S2')] })
    alignStore.setState({ scan: 'S2' })
    const { ctx, painted } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [0, -2], { buttons: 1, shift: true }), ctx)
    tool.onPointer(pointer('up', [3, 2]), ctx)
    expect(painted.scan).toBe('S1')
    expect(painted.set!.count).toBeGreaterThan(10)
  })

  it('says when growing stopped at the most it adds at once (M2)', () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    tool.onPointer(pointer('down', [0, 0], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [0, 0]), ctx)
    growRegion()
    // The whole sheet is under the cap: nothing to say.
    expect(regionStore.getState().notice).toBeNull()
    growRegion()
    expect(regionStore.getState().notice).toBe('Nothing flat with it is within reach')
    expect(painted.set!.count).toBe(1682)
  })

  it('takes no press while main is keeping: what was sent is what is kept (M3)', async () => {
    const { ctx, painted, said } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    let done: (mark: Mark) => void = () => {}
    answer = () => new Promise((resolve) => (done = resolve))
    void keepRegion(ctx)
    tool.onPointer(pointer('down', [8, 8], { buttons: 1 }), ctx)
    tool.onPointer(pointer('up', [8, 8]), ctx)
    expect(painted.set!.count).toBe(count)
    expect(said).toContain(KEEPING)
    done({ id: 'M2', kind: 'region', layout: 'assembly' } as Mark)
    await vi.waitFor(() => expect(regionStore.getState().sending).toBe(false))
    expect(popcount(asked[0].region.bits)).toBe(count)
  })

  it('takes with a box only what faces the eye, unless "through" is chosen', () => {
    // The sheet seen from below: its triangles face away.
    const { ctx, painted } = fake()
    const tool = regionTool()
    const below = (type: ViewportPointer['type'], at: [number, number], opts: { buttons?: number; shift?: boolean } = {}): ViewportPointer => ({ ...pointer(type, at, opts), ray: { origin: [at[0], at[1], -100], direction: [0, 0, 1] } })
    const from = { ...CAMERA, position: [0, 0, -100] as Vec3 }
    const under = { ...ctx, camera: from } as ToolContext
    // The scan shows its back in the middle of the box: that side is the one seen, and is taken.
    tool.onPointer(below('down', [0, -2], { buttons: 1, shift: true }), under)
    tool.onPointer(below('up', [3, 2]), under)
    const seen = painted.set!.count
    expect(seen).toBeGreaterThan(10)
    regionStore.setState({ through: true })
    clearRegion()
    tool.onPointer(below('down', [0, -2], { buttons: 1, shift: true }), under)
    tool.onPointer(below('up', [3, 2]), under)
    expect(painted.set!.count).toBe(seen)
  })
})

describe('while the build is stale (M9)', () => {
  it('is painted on all the same: a region is of the scan, which no build makes', () => {
    const { ctx, painted, said } = fake()
    const stale = { ...ctx, stale: 'The last build failed: picks wait for a build that works' } as ToolContext
    const tool = regionTool()
    for (const e of [pointer('down', [-6, 0], { buttons: 1 }), pointer('move', [-2, 0], { buttons: 1 }), pointer('up', [-2, 0])]) routePointer(tool, e, stale)
    expect(painted.set!.count).toBeGreaterThan(10)
    expect(said).toEqual([])
  })
})

describe('painting a kept region again', () => {
  const kept = { id: 'M4', kind: 'region', scan: 'S1', author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', triangles: 3, area: 1.5 } as never
  const maskOf = (...triangles: number[]): ArrayBuffer => {
    const file = new Uint8Array(16 + Math.ceil(1682 / 8))
    file.set(new TextEncoder().encode('TORNOMSK'))
    new DataView(file.buffer).setUint32(8, 1, true)
    new DataView(file.buffer).setUint32(12, 1682, true)
    for (const t of triangles) file[16 + (t >> 3)] |= 1 << (t & 7)
    return file.buffer
  }

  it('takes its triangles in hand as a painting, and Keep makes them the region\'s: no new mark, no note', async () => {
    const { ctx, painted, notes } = fake()
    const off = connectRegion(ctx.viewport as never)
    const repainted: Array<{ id: string; bits: Uint8Array }> = []
    const masks: string[] = []
    vi.stubGlobal('window', { torno: { scans: { mask: async (_o: string, _s: string, stem: string) => (masks.push(stem), maskOf(5, 6, 7)) }, marks: { repaintRegion: async (_o: string, id: string, bits: Uint8Array) => (repainted.push({ id, bits }), { id, kind: 'region', layout: 'assembly' }) } } })
    toolStore.setState({ tool: 'select' })
    await editRegion({ ...(kept as object), mask: 2 } as never)
    expect(masks).toEqual(['M4.2'])
    expect(toolStore.getState().tool).toBe('region')
    expect([painted.scan, painted.set!.count]).toEqual(['S1', 3])
    expect(regionStore.getState()).toMatchObject({ editing: 'M4', count: 3, scan: 'S1' })
    const tool = regionTool()
    stroke(tool, ctx)
    const count = painted.set!.count
    expect(count).toBeGreaterThan(3)
    await keepRegion(ctx)
    expect(repainted).toHaveLength(1)
    expect(repainted[0].id).toBe('M4')
    expect(popcount(repainted[0].bits)).toBe(count)
    expect(notes).toEqual([])
    expect(regionStore.getState()).toMatchObject({ editing: null, count: 0 })
    off()
  })

  it('is not taken in hand while another painting is: that one is kept or cleared first', async () => {
    const { ctx, painted } = fake()
    const tool = regionTool()
    stroke(tool, ctx)
    const set = painted.set
    let asked = 0
    vi.stubGlobal('window', { torno: { scans: { mask: async () => ((asked += 1), maskOf(1)) } } })
    await editRegion(kept)
    expect(asked).toBe(0)
    expect(painted.set).toBe(set)
    expect(regionStore.getState().notice).toBe(IN_HAND)
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

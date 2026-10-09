import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Described } from '../../shared/geometry'
import type { Vec3 } from '../../shared/marks'
import type { SectionPlane } from '../../shared/view'
import { actions, store } from '../state/store'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { NOT_FLAT, PICK_A_FACE, alongNormal, sectionStore, sectionTool, setFromFace } from './sectionTool'
import { CUT_FACE, routePointer, type ToolContext } from './Tool'

const BOX = { min: [-20, -15, -2.5] as Vec3, max: [20, 15, 22.5] as Vec3 }
const Z: SectionPlane = { origin: [0, 0, 10], normal: [0, 0, 1] }
const SIDE: Described = { kind: 'face', ref: 'assembly:base/F1', type: 'plane', area: 150, center: [20, 0, 0], normal: [1, 0, 0], radius: null, descriptor: 'plane, normal +X, x = 20, 150 mm²' }

/** From the front: the ray looks along +Y through (x, z), and the client pixel is (x, -z). */
function pointer(type: ViewportPointer['type'], x: number, z: number, opts: { hit?: Hit | null; alt?: boolean; cut?: boolean; buttons?: number } = {}): ViewportPointer {
  const buttons = opts.buttons ?? (type === 'up' || type === 'click' ? 0 : 1)
  return { type, hit: opts.hit ?? null, ray: { origin: [x, -100, z], direction: [0, 1, 0] }, client: [x, -z], buttons, shift: false, alt: opts.alt ?? false, ...(opts.cut ? { cut: true } : {}) }
}

function fake(over: Partial<ToolContext> = {}) {
  let plane: SectionPlane | null = store.getState().section
  const shown: Array<SectionPlane | null> = []
  const navigation: boolean[] = []
  const said: string[] = []
  const ctx: ToolContext = {
    viewport: {
      setHover: () => {},
      setNavigation: (on) => void navigation.push(on),
      setDraft: () => {},
      lockedView: () => null,
      pick: () => null,
      bounds: () => BOX,
      sectionBox: () => BOX,
      getSection: () => plane,
      setSection: (p) => {
        plane = p
        shown.push(p)
      }
    },
    readout: { show: (_at, ref) => void said.push(ref), describe: () => {}, say: (_at, message) => void said.push(message), hide: () => {} },
    objectId: 'bracket',
    layout: store.getState().layout,
    revision: store.getState().revision,
    camera: { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 },
    stale: null,
    descriptor: () => undefined,
    describe: async () => SIDE,
    commit: async () => {
      throw new Error('a section is no mark')
    },
    openNote: () => {},
    ...over
  }
  return { ctx, shown, navigation, said }
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  actions.setWorkspace(null)
  actions.openObject('bracket', { layers: {}, section: Z })
})

afterEach(() => setFromFace(false))

describe('alongNormal', () => {
  it('is how far along the normal the pointer is, seen from the side', () => {
    expect(alongNormal({ origin: [3, -100, 14], direction: [0, 1, 0] }, [0, 0, 10], [0, 0, 1])).toBeCloseTo(4)
    expect(alongNormal({ origin: [3, -100, 2], direction: [0, 1, 0] }, [0, 0, 10], [0, 0, 1])).toBeCloseTo(-8)
  })

  it('is none when the view looks along the normal', () => {
    expect(alongNormal({ origin: [3, -100, 14], direction: [0, 1, 0] }, [0, 0, 10], [0, 1, 0])).toBeNull()
  })
})

describe('dragging the plane', () => {
  it('moves it along its normal with the pointer, in the viewport only, and keeps it once, when it is let go', () => {
    const tool = sectionTool()
    const { ctx, shown, navigation } = fake()
    const edits = store.getState().edits
    tool.onPointer(pointer('down', 5, 10), ctx)
    expect(navigation).toEqual([false])
    tool.onPointer(pointer('move', 5, 12), ctx)
    expect(shown).toEqual([]) // not a drag yet
    tool.onPointer(pointer('move', 5, 16), ctx)
    tool.onPointer(pointer('move', 6, 17.5), ctx)
    expect(shown.map((p) => p!.origin[2])).toEqual([16, 17.5])
    expect(store.getState()).toMatchObject({ section: Z, edits })
    tool.onPointer(pointer('up', 6, 17.5), ctx)
    expect(store.getState()).toMatchObject({ section: { origin: [0, 0, 17.5], normal: [0, 0, 1] }, edits: edits + 1 })
    expect(navigation).toEqual([false, true])
  })

  it('stops at the ends of the parts', () => {
    const tool = sectionTool()
    const { ctx, shown } = fake()
    tool.onPointer(pointer('down', 0, 10), ctx)
    tool.onPointer(pointer('move', 0, 90), ctx)
    expect(shown.at(-1)!.origin[2]).toBe(22.5)
    tool.onPointer(pointer('move', 0, -90), ctx)
    expect(shown.at(-1)!.origin[2]).toBe(-2.5)
  })

  it('goes by the height of the drag where the view looks along the normal', () => {
    actions.setSection({ origin: [0, 0, 0], normal: [0, 1, 0] })
    const tool = sectionTool()
    const { ctx, shown } = fake()
    tool.onPointer(pointer('down', 0, 0), ctx)
    tool.onPointer(pointer('move', 0, 30), ctx) // 30 px up: a tenth of the 30 mm the parts are deep
    expect(shown.at(-1)!.origin[1]).toBeCloseTo(3)
  })

  it('leaves a press with Alt to the camera, and does nothing without a plane', () => {
    const tool = sectionTool()
    const withAlt = fake()
    tool.onPointer(pointer('down', 0, 10, { alt: true }), withAlt.ctx)
    tool.onPointer(pointer('move', 0, 20, { alt: true }), withAlt.ctx)
    expect(withAlt.navigation).toEqual([])
    expect(withAlt.shown).toEqual([])

    actions.setSection(null)
    const none = fake()
    tool.onPointer(pointer('down', 0, 10), none.ctx)
    tool.onPointer(pointer('move', 0, 20), none.ctx)
    expect(none.navigation).toEqual([])
  })

  it('keeps what it has when the tool is put down in the middle of a drag', () => {
    const tool = sectionTool()
    const { ctx } = fake()
    tool.onPointer(pointer('down', 0, 10), ctx)
    tool.onPointer(pointer('move', 0, 15), ctx)
    tool.cancel(ctx)
    expect(store.getState().section?.origin[2]).toBe(15)
  })
})

describe('the arrow keys', () => {
  const key = (k: string, shiftKey = false) => ({ key: k, shiftKey }) as KeyboardEvent

  it('nudge the plane by a millimetre, with Shift by a tenth, and keep it each time', () => {
    const tool = sectionTool()
    const { ctx } = fake()
    expect(tool.onKey!(key('ArrowUp'), ctx)).toBe(true)
    expect(store.getState().section?.origin[2]).toBe(11)
    tool.onKey!(key('ArrowDown', true), ctx)
    tool.onKey!(key('ArrowLeft', true), ctx)
    tool.onKey!(key('ArrowDown', true), ctx)
    expect(store.getState().section?.origin[2]).toBeCloseTo(10.7, 9)
    tool.onKey!(key('ArrowRight'), ctx)
    expect(store.getState().section?.origin[2]).toBeCloseTo(11.7, 9)
  })

  it('are not the tool\'s without a plane, nor is any other key', () => {
    const tool = sectionTool()
    const { ctx } = fake()
    expect(tool.onKey!(key('x'), ctx)).toBe(false)
    actions.setSection(null)
    expect(tool.onKey!(key('ArrowUp'), ctx)).toBe(false)
  })
})

describe('from a face', () => {
  const side: Hit = { partKey: 'assembly:base', part: 'base', kind: 'face', index: 1, ref: 'base/F1', point: [20, 3, 1], normal: [1, 0, 0], distance: 80 }

  it('puts the plane on the flat face clicked, with the kernel\'s normal, and stops waiting', async () => {
    const tool = sectionTool()
    const { ctx, said } = fake({ describe: async () => ({ ...SIDE, normal: [-1, 0, 0] }) })
    setFromFace(true)
    tool.onPointer(pointer('move', 0, 0, { buttons: 0 }), ctx)
    expect(said).toEqual([PICK_A_FACE])
    tool.onPointer(pointer('down', 0, 0, { hit: side }), ctx)
    tool.onPointer(pointer('up', 0, 0, { hit: side }), ctx)
    tool.onPointer(pointer('click', 0, 0, { hit: side }), ctx)
    await settled()
    // Out of the part, as the surface under the pointer faces, whichever way the kernel's normal runs.
    expect(store.getState().section).toEqual({ origin: [20, 3, 1], normal: [1, 0, 0] })
    expect(sectionStore.getState().fromFace).toBe(false)
  })

  it('says a face that is not flat is not, and goes on waiting', async () => {
    const tool = sectionTool()
    const { ctx, said } = fake({ describe: async () => ({ ...SIDE, type: 'cylinder' }) })
    setFromFace(true)
    tool.onPointer(pointer('click', 0, 0, { hit: side }), ctx)
    await settled()
    expect(said).toEqual([NOT_FLAT])
    expect(store.getState().section).toEqual(Z)
    expect(sectionStore.getState().fromFace).toBe(true)
  })

  it('takes the surface\'s own normal when the kernel cannot say', async () => {
    const tool = sectionTool()
    const { ctx } = fake({ describe: async () => null })
    setFromFace(true)
    tool.onPointer(pointer('click', 0, 0, { hit: side }), ctx)
    await settled()
    expect(store.getState().section).toEqual({ origin: [20, 3, 1], normal: [1, 0, 0] })
  })

  it('does not drag the plane meanwhile, and Escape stops waiting', () => {
    const tool = sectionTool()
    const { ctx, shown, navigation } = fake()
    setFromFace(true)
    tool.onPointer(pointer('down', 0, 10), ctx)
    tool.onPointer(pointer('move', 0, 20), ctx)
    expect(shown).toEqual([])
    expect(navigation).toEqual([])
    expect(tool.onKey!({ key: 'Escape' } as KeyboardEvent, ctx)).toBe(true)
    expect(sectionStore.getState().fromFace).toBe(false)
  })
})

describe('the cut face under the pointer', () => {
  it('is said to be one, after the tool in hand was told of nothing there', () => {
    const { ctx, said } = fake()
    const told: Array<Hit | null> = []
    const tool = { id: 'pin', cursor: '', onPointer: (e: ViewportPointer) => void told.push(e.hit), cancel: () => {} }
    routePointer(tool, pointer('move', 0, 0, { cut: true, buttons: 0 }), ctx)
    expect(told).toEqual([null])
    expect(said).toEqual([CUT_FACE])
  })

  it('is not said to the tool that moves the plane', () => {
    const { ctx, said } = fake()
    routePointer(sectionTool(), pointer('move', 0, 0, { cut: true, buttons: 0 }), ctx)
    expect(said).toEqual([])
  })
})

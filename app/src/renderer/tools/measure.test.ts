import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Described } from '../../shared/geometry'
import type { DimensionMark, Mark, NewMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'
import { setBetween, setRound, toolStore } from '../state/tools'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { REFUSAL_MS, measureTool } from './measureTool'
import { routePointer, type ToolContext } from './Tool'

const CAMERA: Camera = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 }
const PLANE: Described = { kind: 'face', ref: 'assembly:plate/F5', type: 'plane', area: 1100, center: [0, 0, 3], normal: [0, 0, 1], radius: null, descriptor: 'plane, normal +Z, z = 3, 1100 mm²' }
const CYLINDER: Described = { kind: 'face', ref: 'assembly:plate/F9', type: 'cylinder', area: 150.8, center: [-10, 5, 0], normal: null, radius: 4, descriptor: 'cylinder, radius 4, axis Z, 150.8 mm²' }
const CIRCLE: Described = { kind: 'edge', ref: 'assembly:plate/E20', type: 'circle', length: 25.13, center: [-10, 5, 3], descriptor: 'circle, radius 4, 25.13 mm' }
const LINE: Described = { kind: 'edge', ref: 'assembly:plate/E2', type: 'line', length: 40, center: [0, 15, 3], descriptor: 'line, 40 mm' }
const KNOWN: Record<string, Described> = { 'plate/F5': PLANE, 'plate/F0': { ...PLANE, ref: 'assembly:plate/F0', normal: [0, 0, -1] }, 'plate/F9': CYLINDER, 'plate/E20': CIRCLE, 'plate/E2': LINE }

const top = (point: Vec3 = [5, 3, 3]): Hit => ({ partKey: 'assembly:plate', part: 'plate', kind: 'face', index: 5, ref: 'plate/F5', point, normal: [0, 0, 1], distance: 100 })
const bottom = (point: Vec3 = [5, 3, -3]): Hit => ({ ...top(point), index: 0, ref: 'plate/F0', normal: [0, 0, -1] })
const hole = (point: Vec3 = [-6, 5, 0]): Hit => ({ ...top(point), index: 9, ref: 'plate/F9', normal: [-1, 0, 0] })
const rim = (point: Vec3 = [-6, 5, 3]): Hit => ({ ...top(point), kind: 'edge', index: 20, ref: 'plate/E20', normal: null })

/** A pointer event at a client pixel, on what is given. */
function pointer(type: ViewportPointer['type'], client: [number, number], hit: Hit | null = null, opts: { shift?: boolean; buttons?: number } = {}): ViewportPointer {
  return { type, hit, ray: { origin: [client[0], -100, -client[1]], direction: [0, 1, 0] }, client, buttons: opts.buttons ?? 0, shift: opts.shift ?? false, alt: false }
}

const key = (name: string): KeyboardEvent => ({ key: name }) as KeyboardEvent

function fake(over: Partial<ToolContext> = {}) {
  const committed: NewMark[] = []
  const noted: string[] = []
  const drafts: unknown[] = []
  const said: string[] = []
  const hovered: Array<string | null> = []
  /** What the kernel measures of each mark committed, as main would have it. */
  const measures: Record<string, Partial<DimensionMark>> = {
    distance: { value: 6, how: 'between planes' },
    angle: { value: 180, how: 'between normals' },
    diameter: { value: 8, how: 'cylinder' },
    radius: { value: 4, how: 'cylinder' },
    thickness: { value: 6, how: 'wall, along the normal' }
  }
  const ctx: ToolContext = {
    viewport: { setHover: (hit) => void hovered.push(hit?.ref ?? null), setNavigation: () => {}, setDraft: (d) => void drafts.push(d), lockedView: () => null, pick: () => null, bounds: () => ({ min: [-20, -15, -3], max: [20, 15, 3] }) },
    readout: { show: (_at, ref, detail) => void said.push(`${ref} | ${detail ?? ''}`), describe: () => {}, say: (_at, message) => void said.push(message), hide: () => void said.push('(hidden)') },
    objectId: 'measures',
    layout: 'assembly',
    revision: 7,
    camera: CAMERA,
    stale: null,
    descriptor: () => undefined,
    describe: async (ref) => KNOWN[ref] ?? null,
    commit: async (mark) => {
      committed.push(mark)
      const measured = mark.kind === 'dimension' ? measures[mark.measure] : {}
      return { ...mark, ...measured, id: `M${committed.length}`, status: 'draft', anchorState: 'ok', createdAt: '2026-10-09T00:00:00.000Z' } as Mark
    },
    openNote: (mark) => void noted.push(mark.id),
    ...over
  }
  return { ctx, committed, noted, drafts, said, hovered }
}

/** Lets the promises a tool left behind run out. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  setBetween('distance')
  setRound('diameter')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the measure tool', () => {
  it('two clicks on two things leave a distance between them: each end with its ref, its point and the kernel’s line', async () => {
    const tool = measureTool()
    const { ctx, committed, noted } = fake()
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    await settled()
    expect(committed).toEqual([])
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toEqual([
      {
        kind: 'dimension',
        measure: 'distance',
        author: 'user',
        note: '',
        layout: 'assembly',
        revision: 7,
        camera: CAMERA,
        a: { point: [5, 3, 3], normal: [0, 0, 1], part: 'plate', ref: 'plate/F5', descriptor: PLANE.descriptor },
        b: { point: [5, 3, -3], normal: [0, 0, -1], part: 'plate', ref: 'plate/F0', descriptor: PLANE.descriptor }
      }
    ])
    // A measurement needs no note: none is opened.
    expect(noted).toEqual([])
  })

  it('stays in hand: the next two clicks are the next dimension', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    for (const [y, hit] of [[50, top()], [120, bottom()], [200, top([9, 9, 3])], [300, hole()]] as const) {
      tool.onPointer(pointer('click', [50, y], hit), ctx)
      await settled()
    }
    expect(committed.map((m) => m.kind === 'dimension' && [m.a.ref, m.b?.ref])).toEqual([['plate/F5', 'plate/F0'], ['plate/F5', 'plate/F9']])
  })

  it('measures an angle between the two when that is what is asked for', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    setBetween('angle')
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toMatchObject([{ measure: 'angle', a: { ref: 'plate/F5' }, b: { ref: 'plate/F0' } }])
  })

  it('a double click on a cylindrical face or a circular edge commits its diameter at once', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    tool.onPointer(pointer('click', [50, 50], hole()), ctx)
    tool.onPointer(pointer('click', [51, 50], hole()), ctx)
    await settled()
    expect(committed).toEqual([{ kind: 'dimension', measure: 'diameter', author: 'user', note: '', layout: 'assembly', revision: 7, camera: CAMERA, a: { point: [-6, 5, 0], normal: [-1, 0, 0], part: 'plate', ref: 'plate/F9', descriptor: CYLINDER.descriptor } }])
    tool.onPointer(pointer('click', [200, 50], rim()), ctx)
    tool.onPointer(pointer('click', [200, 50], rim()), ctx)
    await settled()
    expect(committed[1]).toMatchObject({ measure: 'diameter', a: { point: [-6, 5, 3], ref: 'plate/E20' } })
    expect(committed[1]).not.toHaveProperty('b')
    // And the tool starts afresh: the next click is a first end again.
    tool.onPointer(pointer('click', [300, 300], top()), ctx)
    await settled()
    expect(committed).toHaveLength(2)
  })

  it('its radius, when that is what is asked for', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    setRound('radius')
    tool.onPointer(pointer('click', [50, 50], hole()), ctx)
    tool.onPointer(pointer('click', [50, 50], hole()), ctx)
    await settled()
    expect(committed).toMatchObject([{ measure: 'radius' }])
  })

  it('a double click on what has no radius is one click: the first end, still waiting for the second', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    await settled()
    expect(committed).toEqual([])
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toMatchObject([{ measure: 'distance', a: { ref: 'plate/F5' }, b: { ref: 'plate/F0' } }])
  })

  it('a slow second click on a round thing is its second end, not a double click', async () => {
    vi.useFakeTimers()
    const tool = measureTool()
    const { ctx, committed } = fake()
    tool.onPointer(pointer('click', [50, 50], hole()), ctx)
    await vi.advanceTimersByTimeAsync(600)
    tool.onPointer(pointer('click', [50, 50], hole([-6, 5, 1])), ctx)
    await vi.advanceTimersByTimeAsync(10)
    expect(committed).toMatchObject([{ measure: 'distance', a: { ref: 'plate/F9' }, b: { ref: 'plate/F9', point: [-6, 5, 1] } }])
  })

  it('T over a face commits the thickness of the wall at that point', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    expect(tool.onKey!(key('t'), ctx)).toBe(false)
    tool.onPointer(pointer('move', [80, 40], top([8, 4, 3])), ctx)
    expect(tool.onKey!(key('t'), ctx)).toBe(true)
    await settled()
    expect(committed).toEqual([{ kind: 'dimension', measure: 'thickness', author: 'user', note: '', layout: 'assembly', revision: 7, camera: CAMERA, a: { point: [8, 4, 3], normal: [0, 0, 1], part: 'plate', ref: 'plate/F5', descriptor: PLANE.descriptor } }])
    // An edge has no wall under it, and neither has nothing.
    tool.onPointer(pointer('move', [200, 50], rim()), ctx)
    expect(tool.onKey!(key('T'), ctx)).toBe(false)
    tool.onPointer(pointer('move', [400, 400], null), ctx)
    expect(tool.onKey!(key('T'), ctx)).toBe(false)
    expect(committed).toHaveLength(1)
  })

  it('with Shift an end is a bare point: where it was clicked, tied to nothing', async () => {
    const tool = measureTool()
    const { ctx, committed } = fake()
    tool.onPointer(pointer('click', [50, 50], top([1, 2, 3]), { shift: true }), ctx)
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toMatchObject([{ measure: 'distance', a: { point: [1, 2, 3] }, b: { ref: 'plate/F0' } }])
    expect((committed[0] as DimensionMark).a).toEqual({ point: [1, 2, 3] })
    // A bare point has no diameter: a double click with Shift is one click.
    tool.onPointer(pointer('click', [300, 50], hole(), { shift: true }), ctx)
    tool.onPointer(pointer('click', [300, 50], hole(), { shift: true }), ctx)
    await settled()
    expect(committed).toHaveLength(1)
  })

  it('Escape drops the first end and keeps the tool; with nothing under way it is not the tool’s', async () => {
    const tool = measureTool()
    const { ctx, committed, drafts } = fake()
    expect(tool.onKey!(key('Escape'), ctx)).toBe(false)
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'dimension', from: [5, 3, 3], to: null })
    expect(tool.onKey!(key('Escape'), ctx)).toBe(true)
    expect(drafts.at(-1)).toBeNull()
    // The next click is a first end again.
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toEqual([])
    expect(tool.onKey!(key('Escape'), ctx)).toBe(true)
    expect(tool.onKey!(key('Escape'), ctx)).toBe(false)
  })

  it('put down, it drops what it had under way', async () => {
    const tool = measureTool()
    const { ctx, committed, drafts, hovered } = fake()
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    tool.cancel(ctx)
    expect(drafts.at(-1)).toBeNull()
    expect(hovered.at(-1)).toBeNull()
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toEqual([])
  })

  it('while the second end is pending, draws the line to the pointer and reads out an estimate from the mesh, marked as one', () => {
    const tool = measureTool()
    const { ctx, drafts, said } = fake()
    tool.onPointer(pointer('move', [50, 50], top()), ctx)
    expect(said.at(-1)).toBe('plate/F5 | ')
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    tool.onPointer(pointer('move', [50, 120], bottom([5, 7, -3])), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'dimension', from: [5, 3, 3], to: [5, 7, -3] })
    // √(4² + 6²)
    expect(said.at(-1)).toBe('≈ 7.2 mm | plate/F0')
    setBetween('angle')
    tool.onPointer(pointer('move', [50, 121], bottom([5, 7, -3])), ctx)
    expect(said.at(-1)).toBe('≈ 180° | plate/F0')
    // An edge has no normal to estimate an angle from.
    tool.onPointer(pointer('move', [50, 122], rim()), ctx)
    expect(said.at(-1)).toBe('angle | plate/E20')
    // Off the parts, only the first end is drawn.
    tool.onPointer(pointer('move', [400, 400], null), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'dimension', from: [5, 3, 3], to: null })
  })

  it('once main has kept it, reads out the kernel’s value in place of the estimate, and takes its draft away', async () => {
    const tool = measureTool()
    const { ctx, drafts, said } = fake()
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    tool.onPointer(pointer('click', [50, 120], bottom()), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'dimension', from: [5, 3, 3], to: [5, 3, -3] })
    await settled()
    expect(said.at(-1)).toBe('M1 | 6 mm between planes')
    expect(drafts.at(-1)).toBeNull()
    // It stays while the pointer rests there, and makes way when it moves on.
    tool.onPointer(pointer('move', [50, 121], bottom()), ctx)
    expect(said.at(-1)).toBe('M1 | 6 mm between planes')
    tool.onPointer(pointer('move', [90, 160], bottom()), ctx)
    expect(said.at(-1)).toBe('plate/F0 | ')
  })

  it('when the kernel refuses the measurement there is no dimension, and its reason is read out for four seconds', async () => {
    vi.useFakeTimers()
    const tool = measureTool()
    const reason = 'angle is measured between two planar faces, two straight edges, or a planar face and a straight edge; plate/F9 is a cylinder face'
    const { ctx, said, drafts } = fake({ commit: () => Promise.reject(new Error(reason)) })
    setBetween('angle')
    tool.onPointer(pointer('click', [50, 50], top()), ctx)
    tool.onPointer(pointer('click', [50, 120], hole()), ctx)
    await vi.advanceTimersByTimeAsync(10)
    expect(said.at(-1)).toBe(reason)
    expect(drafts.at(-1)).toBeNull()
    // Moving the pointer does not wipe it.
    tool.onPointer(pointer('move', [300, 300], top()), ctx)
    expect(said.at(-1)).toBe(reason)
    await vi.advanceTimersByTimeAsync(REFUSAL_MS)
    expect(said.at(-1)).toBe('(hidden)')
    tool.onPointer(pointer('move', [301, 300], top()), ctx)
    expect(said.at(-1)).toBe('plate/F5 | ')
  })

  it('is given nothing while the parts on screen are stale, and T does nothing then', async () => {
    const tool = measureTool()
    const { ctx, committed, said } = fake({ stale: 'Rebuilding: picks wait for the new build' })
    routePointer(tool, pointer('click', [50, 50], top()), ctx)
    routePointer(tool, pointer('click', [50, 120], bottom()), ctx)
    await settled()
    expect(committed).toEqual([])
    expect(said.at(-1)).toBe('Rebuilding: picks wait for the new build')
    expect(tool.onKey!(key('t'), ctx)).toBe(false)
  })

  it('is one of the tools, on M', () => {
    expect(toolStore.getState()).toMatchObject({ between: 'distance', round: 'diameter' })
  })
})

import { describe, expect, it } from 'vitest'
import type { Described } from '../../shared/geometry'
import type { Mark, NewMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { MAX_POINTS, drawTool } from './drawTool'
import { fromPlane, toPlane, viewPlane } from './planes'
import { simplify } from './simplify'
import { routePointer, type ToolContext } from './Tool'

// From the front: the camera is on -Y and looks along +Y. A pixel is a millimetre.
const FRONT: Camera = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 }
const FACE: Described = { kind: 'face', ref: 'assembly:base/F5', type: 'plane', area: 1200, center: [0, 0, 2.5], normal: [0, 0, 1], radius: null, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }
const BOUNDS = { min: [-20, -15, -2.5] as Vec3, max: [20, 15, 22.5] as Vec3 }

function hitAt(point: Vec3): Hit {
  return { partKey: 'assembly:base', part: 'base', kind: 'face', index: 5, ref: 'base/F5', point, normal: [0, 0, 1], distance: 100 }
}

/** A pointer event from the front: the ray looks along +Y through (x, z), and the client pixel is (x, -z). */
function pointer(type: ViewportPointer['type'], x: number, z: number, hit: Hit | null = null): ViewportPointer {
  return { type, hit, ray: { origin: [x, -100, z], direction: [0, 1, 0] }, client: [x, -z], buttons: type === 'up' || type === 'click' ? 0 : 1, shift: false }
}

function fake(opts: { locked?: 'front' | null; pick?: (x: number, y: number) => Hit | null; stale?: string } = {}) {
  const committed: NewMark[] = []
  const noted: string[] = []
  const drafts: unknown[] = []
  const navigation: unknown[][] = []
  const said: string[] = []
  const ctx: ToolContext = {
    viewport: {
      setHover: () => {},
      setNavigation: (...args) => void navigation.push(args),
      setDraft: (d) => void drafts.push(d),
      lockedView: () => opts.locked ?? null,
      pick: (x, y) => opts.pick?.(x, y) ?? null,
      bounds: () => BOUNDS
    },
    readout: { show: (_at, ref, detail) => void said.push(`${ref} | ${detail ?? ''}`), describe: () => {}, say: (_at, message) => void said.push(message), hide: () => {} },
    objectId: 'bracket',
    layout: 'assembly',
    revision: 7,
    camera: FRONT,
    stale: opts.stale ?? null,
    descriptor: () => undefined,
    describe: async () => FACE,
    commit: async (mark) => {
      committed.push(mark)
      return { ...mark, id: `M${committed.length}`, status: 'draft', anchorState: 'ok', createdAt: '2026-10-09T00:00:00.000Z' } as Mark
    },
    openNote: (mark) => void noted.push(mark.id)
  }
  return { ctx, committed, noted, drafts, navigation, said }
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('simplify', () => {
  it('keeps the ends and removes the points on the line between them', () => {
    expect(simplify<[number, number]>([[0, 0], [1, 0], [2, 0.05], [3, 0], [10, 0]], 0.2, 400)).toEqual([[0, 0], [10, 0]])
  })

  it('keeps a point that is further off the line than the tolerance', () => {
    expect(simplify<[number, number]>([[0, 0], [5, 0.1], [5, 3], [7, 3.1], [10, 3]], 0.2, 400)).toEqual([[0, 0], [5, 0.1], [5, 3], [10, 3]])
  })

  it('works on points in space', () => {
    const points: Vec3[] = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [2, 2, 8], [2, 2, 9]]
    expect(simplify(points, 0.2, 400)).toEqual([[0, 0, 0], [2, 2, 2], [2, 2, 9]])
  })

  it('never gives more than the most asked for, and still keeps the ends', () => {
    // A zigzag: no point of it is within the tolerance of its neighbours' line.
    const points = Array.from({ length: 3000 }, (_, i): [number, number] => [i, i % 2 === 0 ? 0 : 5])
    const kept = simplify(points, 0.2, 400)
    expect(kept.length).toBeLessThanOrEqual(400)
    expect(kept.length).toBeGreaterThan(300)
    expect(kept[0]).toEqual([0, 0])
    expect(kept.at(-1)).toEqual([2999, 5])
    // Thinned evenly: in the order drawn, with no long gap.
    const xs = kept.map((p) => p[0])
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(Math.max(...xs.slice(1).map((x, i) => x - xs[i]))).toBeLessThanOrEqual(9)
  })

  it('leaves one point, or two, or a closed loop, as they are', () => {
    expect(simplify<[number, number]>([[1, 2]], 0.2, 400)).toEqual([[1, 2]])
    expect(simplify<[number, number]>([[1, 2], [1, 2]], 0.2, 400)).toEqual([[1, 2], [1, 2]])
    expect(simplify<[number, number]>([[0, 0], [10, 0], [10, 10], [0, 0]], 0.2, 400)).toEqual([[0, 0], [10, 0], [10, 10], [0, 0]])
  })
})

describe('viewPlane', () => {
  it('names the plane of the front view through a point: XZ at its y', () => {
    const plane = viewPlane({ ...FRONT, position: [0, -100, 0], target: [0, 0, 0] }, [0, 40, 0])
    expect(plane).toEqual({ origin: [0, 40, 0], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 40.0' })
  })

  it('has the view’s right and up as its axes, whichever way the view looks', () => {
    // From the right: looking along -X, +Y is to the right.
    expect(viewPlane({ ...FRONT, position: [100, 0, 0] }, [12.34, 0, 5])).toEqual({ origin: [12.34, 0, 5], x: [0, 1, 0], y: [0, 0, 1], label: 'YZ at x = 12.3' })
    // From above, +Y up on screen. The viewport leans this camera by a hair: the axes come out exact all the same.
    expect(viewPlane({ ...FRONT, position: [0, -0.001, 100], up: [0, 1, 0.00001] }, [1, 2, -0.04])).toEqual({ origin: [1, 2, -0.04], x: [1, 0, 0], y: [0, 1, 0], label: 'XY at z = 0.0' })
    // From the back: +X runs to the left, and the plane says so in its x.
    expect(viewPlane({ ...FRONT, position: [0, 100, 0] }, [0, 0, 0])).toMatchObject({ x: [-1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 0.0' })
  })

  it('is only "view plane" when the view is more than half a degree off every axis', () => {
    const off = Math.tan((0.6 * Math.PI) / 180) * 100
    const plane = viewPlane({ ...FRONT, position: [off, -100, 0] }, [0, 40, 0])
    expect(plane.label).toBe('view plane')
    expect(Math.hypot(...plane.x)).toBeCloseTo(1, 9)
    expect(plane.y).toEqual([0, 0, 1])
    const near = Math.tan((0.4 * Math.PI) / 180) * 100
    expect(viewPlane({ ...FRONT, position: [near, -100, 0] }, [0, 40, 0]).label).toBe('XZ at y = 40.0')
  })

  it('takes points to its own two axes and back', () => {
    const plane = viewPlane({ ...FRONT, position: [60, -80, 50] }, [3, 4, 5])
    for (const uv of [[0, 0], [12.5, -7], [-30, 41.25]] as [number, number][]) {
      const back = toPlane(plane, fromPlane(plane, uv))
      expect(back[0]).toBeCloseTo(uv[0], 9)
      expect(back[1]).toBeCloseTo(uv[1], 9)
    }
    expect(fromPlane(viewPlane(FRONT, [0, 40, 0]), [10, 20])).toEqual([10, 40, 20])
    expect(toPlane(viewPlane(FRONT, [0, 40, 0]), [10, 40, 20])).toEqual([10, 20])
  })
})

describe('the draw tool', () => {
  it('on a locked view, draws on the view plane through the middle of the scene when it starts beside the parts', async () => {
    const { ctx, committed, noted, navigation, drafts, said } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 30, 5), ctx)
    // The camera is not turned by this drag, and the wheel still zooms.
    expect(navigation).toEqual([[false, { wheel: true }]])
    routePointer(tool, pointer('move', 40, 15), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'stroke', points: [[30, 0, 5], [40, 0, 15]] })
    // The plane, and how large the drawing is on it.
    expect(said.at(-1)).toBe('XZ at y = 0.0 | 10.0 × 10.0 mm')
    routePointer(tool, pointer('move', 30, 20), ctx)
    routePointer(tool, pointer('up', 40, 25), ctx)
    expect(navigation.at(-1)).toEqual([true])
    await settled()
    expect(committed).toEqual([
      {
        kind: 'stroke',
        space: 'plane',
        author: 'user',
        note: '',
        layout: 'assembly',
        revision: 7,
        camera: FRONT,
        anchor: { point: [30, 0, 5] },
        plane: { origin: [0, 0, 10], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 0.0' },
        points2d: [[30, -5], [40, 5], [30, 10], [40, 15]]
      }
    ])
    expect(noted).toEqual(['M1'])
    expect(drafts.at(-1)).toBeNull()
  })

  it('on a locked view, the plane goes through the point of the part the stroke starts on', async () => {
    const { ctx, committed } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 10, 2.5, hitAt([10, -15, 2.5])), ctx)
    routePointer(tool, pointer('move', 10, 12.5), ctx)
    routePointer(tool, pointer('up', 25, 12.5), ctx)
    await settled()
    expect(committed[0]).toMatchObject({
      kind: 'stroke',
      space: 'plane',
      anchor: { point: [10, -15, 2.5], part: 'base', ref: 'base/F5', descriptor: FACE.descriptor },
      plane: { origin: [10, -15, 2.5], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = -15.0' },
      points2d: [[0, 0], [0, 10], [15, 10]]
    })
  })

  it('on a free view, draws on the surface: each sample is where the pointer is on a part, and those beside the parts are left out', async () => {
    // The part is under the pointer for x up to 20.
    const pick = (x: number, y: number): Hit | null => (x <= 20 ? hitAt([x, -15, -y]) : null)
    const { ctx, committed, noted, navigation, drafts } = fake({ pick })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0, hitAt([0, -15, 0])), ctx)
    expect(navigation).toEqual([[false, { wheel: true }]])
    routePointer(tool, pointer('move', 10, 10), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'stroke', points: [[0, -15, 0], [10, -15, 10]] })
    routePointer(tool, pointer('move', 30, 10), ctx)
    routePointer(tool, pointer('move', 20, 0), ctx)
    routePointer(tool, pointer('up', 20, -8), ctx)
    await settled()
    expect(committed).toEqual([
      {
        kind: 'stroke',
        space: 'surface',
        author: 'user',
        note: '',
        layout: 'assembly',
        revision: 7,
        camera: FRONT,
        anchor: { point: [0, -15, 0], normal: [0, 0, 1], part: 'base', ref: 'base/F5', descriptor: FACE.descriptor },
        points: [[0, -15, 0], [10, -15, 10], [20, -15, 0], [20, -15, -8]]
      }
    ])
    expect(noted).toEqual(['M1'])
  })

  it('on a free view, a press beside the parts is not a stroke: that drag turns the camera', async () => {
    const { ctx, committed, navigation, drafts } = fake()
    const tool = drawTool()
    routePointer(tool, pointer('down', 90, 90), ctx)
    routePointer(tool, pointer('move', 60, 60), ctx)
    routePointer(tool, pointer('up', 60, 60), ctx)
    await settled()
    expect(navigation).toEqual([])
    expect(drafts.filter(Boolean)).toEqual([])
    expect(committed).toEqual([])
  })

  it('samples every 3 px the pointer travels', () => {
    const { ctx, drafts } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0), ctx)
    for (let x = 1; x <= 7; x++) routePointer(tool, pointer('move', x, 0), ctx)
    expect(drafts.at(-1)).toEqual({ kind: 'stroke', points: [[0, 0, 0], [3, 0, 0], [6, 0, 0]] })
  })

  it('simplifies a stroke of thousands of points to 400 at most, keeping its ends', async () => {
    const { ctx, committed } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0), ctx)
    // A zigzag 4 mm high, a sample every 4 px.
    for (let i = 1; i < 3000; i++) routePointer(tool, pointer('move', i * 3, i % 2 === 0 ? 0 : 4), ctx)
    routePointer(tool, pointer('up', 9000, 0), ctx)
    await settled()
    const mark = committed[0]
    if (mark?.kind !== 'stroke') throw new Error('no stroke')
    expect(MAX_POINTS).toBe(400)
    expect(mark.points2d!.length).toBeLessThanOrEqual(400)
    expect(mark.points2d!.length).toBeGreaterThan(300)
    expect(mark.points2d![0]).toEqual([0, -10])
    expect(mark.points2d!.at(-1)).toEqual([9000, -10])
  })

  it('drops the points that say nothing: a straight drag of many samples is two points', async () => {
    const { ctx, committed } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0), ctx)
    for (let x = 3; x <= 60; x += 3) routePointer(tool, pointer('move', x, 0.1), ctx)
    routePointer(tool, pointer('up', 60, 0), ctx)
    await settled()
    expect(committed[0]).toMatchObject({ points2d: [[0, -10], [60, -10]] })
  })

  it('cancels a stroke of fewer than two points', async () => {
    const { ctx, committed, noted, navigation, drafts } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 5, 5), ctx)
    routePointer(tool, pointer('move', 6, 5), ctx)
    routePointer(tool, pointer('up', 6, 6), ctx)
    routePointer(tool, pointer('click', 6, 6), ctx)
    await settled()
    expect(committed).toEqual([])
    expect(noted).toEqual([])
    expect(navigation.at(-1)).toEqual([true])
    expect(drafts.at(-1)).toBeNull()
  })

  it('Escape drops the stroke, and is not used otherwise', async () => {
    const { ctx, committed, navigation, drafts } = fake({ locked: 'front' })
    const tool = drawTool()
    const escape = { key: 'Escape' } as KeyboardEvent
    expect(tool.onKey!(escape, ctx)).toBe(false)
    routePointer(tool, pointer('down', 0, 0), ctx)
    routePointer(tool, pointer('move', 12, 5), ctx)
    expect(tool.onKey!(escape, ctx)).toBe(true)
    expect(navigation.at(-1)).toEqual([true])
    expect(drafts.at(-1)).toBeNull()
    routePointer(tool, pointer('up', 30, 40), ctx)
    await settled()
    expect(committed).toEqual([])
  })

  it('drops the stroke when the pointer is taken away, and when the tool is put down', async () => {
    for (const end of ['cancel', 'put down'] as const) {
      const { ctx, committed, navigation, drafts } = fake({ locked: 'front' })
      const tool = drawTool()
      routePointer(tool, pointer('down', 0, 0), ctx)
      routePointer(tool, pointer('move', 12, 5), ctx)
      if (end === 'cancel') routePointer(tool, pointer('cancel', 12, 5), ctx)
      else tool.cancel(ctx)
      expect(navigation.at(-1)).toEqual([true])
      expect(drafts.at(-1)).toBeNull()
      routePointer(tool, pointer('up', 30, 40), ctx)
      await settled()
      expect(committed).toEqual([])
    }
  })

  it('drops the stroke when a move comes with no button held: a release was missed', async () => {
    const { ctx, committed, navigation, drafts } = fake({ locked: 'front' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0), ctx)
    routePointer(tool, pointer('move', 12, 5), ctx)
    routePointer(tool, { ...pointer('move', 20, 5), buttons: 0 }, ctx)
    expect(navigation.at(-1)).toEqual([true])
    expect(drafts.at(-1)).toBeNull()
    routePointer(tool, pointer('up', 30, 40), ctx)
    await settled()
    expect(committed).toEqual([])
  })

  it('draws nothing on a stale build', async () => {
    const { ctx, committed, navigation } = fake({ locked: 'front', stale: 'Rebuilding: picks wait for the new build' })
    const tool = drawTool()
    routePointer(tool, pointer('down', 0, 0), ctx)
    routePointer(tool, pointer('move', 12, 5), ctx)
    routePointer(tool, pointer('up', 30, 40), ctx)
    await settled()
    expect(committed).toEqual([])
    expect(navigation).toEqual([])
  })
})

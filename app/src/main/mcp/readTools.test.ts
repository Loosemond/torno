import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Described, SectionLoop, Sectioned } from '../../shared/geometry'
import type { Mark, NewMark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, LookRequest, SectionDrawingRequest, ShowRequest, ViewState } from '../../shared/view'
import { KernelError } from '../kernel/client'
import { addMarkTool } from './markTools'
import { MAX_SECTION_POINTS, checkTool, measureTool, sectionTool, thinned } from './readTools'
import { type ToolDeps, type ToolResult, describeTool, lookTool, sceneTool, showTool, TOOLS } from './tools'

// The tools the agent reads the part with, against stand-ins for the kernel,
// the marks and the window: what is asked of each is kept, and what the
// kernel says is whatever the test gives it to say.

const part = (layout: string, name: string, more: Partial<Part> = {}): Part =>
  ({ key: `${layout}:${name}`, name, layout, bbox: { min: [-20, -15, -3], max: [20, 15, 3] }, volume: 6000, faceCount: 12, edgeCount: 30, valid: true, ...more }) as Part
const SCENE: Scene = { model: 'box.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'tub'), part('assembly', 'lid'), part('print', 'tub'), part('print', 'lid')], seconds: 1, output: '' }
/** The same, with the parts of the print layout spread: they overlapped as the model placed them, and torno moved the lid 45 mm along X. */
const SPREAD: Scene = { ...SCENE, parts: [part('assembly', 'tub'), part('assembly', 'lid'), part('print', 'tub'), part('print', 'lid', { arranged: [45, 0, 0] })] }
const spread = (says?: Parameters<typeof fake>[0], scene: Scene = SPREAD): Fake => fake(says, { scene: () => ({ revision: 4, scene }) })
const MOVED = 'lid was moved by torno for display in layout print: these coordinates are in the displayed frame; subtract arranged for the model’s own.'
const SPREAD_NOTE = 'The parts of the print layout overlapped as the model placed them, so they were spread along X for display; arranged is how far each was moved.'
const CAMERA: Camera = { position: [100, -80, 60], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const VIEW: ViewState = { objectId: 'box', layout: 'assembly', camera: CAMERA, visible: ['assembly:tub', 'assembly:lid'] }
const OK: BuildState = { objectId: 'box', status: 'ok', revision: 4, seconds: 1, stale: false }
const MARK = { author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 4, camera: CAMERA, createdAt: '2026-10-09T12:00:00.000Z', checkedRevision: 4 } as const
const MARKS: Mark[] = [
  { ...MARK, id: 'M1', kind: 'pin', anchor: { point: [10, 5, 3], part: 'tub', ref: 'tub/F5', descriptor: 'plane, normal +Z, z = 3, 1200 mm²' } },
  { ...MARK, id: 'M2', kind: 'pin', anchorState: 'drifted', anchor: { point: [0, 0, 3], part: 'tub', ref: 'tub/F5' } },
  { ...MARK, id: 'M3', kind: 'pin', anchor: { point: [50, 50, 50] } },
  { ...MARK, id: 'M4', kind: 'pin', checkedRevision: 3, anchor: { point: [0, 0, 3], part: 'tub', ref: 'tub/F5' } },
  { ...MARK, id: 'M5', kind: 'pin', anchorState: 'orphaned', anchor: { point: [0, 0, 3], part: 'cap', ref: 'cap/F1' } },
  { ...MARK, id: 'M6', kind: 'pin', layout: 'print', anchor: { point: [0, 0, 3], part: 'tub', ref: 'tub/F5' } },
  { ...MARK, id: 'M7', kind: 'pin', status: 'resolved', anchor: { point: [0, 0, 3], part: 'tub', ref: 'tub/F5' } }
]
const FACE: Described = { kind: 'face', ref: 'assembly:tub/F5', type: 'plane', area: 1200, center: [0, 0, 3], normal: [0, 0, 1], radius: null, descriptor: 'plane, normal +Z, z = 3, 1200 mm²' }

const square = (side: number, at = 0): [number, number][] => [[at, at], [at + side, at], [at + side, at + side], [at, at + side]]
const loop = (points: [number, number][], area: number, more: Partial<SectionLoop> = {}): SectionLoop => ({ points, closed: true, area, areaExact: true, deflection: 0.05, ...more })
const CUT: Sectioned = {
  plane: { origin: [0, 0, 3], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
  parts: [{ part: 'tub', loops: [loop(square(40), 1600), loop(square(10, 5).reverse() as [number, number][], -100)], area: 1500, areaExact: true, open: 0, how: 'cross-section of the solid' }],
  bounds: { min: [0, 0], max: [40, 40] }
}

interface Fake extends ToolDeps {
  queries: Array<{ name: string; args: unknown }>
  drawings: SectionDrawingRequest[]
  added: NewMark[]
  looks: LookRequest[]
  shows: ShowRequest[]
}

/** `says` is what the kernel answers each query with: a reply, or an error to reject with. */
function fake(says: (name: string, args: never) => unknown = () => ({}), over: Partial<ToolDeps> & { state?: BuildState } = {}): Fake {
  const made: Fake = {
    queries: [],
    drawings: [],
    added: [],
    looks: [],
    shows: [],
    object: (id) => (id === 'box' ? { id, name: id, dir: '/ws/box', model: 'box.py' } : undefined),
    build: (id) => (id === 'box' ? (over.state ?? OK) : undefined),
    scene: (id) => (id === 'box' ? { revision: (over.state ?? OK).revision, scene: SCENE } : undefined),
    view: (id) => (id === 'box' ? VIEW : undefined),
    openObjectId: () => 'box',
    look: async (objectId, req) => {
      made.looks.push(req)
      return { png: new Uint8Array([1]), width: 4, height: 3, caption: 'view current', objectId, revision: 4, stale: false }
    },
    saveImage: async (objectId) => `/ws/${objectId}/.torno/views/1.png`,
    marks: async () => MARKS,
    addMark: async () => Promise.reject(new Error('not expected')),
    addDimension: async (_objectId, mark) => {
      made.added.push(mark)
      const expected = (mark as { expected?: number }).expected
      const measured = { value: 6, how: 'between planes', measuredRevision: 4, ...(expected === undefined ? {} : { verdict: expected === 6 ? 'pass' : 'fail' }) }
      return { mark: { ...mark, ...measured, id: 'M9', status: 'sent', anchorState: 'ok', createdAt: MARK.createdAt } as Mark }
    },
    updateMark: async () => Promise.reject(new Error('not expected')),
    describe: async (_objectId, layout, ref) => ({ ...FACE, ref: `${layout}:${ref}` }),
    // Every point asked about is on the face its test says, tub/F5 unless it says another.
    nearest: async (_objectId, _layout, anchors) => anchors.map(({ part: name, point }) => ({ part: name, found: true, point, normal: [0, 0, 1], ref: `${name}/F5`, distance: 0, descriptor: FACE.descriptor, support: 'face' })) as never,
    show: async (objectId, req) => {
      made.shows.push(req)
      return { caption: 'view current · layout assembly', objectId, revision: 4, stale: false }
    },
    highlight: async () => Promise.reject(new Error('not expected')),
    query: async <T,>(_objectId: string, name: string, args: object): Promise<T> => {
      made.queries.push({ name, args })
      const said = says(name, args as never)
      if (said instanceof Error) throw said
      return said as T
    },
    sectionDrawing: async (req) => {
      made.drawings.push(req)
      return { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 1280, height: 1150, colours: 'window', vDown: false }
    },
    scans: async () => [],
    scansBusy: () => [],
    scanPaths: (_objectId, id) => ({ mesh: `/ws/box/.torno/scans/${id}/mesh.bin`, mask: (mark) => `/ws/box/.torno/scans/${id}/${mark}.mask` }),
    ...over
  }
  return made
}

/** A scan aligned in the assembly layout by hand (typed values), as main would tell it; `more` is laid over its alignment there. */
// Alignments as main keeps them (Task 5's fix round 2, m8): a doubtful fit is a fit of pairs, and only one tied to the model can be found off it.
const tiedPair = (n: number) => ({ scan: [n, n % 2, 0], model: [n, n % 2, 10], part: 'tub', residual: 0 })
const TWO_PAIRS = { steps: ['pairs'], pairs: [0, 1].map(tiedPair), rms: 0, fitRms: 0, rough: 'it has 2 pairs of points: it takes three that are not in a line to fix a scan' }
const FOUR_PAIRS = { steps: ['pairs'], pairs: [0, 1, 2, 3].map(tiedPair), rms: 0, fitRms: 0 }
const scanned = (more: object = {}, scan: object = {}) => ({
  scans: async () => [{ id: 'S1', name: 'Micra.glb', alignments: { assembly: { transform: { t: [0, 0, 10], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '', ...more } }, meshState: 'ok', checks: { assembly: { revision: 4, of: 0, off: 0, worst: 0, moved: [] } }, ...scan }] as never
})
const OUTLINE = { scan: 'S1', plane: CUT.plane, polylines: [{ points: [[-5, 2], [20, 2], [45, 3]], closed: false }], omitted: 0, segments: 2, pointsFound: 3, pointsTold: 3, thinned: false, bounds: { min: [-5, 2], max: [45, 3] }, exact: false }

const text = (result: ToolResult): string => result.content.find((block) => block.type === 'text')!.text as string
const data = (result: ToolResult): Record<string, never> => JSON.parse(text(result))
const refused = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

describe('the descriptions of the tools that read the part', () => {
  it('say what is returned, in what units, when to use each, and that values are exact unless the reply says approximate', () => {
    for (const tool of [TOOLS.measure, TOOLS.check]) expect(tool.description).toMatch(/exact, from the B-rep, unless the reply .* approximate/)
    expect(TOOLS.measure.description).toContain('mm, degrees, mm², mm³ and grams')
    expect(TOOLS.section.description).toContain('an answer holds at most 1,500 points in all')
    expect(TOOLS.add_mark.description).toContain('becomes a pinned check the user sees')
  })
})

describe('measure', () => {
  const planes = { kind: 'distance', value: 6, unit: 'mm', how: 'between planes', points: [[0, 0, 3], [0, 0, -3]], exact: true }

  it('asks the kernel with the layout in front of each ref, and answers with its reply, the revision and a reading', async () => {
    const deps = fake(() => planes)
    const result = await measureTool(deps, 'box', { kind: 'distance', a: 'tub/F5', b: 'tub/F0' })
    expect(result.isError).toBeUndefined()
    expect(deps.queries).toEqual([{ name: 'measure', args: { kind: 'distance', a: { ref: 'assembly:tub/F5' }, b: { ref: 'assembly:tub/F0' } } }])
    expect(data(result)).toEqual({ layout: 'assembly', revision: 4, ...planes, reading: '6 mm between planes, tub/F5 to tub/F0' })
  })

  it('reads a diameter, a radius of a torus, an angle, and a wall with the point it was moved to', async () => {
    const reading = async (said: object, args: Parameters<typeof measureTool>[2]): Promise<string> => data(await measureTool(fake(() => said), 'box', args)).reading
    expect(await reading({ kind: 'diameter', value: 8, unit: 'mm', how: 'cylinder', exact: true }, { kind: 'diameter', a: 'tub/F9' })).toBe('⌀ 8 mm, tub/F9')
    expect(await reading({ kind: 'radius', value: 2, unit: 'mm', how: 'tube of a torus', major: 10, exact: true }, { kind: 'radius', a: 'tub/F9' })).toBe('R 2 mm (tube of a torus), tub/F9')
    expect(await reading({ kind: 'angle', value: 45, unit: 'deg', how: 'between normals', exact: true }, { kind: 'angle', a: 'tub/F5', b: 'tub/F1' })).toBe('45° between normals, tub/F5 to tub/F1')
    const wall = { kind: 'thickness', value: 2, unit: 'mm', how: 'wall, along the normal', points: [[10, 5, -1], [10, 5, -3]], moved: 0.12, exact: true }
    expect(await reading(wall, { kind: 'thickness', a: { ref: 'tub/F5', point: [10, 5, -0.88] } })).toBe('2 mm wall, along the normal, tub/F5 at (10, 5, -1) (the point was moved 0.12 mm onto the face)')
    expect(await reading({ ...wall, moved: 0 }, { kind: 'thickness', a: { ref: 'tub/F5', point: [10, 5, -1] } })).toBe('2 mm wall, along the normal, tub/F5 at (10, 5, -1)')
  })

  it('reads a box, a volume, an area and a mass, with the density the kernel used', async () => {
    const reading = async (said: object, kind: 'bbox' | 'volume' | 'area' | 'mass', density?: number): Promise<string> => data(await measureTool(fake(() => said), 'box', { kind, a: 'tub', ...(density ? { density } : {}) })).reading
    expect(await reading({ kind: 'bbox', min: [-20, -15, -3], max: [20, 15, 3], size: [40, 30, 6], unit: 'mm', how: 'axis-aligned box', exact: true }, 'bbox')).toBe('bbox 40 × 30 × 6 mm, from (-20, -15, -3) to (20, 15, 3), axis-aligned box, tub')
    expect(await reading({ kind: 'volume', value: 7039.47, unit: 'mm3', how: 'of the solid', exact: true }, 'volume')).toBe('volume 7039 mm³ of the solid, tub')
    expect(await reading({ kind: 'area', value: 3100, unit: 'mm2', how: 'surface of the part', exact: true }, 'area')).toBe('area 3100 mm² surface of the part, tub')
    expect(await reading({ kind: 'mass', value: 8.729, unit: 'g', how: 'PLA 1.24 g/cm³ (default)', density: 1.24, volume: 7039.47, exact: true }, 'mass')).toBe('mass 8.729 g, PLA 1.24 g/cm³ (default), tub (volume 7039 mm³)')
    const deps = fake(() => ({ kind: 'mass', value: 19, unit: 'g', how: 'at 2.7 g/cm³', density: 2.7, volume: 7039.47, exact: true }))
    await measureTool(deps, 'box', { kind: 'mass', a: 'tub', density: 2.7 })
    expect(deps.queries[0].args).toEqual({ kind: 'mass', a: { ref: 'assembly:tub' }, density: 2.7 })
  })

  it('never says a value is exact that the kernel does not: ≈ and approximate, and exact, how and moved are passed through', async () => {
    const freeform = { kind: 'area', value: 512.34, unit: 'mm2', how: 'of the face', exact: false }
    const result = data(await measureTool(fake(() => freeform), 'box', { kind: 'area', a: 'tub/F3' }))
    expect(result).toMatchObject({ exact: false, how: 'of the face', reading: 'area ≈ 512.3 mm² of the face, approximate, tub/F3' })
    const box = { kind: 'bbox', min: [0, 0, 0], max: [1, 2, 3], size: [1, 2, 3], unit: 'mm', how: 'axis-aligned box, approximate: exact only of planes and cylinders', exact: false }
    expect(data(await measureTool(fake(() => box), 'box', { kind: 'bbox', a: 'tub' })).reading).toBe('bbox ≈ 1 × 2 × 3 mm, from (0, 0, 0) to (1, 2, 3), axis-aligned box, approximate: exact only of planes and cylinders, tub')
    // A reply that does not say is not taken for exact.
    expect(data(await measureTool(fake(() => ({ kind: 'distance', value: 6, unit: 'mm', how: 'minimum' })), 'box', { kind: 'distance', a: 'tub', b: 'lid' })).reading).toBe('≈ 6 mm minimum, approximate, tub to lid')
  })

  it('takes a mark for what it is on, a point for a point, and a ref with a point for the feature at that point', async () => {
    const deps = fake(() => ({ kind: 'distance', value: 2, unit: 'mm', how: 'point to plane', exact: true }))
    const result = await measureTool(deps, 'box', { kind: 'distance', a: 'M1', b: { point: [10, 5, 5] } })
    expect(deps.queries[0].args).toEqual({ kind: 'distance', a: { ref: 'assembly:tub/F5', point: [10, 5, 3] }, b: { layout: 'assembly', point: [10, 5, 5] } })
    expect(data(result).reading).toBe('2 mm point to plane, tub/F5 (M1) to (10, 5, 5)')
    // A mark on no part is its point.
    await measureTool(deps, 'box', { kind: 'distance', a: 'M3', b: { ref: 'lid/F2', point: [1, 2, 3] } })
    expect(deps.queries[1].args).toEqual({ kind: 'distance', a: { layout: 'assembly', point: [50, 50, 50] }, b: { ref: 'assembly:lid/F2', point: [1, 2, 3] } })
  })

  it.each([
    ['M2', 'M2 has moved since it was placed: give a ref'],
    ['M4', 'M4 has not been checked against r4 yet, so what it is on is not known: give a ref, or ask again in a moment'],
    ['M5', 'the part M5 was placed on is gone: give a ref'],
    ['M6', 'M6 is in layout print, not assembly'],
    ['M7', 'M7 is resolved, and is no longer checked against the builds: give a ref'],
    ['M8', 'no mark M8; marks: M1, M2, M3, M4, M5, M6, M7']
  ])('does not measure through %s, whose ref may name something else by now', async (id, message) => {
    const deps = fake()
    expect(await measureTool(deps, 'box', { kind: 'radius', a: id })).toEqual(refused(message))
    expect(deps.queries).toEqual([])
  })

  it('does not measure through a dimension that is itself not measurable, and says why in its words', async () => {
    const off = { ...MARK, id: 'M1', kind: 'dimension', measure: 'distance', anchorState: 'drifted', a: { point: [0, 0, 3], part: 'tub', ref: 'tub/E3', edge: 'tub/E3' }, b: { point: [0, 0, -3], part: 'tub', ref: 'tub/E7', edge: 'tub/E7' }, measuredRevision: 4, refused: 'the edge tub/E3 it was on is not under its end on r4' } as Mark
    const deps = fake(undefined, { marks: async () => [off] })
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'M1', b: 'tub/F0' })).toEqual(refused('M1 is a dimension: name the ref or point of the end you mean'))
    expect(deps.queries).toEqual([])
  })

  it('checks refs against the scene before the kernel is asked, in words that say what there is', async () => {
    const deps = fake()
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'tub/F5', b: 'cap/F1' })).toEqual(refused("no part 'cap' in layout assembly (parts: tub, lid)"))
    expect(await measureTool(deps, 'box', { kind: 'radius', a: 'tub/F12' })).toEqual(refused('tub has 12 faces, F0 to F11: there is no F12'))
    expect(await measureTool(deps, 'box', { kind: 'radius', a: 'tub', layout: 'exploded' })).toEqual(refused("no layout 'exploded'; layouts: assembly, print"))
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'tub/F5' })).toEqual(refused('distance is between two ends: give b'))
    expect(await measureTool(deps, 'box', { kind: 'volume', a: 'tub', b: 'lid' })).toEqual(refused('volume is of a alone: leave b out'))
    const NO_END = (name: string): string => `${name} names nothing: give a ref ("lid/F12"), the number of a mark ("M3"), {"point": [x, y, z]} in mm, or {"ref": "lid/F12", "point": [x, y, z]}`
    expect(await measureTool(deps, 'box', { kind: 'radius', a: {} })).toEqual(refused(NO_END('a')))
    // Whatever was given for an end reaches the tool, which says what an end is.
    for (const a of [undefined, null, 7, [1, 2, 3], { point: [1, 2] }, { ref: 5 }, { point: [1, 2, 'x'] }]) expect(await measureTool(deps, 'box', { kind: 'radius', a: a as never })).toEqual(refused(NO_END('a')))
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'tub/F5', b: { face: 'tub/F0' } as never })).toEqual(refused(NO_END('b')))
    expect(await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'diameter', a: { at: [1, 2, 3] } as never })).toEqual(refused(NO_END('a')))
    // A dimension is between two ends: its number stands for neither.
    const dim: Mark = { ...MARK, id: 'M8', kind: 'dimension', measure: 'distance', a: { point: [0, 0, 3], part: 'tub', ref: 'tub/F5' }, b: { point: [0, 0, -3], part: 'tub', ref: 'tub/F0' } }
    expect(await measureTool(fake(undefined, { marks: async () => [dim] }), 'box', { kind: 'radius', a: 'M8' })).toEqual(refused('M8 is a dimension: name the ref or point of the end you mean'))
    expect(await measureTool(fake(), 'bracket', { kind: 'radius', a: 'tub' })).toEqual(refused('unknown object: bracket'))
    expect(deps.queries).toEqual([])
  })

  it("answers with the kernel's reason when it refuses, without the layout before the refs, and plainly when it does not answer in time", async () => {
    const no = fake(() => new KernelError('bad_request', 'radius is measured of a cylinder, a sphere, a torus or a circle; assembly:tub/F5 is a plane'))
    expect(await measureTool(no, 'box', { kind: 'radius', a: 'tub/F5' })).toEqual(refused('radius is measured of a cylinder, a sphere, a torus or a circle; tub/F5 is a plane'))
    const slow = fake(() => new KernelError('timeout', 'the query took more than 30 s'))
    expect(await measureTool(slow, 'box', { kind: 'radius', a: 'tub/F5' })).toEqual(refused('the kernel did not answer within 30 s; the part may be too large for this measurement'))
    expect(await measureTool(fake(() => ({ kind: 'radius' })), 'box', { kind: 'radius', a: 'tub/F5' })).toEqual(refused('the kernel did not answer with a measurement'))
    // A worker still busy with a query that was given up on answers at once, in the kernel's own words: nothing is said of this part's size.
    const busy = fake(() => new KernelError('timeout', 'the build of /ws/box is still busy with a query it did not answer within 30 s; ask again when it has'))
    expect(await measureTool(busy, 'box', { kind: 'radius', a: 'tub/F5' })).toEqual(refused('the build of /ws/box is still busy with a query it did not answer within 30 s; ask again when it has'))
    expect(await checkTool(busy, 'box', { kind: 'mesh', a: 'lid' })).toEqual(refused('the build of /ws/box is still busy with a query it did not answer within 30 s; ask again when it has'))
  })

  it('reads an area the kernel calls approximate as it says it, with a digit count or with none', async () => {
    const area = (how: string, more: object = {}) => ({ kind: 'area', value: 700.7123, unit: 'mm2', how, exact: false, ...more })
    const reading = async (said: object): Promise<string> => data(await measureTool(fake(() => said), 'box', { kind: 'area', a: 'tub/F5' })).reading
    expect(await reading(area('of the face, approximate, good to about 4 significant digits', { digits: 4 }))).toBe('area ≈ 700.7 mm² of the face, approximate, good to about 4 significant digits, tub/F5')
    expect(await reading(area('of the face, approximate: its integrals differ by 2.1 %', { digits: null }))).toBe('area ≈ 700.7 mm² of the face, approximate: its integrals differ by 2.1 %, tub/F5')
    expect(data(await measureTool(fake(() => area('of the face, approximate: its integrals differ by 2.1 %', { digits: null })), 'box', { kind: 'area', a: 'tub/F5' }))).toMatchObject({ exact: false, digits: null })
  })

  it('reads a wall measured through a mark with the mark, and a box the kernel says nothing of how it took without a stray comma', async () => {
    const wall = { kind: 'thickness', value: 2, unit: 'mm', how: 'wall, along the normal', points: [[10, 5, 3], [10, 5, 1]], moved: 0, exact: true }
    expect(data(await measureTool(fake(() => wall), 'box', { kind: 'thickness', a: 'M1' })).reading).toBe('2 mm wall, along the normal, tub/F5 (M1) at (10, 5, 3)')
    const box = { kind: 'bbox', min: [0, 0, 0], max: [1, 2, 3], size: [1, 2, 3], unit: 'mm', how: '', exact: true }
    expect(data(await measureTool(fake(() => box), 'box', { kind: 'bbox', a: 'tub' })).reading).toBe('bbox 1 × 2 × 3 mm, from (0, 0, 0) to (1, 2, 3), tub')
  })

  it('measures a wall at the centre of the face when no point is given', async () => {
    const deps = fake(() => ({ kind: 'thickness', value: 6, unit: 'mm', how: 'wall, along the normal', points: [[0, 0, 3], [0, 0, -3]], moved: 0, exact: true }))
    expect(data(await measureTool(deps, 'box', { kind: 'thickness', a: 'tub/F5' })).reading).toBe('6 mm wall, along the normal, tub/F5 at (0, 0, 3)')
    expect(deps.queries[0].args).toEqual({ kind: 'thickness', a: { ref: 'assembly:tub/F5', point: [0, 0, 3] } })
  })

  it('takes a point of an aligned scan as an end, and then says nothing is exact', async () => {
    const deps = fake(() => ({ kind: 'distance', value: 12.5, unit: 'mm', how: 'point to plane', points: [[0, 0, 15.5], [0, 0, 3]], exact: true }), scanned())
    const result = await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 15.5] }, b: 'tub/F5' })
    expect(deps.queries[0].args).toEqual({ kind: 'distance', a: { layout: 'assembly', point: [0, 0, 15.5] }, b: { ref: 'assembly:tub/F5' } })
    expect(data(result)).toMatchObject({ exact: false, scan: 'S1', alignment: { state: 'aligned', by: 'by hand (typed values)' }, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact', reading: 'S1 was placed by hand: no fit says how well. ≈ 12.5 mm point to plane, approximate (S1 is a scan), (0, 0, 15.5) given as a point of S1 to tub/F5. S1 is aligned by hand (typed values) (tied to no point of the model: not checked against builds).' })
    expect(text(await measureTool(deps, 'box', { kind: 'angle', a: { scan: 'S1', point: [0, 0, 1] }, b: 'tub/F5' }))).toBe('only a distance is measured to a point of a scan')
    expect(text(await measureTool(fake(), 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: 'tub/F5' }))).toBe('this object has no scans: the user imports one in the Scans panel of the torno window')
    // A way that already says it is approximate is not followed by the word twice.
    const rough = fake(() => ({ kind: 'distance', value: 1, unit: 'mm', how: 'minimum, approximate', exact: false }), scanned(TWO_PAIRS, { checks: { assembly: { revision: 4, of: 2, off: 0, worst: 0, moved: [] } } }))
    expect(data(await measureTool(rough, 'box', { kind: 'distance', a: 'tub/F5', b: { scan: 'S1', point: [0, 0, 1] } })).reading).toBe(
      'S1 is only roughly aligned: it has 2 pairs of points: it takes three that are not in a line to fix a scan. ≈ 1 mm minimum, approximate (S1 is a scan), tub/F5 to (0, 0, 1) given as a point of S1. S1 is aligned by 2 pairs (RMS 0 mm, worst 0 mm): that RMS is of the clicked points, and says nothing of how true the scan is.'
    )
  })

  it('takes a region of a scan for its centroid, where the scan stands in the layout', async () => {
    const region = { ...MARK, id: 'M8', kind: 'region', scan: 'S1', note: 'loom', local: { centroid: [1, 2, 3] } } as unknown as Mark
    const deps = fake(() => ({ kind: 'distance', value: 4, unit: 'mm', how: 'point to plane', exact: true }), { ...scanned(), marks: async () => [...MARKS, region] })
    const said = data(await measureTool(deps, 'box', { kind: 'distance', a: 'M8', b: 'tub/F5' }))
    expect(deps.queries[0].args).toMatchObject({ a: { layout: 'assembly', point: [1, 2, 13] } })
    expect(said.reading).toBe('S1 was placed by hand: no fit says how well. ≈ 4 mm point to plane, approximate (S1 is a scan), the centroid of region M8 (S1) at (1, 2, 13) to tub/F5. S1 is aligned by hand (typed values) (tied to no point of the model: not checked against builds).')
    expect(text(await measureTool(deps, 'box', { kind: 'radius', a: 'M8' }))).toBe('only a distance is measured to a point of a scan')
  })

  it('says of two points of two scans what puts either alignment in doubt, and how both are aligned', async () => {
    const two = { scans: async () => ['S1', 'S2'].map((id) => ({ id, name: `${id}.glb`, alignments: { assembly: { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], pairs: [1, 2, 3].map((n) => ({ scan: [n, 0, 0], model: [n, 0, 0], residual: 1 })), rms: 1, frame: {}, at: '', ...(id === 'S2' ? { rough: 'its pairs of points are in a line: how it is turned about that line is not fixed' } : {}) } }, meshState: 'ok', checks: {} })) as never }
    const deps = fake(() => ({ kind: 'distance', value: 5, unit: 'mm', how: 'between points', exact: true }), two)
    const said = data(await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: { scan: 'S2', point: [0, 0, 6] } })) as any
    expect(said).toMatchObject({ exact: false, scan: 'S1', other: { scan: 'S2', alignment: { state: 'aligned', rough: expect.any(String) } } })
    expect(said.reading).toMatch(/S2 is only roughly aligned: its pairs of points are in a line.*\. ≈ 5 mm between points, approximate \(S1 and S2 are scans\), \(0, 0, 1\) given as a point of S1 to \(0, 0, 6\) given as a point of S2\. S1 is aligned by 3 pairs .*\. S2 is aligned by 3 pairs/)
  })

  it('refuses a scan end where the scan is not aligned, against a part torno moved, and what is no such end', async () => {
    const deps = fake(undefined, scanned())
    expect(text(await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: 'tub/F5', layout: 'print' }))).toBe(
      'S1 is not aligned in layout print (it is aligned in: assembly), so nothing is checked against it there: the user aligns it in print with the Align tool (an alignment is of one layout), or ask in assembly'
    )
    const END = 'a names nothing: a point of a scan is {"scan": "S1", "point": [x, y, z]}, in mm in the frame of the layout'
    expect(text(await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1' } as never, b: 'tub/F5' }))).toBe(END)
    expect(text(await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1', point: [1, 2] } as never, b: 'tub/F5' }))).toBe(END)
    expect(text(await measureTool(deps, 'box', { kind: 'distance', a: { scan: 7, point: [1, 2, 3] } as never, b: 'tub/F5' }))).toBe(END)
    const moved = fake(undefined, { ...scanned(), scene: () => ({ revision: 4, scene: SPREAD }), scans: async () => [{ id: 'S1', name: 'Micra.glb', alignments: { print: { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '' } }, meshState: 'ok', checks: {} }] as never })
    expect(text(await measureTool(moved, 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: 'lid/F5', layout: 'print' }))).toMatch(/^In layout print torno moved lid for display \(the parts overlapped as the model placed them\), so where the scan is against it there is torno's, not the model's\./)
    expect(deps.queries).toEqual([])
    expect(moved.queries).toEqual([])
  })

  it('carries the stale note while a newer build runs or has failed', async () => {
    const deps = fake(() => ({ kind: 'diameter', value: 8, unit: 'mm', how: 'cylinder', exact: true }), { state: { ...OK, status: 'failed', stale: true } })
    expect(data(await measureTool(deps, 'box', { kind: 'diameter', a: 'tub/F9' }))).toMatchObject({
      revision: 4,
      stale: 'the latest build failed, so this is still what is known of r4: refs and descriptors may not hold for the model as it now is'
    })
  })

  it('asks again, once, when another build lands while the kernel is asked, and says so when it happens twice', async () => {
    let revision = 4
    const landing = (times: number): Fake => {
      revision = 4
      const deps: Fake = fake(() => ((deps.queries.length <= times ? (revision += 1) : 0), { kind: 'diameter', value: 8, unit: 'mm', how: 'cylinder', exact: true }), { scene: () => ({ revision, scene: SCENE }) })
      return deps
    }
    const once = landing(1)
    expect(data(await measureTool(once, 'box', { kind: 'diameter', a: 'tub/F9' }))).toMatchObject({ revision: 5, value: 8 })
    expect(once.queries).toHaveLength(2)
    expect(await measureTool(landing(2), 'box', { kind: 'diameter', a: 'tub/F9' })).toEqual(refused('box was built again while the kernel was asked: call again'))
  })
})

describe('check', () => {
  it('reads an overlap and none', async () => {
    const deps = fake(() => ({ volume: 31.1234, bbox: { min: [0, 0, 36], max: [40, 40, 36.5] } }))
    const result = await checkTool(deps, 'box', { kind: 'overlap', a: 'lid', b: 'tub' })
    expect(deps.queries).toEqual([{ name: 'check', args: { kind: 'overlap', layout: 'assembly', a: 'lid', b: 'tub' } }])
    expect(data(result)).toEqual({ layout: 'assembly', revision: 4, kind: 'overlap', volume: 31.1234, bbox: { min: [0, 0, 36], max: [40, 40, 36.5] }, reading: 'overlap 31.12 mm³ between lid and tub, within (0, 0, 36) to (40, 40, 36.5)' })
    expect(data(await checkTool(fake(() => ({ volume: 0, bbox: null })), 'box', { kind: 'overlap', a: 'lid', b: 'tub' })).reading).toBe('no overlap between lid and tub')
  })

  it('reads a clearance: apart, touching, overlapping, and of a part that is no solid', async () => {
    const reading = async (said: object): Promise<string> => data(await checkTool(fake(() => ({ points: [[0, 0, 0], [0, 0, 1]], ...said })), 'box', { kind: 'clearance', a: 'lid', b: 'tub' })).reading
    expect(await reading({ distance: 0.4, overlapping: false, how: 'minimum' })).toBe('clearance 0.4 mm between lid and tub')
    expect(await reading({ distance: 0, overlapping: false, how: 'minimum' })).toBe('clearance 0 mm between lid and tub: the parts touch')
    expect(await reading({ distance: 0, overlapping: true, how: 'the parts overlap; the points are the centre of what they share' })).toBe('clearance 0 mm between lid and tub: the parts overlap')
    const shell = 'minimum; lid is not a solid, so whether the parts overlap is not told'
    expect(await reading({ distance: 1.5, overlapping: null, how: shell })).toBe(`clearance 1.5 mm between lid and tub (${shell})`)
  })

  it('reads a mesh that is closed, and one that is open with where', async () => {
    const reading = async (said: object): Promise<string> => data(await checkTool(fake(() => said), 'box', { kind: 'mesh', a: 'lid' })).reading
    expect(await reading({ watertight: true, openEdges: 0, where: [], triangles: 20594 })).toBe('mesh of lid: closed, 20,594 triangles')
    expect(await reading({ watertight: false, openEdges: 140, where: [[1, 2, 3], [4, 5, 6]], triangles: 900 })).toBe('mesh of lid: OPEN, 140 open edges, first at (1, 2, 3)')
    expect(await reading({ watertight: false, openEdges: 0, where: [], triangles: 0 })).toBe('mesh of lid: no triangles')
  })

  it('is of parts of the scene: anything else is refused before the kernel is asked', async () => {
    const deps = fake()
    expect(await checkTool(deps, 'box', { kind: 'clearance', a: 'lid', b: 'cap' })).toEqual(refused("no part 'cap' in layout assembly (parts: tub, lid)"))
    expect(await checkTool(deps, 'box', { kind: 'mesh', a: 'lid/F2' })).toEqual(refused('check mesh is of whole parts, and lid/F2 is a face: give lid'))
    expect(await checkTool(deps, 'box', { kind: 'overlap', a: 'lid' })).toEqual(refused('overlap is of two parts: give b'))
    expect(await checkTool(deps, 'box', { kind: 'mesh', a: 'lid', b: 'tub' })).toEqual(refused('mesh is of the part a alone: leave b out'))
    expect(deps.queries).toEqual([])
  })

  it('says plainly that the kernel did not answer in time, and gives its reason when it refuses', async () => {
    const slow = fake(() => new KernelError('timeout', 'the query took more than 30 s'))
    expect(await checkTool(slow, 'box', { kind: 'mesh', a: 'lid' })).toEqual(refused('the kernel did not answer within 30 s; the part may be too large for this check'))
    const shell = fake(() => new KernelError('bad_request', 'assembly:lid has no solid: overlap is of solids'))
    expect(await checkTool(shell, 'box', { kind: 'overlap', a: 'lid', b: 'tub' })).toEqual(refused('lid has no solid: overlap is of solids'))
  })
})

describe('section', () => {
  it('answers with the drawing and with the outlines as JSON: the plane in both forms, each part, the extent and a reading', async () => {
    const deps = fake(() => CUT)
    const result = await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, size: 5000 })
    expect(deps.queries).toEqual([{ name: 'section', args: { layout: 'assembly', plane: { origin: [0, 0, 3], normal: [0, 0, 1] }, deflection: 0.01 } }])
    // The window is given the outlines in full, every name of the build for the colours, and a size within bounds.
    expect(deps.drawings).toEqual([{ objectId: 'box', layout: 'assembly', section: CUT, names: ['tub', 'lid', 'tub', 'lid'], size: 2000, spread: false }])
    expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') })
    expect(data(result)).toEqual({
      layout: 'assembly',
      revision: 4,
      plane: { ...CUT.plane, axis: 'z', at: 3 },
      parts: CUT.parts,
      bounds: CUT.bounds,
      extent: [40, 40],
      reading: 'plane normal +Z at z = 3 · layout assembly: tub 1500 mm² in 2 loops; the cut is 40 × 40 mm',
      image: '1280×1150, the parts in the colours the user sees them in, saved as /ws/box/.torno/views/1.png'
    })
  })

  it("cuts by the user's own plane for 'current', and says plainly when there is none or the object is not the one open", async () => {
    const theirs = { origin: [0, 5, 0], normal: [0, 0.6, 0.8] } as const
    const deps = fake(() => ({ ...CUT, plane: { ...CUT.plane, ...theirs } }), { view: () => ({ ...VIEW, section: { origin: [...theirs.origin], normal: [...theirs.normal] } }) })
    const result = data(await sectionTool(deps, 'box', { plane: 'current' }))
    expect(deps.queries[0].args).toMatchObject({ plane: theirs })
    // Across no axis: the plane has no short form, and is named by its point and its normal.
    expect(result.plane).not.toHaveProperty('axis')
    expect(result.reading).toMatch(/^plane through \(0, 5, 0\), normal \(0, 0\.6, 0\.8\) · layout assembly: /)
    expect(await sectionTool(fake(), 'box', { plane: 'current' })).toEqual(refused('the user has no section on screen: give a plane, as {origin, normal} or {axis, at}'))
    expect(await sectionTool(fake(undefined, { openObjectId: () => 'stand' }), 'box', { plane: 'current' })).toEqual(
      refused("box is not the object open in the torno window (open: stand), so the user's section of it is not known: give a plane")
    )
  })

  it('holds at most 1,500 points in all, shared among the loops by their length, whether or not one part is named, and says so', async () => {
    const circle = (r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i): [number, number] => [r * Math.cos((i * 2 * Math.PI) / n), r * Math.sin((i * 2 * Math.PI) / n)])
    // Under the budget nothing is thinned, however many points one loop has.
    const few: Sectioned = { ...CUT, parts: [{ ...CUT.parts[0], loops: [loop(circle(20, 1000), 1256.6), loop(square(4), -16)], area: 1240.6 }], bounds: { min: [-20, -20], max: [20, 20] } }
    const whole = data(await sectionTool(fake(() => few), 'box', { plane: { axis: 'z', at: 3 } })) as never as { thinned?: boolean; parts: Array<{ loops: SectionLoop[] }> }
    expect(whole.thinned).toBeUndefined()
    expect(whole.parts[0].loops[0].points).toHaveLength(1000)

    // Over it: a long outline, a short one of as many points, and a square that has nothing to spare.
    const many: Sectioned = { ...CUT, parts: [{ ...CUT.parts[0], loops: [loop(circle(30, 4000), 2827.4), loop(circle(10, 4000), -314.2), loop(circle(10, 4000), -314.2), loop(square(4), -16)], area: 2183 }], bounds: { min: [-30, -30], max: [30, 30] } }
    type Told = { thinned?: boolean; points?: number; of?: number; loopsOmitted?: number; parts: Array<{ area: number; loopsOmitted?: number; loops: Array<SectionLoop & { thinned?: boolean; of?: number }> }> }
    for (const parts of [undefined, ['tub']]) {
      const deps = fake(() => many)
      const told = data(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, ...(parts ? { parts } : {}) })) as never as Told
      const [long, short, other, corners] = told.parts[0].loops
      const kept = told.parts[0].loops.reduce((sum, l) => sum + l.points.length, 0)
      expect(kept).toBeLessThanOrEqual(MAX_SECTION_POINTS)
      expect(kept).toBeGreaterThan(MAX_SECTION_POINTS - 8)
      expect(told).toMatchObject({ thinned: true, points: kept, of: 12004 })
      expect(told).not.toHaveProperty('loopsOmitted')
      // Three times as long, three times the points; the square keeps its four.
      expect(long.points.length / short.points.length).toBeCloseTo(3, 1)
      expect(short.points).toHaveLength(other.points.length)
      expect(long).toMatchObject({ closed: true, thinned: true, of: 4000, area: 2827.4 })
      expect(long.deflection).toBeGreaterThan(0.05)
      expect(corners).toEqual(loop(square(4), -16))
      // The areas are the kernel's, and the drawing is of the outlines in full.
      expect(told.parts[0].area).toBe(2183)
      expect(deps.drawings[0].section.parts[0].loops[0].points).toHaveLength(4000)
    }
  })

  it('leaves out the smallest loops when there are more than 187, and counts them', async () => {
    const ring = (r: number): [number, number][] => Array.from({ length: 12 }, (_, i): [number, number] => [r * Math.cos((i * Math.PI) / 6), r * Math.sin((i * Math.PI) / 6)])
    const loops = Array.from({ length: 620 }, (_, i) => loop(ring(1 + i), -1))
    const sieve: Sectioned = { ...CUT, parts: [{ ...CUT.parts[0], loops: loops.slice(0, 600) }, { ...CUT.parts[0], part: 'lid', loops: loops.slice(600) }] }
    const told = data(await sectionTool(fake(() => sieve), 'box', { plane: { axis: 'z', at: 3 } })) as never as { thinned: boolean; points: number; of: number; loopsOmitted: number; reading: string; parts: Array<{ loopsOmitted?: number; loops: SectionLoop[] }> }
    expect(told).toMatchObject({ thinned: true, of: 620 * 12, loopsOmitted: 433 })
    expect(told.points).toBeLessThanOrEqual(MAX_SECTION_POINTS)
    expect(told.parts.map((p) => [p.loops.length, p.loopsOmitted])).toEqual([[167, 433], [20, undefined]])
    // The smallest are the ones left out, and each kept has eight points at least.
    expect(Math.hypot(...told.parts[0].loops[0].points[0])).toBeCloseTo(434)
    expect(Math.min(...told.parts.flatMap((p) => p.loops.map((l) => l.points.length)))).toBeGreaterThanOrEqual(8)
    // The reading counts the loops the kernel cut.
    expect(told.reading).toContain('in 600 loops')
  })

  it('asks the kernel for outlines within 0.01 mm, which the drawing is made from, or within what the agent asks', async () => {
    const deps = fake(() => CUT)
    await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 } })
    await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, parts: ['tub'] })
    await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, deflection: 0.05 })
    expect(deps.queries.map((q) => (q.args as { deflection?: number }).deflection)).toEqual([0.01, 0.01, 0.05])
    expect(deps.queries[1].args).toEqual({ layout: 'assembly', plane: { origin: [0, 0, 3], normal: [0, 0, 1] }, parts: ['tub'], deflection: 0.01 })
    expect(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, deflection: 'fine' as never })).toEqual(refused('deflection is a number of mm, 0.005 to 0.05: how far the outlines may stray from the true ones (default 0.01)'))
  })

  it('cuts a scan by the same plane when asked, after the parts: its lines go to the drawing and to the answer, as approximate', async () => {
    const deps = fake((name) => (name === 'section' ? CUT : OUTLINE), scanned())
    const result = await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 'S1' })
    expect(deps.queries.map((q) => q.name)).toEqual(['section', 'scan_section'])
    expect(deps.queries[1].args).toEqual({ layout: 'assembly', plane: { origin: [0, 0, 3], normal: [0, 0, 1] }, points: 1500, scan: { id: 'S1', path: '/ws/box/.torno/scans/S1/mesh.bin', transform: { t: [0, 0, 10], q: [0, 0, 0, 1], s: 1 }, ignore: [], only: null } })
    const said = data(result) as any
    expect(said.scan).toEqual({ id: 'S1', alignment: { state: 'aligned', basis: 'hand', by: 'by hand (typed values)', steps: ['typed'], tied: 0 }, polylines: [{ points: [[-5, 2], [20, 2], [45, 3]], closed: false }], points: 3, of: 3, bounds: { min: [-5, 2], max: [45, 3] }, exact: false, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(said.reading).toBe('plane normal +Z at z = 3 · layout assembly: tub 1500 mm² in 2 loops; the cut is 40 × 40 mm. S1 was placed by hand: no fit says how well. ≈ S1 (a scan, approximate) crosses the plane in 1 line. S1 is aligned by hand (typed values) (tied to no point of the model: not checked against builds).')
    expect(deps.drawings[0].scan).toEqual({ id: 'S1', polylines: OUTLINE.polylines })
    expect(result.content.some((block) => block.type === 'image')).toBe(true)
  })

  // Final fix wave (I9): one budget for the whole reply, and the kernel is told how many points of the scan to tell.
  /** What the kernel says of a scan cut in a wavy line 300 mm long with 9,000 points found: as many of them as it was asked for. */
  const waved = (args: { points?: number }) => {
    const told = Math.min(args.points ?? 2000, 9000)
    return { ...OUTLINE, polylines: [{ points: Array.from({ length: told - 3 }, (_, i): [number, number] => [(i * 300) / (told - 4), Math.sin(i / 50) * 2]), closed: false }, { points: [[0, 0], [1, 0], [1, 1]], closed: true }], omitted: 2, pointsFound: 9000, pointsTold: told, thinned: true, bounds: { min: [0, -20], max: [300, 20] } }
  }

  it('tells a scan cut in as many points as the reply has room for, asked of the kernel, and says of how many; draws it though no part is cut; says its doubt first', async () => {
    const deps = fake((name, args) => (name === 'section' ? { ...CUT, parts: [{ ...CUT.parts[0], loops: [], area: 0 }], bounds: null } : waved(args)), scanned(FOUR_PAIRS, { checks: { assembly: { revision: 4, of: 4, off: 1, worst: 3, moved: [] } } }))
    const result = await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 'S1' })
    const said = data(result) as any
    const told = said.scan.polylines.reduce((sum: number, line: { points: unknown[] }) => sum + line.points.length, 0)
    expect(told).toBe(1500)
    // Asked once: the kernel thinned them, and nothing is thinned again here.
    expect(deps.queries.map((q) => [q.name, (q.args as { points?: number }).points])).toEqual([['section', undefined], ['scan_section', 1500]])
    expect(said.scan).toMatchObject({ points: told, of: 9000, thinned: true, linesOmitted: 2 })
    expect(said.reading).toBe(
      "plane normal +Z at z = 3 · layout assembly: the plane cuts nothing of the parts. S1's alignment may no longer hold: the model is no longer under 1 of its 4 points (worst 3 mm off) on r4: check the alignment. ≈ S1 (a scan, approximate) crosses the plane in 2 lines, told in 1,500 of the 9,000 points found, and 2 more that are not told. S1 is aligned by 4 pairs (RMS 0 mm, worst 0 mm): that RMS is of the clicked points, and says nothing of how true the scan is."
    )
    expect(deps.drawings[0].scan!.polylines[0].points).toHaveLength(1497)
    expect(deps.drawings[0].section.bounds).toEqual({ min: [0, -20], max: [300, 20] })
  })

  it('has one budget of 1,500 points for the parts and the scan together, shared by length, and says what was thinned', async () => {
    const circle = (r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i): [number, number] => [r * Math.cos((i * 2 * Math.PI) / n), r * Math.sin((i * 2 * Math.PI) / n)])
    // An outline of the part about as long as the scan's line (2π × 48 ≈ 300 mm), in 4,000 points.
    const round: Sectioned = { ...CUT, parts: [{ ...CUT.parts[0], loops: [loop(circle(48, 4000), 7238)], area: 7238 }], bounds: { min: [-48, -48], max: [48, 48] } }
    const deps = fake((name, args) => (name === 'section' ? round : waved(args)), scanned())
    const said = data(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 'S1' })) as any
    const ofParts = said.parts[0].loops[0].points.length
    const ofScan = said.scan.polylines.reduce((sum: number, line: { points: unknown[] }) => sum + line.points.length, 0)
    expect(ofParts + ofScan).toBeLessThanOrEqual(1500)
    expect(ofParts + ofScan).toBeGreaterThan(1480)
    // About half each: they are about as long.
    expect(ofParts / ofScan).toBeGreaterThan(0.8)
    expect(ofParts / ofScan).toBeLessThan(1.25)
    // The scan's share is asked of the kernel: its lines are thinned once, by it.
    expect(deps.queries.map((q) => [q.name, (q.args as { points?: number }).points])).toEqual([['section', undefined], ['scan_section', 1500], ['scan_section', ofScan]])
    expect(said).toMatchObject({ thinned: true, points: ofParts, of: 4000, budget: 1500 })
    expect(said.scan).toMatchObject({ points: ofScan, of: 9000, thinned: true })
    expect(said.reading).toContain(`; the cut is 96 × 96 mm, its outlines told in ${ofParts.toLocaleString('en-US')} of the 4,000 points cut (a reply holds 1,500 in all)`)
    expect(said.reading).toContain(`told in ${ofScan.toLocaleString('en-US')} of the 9,000 points found`)
    // The drawing is made from all the kernel first told.
    expect(deps.drawings[0].section.parts[0].loops[0].points).toHaveLength(4000)
    expect(deps.drawings[0].scan!.polylines[0].points).toHaveLength(1497)
    expect(TOOLS.section.description).toContain('at most 1,500 points in all')
    expect(MAX_SECTION_POINTS).toBe(1500)
  })

  it('asks nothing of the kernel for a scan that is not aligned, or that is none', async () => {
    const deps = fake(() => CUT, scanned())
    expect(text(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 'S1', layout: 'print' }))).toMatch(/^S1 is not aligned in layout print/)
    expect(text(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 'S4' }))).toBe('no scan S4; scans: S1')
    expect(text(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, scan: 4 as never }))).toBe('scan is the number of a scan, as listed by scans: {"scan": "S1"}')
    expect(deps.queries).toEqual([])
  })

  it('says of a part the plane misses that it does not cut it, not that it is cut in no loops', async () => {
    const one: Sectioned = { ...CUT, parts: [CUT.parts[0], { ...CUT.parts[0], part: 'lid', loops: [], area: 0 }] }
    expect(data(await sectionTool(fake(() => one), 'box', { plane: { axis: 'z', at: 3 } })).reading).toBe('plane normal +Z at z = 3 · layout assembly: tub 1500 mm² in 2 loops; the plane does not cut lid; the cut is 40 × 40 mm')
  })

  it('keeps the corners of a loop it thins', () => {
    // A square with 100 points along each side: its four corners are what matters of it.
    const side = (from: [number, number], to: [number, number]): [number, number][] => Array.from({ length: 100 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 100, from[1] + ((to[1] - from[1]) * i) / 100])
    const points = [...side([0, 0], [10, 0]), ...side([10, 0], [10, 10]), ...side([10, 10], [0, 10]), ...side([0, 10], [0, 0])]
    const kept = thinned({ points, closed: true, deflection: 0.05 }, 8)!
    expect(kept.points).toHaveLength(4)
    expect(kept.points).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]])
    expect(kept.deflection).toBeCloseTo(0.05)
    expect(thinned({ points: square(4), closed: true, deflection: 0.05 }, 8)).toBeNull()
  })

  it('says of each part whether its area is exact, and of an open outline that it bounds none', async () => {
    const mixed: Sectioned = {
      ...CUT,
      parts: [
        { ...CUT.parts[0], areaExact: false },
        { part: 'lid', loops: [loop([[0, 0], [10, 0]], null as never, { closed: false })], area: null, areaExact: true, open: 1, how: 'outline of the surface: the part is not a solid' }
      ]
    }
    const result = data(await sectionTool(fake(() => mixed), 'box', { plane: { axis: 'z', at: 3 } })) as never as { reading: string; parts: Array<{ areaExact: boolean; open: number; area: number | null; how: string }> }
    expect(result.reading).toBe('plane normal +Z at z = 3 · layout assembly: tub ≈ 1500 mm² in 2 loops; lid, open in 1 loop; the cut is 40 × 40 mm')
    expect(result.parts.map((p) => [p.areaExact, p.open, p.area, p.how])).toEqual([
      [false, 0, 1500, 'cross-section of the solid'],
      [true, 1, null, 'outline of the surface: the part is not a solid']
    ])
  })

  it('still answers with the outlines when the window cannot draw them, and says why there is no image', async () => {
    const closed = fake(() => CUT, { sectionDrawing: async () => Promise.reject(new Error('the torno window is closed')) })
    const result = await sectionTool(closed, 'box', { plane: { axis: 'z', at: 3 } })
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(data(result)).toMatchObject({ parts: CUT.parts, image: 'not drawn: the torno window is closed' })
    // Drawn without the object being open: in the colours the parts have by default, and that is said.
    const elsewhere = fake(() => CUT, { sectionDrawing: async () => ({ png: new Uint8Array([1]), width: 800, height: 700, colours: 'palette', vDown: true }) })
    expect(data(await sectionTool(elsewhere, 'box', { plane: { axis: 'z', at: 3 } })).image).toBe(
      '800×700, the parts in their default colours (box is not the object open in the torno window), v runs down the sheet so that what is up in the world is up on it, saved as /ws/box/.torno/views/1.png'
    )
  })

  it('draws nothing of a plane that cuts nothing, and says so', async () => {
    const deps = fake(() => ({ ...CUT, parts: [{ ...CUT.parts[0], loops: [], area: 0 }], bounds: null }))
    const result = await sectionTool(deps, 'box', { plane: { origin: [0, 0, 99], normal: [0, 0, 2] } })
    expect(deps.queries[0].args).toMatchObject({ plane: { origin: [0, 0, 99], normal: [0, 0, 1] } })
    expect(deps.drawings).toEqual([])
    expect(data(result)).toMatchObject({ bounds: null, extent: null, image: 'not drawn: there is nothing to draw', reading: 'plane normal +Z at z = 3 · layout assembly: the plane cuts nothing' })
  })

  it('refuses what is no plane, parts the layout has not, and passes on a timeout', async () => {
    const deps = fake()
    const noPlane = 'that is not a plane: give {"axis": "z", "at": 3} for the plane across x, y or z at that coordinate in mm, or {"origin": [x, y, z], "normal": [x, y, z]} with a normal that is not all zeros'
    for (const plane of [undefined, 'z=3', { z: 3 }, { axis: 'z' }, { axis: 'z', at: '3' }, [0, 0, 1], { origin: [0, 0], normal: [0, 0, 1] }]) expect(await sectionTool(deps, 'box', { plane: plane as never })).toEqual(refused(noPlane))
    expect(await sectionTool(deps, 'box', { plane: { origin: [0, 0, 0], normal: [0, 0, 0] } })).toEqual(refused(noPlane))
    expect(await sectionTool(deps, 'box', { plane: { axis: 'w', at: 1 } as never })).toEqual(refused(noPlane))
    expect(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, parts: ['cap'] })).toEqual(refused("no part 'cap' in layout assembly (parts: tub, lid)"))
    expect(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, parts: [] })).toEqual(refused('parts is empty: name the parts to cut, or leave it out for all of them'))
    expect(deps.queries).toEqual([])
    const slow = fake(() => new KernelError('timeout', 'the query took more than 30 s'))
    expect(await sectionTool(slow, 'box', { plane: { axis: 'z', at: 3 } })).toEqual(refused('the kernel did not answer within 30 s; the part may be too large for this section'))
  })
})

describe('a layout whose parts torno spread apart for display', () => {
  const refusal = (what: string, where = 'Ask in a layout that places the parts as assembled (layouts: assembly), or check each part by itself.'): ToolResult =>
    refused(`In layout print torno spread these parts apart for display (they overlapped as the model placed them), so ${what} lid and tub there is torno's, not the model's. ${where}`)

  it('refuses what is between two parts there: an overlap, a clearance, a distance', async () => {
    const deps = spread()
    expect(await checkTool(deps, 'box', { kind: 'overlap', a: 'lid', b: 'tub', layout: 'print' })).toEqual(refusal('what is shared between'))
    expect(await checkTool(deps, 'box', { kind: 'clearance', a: 'lid', b: 'tub', layout: 'print' })).toEqual(refusal('the distance between'))
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'lid/F1', b: { ref: 'tub/F2', point: [1, 2, 3] }, layout: 'print' })).toEqual(refusal('the distance between'))
    expect(await measureTool(deps, 'box', { kind: 'distance', a: 'lid', b: 'tub', layout: 'print' })).toEqual(refusal('the distance between'))
    // A mark stands for the part it is on, here as anywhere.
    const onLid: Mark = { ...MARK, id: 'M1', kind: 'pin', layout: 'print', anchor: { point: [45, 0, 2], part: 'lid', ref: 'lid/F1' } }
    const marked = fake(undefined, { scene: () => ({ revision: 4, scene: SPREAD }), marks: async () => [onLid] })
    expect(await measureTool(marked, 'box', { kind: 'distance', a: 'M1', b: 'tub/F2', layout: 'print' })).toEqual(refusal('the distance between'))
    // And a dimension between them is not left as a check of the part.
    expect(await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'distance', a: 'lid/F5', b: 'tub/F5', layout: 'print', expected: 2 })).toEqual(refusal('the distance between'))
    expect(deps.added).toEqual([])
    expect(deps.queries).toEqual([])
    // With no other layout, that is said.
    const only: Scene = { ...SPREAD, layouts: ['print'], parts: SPREAD.parts.filter((p) => p.layout === 'print') }
    expect(await checkTool(spread(undefined, only), 'box', { kind: 'clearance', a: 'lid', b: 'tub' })).toEqual(refusal('the distance between', 'This object has no layout that places its parts as assembled: check each part by itself.'))
  })

  it('answers the same questions in the layout that was not spread, and in one whose parts did not have to be moved', async () => {
    const deps = spread(() => ({ distance: 0.4, points: [[0, 0, 0], [0, 0, 0.4]], overlapping: false, how: 'minimum' }))
    expect((await checkTool(deps, 'box', { kind: 'clearance', a: 'lid', b: 'tub', layout: 'assembly' })).isError).toBeUndefined()
    const plain = fake(() => ({ distance: 0.4, points: [[0, 0, 0], [0, 0, 0.4]], overlapping: false, how: 'minimum' }))
    expect(data(await checkTool(plain, 'box', { kind: 'clearance', a: 'lid', b: 'tub', layout: 'print' }))).not.toHaveProperty('arranged')
  })

  it('answers what is of one part as ever, with how far that part was moved so that its points can be put back', async () => {
    const hole = { kind: 'diameter', value: 8, unit: 'mm', how: 'cylinder', points: [[41, 0, 0], [49, 0, 0]], exact: true }
    expect(data(await measureTool(spread(() => hole), 'box', { kind: 'diameter', a: 'lid/F3', layout: 'print' }))).toEqual({ layout: 'print', revision: 4, ...hole, arranged: [45, 0, 0], note: MOVED, reading: '⌀ 8 mm, lid/F3' })
    // From a free point to a part torno moved is no distance of the model's either, whichever is named first: the point is where the part is shown only by the spread.
    const toPoint = { kind: 'distance', value: 3, unit: 'mm', how: 'point to plane', points: [[45, 0, 5], [45, 0, 2]], exact: true }
    const POINT = "In layout print torno moved lid for display (the parts overlapped as the model placed them), so the distance between a point and lid there is torno's, not the model's. Ask in a layout that places lid as the model does (layouts: assembly), or measure between faces and edges of lid."
    for (const ends of [{ a: { point: [45, 0, 5] }, b: 'lid/F1' }, { a: 'lid/F1', b: { point: [45, 0, 5] } }] as const) {
      const deps = spread(() => toPoint)
      expect(await measureTool(deps, 'box', { kind: 'distance', ...ends, layout: 'print' } as never)).toEqual(refused(POINT))
      expect(await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'distance', ...ends, layout: 'print' } as never)).toEqual(refused(POINT))
      expect(deps.queries).toEqual([])
    }
    // To a part that was left where the model placed it, it is answered.
    expect(data(await measureTool(spread(() => toPoint), 'box', { kind: 'distance', a: { point: [0, 0, 5] }, b: 'tub/F1', layout: 'print' }))).toMatchObject({ value: 3 })
    // Two ends on one part are of that part. With no coordinates in the answer, nothing is said of frames.
    const within = { kind: 'distance', value: 2, unit: 'mm', how: 'between planes', exact: true }
    const inside = data(await measureTool(spread(() => within), 'box', { kind: 'distance', a: 'lid/F1', b: 'lid/F2', layout: 'print' }))
    expect(inside).toMatchObject({ value: 2, arranged: [45, 0, 0] })
    expect(inside).not.toHaveProperty('note')
    const volume = data(await measureTool(spread(() => ({ kind: 'volume', value: 6000, unit: 'mm3', how: 'solid', exact: true })), 'box', { kind: 'volume', a: 'lid', layout: 'print' }))
    expect(volume).toMatchObject({ value: 6000, arranged: [45, 0, 0] })
    expect(volume).not.toHaveProperty('note')
    // A part that was not moved says nothing of it, and a mesh is the part's own.
    expect(data(await measureTool(spread(() => hole), 'box', { kind: 'diameter', a: 'tub/F3', layout: 'print' }))).not.toHaveProperty('arranged')
    const mesh = data(await checkTool(spread(() => ({ watertight: true, openEdges: 0, where: [], triangles: 12 })), 'box', { kind: 'mesh', a: 'lid', layout: 'print' }))
    expect(mesh).toMatchObject({ reading: 'mesh of lid: closed, 12 triangles', arranged: [45, 0, 0] })
    expect(mesh).not.toHaveProperty('note')
    const open = data(await checkTool(spread(() => ({ watertight: false, openEdges: 3, where: [[45, 0, 0]], triangles: 12 })), 'box', { kind: 'mesh', a: 'lid', layout: 'print' }))
    expect(open).toMatchObject({ arranged: [45, 0, 0], note: MOVED })
    // An angle is the same wherever the parts are put: they were moved, not turned.
    // Where its two ends are relative to each other is torno's, though: the points are left out.
    const angle = { kind: 'angle', value: 90, unit: 'deg', how: 'between normals', points: [[45, 0, 0], [0, 0, 0]], exact: true }
    const between = data(await measureTool(spread(() => angle), 'box', { kind: 'angle', a: 'lid/F1', b: 'tub/F2', layout: 'print' }))
    expect(between.reading).toBe('90° between normals, lid/F1 to tub/F2')
    expect(between).not.toHaveProperty('points')
    expect(between).not.toHaveProperty('arranged')
    expect(data(await measureTool(spread(() => angle), 'box', { kind: 'angle', a: 'lid/F1', b: 'tub/F2', layout: 'assembly' }))).toHaveProperty('points')
  })

  it('cuts them where they are shown, and says so: a note, how far each part was moved, the reading, and the title of the drawing', async () => {
    const two: Sectioned = { ...CUT, parts: [CUT.parts[0], { ...CUT.parts[0], part: 'lid' }] }
    const deps = spread(() => two)
    const result = data(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 }, layout: 'print' })) as never as { note: string; reading: string; parts: Array<{ part: string; arranged?: number[] }> }
    expect(result.note).toBe(SPREAD_NOTE)
    expect(result.parts.map((p) => [p.part, p.arranged])).toEqual([['tub', [0, 0, 0]], ['lid', [45, 0, 0]]])
    expect(result.reading).toBe(`plane normal +Z at z = 3 · layout print (parts spread for display): tub 1500 mm² in 2 loops; lid 1500 mm² in 2 loops; the cut is 40 × 40 mm. ${SPREAD_NOTE}`)
    expect(deps.drawings[0]).toMatchObject({ layout: 'print', spread: true })
    // Where nothing was spread, nothing is said.
    const plain = fake(() => two)
    const unspread = data(await sectionTool(plain, 'box', { plane: { axis: 'z', at: 3 }, layout: 'print' }))
    expect(unspread).not.toHaveProperty('note')
    expect(plain.drawings[0].spread).toBe(false)
  })
})

describe('describe and the caps of the inputs', () => {
  it('describe says of a part torno moved how far, so that its centre and its box can be put back', async () => {
    const moved = data(await describeTool(spread(), 'box', { ref: 'lid/F5', layout: 'print' }))
    expect(moved).toMatchObject({ layout: 'print', center: [0, 0, 3], arranged: [45, 0, 0], note: MOVED })
    const still = data(await describeTool(spread(), 'box', { ref: 'tub/F5', layout: 'print' }))
    expect(still).not.toHaveProperty('arranged')
    expect(still).not.toHaveProperty('note')
  })

  it('no tool takes more than 64 part names', () => {
    const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `p${i}`)
    for (const tool of [TOOLS.look, TOOLS.show, TOOLS.section]) {
      const parts = (tool.inputSchema as unknown as { parts: { safeParse(value: unknown): { success: boolean } } }).parts
      expect(parts.safeParse(names(64)).success).toBe(true)
      expect(parts.safeParse(names(65)).success).toBe(false)
    }
  })
})

describe('which build a section is of', () => {
  it('is the one its outlines were cut on, whatever is built while they are drawn', async () => {
    let revision = 4
    let status: BuildState['status'] = 'ok'
    const deps = fake(() => CUT, {
      scene: () => ({ revision, scene: SCENE }),
      build: () => ({ ...OK, revision, status, stale: status !== 'ok' }),
      sectionDrawing: async () => {
        // A build lands, and another starts, while the window draws.
        revision = 5
        status = 'building'
        return { png: new Uint8Array([1]), width: 800, height: 700, colours: 'window', vDown: false }
      }
    })
    const result = data(await sectionTool(deps, 'box', { plane: { axis: 'z', at: 3 } }))
    expect(result.revision).toBe(4)
    expect(result).not.toHaveProperty('stale')
  })

  it("is not asked by the user's plane in another layout than the one they are viewing", async () => {
    const deps = fake(() => CUT, { view: () => ({ ...VIEW, section: { origin: [0, 0, 3], normal: [0, 0, 1] } }) })
    expect(await sectionTool(deps, 'box', { plane: 'current', layout: 'print' })).toEqual(refused("the user's section is of layout assembly, the one they are viewing, not of print: leave layout out, or give a plane"))
    expect((await sectionTool(deps, 'box', { plane: 'current', layout: 'assembly' })).isError).toBeUndefined()
  })
})

describe('the section in scene, look and show', () => {
  it("scene reports the user's section, with the short form when it is across an axis the way that form means", () => {
    const withCut = (section: ViewState['section']): unknown => JSON.parse(text(sceneTool(fake(undefined, { view: () => ({ ...VIEW, section }) }), 'box'))).section
    expect(withCut({ origin: [0, 0, 3.0000004], normal: [0, 0, 1] })).toEqual({ origin: [0, 0, 3], normal: [0, 0, 1], axis: 'z', at: 3 })
    // {axis, at} leaves out what is beyond the coordinate: a plane that looks the other way is not that one.
    expect(withCut({ origin: [0, 0, 3], normal: [0, 0, -1] })).toEqual({ origin: [0, 0, 3], normal: [0, 0, -1] })
    expect(withCut({ origin: [1, 2, 3], normal: [0, 0.6, 0.8] })).toEqual({ origin: [1, 2, 3], normal: [0, 0.6, 0.8] })
    expect(withCut(null)).toBeNull()
    expect(JSON.parse(text(sceneTool(fake(), 'box'))).section).toBeNull()
  })

  it('look passes a plane in either form, none, or leaves it to the window', async () => {
    const deps = fake()
    await lookTool(deps, 'box', {})
    await lookTool(deps, 'box', { section: { axis: 'y', at: -2 } })
    await lookTool(deps, 'box', { section: { origin: [1, 2, 3], normal: [0, 0, 5] } })
    await lookTool(deps, 'box', { section: null })
    await lookTool(deps, 'box', { section: 'current' })
    expect(deps.looks.map((req) => req.section)).toEqual([undefined, { origin: [0, -2, 0], normal: [0, 1, 0] }, { origin: [1, 2, 3], normal: [0, 0, 1] }, null, 'current'])
    expect(text(await lookTool(deps, 'box', { section: { origin: [0, 0, 0], normal: [0, 0, 0] } }))).toMatch(/^that is not a plane/)
    expect(deps.looks).toHaveLength(5)
  })

  it("show puts a cut on the user's screen or takes it away, and a section alone is something to show", async () => {
    const deps = fake()
    expect((await showTool(deps, 'box', { section: { axis: 'z', at: 3 } })).isError).toBeUndefined()
    await showTool(deps, 'box', { section: null })
    await showTool(deps, 'box', { view: 'top' })
    expect(deps.shows).toEqual([{ objectId: 'box', section: { origin: [0, 0, 3], normal: [0, 0, 1] } }, { objectId: 'box', section: null }, { objectId: 'box', view: 'top' }])
    expect(text(await showTool(deps, 'box', { section: { origin: [0, 0, 0], normal: [0, 0, 0] } }))).toMatch(/^that is not a plane/)
  })
})

describe('add_mark with a dimension', () => {
  it('keeps a dimension of the agent between the two ends it names, and answers with its line: the value and the verdict', async () => {
    const deps = fake()
    const result = await addMarkTool(deps, 'box', { kind: 'dimension', note: 'wall under the lid', measure: 'distance', a: 'tub/F5', b: { ref: 'tub/F5', point: [1, 2, 3] }, expected: 6, tolerance: 0.1 })
    expect(result.isError).toBeUndefined()
    expect(deps.added).toMatchObject([
      { kind: 'dimension', author: 'agent', layout: 'assembly', revision: 4, measure: 'distance', note: 'wall under the lid', expected: 6, tolerance: 0.1, a: { ref: 'tub/F5', part: 'tub', point: [0, 0, 3] }, b: { ref: 'tub/F5', part: 'tub', point: [1, 2, 3] } }
    ])
    // Nothing of what only main says of a dimension is the tool's to give.
    for (const key of ['value', 'how', 'verdict', 'measuredRevision', 'points']) expect(deps.added[0]).not.toHaveProperty(key)
    expect(text(result)).toBe('placed in layout assembly: (yours) M9 distance 6 mm between planes, tub/F5 to tub/F5 (expected 6 ± 0.1: pass): "wall under the lid"\nrevision r4')
    const failing = await addMarkTool(fake(), 'box', { kind: 'dimension', note: '', measure: 'distance', a: 'tub/F5', b: 'M1', expected: 8 })
    expect(text(failing)).toBe('placed in layout assembly: (yours) M9 distance 6 mm between planes, tub/F5 to tub/F5 (expected 8 ± 0.05: FAIL, 2 under)\nrevision r4')
  })

  it('takes a bare point for an end, and a mark for what it is on', async () => {
    const deps = fake()
    await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'distance', a: { point: [0, 0, 9] }, b: 'M1' })
    expect(deps.added[0]).toMatchObject({ a: { point: [0, 0, 9] }, b: { ref: 'tub/F5', point: [10, 5, 3] } })
    expect((deps.added[0] as { a: object }).a).toEqual({ point: [0, 0, 9] })
  })

  it.each([
    [{ measure: 'distance', a: 'tub/F5' }, 'a dimension of a distance needs b, its other end'],
    [{ measure: 'diameter', a: 'tub/F5', b: 'tub/F1' }, 'a dimension of a diameter is of a alone: leave b out'],
    [{ a: 'tub/F5' }, 'a dimension needs measure, one of distance, angle, radius, diameter, thickness, and a, what it is of'],
    [{ measure: 'radius', a: 'tub/F5', expected: Infinity }, 'expected is a number'],
    [{ measure: 'radius', a: 'tub/F5', tolerance: -1 }, 'tolerance is a number, zero or more'],
    [{ measure: 'radius', a: 'tub' }, 'a dimension is between faces, edges and points, and tub is a whole part: name a face or an edge of it, or use measure'],
    [{ measure: 'radius', a: 'tub/F40' }, 'tub has 12 faces, F0 to F11: there is no F40'],
    [{ measure: 'radius', a: 'M2' }, 'M2 has moved since it was placed: give a ref'],
    [{ measure: 'radius', a: 'tub/F3' }, 'the centre of tub/F3 is on tub/F5, not on tub/F3: give a point on it, as {ref: "tub/F3", point: [x, y, z]}']
  ] as const)('keeps nothing for %o', async (args, message) => {
    const deps = fake()
    expect(await addMarkTool(deps, 'box', { kind: 'dimension', note: '', ...args } as never)).toEqual(refused(message))
    expect(deps.added).toEqual([])
  })

  it.each([
    ['rebuilt', 5, 'NOT MEASURED: the model was rebuilt while this was measured. M9 was kept without a value, and is measured when its ends have been found on r5: read it then with describe.'],
    ['unanswered', 4, 'NOT MEASURED: the kernel gave no answer (the worker died). M9 was kept without a value, and is measured when the marks are next checked against r4: read it then with describe.']
  ] as const)('says first that a dimension was kept without a value, and why (%s), so that its line is not read as a measurement', async (unmeasured, now, first) => {
    let revision = 4
    const deps = fake(undefined, {
      scene: () => ({ revision, scene: SCENE }),
      addDimension: async (_objectId, mark) => {
        revision = now
        return { mark: { ...mark, id: 'M9', status: 'sent', anchorState: 'ok', createdAt: MARK.createdAt } as Mark, unmeasured, ...(unmeasured === 'unanswered' ? { reason: 'the worker died' } : {}) }
      }
    })
    const result = await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'diameter', a: 'tub/F5', expected: 8 })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(`${first}\nplaced in layout assembly: (yours) M9 diameter: not measured yet, tub/F5 (expected 8 ± 0.05) [not checked against r${now}]\nrevision r${now}`)
  })

  it("answers with the kernel's reason when it cannot measure what was named, and nothing is kept", async () => {
    const deps = fake(undefined, { addDimension: async () => Promise.reject(new Error('radius is measured of a cylinder, a sphere, a torus or a circle; tub/F5 is a plane')) })
    expect(await addMarkTool(deps, 'box', { kind: 'dimension', note: '', measure: 'radius', a: 'tub/F5' })).toEqual(refused('radius is measured of a cylinder, a sphere, a torus or a circle; tub/F5 is a plane'))
  })
})

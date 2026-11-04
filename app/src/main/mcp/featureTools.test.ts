import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import { KernelError } from '../kernel/client'
import { type Boss, type Featured, type Hole, alongText, featuresReading, featuresTool } from './featureTools'
import type { ToolDeps } from './tools'

// `features` against a stand-in for the kernel: what is asked of it is kept, and what it says is what the test gives.

const part = (layout: string, name: string, more: Partial<Part> = {}): Part =>
  ({ key: `${layout}:${name}`, name, layout, bbox: { min: [-20, -15, -3], max: [20, 15, 3] }, volume: 6000, faceCount: 12, edgeCount: 30, valid: true, ...more }) as Part
const SCENE: Scene = { model: 'box.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'lid'), part('print', 'lid', { arranged: [45, 0, 0] })], seconds: 1, output: '' }
const OK: BuildState = { objectId: 'box', status: 'ok', revision: 4, seconds: 1, stale: false }

const hole = (more: Partial<Hole> = {}): Hole => ({
  diameter: 3.4,
  axis: [0, 0, -1],
  entry: [10, 5, 3],
  entryRef: 'lid/F2',
  exitRef: 'lid/F3',
  end: 'through',
  depth: 6,
  shape: 'plain',
  steps: [{ from: 0, to: 6, type: 'cylinder', diameter: 3.4 }],
  faces: ['lid/F6'],
  exact: true,
  ...more
})
const boss = (more: Partial<Boss> = {}): Boss => ({
  diameter: 8,
  axis: [0, 0, 1],
  base: [0, 0, 3],
  baseRef: 'lid/F2',
  top: [0, 0, 13],
  topRef: 'lid/F9',
  height: 10,
  steps: [{ from: 0, to: 10, type: 'cylinder', diameter: 8 }],
  faces: ['lid/F8'],
  exact: true,
  ...more
})
const featured = (more: Partial<Featured> = {}): Featured => ({
  part: 'lid',
  kinds: ['hole', 'boss'],
  holes: [hole()],
  holeCount: 1,
  bosses: [],
  bossCount: 0,
  left: { holes: 0, bosses: 0 },
  notFeatures: { arcs: 0, freeCylinders: 0, freeformFaces: 0 },
  exact: true,
  how: 'from the B-rep',
  complete: true,
  ...more
})

function fake(says: (name: string, args: never) => unknown = () => featured()): ToolDeps & { queries: Array<{ name: string; args: unknown }> } {
  const queries: Array<{ name: string; args: unknown }> = []
  return {
    queries,
    object: (id: string) => (id === 'box' ? { id, name: id, dir: '/ws/box', model: 'box.py' } : undefined),
    build: (id: string) => (id === 'box' ? OK : undefined),
    scene: (id: string) => (id === 'box' ? { revision: 4, scene: SCENE } : undefined),
    openObjectId: () => 'box',
    view: () => undefined,
    query: async (_id: string, name: string, args: object) => {
      queries.push({ name, args })
      const said = says(name, args as never)
      if (said instanceof Error) throw said
      return said
    }
  } as unknown as ToolDeps & { queries: Array<{ name: string; args: unknown }> }
}

const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content[0].text!
const data = (r: Parameters<typeof text>[0]): Record<string, unknown> => JSON.parse(text(r))

describe('features', () => {
  it('asks the kernel for the part in the layout, and answers with its data, the build and a reading', async () => {
    const deps = fake()
    const said = data(await featuresTool(deps, 'box', { part: 'lid', layout: 'assembly' }))
    expect(deps.queries).toEqual([{ name: 'features', args: { layout: 'assembly', part: 'lid' } }])
    expect(said).toMatchObject({ layout: 'assembly', revision: 4, part: 'lid', holeCount: 1, exact: true })
    expect((said.holes as Hole[])[0]).toMatchObject({ diameter: 3.4, entryRef: 'lid/F2' })
    expect(said.reading).toBe('1 hole in lid: 1 × ⌀3.4 through, 6 long, along Z; no bosses on lid')
  })

  it('passes the kinds on, and says what it takes for anything else', async () => {
    const deps = fake()
    await featuresTool(deps, 'box', { part: 'lid', kinds: ['boss'] })
    expect(deps.queries[0].args).toEqual({ layout: 'assembly', part: 'lid', kinds: ['boss'] })
    for (const [args, said] of [
      [{}, 'features needs part, the name of a part as scene lists it: {"part": "lid"}'],
      [{ part: 'lid', kinds: 'hole' }, 'kinds is a list of hole, boss: {"part": "lid", "kinds": ["hole"]}'],
      [{ part: 'lid', kinds: ['gear'] }, 'kinds is a list of hole, boss: {"part": "lid", "kinds": ["hole"]}'],
      [{ part: 'lid', kinds: [] }, 'kinds is a list of hole, boss: {"part": "lid", "kinds": ["hole"]}']
    ] as const) {
      const r = await featuresTool(fake(), 'box', args as never)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(text(r)).toBe(said)
    }
  })

  it('refuses a part the scene does not have, a face, and a layout it does not have, before the kernel is asked', async () => {
    const deps = fake()
    expect(text(await featuresTool(deps, 'box', { part: 'cap', layout: 'assembly' }))).toContain("no part 'cap' in layout assembly")
    expect(text(await featuresTool(deps, 'box', { part: 'lid/F3', layout: 'assembly' }))).toBe('part is a part, not a face: give lid')
    expect((await featuresTool(deps, 'box', { part: 'lid', layout: 'nowhere' })).isError).toBe(true)
    expect(deps.queries).toEqual([])
  })

  it("tells the kernel's refusal in its words, and a query that took its time as that", async () => {
    const refused = await featuresTool(fake(() => new KernelError('bad_request', 'assembly:lid is not a solid: it is a shell')), 'box', { part: 'lid', layout: 'assembly' })
    expect(text(refused)).toBe('lid is not a solid: it is a shell')
    const slow = await featuresTool(fake(() => new KernelError('timeout', 'the query took too long')), 'box', { part: 'lid', layout: 'assembly' })
    expect(text(slow)).toBe('the kernel did not answer within 30 s; the part may be too large for this query')
  })

  it('says where a part torno moved for display is, as the other tools of one part do', async () => {
    const said = data(await featuresTool(fake(), 'box', { part: 'lid', layout: 'print' }))
    expect(said).toMatchObject({ arranged: [45, 0, 0], note: 'lid was moved by torno for display in layout print: these coordinates are in the displayed frame; subtract arranged for the model’s own.' })
  })
})

describe('the reading of features', () => {
  it('counts equal holes together and tells each kind of end', () => {
    const f = featured({
      kinds: ['hole'],
      holes: [hole(), hole({ entry: [-10, 5, 3] }), hole({ diameter: 6, end: 'blind', depth: 4, bottom: 'flat', exitRef: undefined, steps: [], entry: [0, 0, 3] })],
      holeCount: 3
    })
    expect(featuresReading(f)).toBe('3 holes in lid: 2 × ⌀3.4 through, 6 long, along Z; 1 × ⌀6 blind, 4 deep, along −Z')
  })

  it('tells a counterbore, a countersink and a rounded mouth', () => {
    const bore = hole({ shape: 'counterbore', counterbore: { diameter: 6.4, depth: 4 } })
    const sink = hole({ shape: 'countersink', countersink: { diameter: 7, angle: 90, depth: 1.5 } })
    const round = hole({ shape: 'rounded', rounded: { radius: 0.5 } })
    const said = featuresReading(featured({ holes: [bore, sink, round], holeCount: 3 }))
    expect(said).toContain('⌀3.4 through, 6 long, counterbore ⌀6.4 × 4, along Z')
    expect(said).toContain('countersink ⌀7 at 90°')
    expect(said).toContain('mouth rounded r0.5')
  })

  it('marks what is not exact with ≈ and says why, and counts what it did not list', () => {
    const rough = hole({ exact: false, depth: 20, how: 'x' })
    const said = featuresReading(featured({ holes: [rough], holeCount: 105, exact: false, left: { holes: 5, bosses: 0 } }))!
    expect(said).toContain('105 holes in lid')
    expect(said).toContain('≈ 20 long')
    expect(said).toContain('104 more not listed')
    expect(said).toContain('approximate where it says ≈')
  })

  it('tells bosses, none, and what was not taken for either', () => {
    expect(featuresReading(featured({ holes: [], holeCount: 0, bosses: [boss(), boss({ base: [10, 0, 3] })], bossCount: 2 }))).toBe('no holes in lid; 2 bosses on lid: 2 × ⌀8 × 10 high, along Z')
    const said = featuresReading(featured({ kinds: ['hole'], holes: [], holeCount: 0, notFeatures: { arcs: 4, freeCylinders: 0, freeformFaces: 1 }, complete: false }))!
    expect(said).toContain('no holes in lid')
    expect(said).toContain('4 round faces that do not go all the way round')
    expect(said).toContain('1 freeform face cannot be told')
    expect(said).toContain('the time ran out')
  })

  it('names an axis along one of the layout’s as that, and any other by its components', () => {
    expect(alongText([0, 0, -1])).toBe('−Z')
    expect(alongText([1, 0, 0])).toBe('X')
    expect(alongText([0, 0.5, -0.866])).toBe('(0, 0.5, -0.866)')
  })
})

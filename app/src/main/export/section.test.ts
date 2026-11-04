import { describe, expect, it } from 'vitest'
import type { Sectioned } from '../../shared/geometry'
import type { Scene } from '../../shared/scene'
import type { ViewState } from '../../shared/view'
import { type SectionDeps, NO_SECTION, NOTHING_CUT, makeSectionDrawing } from './section'
import { NOT_BUILT } from './build'
import { NEW_BUILD } from './model'

const part = (name: string) => ({ key: `assembly:${name}`, name, layout: 'assembly' })
const scene = { layouts: ['assembly'], parts: [part('tub'), part('lid')] } as unknown as Scene
const cut: Sectioned = {
  plane: { origin: [0, 0, 10], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
  parts: [{ part: 'tub', loops: [{ points: [[-20, -10], [20, -10], [20, 10], [-20, 10]], closed: true, area: 800, areaExact: true, deflection: 0.01 }], area: 800, areaExact: true, open: 0, how: 'x' }],
  bounds: { min: [-20, -10], max: [20, 10] }
}
const view = (extra: Partial<ViewState> = {}): ViewState => ({ objectId: 'hollow', layout: 'assembly', camera: {} as never, visible: ['assembly:tub', 'assembly:lid'], section: { origin: [0, 0, 10], normal: [0, 0, 1] }, ...extra })

function deps(over: Partial<SectionDeps> & { asked?: unknown[] } = {}): SectionDeps {
  const { asked, ...rest } = over
  return {
    object: (id) => (id === 'hollow' ? { id, name: 'hollow', dir: '/w/hollow', model: 'hollow.py' } : undefined),
    last: () => ({ revision: 4, scene }),
    view: () => view(),
    marks: async () => [],
    query: (async (_id: string, _name: string, args: unknown) => (asked?.push(args), cut)) as SectionDeps['query'],
    now: () => new Date('2026-11-04T10:00:00Z'),
    ...rest
  }
}

describe('makeSectionDrawing', () => {
  it('asks the kernel for the plane on screen within 0.01 mm, and draws what it answers', async () => {
    const asked: unknown[] = []
    const made = await makeSectionDrawing(deps({ asked }), 'hollow')
    expect(asked).toEqual([{ layout: 'assembly', plane: { origin: [0, 0, 10], normal: [0, 0, 1] }, deflection: 0.01 }])
    expect(made.revision).toBe(4)
    expect(made.svg).toContain('tub 800 mm²')
  })

  it('names the parts that are on only when some are switched off', async () => {
    const asked: unknown[] = []
    await makeSectionDrawing(deps({ asked, view: () => view({ visible: ['assembly:tub'] }) }), 'hollow')
    expect(asked[0]).toMatchObject({ parts: ['tub'] })
  })

  it('refuses with a sentence: no section, no build, no such project, a plane that cuts nothing, a build that landed meanwhile', async () => {
    await expect(makeSectionDrawing(deps({ view: () => view({ section: null }) }), 'hollow')).rejects.toThrow(NO_SECTION)
    await expect(makeSectionDrawing(deps({ last: () => undefined }), 'hollow')).rejects.toThrow(NOT_BUILT)
    await expect(makeSectionDrawing(deps(), 'nothing')).rejects.toThrow('There is no project of that name')
    await expect(makeSectionDrawing(deps({ query: (async () => ({ ...cut, parts: [], bounds: null })) as SectionDeps['query'] }), 'hollow')).rejects.toThrow(NOTHING_CUT)
    let revision = 4
    await expect(makeSectionDrawing(deps({ last: () => ({ revision, scene }), query: (async () => ((revision = 5), cut)) as SectionDeps['query'] }), 'hollow')).rejects.toThrow(NEW_BUILD)
  })

  it('leaves the source out until torno knows it', async () => {
    expect((await makeSectionDrawing(deps(), 'hollow')).svg).not.toContain('Source')
    expect((await makeSectionDrawing(deps({ source: () => 'abc123' }), 'hollow')).svg).toContain('abc123')
  })
})

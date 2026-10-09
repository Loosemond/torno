import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import type { Described } from '../../shared/geometry'
import type { Anchor, Mark, MarkPatch, NewMark } from '../../shared/marks'
import type { Camera, LookRequest, LookResult, ShowRequest, ViewState } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import type { NearestAnchor } from '../marks/reanchor'
import { addMarkTool, highlightTool, resolveMarkTool } from './markTools'
import { describeTool, lookTool, marksTool, sceneTool, showTool, TOOLS, type ToolDeps } from './tools'

const BRACKET: ObjectInfo = { id: 'bracket', name: 'bracket', dir: '/ws/bracket', model: 'bracket.py' }
const STAND: ObjectInfo = { id: 'helmet-stand', name: 'helmet-stand', dir: '/ws/helmet-stand', model: 'stand.py' }

function part(layout: string, name: string, min: [number, number, number], max: [number, number, number], more: Partial<Part> = {}): Part {
  return { key: `${layout}:${name}`, name, layout, bbox: { min, max }, volume: 6000, faceCount: 6, edgeCount: 12, valid: true, ...more } as Part
}

const SCENE: Scene = {
  model: 'bracket.py',
  layouts: ['assembly', 'print'],
  parts: [
    part('assembly', 'base', [-20, -15, -2.5], [20, 15, 2.5]),
    part('assembly', 'post', [-4.0000001, -3.999, 2.5], [4, 4, 22.50499], { volume: 1005.3096491, faceCount: 3, edgeCount: 3, valid: false }),
    part('print', 'base', [-20, -15, -2.5], [20, 15, 2.5]),
    part('print', 'post', [56, -10, 0], [64, 10, 8])
  ],
  seconds: 0.8123,
  output: ''
}

const CAMERA: Camera = { position: [100.123456, -80, 60], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const VIEW: ViewState = { objectId: 'bracket', layout: 'assembly', camera: CAMERA, visible: ['assembly:base'] }
const OK: BuildState = { objectId: 'bracket', status: 'ok', revision: 3, seconds: 0.8123, stale: false }
const PICTURE: LookResult = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  width: 1280,
  height: 960,
  caption: 'view iso · layout assembly · parts base, post · orthographic · 1280×960',
  objectId: 'bracket',
  revision: 3,
  stale: false
}

const MARK_BASE = { author: 'user', note: '', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 3, camera: CAMERA, createdAt: '2026-10-09T12:00:00.000Z', checkedRevision: 3 } as const
const FACE: Described = { kind: 'face', ref: 'assembly:base/F5', type: 'plane', area: 1200.00004, center: [0, 0, 2.5], normal: [0, 0, 1], radius: null, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }
const EDGE: Described = { kind: 'edge', ref: 'assembly:base/E7', type: 'line', length: 40, center: [0, 15, 2.5], descriptor: 'line, 40 mm' }
const WHOLE: Described = { kind: 'part', key: 'assembly:base', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, volume: 6000, area: 3100, faceCount: 6, edgeCount: 12, valid: true, descriptor: 'part, 40 × 30 × 5 mm, 6000 mm³, 6 faces' }

/** The marks, the kernel and the window, as far as the tools ask: what was asked of each is kept. */
interface World {
  list: Mark[]
  added: NewMark[]
  updates: Array<{ id: string; patch: MarkPatch }>
  /** What else the kernel says of each point: what it lies on, the edge under it. */
  near: object
  described: Array<{ layout: string; ref: string }>
  asked: Array<{ layout: string; anchors: Array<{ part: string; point: number[]; edge?: string }> }>
  /** How far from the edge it names the kernel finds a point. */
  edgeDistance: number | undefined
  shows: ShowRequest[]
  highlights: Array<{ layout: string; refs: string[]; note?: string }>
  /** How far from the surface the kernel finds each point asked about. */
  distance: (part: string, point: number[]) => number
}

function world(): Pick<ToolDeps, 'marks' | 'addMark' | 'updateMark' | 'describe' | 'nearest' | 'show' | 'highlight'> & { w: World } {
  const w: World = {
    list: [
      { ...MARK_BASE, id: 'M1', kind: 'pin', note: 'here', anchor: { point: [1.00000004, 2, 2.5], part: 'base', ref: 'base/F5', descriptor: FACE.descriptor } },
      { ...MARK_BASE, id: 'M2', kind: 'stroke', space: 'plane', status: 'sent', anchor: { point: [0, 40, 0] }, plane: { origin: [0, 40, 0], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 40.0' }, points2d: [[0, 0], [10, 5]] },
      { ...MARK_BASE, id: 'M3', kind: 'pin', status: 'resolved', layout: 'print', anchor: { point: [60, 0, 8], part: 'post', ref: 'post/F1' } },
      { ...MARK_BASE, id: 'M4', kind: 'pin', author: 'agent', status: 'sent', anchor: { point: [9, 9, 9] } }
    ],
    added: [],
    updates: [],
    described: [],
    asked: [],
    shows: [],
    highlights: [],
    distance: () => 0,
    edgeDistance: 0,
    near: {}
  }
  return {
    w,
    marks: async () => structuredClone(w.list),
    addMark: async (_objectId, mark) => {
      w.added.push(mark)
      return { ...mark, id: `M${w.list.length + w.added.length}`, status: 'sent', anchorState: 'ok', createdAt: MARK_BASE.createdAt } as Mark
    },
    updateMark: async (_objectId, id, patch) => {
      const mark = w.list.find((m) => m.id === id)
      if (!mark) throw new Error(`no mark ${id}; marks: ${w.list.map((m) => m.id).join(', ')}`)
      w.updates.push({ id, patch })
      return { ...mark, ...patch } as Mark
    },
    describe: async (_objectId, layout, ref) => {
      w.described.push({ layout, ref })
      return ref.includes('/F') ? { ...FACE, ref: `${layout}:${ref}` } : ref.includes('/E') ? { ...EDGE, ref: `${layout}:${ref}` } : { ...WHOLE, key: `${layout}:${ref}` }
    },
    nearest: async (_objectId, layout, anchors) => {
      w.asked.push({ layout, anchors })
      return anchors.map(({ part, point, edge }) => ({
        part,
        found: true,
        point: [point[0], point[1], 2.5],
        normal: [0, 0, 1],
        ref: `${part}/F5`,
        distance: w.distance(part, point),
        descriptor: `nearest of ${part}`,
        ...(edge === undefined || w.edgeDistance === undefined ? {} : { edgeFound: true, edgeDistance: w.edgeDistance, edgeDescriptor: 'line, 40 mm', edgeBetween: [`${part}/F2`, `${part}/F5`] }),
        ...w.near
      })) as NearestAnchor[]
    },
    show: async (objectId, req) => {
      w.shows.push(req)
      return { caption: 'view top · layout assembly · parts base, post · orthographic', objectId, revision: 3, stale: false }
    },
    highlight: async (objectId, layout, refs, note) => {
      w.highlights.push({ layout, refs, ...(note === undefined ? {} : { note }) })
      return { objectId, layout, refs, revision: 3 }
    }
  }
}

interface Fake extends ToolDeps {
  w: World
  looks: Array<{ objectId: string; req: LookRequest }>
  saved: Array<{ objectId: string; png: Uint8Array }>
}

function fake(over: Partial<ToolDeps> & { state?: BuildState | null; noScene?: boolean } = {}): Fake {
  const looks: Fake['looks'] = []
  const saved: Fake['saved'] = []
  return {
    looks,
    saved,
    object: (id) => [BRACKET, STAND].find((o) => o.id === id),
    build: (id) => (id === 'bracket' ? (over.state === null ? undefined : (over.state ?? OK)) : undefined),
    scene: (id) => (id === 'bracket' && !over.noScene ? { revision: (over.state ?? OK).revision, scene: SCENE } : undefined),
    view: (id) => (id === 'bracket' ? VIEW : undefined),
    openObjectId: () => 'bracket',
    look: async (objectId, req) => {
      looks.push({ objectId, req })
      return { ...PICTURE, revision: (over.state ?? OK).revision, stale: (over.state ?? OK).stale }
    },
    saveImage: async (objectId, png) => {
      saved.push({ objectId, png })
      return `/ws/${objectId}/.torno/views/${saved.length}.png`
    },
    // The kernel's own queries and the drawing of a section are the read tools': see readTools.test.ts.
    addDimension: async () => Promise.reject(new Error('no dimension was expected to be added')),
    query: async () => Promise.reject(new Error('the kernel was not expected to be asked')),
    sectionDrawing: async () => Promise.reject(new Error('no drawing was expected to be asked for')),
    ...world(),
    ...over
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

describe('the tool descriptions', () => {
  it('say in two or three sentences each what the tool returns and when to use it', () => {
    expect(Object.keys(TOOLS)).toEqual(['scene', 'look', 'marks', 'describe', 'highlight', 'show', 'add_mark', 'resolve_mark', 'measure', 'section', 'check'])
    for (const tool of Object.values(TOOLS)) {
      expect(tool.description).toMatch(/^Returns /)
      const sentences = tool.description.match(/[.?!]"?(\s|$)/g)!.length
      expect(sentences).toBeGreaterThanOrEqual(2)
      expect(sentences).toBeLessThanOrEqual(3)
    }
  })

  it('marks says which marks have not been checked against the build as the code does: no checkedRevision, or any other than the revision', () => {
    expect(TOOLS.marks.description).toContain('a checkedRevision that is absent or is not the revision means')
    expect(TOOLS.marks.description).not.toContain('lower than')
  })

  it('say where refs come from, that show changes what the user sees, and what highlight is for', () => {
    for (const tool of [TOOLS.describe, TOOLS.add_mark]) expect(tool.description).toContain('marks, scene and')
    expect(TOOLS.show.description).toMatch(/moves the user's own camera/)
    expect(TOOLS.highlight.description).toContain('"this one?"')
  })
})

describe('scene', () => {
  it('is one text block of JSON: the build, the layouts, the parts and the camera', () => {
    const result = sceneTool(fake(), 'bracket')
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(textOf(result))).toEqual({
      object: 'bracket',
      model: 'bracket.py',
      build: { status: 'ok', revision: 3, seconds: 0.81, stale: false },
      layout: 'assembly',
      layouts: ['assembly', 'print'],
      parts: [
        { name: 'base', layout: 'assembly', visible: true, size: [40, 30, 5], bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, volume: 6000, faces: 6, edges: 12, valid: true },
        { name: 'post', layout: 'assembly', visible: false, size: [8, 8, 20], bbox: { min: [-4, -4, 2.5], max: [4, 4, 22.5] }, volume: 1005.31, faces: 3, edges: 3, valid: false },
        { name: 'base', layout: 'print', visible: true, size: [40, 30, 5], bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, volume: 6000, faces: 6, edges: 12, valid: true },
        { name: 'post', layout: 'print', visible: false, size: [8, 20, 8], bbox: { min: [56, -10, 0], max: [64, 10, 8] }, volume: 6000, faces: 6, edges: 12, valid: true }
      ],
      camera: { position: [100.12, -80, 60], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
      section: null
    })
  })

  it('carries the kind, the message and the last 30 lines of the traceback of a failed build, with the parts still shown', () => {
    const traceback = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n')
    const state: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, seconds: 0.1, stale: true, error: { kind: 'exception', message: 'ValueError: no', traceback, output: 'printed' } }
    const scene = JSON.parse(textOf(sceneTool(fake({ state }), 'bracket')))
    expect(scene.build).toEqual({
      status: 'failed',
      revision: 3,
      seconds: 0.1,
      stale: true,
      error: { kind: 'exception', message: 'ValueError: no', traceback: Array.from({ length: 30 }, (_, i) => `line ${i + 16}`).join('\n') }
    })
    expect(scene.parts).toHaveLength(4)
  })

  it('for an object that is not the one open: its build and parts, no camera, no visibility, and a note saying so', () => {
    const scene = JSON.parse(textOf(sceneTool(fake({ openObjectId: () => 'helmet-stand' }), 'bracket')))
    expect(scene.camera).toBeNull()
    expect(scene.layout).toBeNull()
    expect(scene.note).toBe('bracket is not the object open in the torno window (open: helmet-stand), so what is visible, the camera and the section are not known.')
    expect(scene.parts.map((p: { name: string }) => p.name)).toEqual(['base', 'post', 'base', 'post'])
    for (const p of scene.parts) expect(p).not.toHaveProperty('visible')
    expect(scene.build.revision).toBe(3)
  })

  it('says which parts of the print layout were spread along X, and by how much', () => {
    const spread: Scene = {
      ...SCENE,
      parts: [...SCENE.parts.slice(0, 3), part('print', 'post', [30, -10, 0], [38, 10, 8], { arranged: [34.004, 0, 0] })]
    }
    const scene = JSON.parse(textOf(sceneTool(fake({ scene: () => ({ revision: 3, scene: spread }) }), 'bracket')))
    expect(scene.parts.map((p: { arranged?: number[] }) => p.arranged)).toEqual([undefined, undefined, undefined, [34, 0, 0]])
    expect(scene.note).toBe('The parts of the print layout overlapped as the model placed them, so they were spread along X for display; arranged is how far each was moved.')

    // Said together with the other note, when there is one.
    const elsewhere = JSON.parse(textOf(sceneTool(fake({ scene: () => ({ revision: 3, scene: spread }), openObjectId: () => 'helmet-stand' }), 'bracket')))
    expect(elsewhere.note).toBe(
      'bracket is not the object open in the torno window (open: helmet-stand), so what is visible, the camera and the section are not known. The parts of the print layout overlapped as the model placed them, so they were spread along X for display; arranged is how far each was moved.'
    )
  })

  it('is an error for an object the workspace does not have', () => {
    const result = sceneTool(fake(), 'nothing')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('unknown object: nothing')
  })

  it('is an error before the first successful build, saying where the build is', () => {
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 0, stale: false, error: { kind: 'exception', message: "NameError: name 'Boxx' is not defined", traceback: 'a\nb' } }
    const result = sceneTool(fake({ state: failed, noScene: true }), 'bracket')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe("no build yet: failed: NameError: name 'Boxx' is not defined\na\nb")

    const building: BuildState = { objectId: 'bracket', status: 'building', revision: 0, startedAt: 1, stale: false }
    expect(textOf(sceneTool(fake({ state: building, noScene: true }), 'bracket'))).toBe('no build yet: building')

    const never = sceneTool(fake({ state: null, noScene: true }), 'bracket')
    expect(never.isError).toBe(true)
    expect(textOf(never)).toBe('no build yet: bracket has not been opened in the torno window')
  })
})

describe('look', () => {
  it('returns the picture as a PNG image block, and says what it shows and where it was saved', async () => {
    const deps = fake()
    const result = await lookTool(deps, 'bracket', { view: 'iso' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'image', data: Buffer.from(PICTURE.png).toString('base64'), mimeType: 'image/png' })
    expect(textOf(result)).toBe(`${PICTURE.caption}\nrevision r3\nsaved as /ws/bracket/.torno/views/1.png`)
    expect(deps.saved).toEqual([{ objectId: 'bracket', png: PICTURE.png }])
  })

  it('passes the request through, with the default size', async () => {
    const deps = fake()
    await lookTool(deps, 'bracket', {})
    await lookTool(deps, 'bracket', { view: 'top', layout: 'print', parts: ['post'], size: 800 })
    expect(deps.looks).toEqual([
      { objectId: 'bracket', req: { view: 'current', size: 1280 } },
      { objectId: 'bracket', req: { view: 'top', layout: 'print', parts: ['post'], size: 800 } }
    ])
  })

  it('draws the marks unless told not to: the choice is passed on, and left out when it was not made', async () => {
    const deps = fake()
    await lookTool(deps, 'bracket', { marks: false })
    await lookTool(deps, 'bracket', { marks: true })
    expect(deps.looks.map((l) => l.req)).toEqual([
      { view: 'current', size: 1280, marks: false },
      { view: 'current', size: 1280, marks: true }
    ])
    expect(TOOLS.look.inputSchema.marks.description).toBe("Draw the user's and your marks with their numbers. Default true.")
    expect(TOOLS.look.inputSchema.marks.safeParse(undefined).success).toBe(true)
    expect(TOOLS.look.inputSchema.marks.safeParse('yes').success).toBe(false)
  })

  it('clamps the size to 256–2000', async () => {
    const deps = fake()
    for (const size of [10, 5000, 640.6, Number.NaN]) await lookTool(deps, 'bracket', { size })
    expect(deps.looks.map((l) => l.req.size)).toEqual([256, 2000, 641, 1280])
  })

  it('makes a whole camera of a position and a target', async () => {
    const deps = fake()
    await lookTool(deps, 'bracket', { view: { position: [100, 0, 50], target: [0, 0, 10] } })
    await lookTool(deps, 'bracket', { view: { position: [0, 0, 200], target: [0, 0, 0], ortho: true } })
    await lookTool(deps, 'bracket', { view: { position: [0, 50, 0], target: [0, 0, 0], up: [1, 0, 0] } })
    expect(deps.looks.map((l) => l.req.view)).toEqual([
      { position: [100, 0, 50], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
      // Straight down the Z axis, Z cannot be up.
      { position: [0, 0, 200], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 },
      { position: [0, 50, 0], target: [0, 0, 0], up: [1, 0, 0], ortho: false, fov: 35, zoom: 1 }
    ])
  })

  it('refuses a camera whose position is its target', async () => {
    const deps = fake()
    const result = await lookTool(deps, 'bracket', { view: { position: [10, 20, 30], target: [10, 20, 30] } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('position and target are the same')
    expect(deps.looks).toEqual([])
  })

  it('says the parts are stale when the window drew them stale, and why', async () => {
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }
    expect(textOf(await lookTool(fake({ state: failed }), 'bracket', {}))).toContain('\nrevision r3, stale: the latest build failed, so these are still the parts of r3\n')
    const building: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 1, stale: true }
    expect(textOf(await lookTool(fake({ state: building }), 'bracket', {}))).toContain('\nrevision r3, stale: a build is running, so these are still the parts of r3\n')
  })

  it('captions the picture with the revision the window drew, not the one built while the picture was made', async () => {
    // The build of r4 lands between the request and the reply: the picture is still of r3.
    let state: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 1, stale: true }
    const deps = fake({
      build: () => state,
      scene: () => ({ revision: state.revision, scene: SCENE }),
      look: async () => {
        const drawn = { ...PICTURE, revision: 3, stale: true }
        state = { objectId: 'bracket', status: 'ok', revision: 4, seconds: 1, stale: false }
        return drawn
      }
    })
    const result = await lookTool(deps, 'bracket', {})
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe(`${PICTURE.caption}\nrevision r3, stale: r4 was built while this picture was made; look again to see it\nsaved as /ws/bracket/.torno/views/1.png`)
  })

  it('says so when a picture drawn fresh has been overtaken by a newer build', async () => {
    let revision = 3
    const deps = fake({
      scene: () => ({ revision, scene: SCENE }),
      look: async () => {
        revision = 4
        return PICTURE
      }
    })
    expect(textOf(await lookTool(deps, 'bracket', {}))).toContain('\nrevision r3, stale: r4 was built while this picture was made; look again to see it\n')
  })

  it('still returns the picture when it cannot be saved', async () => {
    const result = await lookTool(fake({ saveImage: () => Promise.reject(new Error('EACCES: permission denied')) }), 'bracket', {})
    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe('image')
    expect(textOf(result)).toBe(`${PICTURE.caption}\nrevision r3\nnot saved: EACCES: permission denied`)
  })

  it('is an error for an object the workspace does not have', async () => {
    const deps = fake()
    const result = await lookTool(deps, 'nothing', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('unknown object: nothing')
    expect(deps.looks).toEqual([])
  })

  it('is an error before the first successful build', async () => {
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 0, stale: false, error: { kind: 'no_model', message: 'no model file in /ws/bracket' } }
    const deps = fake({ state: failed, noScene: true })
    const result = await lookTool(deps, 'bracket', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('no build yet: failed: no model file in /ws/bracket')
    expect(deps.looks).toEqual([])
  })

  it('is an error for an object that is not the one open in the window, which is not asked', async () => {
    const deps = fake({ openObjectId: () => 'helmet-stand' })
    const result = await lookTool(deps, 'bracket', { view: 'iso' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('bracket is not the object open in the torno window (open: helmet-stand). Ask the user to open it.')
    expect(deps.looks).toEqual([])

    expect(textOf(await lookTool(fake({ openObjectId: () => null }), 'bracket', {}))).toBe(
      'bracket is not the object open in the torno window (open: none). Ask the user to open it.'
    )
  })

  it('is an error when the picture the window made is of another object', async () => {
    // Main still takes bracket for the open object; the window had already moved on.
    const deps = fake({ look: async () => ({ ...PICTURE, objectId: 'helmet-stand' }) })
    const result = await lookTool(deps, 'bracket', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('bracket is not the object open in the torno window (open: helmet-stand). Ask the user to open it.')
    expect(deps.saved).toEqual([])
  })

  it('passes on what the window says of an unknown part, and of not answering', async () => {
    const unknown = "unknown part 'lid'; parts in layout assembly: base, post"
    const result = await lookTool(fake({ look: () => Promise.reject(new Error(unknown)) }), 'bracket', { parts: ['lid'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(unknown)

    const late = await lookTool(fake({ look: () => Promise.reject(new Error('the torno window did not answer within 10 s')) }), 'bracket', {})
    expect(late.isError).toBe(true)
    expect(textOf(late)).toBe('the torno window did not answer within 10 s')
  })
})

/** What a tool that places a mark says, without the line that says which build it was placed on. */
const said = (result: { content: Array<{ type: string; text?: string }> }): string => textOf(result).replace(/\nrevision r\d+.*$/, '')

const jsonOf = (result: { content: Array<{ type: string; text?: string }> }): any => JSON.parse(textOf(result))

describe('marks', () => {
  it('is JSON of every mark with all its fields, a stroke with its points', async () => {
    const deps = fake()
    const result = await marksTool(deps, 'bracket', {})
    expect(result.isError).toBeUndefined()
    const { marks } = jsonOf(result)
    expect(marks.map((m: Mark) => m.id)).toEqual(['M1', 'M2', 'M3', 'M4'])
    // What modelling leaves in the last digits is not passed on.
    expect(marks[0]).toEqual({
      ...deps.w.list[0],
      anchor: { ...(deps.w.list[0] as { anchor: object }).anchor, point: [1, 2, 2.5] },
      camera: { ...CAMERA, position: [100.1235, -80, 60] },
      line: 'M1 pin on base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (1, 2, 2.5): "here"'
    })
    expect(marks[1]).toMatchObject({ kind: 'stroke', plane: { label: 'XZ at y = 40.0' }, points2d: [[0, 0], [10, 5]] })
  })

  it('gives each mark its line, which says of one that moved only where it was placed', async () => {
    const deps = fake()
    deps.w.list[0] = { ...deps.w.list[0], anchorState: 'drifted' } as Mark
    const [moved] = jsonOf(await marksTool(deps, 'bracket', {})).marks
    // The ref and the descriptor are there side by side, and may be of two things: the line does not pair them.
    expect(moved).toMatchObject({ anchorState: 'drifted', anchor: { ref: 'base/F5', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' } })
    expect(moved.line).toBe('M1 pin placed on base/F5 at (1, 2, 2.5): "here" [moved since it was placed: check it]')
    expect(jsonOf(await describeTool(deps, 'bracket', { ref: 'M1' })).mark.line).toBe(moved.line)
    expect(TOOLS.marks.description).toContain('anchorState')
  })

  it('gives a dimension a value in its data only where its line gives one: measured on that build, and measurable', async () => {
    const dim = (n: number, over: object = {}): Mark =>
      ({ ...MARK_BASE, id: `M${n}`, status: 'sent', note: '', kind: 'dimension', measure: 'diameter', a: { point: [-6, 5, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder', points: [[-14, 5, 0], [-6, 5, 0]], measuredRevision: 3, checkedRevision: 3, expected: 8, verdict: 'pass', ...over }) as Mark
    const deps = fake()
    deps.w.list = [dim(1), dim(2, { measuredRevision: 2 }), dim(3, { anchorState: 'orphaned' }), dim(4, { anchorState: 'drifted' }), dim(5, { value: undefined, how: undefined, points: undefined, verdict: undefined, refused: 'base/F9 is a plane face: it has no diameter' })]
    const { marks } = jsonOf(await marksTool(deps, 'bracket', {}))
    // Measured on r3, the build the answer is of.
    expect(marks[0]).toMatchObject({ value: 8, how: 'cylinder', verdict: 'pass', points: [[-14, 5, 0], [-6, 5, 0]], line: 'M1 diameter 8 mm, base/F9 (expected 8 ± 0.05: pass)' })
    // Measured on r2: nothing in the data says 8 is its value, or that it passes.
    for (const key of ['value', 'how', 'points', 'verdict']) expect(marks[1]).not.toHaveProperty(key)
    expect(marks[1]).toMatchObject({ expected: 8, wasValue: 8, wasRevision: 2, line: 'M2 diameter: not measured on r3 (was 8 mm on r2), base/F9 (expected 8 ± 0.05)' })
    // Its part gone.
    for (const key of ['value', 'how', 'points', 'verdict', 'wasValue']) expect(marks[2]).not.toHaveProperty(key)
    expect(marks[2].line).toBe('M3 diameter: not measurable, [its part is gone]')
    // Moved, and measured from what is under it now: the value stands, and the line says to check it.
    expect(marks[3]).toMatchObject({ value: 8, verdict: 'pass', anchorState: 'drifted', line: 'M4 diameter 8 mm, base/F9 (expected 8 ± 0.05: pass) [moved since it was placed: check it]' })
    expect(marks[4]).toMatchObject({ refused: 'base/F9 is a plane face: it has no diameter' })
    expect(marks[4]).not.toHaveProperty('value')
    // `describe M<n>` says the same.
    const described = jsonOf(await describeTool(deps, 'bracket', { ref: 'M2' })).mark
    expect(described).toEqual(marks[1])
    // While another build runs, r3 is still what the values are of.
    expect(jsonOf(await marksTool({ ...deps, build: () => ({ objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true }) }, 'bracket', {})).marks[0]).toMatchObject({ value: 8 })
  })

  it('before any build of the run, gives no dimension a value', async () => {
    const deps = fake({ state: null, noScene: true })
    deps.w.list = [{ ...MARK_BASE, id: 'M1', status: 'sent', note: '', kind: 'dimension', measure: 'diameter', a: { point: [-6, 5, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder', expected: 8, verdict: 'pass' } as Mark]
    const [mark] = jsonOf(await marksTool(deps, 'bracket', {})).marks
    for (const key of ['value', 'verdict', 'wasRevision']) expect(mark).not.toHaveProperty(key)
    expect(mark).toMatchObject({ wasValue: 8, line: 'M1 diameter: not measured (was 8 mm on an earlier build), base/F9 (expected 8 ± 0.05)' })
  })

  it('keeps to one status when asked, and open is all that are not resolved', async () => {
    const ids = async (status: 'draft' | 'sent' | 'resolved' | 'open') => jsonOf(await marksTool(fake(), 'bracket', { status })).marks.map((m: Mark) => m.id)
    expect(await ids('draft')).toEqual(['M1'])
    expect(await ids('sent')).toEqual(['M2', 'M4'])
    expect(await ids('resolved')).toEqual(['M3'])
    expect(await ids('open')).toEqual(['M1', 'M2', 'M4'])
  })

  it('needs no build, and says when the object is unknown or its marks cannot be read', async () => {
    const unbuilt = jsonOf(await marksTool(fake({ state: null, noScene: true }), 'bracket', {}))
    expect(unbuilt.marks).toHaveLength(4)
    expect(unbuilt.revision).toBeNull()
    expect(await marksTool(fake(), 'nothing', {})).toEqual({ isError: true, content: [{ type: 'text', text: 'unknown object: nothing' }] })
    const unreadable = fake({ marks: async () => Promise.reject(new Error('EACCES: permission denied')) })
    expect(await marksTool(unreadable, 'bracket', {})).toMatchObject({ isError: true, content: [{ text: 'EACCES: permission denied' }] })
  })
})

describe('which build a reply is of', () => {
  const BUILDING: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true }
  const FAILED: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }

  it('marks says the revision, and that it is the last that worked while another is built or has failed', async () => {
    expect(jsonOf(await marksTool(fake(), 'bracket', {}))).toMatchObject({ revision: 3 })
    expect(jsonOf(await marksTool(fake(), 'bracket', {}))).not.toHaveProperty('stale')
    expect(jsonOf(await marksTool(fake({ state: BUILDING }), 'bracket', {})).stale).toBe('a build is running, so this is still what is known of r3: refs and descriptors may not hold for the model as it now is')
    expect(jsonOf(await marksTool(fake({ state: FAILED }), 'bracket', {})).stale).toBe('the latest build failed, so this is still what is known of r3: refs and descriptors may not hold for the model as it now is')
  })

  it('marks says in the line of a mark that nothing has checked it against that build', async () => {
    const deps = fake()
    deps.w.list[0] = { ...deps.w.list[0], checkedRevision: 2 } as Mark
    const reply = jsonOf(await marksTool(deps, 'bracket', {}))
    expect(reply.marks[0]).toMatchObject({ checkedRevision: 2, line: 'M1 pin on base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (1, 2, 2.5): "here" [not checked against r3]' })
    expect(jsonOf(await describeTool(deps, 'bracket', { ref: 'M1' }))).toMatchObject({ revision: 3, mark: { line: reply.marks[0].line } })
    expect(TOOLS.marks.description).toContain('checkedRevision')
  })

  it('describe says the same of a ref, and of a mark', async () => {
    expect(jsonOf(await describeTool(fake(), 'bracket', { ref: 'base/F5' }))).not.toHaveProperty('stale')
    const building = jsonOf(await describeTool(fake({ state: BUILDING }), 'bracket', { ref: 'base/F5' }))
    expect(building).toMatchObject({ revision: 3, stale: expect.stringContaining('a build is running, so this is still what is known of r3') })
    expect(jsonOf(await describeTool(fake({ state: FAILED }), 'bracket', { ref: 'M1' }))).toMatchObject({ revision: 3, stale: expect.stringContaining('the latest build failed'), mark: { id: 'M1' } })
  })

  it('add_mark says it after the mark it placed', async () => {
    const fresh = textOf(await addMarkTool(fake(), 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5' }))
    expect(fresh.split('\n').at(-1)).toBe('revision r3')
    const building = textOf(await addMarkTool(fake({ state: BUILDING }), 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5' }))
    expect(building.split('\n').at(-1)).toBe('revision r3, stale: a build is running, so the mark was placed on the parts of r3; it is checked against the next build that works')
    const failed = textOf(await addMarkTool(fake({ state: FAILED }), 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5' }))
    expect(failed.split('\n').at(-1)).toBe('revision r3, stale: the latest build failed, so the mark was placed on the parts of r3; it is checked against the next build that works')
  })
})

describe('describe', () => {
  it("is the kernel's reply as JSON, for the layout on screen", async () => {
    const deps = fake()
    const result = await describeTool(deps, 'bracket', { ref: 'base/F5' })
    expect(result.isError).toBeUndefined()
    expect(jsonOf(result)).toEqual({ layout: 'assembly', revision: 3, ...FACE, area: 1200 })
    expect(deps.w.described).toEqual([{ layout: 'assembly', ref: 'base/F5' }])
  })

  it('asks in the layout named, and of a whole part or an edge alike', async () => {
    const deps = fake()
    expect(jsonOf(await describeTool(deps, 'bracket', { ref: 'post', layout: 'print' }))).toMatchObject({ layout: 'print', kind: 'part', key: 'print:post' })
    expect(jsonOf(await describeTool(deps, 'bracket', { ref: 'base/E11' }))).toMatchObject({ kind: 'edge', descriptor: 'line, 40 mm' })
    expect(deps.w.described).toEqual([
      { layout: 'print', ref: 'post' },
      { layout: 'assembly', ref: 'base/E11' }
    ])
  })

  it('uses the first layout for an object the window does not show', async () => {
    const deps = fake({ openObjectId: () => 'helmet-stand' })
    expect(jsonOf(await describeTool(deps, 'bracket', { ref: 'base' })).layout).toBe('assembly')
  })

  it('returns a mark for its number, built or not', async () => {
    const result = await describeTool(fake({ state: null, noScene: true }), 'bracket', { ref: 'M2' })
    expect(jsonOf(result)).toMatchObject({ revision: null, mark: { id: 'M2', kind: 'stroke', points2d: [[0, 0], [10, 5]] } })
    expect(await describeTool(fake(), 'bracket', { ref: 'M9' })).toEqual({ isError: true, content: [{ type: 'text', text: 'no mark M9; marks: M1, M2, M3, M4' }] })
  })

  it.each([
    [{ ref: 'lid' }, "no part 'lid' in layout assembly (parts: base, post)"],
    [{ ref: 'lid/F2' }, "no part 'lid' in layout assembly (parts: base, post)"],
    [{ ref: 'base/F6' }, 'base has 6 faces, F0 to F5: there is no F6'],
    [{ ref: 'post/E3' }, 'post has 3 edges, E0 to E2: there is no E3'],
    [{ ref: 'base/top' }, "no part 'base/top' in layout assembly (parts: base, post); a ref is a part, part/F<n> or part/E<n>"],
    [{ ref: 'base', layout: 'exploded' }, "no layout 'exploded'; layouts: assembly, print"]
  ])('says what there is when %o names nothing', async (args, text) => {
    const deps = fake()
    expect(await describeTool(deps, 'bracket', args)).toEqual({ isError: true, content: [{ type: 'text', text }] })
    expect(deps.w.described).toEqual([])
  })

  it('passes on what the kernel says when it cannot answer, and that there is no build', async () => {
    const failing = fake({ describe: async () => Promise.reject(new Error('the kernel did not answer within 30 s')) })
    expect(await describeTool(failing, 'bracket', { ref: 'base' })).toMatchObject({ isError: true, content: [{ text: 'the kernel did not answer within 30 s' }] })
    expect(textOf(await describeTool(fake({ state: null, noScene: true }), 'bracket', { ref: 'base' }))).toBe('no build yet: bracket has not been opened in the torno window')
    expect(textOf(await describeTool(fake(), 'nothing', { ref: 'base' }))).toBe('unknown object: nothing')
  })
})

describe('highlight', () => {
  it('has the window tint the refs, with the note, and says what was highlighted', async () => {
    const deps = fake()
    const result = await highlightTool(deps, 'bracket', { refs: ['base/F5', 'post', 'base/E0'], note: ' this one? ' })
    expect(result.isError).toBeUndefined()
    expect(deps.w.highlights).toEqual([{ layout: 'assembly', refs: ['base/F5', 'post', 'base/E0'], note: 'this one?' }])
    expect(textOf(result)).toBe('highlighted base/F5, post, base/E0 in layout assembly for the user, with the note "this one?", until they click in the viewport or 60 s pass.')
  })

  it('takes a mark number for what the mark is on, once', async () => {
    const deps = fake()
    const result = await highlightTool(deps, 'bracket', { refs: ['M1', 'base/F5'] })
    expect(deps.w.highlights).toEqual([{ layout: 'assembly', refs: ['base/F5'] }])
    expect(textOf(result)).toBe('highlighted base/F5 in layout assembly for the user, until they click in the viewport or 60 s pass.')
  })

  it('highlights nothing when a ref does not exist, and names each with what there is', async () => {
    const deps = fake()
    const result = await highlightTool(deps, 'bracket', { refs: ['base/F5', 'lid/F1', 'post/F3', 'M9', 'M3', 'M4'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      "nothing was highlighted: no part 'lid' in layout assembly (parts: base, post); post has 3 faces, F0 to F2: there is no F3; no mark M9 (marks: M1, M2, M3, M4); M3 is in layout print, not assembly; M4 is not on a part, a face or an edge"
    )
    expect(deps.w.highlights).toEqual([])
  })

  it('says so when a mark is on a face the build no longer has', async () => {
    const deps = fake()
    deps.w.list[0] = { ...deps.w.list[0], anchor: { point: [0, 0, 0], part: 'base', ref: 'base/F40' } } as Mark
    expect(textOf(await highlightTool(deps, 'bracket', { refs: ['M1'] }))).toBe('nothing was highlighted: M1 is on base/F40, but base has 6 faces, F0 to F5: there is no F40')
  })

  it('does not point at where a mark was, once the mark has moved or lost its part', async () => {
    const deps = fake()
    deps.w.list[0] = { ...deps.w.list[0], anchorState: 'drifted' } as Mark
    deps.w.list[1] = { ...MARK_BASE, id: 'M2', kind: 'pick', target: 'edge', anchorState: 'orphaned', anchor: { point: [0, 0, 0], part: 'base', ref: 'base/E7' } }
    const result = await highlightTool(deps, 'bracket', { refs: ['base/F1', 'M1', 'M2'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      'nothing was highlighted: M1 was placed on base/F5, which has moved since: the ref may name something else now; the part M2 was placed on is gone'
    )
    expect(deps.w.highlights).toEqual([])
  })

  it('cuts the note at 2000 characters', async () => {
    const deps = fake()
    await highlightTool(deps, 'bracket', { refs: ['base'], note: 'n'.repeat(5000) })
    expect(deps.w.highlights[0].note).toHaveLength(2000)
  })

  it('refuses an object that is not the one open in the window, an unknown layout, and no build', async () => {
    const elsewhere = fake({ openObjectId: () => 'helmet-stand' })
    expect(textOf(await highlightTool(elsewhere, 'bracket', { refs: ['base'] }))).toBe('bracket is not the object open in the torno window (open: helmet-stand). Ask the user to open it.')
    expect(elsewhere.w.highlights).toEqual([])
    expect(textOf(await highlightTool(fake(), 'bracket', { refs: ['base'], layout: 'exploded' }))).toBe("no layout 'exploded'; layouts: assembly, print")
    expect((await highlightTool(fake({ state: null, noScene: true }), 'bracket', { refs: ['base'] })).isError).toBe(true)
  })

  it("answers with the window's own words when it cannot, and says when the window had moved on", async () => {
    const refusing = fake({ highlight: async () => Promise.reject(new Error('layout print is not the one on screen (assembly): call show with that layout first')) })
    expect(await highlightTool(refusing, 'bracket', { refs: ['base'], layout: 'print' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'layout print is not the one on screen (assembly): call show with that layout first' }]
    })
    const hidden = fake({ highlight: async () => Promise.reject(new Error('nothing was highlighted: post is hidden, so the user would see nothing of it. Call show with parts ["base","post"] first, which changes what the user sees')) })
    expect(await highlightTool(hidden, 'bracket', { refs: ['post'] })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'nothing was highlighted: post is hidden, so the user would see nothing of it. Call show with parts ["base","post"] first, which changes what the user sees' }]
    })
    const moved = fake({ highlight: async (_id, layout, refs) => ({ objectId: 'helmet-stand', layout, refs, revision: 1 }) })
    expect(textOf(await highlightTool(moved, 'bracket', { refs: ['base'] }))).toBe('bracket is not the object open in the torno window (open: helmet-stand). Ask the user to open it.')
    const newer = fake({ highlight: async (objectId, layout, refs) => ({ objectId, layout, refs, revision: 4 }) })
    expect(textOf(await highlightTool(newer, 'bracket', { refs: ['base'] }))).toContain('The window shows r4, not r3: check the refs with describe.')
  })
})

describe('show', () => {
  it("changes the user's view and answers with the caption a look would have", async () => {
    const deps = fake()
    const result = await showTool(deps, 'bracket', { view: 'top', layout: 'print', parts: ['post'] })
    expect(result.isError).toBeUndefined()
    expect(deps.w.shows).toEqual([{ objectId: 'bracket', view: 'top', layout: 'print', parts: ['post'] }])
    expect(textOf(result)).toBe("view top · layout assembly · parts base, post · orthographic\nrevision r3\nThe user's viewport now shows this.")
  })

  it('makes a camera of a position and a target', async () => {
    const deps = fake()
    await showTool(deps, 'bracket', { view: { position: [0, 0, 100], target: [0, 0, 0] } })
    expect(deps.w.shows).toEqual([{ objectId: 'bracket', view: { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0], ortho: false, fov: 35, zoom: 1 } }])
  })

  it.each([
    [{}, 'nothing to show: give a view, a layout, parts or a section'],
    [{ layout: 'exploded' }, "no layout 'exploded'; layouts: assembly, print"],
    [{ parts: [] }, 'parts is empty: name the parts to leave switched on'],
    [{ view: { position: [1, 1, 1], target: [1, 1, 1] } }, 'position and target are the same']
  ] as const)('changes nothing for %o', async (args, text) => {
    const deps = fake()
    expect(await showTool(deps, 'bracket', args as never)).toEqual({ isError: true, content: [{ type: 'text', text }] })
    expect(deps.w.shows).toEqual([])
  })

  it('refuses an object that is not the one open in the window', async () => {
    const deps = fake({ openObjectId: () => null })
    expect(textOf(await showTool(deps, 'bracket', { view: 'top' }))).toBe('bracket is not the object open in the torno window (open: none). Ask the user to open it.')
    expect(deps.w.shows).toEqual([])
  })

  it("answers with the window's own words when it cannot, and says when what it shows is stale", async () => {
    const refusing = fake({ show: async () => Promise.reject(new Error("unknown part 'lid'; parts in layout assembly: base, post")) })
    expect(await showTool(refusing, 'bracket', { parts: ['lid'] })).toEqual({ isError: true, content: [{ type: 'text', text: "unknown part 'lid'; parts in layout assembly: base, post" }] })
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }
    const stale = fake({ state: failed, show: async (objectId) => ({ caption: 'view top', objectId, revision: 3, stale: true }) })
    expect(textOf(await showTool(stale, 'bracket', { view: 'top' }))).toBe("view top\nrevision r3, stale: the latest build failed, so these are still the parts of r3\nThe user's viewport now shows this.")
  })
})

describe('add_mark', () => {
  it("places a pin at the centre of a face named by ref, as the agent's, on the build it saw", async () => {
    const deps = fake()
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'this face?', ref: 'base/F5' })
    expect(result.isError).toBeUndefined()
    expect(deps.w.described).toEqual([{ layout: 'assembly', ref: 'base/F5' }])
    expect(deps.w.added).toHaveLength(1)
    expect(deps.w.added[0]).toMatchObject({
      kind: 'pin',
      author: 'agent',
      note: 'this face?',
      layout: 'assembly',
      revision: 3,
      anchor: { point: [0, 0, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F5', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }
    })
    // A view of the mark from the side its face looks to.
    expect(deps.w.added[0].camera.target).toEqual([0, 0, 2.5])
    expect(deps.w.added[0].camera.position[2]).toBeGreaterThan(2.5)
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 pin on base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (0, 0, 2.5): "this face?"')
  })

  it('ties a pin given only a point to the part whose surface it is on', async () => {
    const deps = fake()
    deps.w.distance = (part) => (part === 'post' ? 0.1 : 12)
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', point: [3, 1, 20] })
    expect(deps.w.asked).toEqual([{ layout: 'assembly', anchors: [{ part: 'base', point: [3, 1, 20] }, { part: 'post', point: [3, 1, 20] }] }])
    expect(deps.w.added[0]).toMatchObject({ kind: 'pin', anchor: { point: [3, 1, 20], part: 'post', ref: 'post/F5', normal: [0, 0, 1], descriptor: 'nearest of post' } })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 pin on post/F5 (nearest of post) at (3, 1, 20): "here"')
  })

  it('leaves a pin that is on no part in space, and says so', async () => {
    const deps = fake()
    deps.w.distance = () => 30
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'up here', point: [0, 0, 80] })
    expect((deps.w.added[0] as { anchor: object }).anchor).toEqual({ point: [0, 0, 80] })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 pin at (0, 0, 80): "up here"\nThe point is on no part of this layout, so the mark is tied to none.')
  })

  it('by a point the kernel could say nothing of on some part, fails with what the kernel said: the point may be on that part', async () => {
    const answers = (post: object): ToolDeps['nearest'] => async (_objectId, _layout, anchors) =>
      anchors.map(({ part, point }) => (part === 'base' ? { part, found: true, error: 'the point of assembly:base nearest to the anchor is on none of its faces' } : { part, found: true, point, normal: [0, 0, 1], ref: 'post/F5', distance: 30, descriptor: 'nearest of post', ...post })) as NearestAnchor[]
    const deps = fake({ nearest: answers({}) })
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'up here', point: [0, 0, 80] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('the kernel could not say whether (0, 0, 80) is on base: the point of assembly:base nearest to the anchor is on none of its faces. No mark was placed: give a ref.')
    expect(deps.w.added).toEqual([])

    // On a part it could answer for, the point is on that part whatever was not said of the others.
    const onPost = fake({ nearest: answers({ distance: 0.1 }) })
    expect((await addMarkTool(onPost, 'bracket', { kind: 'pin', note: 'here', point: [0, 0, 80] })).isError).toBeUndefined()
    expect(onPost.w.added[0]).toMatchObject({ anchor: { part: 'post', ref: 'post/F5' } })
  })

  it('picks an edge or a whole part by its ref', async () => {
    const deps = fake()
    await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'round this', ref: 'base/E7' })
    await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'too heavy', ref: 'post', layout: 'print' })
    expect(deps.w.added[0]).toMatchObject({ kind: 'pick', target: 'edge', anchor: { point: [0, 15, 2.5], part: 'base', ref: 'base/E7', descriptor: 'line, 40 mm' } })
    expect(deps.w.added[1]).toMatchObject({ kind: 'pick', target: 'part', layout: 'print', anchor: { point: [0, 0, 2.5], part: 'post', ref: 'post', descriptor: 'part, 40 × 30 × 5 mm, 6000 mm³, 6 faces' } })
  })

  it('puts a mark by ref on the surface: at the point of it nearest the centre of the face or the part', async () => {
    const deps = fake()
    // As for a cylinder, whose centre is on its axis: 4 mm from the face itself.
    deps.w.distance = () => 4
    deps.describe = async () => ({ ...FACE, center: [3, 4, 9] })
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5' })
    expect(deps.w.asked).toEqual([{ layout: 'assembly', anchors: [{ part: 'base', point: [3, 4, 9] }] }])
    expect(deps.w.added[0]).toMatchObject({ anchor: { point: [3, 4, 2.5], ref: 'base/F5', normal: [0, 0, 1] } })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 pin on base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (3, 4, 2.5): "here"')
  })

  it('refuses a pick of a face whose centre is not on it, as in the hole of a ring: the mark kept would be of another face', async () => {
    // The fake kernel finds every point on base/F5: the centre of base/F2 is not on base/F2. Far or near, it is refused.
    for (const distance of [4, 0.01]) {
      const deps = fake()
      deps.w.distance = () => distance
      expect(await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'this rim', ref: 'base/F2' })).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'the centre of base/F2 is not on it (a face with a hole, a ring or a short cylinder): give a point on base/F2' }]
      })
      expect(deps.w.added).toEqual([])
    }
    const deps = fake()
    expect(said(await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'this rim', ref: 'base/F2', point: [5, 5, 2.5] }))).toBe('the point (5, 5, 2.5) is on base/F5, not base/F2: give a point on base/F2')
    expect(deps.w.added).toEqual([])
  })

  it('puts a pin or the start of an arrow on the face that is under its point, and says which when it is not the one named', async () => {
    for (const distance of [4, 0.01]) {
      const deps = fake()
      deps.w.distance = () => distance
      const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', ref: 'base/F2' })
      // What is kept is what the check that follows the adding would make of it: nothing is left to rewrite.
      expect((deps.w.added[0] as { anchor: Anchor }).anchor).toEqual({ point: [0, 0, 2.5], part: 'base', ref: 'base/F5', normal: [0, 0, 1], descriptor: 'nearest of base' })
      expect(said(result)).toBe(
        'placed in layout assembly: (yours) M5 pin on base/F5 (nearest of base) at (0, 0, 2.5): "here"\nThe centre of base/F2 is not on it: the mark is placed on base/F5, the face under that point. Give a point on base/F2 to put it there.'
      )
    }
    const deps = fake()
    const arrow = await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', ref: 'base/F2', point: [5, 5, 2.5], by: [0, 0, 5] })
    expect(deps.w.added[0]).toMatchObject({ from: { point: [5, 5, 2.5], ref: 'base/F5', descriptor: 'nearest of base' } })
    expect(said(arrow)).toContain('M5 arrow from base/F5 (nearest of base) at (5, 5, 2.5)')
    expect(said(arrow)).toContain('\nThe point is on base/F5, not base/F2: the mark is placed on base/F5, the face under that point.')
  })

  it('puts a pin named by a part or an edge on the face under it, as it would be found to be', async () => {
    const deps = fake()
    const byPart = await addMarkTool(deps, 'bracket', { kind: 'pin', note: '', ref: 'base' })
    expect((deps.w.added[0] as { anchor: Anchor }).anchor).toEqual({ point: [0, 0, 2.5], part: 'base', ref: 'base/F5', normal: [0, 0, 1], descriptor: 'nearest of base' })
    expect(said(byPart)).toBe('placed in layout assembly: (yours) M5 pin on base/F5 (nearest of base) at (0, 0, 2.5)')
  })

  it('puts a pin named by an edge on that edge: at its middle, or at a point on it, with the faces it is between', async () => {
    const deps = fake()
    const byEdge = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'this edge is ugly', ref: 'base/E7' })
    expect(deps.w.asked).toEqual([{ layout: 'assembly', anchors: [{ part: 'base', point: [0, 15, 2.5], edge: 'base/E7' }] }])
    expect((deps.w.added[0] as { anchor: Anchor }).anchor).toEqual({ point: [0, 15, 2.5], part: 'base', ref: 'base/E7', edge: 'base/E7', between: ['base/F2', 'base/F5'], descriptor: 'line, 40 mm' })
    expect(said(byEdge)).toBe('placed in layout assembly: (yours) M5 pin on the edge base/E7 between base/F2 and base/F5 (line, 40 mm) at (0, 15, 2.5): "this edge is ugly"')
    await addMarkTool(deps, 'bracket', { kind: 'pin', note: '', ref: 'base/E7', point: [10, 15, 2.5] })
    expect(deps.w.added[1]).toMatchObject({ anchor: { point: [10, 15, 2.5], ref: 'base/E7', edge: 'base/E7' } })
    // Beside the edge, it is not a pin on the edge.
    deps.w.edgeDistance = 3.21
    expect(said(await addMarkTool(deps, 'bracket', { kind: 'pin', note: '', ref: 'base/E7', point: [10, 12, 2.5] }))).toBe(
      'the point (10, 12, 2.5) is 3.21 mm from base/E7: give a point on the edge, or leave the point out to use its middle'
    )
    expect(deps.w.added).toHaveLength(2)
  })

  it('says so when a pin named by an edge and a point lands on another edge than the one named', async () => {
    const deps = fake()
    deps.w.near = { support: 'edge', edgeUnder: 'base/E7', edgeUnderDescriptor: 'line, 40 mm', between: ['base/F2', 'base/F5'] }
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', ref: 'base/E5', point: [20, 15, 2.5] })
    expect(deps.w.added[0]).toMatchObject({ anchor: { ref: 'base/E7', edge: 'base/E7' } })
    expect(said(result)).toBe(
      'placed in layout assembly: (yours) M5 pin on the edge base/E7 between base/F2 and base/F5 (line, 40 mm) at (20, 15, 2.5): "here"\nThe pin is placed on base/E7, the edge under that point, not base/E5.'
    )
    // On the edge named, nothing more is said.
    const same = await addMarkTool(deps, 'bracket', { kind: 'pin', note: '', ref: 'base/E7', point: [10, 15, 2.5] })
    expect(said(same)).not.toContain('not base/')
  })

  it('says a pin is on an edge when the kernel finds its point on one, whatever named the point', async () => {
    const deps = fake()
    deps.w.near = { support: 'edge', edgeUnder: 'base/E3', edgeUnderDescriptor: 'line, 30 mm', between: ['base/F1', 'base/F5'] }
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', point: [20, 1, 2.5] })
    expect((deps.w.added[0] as { anchor: Anchor }).anchor).toEqual({ point: [20, 1, 2.5], part: 'base', ref: 'base/E3', edge: 'base/E3', between: ['base/F1', 'base/F5'], descriptor: 'line, 30 mm' })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 pin on the edge base/E3 between base/F1 and base/F5 (line, 30 mm) at (20, 1, 2.5): "here"')
    // An arrow starts on the face, as before.
    await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', point: [20, 1, 2.5], by: [0, 0, 5] })
    expect(deps.w.added[1]).toMatchObject({ from: { ref: 'base/F5' } })
    expect(deps.w.added[1]).not.toHaveProperty('from.edge')
  })

  it('passes on that the kernel could say nothing of the point', async () => {
    const deps = fake({ nearest: async (_id, _layout, anchors) => anchors.map(({ part }) => ({ part, found: true, error: 'the point of assembly:base nearest to the anchor is on none of its faces' })) })
    expect(said(await addMarkTool(deps, 'bracket', { kind: 'pin', note: '', ref: 'base/F5', point: [1, 1, 2.5] }))).toBe(
      'the kernel could not say where (1, 1, 2.5) is on base: the point of assembly:base nearest to the anchor is on none of its faces'
    )
    expect(deps.w.added).toEqual([])
  })

  it('refuses an arrow given both where it ends and by how much: one of them would be ignored', async () => {
    const deps = fake()
    expect(await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', ref: 'base/F5', to: [0, 0, 10], by: [0, 0, 5] })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'an arrow takes to (where it ends) or by (the vector from its start), not both' }]
    })
    expect(deps.w.added).toEqual([])
  })

  it('says of an arrow that it starts on the face, and of a shape that it is tied to it', async () => {
    const deps = fake()
    const arrow = await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', ref: 'base/E7', by: [0, 0, 5] })
    expect(said(arrow)).toContain('\nAn arrow starts on a face: it starts on base/F5, the face under the middle of base/E7. Use a pick to mark the edge itself.')
    const shape = await addMarkTool(deps, 'bracket', { kind: 'shape', note: '', ref: 'base/E7', shape: 'box', intent: 'add', size: [5, 5, 5], position: [0, 15, 5] })
    expect(said(shape)).toContain('\nA shape is tied to a face: it is tied to base/F5, the face under the middle of base/E7. Use a pick to mark the edge itself.')
  })

  it('keeps and says what the kernel finds at the rounded point it keeps, not at the one it rounded', async () => {
    const deps = fake()
    // The middle of a curved edge, as measured; the point of the surface nearest to it rounds to another, which is on the next face.
    const nearest = deps.nearest
    deps.nearest = async (objectId, layout, anchors) => {
      const found = await nearest(objectId, layout, anchors)
      return found.map((one, i) => {
        if (!one.found) return one
        const exact = anchors[i].point[0] === 0
        return { ...one, point: exact ? [0.00016, 15, 2.5] : anchors[i].point, ref: exact ? 'base/F5' : 'base/F6', descriptor: exact ? 'the face before rounding' : 'the face at the rounded point' } as NearestAnchor
      })
    }
    // An arrow from an edge starts on the face there (a pin would be on the edge itself).
    const result = await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', ref: 'base/E7', by: [0, 0, 5] })
    expect(deps.w.asked.map((a) => a.anchors[0].point)).toEqual([[0, 15, 2.5], [0.0002, 15, 2.5]])
    expect((deps.w.added[0] as { from: Anchor }).from).toEqual({ point: [0.0002, 15, 2.5], part: 'base', ref: 'base/F6', normal: [0, 0, 1], descriptor: 'the face at the rounded point' })
    expect(said(result)).toContain('M5 arrow from base/F6 (the face at the rounded point) at (0.0002, 15, 2.5)')
    expect(said(result)).toContain('it starts on base/F6, the face under the middle of base/E7')
  })

  it('leaves a mark on an edge at the middle of the edge, which needs no asking', async () => {
    const deps = fake()
    const result = await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'this hole', ref: 'base/E7' })
    expect(deps.w.added[0]).toMatchObject({ target: 'edge', anchor: { point: [0, 15, 2.5], ref: 'base/E7', descriptor: 'line, 40 mm' } })
    expect(deps.w.added[0]).not.toHaveProperty('anchor.normal')
    expect(deps.w.asked).toEqual([])
    expect(said(result)).not.toContain('\n')
  })

  it('takes a point with an edge only when the point is on that edge, within half a millimetre', async () => {
    const deps = fake()
    deps.w.edgeDistance = 0.5
    await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'round this', ref: 'base/E7', point: [10, 15, 2.5] })
    expect(deps.w.asked).toEqual([{ layout: 'assembly', anchors: [{ part: 'base', point: [10, 15, 2.5], edge: 'base/E7' }] }])
    expect(deps.w.added[0]).toMatchObject({ kind: 'pick', target: 'edge', anchor: { point: [10, 15, 2.5], part: 'base', ref: 'base/E7', descriptor: 'line, 40 mm' } })
    // An edge has no one normal.
    expect(deps.w.added[0]).not.toHaveProperty('anchor.normal')

    // On the surface, but beside the edge: kept, it would be said to have drifted at once.
    deps.w.edgeDistance = 3.21
    expect(await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'round this', ref: 'base/E7', point: [10, 12, 2.5] })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'the point (10, 12, 2.5) is 3.21 mm from base/E7: give a point on the edge, or leave the point out to use its middle' }]
    })
    deps.w.edgeDistance = undefined
    expect(said(await addMarkTool(deps, 'bracket', { kind: 'pick', note: '', ref: 'base/E7', point: [10, 12, 2.5] }))).toBe(
      'the kernel did not say how far the point (10, 12, 2.5) is from base/E7: leave the point out to use the middle of the edge'
    )
    expect(deps.w.added).toHaveLength(1)
  })

  it('takes a point with the ref of the face it is on', async () => {
    const deps = fake()
    const onIt = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5', point: [5, 5, 2.5] })
    expect(deps.w.added[0]).toMatchObject({ anchor: { point: [5, 5, 2.5], ref: 'base/F5', normal: [0, 0, 1], descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' } })
    expect(said(onIt)).not.toContain('\n')
    await addMarkTool(deps, 'bracket', { kind: 'pick', note: 'here', ref: 'base/F5', point: [5, 5, 2.5] })
    expect(deps.w.added[1]).toMatchObject({ kind: 'pick', target: 'face', anchor: { point: [5, 5, 2.5], ref: 'base/F5' } })
  })

  it('refuses a point that is not on the part of its ref', async () => {
    const deps = fake()
    deps.w.distance = () => 12.3456
    const result = await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'here', ref: 'base/F5', point: [5, 5, 30] })
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'the point (5, 5, 30) is 12.35 mm from the surface of base: give a point on it, or leave the point out to use the centre of base/F5' }]
    })
    expect(deps.w.added).toEqual([])
  })

  it('draws an arrow from a ref or a point, to a point or by a vector', async () => {
    const deps = fake()
    const result = await addMarkTool(deps, 'bracket', { kind: 'arrow', note: 'move this out', ref: 'base/F5', by: [0, 0, 14.2] })
    await addMarkTool(deps, 'bracket', { kind: 'arrow', note: '', point: [1, 2, 2.5], to: [1, 2, 10] })
    expect(deps.w.added[0]).toMatchObject({ kind: 'arrow', from: { point: [0, 0, 2.5], ref: 'base/F5' }, to: [0, 0, 16.7] })
    expect(deps.w.added[1]).toMatchObject({ kind: 'arrow', from: { point: [1, 2, 2.5], part: 'base' }, to: [1, 2, 10] })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 arrow from base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (0, 0, 2.5) by (0, 0, 14.2), 14.2 mm: "move this out"')
  })

  it('places a shape in space, not turned unless told, with the sizes its kind has', async () => {
    const deps = fake()
    const result = await addMarkTool(deps, 'bracket', { kind: 'shape', note: 'pocket here', shape: 'box', size: [10, 10, 4], position: [5, 5, 4.5], intent: 'remove' })
    await addMarkTool(deps, 'bracket', { kind: 'shape', note: '', shape: 'cylinder', size: [8, 99, 20], position: [0, 0, 0], intent: 'add', rotation: [0, 0, 2, 2] })
    await addMarkTool(deps, 'bracket', { kind: 'shape', note: '', shape: 'plane', size: [30, 20, 7], position: [0, 0, 0], intent: 'reference' })
    expect(deps.w.added[0]).toMatchObject({ kind: 'shape', author: 'agent', shape: 'box', intent: 'remove', size: [10, 10, 4], position: [5, 5, 4.5], rotation: [0, 0, 0, 1] })
    expect(deps.w.added[0]).not.toHaveProperty('anchor')
    expect(deps.w.added[1]).toMatchObject({ shape: 'cylinder', size: [8, 8, 20] })
    expect((deps.w.added[1] as { rotation: number[] }).rotation[3]).toBeCloseTo(Math.SQRT1_2)
    expect(deps.w.added[2]).toMatchObject({ shape: 'plane', size: [30, 20, 0] })
    expect(said(result)).toBe('placed in layout assembly: (yours) M5 box 10 × 10 × 4 mm centred at (5, 5, 4.5), intent remove: "pocket here"')
    // The kernel is not asked about a shape that is tied to nothing.
    expect(deps.w.described).toEqual([])
    expect(deps.w.asked).toEqual([])
  })

  it.each([
    [{ kind: 'pick', note: '' }, 'a pick needs a ref: the part, face or edge it is of. For a point, place a pin'],
    [{ kind: 'pin', note: '' }, 'a pin needs a ref or a point'],
    [{ kind: 'arrow', note: '', to: [0, 0, 1] }, 'an arrow needs a ref or a point to start from'],
    [{ kind: 'arrow', note: '', ref: 'base/F5' }, 'an arrow needs to (where it ends) or by (the vector from its start), in mm'],
    [{ kind: 'arrow', note: '', ref: 'base/F5', by: [0, 0, 0] }, 'the arrow would end where it starts, at (0, 0, 2.5)'],
    [{ kind: 'shape', note: '', shape: 'box', size: [1, 1, 1] }, 'a shape needs position, intent: shape is one of box, cylinder, sphere, plane; intent one of add, remove, keep-out, reference; size and position are [x, y, z] in mm'],
    [{ kind: 'shape', note: '', shape: 'box', size: [1, 0, 1], position: [0, 0, 0], intent: 'add' }, 'the size of a box must be positive: (1, 0, 1)'],
    [{ kind: 'shape', note: '', shape: 'box', size: [1, 1, 1], position: [0, 0, 0], intent: 'add', rotation: [0, 0, 0, 0] }, 'rotation is a quaternion [x, y, z, w]: it cannot be all zeros'],
    [{ kind: 'pin', note: '', ref: 'lid/F1' }, "no part 'lid' in layout assembly (parts: base, post)"],
    [{ kind: 'pin', note: '', ref: 'base/F6' }, 'base has 6 faces, F0 to F5: there is no F6'],
    [{ kind: 'pin', note: '', ref: 'base', layout: 'exploded' }, "no layout 'exploded'; layouts: assembly, print"]
  ] as const)('places nothing for %o', async (args, text) => {
    const deps = fake()
    expect(await addMarkTool(deps, 'bracket', args as never)).toEqual({ isError: true, content: [{ type: 'text', text }] })
    expect(deps.w.added).toEqual([])
  })

  it('cuts the note at 2000 characters, and passes on why a mark was not kept or the kernel did not answer', async () => {
    const deps = fake()
    await addMarkTool(deps, 'bracket', { kind: 'pin', note: 'n'.repeat(5000), ref: 'base' })
    expect(deps.w.added[0].note).toHaveLength(2000)
    const full = fake({ addMark: async () => Promise.reject(new Error('ENOSPC: no space left on device')) })
    expect(said(await addMarkTool(full, 'bracket', { kind: 'pin', note: '', ref: 'base' }))).toBe('ENOSPC: no space left on device')
    const silent = fake({ nearest: async () => Promise.reject(new Error('the kernel did not answer within 30 s')) })
    expect(await addMarkTool(silent, 'bracket', { kind: 'pin', note: '', point: [0, 0, 0] })).toMatchObject({ isError: true, content: [{ text: 'the kernel did not answer within 30 s' }] })
    expect(said(await addMarkTool(fake({ state: null, noScene: true }), 'bracket', { kind: 'pin', note: '', ref: 'base' }))).toContain('no build yet')
  })
})

describe('resolve_mark', () => {
  it('resolves the mark with the note, and says which it was', async () => {
    const deps = fake()
    const result = await resolveMarkTool(deps, 'bracket', { id: 'M1', note: ' filleted at 2 mm ' })
    expect(result.isError).toBeUndefined()
    expect(deps.w.updates).toEqual([{ id: 'M1', patch: { status: 'resolved', resolvedNote: 'filleted at 2 mm' } }])
    expect(textOf(result)).toBe('resolved: M1 pin on base/F5 (plane, normal +Z, z = 2.5, 1200 mm²) at (1, 2, 2.5): "here"\nnote: filleted at 2 mm')
  })

  it('needs no note, and cuts one at 2000 characters', async () => {
    const deps = fake()
    expect(textOf(await resolveMarkTool(deps, 'bracket', { id: 'M4' }))).toBe('resolved: (yours) M4 pin at (9, 9, 9)')
    await resolveMarkTool(deps, 'bracket', { id: 'M1', note: 'n'.repeat(5000) })
    expect(deps.w.updates.map((u) => u.patch.resolvedNote?.length)).toEqual([undefined, 2000])
  })

  it('echoes a dimension with the value it has on the build there is', async () => {
    const deps = fake()
    // A dimension is echoed with the value it has on the build there is: one measured on another says of which.
    const dimension = { ...MARK_BASE, id: 'M7', status: 'sent', note: '', kind: 'dimension', measure: 'diameter', a: { point: [-6, 5, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder' } as Mark
    deps.w.list.push({ ...dimension, measuredRevision: 3 } as Mark, { ...dimension, id: 'M8', measuredRevision: 2 } as Mark)
    expect(textOf(await resolveMarkTool(deps, 'bracket', { id: 'M7' }))).toBe('resolved: M7 diameter 8 mm, base/F9')
    expect(textOf(await resolveMarkTool(deps, 'bracket', { id: 'M8' }))).toBe('resolved: M8 diameter 8 mm, base/F9 [as measured on r2]')
  })

  it('names the marks there are when the id is of none', async () => {
    const deps = fake()
    for (const id of ['M9', 'three']) {
      expect(await resolveMarkTool(deps, 'bracket', { id })).toEqual({ isError: true, content: [{ type: 'text', text: `no mark ${id}; marks: M1, M2, M3, M4` }] })
    }
    expect(deps.w.updates).toEqual([])
    expect(textOf(await resolveMarkTool(deps, 'nothing', { id: 'M1' }))).toBe('unknown object: nothing')
  })
})

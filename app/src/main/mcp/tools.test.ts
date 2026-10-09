import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, LookRequest, LookResult, ViewState } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { lookTool, sceneTool, TOOLS, type ToolDeps } from './tools'

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
const PICTURE: LookResult = { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), width: 1280, height: 960, caption: 'view iso · layout assembly · parts base, post · orthographic · 1280×960' }

interface Fake extends ToolDeps {
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
      return PICTURE
    },
    saveImage: async (objectId, png) => {
      saved.push({ objectId, png })
      return `/ws/${objectId}/.torno/views/${saved.length}.png`
    },
    ...over
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

describe('the tool descriptions', () => {
  it('say in two sentences each what the tool returns and when to use it', () => {
    for (const tool of [TOOLS.scene, TOOLS.look]) {
      expect(tool.description.match(/[.?!](\s|$)/g)).toHaveLength(2)
    }
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
      camera: { position: [100.12, -80, 60], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
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
    expect(scene.note).toBe('bracket is not the object open in the torno window (open: helmet-stand), so what is visible and the camera are not known.')
    expect(scene.parts.map((p: { name: string }) => p.name)).toEqual(['base', 'post', 'base', 'post'])
    for (const p of scene.parts) expect(p).not.toHaveProperty('visible')
    expect(scene.build.revision).toBe(3)
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

  it('says the parts are stale when the latest build is not the one shown', async () => {
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }
    expect(textOf(await lookTool(fake({ state: failed }), 'bracket', {}))).toContain('\nrevision r3, stale: the latest build failed, so these are still the parts of r3\n')
    const building: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 1, stale: true }
    expect(textOf(await lookTool(fake({ state: building }), 'bracket', {}))).toContain('\nrevision r3, stale: a build is running, so these are still the parts of r3\n')
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

  it('is an error when another object was opened while the picture was made', async () => {
    let open = 'bracket'
    const deps = fake({
      openObjectId: () => open,
      look: async () => {
        open = 'helmet-stand'
        return PICTURE
      }
    })
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

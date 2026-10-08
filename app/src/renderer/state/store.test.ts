import { beforeEach, describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import { actions, partsInLayout, sceneFileOf, store, visibleKeys } from './store'

const BUF = { offset: 0, length: 0 }
const MESH = { vertices: BUF, normals: BUF, triangles: BUF, edges: BUF, trianglesPerFace: BUF, segmentsPerEdge: BUF, faceTypes: BUF, edgeTypes: BUF }

function part(layout: string, name: string): Part {
  return {
    key: `${layout}:${name}`,
    name,
    layout,
    loc: { t: [0, 0, 0], q: [0, 0, 0, 1] },
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    volume: 1,
    faceCount: 6,
    edgeCount: 12,
    triangleCount: 12,
    valid: true,
    hash: name,
    mesh: MESH
  }
}

function scene(layouts: Record<string, string[]>): Scene {
  const parts = Object.entries(layouts).flatMap(([layout, names]) => names.map((name) => part(layout, name)))
  return { model: 'bracket.py', layouts: Object.keys(layouts), parts, seconds: 0.5, output: '' }
}

const BRACKET = scene({ assembly: ['base', 'post'], print: ['base', 'post'] })

function build(over: Partial<BuildState>): BuildState {
  return { objectId: 'bracket', status: 'ok', revision: 1, stale: false, ...over }
}

beforeEach(() => {
  actions.setWorkspace(null)
  actions.openObject('bracket', { layers: {} })
})

describe('applying a scene', () => {
  it('sets the layouts and shows the first one', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    const s = store.getState()
    expect(s.scene?.layouts).toEqual(['assembly', 'print'])
    expect(s.layout).toBe('assembly')
    expect(s.revision).toBe(1)
  })

  it('keeps layer settings for names that persist and drops the rest', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setLayer('post', { visible: false })
    actions.setLayer('base', { opacity: 0.4 })
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: scene({ assembly: ['post', 'cap'] }) })
    expect(store.getState().layers).toEqual({ post: { visible: false } })
  })

  it('keeps the layout shown when the new scene still has it, else falls back to the first', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setLayout('print')
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: BRACKET })
    expect(store.getState().layout).toBe('print')
    actions.applyScene({ objectId: 'bracket', revision: 3, scene: scene({ main: ['base'] }) })
    expect(store.getState().layout).toBe('main')
  })

  it('says there is nothing new when the same revision arrives again', () => {
    expect(actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })).toBe(true)
    actions.setLayout('print')
    const replay = scene({ assembly: ['base', 'post'], print: ['base', 'post'] })
    expect(actions.applyScene({ objectId: 'bracket', revision: 1, scene: replay })).toBe(false)
    expect(store.getState().scene).toBe(BRACKET)
    expect(actions.applyScene({ objectId: 'bracket', revision: 2, scene: replay })).toBe(true)
  })

  it('ignores a scene of an object that is not the open one', () => {
    actions.applyScene({ objectId: 'other', revision: 4, scene: BRACKET })
    expect(store.getState().scene).toBeNull()
  })
})

describe('layouts and layers', () => {
  beforeEach(() => actions.applyScene({ objectId: 'bracket', revision: 1, scene: scene({ assembly: ['base', 'post'], print: ['base'] }) }))

  it('switching layout filters the parts', () => {
    expect(partsInLayout(store.getState()).map((p) => p.key)).toEqual(['assembly:base', 'assembly:post'])
    actions.setLayout('print')
    expect(partsInLayout(store.getState()).map((p) => p.key)).toEqual(['print:base'])
  })

  it('refuses a layout the scene does not have', () => {
    actions.setLayout('exploded')
    expect(store.getState().layout).toBe('assembly')
  })

  it('a hidden part is left out of the visible keys', () => {
    actions.setLayer('post', { visible: false })
    expect(visibleKeys(store.getState())).toEqual(['assembly:base'])
  })

  it('setting one thing about a layer keeps the others', () => {
    actions.setLayer('post', { visible: false })
    actions.setLayer('post', { opacity: 0.5 })
    expect(store.getState().layers.post).toEqual({ visible: false, opacity: 0.5 })
  })

  it('counts edits made by hand, and only those', () => {
    const before = store.getState().edits
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: BRACKET })
    actions.applyBuild(build({ revision: 2 }))
    expect(store.getState().edits).toBe(before)
    actions.setLayer('post', { visible: false })
    actions.setLayout('print')
    expect(store.getState().edits).toBe(before + 2)
  })

  it('writes the layout and the layers as a scene file', () => {
    actions.setLayout('print')
    actions.setLayer('base', { visible: false })
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'print', layers: { base: { visible: false } } })
  })
})

describe('build states', () => {
  it('a stale build state keeps the old scene', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.applyBuild(build({ status: 'building', stale: true, startedAt: 5 }))
    actions.applyBuild(build({ status: 'failed', stale: true, error: { kind: 'exception', message: 'half-typed' } }))
    const s = store.getState()
    expect(s.build).toMatchObject({ status: 'failed', stale: true, revision: 1 })
    expect(s.scene).toBe(BRACKET)
    expect(partsInLayout(s).map((p) => p.name)).toEqual(['base', 'post'])
  })

  it('ignores the build state of another object', () => {
    actions.applyBuild(build({ objectId: 'other' }))
    expect(store.getState().build).toBeNull()
  })
})

describe('opening an object', () => {
  it('starts from its scene file: the layout once the scene has it, and the layers', () => {
    actions.openObject('bracket', { layout: 'print', layers: { post: { visible: false }, gone: { opacity: 0.2 } } })
    expect(store.getState().layers.post).toEqual({ visible: false })
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    const s = store.getState()
    expect(s.layout).toBe('print')
    expect(s.layers).toEqual({ post: { visible: false } })
  })

  it('forgets the object that was open', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.applyBuild(build({}))
    actions.openObject('two', { layers: {} })
    expect(store.getState()).toMatchObject({ objectId: 'two', scene: null, build: null, revision: 0, layers: {} })
  })
})

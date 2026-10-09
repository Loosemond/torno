import { beforeEach, describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Mark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { ScanInfo } from '../../shared/scans'
import { actions, partsInLayout, runningSession, sceneFileOf, store, visibleKeys } from './store'

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

/** The scene as a build that changed one part leaves it. */
function rebuilt(from: Scene, key: string): Scene {
  return { ...from, parts: from.parts.map((p) => (p.key === key ? { ...p, hash: `${p.hash}'` } : p)) }
}

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

  it('closes the note and lets go of the active mark when the layout shown is gone: the mark is of a layout that is not there', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setLayout('print')
    const mark = { id: 'M1', layout: 'print', status: 'draft' } as Mark
    actions.setMarks({ objectId: 'bracket', marks: [mark] })
    actions.openNote({ objectId: 'bracket', layout: 'print', id: 'M1' })
    expect(store.getState()).toMatchObject({ activeMark: 'M1', noting: 'M1' })
    // A build that still has the layout leaves both.
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: rebuilt(BRACKET, 'print:base') })
    expect(store.getState()).toMatchObject({ activeMark: 'M1', noting: 'M1' })
    actions.applyScene({ objectId: 'bracket', revision: 3, scene: scene({ assembly: ['base'] }) })
    expect(store.getState()).toMatchObject({ layout: 'assembly', activeMark: null, noting: null })
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

  describe('what the agent has shown', () => {
    it('is on screen, counts as no edit, and is not what the scene file keeps', () => {
      actions.setLayer('base', { visible: false, color: '#123456' })
      const edits = store.getState().edits
      actions.showForAgent('print', { base: true })
      expect(store.getState()).toMatchObject({ layout: 'print', layers: { base: { visible: true, color: '#123456' } }, edits })
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: { base: { visible: false, color: '#123456' } } })
    })

    it('leaves the scene file without a setting the person never made', () => {
      actions.showForAgent('assembly', { post: false })
      expect(visibleKeys(store.getState())).toEqual(['assembly:base'])
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
    })

    it('stays out of the scene file when the person then changes something else by hand', () => {
      actions.showForAgent('assembly', { post: false })
      actions.setLayer('base', { opacity: 0.5 })
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: { base: { opacity: 0.5 } } })
      expect(store.getState().layers.post).toEqual({ visible: false })
    })

    it('is the person\'s again once they set it by hand: that part, or the layout', () => {
      actions.showForAgent('print', { base: false })
      actions.setLayer('base', { visible: false })
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: { base: { visible: false } } })
      actions.setLayout('assembly')
      actions.showForAgent('print', {})
      actions.setLayout('assembly')
      actions.setLayout('print')
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'print', layers: { base: { visible: false } } })
    })

    it('is forgotten when the agent shows again what the person had, and with the object', () => {
      actions.showForAgent('print', { base: false })
      actions.showForAgent('assembly', { base: true })
      expect(store.getState().shownByAgent).toBeNull()
      actions.showForAgent('print', {})
      actions.openObject('gear', { layers: {} })
      expect(store.getState().shownByAgent).toBeNull()
    })

    it('empties the selection and closes the note when it changes the layout, as any change of layout does', () => {
      actions.setSelection(['base/F5'])
      actions.showForAgent('print', {})
      expect(store.getState().selection).toEqual([])
    })
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

describe('marks', () => {
  function pin(id: string, note: string): Mark {
    return {
      id,
      kind: 'pin',
      author: 'user',
      note,
      status: 'draft',
      anchorState: 'ok',
      layout: 'assembly',
      revision: 1,
      camera: { position: [100, -100, 80], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
      createdAt: '2026-10-09T12:00:00.000Z',
      anchor: { point: [0, 0, 20], part: 'base', ref: 'base/F4' }
    }
  }

  it('one mark at a time is the active one: of the open object, until it is gone or another layout is shown', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here'), pin('M2', 'there')] })
    expect(store.getState().activeMark).toBeNull()
    actions.setActiveMark('M2')
    expect(store.getState().activeMark).toBe('M2')
    // A mark the object does not have is not made the active one.
    actions.setActiveMark('M9')
    expect(store.getState().activeMark).toBe('M2')
    // A change to the marks leaves it; its removal does not.
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here'), pin('M2', 'changed')] })
    expect(store.getState().activeMark).toBe('M2')
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here')] })
    expect(store.getState().activeMark).toBeNull()

    actions.setActiveMark('M1')
    actions.setLayout('print')
    expect(store.getState().activeMark).toBeNull()
    actions.setActiveMark('M1')
    actions.setActiveMark(null)
    expect(store.getState().activeMark).toBeNull()
    actions.setActiveMark('M1')
    actions.openObject('two', { layers: {} })
    expect(store.getState().activeMark).toBeNull()
  })

  it('going to a mark makes it the active one, shows its layout, and asks for the camera each time', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here'), { ...pin('M2', 'on the bed'), layout: 'print' }] })
    const asked = store.getState().markFocus
    actions.focusMark('M1')
    expect(store.getState()).toMatchObject({ activeMark: 'M1', layout: 'assembly', markFocus: asked + 1 })
    // Again: the person may have looked elsewhere since.
    actions.focusMark('M1')
    expect(store.getState().markFocus).toBe(asked + 2)
    actions.focusMark('M2')
    expect(store.getState()).toMatchObject({ activeMark: 'M2', layout: 'print', markFocus: asked + 3 })
    actions.focusMark('M9')
    expect(store.getState()).toMatchObject({ activeMark: 'M2', markFocus: asked + 3 })
  })

  it('going to a mark whose layout the build no longer has does nothing: it is not made active, and the camera is not asked for', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here'), { ...pin('M2', 'on the bed'), layout: 'print' }] })
    actions.focusMark('M1')
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: scene({ assembly: ['base', 'post'] }) })
    const asked = store.getState().markFocus
    actions.focusMark('M2')
    expect(store.getState()).toMatchObject({ activeMark: 'M1', layout: 'assembly', markFocus: asked })
  })

  it('what was wrong with the marks file is put away when the person has read it', () => {
    actions.setMarksProblem({ objectId: 'bracket', message: 'The marks file of this object could not be read.' })
    actions.dismissMarksProblem()
    expect(store.getState().marksProblem).toBeNull()
  })

  it('an object opens with none, then has the ones main lists for it', () => {
    expect(store.getState().marks).toEqual([])
    const listed = [pin('M1', 'here'), pin('M2', 'and here')]
    actions.setMarks({ objectId: 'bracket', marks: listed })
    expect(store.getState().marks).toBe(listed)
  })

  it('follows every change main tells of, with the whole list', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here')] })
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here'), pin('M2', 'new')] })
    expect(store.getState().marks.map((m) => m.id)).toEqual(['M1', 'M2'])
    actions.setMarks({ objectId: 'bracket', marks: [pin('M2', 'new')] })
    expect(store.getState().marks.map((m) => m.id)).toEqual(['M2'])
  })

  it('does not take the marks of an object that is not the open one', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here')] })
    actions.setMarks({ objectId: 'two', marks: [pin('M1', 'on two')] })
    expect(store.getState().marks.map((m) => m.note)).toEqual(['here'])
  })

  it('switching object swaps them: none until the other object\'s are listed, and the old ones do not come back', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here')] })
    actions.openObject('two', { layers: {} })
    expect(store.getState().marks).toEqual([])
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'late answer')] })
    expect(store.getState().marks).toEqual([])
    actions.setMarks({ objectId: 'two', marks: [pin('M1', 'on two')] })
    expect(store.getState().marks.map((m) => m.note)).toEqual(['on two'])
  })

  it('keeps what main said was wrong with the marks file of the open object, until another is opened', () => {
    expect(store.getState().marksProblem).toBeNull()
    actions.setMarksProblem({ objectId: 'two', message: 'not ours' })
    expect(store.getState().marksProblem).toBeNull()
    actions.setMarksProblem({ objectId: 'bracket', message: 'The marks file of this object could not be read.' })
    actions.setMarks({ objectId: 'bracket', marks: [] })
    expect(store.getState().marksProblem).toBe('The marks file of this object could not be read.')
    actions.openObject('two', { layers: {} })
    expect(store.getState().marksProblem).toBeNull()
  })

  it('leaving the workspace leaves none', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1', 'here')] })
    actions.setMarksProblem({ objectId: 'bracket', message: 'x' })
    actions.setWorkspace(null)
    expect(store.getState()).toMatchObject({ marks: [], marksProblem: null })
  })
})

describe('the selection', () => {
  beforeEach(() => actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET }))

  it('is what was last selected, each ref once, in the order picked', () => {
    expect(store.getState().selection).toEqual([])
    actions.setSelection(['base/F5'])
    actions.toggleSelection('post/E2')
    actions.toggleSelection('base/F1')
    expect(store.getState().selection).toEqual(['base/F5', 'post/E2', 'base/F1'])
    actions.toggleSelection('post/E2')
    expect(store.getState().selection).toEqual(['base/F5', 'base/F1'])
    actions.setSelection(['base/F0', 'base/F0'])
    expect(store.getState().selection).toEqual(['base/F0'])
    actions.setSelection([])
    expect(store.getState().selection).toEqual([])
  })

  it('is the same list when nothing changes, so nothing is drawn again', () => {
    actions.setSelection(['base/F5'])
    const before = store.getState().selection
    actions.setSelection(['base/F5'])
    actions.setLayer('base', { opacity: 0.5 })
    actions.applyBuild(build({ status: 'building', stale: true }))
    expect(store.getState().selection).toBe(before)
  })

  it('is emptied by a new revision, whose faces are numbered anew', () => {
    actions.setSelection(['base/F5'])
    expect(actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })).toBe(false)
    expect(store.getState().selection).toEqual(['base/F5'])
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: rebuilt(BRACKET, 'assembly:post') })
    expect(store.getState().selection).toEqual([])
  })

  it('is kept by a new revision of the very same parts: the kernel built the same sources again', () => {
    const at = { point: [1, 0, 2.5] as [number, number, number], normal: null }
    actions.setSelection(['base/F5'], { 'base/F5': at })
    const before = store.getState().selection
    expect(actions.applyScene({ objectId: 'bracket', revision: 2, scene: structuredClone(BRACKET) })).toBe(true)
    expect(store.getState()).toMatchObject({ revision: 2, picked: { 'base/F5': at } })
    expect(store.getState().selection).toBe(before)
    // Not when a part came or went, though the others are the same.
    actions.applyScene({ objectId: 'bracket', revision: 3, scene: scene({ assembly: ['base', 'post', 'cap'], print: ['base', 'post'] }) })
    expect(store.getState().selection).toEqual([])
    actions.setSelection(['base/F5'])
    actions.applyScene({ objectId: 'bracket', revision: 4, scene: scene({ assembly: ['base', 'post'], print: ['base', 'post'] }) })
    expect(store.getState().selection).toEqual([])
  })

  it('is emptied by another layout, and by another object', () => {
    actions.setSelection(['base/F5'])
    actions.setLayout('assembly') // the one shown: nothing changes
    expect(store.getState().selection).toEqual(['base/F5'])
    actions.setLayout('print')
    expect(store.getState().selection).toEqual([])
    actions.setSelection(['base/F5'])
    actions.openObject('gear', { layers: {} })
    expect(store.getState().selection).toEqual([])
  })
})

describe('where the selection was clicked', () => {
  beforeEach(() => actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET }))
  const at = (x: number) => ({ point: [x, 0, 2.5] as [number, number, number], normal: [0, 0, 1] as [number, number, number] })

  it('is remembered for each ref, and forgotten with it', () => {
    actions.setSelection(['base/F5'], { 'base/F5': at(1) })
    actions.toggleSelection('post/E2', { point: [0, 4, 9], normal: null })
    expect(store.getState().picked).toEqual({ 'base/F5': at(1), 'post/E2': { point: [0, 4, 9], normal: null } })
    actions.toggleSelection('base/F5', at(7)) // taken out
    expect(store.getState().picked).toEqual({ 'post/E2': { point: [0, 4, 9], normal: null } })
    actions.setSelection([])
    expect(store.getState().picked).toEqual({})
  })

  it('follows the last click on a ref that stays selected', () => {
    actions.setSelection(['base/F5'], { 'base/F5': at(1) })
    const before = store.getState().selection
    actions.setSelection(['base/F5'], { 'base/F5': at(2) })
    expect(store.getState().picked).toEqual({ 'base/F5': at(2) })
    expect(store.getState().selection).toBe(before)
  })

  it('goes with the selection: another layout, a new revision', () => {
    actions.setSelection(['base/F5'], { 'base/F5': at(1) })
    actions.setLayout('print')
    expect(store.getState().picked).toEqual({})
    actions.setSelection(['base/F5'], { 'base/F5': at(1) })
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: rebuilt(BRACKET, 'assembly:base') })
    expect(store.getState().picked).toEqual({})
  })
})

describe('the note that is open', () => {
  beforeEach(() => actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET }))
  const pin = (id: string, layout = 'assembly'): Mark => ({
    id, kind: 'pin', author: 'user', note: '', status: 'draft', anchorState: 'ok', layout, revision: 1,
    camera: { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }, createdAt: '', anchor: { point: [0, 0, 0] }
  })
  const open = (id: string, layout = 'assembly') => actions.openNote({ objectId: 'bracket', layout, id })

  it('is of a mark just made, which becomes the active one, even before main has told of it', () => {
    open('M1')
    expect(store.getState()).toMatchObject({ noting: 'M1', activeMark: 'M1' })
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1')] })
    expect(store.getState()).toMatchObject({ noting: 'M1', activeMark: 'M1' })
    // A change to its note leaves it open.
    actions.setMarks({ objectId: 'bracket', marks: [{ ...pin('M1'), note: 'thicker' }] })
    expect(store.getState().noting).toBe('M1')
  })

  it('closes when its mark is deleted', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1'), pin('M2')] })
    open('M2')
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1')] })
    expect(store.getState()).toMatchObject({ noting: null, activeMark: null })
  })

  it('closes when it is closed, leaving its mark the active one', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1')] })
    open('M1')
    actions.closeNote()
    expect(store.getState()).toMatchObject({ noting: null, activeMark: 'M1' })
  })

  it('closes when another mark is made the active one, another layout is shown, or another object', () => {
    actions.setMarks({ objectId: 'bracket', marks: [pin('M1'), pin('M2'), pin('M3', 'print')] })
    open('M1')
    actions.setActiveMark('M2')
    expect(store.getState().noting).toBeNull()
    open('M1')
    actions.focusMark('M1') // going to its own view leaves it open
    expect(store.getState().noting).toBe('M1')
    actions.focusMark('M2')
    expect(store.getState().noting).toBeNull()
    open('M1')
    actions.setLayout('print')
    expect(store.getState().noting).toBeNull()
    actions.setLayout('assembly')
    open('M1')
    actions.openObject('gear', { layers: {} })
    expect(store.getState().noting).toBeNull()
  })

  it('does not open for a mark of an object or a layout that is not shown', () => {
    actions.openNote({ objectId: 'gear', layout: 'assembly', id: 'M1' })
    open('M1', 'print')
    expect(store.getState()).toMatchObject({ noting: null, activeMark: null })
  })
})

describe('the running session of the open object', () => {
  it('is the one an agent still runs in', () => {
    expect(runningSession(store.getState())).toBeUndefined()
    actions.setSession('gear', { sessionId: 'g', status: 'idle' })
    expect(runningSession(store.getState())).toBeUndefined()
    actions.setSession('bracket', { sessionId: 'b', status: 'working' })
    expect(runningSession(store.getState())).toEqual({ sessionId: 'b', status: 'working' })
    actions.applySessionStatus({ sessionId: 'b', status: 'exited' })
    expect(runningSession(store.getState())).toBeUndefined()
  })
})

describe('the section', () => {
  const Z = { origin: [0, 0, 12], normal: [0, 0, 1] } satisfies NonNullable<ReturnType<typeof store.getState>['section']>
  const X = { origin: [3, 0, 0], normal: [1, 0, 0] } satisfies typeof Z

  beforeEach(() => actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET }))

  it('is none for an object whose scene file has none, and the file\'s when it has one', () => {
    expect(store.getState().section).toBeNull()
    actions.openObject('two', { layers: {}, section: { origin: [0, 0, 12], normal: [0, 0, 2] } })
    expect(store.getState().section).toEqual(Z)
    actions.openObject('plain', { layers: {}, section: { origin: [0, 0, 12], normal: [0, 0, 0] } })
    expect(store.getState().section).toBeNull()
  })

  it('set by hand is an edit, and is what the scene file keeps; none is left out of the file', () => {
    const edits = store.getState().edits
    actions.setSection(Z)
    expect(store.getState()).toMatchObject({ section: Z, edits: edits + 1 })
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {}, section: Z })
    actions.setSection({ ...Z })
    expect(store.getState().edits).toBe(edits + 1) // the same plane is no change
    actions.setSection(null)
    expect(store.getState().edits).toBe(edits + 2)
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
  })

  it('stays through a build and a change of layout, and goes with the object', () => {
    actions.setSection(Z)
    actions.applyScene({ objectId: 'bracket', revision: 2, scene: rebuilt(BRACKET, 'assembly:post') })
    actions.setLayout('print')
    expect(store.getState().section).toEqual(Z)
    actions.openObject('two', { layers: {} })
    expect(store.getState().section).toBeNull()
  })

  it('shown by the agent is on screen, counts as no edit, and is not what the scene file keeps', () => {
    actions.setSection(Z)
    const edits = store.getState().edits
    actions.showForAgent('assembly', {}, X)
    expect(store.getState()).toMatchObject({ section: X, edits })
    expect(sceneFileOf(store.getState()).section).toEqual(Z)
    // Taken away by the agent, it is still the person's in the file.
    actions.showForAgent('assembly', {}, null)
    expect(store.getState().section).toBeNull()
    expect(sceneFileOf(store.getState()).section).toEqual(Z)
    // Back to what they had: nothing of the agent's is left.
    actions.showForAgent('assembly', {}, { ...Z })
    expect(store.getState().shownByAgent).toBeNull()
  })

  it('shown by the agent where the person had none leaves the file without one', () => {
    actions.showForAgent('assembly', {}, X)
    actions.setLayer('base', { opacity: 0.5 })
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: { base: { opacity: 0.5 } } })
    expect(store.getState().section).toEqual(X)
  })

  it('is left alone by a show that says nothing of it', () => {
    actions.setSection(Z)
    actions.showForAgent('print', { base: false })
    expect(store.getState().section).toEqual(Z)
    expect(store.getState().shownByAgent).toEqual({ layout: 'assembly', visible: { base: undefined } })
  })

  it('is the person\'s again once they set it by hand, even to the plane the agent showed', () => {
    actions.showForAgent('assembly', {}, X)
    actions.setSection({ ...X })
    expect(sceneFileOf(store.getState()).section).toEqual(X)
    expect(store.getState().shownByAgent?.section).toBeUndefined()
  })
})

describe('the scans', () => {
  const S1 = { id: 'S1', name: 'plate.stl' } as ScanInfo

  it('are those of the open object, as main last told them; another object has its own', () => {
    actions.setScans({ objectId: 'other', scans: [S1] })
    expect(store.getState().scans).toEqual([])
    actions.setScans({ objectId: 'bracket', scans: [S1] })
    expect(store.getState().scans).toEqual([S1])
    actions.openObject('two', { layers: {} })
    expect(store.getState()).toMatchObject({ scans: [], scanViews: {}, importing: null })
  })

  it('say why an import came to nothing and what was wrong with their file, until that is put away or another object is opened', () => {
    actions.setScansRefused('part.3mf is not a scan torno reads')
    actions.setScansProblem({ objectId: 'other', message: 'not of this object' })
    expect(store.getState()).toMatchObject({ scansRefused: 'part.3mf is not a scan torno reads', scansProblem: null })
    actions.setScansProblem({ objectId: 'bracket', message: 'scans.json was set aside' })
    expect(store.getState().scansProblem).toBe('scans.json was set aside')
    actions.dismissScansProblem()
    actions.setScansRefused(null)
    expect(store.getState()).toMatchObject({ scansRefused: null, scansProblem: null })
    actions.setScansRefused('again')
    actions.openObject('two', { layers: {} })
    expect(store.getState().scansRefused).toBeNull()
  })

  it('are looked at as the person set each: a change is merged, is an edit, and is what the scene file keeps', () => {
    actions.applyScene({ objectId: 'bracket', revision: 1, scene: BRACKET })
    const edits = store.getState().edits
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
    actions.setScanView('S1', { opacity: 0.6 })
    actions.setScanView('S1', { visible: false })
    actions.setScanView('S2', { colour: 'plain' })
    expect(store.getState()).toMatchObject({ scanViews: { S1: { opacity: 0.6, visible: false }, S2: { colour: 'plain' } }, edits: edits + 3 })
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {}, scans: { S1: { opacity: 0.6, visible: false }, S2: { colour: 'plain' } } })
  })

  it('are looked at as the scene file left them when their object is opened', () => {
    actions.openObject('bracket', { layers: {}, scans: { S1: { visible: false } } })
    expect(store.getState().scanViews).toEqual({ S1: { visible: false } })
    expect(sceneFileOf(store.getState()).scans).toEqual({ S1: { visible: false } })
  })

  it('say what is being imported into the open object, and nothing of an import into another', () => {
    actions.setImporting({ objectId: 'other', name: 'Micra.glb', stage: 'reading' })
    expect(store.getState().importing).toBeNull()
    actions.setImporting({ objectId: 'bracket', name: 'Micra.glb', stage: 'colours' })
    expect(store.getState().importing).toEqual({ name: 'Micra.glb', stage: 'colours' })
    // No stage: the process is over.
    actions.setImporting({ objectId: 'bracket', name: 'Micra.glb', stage: null })
    expect(store.getState().importing).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, HighlightRequest, ShowRequest } from '../../shared/view'
import { agentStore, connectAgent, dismissHighlight, HIGHLIGHT_FOR_MS } from './agent'
import { actions, store } from './store'

const part = (layout: string, name: string): Part => ({ key: `${layout}:${name}`, name, layout, faceCount: 6, edgeCount: 12 }) as Part
const SCENE: Scene = { model: 'bracket.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'base'), part('assembly', 'post'), part('print', 'base'), part('print', 'post')], seconds: 1, output: '' }
const CAMERA: Camera = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

let onShow: (m: { id: number; request: ShowRequest }) => void
let onHighlight: (m: { id: number; request: HighlightRequest }) => void
let replies: Array<{ id: number; result: unknown }>
let tinted: string[][]
let views: unknown[]
let press: () => void
let disconnect: () => void

beforeEach(() => {
  vi.useFakeTimers()
  replies = []
  tinted = []
  views = []
  const off = vi.fn()
  vi.stubGlobal('window', {
    torno: {
      view: {
        onShow: (cb: typeof onShow) => ((onShow = cb), off),
        onHighlight: (cb: typeof onHighlight) => ((onHighlight = cb), off),
        showReply: (id: number, result: unknown) => replies.push({ id, result }),
        highlightReply: (id: number, result: unknown) => replies.push({ id, result })
      }
    }
  })
  actions.setWorkspace({ root: '/ws', hasProject: true, objects: [{ id: 'bracket', name: 'bracket', dir: '/ws/bracket', model: 'bracket.py' }] })
  actions.openObject('bracket', { layers: {} })
  actions.applyScene({ objectId: 'bracket', revision: 3, scene: SCENE })
  disconnect = connectAgent({
    setView: (view) => views.push(view),
    getCamera: () => CAMERA,
    setAgentHighlight: (refs) => tinted.push(refs),
    canvas: { addEventListener: (_type: string, cb: () => void) => (press = cb), removeEventListener: () => {} } as unknown as HTMLCanvasElement
  })
})

afterEach(() => {
  disconnect()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const highlight = (request: Partial<HighlightRequest> = {}) => onHighlight({ id: 7, request: { objectId: 'bracket', layout: 'assembly', refs: ['base/F5', 'post'], note: 'this one?', ...request } })

describe('highlight', () => {
  it('tints the refs, keeps the note for the line, and answers with what it did', () => {
    highlight()
    expect(tinted).toEqual([['base/F5', 'post']])
    expect(agentStore.getState().highlight).toEqual({ refs: ['base/F5', 'post'], note: 'this one?' })
    expect(replies).toEqual([{ id: 7, result: { objectId: 'bracket', layout: 'assembly', refs: ['base/F5', 'post'], revision: 3 } }])
  })

  it('goes after a minute', () => {
    highlight()
    vi.advanceTimersByTime(HIGHLIGHT_FOR_MS - 1)
    expect(agentStore.getState().highlight).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(agentStore.getState().highlight).toBeNull()
    expect(tinted.at(-1)).toEqual([])
  })

  it('counts the minute from the last highlight, which replaces the one before', () => {
    highlight()
    vi.advanceTimersByTime(40_000)
    highlight({ refs: ['post/E2'], note: undefined })
    vi.advanceTimersByTime(40_000)
    expect(agentStore.getState().highlight).toEqual({ refs: ['post/E2'], note: '' })
    vi.advanceTimersByTime(20_000)
    expect(agentStore.getState().highlight).toBeNull()
  })

  it.each([
    ['a press anywhere in the viewport', () => press()],
    ['its dismiss control', () => dismissHighlight()],
    ['another layout', () => actions.setLayout('print')],
    ['a new build', () => actions.applyScene({ objectId: 'bracket', revision: 4, scene: SCENE })],
    ['another object', () => actions.openObject('other', { layers: {} })]
  ])('goes with %s', (_what, act) => {
    highlight()
    act()
    expect(agentStore.getState().highlight).toBeNull()
    expect(tinted.at(-1)).toEqual([])
    // Nothing is left to go off later.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cuts a note at 2000 characters', () => {
    highlight({ note: 'n'.repeat(5000) })
    expect(agentStore.getState().highlight?.note).toHaveLength(2000)
  })

  it.each([
    [{ objectId: 'other' }, 'other is not the object open in the torno window (open: bracket). Ask the user to open it.'],
    [{ layout: 'print' }, 'layout print is not the one on screen (assembly): call show with that layout first, which changes what the user sees'],
    [{ refs: ['base/F5', 'lid', 'post/F6', 'post/E12'] }, 'nothing was highlighted: the window shows r3, which has no lid, no post/F6, no post/E12']
  ])('tints nothing for %o, and says why', (request, error) => {
    highlight(request)
    expect(replies).toEqual([{ id: 7, result: { error } }])
    expect(tinted).toEqual([])
    expect(agentStore.getState().highlight).toBeNull()
  })
})

describe('show', () => {
  const show = (request: Partial<ShowRequest>) => onShow({ id: 9, request: { objectId: 'bracket', ...request } })

  it('sets the layout, leaves on the parts named and no other, and moves the camera there', () => {
    show({ view: 'top', layout: 'print', parts: ['post'] })
    const s = store.getState()
    expect(s.layout).toBe('print')
    expect(s.layers).toEqual({ base: { visible: false } })
    expect(views).toEqual(['top'])
    expect(replies).toEqual([{ id: 9, result: { caption: 'view top · layout print · parts post · perspective', objectId: 'bracket', revision: 3, stale: false } }])
  })

  it('switches a hidden part back on when it is named', () => {
    actions.setLayer('post', { visible: false })
    show({ parts: ['post', 'base'] })
    expect(store.getState().layers.post.visible).toBe(true)
    expect(views).toEqual([])
    expect((replies[0].result as { caption: string }).caption).toBe('view current · layout assembly · parts base, post · perspective')
  })

  it('goes to a camera as given, and says the projection it has', () => {
    const camera = { ...CAMERA, ortho: true }
    show({ view: camera })
    expect(views).toEqual([camera])
    expect((replies[0].result as { caption: string }).caption).toBe('view custom · layout assembly · parts base, post · orthographic')
  })

  it.each([
    [{ objectId: 'other', view: 'top' as const }, 'other is not the object open in the torno window (open: bracket). Ask the user to open it.'],
    [{ layout: 'exploded' }, "no layout 'exploded'; layouts: assembly, print"],
    [{ layout: 'print', parts: ['post', 'lid'] }, "unknown part 'lid'; parts in layout print: base, post"]
  ])('changes nothing for %o, and says what there is', (request, error) => {
    show(request)
    expect(replies).toEqual([{ id: 9, result: { error } }])
    expect(store.getState()).toMatchObject({ layout: 'assembly', layers: {} })
    expect(views).toEqual([])
  })
})

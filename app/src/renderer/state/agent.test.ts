import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, HighlightRequest, LookRequest, LookResult, SectionDrawingRequest, ShowRequest } from '../../shared/view'
import { agentStore, connectAgent, connectLook, dismissHighlight, HIGHLIGHT_FOR_MS, setPictures } from './agent'
import { actions, explodeNow, sceneFileOf, store } from './store'

const part = (layout: string, name: string): Part => ({ key: `${layout}:${name}`, name, layout, faceCount: 6, edgeCount: 12 }) as Part
const SCENE: Scene = { model: 'bracket.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'base'), part('assembly', 'post'), part('print', 'base'), part('print', 'post')], seconds: 1, output: '' }
const CAMERA: Camera = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

let onShow: (m: { id: number; request: ShowRequest }) => void
let onHighlight: (m: { id: number; request: HighlightRequest }) => void
let onLook: (m: { id: number; request: LookRequest }) => void
let onDrawSection: (m: { id: number; request: SectionDrawingRequest }) => void
let replies: Array<{ id: number; result: unknown }>
let tinted: string[][]
let views: unknown[]
/** What the canvas is told of the pointer: a press at a point of the window, and its release. */
let canvasEvents: Record<string, (e: { clientX: number; clientY: number; button: number }) => void>
const press = (x = 100, y = 100, button = 0): void => canvasEvents.pointerdown({ clientX: x, clientY: y, button })
const release = (x = 100, y = 100, button = 0): void => canvasEvents.pointerup({ clientX: x, clientY: y, button })
let disconnect: () => void
/** Whether the person has a button down in the viewport. */
let busy: boolean

beforeEach(() => {
  vi.useFakeTimers()
  replies = []
  busy = false
  canvasEvents = {}
  tinted = []
  views = []
  const off = vi.fn()
  vi.stubGlobal('window', {
    torno: {
      view: {
        onShow: (cb: typeof onShow) => ((onShow = cb), off),
        onHighlight: (cb: typeof onHighlight) => ((onHighlight = cb), off),
        onLook: (cb: typeof onLook) => ((onLook = cb), off),
        onDrawSection: (cb: typeof onDrawSection) => ((onDrawSection = cb), off),
        drawSectionReply: (id: number, result: unknown) => replies.push({ id, result }),
        lookReply: (id: number, result: unknown) => replies.push({ id, result }),
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
    pointerBusy: () => busy,
    setAgentHighlight: (refs) => tinted.push(refs),
    canvas: { addEventListener: (type: string, cb: (typeof canvasEvents)[string]) => (canvasEvents[type] = cb), removeEventListener: () => {} } as unknown as HTMLCanvasElement
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
    ['a click anywhere in the viewport', () => (press(), release(101, 99))],
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

  it('stays while the part is turned to look at it: a drag is not a click', () => {
    highlight()
    press(100, 100)
    expect(agentStore.getState().highlight).not.toBeNull()
    release(160, 120)
    expect(agentStore.getState().highlight).not.toBeNull()
    // Nor is the release of a press that began elsewhere, or of another button.
    release(160, 120)
    press(10, 10, 2)
    release(10, 10, 2)
    expect(agentStore.getState().highlight).not.toBeNull()
  })

  it('tints nothing on a part that is switched off, and says how to switch it on', () => {
    actions.setLayer('post', { visible: false })
    highlight({ refs: ['base/F5', 'post/F1', 'post'] })
    expect(replies).toEqual([{ id: 7, result: { error: 'nothing was highlighted: post is hidden, so the user would see nothing of it. Call show with parts ["base","post"] first, which changes what the user sees' } }])
    expect(tinted).toEqual([])
    expect(agentStore.getState().highlight).toBeNull()
    actions.setLayer('base', { visible: false })
    highlight({ refs: ['base/F5', 'post'] })
    expect((replies[1].result as { error: string }).error).toContain('base and post are hidden, so the user would see nothing of them. Call show with parts ["base","post"] first')
    // What is on is pointed at as ever.
    actions.setLayer('base', { visible: true })
    highlight({ refs: ['base/F5'] })
    expect(tinted).toEqual([['base/F5']])
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
    expect(replies).toEqual([{ id: 9, result: { caption: 'view top · layout print · parts post · perspective', objectId: 'bracket', revision: 3, stale: false, layout: 'print', scans: [] } }])
  })

  it('is not an edit of the person\'s: the scene file goes on saying what they had chosen', () => {
    actions.setLayer('post', { opacity: 0.5 })
    const edits = store.getState().edits
    const theirs = sceneFileOf(store.getState())
    show({ view: 'top', layout: 'print', parts: ['post'] })
    expect(store.getState().edits).toBe(edits)
    expect(sceneFileOf(store.getState())).toEqual(theirs)
    expect(theirs).toEqual({ layout: 'assembly', layers: { post: { opacity: 0.5 } } })
  })

  it('cuts the parts by the plane asked for, says so, and leaves the scene file as the person had it', () => {
    show({ section: { origin: [0, 0, 12.5], normal: [0, 0, 3] } })
    expect(store.getState().section).toEqual({ origin: [0, 0, 12.5], normal: [0, 0, 1] })
    expect(replies).toEqual([{ id: 9, result: { caption: 'view current · layout assembly · parts base, post · cut at z = 12.5, +Z side removed · perspective', objectId: 'bracket', revision: 3, stale: false, layout: 'assembly', scans: [] } }])
    expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
    // Null takes it away again; a show that says nothing of it leaves it.
    show({ layout: 'print' })
    expect(store.getState().section).not.toBeNull()
    show({ section: null })
    expect(store.getState().section).toBeNull()
  })

  describe('with an explode', () => {
    const NOTE = 'the parts are drawn apart for display: every position, ref and number told is of the parts as assembled'
    const NOT_BOTH = 'a section is not drawn exploded: give explode or section, not both (explode: null draws the parts together, section: null draws them whole)'
    const caption = (): string => (replies.at(-1)!.result as { caption: string }).caption

    it('draws the parts apart for now, says so with what that means, and leaves the scene file as the person had it', () => {
      const edits = store.getState().edits
      show({ explode: { amount: 0.5, scale: 1, axis: 'z' } })
      expect(explodeNow(store.getState())).toEqual({ amount: 0.5, scale: 1, axis: 'z' })
      expect(replies).toEqual([{ id: 9, result: { caption: `view current · layout assembly · parts base, post · exploded 50 % along z (${NOTE}) · perspective`, objectId: 'bracket', revision: 3, stale: false, layout: 'assembly', scans: [], exploded: true } }])
      expect(store.getState().edits).toBe(edits)
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
      // A show that says nothing of it leaves the parts apart, and goes on saying so.
      show({ view: 'top' })
      expect(caption()).toContain('exploded 50 % along z')
      // Null puts them together, and nothing is said of it.
      show({ explode: null })
      expect(explodeNow(store.getState())).toBeNull()
      expect(replies.at(-1)!.result).toEqual({ caption: 'view current · layout assembly · parts base, post · perspective', objectId: 'bracket', revision: 3, stale: false, layout: 'assembly', scans: [] })
    })

    it('takes of what it is given only an explode, within its ranges', () => {
      show({ explode: { amount: 7, scale: 99, axis: 'w', more: 'x' } as never })
      expect(explodeNow(store.getState())).toEqual({ amount: 1, scale: 4, axis: 'centre' })
      show({ explode: { amount: 0, scale: 2, axis: 'x' } })
      expect(explodeNow(store.getState())).toBeNull()
    })

    it('is of the layout it shows', () => {
      show({ layout: 'print', explode: { amount: 1, scale: 1, axis: 'x' } })
      expect(store.getState().layout).toBe('print')
      expect(explodeNow(store.getState())).toEqual({ amount: 1, scale: 1, axis: 'x' })
      expect(explodeNow(store.getState(), 'assembly')).toBeNull()
      expect(caption()).toContain('layout print · parts base, post · exploded 100 % along x')
    })

    it('never draws a section exploded: with the cut it asks for, or the one on screen unless it takes that away', () => {
      const cut = { origin: [0, 0, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }
      show({ explode: { amount: 0.5, scale: 1, axis: 'z' }, section: cut })
      expect(replies.at(-1)!.result).toEqual({ error: NOT_BOTH })
      expect([store.getState().section, explodeNow(store.getState())]).toEqual([null, null])
      actions.setSection(cut)
      show({ explode: { amount: 0.5, scale: 1, axis: 'z' } })
      expect(replies.at(-1)!.result).toEqual({ error: NOT_BOTH })
      expect(explodeNow(store.getState())).toBeNull()
      show({ explode: { amount: 0.5, scale: 1, axis: 'z' }, section: null })
      expect([store.getState().section, explodeNow(store.getState())?.amount]).toEqual([null, 0.5])
      expect(caption()).not.toContain('cut at')
      // A cut asked for while the parts are apart puts them together.
      show({ section: cut })
      expect(explodeNow(store.getState())).toBeNull()
      expect(caption()).toBe('view current · layout assembly · parts base, post · cut at z = 3, +Z side removed · perspective')
    })
  })

  describe('with scans', () => {
    const scan = (id: string, alignments: object = {}) => ({ id, name: `${id}.stl`, imported: { triangles: 12 }, alignments, sourceState: 'present', meshState: 'ok', checks: {} }) as never
    const typed = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '' }
    beforeEach(() => actions.setScans({ objectId: 'bracket', scans: [scan('S1', { assembly: typed }), scan('S2')] }))

    it('says of the scans left on that they have not moved, when it draws the parts apart beside them', () => {
      show({ scans: ['S1'], explode: { amount: 1, scale: 1, axis: 'z' } })
      expect((replies.at(-1)!.result as { caption: string }).caption).toMatch(/ · scans S1 \(.*\) · exploded 100 % along z \(the parts are drawn apart for display: every position, ref and number told is of the parts as assembled\) · scans are where they are · perspective$/)
      show({ scans: [] })
      expect((replies.at(-1)!.result as { caption: string }).caption).not.toContain('scans are where they are')
    })

    // Fix round 1 (M7): the caption is read by the agent: a fit's figures to a tenth of a millimetre, as a picture's has them.
    it('says of a fit in its caption no finer than a tenth of a millimetre', () => {
      const pairs = [0.001, 0.005, 0.003].map((residual, n) => ({ scan: [n, 0, 0], model: [n, 0, 0], residual }))
      store.setState({ scans: store.getState().scans.map((scan) => (scan.id === 'S1' ? { ...scan, alignments: { assembly: { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], pairs, rms: 0.003, frame: {}, at: '' } } } : scan)) as never })
      show({ scans: ['S1'] })
      expect((replies.at(-1)!.result as { caption: string }).caption).toContain(' · scans S1 (3 pairs, RMS under 0.1 mm; ')
    })

    it('leaves on the scans named and no other, as thin as asked, says so, and leaves the scene file as the person had it', () => {
      actions.setScanView('S2', { opacity: 0.8 })
      const edits = store.getState().edits
      show({ scans: ['S1'], scanOpacity: 0.4 })
      expect(store.getState().scanViews).toEqual({ S1: { visible: true, opacity: 0.4 }, S2: { opacity: 0.8, visible: false } })
      // Task 5's fix round 1: the caption says what the alignment rests on, that this build's check has not come, and what no build can say of it.
      expect(replies).toEqual([{ id: 9, result: { caption: 'view current · layout assembly · parts base, post · scans S1 at 40 % (by hand; it was not checked against r3; tied to no point of the model: not checked against builds) · perspective', objectId: 'bracket', revision: 3, stale: false, layout: 'assembly', scans: ['S1'] } }])
      expect(store.getState().edits).toBe(edits)
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {}, scans: { S2: { opacity: 0.8 } } })
    })

    it('hides them all for none, thins those that are on when no scan is named, and says of one that it is not aligned', () => {
      show({ scans: [] })
      expect(store.getState().scanViews).toEqual({ S1: { visible: false }, S2: { visible: false } })
      expect((replies[0].result as { caption: string }).caption).toBe('view current · layout assembly · parts base, post · perspective')
      show({ scans: ['S2'] })
      show({ scanOpacity: 0.5 })
      expect(store.getState().scanViews).toEqual({ S1: { visible: false }, S2: { opacity: 0.5 } })
      expect((replies[2].result as { caption: string }).caption).toBe('view current · layout assembly · parts base, post · scans S2 at 50 % (not aligned in assembly: drawn where it was imported) · perspective')
      expect(sceneFileOf(store.getState())).toEqual({ layout: 'assembly', layers: {} })
    })

    it('refuses a scan the object has not, and an opacity no scan is drawn at, and changes nothing', () => {
      show({ layout: 'print', scans: ['S9'] })
      show({ scans: ['S1'], scanOpacity: 4 })
      expect(replies.map((reply) => reply.result)).toEqual([{ error: 'no scan S9; scans: S1, S2' }, { error: 'scanOpacity is a number from 0.05 to 1' }])
      expect(store.getState()).toMatchObject({ layout: 'assembly', scanViews: {} })
    })
  })

  it('refuses a section that is no plane, and changes nothing', () => {
    show({ layout: 'print', section: { origin: [0, 0, 1], normal: [0, 0, 0] } })
    expect(replies).toEqual([{ id: 9, result: { error: 'section is not a plane: give origin and normal as three numbers each, the normal not all zeros' } }])
    expect(store.getState()).toMatchObject({ layout: 'assembly', section: null })
  })

  it('is refused while the person has a button down in the viewport, and changes nothing', () => {
    busy = true
    show({ view: 'top', layout: 'print', parts: ['post'] })
    expect(replies).toEqual([{ id: 9, result: { error: 'the user is in the middle of a stroke or drag; try again' } }])
    expect(store.getState()).toMatchObject({ layout: 'assembly', layers: {} })
    expect(views).toEqual([])
    busy = false
    show({ view: 'top' })
    expect(views).toEqual(['top'])
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

describe('look, joined by the app', () => {
  const PICTURE = { png: new Uint8Array([1]), width: 4, height: 3, caption: 'view iso', objectId: 'bracket', revision: 3, stale: false } satisfies LookResult
  let off: () => void
  beforeEach(() => {
    off = connectLook()
  })
  afterEach(() => {
    off()
    setPictures(null)
  })
  const settle = () => vi.advanceTimersByTimeAsync(0)

  it('answers with the picture the viewport makes', async () => {
    const asked: LookRequest[] = []
    setPictures(async (req) => (asked.push(req), PICTURE))
    onLook({ id: 3, request: { view: 'front' } })
    await settle()
    expect(asked).toEqual([{ view: 'front' }])
    expect(replies).toEqual([{ id: 3, result: PICTURE }])
  })

  it('says at once that no object is open, with or without a viewport', async () => {
    actions.setWorkspace(null)
    onLook({ id: 4, request: {} })
    setPictures(async () => PICTURE)
    onLook({ id: 5, request: {} })
    await settle()
    expect(replies).toEqual([4, 5].map((id) => ({ id, result: { error: 'no object open in the torno window' } })))
  })

  it('answers a request for the drawing of a section, whatever the window shows: here, that the plane cut nothing', async () => {
    const section = { plane: { origin: [0, 0, 9], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] }, parts: [], bounds: null } satisfies SectionDrawingRequest['section']
    onDrawSection({ id: 8, request: { objectId: 'another', layout: 'assembly', section, names: [], size: 1280 } })
    await settle()
    expect(replies).toEqual([{ id: 8, result: { error: 'the plane cuts nothing' } }])
  })

  it('says so when there is no viewport to draw it, and passes on why a picture could not be made', async () => {
    onLook({ id: 6, request: {} })
    setPictures(() => Promise.reject(new Error('no build yet')))
    onLook({ id: 7, request: {} })
    await settle()
    expect(replies).toEqual([
      { id: 6, result: { error: 'the torno window has no 3D view to draw it with' } },
      { id: 7, result: { error: 'no build yet' } }
    ])
  })
})

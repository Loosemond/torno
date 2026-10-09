import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { HighlightRequest, HighlightResult, ShowRequest, ShowResult } from '../../shared/view'
import type { Viewport } from '../viewport/Viewport'
import { actions, partsInLayout, store } from './store'

/** How long what the agent points at stays pointed at, unless the person clicks first. */
export const HIGHLIGHT_FOR_MS = 60_000
/** How far the pointer may travel between press and release and still have clicked, in pixels. */
const CLICK_WITHIN_PX = 4
/** The longest note of the agent's that is shown. */
const MAX_NOTE = 2000

/** What the agent is pointing at in the viewport: refs of the layout shown, and what it says of them. */
export interface AgentHighlight {
  refs: string[]
  note: string
}

/** Apart from the window's own state: it is the agent's, and nothing of it is kept. */
export const agentStore = createStore<{ highlight: AgentHighlight | null }>(() => ({ highlight: null }))

export function useAgentHighlight(): AgentHighlight | null {
  return useZustand(agentStore, (s) => s.highlight)
}

let dismiss: () => void = () => {}

/** Stop showing what the agent points at. */
export function dismissHighlight(): void {
  dismiss()
}

/**
 * Change what the window shows of the open object as the agent asked: the
 * layout, which parts are switched on (those named, and no other of that
 * layout), the camera. Everything is checked before anything is changed. The
 * answer says what is shown then, as the caption of a picture would.
 */
export function show(viewport: Pick<Viewport, 'setView' | 'getCamera'>, req: ShowRequest): ShowResult {
  const s = openObject(req.objectId)
  const layout = req.layout ?? s.layout
  if (!s.scene.layouts.includes(layout)) throw new Error(`no layout '${layout}'; layouts: ${s.scene.layouts.join(', ')}`)
  const parts = partsInLayout(s, layout)
  for (const name of req.parts ?? []) {
    if (!parts.some((p) => p.name === name)) throw new Error(`unknown part '${name}'; parts in layout ${layout}: ${parts.map((p) => p.name).join(', ')}`)
  }

  // The viewport follows the store as each of these is set, so the camera below is fitted to what they leave on.
  actions.setLayout(layout)
  if (req.parts) {
    for (const part of parts) {
      const visible = req.parts.includes(part.name)
      if ((store.getState().layers[part.name]?.visible !== false) !== visible) actions.setLayer(part.name, { visible })
    }
  }
  if (req.view !== undefined) viewport.setView(req.view, true)

  const after = store.getState()
  const names = partsInLayout(after, layout)
    .filter((p) => after.layers[p.name]?.visible !== false)
    .map((p) => p.name)
  const view = req.view === undefined ? 'current' : typeof req.view === 'string' ? req.view : 'custom'
  // Where the camera is going, not where it is on the way: a named view keeps the projection there is.
  const ortho = typeof req.view === 'object' ? req.view.ortho : viewport.getCamera().ortho
  return {
    caption: `view ${view} · layout ${layout} · parts ${names.join(', ') || 'none'} · ${ortho ? 'orthographic' : 'perspective'}`,
    objectId: req.objectId,
    revision: after.revision,
    stale: after.build?.stale ?? false
  }
}

/** The state of the window, when the object it shows is the one asked about and has been built. Throws otherwise. */
function openObject(objectId: string) {
  const s = store.getState()
  if (s.objectId !== objectId) throw new Error(`${objectId} is not the object open in the torno window (open: ${s.objectId ?? 'none'}). Ask the user to open it.`)
  if (!s.scene) throw new Error('no build yet')
  return { ...s, scene: s.scene }
}

/** Why a ref names nothing among these parts, or null when it names a part, a face or an edge of one. */
function missing(ref: string, parts: ReturnType<typeof partsInLayout>): string | null {
  if (parts.some((p) => p.name === ref)) return null
  const sub = /^(.*)\/([FE])(\d+)$/.exec(ref)
  const part = sub && parts.find((p) => p.name === sub[1])
  if (!sub || !part) return `no ${ref}`
  return Number(sub[3]) < (sub[2] === 'F' ? part.faceCount : part.edgeCount) ? null : `no ${ref}`
}

/**
 * Join the viewport to what the agent asks of the window: `show` and
 * `highlight`, each answered with what was done or why it was not. What is
 * highlighted stays until the person clicks anywhere in the viewport,
 * dismisses it, the object, the layout or the build changes, or a minute has
 * passed. Returns what undoes the joining.
 */
export function connectAgent(viewport: Pick<Viewport, 'setView' | 'getCamera' | 'setAgentHighlight' | 'canvas'>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    clearTimeout(timer)
    if (agentStore.getState().highlight === null) return
    viewport.setAgentHighlight([])
    agentStore.setState({ highlight: null })
  }
  dismiss = clear

  const highlight = (req: HighlightRequest): HighlightResult => {
    const s = openObject(req.objectId)
    if (req.layout !== s.layout) {
      throw new Error(`layout ${req.layout} is not the one on screen (${s.layout}): call show with that layout first, which changes what the user sees`)
    }
    // Checked against what is drawn: the refs were read from a build, and the window may show another.
    const parts = partsInLayout(s)
    const gone = req.refs.map((ref) => missing(ref, parts)).filter((m) => m !== null)
    if (gone.length > 0) throw new Error(`nothing was highlighted: the window shows r${s.revision}, which has ${gone.join(', ')}`)
    // A part that is switched off is not drawn, and nothing of it would be tinted.
    const hidden = parts.filter((p) => s.layers[p.name]?.visible === false).map((p) => p.name)
    const unseen = hidden.filter((name) => req.refs.some((ref) => ref === name || ref.startsWith(`${name}/`)))
    if (unseen.length > 0) {
      const on = parts.map((p) => p.name).filter((name) => !hidden.includes(name) || unseen.includes(name))
      const [are, them] = unseen.length === 1 ? ['is', 'it'] : ['are', 'them']
      throw new Error(
        `nothing was highlighted: ${unseen.join(' and ')} ${are} hidden, so the user would see nothing of ${them}. Call show with parts ${JSON.stringify(on)} first, which changes what the user sees`
      )
    }
    clear()
    viewport.setAgentHighlight(req.refs)
    agentStore.setState({ highlight: { refs: req.refs, note: (req.note ?? '').slice(0, MAX_NOTE) } })
    timer = setTimeout(clear, HIGHLIGHT_FOR_MS)
    return { objectId: req.objectId, layout: s.layout, refs: req.refs, revision: s.revision }
  }

  const answered = <Q, R>(act: (req: Q) => R, reply: (id: number, result: R | { error: string }) => void) => {
    return ({ id, request }: { id: number; request: Q }): void => {
      let result: R | { error: string }
      try {
        result = act(request)
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) }
      }
      reply(id, result)
    }
  }
  const offShow = window.torno.view.onShow(answered((req: ShowRequest) => show(viewport, req), window.torno.view.showReply))
  const offHighlight = window.torno.view.onHighlight(answered(highlight, window.torno.view.highlightReply))
  // The refs name geometry of the object, the layout and the build they were pointed out in.
  const offStore = store.subscribe((s, prev) => {
    if (s.objectId !== prev.objectId || s.layout !== prev.layout || s.revision !== prev.revision) clear()
  })
  // A click in the viewport puts it away; a drag does not: the person turns the part to see what is pointed at.
  let pressed: { x: number; y: number } | null = null
  const onDown = (e: PointerEvent): void => {
    pressed = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
  }
  const onUp = (e: PointerEvent): void => {
    const from = pressed
    pressed = null
    if (from && e.button === 0 && Math.hypot(e.clientX - from.x, e.clientY - from.y) <= CLICK_WITHIN_PX) clear()
  }
  viewport.canvas.addEventListener('pointerdown', onDown)
  viewport.canvas.addEventListener('pointerup', onUp)

  return () => {
    clear()
    dismiss = () => {}
    offShow()
    offHighlight()
    offStore()
    viewport.canvas.removeEventListener('pointerdown', onDown)
    viewport.canvas.removeEventListener('pointerup', onUp)
  }
}

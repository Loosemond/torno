import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ViewDrawing } from '../../shared/drawing'
import type { Camera } from '../../shared/view'
import type { Under } from '../ui/drawing/under'
import type { Stroke } from './onboard'

// A drawing on the view (the chat's "Draw on view"): the board open over a picture of the view, and by session the
// drawing that goes with its next prompt. Nothing of it is on disk; a closed workspace lets it go. What makes a
// picture and a drawing is `ui/drawing/make.ts`.

/** What the viewport tells of itself for a drawing, while there is one (`ui/ViewportPane.tsx`). */
export interface ViewHost {
  /** The camera on screen. */
  camera(): Camera
  /** What the screen shows, as one string: while it is the same, a point of the canvas is over what it was. */
  shows(): string
  /** What is under each point of the canvas, given as fractions of its width and height: faces only, then scans. */
  under(points: ReadonlyArray<readonly [number, number]>): Under[]
}

/**
 * What the screen shows, as one string (`ViewHost.shows`): the object, its build, the layout, the camera, the canvas's
 * size, the section, the explode and whether parts are on their way apart, the parts drawn, and each scan by whether it
 * is drawn, how thin, whether its mesh has come and where it stands. Not whether a scan's tree is made: once it is,
 * the picks only see what the picture already drew.
 */
export function screenShows(of: {
  objectId: string | null
  revision: number
  layout: string
  camera: Camera
  width: number
  height: number
  section: unknown
  explode: unknown
  apart: boolean
  visible: readonly string[]
  scans: ReadonlyArray<{ id: string; visible: boolean; opacity: number; loaded: boolean; transform: unknown }>
}): string {
  const scans = of.scans.map(({ id, visible, opacity, loaded, transform }) => [id, visible, opacity, loaded, transform])
  return JSON.stringify([of.objectId, of.revision, of.layout, of.camera, Math.round(of.width), Math.round(of.height), of.section, of.explode, of.apart, of.visible, scans])
}

let host: ViewHost | null = null
export function setViewHost(of: ViewHost | null): void {
  host = of
}
export function viewHost(): ViewHost | null {
  return host
}

/** The picture a drawing is made on: the agent's picture of the view, with what it is of. */
export interface Pictured {
  /** The PNG, as an object URL for the board's ground, and decoded for the drawing's picture. */
  url: string
  bitmap: ImageBitmap
  width: number
  height: number
  objectId: string
  revision: number
  layout: string
  caption: string
  camera: Camera
  /** The ink and its casing, read from the theme the picture was made in. */
  ink: string
  casing: string
  /** What the screen showed as the picture was made; null when it changed meanwhile. */
  shows: string | null
}

/** A drawing done, waiting for its prompt: the picture and the strokes (to open it again), what goes, and a thumbnail. */
export interface Drawn { picture: Pictured; strokes: Stroke[]; drawing: ViewDrawing; thumb: string }

interface DrawingState {
  /** The board open: for which session, on which picture, with what drawn when it was opened. */
  board: { sessionId: string; picture: Pictured; strokes: Stroke[] } | null
  /** By session: the drawing that goes with its next prompt. */
  drawn: Record<string, Drawn>
  /** The session a picture is being made for. */
  opening: string | null
}

export const drawingStore = createStore<DrawingState>(() => ({ board: null, drawn: {}, opening: null }))

export function useDrawing<T>(pick: (s: DrawingState) => T): T {
  return useZustand(drawingStore, pick)
}

/** Lets go of a picture that no board and no drawing holds. */
function release(p: Pictured): void {
  const s = drawingStore.getState()
  if (s.board?.picture === p || Object.values(s.drawn).some((d) => d.picture === p)) return
  URL.revokeObjectURL(p.url)
  p.bitmap.close()
}

function without(sessionId: string): void {
  drawingStore.setState((s) => {
    const drawn = { ...s.drawn }
    delete drawn[sessionId]
    return { drawn }
  })
}

export const drawingActions = {
  /** A picture is being made for a session (null: no longer). */
  opening(sessionId: string | null): void {
    drawingStore.setState({ opening: sessionId })
  },
  /** The board, over this picture, for this session. */
  openOn(sessionId: string, picture: Pictured): void {
    drawingStore.setState({ board: { sessionId, picture, strokes: [] } })
  },
  /** The board again over the drawing that waits, with its strokes. */
  edit(sessionId: string): void {
    const s = drawingStore.getState()
    const d = s.drawn[sessionId]
    if (!d || s.board || s.opening) return
    drawingStore.setState({ board: { sessionId, picture: d.picture, strokes: d.strokes } })
  },
  /** The board put away; what waited before it was opened still waits. */
  cancel(): void {
    const board = drawingStore.getState().board
    if (!board) return
    drawingStore.setState({ board: null })
    release(board.picture)
  },
  /** The board put away, and this drawing waits for the session's next prompt, in place of any that did. */
  keep(sessionId: string, d: Drawn): void {
    const before = drawingStore.getState().drawn[sessionId]
    drawingStore.setState((s) => ({ board: null, drawn: { ...s.drawn, [sessionId]: d } }))
    if (before && before !== d) drawingActions.spent(before)
  },
  remove(sessionId: string): void {
    const d = drawingStore.getState().drawn[sessionId]
    if (!d) return
    without(sessionId)
    drawingActions.spent(d)
  },
  /** The drawing that goes with the prompt being sent: no longer waiting. */
  taken(sessionId: string): Drawn | undefined {
    const d = drawingStore.getState().drawn[sessionId]
    if (d) without(sessionId)
    return d
  },
  /** A prompt that was not sent: its drawing waits again, unless another was drawn meanwhile. */
  giveBack(sessionId: string, d: Drawn): void {
    if (drawingStore.getState().drawn[sessionId]) return drawingActions.spent(d)
    drawingStore.setState((s) => ({ drawn: { ...s.drawn, [sessionId]: d } }))
  },
  /** Done with: what it holds of the window's memory is let go. */
  spent(d: Drawn): void {
    URL.revokeObjectURL(d.thumb)
    release(d.picture)
  },
  /** The workspace is closed: every drawing, and the board, go. */
  clear(): void {
    const s = drawingStore.getState()
    drawingStore.setState({ board: null, drawn: {}, opening: null })
    for (const d of Object.values(s.drawn)) drawingActions.spent(d)
    if (s.board) release(s.board.picture)
  }
}

/** Whether a drawing waits for this session's next prompt: closing the window would lose it. */
export function drawingWaits(sessionId: string): boolean {
  return drawingStore.getState().drawn[sessionId] !== undefined
}

import { useStore as useZustand } from 'zustand'
import { type StoreApi, createStore } from 'zustand/vanilla'
import type { ScanInfo } from '../../shared/scans'

/** How the Region tool takes triangles: under a brush dragged over the scan, or inside a box dragged on the screen. */
export type RegionMode = 'brush' | 'box'

/**
 * What the Region tool has in hand, as far as the bar shows it: changed by a click, a key, a field or the end
 * of a stroke, never by a pointer move. The triangles themselves are the tool's (`tools/regionTool.ts`).
 */
export interface RegionState {
  /** The scan being painted on; null while nothing is painted. */
  scan: string | null
  mode: RegionMode
  /** The brush's radius in millimetres, as typed or stepped; null for the usual share of the scan's size. */
  radius: number | null
  /** The brush takes triangles out. */
  erase: boolean
  /** A box takes what faces away from the eye too: the far side of what it goes round. */
  through: boolean
  /** The kept region being painted again, by its mark's number; null for a new painting. */
  editing: string | null
  /** How many triangles are painted, and their area in mm², as of the last stroke that ended. */
  count: number
  area: number
  canUndo: boolean
  /** Main was asked to keep what is painted and has not answered. */
  sending: boolean
  /** Why main did not keep it. */
  refused: string | null
  /** What happened to what was in hand, when it was put down from elsewhere: said in the bar's line until something is painted again. */
  notice: string | null
}

export const NOTHING_PAINTED_STATE = { scan: null, count: 0, area: 0, canUndo: false, sending: false } satisfies Partial<RegionState>

export const regionStore: StoreApi<RegionState> = createStore<RegionState>(() => ({ mode: 'brush', radius: null, erase: false, through: false, editing: null, refused: null, notice: null, ...NOTHING_PAINTED_STATE }))

export function useRegion<T>(pick: (s: RegionState) => T): T {
  return useZustand(regionStore, pick)
}

/** The least and the most a brush's radius may be typed or stepped to, in millimetres. */
export const RADIUS = { least: 0.1, most: 5000 }

/** A radius as the brush takes it: held to what a brush can be; null for what is no number, which leaves the usual one. */
export function radiusOf(typed: number | null): number | null {
  return typed === null || !Number.isFinite(typed) || typed <= 0 ? null : Math.min(Math.max(typed, RADIUS.least), RADIUS.most)
}

/** The brush's radius when none is chosen: this share of the scan's diagonal, as the scan stands (`scale`: what a fit made of its size). */
export const BRUSH_OF_DIAGONAL = 0.03
/** The largest the brush is when none is chosen, mm. A larger one is typed, or made with `]`. */
export const USUAL_MOST = 25
export function usualRadius(scan: Pick<ScanInfo, 'imported'>, scale = 1): number {
  const { min, max } = scan.imported.bbox
  // No larger than `USUAL_MOST`: on a scan the size of a car a thirtieth of it is a brush of a hand's width and more, which paints the tray under the part beside it.
  return Math.min(Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * scale * BRUSH_OF_DIAGONAL, RADIUS.least), USUAL_MOST)
}

/** Said of a box wherever one can be dragged: it does not look at what hides what. */
export const BOX_NOTE = 'A box takes what faces you, also what something in front hides'
export const THROUGH_NOTE = 'A box takes what it goes round, the far side too'

/** The one line of the bar that says what to do next. */
export function nextLine(state: Pick<RegionState, 'mode' | 'count' | 'notice' | 'refused' | 'sending'> & Partial<Pick<RegionState, 'through' | 'editing'>>, scans: number): string {
  if (scans === 0) return 'Import a scan first: a region is painted on one'
  if (state.sending) return 'Keeping it…'
  if (state.notice) return state.notice
  const box = state.mode === 'box' ? `. ${state.through ? THROUGH_NOTE : BOX_NOTE}` : ''
  if (state.count > 0) return `${state.editing ? `Keep makes this ${state.editing}` : 'Keep it to name it'}, or paint on. Alt-drag turns the view${box}`
  return state.mode === 'box' ? `Drag a box over the scan${box}. Alt-drag turns the view` : 'Drag over the scan to paint the part to name. Alt-drag turns the view'
}

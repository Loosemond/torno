export type ViewName = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
export interface Camera { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; ortho: boolean; fov: number; zoom: number }
/**
 * What the person has selected in the layout shown, as of a build: its refs name geometry of that revision only.
 * `refs` are the first of them, `MAX_SELECTION_REPORTED` at most; `total` is how many are selected in all.
 */
export interface SelectionReport { revision: number; total: number; refs: Array<{ ref: string; descriptor?: string }> }
/** The most refs of a selection that are reported. */
export const MAX_SELECTION_REPORTED = 8
export interface ViewState { objectId: string; layout: string; camera: Camera; visible: string[] /* part keys */; selection?: SelectionReport }
export interface LookRequest { view?: 'current' | ViewName | Camera; layout?: string; parts?: string[] /* names */; size?: number; marks?: boolean /* draw the marks and their numbers; true when absent */ }
/** A picture, and what the window drew to make it: the object it had open, that object's revision, and whether its parts were stale. */
export interface LookResult { png: Uint8Array; width: number; height: number; caption: string; objectId: string; revision: number; stale: boolean }
/** What the agent asks the window to show: an object, and of it a view, a layout, some parts (by name). */
export interface ShowRequest { objectId: string; view?: ViewName | Camera; layout?: string; parts?: string[] }
/** What the window did for a `ShowRequest`: what it now shows, as the caption of a picture would say it, and of which object and build. */
export interface ShowResult { caption: string; objectId: string; revision: number; stale: boolean }
/** What the agent asks the window to point out to the person: refs of the layout shown, tinted in the agent's colour, with a note. */
export interface HighlightRequest { objectId: string; layout: string; refs: string[]; note?: string }
/** What the window pointed out, and of which object and build. */
export interface HighlightResult { objectId: string; layout: string; refs: string[]; revision: number }

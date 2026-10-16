import type { Camera } from './view'

// A drawing on the view (the chat's "Draw on view"): the picture the agent's `look` makes of the view on screen, with
// the person's ink on it, and what that ink lies over. The window makes it; main checks it and words it for the agent
// (`main/sessions/drawing.ts`). It goes with one prompt and is kept nowhere.

/** The hue of `--drawing-ink` in both themes, as the agent is told it beside the very colour. */
export const DRAWING_INK_NAME = 'magenta'
/** The most strokes the agent is told of, the most faces of one and the most scans of one; the rest are counted. */
export const MOST_STROKES_TOLD = 16
export const MOST_REFS_TOLD = 6
export const MOST_SCANS_TOLD = 4

/** What one stroke of ink lies over in the picture, where ink is still left of it. */
export interface StrokeUnder {
  /** Its box in pixels of the picture: left, top, right, bottom. */
  box: [number, number, number, number]
  /** The faces under it (`lid/F12`), in the order the stroke first crosses them, each with the kernel's line when it came. */
  refs: Array<{ ref: string; descriptor?: string }>
  /** How many more faces it crosses than `refs` holds. */
  moreRefs?: number
  /** The scans under it where no part is (`S1`). */
  scans: string[]
  /** Some of it lies over no part (nor a scan). */
  bare: boolean
}

/** A drawing on the view, as the window gives it to main with a prompt. */
export interface ViewDrawing {
  objectId: string
  /** The build it was drawn on, and the layout. */
  revision: number
  layout: string
  /** The caption of the picture, as `look` made it. */
  caption: string
  /** Where the view was seen from. */
  camera: Camera
  /** The picture with the ink on it: a PNG of `width` × `height`. */
  png: Uint8Array
  width: number
  height: number
  /** The ink, `#rrggbb`. */
  ink: string
  /** Stroke by stroke, what the ink lies over; null when the screen changed while it was drawn and it could not be said. */
  under: StrokeUnder[] | null
  /** Strokes not in `under`, beyond `MOST_STROKES_TOLD`. */
  moreStrokes?: number
}

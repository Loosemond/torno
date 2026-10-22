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
/** The most parts whose cut face (a section's) one stroke is told to lie over. */
export const MOST_CUTS_TOLD = 4

/** What one stroke of ink lies over in the picture, where ink is still left of it. */
export interface StrokeUnder {
  /** Its box in pixels of the picture: left, top, right, bottom. */
  box: [number, number, number, number]
  /** The faces under it (`lid/F12`), in the order the stroke first crosses them, each with the kernel's line when it came. */
  refs: Array<{ ref: string; descriptor?: string }>
  /** How many more faces it crosses than `refs` holds. */
  moreRefs?: number
  /** The parts whose cut face, where a section cuts them, is under it (`lid`), in the order first crossed. */
  cuts: string[]
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

/** The most faces the line a drawing is shown by lists; the rest are counted. */
export const MOST_FACES_LISTED = 8

/**
 * What a drawing's ink lies over, as the person is shown it before the drawing goes and under it once it has: refs and
 * counts, no kernel line and no pixel. The chat keeps it on the prompt's item (text, so the log may hold it); the
 * picture is never kept.
 */
export interface DrawnOver {
  /** The build the drawing was made on: the faces are of it. */
  revision: number
  /** The object's latest build when the prompt went, when it was another than `revision`. */
  latest?: number
  /** Null when the view moved while it was drawn and it could not be said. */
  over: {
    /** The faces, once each, in the order the strokes first cross them (`lid/F12`). */
    faces: string[]
    moreFaces?: number
    /** The parts whose cut face, where a section cuts them, is under the ink. */
    cuts: string[]
    scans: string[]
    /** The strokes, by number from 1, that lie over no part and no scan. */
    bare: number[]
    /** How many strokes have ink left. */
    strokes: number
    moreStrokes?: number
  } | null
}

const once = (all: string[]): string[] => [...new Set(all)]

/** What the ink of a drawing lies over, as `DrawnOver`; `latest` is the object's last build now. */
export function drawnOver(d: Pick<ViewDrawing, 'revision' | 'under' | 'moreStrokes'>, latest?: number): DrawnOver {
  const stamp = latest !== undefined && latest !== d.revision ? { latest } : {}
  if (d.under === null) return { revision: d.revision, ...stamp, over: null }
  const all = once(d.under.flatMap((s) => s.refs.map((r) => r.ref)))
  const unlisted = all.length - MOST_FACES_LISTED
  const moreFaces = Math.max(0, unlisted) + d.under.reduce((n, s) => n + (s.moreRefs ?? 0), 0)
  return {
    revision: d.revision,
    ...stamp,
    over: {
      faces: all.slice(0, MOST_FACES_LISTED),
      ...(moreFaces > 0 ? { moreFaces } : {}),
      cuts: once(d.under.flatMap((s) => s.cuts)),
      scans: once(d.under.flatMap((s) => s.scans)),
      bare: d.under.flatMap((s, i) => (s.refs.length === 0 && s.cuts.length === 0 && s.scans.length === 0 ? [i + 1] : [])),
      strokes: d.under.length,
      ...(d.moreStrokes ? { moreStrokes: d.moreStrokes } : {})
    }
  }
}

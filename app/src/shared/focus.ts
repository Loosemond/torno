// A focus is the place a picture, or the camera, is framed on: a box of the layout in the object frame, in
// millimetres, and how far round it the view reaches. Main works the box out of what the agent named (`look`'s
// and `show`'s `focus`); the window frames it.

type Vec3 = [number, number, number]

/** A box to frame, and the margin round it, in mm, on every side. */
export interface FocusBox {
  min: Vec3
  max: Vec3
  margin: number
}

/** How far round the box the view reaches when the agent says nothing: a share of the box's longest side. */
export const DEFAULT_FOCUS_MARGIN = 0.3
/** The most a margin may be, as a share of the box's longest side. */
export const MAX_FOCUS_MARGIN = 5
/** The box's longest side counts as this long at the least: a mark at a point is framed with room round it, not magnified to a speck. */
export const LEAST_FOCUS_MM = 20

/** The margin of a box, in mm, for a share of its longest side. */
export function focusMargin(box: { min: readonly number[]; max: readonly number[] }, share: number): number {
  const longest = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])
  return share * Math.max(longest, LEAST_FOCUS_MM)
}

/** The box a view frames: the focus with its margin on every side. */
export function focusFrame(focus: FocusBox): { min: Vec3; max: Vec3 } {
  const grow = (v: Vec3, by: number): Vec3 => [v[0] + by, v[1] + by, v[2] + by]
  return { min: grow(focus.min, -focus.margin), max: grow(focus.max, focus.margin) }
}

/** Said when a focus is asked of parts drawn apart: the box is where the parts are built, not where an explode puts them. */
export const FOCUS_NOT_EXPLODED = 'a focus is a place on the parts as built: draw them together (explode null) to frame it'

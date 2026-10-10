import type { SectionPlane } from './view'

// What a section leaves of what is in a box, as plain numbers: asked by the viewport as it cuts the parts, and by
// whatever plans a picture of them without drawing it.

/**
 * What lies in the plane itself is kept: a plane put on a face leaves the face
 * drawn, and whole, where to the last bit it would be neither. In millimetres.
 */
export const KEPT_WITHIN_MM = 1e-3

/**
 * How far into the half that is kept the furthest corner of a box reaches, in
 * millimetres: negative for a box that is wholly in the half taken away.
 */
export function keptDepth(box: { min: ArrayLike<number>; max: ArrayLike<number> }, plane: SectionPlane): number {
  const n = plane.normal
  let depth = 0
  for (let i = 0; i < 3; i++) depth += -n[i] * ((box.min[i] + box.max[i]) / 2 - plane.origin[i]) + (Math.abs(n[i]) * (box.max[i] - box.min[i])) / 2
  return depth
}

/**
 * Whether a section leaves nothing of what is in a box: no corner of it
 * reaches into the half that is kept by more than what counts as lying in the
 * plane. Such a part only touches the plane (it rests on the face the plane
 * was put on) or is beyond it: it is not drawn at all, where the rule that
 * what lies in the plane is kept would leave a sheet of it.
 */
export function keepsNothing(box: { min: ArrayLike<number>; max: ArrayLike<number> }, plane: SectionPlane): boolean {
  return keptDepth(box, plane) <= 2 * KEPT_WITHIN_MM
}

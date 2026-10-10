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

const CUT_AXES = ['x', 'y', 'z'] as const
type CutAxis = (typeof CUT_AXES)[number]
type Looking = { position: ArrayLike<number>; target: ArrayLike<number> }

/** The axis a camera looks most along; of two it looks along alike, the first (x before y before z). */
export function facingAxis(camera: Looking): CutAxis {
  const along = CUT_AXES.map((_, i) => Math.abs(camera.position[i] - camera.target[i]))
  return CUT_AXES[along.indexOf(Math.max(...along))]
}

/**
 * Which way a new cut across an axis opens: +1 or -1 for the way its normal points, which is the side taken
 * away. It is the side the camera is on, so that what is seen is the inside of what is left and not its back.
 * A camera level with the plane leaves the +axis side taken away. The window and an exported page both ask this.
 */
export function towardsViewer(camera: Looking, axis: CutAxis): 1 | -1 {
  const i = CUT_AXES.indexOf(axis)
  return camera.position[i] - camera.target[i] < 0 ? -1 : 1
}

/**
 * A cut that is new: through the middle of a box, across an axis (the one the camera looks most along when
 * none is asked for), open towards the viewer (`towardsViewer`). The middle is taken to the hundredth of a
 * millimetre: what modelling leaves of a part meant to be centred is not told as where the plane is.
 */
export function newCut(box: { min: ArrayLike<number>; max: ArrayLike<number> }, camera: Looking, axis: CutAxis = facingAxis(camera)): SectionPlane {
  const i = CUT_AXES.indexOf(axis)
  const origin = CUT_AXES.map((_, n) => Math.round(((box.min[n] + box.max[n]) / 2) * 100) / 100 + 0) as [number, number, number]
  const normal: [number, number, number] = [0, 0, 0]
  normal[i] = towardsViewer(camera, axis)
  return { origin, normal }
}

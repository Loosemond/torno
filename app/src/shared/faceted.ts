const FACETED_MIN_FACES = 1000
const FACETED_SHARE = 0.9
/** The angle between two triangles, in degrees, from which the edge they share is drawn on a faceted part. */
export const CREASE_ANGLE = 25

/**
 * Whether a part is a solid made of a mesh (a sewn STL): at least a thousand
 * faces, nine in ten of them one or two triangles. Every triangle of such a
 * part is a face of its own, so its B-rep edges are the outline of every
 * triangle, and drawn they cover the part in dark bands.
 */
export function isFaceted(trianglesPerFace: ArrayLike<number>): boolean {
  const faces = trianglesPerFace.length
  if (faces < FACETED_MIN_FACES) return false
  let small = 0
  for (let i = 0; i < faces; i++) if (trianglesPerFace[i] <= 2) small += 1
  return small >= faces * FACETED_SHARE
}

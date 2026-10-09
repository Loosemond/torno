// What one stamp of the Region tool's brush takes, where a part may be in front of some of it.

/** How many triangles of one stamp are asked about, one pick each, when a part is in front of some of the brush. */
export const STAMP_TESTS = 400

/**
 * The triangles a stamp takes of those under the brush. With no part in front of the brush's centre or of any of
 * the eight points of its rim (`rimBlocked` all false), all of them. Otherwise each is asked about (`hidden`), up
 * to `cap`; those not asked about are left: what is not seen to be in sight is not painted.
 */
export function stampTriangles(gathered: readonly number[], rimBlocked: readonly boolean[], hidden: (triangle: number) => boolean, cap = STAMP_TESTS): number[] {
  if (!rimBlocked.some(Boolean)) return [...gathered]
  const taken: number[] = []
  for (const triangle of gathered.slice(0, cap)) if (!hidden(triangle)) taken.push(triangle)
  return taken
}

// What one stamp of the Region tool's brush takes, where a part may be in front of some of it.

/**
 * How many triangles of one stamp are asked about anew, one pick of the parts' faces each, when a part is near the
 * brush. A pick is about 0.04 ms (measured in the hidden window on the fixtures): a stamp is held to some 40 ms.
 */
export const STAMP_TESTS = 1000

/**
 * Whether what a part's box covers of the screen meets the square round a brush `pixels` wide either way of
 * (`x`, `y`): only then can the part hide anything under the brush. `corners` are the box's, where each is
 * drawn; null for one behind the eye, which is drawn nowhere that can be said: such a box is taken to meet it.
 */
export function boxMeetsBrush(corners: ReadonlyArray<readonly [number, number] | null>, x: number, y: number, pixels: number): boolean {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const corner of corners) {
    if (corner === null || !Number.isFinite(corner[0]) || !Number.isFinite(corner[1])) return true
    left = Math.min(left, corner[0])
    right = Math.max(right, corner[0])
    top = Math.min(top, corner[1])
    bottom = Math.max(bottom, corner[1])
  }
  return left <= x + pixels && right >= x - pixels && top <= y + pixels && bottom >= y - pixels
}

/**
 * The triangles a stamp takes of those under the brush. With no part near the brush on the screen (`near`
 * false), all of them, unasked. Otherwise each is taken only when it is seen: what is `known` of it from an
 * earlier stamp (true for hidden) is not asked again, and what is not is asked (`hidden`), `cap` times at most.
 * Past the cap nothing more is taken: what is not seen to be in sight is not painted, and `capped` says the
 * stamp left some for the next.
 */
export function stampTriangles(gathered: readonly number[], near: boolean, known: (triangle: number) => boolean | undefined, hidden: (triangle: number) => boolean, cap = STAMP_TESTS): { taken: number[]; capped: boolean } {
  if (!near) return { taken: [...gathered], capped: false }
  const taken: number[] = []
  let asked = 0
  let capped = false
  for (const triangle of gathered) {
    let is = known(triangle)
    if (is === undefined) {
      if (asked >= cap) {
        capped = true
        continue
      }
      asked += 1
      is = hidden(triangle)
    }
    if (!is) taken.push(triangle)
  }
  return { taken, capped }
}

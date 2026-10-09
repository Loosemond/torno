import { describe, expect, it } from 'vitest'
import { STAMP_TESTS, boxMeetsBrush, stampTriangles } from './stamp'

describe('stampTriangles', () => {
  it('takes every triangle under the brush when no part is near it, and asks about none', () => {
    let asked = 0
    expect(stampTriangles([4, 5, 6], false, () => undefined, () => (asked++, true))).toEqual({ taken: [4, 5, 6], capped: false })
    expect(asked).toBe(0)
  })

  it('asks about each one when a part is near, and leaves those hidden', () => {
    expect(stampTriangles([4, 5, 6, 7], true, () => undefined, (t) => t % 2 === 1)).toEqual({ taken: [4, 6], capped: false })
  })

  it('asks once of a triangle: what is known of it is not asked again, and does not count', () => {
    const known = new Map<number, boolean>([[4, true], [5, false]])
    const asked: number[] = []
    expect(stampTriangles([4, 5, 6], true, (t) => known.get(t), (t) => (asked.push(t), false), 1)).toEqual({ taken: [5, 6], capped: false })
    expect(asked).toEqual([6])
  })

  it('takes at the cap only what was asked about and found in sight, never the rest, and says the cap was met', () => {
    const gathered = Array.from({ length: STAMP_TESTS + 50 }, (_, i) => i)
    const { taken, capped } = stampTriangles(gathered, true, () => undefined, () => false)
    expect(taken).toHaveLength(STAMP_TESTS)
    expect(taken.at(-1)).toBe(STAMP_TESTS - 1)
    expect(capped).toBe(true)
    expect(stampTriangles(gathered.slice(0, STAMP_TESTS), true, () => undefined, () => false).capped).toBe(false)
  })
})

describe('boxMeetsBrush', () => {
  const corners = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]

  it('is whether what a part’s box covers of the screen meets the square round the brush', () => {
    expect(boxMeetsBrush(corners(10, 10, 20, 20), 25, 15, 4)).toBe(false)
    expect(boxMeetsBrush(corners(10, 10, 20, 20), 25, 15, 5)).toBe(true)
    // The brush wholly inside it, and it wholly inside the brush.
    expect(boxMeetsBrush(corners(0, 0, 100, 100), 50, 50, 3)).toBe(true)
    expect(boxMeetsBrush(corners(49, 49, 51, 51), 50, 50, 30)).toBe(true)
    expect(boxMeetsBrush(corners(10, 10, 20, 20), 15, 40, 5)).toBe(false)
  })

  it('is so of a box with a corner behind the eye, which is drawn nowhere that can be said', () => {
    expect(boxMeetsBrush([[900, 900], null, [910, 910]], 0, 0, 1)).toBe(true)
  })
})

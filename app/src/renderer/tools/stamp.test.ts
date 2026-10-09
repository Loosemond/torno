import { describe, expect, it } from 'vitest'
import { STAMP_TESTS, stampTriangles } from './stamp'

const NONE = [false, false, false, false, false, false, false, false]

describe('stampTriangles', () => {
  it('takes every triangle under the brush when no part is in front of its rim, and asks about none', () => {
    let asked = 0
    expect(stampTriangles([4, 5, 6], NONE, () => (asked++, true))).toEqual([4, 5, 6])
    expect(asked).toBe(0)
  })

  it('asks about each one when a part is in front of any of the rim, and leaves those hidden', () => {
    const rim = [false, false, true, false, false, false, false, false]
    expect(stampTriangles([4, 5, 6, 7], rim, (t) => t % 2 === 1)).toEqual([4, 6])
  })

  it('leaves what it did not ask about: what is not seen to be in sight is not painted', () => {
    const gathered = Array.from({ length: STAMP_TESTS + 50 }, (_, i) => i)
    const taken = stampTriangles(gathered, [true, ...NONE.slice(1)], () => false)
    expect(taken).toHaveLength(STAMP_TESTS)
    expect(taken.at(-1)).toBe(STAMP_TESTS - 1)
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_FOCUS_MARGIN, LEAST_FOCUS_MM, focusFrame, focusMargin } from './focus'

describe('the margin of a focus', () => {
  it('is a share of the box’s longest side, and the box counts as 20 mm at the least', () => {
    expect(focusMargin({ min: [0, 0, 0], max: [100, 40, 5] }, DEFAULT_FOCUS_MARGIN)).toBeCloseTo(30, 12)
    expect(focusMargin({ min: [0, 0, 0], max: [4, 4, 0] }, DEFAULT_FOCUS_MARGIN)).toBeCloseTo(0.3 * LEAST_FOCUS_MM, 12)
    expect(focusMargin({ min: [1, 2, 3], max: [1, 2, 3] }, 0.5)).toBe(10)
    expect(focusMargin({ min: [0, 0, 0], max: [100, 40, 5] }, 0)).toBe(0)
  })

  it('is added on every side of the frame', () => {
    expect(focusFrame({ min: [0, 0, 0], max: [10, 20, 0], margin: 2 })).toEqual({ min: [-2, -2, -2], max: [12, 22, 2] })
  })
})

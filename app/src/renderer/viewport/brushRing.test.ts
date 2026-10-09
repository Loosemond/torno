import { describe, expect, it } from 'vitest'
import { ringPoints } from './brushRing'

describe('the brush ring', () => {
  it('is a circle of the brush’s radius lying in the surface, about where the pointer is', () => {
    for (const normal of [[0, 0, 1], [1, 0, 0], [0.6, 0, 0.8]] as Array<[number, number, number]>) {
      const points = ringPoints({ centre: [10, 20, 30], normal, radius: 5 }, 12)
      expect(points).toHaveLength(12)
      for (const p of points) {
        const d = [p[0] - 10, p[1] - 20, p[2] - 30]
        expect(Math.hypot(...d)).toBeCloseTo(5, 9)
        expect(d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]).toBeCloseTo(0, 9)
      }
    }
    // A hit that gives no direction is drawn flat rather than not at all.
    expect(ringPoints({ centre: [0, 0, 0], normal: [0, 0, 0], radius: 2 }, 4).every((p) => Math.abs(p[2]) < 1e-9)).toBe(true)
  })
})

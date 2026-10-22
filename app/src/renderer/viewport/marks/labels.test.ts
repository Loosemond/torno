import { describe, expect, it } from 'vitest'
import { chipAt, needsCamera, type Placed } from './labels'

describe('bringing a selected mark into view', () => {
  it('moves the camera only for a mark whose label is not in view, or is not drawn at all', () => {
    expect(needsCamera({ visible: true })).toBe(false)
    expect(needsCamera({ visible: false })).toBe(true)
    expect(needsCamera(null)).toBe(true)
  })
})

describe('the chip under the pointer', () => {
  const chip = (id: string, x: number, y: number, visible = true): Placed => ({ id, text: id, author: 'user', x, y, visible, lean: [0, -1], gap: 9, box: { x, y, w: 30, h: 17 } })
  const placed = [chip('M1', 100, 100), chip('M2', 120, 108), chip('M3', 300, 300, false)]

  it('is the one whose box holds the point, the one drawn last where two meet', () => {
    expect(chipAt(placed, 105, 105)).toBe('M1')
    expect(chipAt(placed, 125, 112)).toBe('M2')
    expect(chipAt(placed, 145, 120)).toBe('M2')
  })

  it('takes in the hairline round a chip, and nothing further', () => {
    expect(chipAt(placed, 99, 100)).toBe('M1')
    expect(chipAt(placed, 96, 100)).toBeNull()
    expect(chipAt(placed, 110, 200)).toBeNull()
  })

  it('is never one that is not drawn', () => {
    expect(chipAt(placed, 305, 305)).toBeNull()
    expect(chipAt([], 0, 0)).toBeNull()
  })
})

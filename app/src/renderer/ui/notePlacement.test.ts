import { describe, expect, it } from 'vitest'
import { NOTE_GAP, placeBeside, type Box } from './notePlacement'

const PANE: Box = { left: 60, top: 50, right: 800, bottom: 600 }
const CARD = { w: 260, h: 110 }
const around = (x: number, y: number, r = 20): Box => ({ left: x - r, top: y - r, right: x + r, bottom: y + r })
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const cardBox = (p: { x: number; y: number }): Box => ({ left: p.x, top: p.y, right: p.x + CARD.w, bottom: p.y + CARD.h })

describe('placeBeside', () => {
  it('puts the note on the side of the mark with more room, clear of the mark', () => {
    const left = around(200, 300)
    const onRight = placeBeside(left, [200, 300], CARD, PANE)
    expect(onRight.side).toBe('right')
    expect(onRight.x).toBe(left.right + NOTE_GAP)
    expect(overlaps(cardBox(onRight), left)).toBe(false)

    const right = around(650, 300)
    const onLeft = placeBeside(right, [650, 300], CARD, PANE)
    expect(onLeft.side).toBe('left')
    expect(onLeft.x + CARD.w).toBe(right.left - NOTE_GAP)
    expect(overlaps(cardBox(onLeft), right)).toBe(false)
  })

  it('stays inside the pane beside a mark near its top or its bottom', () => {
    expect(placeBeside(around(200, 60), [200, 60], CARD, PANE).y).toBe(PANE.top)
    expect(placeBeside(around(200, 590), [200, 590], CARD, PANE).y).toBe(PANE.bottom - CARD.h)
  })

  it('goes below or above a mark as wide as the view', () => {
    const wide: Box = { left: 80, top: 100, right: 780, bottom: 160 }
    const below = placeBeside(wide, [80, 130], CARD, PANE)
    expect(below.side).toBe('below')
    expect(overlaps(cardBox(below), wide)).toBe(false)
    expect(below.x).toBeGreaterThanOrEqual(PANE.left)
    const low: Box = { left: 80, top: 480, right: 780, bottom: 560 }
    const above = placeBeside(low, [80, 500], CARD, PANE)
    expect(above.side).toBe('above')
    expect(overlaps(cardBox(above), low)).toBe(false)
  })

  it('keeps clear of the point of a mark that fills the view', () => {
    const all: Box = { left: 70, top: 60, right: 790, bottom: 590 }
    const placed = placeBeside(all, [300, 300], CARD, PANE)
    expect(placed.side).toBe('right')
    expect(overlaps(cardBox(placed), around(300, 300, 10))).toBe(false)
    expect(placed.x + CARD.w).toBeLessThanOrEqual(PANE.right)
  })
})

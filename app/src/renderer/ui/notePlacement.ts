/** A box in pixels, from the top left of the viewport pane. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Room left between the note and its mark. */
export const NOTE_GAP = 12
/** How far above its mark's point the top of a note beside it starts. */
const RISE = 18
/** What is treated as the mark when the whole of it leaves no room: this much around its point. */
const POINT_REACH = 14

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)))
}

/**
 * Where the note of a mark goes so that it does not cover the mark: beside it,
 * on the side with more room; failing that below or above it, again where
 * there is more room. `mark` is what the mark covers and `at` its point,
 * `card` the size of the note, and `within` the part of the pane it may use.
 * A mark that leaves no room on any side (an arrow across the whole view) is
 * taken for its point alone. The answer is the note's top left corner.
 */
export function placeBeside(mark: Box, at: [number, number], card: { w: number; h: number }, within: Box): { x: number; y: number; side: 'right' | 'left' | 'below' | 'above' } {
  const maxX = within.right - card.w
  const maxY = within.bottom - card.h
  const beside = (box: Box, force: boolean): ReturnType<typeof placeBeside> | null => {
    const room = { right: within.right - box.right - NOTE_GAP, left: box.left - within.left - NOTE_GAP, below: within.bottom - box.bottom - NOTE_GAP, above: box.top - within.top - NOTE_GAP }
    const horizontal = room.right >= room.left ? 'right' : 'left'
    if (room[horizontal] >= card.w || force) {
      const x = horizontal === 'right' ? box.right + NOTE_GAP : box.left - NOTE_GAP - card.w
      return { x: clamp(x, within.left, maxX), y: clamp(at[1] - RISE, within.top, maxY), side: horizontal }
    }
    const vertical = room.below >= room.above ? 'below' : 'above'
    if (room[vertical] < card.h) return null
    const y = vertical === 'below' ? box.bottom + NOTE_GAP : box.top - NOTE_GAP - card.h
    return { x: clamp(at[0] - card.w / 2, within.left, maxX), y: clamp(y, within.top, maxY), side: vertical }
  }
  const point: Box = { left: at[0] - POINT_REACH, top: at[1] - POINT_REACH, right: at[0] + POINT_REACH, bottom: at[1] + POINT_REACH }
  return beside(mark, false) ?? beside(point, true)!
}

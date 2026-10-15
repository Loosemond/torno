import { describe, expect, it } from 'vitest'
import { type GroundCell, edgeGround, paletteColour } from './termGround'

const PALETTE = ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']

const plain: GroundCell = { isBgDefault: () => true, isBgPalette: () => false, isBgRGB: () => false, getBgColor: () => -1, isInverse: () => 0 }
const rgb = (colour: number): GroundCell => ({ ...plain, isBgDefault: () => false, isBgRGB: () => true, getBgColor: () => colour })
const indexed = (index: number): GroundCell => ({ ...plain, isBgDefault: () => false, isBgPalette: () => true, getBgColor: () => index })

/** A screen of `cols` × `rows` cells, each as `at` says. */
const screen = (cols: number, rows: number, at: (x: number, y: number) => GroundCell) => ({ cols, rows, cell: (x: number, y: number) => (x < cols && y < rows ? at(x, y) : undefined) })

describe('edgeGround', () => {
  it('is none where the agent paints no ground of its own: the panel shows', () => {
    expect(edgeGround(screen(80, 24, () => plain), PALETTE)).toBeNull()
  })

  it('is the ground an agent paints its whole screen in, as a colour of its own or of the palette', () => {
    expect(edgeGround(screen(80, 24, () => rgb(0x14141e)), PALETTE)).toBe('#14141e')
    expect(edgeGround(screen(80, 24, () => indexed(236)), PALETTE)).toBe('#303030')
    expect(edgeGround(screen(80, 24, () => indexed(4)), PALETTE)).toBe('#0000aa')
  })

  it('goes by most of the left column and the bottom row: what borders the inset', () => {
    // A status line in another colour across the top, a prompt in the default ground on one row: the ground holds.
    const busy = screen(80, 24, (x, y) => (y === 0 ? rgb(0x3355aa) : y === 10 && x < 20 ? plain : rgb(0x14141e)))
    expect(edgeGround(busy, PALETTE)).toBe('#14141e')
    // Painted only in the middle: the edges are the panel's.
    expect(edgeGround(screen(80, 24, (x, y) => (x > 10 && x < 70 && y > 3 && y < 20 ? rgb(0x14141e) : plain)), PALETTE)).toBeNull()
  })

  it('passes over a cell drawn inverse, whose ground is its text colour', () => {
    const inverse: GroundCell = { ...rgb(0xffffff), isInverse: () => 1 }
    expect(edgeGround(screen(4, 3, (x) => (x === 0 ? inverse : rgb(0x14141e))), PALETTE)).toBe('#14141e')
  })

  it('is none of a screen with no size', () => {
    expect(edgeGround(screen(0, 0, () => plain), PALETTE)).toBeNull()
  })
})

describe('paletteColour', () => {
  it('is the theme for the sixteen, then the colour cube, then the greys', () => {
    expect(paletteColour(9, PALETTE)).toBe('#ff5555')
    expect(paletteColour(16, PALETTE)).toBe('#000000')
    expect(paletteColour(21, PALETTE)).toBe('#0000ff')
    expect(paletteColour(196, PALETTE)).toBe('#ff0000')
    expect(paletteColour(231, PALETTE)).toBe('#ffffff')
    expect(paletteColour(232, PALETTE)).toBe('#080808')
    expect(paletteColour(255, PALETTE)).toBe('#eeeeee')
  })
})

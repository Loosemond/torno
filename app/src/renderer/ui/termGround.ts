// The ground an agent paints its terminal in. An agent's CLI may fill its whole screen with a background of its
// own; the terminal's inset in the pane, and what is left beyond its last whole cell, are then drawn in that
// ground too, so that its screen fills the pane. Read from the cells that border the inset: the left column and
// the bottom row.

/** What is read of a cell: xterm's `IBufferCell` has these. */
export interface GroundCell {
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  getBgColor(): number
  isInverse(): number
}

/** A screen as it is shown: its size, and a cell of it by column and row from the top of what is shown. */
export interface GroundScreen {
  cols: number
  rows: number
  cell(x: number, y: number): GroundCell | undefined
}

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`

/** The colour of a palette index: the theme's sixteen (`palette`, black to bright white), then the 6 × 6 × 6 cube, then 24 greys. */
export function paletteColour(index: number, palette: readonly string[]): string | null {
  if (index < 16) return palette[index] ?? null
  if (index < 232) {
    const level = (n: number): number => (n === 0 ? 0 : 55 + 40 * n)
    const i = index - 16
    return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
  }
  if (index < 256) {
    const grey = 8 + 10 * (index - 232)
    return hex(grey, grey, grey)
  }
  return null
}

/**
 * The ground the agent paints the edges of its screen in, as a CSS colour, or null where most of those cells are
 * left to the terminal's own ground (the panel). Most of the left column and the bottom row decides: a status
 * line or a prompt in another colour does not.
 */
export function edgeGround(screen: GroundScreen, palette: readonly string[]): string | null {
  const counts = new Map<string | null, number>()
  const count = (cell: GroundCell | undefined): void => {
    if (!cell || cell.isInverse()) return
    const colour = cell.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, '0')}` : cell.isBgPalette() ? paletteColour(cell.getBgColor(), palette) : null
    counts.set(colour, (counts.get(colour) ?? 0) + 1)
  }
  for (let y = 0; y < screen.rows - 1; y += 1) count(screen.cell(0, y))
  for (let x = 0; x < screen.cols; x += 1) count(screen.cell(x, screen.rows - 1))
  let most: string | null = null
  let best = 0
  for (const [colour, n] of counts) {
    if (n > best || (n === best && colour === null)) [most, best] = [colour, n]
  }
  return most
}

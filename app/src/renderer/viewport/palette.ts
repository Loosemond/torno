/** The part palette, in order. Equal to --part-1..8 in styles/tokens.css. */
export const PALETTE: readonly string[] = [
  '#7B93B4',
  '#C28B6C',
  '#8DA888',
  '#C8A75B',
  '#A48BA7',
  '#6E8388',
  '#B56F76',
  '#7FA7A6'
]

/**
 * The colour of a part. `index` is the part's position among the scene's sorted
 * unique names (see `colorsByName`); it wraps after the palette runs out. A part
 * with no usable index still gets a steady colour, taken from its name.
 */
export function colorFor(name: string, index: number): string {
  const n = PALETTE.length
  const i = Number.isInteger(index) && index >= 0 ? index : hashName(name)
  return PALETTE[i % n]
}

/**
 * One colour per part name, by position among the sorted unique names, so a part
 * keeps its colour across layouts and rebuilds.
 */
export function colorsByName(names: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(names)].sort()
  return new Map(sorted.map((name, index) => [name, colorFor(name, index)]))
}

/** The darker tint of a part colour that its edges are drawn in. */
export function edgeTint(hex: string): string {
  return mix(hex, '#000000', 0.5)
}

/** Blends `a` towards `b` by `t` (0 gives `a`, 1 gives `b`), channel by channel. */
export function mix(a: string, b: string, t: number): string {
  const ca = channels(a)
  const cb = channels(b)
  return (
    '#' +
    ca
      .map((v, i) => Math.round(v + (cb[i] - v) * t))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

function channels(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

function hashName(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  return h >>> 0
}

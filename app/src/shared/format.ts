/** A length or a coordinate smaller than this is what modelling leaves where it means nothing. */
const NOISE = 1e-6

/**
 * A number with at most four significant digits and no trailing zeros, as the
 * kernel writes them in descriptors (`number` in kernel/src/torno_kernel/describe.py).
 * Millimetres are meant: a magnitude under a millionth is written `0`. Every
 * number shown or told is written so; what is stored is full precision.
 */
export function number(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (Math.abs(value) < NOISE) return '0'
  const decimals = 3 - Math.floor(Math.log10(Math.abs(value)))
  if (decimals <= 0) {
    const step = 10 ** -decimals
    return String(Math.round(value / step) * step)
  }
  const text = value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

/**
 * How well something fits, in millimetres: `number`, of the value to the thousandth. What a fit of clicked
 * points leaves is never known finer than that, and `0.000004247 mm` says nothing `0 mm` does not.
 */
export function fitNumber(mm: number): string {
  return number(Math.round(mm * 1000) / 1000)
}

/**
 * A length or a coordinate taken from a scan, in millimetres: to the tenth, and never -0. A scan is true to a
 * few millimetres at best; `0.008139 mm` of one says nothing `0 mm` does not, and reads as if it did.
 */
export function scanNumber(mm: number): string {
  return number(Math.round(mm * 10) / 10 + 0)
}

/**
 * A figure of a fit as the agent is told it, less its unit: to a tenth of a millimetre, as everything a reading
 * takes from a scan is (`scanNumber`), and `under 0.1` below half of that. A few clicked points fitted to the
 * micron are no finer than the scan they were clicked on; the data keeps the numbers in full.
 */
export function tenth(mm: number): string {
  return Math.abs(mm) < 0.05 ? 'under 0.1' : scanNumber(mm)
}

/** How many of something: a whole number with its thousands set apart, `1,598,472`. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** What names a build (`r12`) or a part's face or edge (`plate/E7`) in a sentence. */
const NAMED = /(\br\d+\b|[\w.-]+\/[FE]\d+\b)/

/**
 * A sentence in pieces: every second one, from the second, names a build or
 * a ref, and is set in the face of numbers wherever the sentence is shown,
 * as every number and ref is. (`['not measured on ', 'r12', '']`.)
 */
export function namedPieces(text: string): string[] {
  return text.split(NAMED)
}

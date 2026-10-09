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

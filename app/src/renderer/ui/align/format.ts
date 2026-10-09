import { number } from '../../../shared/format'
import type { Vec3 } from '../../../shared/marks'

// What the bodies of the align bar share in showing and reading numbers.

export const AXES = ['x', 'y', 'z'] as const

export const coords = (p: Vec3): string => `(${p.map(number).join(', ')})`
/** A number as a field shows it: to the hundredth, without the zeros that say nothing. */
export const shown = (value: number): string => String(Math.round(value * 100) / 100 + 0)

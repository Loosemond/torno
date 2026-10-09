import { number } from './format'
import type { DimensionMark, MeasureKind } from './marks'

/** How far off its expected value a dimension may be when nothing says: 0.05 mm, and 0.1° for an angle. */
export function defaultTolerance(measure: MeasureKind): number {
  return measure === 'angle' ? 0.1 : 0.05
}

/** What a tolerance is compared with beyond itself: 8.05 against 8 ± 0.05 passes, whatever the last bit of the subtraction says. */
const SLACK = 1e-9

/**
 * Whether a measured value is what was expected: within the tolerance (the
 * default of its kind when none is given), the bound included. Undefined
 * without a value or without an expectation: there is nothing to judge.
 */
export function verdictOf(mark: Pick<DimensionMark, 'measure' | 'value' | 'expected' | 'tolerance'>): 'pass' | 'fail' | undefined {
  if (mark.value === undefined || mark.expected === undefined) return undefined
  const tolerance = mark.tolerance ?? defaultTolerance(mark.measure)
  return Math.abs(mark.value - mark.expected) <= tolerance + SLACK ? 'pass' : 'fail'
}

/**
 * The value a dimension may be said to have: the kernel's, while its ends are
 * where they were put. Undefined otherwise: a dimension whose ends the last
 * build moved or dropped is never given a value, it is not measurable.
 */
export function measuredValue(mark: DimensionMark): number | undefined {
  return mark.anchorState === 'ok' ? mark.value : undefined
}

/** A value of a kind of measurement as it is shown: `6 mm`, `⌀ 8 mm`, `R 4 mm`, `45°`. At most four significant digits. */
export function valueText(measure: MeasureKind, value: number): string {
  if (measure === 'angle') return `${number(value)}°`
  return `${measure === 'diameter' ? '⌀ ' : measure === 'radius' ? 'R ' : ''}${number(value)} mm`
}

/** What stands for the value of a dimension that has none. */
export const NO_VALUE = '—'

/** A dimension's value as it is shown beside its number, on the part and in the list; `—` when it has none. */
export function dimensionText(mark: DimensionMark): string {
  const value = measuredValue(mark)
  return value === undefined ? NO_VALUE : valueText(mark.measure, value)
}

/** `8.5 ± 0.05`: what a dimension should measure, with the tolerance that applies. Full precision, as typed. */
export function expectedText(mark: Pick<DimensionMark, 'measure' | 'expected' | 'tolerance'>): string {
  return `${mark.expected} ± ${mark.tolerance ?? defaultTolerance(mark.measure)}`
}

/** `0.5 under`, `0.2 over`: how far a value is from what was expected, and which way. */
export function offBy(value: number, expected: number): string {
  const by = value - expected
  return `${number(Math.abs(by))} ${by < 0 ? 'under' : 'over'}`
}

/**
 * Whether the kernel has yet been asked for a dimension's value in this run.
 * Until it has, a dimension without one is being measured; afterwards it is
 * not measurable.
 */
export function awaitsMeasurement(mark: DimensionMark): boolean {
  return mark.value === undefined && mark.measuredRevision === undefined && mark.anchorState === 'ok'
}

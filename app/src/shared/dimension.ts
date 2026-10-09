import { number } from './format'
import type { DimensionMark, Mark, MeasureKind } from './marks'

/** How far off its expected value a dimension may be when nothing says: 0.05 mm, and 0.1° for an angle. */
export function defaultTolerance(measure: MeasureKind): number {
  return measure === 'angle' ? 0.1 : 0.05
}

/**
 * What a tolerance is compared with beyond itself: 8.05 against 8 ± 0.05 passes, whatever the last bit of the
 * subtraction says. It is the least difference that is written as other than 0 (`number`): nothing fails by `0 over`.
 */
const SLACK = 1e-6

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
 * Whether an open dimension has not been measured on the build there is: what
 * it holds is then of an older build, or of an earlier run, and is no value
 * of this one. `revision` is that of the last build that worked. With none
 * there is nothing it was measured on: a dimension read from its file is not
 * measured until the first build of the run.
 */
export function isUnmeasured(mark: DimensionMark, revision: number | undefined): boolean {
  if (mark.status === 'resolved') return false
  return !(revision !== undefined && revision > 0 && mark.measuredRevision === revision)
}

/**
 * The value the kernel last gave a dimension, on whichever build that was.
 * None for one that lost the part of an end: nothing is measured from there.
 */
export function lastValue(mark: DimensionMark): number | undefined {
  return mark.anchorState === 'orphaned' ? undefined : mark.value
}

/**
 * The value a dimension may be said to have on the build `revision`: the
 * kernel's, measured on that build. Undefined otherwise: a value of another
 * build is never given as that of this one (`isUnmeasured`), and a dimension
 * the kernel could not measure, or whose part is gone, has none. One whose
 * end the build moved is measured from what is under it now, and has a value.
 *
 * This is the one rule for whatever shows or tells a dimension: its row, its
 * chip on the part and in a picture, its line, and its data for the agent.
 */
export function measuredValue(mark: DimensionMark, revision: number | undefined): number | undefined {
  return isUnmeasured(mark, revision) ? undefined : lastValue(mark)
}

/**
 * How a dimension stands on the build `revision`, as a check of the part:
 * `unmeasurable` when it has no value there and can have none (its part is
 * gone, or the kernel refused), `unmeasured` when what it holds is not of
 * that build, `fail` or `pass` against what is expected of it, and `measured`
 * when nothing is.
 */
export type DimensionStanding = 'unmeasured' | 'unmeasurable' | 'fail' | 'pass' | 'measured'
export function standingOf(mark: DimensionMark, revision: number | undefined): DimensionStanding {
  if (mark.anchorState === 'orphaned') return 'unmeasurable'
  if (isUnmeasured(mark, revision)) return 'unmeasured'
  if (mark.value === undefined) return 'unmeasurable'
  return mark.verdict ?? 'measured'
}

/**
 * The dimensions among some marks that the build `revision` does not meet:
 * those that fail what is expected of them, and those with no value of that
 * build (not measured on it, or not measurable). Resolved ones are no longer
 * checks of the part, and are in neither.
 */
export function unmetDimensions(marks: readonly Mark[], revision: number | undefined): { failing: DimensionMark[]; unmeasured: DimensionMark[] } {
  const open = marks.filter((m): m is DimensionMark => m.kind === 'dimension' && m.status !== 'resolved')
  const standing = (m: DimensionMark): DimensionStanding => standingOf(m, revision)
  return { failing: open.filter((m) => standing(m) === 'fail'), unmeasured: open.filter((m) => standing(m) === 'unmeasured' || standing(m) === 'unmeasurable') }
}

/** The verdict a dimension has on the build `revision`: none without a value of that build. */
export function verdictOn(mark: DimensionMark, revision: number | undefined): 'pass' | 'fail' | undefined {
  return measuredValue(mark, revision) === undefined ? undefined : mark.verdict
}

/** `not measured on r12`: said of a dimension in place of a value that is not of the build there is; `not measured` when there is no build. */
export function unmeasuredText(revision: number | undefined): string {
  return revision !== undefined && revision > 0 ? `not measured on r${revision}` : 'not measured'
}

/** A value of a kind of measurement as it is shown: `6 mm`, `⌀ 8 mm`, `R 4 mm`, `45°`. At most four significant digits. */
export function valueText(measure: MeasureKind, value: number): string {
  if (measure === 'angle') return `${number(value)}°`
  return `${measure === 'diameter' ? '⌀ ' : measure === 'radius' ? 'R ' : ''}${number(value)} mm`
}

/** What stands for the value of a dimension that has none. */
export const NO_VALUE = '—'

/** A dimension's value on the build `revision` as it is shown beside its number, on the part and in the list; `—` when it has none there. */
export function dimensionText(mark: DimensionMark, revision: number | undefined): string {
  const value = measuredValue(mark, revision)
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

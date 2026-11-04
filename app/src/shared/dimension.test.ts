import { describe, expect, it } from 'vitest'
import { valueAgainstExpected, dimensionText, exactText, notMeasuredText, shownDimension, isOffEdge, isUnmeasured, offEdgeReason, lastValue, measuredValue, offBy, standingOf, unmeasuredText, unmetDimensions, checksOf, isCheck, verdictOf, verdictOn } from './dimension'
import type { DimensionMark, Mark } from './marks'

const dim = (over: Partial<DimensionMark> = {}): DimensionMark =>
  ({ id: 'M1', kind: 'dimension', measure: 'diameter', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'main', revision: 1, a: { point: [0, 0, 0], part: 'plate', ref: 'plate/F9' }, value: 8, how: 'cylinder', measuredRevision: 3, ...over }) as DimensionMark

describe('the verdict', () => {
  it('passes within the tolerance, the bound included, and by the default when none is given', () => {
    expect(verdictOf({ measure: 'diameter', value: 8.05, expected: 8 })).toBe('pass')
    expect(verdictOf({ measure: 'diameter', value: 8.06, expected: 8 })).toBe('fail')
    expect(verdictOf({ measure: 'angle', value: 45.1, expected: 45 })).toBe('pass')
    expect(verdictOf({ measure: 'angle', value: 45.11, expected: 45 })).toBe('fail')
    expect(verdictOf({ measure: 'diameter', value: 8.4, expected: 8, tolerance: 0.5 })).toBe('pass')
    expect(verdictOf({ measure: 'diameter', value: 8 })).toBeUndefined()
    expect(verdictOf({ measure: 'diameter', expected: 8 })).toBeUndefined()
  })

  it('with no tolerance at all, passes what differs by less than is ever written: nothing fails by `0 over`', () => {
    expect(verdictOf({ measure: 'distance', value: 6.0000000004, expected: 6, tolerance: 0 })).toBe('pass')
    expect(verdictOf({ measure: 'distance', value: 6.0000005, expected: 6, tolerance: 0 })).toBe('pass')
    expect(verdictOf({ measure: 'distance', value: 6.000002, expected: 6, tolerance: 0 })).toBe('fail')
    expect(offBy(6.000002, 6)).toBe('0.000002 over')
    expect(offBy(5, 6)).toBe('1 under')
  })
})

describe('the value a dimension may be said to have', () => {
  it('is the one measured on the build there is', () => {
    expect(measuredValue(dim(), 3)).toBe(8)
    expect(isUnmeasured(dim(), 3)).toBe(false)
    expect(dimensionText(dim(), 3)).toBe('⌀ 8 mm')
  })

  it('is none when it was measured on another build, on none this run, or there is no build', () => {
    for (const [mark, revision] of [[dim(), 4], [dim({ measuredRevision: undefined }), 3], [dim(), 0], [dim(), undefined]] as const) {
      expect(isUnmeasured(mark, revision)).toBe(true)
      expect(measuredValue(mark, revision)).toBeUndefined()
      expect(verdictOn({ ...mark, expected: 8, verdict: 'pass' }, revision)).toBeUndefined()
      expect(dimensionText(mark, revision)).toBe('—')
      // What it was is still known, to be shown as that.
      expect(lastValue(mark)).toBe(8)
    }
    expect(unmeasuredText(4)).toBe('not measured on r4')
    expect(unmeasuredText(0)).toBe('not measured')
    expect(unmeasuredText(undefined)).toBe('not measured')
  })

  it('stands for one whose end the build moved: it is measured from what is under it now', () => {
    expect(measuredValue(dim({ anchorState: 'drifted' }), 3)).toBe(8)
    expect(verdictOn(dim({ anchorState: 'drifted', expected: 9, verdict: 'fail' }), 3)).toBe('fail')
  })

  it('is none once the part of an end is gone, and none that it was', () => {
    const gone = dim({ anchorState: 'orphaned', expected: 8, verdict: 'pass' })
    expect(measuredValue(gone, 3)).toBeUndefined()
    expect(lastValue(gone)).toBeUndefined()
    expect(verdictOn(gone, 3)).toBeUndefined()
  })

  it('of a resolved one is what it was: it is no longer measured', () => {
    expect(isUnmeasured(dim({ status: 'resolved' }), 9)).toBe(false)
    expect(measuredValue(dim({ status: 'resolved' }), 9)).toBe(8)
  })
})

describe('what is shown of a dimension, in its row, on its chip, in a picture', () => {
  it('is its value and its verdict on the build it was measured on', () => {
    expect(shownDimension(dim({ expected: 8, verdict: 'pass' }), 3)).toEqual({ text: '⌀ 8 mm', value: 8, verdict: 'pass' })
    expect(shownDimension(dim(), 3)).toEqual({ text: '⌀ 8 mm', value: 8 })
    // A verdict is of a value and an expectation: one that says neither is not taken for a failure.
    expect(shownDimension(dim({ expected: 8 }), 3)).toEqual({ text: '⌀ 8 mm', value: 8 })
  })

  it('on another build is what it was, stale, with no verdict, and says of which build', () => {
    expect(shownDimension(dim({ expected: 8, verdict: 'pass' }), 4)).toEqual({ text: '⌀ 8 mm', stale: true, of: 3, note: 'not measured on r4: this is what it was on r3' })
  })

  it('of a resolved one is the value as measured on the build it was last measured on: no verdict, stale, whatever it held', () => {
    const resolved = dim({ status: 'resolved', expected: 8, verdict: 'pass', measuredRevision: 5 })
    expect(shownDimension(resolved, 6)).toEqual({ text: '⌀ 8 mm', stale: true, of: 5, note: 'as measured on r5: resolved, it is no longer measured' })
    expect(shownDimension(dim({ status: 'resolved', expected: 8, verdict: 'pass', measuredRevision: undefined }), 6)).toEqual({ text: '⌀ 8 mm', stale: true, note: 'as measured on an earlier build: resolved, it is no longer measured' })
    // Resolved on the build there is, it is still that build's.
    expect(shownDimension(resolved, 5)).toEqual({ text: '⌀ 8 mm', value: 8, verdict: 'pass' })
    expect(shownDimension(dim({ status: 'resolved', value: undefined }), 6)).toEqual({ text: 'not measured', none: true, note: 'resolved: it is no longer measured' })
  })

  it('held from a run before, or never measured, is not measured yet: what the file holds is of no build of this run', () => {
    expect(shownDimension(dim({ measuredRevision: undefined, expected: 8, verdict: 'pass' }), 1)).toEqual({ text: 'not measured yet', none: true })
    expect(shownDimension(dim({ measuredRevision: undefined }), undefined)).toEqual({ text: 'not measured yet', none: true })
    expect(shownDimension(dim({ measuredRevision: undefined, value: undefined }), 4)).toEqual({ text: 'not measured yet', none: true })
    expect(notMeasuredText(dim({ measuredRevision: undefined }), 4)).toBe('not measured yet')
    expect(notMeasuredText(dim(), 4)).toBe('not measured on r4')
  })

  it('without a value it can have, says so', () => {
    expect(shownDimension(dim({ value: undefined, refused: 'no diameter' }), 3)).toEqual({ text: 'not measurable', none: true })
    expect(shownDimension(dim({ anchorState: 'orphaned' }), 3)).toEqual({ text: 'not measurable', none: true })
  })

  it('a value in full has its unit as everywhere: no space before the degree', () => {
    expect(exactText('angle', 45.00000001)).toBe('45.00000001°')
    expect(exactText('diameter', 8.0000001)).toBe('8.0000001 mm')
  })
})

describe('how a dimension stands on a build', () => {
  it('fails, passes or is only measured, on the build it was measured on', () => {
    expect(standingOf(dim({ expected: 8.5, verdict: 'fail' }), 3)).toBe('fail')
    expect(standingOf(dim({ expected: 8, verdict: 'pass' }), 3)).toBe('pass')
    expect(standingOf(dim(), 3)).toBe('measured')
  })

  it('is unmeasured on any other, whatever verdict it holds, and unmeasurable without a value or without its part', () => {
    expect(standingOf(dim({ expected: 8, verdict: 'pass' }), 4)).toBe('unmeasured')
    expect(standingOf(dim({ value: undefined, measuredRevision: undefined }), 4)).toBe('unmeasured')
    expect(standingOf(dim({ value: undefined, refused: 'no diameter' }), 3)).toBe('unmeasurable')
    expect(standingOf(dim({ anchorState: 'orphaned', measuredRevision: 2 }), 3)).toBe('unmeasurable')
  })

  it('unmetDimensions gathers those that fail and those with no value of the build, among the unresolved', () => {
    const marks = [
      dim({ id: 'M1', expected: 8.5, verdict: 'fail' }),
      dim({ id: 'M2', expected: 8, verdict: 'pass' }),
      dim({ id: 'M3', measuredRevision: 2, expected: 8.5, verdict: 'fail' }),
      dim({ id: 'M4', anchorState: 'orphaned' }),
      dim({ id: 'M5', status: 'resolved', expected: 8.5, verdict: 'fail' }),
      dim({ id: 'M6', status: 'draft', expected: 8.5, verdict: 'fail' }),
      { id: 'M7', kind: 'pin', status: 'sent' } as Mark
    ]
    const { failing, unmeasured, passing } = unmetDimensions(marks, 3)
    expect(failing.map((m) => m.id)).toEqual(['M1', 'M6'])
    expect(unmeasured.map((m) => m.id)).toEqual(['M3', 'M4'])
    expect(passing.map((m) => m.id)).toEqual(['M2'])
  })

  it('checksOf counts only the dimensions that have something expected of them', () => {
    const marks = [
      dim({ id: 'M1', expected: 8.5, verdict: 'fail' }),
      dim({ id: 'M2', expected: 8, verdict: 'pass' }),
      dim({ id: 'M3' }),
      dim({ id: 'M4', measuredRevision: 2, expected: 8 }),
      dim({ id: 'M5', anchorState: 'orphaned' }),
      dim({ id: 'M6', status: 'resolved', expected: 8, verdict: 'pass' })
    ]
    const { failing, unmeasured, passing } = checksOf(marks, 3)
    expect(failing.map((m) => m.id)).toEqual(['M1'])
    expect(passing.map((m) => m.id)).toEqual(['M2'])
    expect(unmeasured.map((m) => m.id)).toEqual(['M4'])
    expect(marks.filter(isCheck).map((m) => m.id)).toEqual(['M1', 'M2', 'M4'])
  })
})

describe('an end that is off the edge it was put on', () => {
  it('is said by main in words the window knows again', () => {
    expect(offEdgeReason('plate/E7', 12)).toBe('the edge plate/E7 it was on is not under its end on r12')
    expect(isOffEdge(offEdgeReason('plate/E7', 12))).toBe(true)
    expect(isOffEdge('plate/F9 is a plane face: it has no diameter')).toBe(false)
    expect(isOffEdge(undefined)).toBe(false)
  })
})

describe('a dimension against what was expected', () => {
  it('says its value on the build and what was expected, with the tolerance that applies', () => {
    expect(valueAgainstExpected(dim({ measure: 'distance', value: 6, expected: 8, tolerance: 0.05, measuredRevision: 9 }), 9)).toBe('6 mm, expected 8 ± 0.05')
    expect(valueAgainstExpected(dim({ measure: 'diameter', value: 8.3, expected: 8 }), 3)).toBe('⌀ 8.3 mm, expected 8 ± 0.05')
    expect(valueAgainstExpected(dim({ measure: 'angle', value: 44, expected: 45 }), 3)).toBe('44°, expected 45 ± 0.1')
  })

  it('says nothing of a dimension with no value of that build, or nothing expected', () => {
    expect(valueAgainstExpected(dim({ value: 6, expected: 8, measuredRevision: 3 }), 4)).toBeUndefined()
    expect(valueAgainstExpected(dim({ value: 6 }), 3)).toBeUndefined()
  })
})

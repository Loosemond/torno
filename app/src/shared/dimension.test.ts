import { describe, expect, it } from 'vitest'
import { dimensionText, isOffEdge, isUnmeasured, offEdgeReason, lastValue, measuredValue, offBy, standingOf, unmeasuredText, unmetDimensions, verdictOf, verdictOn } from './dimension'
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
    const { failing, unmeasured } = unmetDimensions(marks, 3)
    expect(failing.map((m) => m.id)).toEqual(['M1', 'M6'])
    expect(unmeasured.map((m) => m.id)).toEqual(['M3', 'M4'])
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

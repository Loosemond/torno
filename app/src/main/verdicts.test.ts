import { describe, expect, it } from 'vitest'
import type { DimensionMark, Mark } from '../shared/marks'
import { VERDICTS_KEPT, Verdicts, verdictChanges } from './verdicts'

const dim = (id: string, over: Partial<DimensionMark> = {}): DimensionMark =>
  ({ id, kind: 'dimension', measure: 'diameter', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'main', revision: 1, a: { point: [0, 0, 0], part: 'plate', ref: 'plate/F9' }, value: 8, expected: 8, verdict: 'pass', how: 'cylinder', measuredRevision: 7, ...over }) as DimensionMark
const pin = { id: 'M9', kind: 'pin', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'main', revision: 1, anchor: { point: [0, 0, 0] } } as unknown as Mark

describe("each build's verdicts on the dimensions", () => {
  it('keeps what each dimension with an expected value says of a build, none while it has no value of it', () => {
    const verdicts = new Verdicts()
    verdicts.record('box', 7, [dim('M1'), dim('M2', { value: 9, verdict: 'fail' }), dim('M3', { measuredRevision: 6 }), dim('M4', { expected: undefined, verdict: undefined }), dim('M5', { status: 'resolved' }), pin])
    expect([...verdicts.of('box', 7)!]).toEqual([
      ['M1', 'pass'],
      ['M2', 'fail'],
      ['M3', 'none']
    ])
    expect(verdicts.of('box', 6)).toBeUndefined()
    expect(verdicts.of('other', 7)).toBeUndefined()
  })

  it('replaces the snapshot of the last build, and never one of a build before it', () => {
    const verdicts = new Verdicts()
    verdicts.record('box', 7, [dim('M1')])
    verdicts.record('box', 8, [dim('M1', { measuredRevision: 8, value: 9, verdict: 'fail' })])
    // What the marks hold now is of r8: told of r7 it would say none.
    verdicts.record('box', 7, [dim('M1', { measuredRevision: 8, value: 9, verdict: 'fail' })])
    expect(verdicts.of('box', 7)?.get('M1')).toBe('pass')
    expect(verdicts.of('box', 8)?.get('M1')).toBe('fail')
  })

  it(`keeps the last ${VERDICTS_KEPT} builds of an object`, () => {
    const verdicts = new Verdicts()
    for (let r = 1; r <= VERDICTS_KEPT + 2; r++) verdicts.record('box', r, [dim('M1', { measuredRevision: r })])
    expect(verdicts.of('box', 2)).toBeUndefined()
    expect(verdicts.of('box', 3)?.get('M1')).toBe('pass')
    verdicts.forget('box')
    expect(verdicts.of('box', VERDICTS_KEPT + 2)).toBeUndefined()
  })

  it('waits for the marks to be checked against a build, or for the time given', async () => {
    const verdicts = new Verdicts()
    let done = false
    const waiting = verdicts.settled('box', 8, Date.now() + 5000).then(() => (done = true))
    verdicts.checkedOn('box', 7, [dim('M1')])
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    verdicts.checkedOn('box', 8, [dim('M1', { measuredRevision: 8 })])
    await waiting
    expect(verdicts.of('box', 8)?.get('M1')).toBe('pass')
    const started = Date.now()
    await verdicts.settled('box', 9, Date.now() + 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })
})

describe('which dimensions changed verdict between two builds', () => {
  it('names each with what it was and what it is, none for one that had no verdict', () => {
    const was = new Map([
      ['M1', 'pass' as const],
      ['M2', 'fail' as const],
      ['M3', 'none' as const],
      ['M6', 'pass' as const]
    ])
    const now = new Map([
      ['M1', 'fail' as const],
      ['M2', 'pass' as const],
      ['M3', 'none' as const],
      ['M4', 'pass' as const]
    ])
    expect(verdictChanges(was, now)).toEqual([
      { id: 'M1', was: 'pass', now: 'fail' },
      { id: 'M2', was: 'fail', now: 'pass' },
      { id: 'M4', was: 'none', now: 'pass' }
    ])
    expect(verdictChanges(undefined, now)).toEqual([])
    expect(verdictChanges(was, undefined)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { marksByPart } from './layerMarks'

const base = { author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1 }
const pin = (id: string, part: string, over: object = {}): Mark => ({ ...base, id, kind: 'pin', anchor: { point: [0, 0, 0], part }, ...over }) as Mark
const dimension = (id: string, a: string, b: string, over: object = {}): Mark =>
  ({ ...base, id, kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0], part: a }, b: { point: [0, 0, 1], part: b }, value: 40, expected: 40, verdict: 'pass', measuredRevision: 4, ...over }) as Mark

describe('the open marks on each part', () => {
  const marks = [
    pin('M1', 'lid'),
    pin('M2', 'lid', { status: 'draft' }),
    pin('M3', 'lid', { status: 'resolved' }),
    pin('M4', 'tub', { layout: 'print' }),
    dimension('M5', 'lid', 'tub'),
    dimension('M6', 'tub', 'tub', { value: 38, verdict: 'fail' }),
    { ...base, id: 'M7', kind: 'region', scan: 'S1' } as unknown as Mark
  ]

  it('counts the open ones of the layout shown, a dimension for each part it is between, and leaves out resolved marks, other layouts and regions', () => {
    const counts = marksByPart(marks, 'assembly', 4)
    expect(counts.get('lid')).toEqual({ open: 3, failing: false })
    expect(counts.get('tub')).toEqual({ open: 2, failing: true })
    expect(counts.size).toBe(2)
  })

  it('says a check that fails only of the build there is', () => {
    expect(marksByPart(marks, 'assembly', 5).get('tub')).toEqual({ open: 2, failing: false })
  })
})

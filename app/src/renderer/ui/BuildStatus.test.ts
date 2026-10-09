import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DimensionMark, Mark } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { store } from '../state/store'
import { dimensionCount, goToRow } from './BuildStatus'
import { OFF_EDGE_ADVICE, shownValue, whyNotMeasurable } from './DimensionFields'

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const dim = (id: string, over: object = {}): DimensionMark =>
  ({ id, kind: 'dimension', measure: 'diameter', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 3, camera: CAMERA, createdAt: 't', a: { point: [0, 0, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder', measuredRevision: 3, expected: 8.5, verdict: 'fail', ...over }) as DimensionMark
const SCENE = { model: 'm.py', layouts: ['assembly', 'print'], parts: [], seconds: 0, output: '' } as unknown as Scene

describe('the click on the count of failing dimensions', () => {
  let scrolled: string[]

  beforeEach(() => {
    scrolled = []
    vi.stubGlobal('document', { querySelector: (selector: string) => ({ scrollIntoView: () => void scrolled.push(selector) }) })
    store.setState({ objectId: 'bracket', scene: SCENE, revision: 3, layout: 'assembly', marks: [dim('M2', { layout: 'print' }), dim('M5')] as Mark[], activeMark: 'M5', markFocus: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('goes to the mark as its row does: its layout is shown when it is of another, it is the active one, and its row is brought into view', () => {
    goToRow('M2')
    const s = store.getState()
    expect(s.layout).toBe('print')
    expect(s.activeMark).toBe('M2')
    // The view goes to it, as on a click on the row.
    expect(s.markFocus).toBe(1)
    expect(scrolled).toEqual(['.mark-row[data-mark="M2"]'])
  })

  it('stays in the layout shown for a mark of that one', () => {
    goToRow('M5')
    expect(store.getState()).toMatchObject({ layout: 'assembly', activeMark: 'M5' })
  })

  it('makes a mark of a layout the build no longer has the active one, and shows no other layout for it', () => {
    store.setState({ marks: [dim('M2', { layout: 'gone' }), dim('M5')] as Mark[] })
    goToRow('M2')
    expect(store.getState()).toMatchObject({ layout: 'assembly', activeMark: 'M2', markFocus: 0 })
    expect(scrolled).toEqual(['.mark-row[data-mark="M2"]'])
  })
})

describe('what the status line and the row say of dimensions', () => {
  it('counts in words', () => {
    expect([dimensionCount(1, 'fail'), dimensionCount(2, 'fail'), dimensionCount(1, 'not measured'), dimensionCount(3, 'not measured')]).toEqual(['dimension fails', 'dimensions fail', 'dimension not measured', 'dimensions not measured'])
  })

  it('shows a value of the build on show, and one of another build as what it was', () => {
    expect(shownValue(dim('M1'), 3)).toEqual({ text: '⌀ 8 mm' })
    expect(shownValue(dim('M1'), 4)).toEqual({ text: '⌀ 8 mm', stale: true })
    expect(shownValue(dim('M1', { value: undefined, measuredRevision: undefined }), 4)).toEqual({ text: 'not measured on r4', none: true })
    expect(shownValue(dim('M1', { anchorState: 'orphaned' }), 3)).toEqual({ text: 'not measurable', none: true })
  })

  it('of an end that is off its edge says what can be done; of any other refusal only the kernel’s reason', () => {
    const off = dim('M1', { value: undefined, refused: 'the edge base/E7 it was on is not under its end on r3' })
    expect(whyNotMeasurable(off)).toBe('the edge base/E7 it was on is not under its end on r3 — measure it again, or between faces')
    expect(OFF_EDGE_ADVICE).toBe(' — measure it again, or between faces')
    expect(whyNotMeasurable(dim('M1', { value: undefined, refused: 'base/F9 is a plane face: it has no diameter' }))).toBe('base/F9 is a plane face: it has no diameter')
    expect(whyNotMeasurable(dim('M1', { value: undefined }))).toBe('the kernel could not measure it on this build')
  })
})

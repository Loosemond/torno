import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DimensionMark, Mark } from '../../shared/marks'
import { ChecksSummary } from './ChecksSummary'

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const dim = (id: string, over: object = {}): DimensionMark =>
  ({ id, kind: 'dimension', measure: 'diameter', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 3, camera: CAMERA, createdAt: 't', a: { point: [0, 0, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder', measuredRevision: 12, expected: 8, verdict: 'pass', ...over }) as DimensionMark
const text = (marks: Mark[], revision: number): string => renderToStaticMarkup(createElement(ChecksSummary, { marks, revision })).replace(/<[^>]+>/g, '')

describe('the summary of the checks', () => {
  it('counts what passes and what fails on the build, in words', () => {
    const marks = [dim('M1'), dim('M2'), dim('M3'), dim('M4', { value: 9, verdict: 'fail' })]
    expect(text(marks, 12)).toBe('Checks on r12: 3 pass · 1 fails')
    expect(text([...marks, dim('M5', { value: 9, verdict: 'fail' })], 12)).toBe('Checks on r12: 3 pass · 2 fail')
  })

  it('leaves out a dimension with nothing expected, a resolved one, and says nothing without checks', () => {
    expect(text([dim('M1', { expected: undefined, verdict: undefined }), dim('M2', { status: 'resolved' })], 12)).toBe('')
    expect(text([], 12)).toBe('')
  })

  it('names the build only when there is one', () => {
    expect(text([dim('M1', { measuredRevision: undefined })], 0)).toBe('Checks: measuring')
  })
})

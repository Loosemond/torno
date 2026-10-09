import { describe, expect, it } from 'vitest'
import type { ScanAlignment } from '../../shared/scans'
import { alignmentSaid } from './said'

const pair = (n: number, residual: number) => ({ scan: [n, 0, 0] as [number, number, number], model: [n, 0, 0] as [number, number, number], residual })
const fitted = (rms: number, residuals: number[], more: Partial<ScanAlignment> = {}): ScanAlignment => ({ transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], frame: {}, at: '2026-10-10T09:00:00.000Z', pairs: residuals.map((residual, n) => pair(n, residual)), rms, ...more })
const said = (alignment: ScanAlignment) => alignmentSaid({ id: 'S1', alignments: { print: alignment }, checks: {} }, 'print')

// Milestone 5 (M7): a reading tells what it takes from a scan to 0.1 mm; the fit's own figures stood beside it in microns.
describe('what main says of a fit of pairs', () => {
  it('tells its RMS and its worst pair to a tenth of a millimetre, and under 0.05 mm as under 0.1 mm', () => {
    const fine = said(fitted(0.003, [0.001, 0.002, 0.005, 0.003]))
    expect(fine.line).toBe('aligned in print by 4 pairs (RMS under 0.1 mm, worst under 0.1 mm) (tied to no point of the model: not checked against builds)')
    expect(fine.last()).toBe('S1 is aligned by 4 pairs (RMS under 0.1 mm, worst under 0.1 mm): that RMS is of the clicked points, and says nothing of how true the scan is (tied to no point of the model: not checked against builds).')
    expect(fine.data.by).toBe('by 4 pairs (RMS under 0.1 mm, worst under 0.1 mm)')
    const coarse = said(fitted(1.26, [0.4, 2.04, 1.1]))
    expect(coarse.line).toContain('by 3 pairs (RMS 1.3 mm, worst 2 mm)')
  })

  it('keeps the numbers themselves in the data, in full', () => {
    expect(said(fitted(0.003, [0.001, 0.005])).data).toMatchObject({ rms: 0.003, worst: 0.005 })
  })

  it('tells to a tenth also how well a fit that was moved by hand fitted, where its pairs are now, and the plane of a floor', () => {
    expect(said(fitted(20.04, [20, 20.1, 20], { steps: ['pairs', 'nudge'], fitRms: 0.004 })).data.by).toBe('by 3 pairs (fit RMS under 0.1 mm), then moved by hand: the pairs are now 20 mm apart')
    expect(said({ transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['floor'], frame: {}, at: '', rms: 0.812 }).data.by).toBe('by floor only (plane RMS 0.8 mm): its place in that plane is as imported')
  })
})

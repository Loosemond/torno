import { describe, expect, it } from 'vitest'
import { type StrokeUnder, drawnOver } from './drawing'

const stroke = (over: Partial<StrokeUnder> = {}): StrokeUnder => ({ box: [0, 0, 10, 10], refs: [], cuts: [], scans: [], bare: false, ...over })
const faces = (...refs: string[]): StrokeUnder['refs'] => refs.map((ref) => ({ ref, descriptor: 'plane, normal +Z' }))

describe('drawnOver', () => {
  it('is the faces the strokes lie over, once each in the order they are first crossed, with no kernel line and no pixel', () => {
    const d = drawnOver({ revision: 3, moreStrokes: undefined, under: [stroke({ refs: faces('tub/F3', 'tub/F1') }), stroke({ refs: faces('tub/F1', 'lid/F2') })] })
    expect(d).toEqual({ revision: 3, over: { faces: ['tub/F3', 'tub/F1', 'lid/F2'], cuts: [], scans: [], bare: [], strokes: 2 } })
    expect(JSON.stringify(d)).not.toContain('plane')
    expect(JSON.stringify(d)).not.toContain('box')
  })

  it('names the cut faces and the scans, once each, and the strokes that lie over no part, by their number', () => {
    const d = drawnOver({ revision: 1, under: [stroke({ cuts: ['lid'] }), stroke({ bare: true }), stroke({ scans: ['S1'] }), stroke({ cuts: ['lid', 'base'], scans: ['S1', 'S2'] }), stroke({ bare: true })] })
    expect(d.over).toEqual({ faces: [], cuts: ['lid', 'base'], scans: ['S1', 'S2'], bare: [2, 5], strokes: 5 })
  })

  it('a stroke that is partly over a part is a stroke over that part', () => {
    expect(drawnOver({ revision: 1, under: [stroke({ refs: faces('a/F1'), bare: true })] }).over).toMatchObject({ faces: ['a/F1'], bare: [] })
  })

  it('counts the faces beyond the most it lists, the faces a stroke said it had more of, and the strokes not told', () => {
    const many = Array.from({ length: 6 }, (_, i) => `p/F${i}`)
    const d = drawnOver({ revision: 1, moreStrokes: 2, under: [stroke({ refs: faces(...many), moreRefs: 3 }), stroke({ refs: faces('q/F0', 'q/F1', 'q/F2', 'q/F3', 'q/F4') })] })
    expect(d.over?.faces).toHaveLength(8)
    expect(d.over?.moreFaces).toBe(3 + 3)
    expect(d.over?.moreStrokes).toBe(2)
  })

  it('is no `over` when it was not worked out, and no strokes when no ink is left', () => {
    expect(drawnOver({ revision: 2, under: null })).toEqual({ revision: 2, over: null })
    expect(drawnOver({ revision: 2, under: [] }).over).toEqual({ faces: [], cuts: [], scans: [], bare: [], strokes: 0 })
  })

  it('says the latest build when it is another than the one drawn on', () => {
    expect(drawnOver({ revision: 1, under: null }, 2).latest).toBe(2)
    expect(drawnOver({ revision: 2, under: null }, 2)).not.toHaveProperty('latest')
    expect(drawnOver({ revision: 2, under: null }, undefined)).not.toHaveProperty('latest')
  })
})

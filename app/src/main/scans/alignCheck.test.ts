import { describe, expect, it } from 'vitest'
import type { Part } from '../../shared/scene'
import type { ScanAlignment } from '../../shared/scans'
import type { NearestAnchor } from '../marks/reanchor'
import { anchoredPoints, checkAlignments, judgeAlignment, tiedToMoved } from './alignCheck'

const part = (name: string, arranged?: [number, number, number]): Part =>
  ({ key: `print:${name}`, name, layout: 'print', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, ...(arranged ? { arranged } : {}) }) as Part
const pair = (model: [number, number, number], on?: string) => ({ scan: [0, 0, 0] as [number, number, number], model, residual: 0, ...(on ? { part: on } : {}) })
const ALIGNED: ScanAlignment = {
  transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 },
  steps: ['pairs'],
  pairs: [pair([10, 5, 2.5], 'tray'), pair([-10, 5, 2.5], 'tray'), pair([0, -5, 2.5], 'lid'), pair([7, 7, 7])],
  frame: { tray: [0, 0, 0], lid: [45, 0, 0] },
  at: ''
}
const found = (part: string, distance: number): NearestAnchor => ({ part, found: true, point: [0, 0, 0], normal: null, ref: `${part}/F0`, distance, descriptor: null, support: 'face' }) as NearestAnchor

describe('judgeAlignment', () => {
  it('asks only of the points that were clicked on a part', () => {
    expect(anchoredPoints(ALIGNED)).toEqual([{ part: 'tray', point: [10, 5, 2.5] }, { part: 'tray', point: [-10, 5, 2.5] }, { part: 'lid', point: [0, -5, 2.5] }])
    expect(anchoredPoints({ ...ALIGNED, pairs: undefined, steps: ['floor'], floor: { part: 'tray', point: [0, 0, 2.5] } })).toEqual([{ part: 'tray', point: [0, 0, 2.5] }])
    expect(anchoredPoints({ ...ALIGNED, pairs: undefined, steps: ['floor'], floor: { point: [0, 0, 0] } })).toEqual([])
  })

  it('holds while the model is still under its points', () => {
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [45, 0, 0])], [found('tray', 0), found('tray', 0.2), found('lid', 0.01)], 12)
    expect(check).toEqual({ revision: 12, of: 3, off: 0, worst: 0.2, moved: [] })
  })

  it('counts the points the model has left, and a part that is gone', () => {
    // A box 40 × 30 × 5: within half a millimetre is on it.
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [45, 0, 0])], [found('tray', 6.2), found('tray', 0.5), { part: 'lid', found: false }], 12)
    expect(check).toMatchObject({ of: 3, off: 2, worst: 6.2 })
  })

  it('says which of the parts it is tied to torno has moved since', () => {
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [50, 0, 0]), part('clip', [90, 0, 0])], [found('tray', 0), found('tray', 0), found('lid', 0)], 12)
    // The clip was moved too, and the alignment is tied to nothing of it.
    expect(check.moved).toEqual(['lid'])
  })

  it('of an alignment tied to no part, any part torno has moved since', () => {
    const typed: ScanAlignment = { ...ALIGNED, steps: ['typed'], pairs: undefined, frame: { tray: [0, 0, 0], lid: [45, 0, 0] } }
    expect(judgeAlignment(typed, [part('tray'), part('lid', [50, 0, 0])], [], 12)).toEqual({ revision: 12, of: 0, off: 0, worst: 0, moved: ['lid'] })
    expect(judgeAlignment(typed, [part('tray'), part('lid', [45, 0, 0])], [], 12).moved).toEqual([])
    // A part that came with a later build was never where it was not: it says nothing.
    expect(judgeAlignment(typed, [part('tray'), part('lid', [45, 0, 0]), part('new')], [], 12).moved).toEqual([])
  })
})

describe('checkAlignments', () => {
  const scans = (alignments: Record<string, ScanAlignment>) => [{ id: 'S1', alignments }]
  const scene = { revision: 12, scene: { model: 'm.py', layouts: ['print'], parts: [part('tray'), part('lid', [50, 0, 0])], seconds: 0, output: '' } }

  it('asks the kernel once per alignment of a layout the build has, and keeps what it found', async () => {
    const asked: unknown[] = []
    const kept: unknown[] = []
    const done = await checkAlignments(
      {
        scans: { list: async () => scans({ print: ALIGNED, assembly: ALIGNED }) as never, checked: async (...args) => void kept.push(args) },
        scene: () => scene,
        nearest: async (_id, layout, anchors) => {
          asked.push([layout, anchors.length])
          return anchors.map((a) => found(a.part, 0))
        }
      },
      'box'
    )
    expect(done).toBe(true)
    expect(asked).toEqual([['print', 3]])
    expect(kept).toEqual([['box', 'S1', 'print', { revision: 12, of: 3, off: 0, worst: 0, moved: ['lid'] }]])
  })

  it('is to be tried again when the kernel could not be asked, and keeps nothing meanwhile', async () => {
    const kept: unknown[] = []
    const deps = { scans: { list: async () => scans({ print: ALIGNED }) as never, checked: async (...args: unknown[]) => void kept.push(args) }, scene: () => scene }
    expect(await checkAlignments({ ...deps, nearest: async () => Promise.reject(new Error('the kernel exited')) }, 'box')).toBe(false)
    expect(kept).toEqual([])
    expect(await checkAlignments({ ...deps, scene: () => undefined, nearest: async () => [] }, 'box')).toBe(true)
  })
})

// Beyond the brief's tests.
describe('and besides', () => {
  it('a point the kernel could say nothing of is not judged: the check is to be tried again', async () => {
    const kept: unknown[] = []
    const scene = { revision: 12, scene: { model: 'm.py', layouts: ['print'], parts: [part('tray'), part('lid', [45, 0, 0])], seconds: 0, output: '' } }
    const went = await checkAlignments(
      { scans: { list: async () => [{ id: 'S1', alignments: { print: ALIGNED } }] as never, checked: async (...args) => void kept.push(args) }, scene: () => scene, nearest: async (_id, _layout, anchors) => anchors.map((a) => ({ part: a.part, found: true, error: 'no surface' })) },
      'box'
    )
    expect(went).toBe(false)
    expect(kept).toEqual([])
  })

  it('names the parts a fit or a floor just made is tied to that torno moved for display', () => {
    const frame = { tray: [0, 0, 0] as [number, number, number], lid: [45, 0, 0] as [number, number, number] }
    expect(tiedToMoved(ALIGNED, frame)).toEqual(['lid'])
    expect(tiedToMoved({ steps: ['floor'], floor: { part: 'lid', point: [0, 0, 0] } }, frame)).toEqual(['lid'])
    expect(tiedToMoved({ steps: ['floor'], floor: { part: 'tray', point: [0, 0, 0] } }, frame)).toEqual([])
    // Moved by hand afterwards: the pairs are what it was once fitted to, and tie nothing anew.
    expect(tiedToMoved({ ...ALIGNED, steps: ['pairs', 'nudge'] }, frame)).toEqual([])
  })
})

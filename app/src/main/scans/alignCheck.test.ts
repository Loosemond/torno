import { describe, expect, it } from 'vitest'
import type { Part } from '../../shared/scene'
import type { ScanAlignment } from '../../shared/scans'
import type { NearestAnchor } from '../marks/reanchor'
import { anchoredPoints, checkAlignments, heldNow, judgeAlignment, tiedToMoved, uncheckedOn } from './alignCheck'

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

  // Fix round 1 (R-check): what the person confirmed is the ground a later build is judged from.
  it('judges a confirmed alignment against how far its points then were: what was confirmed is not raised again, what moved since is', () => {
    const confirmed: ScanAlignment = { ...ALIGNED, confirmed: { at: '', held: [6.2, 0, null] } }
    const parts = [part('tray'), part('lid', [45, 0, 0])]
    // As it was when it was confirmed: the first point 6.2 mm off, the lid's part gone.
    expect(judgeAlignment(confirmed, parts.slice(0, 1), [found('tray', 6.2), found('tray', 0.2), { part: 'lid', found: false }], 13)).toEqual({ revision: 13, of: 3, off: 0, worst: 6.2, moved: [] })
    // Further off than it was by more than a mark may be: raised.
    expect(judgeAlignment(confirmed, parts, [found('tray', 7.5), found('tray', 0.2), found('lid', 0)], 13)).toMatchObject({ off: 1, worst: 7.5 })
    // And a point that was under the model then, and is not now.
    expect(judgeAlignment(confirmed, parts, [found('tray', 6.2), found('tray', 3), found('lid', 0)], 13)).toMatchObject({ off: 1 })
  })

  it('says how far each point of an alignment is from its part, for what is recorded when it is confirmed', async () => {
    const scene = { revision: 12, scene: { model: 'm.py', layouts: ['print'], parts: [part('tray')], seconds: 0, output: '' } }
    const deps = { scans: { list: async () => [] as never, checked: async () => {} }, scene: () => scene }
    expect(await heldNow({ ...deps, nearest: async () => [found('tray', 6.2), found('tray', 0), { part: 'lid', found: false }] }, 'box', 'print', ALIGNED)).toEqual({ revision: 12, frame: { tray: [0, 0, 0] }, held: [6.2, 0, null] })
    // Tied to nothing: nothing is asked.
    expect(await heldNow({ ...deps, nearest: async () => Promise.reject(new Error('not asked')) }, 'box', 'print', { ...ALIGNED, pairs: undefined })).toEqual({ revision: 12, frame: { tray: [0, 0, 0] }, held: [] })
    await expect(heldNow({ ...deps, nearest: async () => Promise.reject(new Error('the kernel exited')) }, 'box', 'print', ALIGNED)).rejects.toThrow('the model could not be asked where its points are now (the kernel exited): try again')
    await expect(heldNow({ ...deps, scene: () => undefined, nearest: async () => [] }, 'box', 'print', ALIGNED)).rejects.toThrow('no build of this object has a layout named print')
  })

  it('is to be asked for again when an alignment of a layout the build has was not checked against it', () => {
    const ok = { revision: 12, of: 3, off: 0, worst: 0, moved: [] }
    const one = (checks: Record<string, typeof ok>) => [{ id: 'S1', alignments: { print: ALIGNED, assembly: ALIGNED }, checks }] as never
    expect(uncheckedOn(one({ print: ok }), ['print'], 12)).toBe(false)
    expect(uncheckedOn(one({ print: { ...ok, revision: 11 } }), ['print'], 12)).toBe(true)
    expect(uncheckedOn(one({}), ['print'], 12)).toBe(true)
    // A layout the build has not is nothing to check.
    expect(uncheckedOn(one({}), ['main'], 12)).toBe(false)
  })
})

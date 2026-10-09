import { describe, expect, it } from 'vitest'
import { apply, reckoned, rotate } from '../../shared/align'
import type { Vec3 } from '../../shared/marks'
import type { ScanAlignment, ScanInfo } from '../../shared/scans'
import { type AlignState, type FloorDraft, type PairDraft, alignStore, asKept, expects, fitOf, floorAlignment, floorWarning, movedAlignment, nextLine, pairsAlignment, previewOf, proposed, scanInHand, sizeNote, stepBack, withModelEnd, withScanEnd, withTypedEnd } from './align'

describe('the pairs in hand', () => {
  it('take their ends in either order, each to the first pair that lacks one', () => {
    let pairs = withScanEnd([], [1, 2, 3])
    pairs = withScanEnd(pairs, [4, 5, 6])
    pairs = withModelEnd(pairs, [10, 0, 0], 'base')
    pairs = withModelEnd(pairs, [20, 0, 0])
    pairs = withModelEnd(pairs, [30, 0, 0], 'post')
    expect(pairs).toEqual([{ scan: [1, 2, 3], model: [10, 0, 0], part: 'base' }, { scan: [4, 5, 6], model: [20, 0, 0] }, { model: [30, 0, 0], part: 'post' }])
  })

  it('fit once three are whole, and say so as an alignment that starts over', () => {
    const whole = [[0, 0, 0], [10, 0, 0], [0, 10, 0]].map((p) => ({ scan: p as [number, number, number], model: [p[0] + 5, p[1], p[2] + 1] as [number, number, number], part: 'base' }))
    expect(fitOf(whole.slice(0, 2), false)).toBeNull()
    expect(fitOf([...whole.slice(0, 2), { scan: [0, 10, 0] }], false)).toBeNull()
    const fit = fitOf(whole, false)
    if (!fit || 'error' in fit) throw new Error('no fit')
    const made = pairsAlignment(whole, fit)
    expect(made.steps).toEqual(['pairs'])
    expect(made.transform.t.map((c) => Math.round(c * 1e9) / 1e9)).toEqual([5, 0, 1])
    expect(made.pairs).toHaveLength(3)
    expect(made.pairs![0]).toMatchObject({ scan: [0, 0, 0], model: [5, 0, 1], part: 'base' })
  })
})

describe('what is added to an alignment', () => {
  const current: ScanAlignment = { transform: { t: [5, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], pairs: [], rms: 1, frame: {}, at: '' }

  it('a floor is composed on what there is, and says what it was laid on', () => {
    const floor = { plane: { origin: [5, 0, 30] as [number, number, number], normal: [0, 0, 1] as [number, number, number], rms: 0.4, used: 120 }, facing: [0, 0, 1] as [number, number, number] }
    const onGround = floorAlignment(current, floor, null, 2)
    expect(onGround).toMatchObject({ steps: ['pairs', 'floor'], rms: 0.4, floor: { point: [0, 0, 2] } })
    expect(onGround.transform.t).toEqual([5, 0, -28])
    const onFace = floorAlignment(null, floor, { origin: [0, 0, 2.5], normal: [0, 0, 1], part: 'base' }, 0)
    expect(onFace).toMatchObject({ steps: ['floor'], floor: { part: 'base', point: [0, 0, 2.5] } })
    expect(onFace.transform.t).toEqual([0, 0, -27.5])
  })

  it('a nudge and typed values are added once each in a row', () => {
    const nudged = movedAlignment(current, { t: [6, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'nudge')
    expect(nudged.steps).toEqual(['pairs', 'nudge'])
    expect(movedAlignment({ ...current, ...nudged, frame: {}, at: '' }, { t: [7, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'nudge').steps).toEqual(['pairs', 'nudge'])
    expect(movedAlignment(null, { t: [7, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'typed').steps).toEqual(['typed'])
  })
})

describe('sizeNote', () => {
  const fit = (freeScale: number) => ({ transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, residuals: [], rms: 0, freeScale }) as never
  it('says a unit when the size is one, a per cent when it is off, and nothing when it fits', () => {
    expect(sizeNote(fit(1000.2), 'mm')).toBe('These points fit 1000 × larger: this scan looks like it is in m, and was imported as mm. Change its unit on its row.')
    expect(sizeNote(fit(0.0393), 'in')).toBe('These points fit 25.4 × smaller: this scan looks like it is in mm, and was imported as in. Change its unit on its row.')
    expect(sizeNote(fit(0.982), 'mm')).toBe('The scan measures 1.8 % larger than the model between these points.')
    expect(sizeNote(fit(1.02), 'mm')).toBe('The scan measures 2 % smaller than the model between these points.')
    expect(sizeNote(fit(1.002), 'mm')).toBeNull()
  })
})

// Beyond the brief's tests: the rulings, and what Task 4's review asked of the floor.
describe('what is in hand, and what it would make', () => {
  const state = (over: Partial<AlignState>): AlignState => ({ ...alignStore.getInitialState(), ...over })
  const scan = { id: 'S1' } as ScanInfo
  const three: PairDraft[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0]].map((p) => ({ scan: p as Vec3, model: [p[0] + 5, p[1], p[2] + 1] as Vec3 }))

  it('says in one line what to click next', () => {
    expect(nextLine(state({}), null, 0, null)).toBe('Import a scan first')
    expect(nextLine(state({}), null, 2, null)).toBe('Choose the scan to align')
    expect(nextLine(state({ mode: 'pairs' }), scan, 1, null)).toBe('Click a point on the scan')
    expect(nextLine(state({ mode: 'pairs', pairs: [{ scan: [0, 0, 0] }] }), scan, 1, null)).toBe('Now the same point on the model, or type it')
    expect(nextLine(state({ mode: 'pairs', pairs: three.slice(0, 2) }), scan, 1, null)).toBe('Click another point on the scan: 2 of 3 pairs')
    expect(nextLine(state({ mode: 'pairs', pairs: three }), scan, 1, null)).toBe('Apply, or click another point on the scan to tighten the fit')
    expect(nextLine(state({ mode: 'floor' }), scan, 1, null)).toBe('Click the floor of the scan')
    expect(nextLine(state({ mode: 'floor', points: [[0, 0, 0]] }), scan, 1, null)).toBe('Shift-click 2 more on the floor')
    expect(nextLine(state({ mode: 'floor', choosingFace: true }), scan, 1, null)).toBe('Click a flat face of the model to lay the floor on')
  })

  it('expects the model end while a pair has only its scan end, and the scan end otherwise', () => {
    expect(expects([])).toBe('scan')
    expect(expects([{ scan: [0, 0, 0] }])).toBe('model')
    expect(expects(three)).toBe('scan')
    expect(expects([{ model: [0, 0, 0] }])).toBe('scan')
  })

  it('steps back one pick at a time, and has nothing left to step back from in the end', () => {
    let s = state({ mode: 'pairs', pairs: [three[0], { scan: [1, 1, 1] }] })
    const back = (): boolean => {
      const step = stepBack(s)
      if (step) s = { ...s, ...step }
      return step !== null
    }
    expect(back()).toBe(true)
    expect(s.pairs).toEqual([three[0]])
    expect(back()).toBe(true)
    expect(s.pairs).toEqual([{ scan: [0, 0, 0] }])
    expect(back()).toBe(true)
    expect(s.pairs).toEqual([])
    expect(back()).toBe(false)
    // A question that waits is withdrawn before anything of the draft goes.
    s = state({ mode: 'pairs', pairs: three, asking: { made: { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'] }, why: 'so' } })
    expect(back()).toBe(true)
    expect(s).toMatchObject({ asking: null, pairs: three })
  })

  it('makes of fewer than three pairs, or of pairs in a line, what they fix of the scan as it stands: rough, and never drawn before it is asked', () => {
    const floored: ScanAlignment = { transform: { t: [0, 0, -30], q: [0, 0, 0, 1], s: 1 }, steps: ['floor'], rms: 0.4, floor: { point: [0, 0, 0] }, frame: {}, at: '' }
    const two = proposed(state({ mode: 'pairs', pairs: [{ scan: [0, 0, 30], model: [50, 0, 0] }, { scan: [10, 0, 30], model: [50, 10, 0] }] }), floored)!
    expect(two).toMatchObject({ few: true, need: '2 of 3 pairs: with fewer, how the scan is turned is not fixed', made: { steps: ['floor', 'pairs'], floor: { point: [0, 0, 0] } } })
    expect(two.made.pairs).toHaveLength(2)
    expect(two.fit!.rms).toBeLessThan(1e-9)
    expect(reckoned(two.made).rough).toBe('it has 2 pairs of points: it takes three that are not in a line to fix a scan')
    expect(previewOf(state({ mode: 'pairs', pairs: three.slice(0, 2) }), null)).toBeNull()
    const line = proposed(state({ mode: 'pairs', pairs: [[0, 0, 0], [10, 0, 0], [20, 0, 0]].map((p) => ({ scan: p as Vec3, model: p as Vec3 })) }), null)!
    expect(line).toMatchObject({ few: true, need: 'the scan points are in a line: an alignment needs three that are not' })
    // Three that are not in a line: a fit, drawn at once.
    expect(previewOf(state({ mode: 'pairs', pairs: three }), null)!.t.map((c) => Math.round(c * 1e9) / 1e9)).toEqual([5, 0, 1])
    expect(proposed(state({ mode: 'pairs' }), null)).toBeNull()
    expect(proposed(state({ mode: 'nudge', pairs: three }), null)).toBeNull()
  })

  it('a typed end is the model end of its own pair, on no part', () => {
    expect(withTypedEnd([{ scan: [1, 1, 1], model: [0, 0, 0], part: 'base' }, { scan: [2, 2, 2] }], 1, [9, 9, 9])).toEqual([{ scan: [1, 1, 1], model: [0, 0, 0], part: 'base' }, { scan: [2, 2, 2], model: [9, 9, 9] }])
    expect(withTypedEnd([{ scan: [1, 1, 1], model: [0, 0, 0], part: 'base' }], 0, [9, 9, 9])).toEqual([{ scan: [1, 1, 1], model: [9, 9, 9] }])
    expect(withTypedEnd([], 0, [9, 9, 9])).toEqual([{ model: [9, 9, 9] }])
  })

  it('the scan in hand is the one chosen, or the only one', () => {
    const scans = [{ id: 'S1' }, { id: 'S2' }] as ScanInfo[]
    expect(scanInHand(null, scans)).toBeNull()
    expect(scanInHand('S2', scans)?.id).toBe('S2')
    expect(scanInHand('S9', scans.slice(0, 1))?.id).toBe('S1')
    expect(scanInHand(null, [])).toBeNull()
  })
})

describe('a floor laid on a face of the model', () => {
  // A patch of floor 30 mm up, seen from above.
  const floor: FloorDraft = { plane: { origin: [5, 0, 30], normal: [0, 0, 1], rms: 0.4, used: 120 }, facing: [0, 0, 1], of: 125 }
  const up = (made: { transform: { q: [number, number, number, number] } }): number[] => rotate(made.transform.q, [0, 0, 1]).map((c) => Math.round(c * 1e9) / 1e9 + 0)

  it('is not turned on its head, whether the face looks up or down', () => {
    // The top of a part: the scanned surface is that face.
    const onTop = floorAlignment(null, floor, { origin: [0, 0, 2.5], normal: [0, 0, 1], part: 'base' }, 0)
    // The underside of a part that stands on the floor: the two face each other.
    const under = floorAlignment(null, floor, { origin: [0, 0, -2.5], normal: [0, 0, -1], part: 'base' }, 0)
    expect(up(onTop)).toEqual([0, 0, 1])
    expect(up(under)).toEqual([0, 0, 1])
    expect(under.transform.t).toEqual([0, 0, -32.5])
    // And the same of a patch whose fitted normal happens to look down: the side that is seen counts.
    expect(up(floorAlignment(null, { ...floor, plane: { ...floor.plane, normal: [0, 0, -1] } }, null, 0))).toEqual([0, 0, 1])
  })

  it('is laid the other way up when flipped, about the patch’s own point', () => {
    const flipped = floorAlignment(null, floor, null, 0, true)
    expect(up(flipped)).toEqual([0, 0, -1])
    expect(apply(flipped.transform, [5, 0, 30]).map((c) => Math.round(c * 1e9) / 1e9 + 0)).toEqual([5, 0, 0])
  })

  it('warns of a patch that is bumpy, or of which too little lies in its plane', () => {
    expect(floorWarning(floor)).toBeNull()
    expect(floorWarning({ ...floor, plane: { ...floor.plane, rms: 7.2 } })).toBe('this patch is not flat: pick a flatter one')
    expect(floorWarning({ ...floor, plane: { ...floor.plane, used: 90 } })).toBe('this patch is not flat: pick a flatter one')
  })

  it('found on the scan as it is drawn, is said as it is where main has the scan', () => {
    const drawn = { t: [0, 0, -30] as Vec3, q: [0, 0, 0, 1] as [number, number, number, number], s: 1 }
    const kept = { t: [0, 0, 0] as Vec3, q: [0, 0, 0, 1] as [number, number, number, number], s: 1 }
    expect(asKept(drawn, kept).point([5, 0, 0])).toEqual([5, 0, 30])
    expect(asKept(drawn, kept).direction([0, 0, 1])).toEqual([0, 0, 1])
  })
})

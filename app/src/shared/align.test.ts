import { describe, expect, it } from 'vitest'
import type { Quat, Vec3 } from './marks'
import type { ScanTransform } from './scans'
import { IDENTITY } from './scans'
import { ROUGH_RMS_MM, apply, compose, eigenSymmetric, fitFew, fitPairs, fitPlane, fitPlaneTrimmed, inLine, inverse, matrixOf, nudged, reckoned, rotate, roughOf, spreadOf, toFloor, unitHint } from './align'

const near = (a: number[], b: number[], within = 1e-9): void => a.forEach((c, i) => expect(Math.abs(c - b[i])).toBeLessThan(within))
/** A turn of `degrees` about an axis. */
const turn = (axis: Vec3, degrees: number): Quat => {
  const half = (degrees * Math.PI) / 360
  const length = Math.hypot(...axis)
  return [(axis[0] / length) * Math.sin(half), (axis[1] / length) * Math.sin(half), (axis[2] / length) * Math.sin(half), Math.cos(half)]
}
const T: ScanTransform = { q: turn([1, 2, 3], 40), t: [100, -50, 20], s: 1 }
const POINTS: Vec3[] = [[0, 0, 0], [300, 10, 5], [20, 250, -30], [150, 150, 90], [-80, 40, 10]]

describe('transforms', () => {
  it('turn, scale, then move', () => {
    near(rotate(turn([0, 0, 1], 90), [1, 0, 0]), [0, 1, 0])
    near(apply({ q: turn([0, 0, 1], 90), t: [10, 20, 30], s: 2 }, [1, 0, 0]), [10, 22, 30])
  })

  it('compose, invert and say themselves as a matrix', () => {
    const other: ScanTransform = { q: turn([0, 1, 0], -70), t: [5, 6, 7], s: 1.02 }
    for (const p of POINTS) {
      near(apply(compose(other, T), p), apply(other, apply(T, p)))
      near(apply(inverse(other), apply(other, p)), p)
    }
    const m = matrixOf({ q: turn([0, 0, 1], 90), t: [10, 20, 30], s: 2 })
    // Column by column: the first column is where +X goes.
    near(m, [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1])
  })

  it('are nudged about a pivot, which stays where it is when only turned', () => {
    const pivot: Vec3 = [50, 60, 70]
    const local = apply(inverse(T), pivot)
    near(apply(nudged(T, pivot, [0, 0, 0], turn([0, 0, 1], 33)), local), pivot)
    near(apply(nudged(T, pivot, [1, 2, 3], [0, 0, 0, 1]), local), [51, 62, 73])
  })
})

describe('eigenSymmetric', () => {
  it('finds the axes of a symmetric matrix', () => {
    const { values, vectors } = eigenSymmetric([[2, 1, 0], [1, 2, 0], [0, 0, 5]])
    near([...values].sort((a, b) => a - b), [1, 3, 5])
    const at = values.findIndex((v) => Math.abs(v - 1) < 1e-9)
    near([Math.abs(vectors[0][at]), Math.abs(vectors[1][at]), Math.abs(vectors[2][at])], [Math.SQRT1_2, Math.SQRT1_2, 0])
  })
})

describe('fitPlane', () => {
  const tilted = (x: number, y: number): Vec3 => [x, y, 0.1 * x - 0.2 * y + 7]

  it('fits the plane points lie in, and says how far off they are', () => {
    const fit = fitPlane([tilted(0, 0), tilted(10, 0), tilted(0, 10), tilted(10, 10), tilted(5, 3)])!
    const n = [-0.1, 0.2, 1].map((c) => c / Math.hypot(0.1, 0.2, 1))
    near(fit.normal.map((c) => c * Math.sign(fit.normal[2])), n)
    expect(fit.rms).toBeLessThan(1e-6)
    // The centroid is a point of it.
    near([0.1 * fit.origin[0] - 0.2 * fit.origin[1] + 7], [fit.origin[2]])
    const rough = fitPlane([[0, 0, 1], [10, 0, -1], [0, 10, -1], [10, 10, 1]])!
    expect(rough.rms).toBeCloseTo(1, 9)
  })

  it('weighs points, and refuses what is no plane', () => {
    const heavy = fitPlane([[0, 0, 0], [10, 0, 0], [0, 10, 0], [5, 5, 9]], [1, 1, 1, 1e-9])!
    expect(heavy.rms).toBeLessThan(1e-3)
    expect(fitPlane([[0, 0, 0], [1, 1, 1]])).toBeNull()
    expect(fitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])).toBeNull()
    expect(fitPlane([[4, 4, 4], [4, 4, 4], [4, 4, 4]])).toBeNull()
  })

  it('leaves out what stands off the plane (a cable on the floor)', () => {
    const floor: Vec3[] = []
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) floor.push([x, y, 0.01 * ((x * 7 + y * 3) % 5) - 0.02])
    const cable: Vec3[] = [[2, 2, 6], [3, 2, 6], [4, 2, 7], [5, 2, 6]]
    const fit = fitPlaneTrimmed([...floor, ...cable])!
    expect(fit.used).toBe(100)
    expect(fit.rms).toBeLessThan(0.02)
    expect(Math.abs(fit.normal[2])).toBeGreaterThan(0.99999)
  })
})

describe('toFloor', () => {
  it('lays a tilted patch flat on z = 0, turning it about itself by the shortest way', () => {
    const plane = { origin: [100, 50, 30] as Vec3, normal: rotate(turn([1, 0, 0], 5), [0, 0, 1]) }
    const laid = toFloor(plane, [0, 0, 1])
    near(rotate(laid.q, plane.normal), [0, 0, 1])
    // The patch's own point goes straight down: it is not slid in the plane.
    near(apply(laid, plane.origin), [100, 50, 0])
    expect(laid.s).toBe(1)
    // Seen from below, the same patch is laid the other way up.
    near(rotate(toFloor(plane, [0, 0, -1]).q, plane.normal), [0, 0, -1])
  })

  it('lays it on a face of the model, facing as the face does', () => {
    const face = { origin: [0, 0, 2.5] as Vec3, normal: [0, 0, 1] as Vec3 }
    const laid = toFloor({ origin: [7, 8, 40], normal: [0, 1, 0] }, [0, 1, 0], face)
    near(rotate(laid.q, [0, 1, 0]), [0, 0, 1])
    near(apply(laid, [7, 8, 40]), [7, 8, 2.5])
    // A patch that already lies on it is left where it is.
    const same = toFloor(face, [0, 0, 1], face)
    near([...same.q, ...same.t], [0, 0, 0, 1, 0, 0, 0])
  })
})

describe('fitPairs', () => {
  const model = POINTS.map((p) => apply(T, p))

  it('recovers a rigid move from three pairs and from five', () => {
    for (const count of [3, 5]) {
      const fit = fitPairs(POINTS.slice(0, count), model.slice(0, count))
      if ('error' in fit) throw new Error(fit.error)
      near([...fit.transform.q].map((c) => c * Math.sign(fit.transform.q[3])), T.q)
      near(fit.transform.t, T.t, 1e-7)
      expect(fit.transform.s).toBe(1)
      expect(fit.rms).toBeLessThan(1e-9)
      expect(fit.freeScale).toBeCloseTo(1, 9)
    }
  })

  it('never answers with a mirror image', () => {
    const mirrored = POINTS.map(([x, y, z]) => [x, y, -z] as Vec3)
    const fit = fitPairs(POINTS, mirrored)
    if ('error' in fit) throw new Error(fit.error)
    // A rotation cannot do it: the pairs are left with residuals, and the turn is a proper one.
    expect(fit.rms).toBeGreaterThan(1)
    const [x, y, z] = [rotate(fit.transform.q, [1, 0, 0]), rotate(fit.transform.q, [0, 1, 0]), rotate(fit.transform.q, [0, 0, 1])]
    near([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], z)
  })

  it('keeps the size unless told to fit it, and says what the size would be', () => {
    const larger = POINTS.map((p) => apply({ ...T, s: 1.02 }, p))
    const rigid = fitPairs(POINTS, larger)
    if ('error' in rigid) throw new Error(rigid.error)
    expect(rigid.transform.s).toBe(1)
    expect(rigid.freeScale).toBeCloseTo(1.02, 9)
    expect(rigid.rms).toBeGreaterThan(0.5)
    expect(rigid.residuals).toHaveLength(5)
    const scaled = fitPairs(POINTS, larger, { scale: true })
    if ('error' in scaled) throw new Error(scaled.error)
    expect(scaled.transform.s).toBeCloseTo(1.02, 9)
    expect(scaled.rms).toBeLessThan(1e-9)
  })

  it('names the pair that is off', () => {
    const bad = model.map((p, i) => (i === 3 ? ([p[0] + 9, p[1], p[2]] as Vec3) : p))
    const fit = fitPairs(POINTS, bad)
    if ('error' in fit) throw new Error(fit.error)
    expect(fit.residuals.indexOf(Math.max(...fit.residuals))).toBe(3)
  })

  it('holds for the frame the owner worked out by hand for the Micra scan', () => {
    // micra-intake/docs/2026-10-06-micra-intake-design.md: glTF coordinates in mm, less the origin, dotted with each axis (four digits).
    const origin: Vec3 = [107.4, 689.9, 28.8]
    const axes: Vec3[] = [[0.9944, -0.0064, 0.1055], [0.1045, -0.0898, -0.9905], [0.0158, 0.9959, -0.0887]]
    const tray = (p: Vec3): Vec3 => axes.map((axis) => axis.reduce((sum, c, i) => sum + c * (p[i] - origin[i]), 0)) as Vec3
    const fit = fitPairs(POINTS, POINTS.map(tray))
    if ('error' in fit) throw new Error(fit.error)
    // Its axes are orthonormal to four digits: a rigid fit agrees with it to a fifth of a millimetre over 300 mm.
    expect(fit.rms).toBeLessThan(0.2)
    expect(Math.abs(fit.freeScale - 1)).toBeLessThan(1e-3)
    near(apply(fit.transform, origin), [0, 0, 0], 0.2)
  })

  it('refuses too few pairs, and points in a line', () => {
    expect(fitPairs(POINTS.slice(0, 2), model.slice(0, 2))).toEqual({ error: 'an alignment needs at least three pairs of points' })
    const line: Vec3[] = [[0, 0, 0], [10, 0, 0], [20, 0, 0], [35, 0, 0]]
    expect(fitPairs(line, model.slice(0, 4))).toEqual({ error: 'the scan points are in a line: an alignment needs three that are not' })
    expect(fitPairs(POINTS.slice(0, 4), line)).toEqual({ error: 'the model points are in a line: an alignment needs three that are not' })
  })
})

describe('unitHint', () => {
  it('says when the size a fit wants is a unit', () => {
    expect(unitHint(1000.4, 'mm')).toEqual({ unit: 'm', factor: 1000 })
    expect(unitHint(25.1, 'mm')).toEqual({ unit: 'in', factor: 25.4 })
    expect(unitHint(0.0101, 'm')).toEqual({ unit: 'cm', factor: 0.01 })
    expect(unitHint(1.02, 'mm')).toBeNull()
    expect(unitHint(3, 'mm')).toBeNull()
  })
})

// Task 5: what main and the window both say of an alignment.
describe('what an alignment is worth', () => {
  const I: [number, number, number, number] = [0, 0, 0, 1]
  const pair = (scan: [number, number, number], model: [number, number, number]) => ({ scan, model, residual: 99 })
  const THREE_PAIRS = [pair([0, 0, 0], [5, 0, 1]), pair([10, 0, 0], [15, 0, 1]), pair([0, 10, 0], [5, 10, 1])]

  it('has its residuals, its rms and whether it was scaled worked out from its transform, whatever it says', () => {
    const made = reckoned({ transform: { t: [0, 0, 0], q: I, s: 2 }, steps: ['pairs' as const], rms: 0, scaled: false, pairs: [pair([1, 0, 0], [2, 0, 3]), pair([0, 1, 0], [0, 2, 0])] })
    expect(made.pairs!.map((p) => p.residual)).toEqual([3, 0])
    expect(made.rms).toBeCloseTo(Math.sqrt(4.5), 12)
    expect(made.scaled).toBe(true)
    // Without pairs the rms is the floor's, as given; a scale of one is no scale.
    const floor = reckoned({ transform: { t: [0, 0, 0], q: I, s: 1 }, steps: ['floor' as const], rms: 0.4, scaled: true })
    expect(floor.rms).toBe(0.4)
    expect('scaled' in floor).toBe(false)
  })

  it('is rough with no pairs, with fewer than three, with pairs in a line, or with pairs left far apart', () => {
    const at = (pairs: ReturnType<typeof pair>[], steps: Array<'floor' | 'pairs' | 'nudge' | 'typed'> = ['pairs'], t: [number, number, number] = [5, 0, 1]) => reckoned({ transform: { t, q: I, s: 1 }, steps, pairs }).rough
    expect(at(THREE_PAIRS)).toBeUndefined()
    // Fix round 1 (R-basis): a floor alone and a scan placed by hand are what they are, said as that: not rough.
    expect(roughOf({ steps: ['floor'] })).toBeNull()
    expect(roughOf({ steps: ['floor', 'nudge'] })).toBeNull()
    expect(roughOf({ steps: ['typed'], pairs: [] })).toBeNull()
    expect(at(THREE_PAIRS.slice(0, 2))).toBe('it has 2 pairs of points: it takes three that are not in a line to fix a scan')
    expect(at(THREE_PAIRS.slice(0, 1))).toBe('it has 1 pair of points: it takes three that are not in a line to fix a scan')
    expect(at([pair([0, 0, 0], [5, 0, 1]), pair([10, 0, 0], [15, 0, 1]), pair([20, 0, 0], [25, 0, 1])])).toBe('its pairs of points are in a line: how it is turned about that line is not fixed')
    // A fit that leaves its pairs 6 mm apart: more than the 5 mm that is still an alignment.
    expect(ROUGH_RMS_MM).toBe(5)
    expect(at(THREE_PAIRS, ['pairs'], [5, 0, 7])).toBe('its pairs of points are left 6 mm apart (rms): more than 5 mm')
    expect(at(THREE_PAIRS, ['pairs'], [5, 0, 5])).toBeUndefined()
    // Changed in fix round 2 (C): a fit is judged by how well it fitted (`fitRms`), wherever a hand put it afterwards.
    const moved = (fitRms: number | undefined, t: [number, number, number]) => reckoned({ transform: { t, q: I, s: 1 }, steps: ['pairs', 'typed'] as Array<'pairs' | 'typed'>, pairs: THREE_PAIRS, ...(fitRms === undefined ? {} : { fitRms }) }).rough
    // Fitted well, then moved 26 mm by hand: not a doubtful fit.
    expect(moved(0.4, [5, 0, 27])).toBeUndefined()
    // Fitted 40 mm off, then put right by hand: as doubtful a fit as it was.
    expect(moved(40, [5, 0, 1])).toBe('its pairs of points were fitted 40 mm apart (rms): more than 5 mm')
    // With no fit on record it is judged as it stands.
    expect(moved(undefined, [5, 0, 27])).toBe('its pairs of points are left 26 mm apart (rms): more than 5 mm')
    // But two pairs stay two pairs, wherever a hand puts it afterwards.
    expect(at(THREE_PAIRS.slice(0, 2), ['pairs', 'nudge'], [5, 0, 27])).toBe('it has 2 pairs of points: it takes three that are not in a line to fix a scan')
  })
})

describe('fitFew', () => {
  const I: [number, number, number, number] = [0, 0, 0, 1]
  const from = { t: [100, 0, 0] as [number, number, number], q: I, s: 1 }

  it('moves the scan as it stands onto one pair, and turns it no way', () => {
    const fit = fitFew([[1, 2, 3]], [[0, 0, 0]], from)!
    expect(fit.transform.q).toEqual(I)
    expect(apply(fit.transform, [1, 2, 3]).map((c) => Math.round(c * 1e9) / 1e9 + 0)).toEqual([0, 0, 0])
    expect(fit.residuals).toEqual([0])
    expect(fitFew([], [], from)).toBeNull()
  })

  it('with two pairs turns it the shortest way that lines them up, and says what the distances make of its size', () => {
    // The scan's two points are 10 apart along X; the model's are 10 apart along Y.
    const fit = fitFew([[0, 0, 0], [10, 0, 0]], [[0, 0, 5], [0, 10, 5]], from)!
    expect(fit.rms).toBeLessThan(1e-9)
    // About Z only: what was up is still up.
    expect(rotate(fit.transform.q, [0, 0, 1]).map((c) => Math.round(c * 1e9) / 1e9 + 0)).toEqual([0, 0, 1])
    expect(fit.freeScale).toBeCloseTo(1, 9)
    expect(fitFew([[0, 0, 0], [0.01, 0, 0]], [[0, 0, 5], [0, 10, 5]], IDENTITY)!.freeScale).toBeCloseTo(1000, 6)
  })

  it('takes pairs in a line as two, by the line they lie along', () => {
    const scan: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [20, 0, 0]]
    const model: [number, number, number][] = [[0, 0, 0], [0, 10, 0], [0, 20, 0]]
    expect(inLine(scan)).toBe(true)
    expect(inLine([...scan, [0, 5, 0]])).toBe(false)
    expect(fitFew(scan, model, IDENTITY)!.rms).toBeLessThan(1e-9)
  })
})

// From Task 4's review.
describe('pairs that are nearly in a line', () => {
  it('are refused when the third is hardly off the line, and say how far they spread otherwise', () => {
    // Three clicks along a rail 200 mm long, the third 0.2 mm off it: the turn about the rail would be noise.
    const rail: Vec3[] = [[0, 0, 0], [200, 0, 0], [100, 0.2, 0]]
    expect(fitPairs(rail, rail)).toEqual({ error: 'the points are almost in a line: add one well off it' })
    // 5 mm off it: a fit, and one that says it is weak.
    const weak: Vec3[] = [[0, 0, 0], [200, 0, 0], [100, 5, 0]]
    const fit = fitPairs(weak, weak)
    if ('error' in fit) throw new Error(fit.error)
    expect(fit.spread).toBeGreaterThan(0.02)
    expect(fit.spread).toBeLessThan(0.1)
    expect(spreadOf(weak)).toBeCloseTo(fit.spread, 12)
    const sound: Vec3[] = [[0, 0, 0], [200, 0, 0], [100, 80, 0]]
    expect((fitPairs(sound, sound) as { spread: number }).spread).toBeGreaterThan(0.1)
    // The worse of the two sets counts.
    expect((fitPairs(sound, weak) as { spread: number }).spread).toBeCloseTo(spreadOf(weak), 12)
    const pairs = weak.map((p) => ({ scan: p, model: p, residual: 0 }))
    expect(roughOf({ steps: ['pairs'], pairs })).toBe('its pairs of points are almost in a line: how it is turned about that line is poorly fixed')
  })

  it('say what is wrong with what they were given', () => {
    const three: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0]]
    expect(fitPairs(three, three.slice(0, 2))).toEqual({ error: 'each scan point needs its model point: 3 of the one, 2 of the other' })
    expect(fitPairs([[0, 0, 0], [10, 0, 0], [0, Number.NaN, 0]], three)).toEqual({ error: 'a point of a pair is not three finite numbers' })
    expect(fitPairs(three, [[0, 0, 0], [10, 0, 0], [0, Infinity, 0]])).toEqual({ error: 'a point of a pair is not three finite numbers' })
  })

  it('a plane is fitted with no weight that is negative or no number', () => {
    const points: Vec3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0]]
    expect(fitPlane(points, [1, 1, -1, 1])).toBeNull()
    expect(fitPlane(points, [1, 1, Number.NaN, 1])).toBeNull()
    expect(fitPlane(points, [1, 2, 3, 4])).not.toBeNull()
  })
})

describe('toFloor, of a plane with no direction', () => {
  it('refuses with a reason, rather than turn the scan no way in silence', () => {
    expect(() => toFloor({ origin: [0, 0, 0], normal: [0, 0, 0] }, [0, 0, 1])).toThrow('a plane with no direction cannot be laid down: its normal is zero')
    expect(() => toFloor({ origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], { origin: [0, 0, 0], normal: [0, Number.NaN, 0] })).toThrow('a plane with no direction')
  })
})

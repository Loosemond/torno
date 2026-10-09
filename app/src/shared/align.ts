import { fitNumber } from './format'
import type { Quat, Vec3 } from './marks'
import { type ScanAlignment, type ScanPair, type ScanTransform, type ScanUnit, UNIT_MM, basisOf } from './scans'

// The maths of standing a scan where the model is: plain arrays in, plain arrays out, no three.js, so the
// window and main work out the same. A transform is p' = s · R(q) · p + t, from the scan's own frame to the
// object frame of a layout.

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const times = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => times(a, 1 / (Math.hypot(...a) || 1))
const unitQuat = (q: Quat): Quat => {
  const length = Math.hypot(...q)
  return length > 0 ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [0, 0, 0, 1]
}
/** The turn `a` after the turn `b`. */
const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]

/** A vector turned by a quaternion of length one. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]]
  const first = cross(u, v)
  return add(v, add(times(first, 2 * q[3]), times(cross(u, first), 2)))
}

/** Where a transform puts a point: turned, scaled, then moved. */
export function apply(t: ScanTransform, p: Vec3): Vec3 {
  return add(times(rotate(t.q, p), t.s), t.t)
}

/** One transform for two: `apply(compose(after, first), p)` equals `apply(after, apply(first, p))`. */
export function compose(after: ScanTransform, first: ScanTransform): ScanTransform {
  return { q: unitQuat(multiply(after.q, first.q)), s: after.s * first.s, t: apply(after, first.t) }
}

/** The transform that undoes one. */
export function inverse(t: ScanTransform): ScanTransform {
  const back: Quat = [-t.q[0], -t.q[1], -t.q[2], t.q[3]]
  return { q: back, s: 1 / t.s, t: times(rotate(back, t.t), -1 / t.s) }
}

/** Sixteen numbers, column by column, as `THREE.Matrix4.fromArray` takes them. */
export function matrixOf(t: ScanTransform): number[] {
  const [x, y, z] = [rotate(t.q, [1, 0, 0]), rotate(t.q, [0, 1, 0]), rotate(t.q, [0, 0, 1])].map((axis) => times(axis, t.s))
  return [...x, 0, ...y, 0, ...z, 0, ...t.t, 1]
}

/** A transform after it was turned by `turn` about `pivot` and then moved by `move`, all in the object frame. */
export function nudged(from: ScanTransform, pivot: Vec3, move: Vec3, turn: Quat): ScanTransform {
  const q = unitQuat(turn)
  return compose({ q, s: 1, t: add(sub(pivot, rotate(q, pivot)), move) }, from)
}

/** The eigenvalues and the eigenvectors (as columns: `vectors[row][i]` belongs to `values[i]`) of a symmetric matrix, by Jacobi rotations. */
export function eigenSymmetric(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length
  const m = a.map((row) => [...row])
  const v = m.map((_, i) => m.map((_, j) => (i === j ? 1 : 0)))
  const whole = m.flat().reduce((sum, c) => sum + c * c, 0)
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j]
    if (off <= 1e-30 * whole) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (m[p][q] === 0) continue
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q])
        const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (const of of [m, v]) {
          // Columns p and q, of the matrix and of the vectors.
          for (let k = 0; k < n; k++) {
            const [kp, kq] = [of[k][p], of[k][q]]
            of[k][p] = c * kp - s * kq
            of[k][q] = s * kp + c * kq
          }
        }
        // Rows p and q of the matrix.
        for (let k = 0; k < n; k++) {
          const [pk, qk] = [m[p][k], m[q][k]]
          m[p][k] = c * pk - s * qk
          m[q][k] = s * pk + c * qk
        }
      }
    }
  }
  return { values: m.map((row, i) => row[i]), vectors: v }
}

/** The centroid of some points and the axes they spread along, least first, with how much. */
function spread(points: Vec3[], weights?: number[]): { centre: Vec3; values: number[]; axes: Vec3[] } | null {
  const w = (i: number): number => weights?.[i] ?? 1
  const total = points.reduce((sum, _, i) => sum + w(i), 0)
  if (!(total > 0)) return null
  const centre = times(points.reduce<Vec3>((sum, p, i) => add(sum, times(p, w(i))), [0, 0, 0]), 1 / total)
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  points.forEach((p, i) => {
    const d = sub(p, centre)
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c[r][k] += (w(i) * d[r] * d[k]) / total
  })
  const { values, vectors } = eigenSymmetric(c)
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
  return { centre, values: order.map((i) => Math.max(values[i], 0)), axes: order.map((i) => [vectors[0][i], vectors[1][i], vectors[2][i]] as Vec3) }
}

/** Whether points lie in a line, or in one place: they spread along one axis at most. */
const inALine = (values: number[]): boolean => values[1] <= 1e-6 * values[2] || values[2] <= 1e-18

/** How far points spread across the line they lie along, against how far along it: 0 in a line, 1 as far across as along. */
const across = (values: number[]): number => (values[2] <= 1e-18 ? 0 : Math.sqrt(values[1] / values[2]))

/** Under this spread the turn about the line is noise: three clicks along one edge, the third a hair off it. No fit is made. */
export const LINE_SPREAD = 0.02
/** Under this spread a fit is made and is weak: it is rough. */
export const WEAK_SPREAD = 0.1
/** Pairs left further apart than this (rms, mm) are no alignment to rely on: it is rough. */
export const ROUGH_RMS_MM = 5

/** How far points spread across the line they lie along, against how far along it (`PairFit.spread`); 0 for none, or all in one place. */
export function spreadOf(points: Vec3[]): number {
  const found = spread(points)
  return found ? across(found.values) : 0
}

/** Whether points are in a line as far as a fit can tell: fewer than three, or hardly spread across it (`LINE_SPREAD`). */
export function inLine(points: Vec3[]): boolean {
  return points.length < 3 || spreadOf(points) < LINE_SPREAD
}

/**
 * The plane nearest a set of points, least squares: through their (weighted) centroid, with how far they lie
 * from it (rms, mm). Null for fewer than three or for points in a line. Which way the normal looks is not said.
 */
export function fitPlane(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number } | null {
  if (points.length < 3 || weights?.some((w) => !(w >= 0))) return null
  const found = spread(points, weights)
  if (!found || inALine(found.values)) return null
  return { origin: found.centre, normal: unit(found.axes[0]), rms: Math.sqrt(found.values[0]) }
}

/** A point further from the plane than this many times the median distance is left out: about three standard deviations of points that scatter evenly. */
const TRIM = 4.5

/**
 * `fitPlane`, then up to three times: the points further than 4.5 times the median distance from the plane are
 * left out, of all of them each time, and it is fitted again. `used` is how many it ends with.
 */
export function fitPlaneTrimmed(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number; used: number } | null {
  let kept = points.map((_, i) => i)
  let fit = fitPlane(points, weights)
  for (let pass = 0; fit && pass < 3; pass++) {
    const plane = fit
    // Of every point, each time: one left out while the plane was tilted by what stands off it may belong after all.
    const off = points.map((p) => Math.abs(dot(sub(p, plane.origin), plane.normal)))
    const median = [...off].sort((a, b) => a - b)[Math.floor(off.length / 2)]
    const within = points.map((_, i) => i).filter((i) => off[i] <= TRIM * Math.max(median, 1e-9))
    if (within.length < 3 || (within.length === kept.length && within.every((i, n) => i === kept[n]))) break
    kept = within
    fit = fitPlane(kept.map((i) => points[i]), weights && kept.map((i) => weights[i]))
  }
  return fit && { ...fit, used: kept.length }
}

/** The shortest turn that takes one direction to another; a half turn about any axis across them when they are opposed. */
function between(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to)
  if (d < -1 + 1e-12) {
    const across = unit(Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]))
    return [across[0], across[1], across[2], 0]
  }
  const axis = cross(from, to)
  return unitQuat([axis[0], axis[1], axis[2], 1 + d])
}

/**
 * The rigid move, in the object frame, that lays a plane of the scan as it now stands onto `onto`
 * (default: z = 0, facing up): the shortest turn about the plane's own point, then the shift along
 * `onto`'s normal. Where the scan is within that plane, and how it is turned about the normal, are
 * left as they are. `facing` is a direction the seen side of the plane looks towards (the eye).
 * It is a move of the scan where it stands: compose it after the scan's transform.
 */
export function toFloor(plane: { origin: Vec3; normal: Vec3 }, facing: Vec3, onto: { origin: Vec3; normal: Vec3 } = { origin: [0, 0, 0], normal: [0, 0, 1] }): ScanTransform {
  // A plane with no direction turns nothing: said, not passed over.
  for (const normal of [plane.normal, onto.normal]) if (!(Math.hypot(...normal) > 1e-12)) throw new RangeError('a plane with no direction cannot be laid down: its normal is zero')
  const seen = unit(plane.normal)
  const up = unit(onto.normal)
  const q = between(dot(seen, facing) < 0 ? times(seen, -1) : seen, up)
  // About the patch's own point, which then goes along the target's normal onto the target.
  const turned = sub(plane.origin, rotate(q, plane.origin))
  return { q, s: 1, t: add(turned, times(up, dot(sub(onto.origin, plane.origin), up))) }
}

/**
 * A fit of pairs: the transform, how far each pair is left apart (mm) and their rms, what the scale would be
 * were it free, and how far the points spread across the line they lie along (the worse of the two sets; `spreadOf`):
 * under `WEAK_SPREAD` the turn about that line is poorly fixed, whatever the residuals say.
 */
export interface PairFit { transform: ScanTransform; residuals: number[]; rms: number; freeScale: number; spread: number }

/**
 * The least-squares move (Umeyama) taking `scan[i]` to `model[i]`: rigid, or with one scale for all when
 * `scale` is set. An error in words for fewer than three pairs or points in a line.
 */
export function fitPairs(scan: Vec3[], model: Vec3[], opts: { scale?: boolean } = {}): PairFit | { error: string } {
  if (scan.length !== model.length) return { error: `each scan point needs its model point: ${scan.length} of the one, ${model.length} of the other` }
  if (scan.length < 3) return { error: 'an alignment needs at least three pairs of points' }
  if (![...scan, ...model].every(isPoint)) return { error: 'a point of a pair is not three finite numbers' }
  const [from, to] = [spread(scan), spread(model)]
  if (!from || inALine(from.values)) return { error: 'the scan points are in a line: an alignment needs three that are not' }
  if (!to || inALine(to.values)) return { error: 'the model points are in a line: an alignment needs three that are not' }
  // Hardly off a line: the turn about it would follow the noise of the clicks, under a small residual.
  const wide = Math.min(across(from.values), across(to.values))
  if (wide < LINE_SPREAD) return { error: ALMOST_IN_LINE }
  const a = scan.map((p) => sub(p, from.centre))
  const b = model.map((p) => sub(p, to.centre))
  // Horn's closed form: the turn is the eigenvector of the largest eigenvalue of this matrix, as (w, x, y, z).
  const S = [0, 1, 2].map((r) => [0, 1, 2].map((k) => a.reduce((sum, p, i) => sum + p[r] * b[i][k], 0)))
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const { values, vectors } = eigenSymmetric([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz]
  ])
  const top = values.indexOf(Math.max(...values))
  const q = canonical(unitQuat([vectors[1][top], vectors[2][top], vectors[3][top], vectors[0][top]]))
  // Umeyama's scale: the one that leaves the least between the turned scan points and the model's.
  const freeScale = a.reduce((sum, p, i) => sum + dot(rotate(q, p), b[i]), 0) / a.reduce((sum, p) => sum + dot(p, p), 0)
  const s = opts.scale ? freeScale : 1
  const transform: ScanTransform = { q, s, t: sub(to.centre, times(rotate(q, from.centre), s)) }
  const residuals = scan.map((p, i) => Math.hypot(...sub(apply(transform, p), model[i])))
  return { transform, residuals, rms: rmsOf(residuals), freeScale, spread: wide }
}

/** Said of pairs a fit cannot be made of: `fitPairs`'s refusal under `LINE_SPREAD`. */
export const ALMOST_IN_LINE = 'the points are almost in a line: add one well off it'

const isPoint = (p: Vec3): boolean => Array.isArray(p) && p.length === 3 && p.every((c) => Number.isFinite(c))
const rmsOf = (residuals: number[]): number => Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(residuals.length, 1))

/** A turn as it is kept: of length one, and of its two signs the one with w ≥ 0, so that one turn is written one way. */
export function canonical(q: Quat): Quat {
  const u = unitQuat(q)
  const negative = u[3] < 0 || (u[3] === 0 && (u.find((c) => c !== 0) ?? 1) < 0)
  return u.map((c) => (negative ? -c : c) + 0) as Quat
}

/**
 * What fewer than three pairs, or pairs in a line, make of a scan as it stands (`from`): with one pair it is
 * moved onto it and not turned; with more it is turned the shortest way that lays the line of its points along
 * the line of the model's, and moved so that their middles meet. How it is turned about that line stays as it
 * stood: such an alignment is rough (`roughOf`). `freeScale` is what the distances between the points make of
 * the scan's size, as `fitPairs` says it. Null for no pair, or for points that are not numbers.
 */
export function fitFew(scan: Vec3[], model: Vec3[], from: ScanTransform): PairFit | null {
  if (scan.length === 0 || scan.length !== model.length || ![...scan, ...model].every(isPoint)) return null
  const stood = scan.map((p) => apply(from, p))
  const [a, b] = [spread(stood)!, spread(model)!]
  // Along each line from its first point to its last: which way round the two are matched.
  const way = (points: Vec3[], axis: Vec3): Vec3 => (dot(axis, sub(points[points.length - 1], points[0])) < 0 ? times(axis, -1) : axis)
  const lined = a.values[2] > 1e-18 && b.values[2] > 1e-18
  const q = lined ? between(way(stood, unit(a.axes[2])), way(model, unit(b.axes[2]))) : ([0, 0, 0, 1] as Quat)
  const transform = compose({ q, s: 1, t: sub(b.centre, rotate(q, a.centre)) }, from)
  const residuals = scan.map((p, i) => Math.hypot(...sub(apply(transform, p), model[i])))
  const freeScale = lined ? from.s * Math.sqrt((b.values[0] + b.values[1] + b.values[2]) / (a.values[0] + a.values[1] + a.values[2])) : from.s
  return { transform: { ...transform, q: canonical(transform.q) }, residuals, rms: rmsOf(residuals), freeScale, spread: 0 }
}

/**
 * Why an alignment's fit of pairs is doubtful, or null: fewer than three pairs, pairs in or almost in a line,
 * or pairs the fit leaves further apart than `ROUGH_RMS_MM`. Of the pairs as they are: their residuals are to
 * be worked out first (`reckoned`). An alignment that rests on no pairs (a floor, a hand) is not rough: it is
 * what its basis says. A fit is judged by how well it fitted (`fitRms`, which main keeps through every move by
 * hand after it): a good fit moved by hand is not rough, a rough one stays rough wherever a hand puts it; with
 * no such number it is judged by how far apart its pairs are as it stands.
 */
export function roughOf(alignment: Pick<ScanAlignment, 'steps'> & { pairs?: ScanPair[]; fitRms?: number }): string | null {
  const pairs = alignment.pairs ?? []
  const { basis, movedByHand } = basisOf(alignment)
  if (basis !== 'pairs') return null
  if (pairs.length < 3) return `it has ${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'} of points: it takes three that are not in a line to fix a scan`
  const wide = Math.min(spreadOf(pairs.map((pair) => pair.scan)), spreadOf(pairs.map((pair) => pair.model)))
  if (wide < LINE_SPREAD) return 'its pairs of points are in a line: how it is turned about that line is not fixed'
  if (wide < WEAK_SPREAD) return 'its pairs of points are almost in a line: how it is turned about that line is poorly fixed'
  // How well they were fitted, when that is known: a hand that moves the scan afterwards makes a fit neither better nor worse.
  const fitted = alignment.fitRms !== undefined
  const rms = alignment.fitRms ?? rmsOf(pairs.map((pair) => pair.residual))
  return rms > ROUGH_RMS_MM ? `its pairs of points ${fitted && movedByHand ? 'were fitted' : 'are left'} ${fitNumber(rms)} mm apart (rms): more than ${ROUGH_RMS_MM} mm` : null
}

type Reckoned = Partial<Pick<ScanAlignment, 'rms' | 'scaled' | 'rough'>>

/**
 * An alignment with what follows from its transform, its steps and its pairs worked out, whatever it said of
 * them: how far each pair is left apart and, when it has pairs, their rms (without, the rms is its floor's and
 * is left); whether its size was changed; and why its fit is doubtful, when it is (by `fitRms`, when it has one).
 */
export function reckoned<A extends Pick<ScanAlignment, 'transform' | 'steps'> & Partial<Pick<ScanAlignment, 'pairs' | 'fitRms'>>>(alignment: A): A & Reckoned {
  const made: A & Reckoned = { ...alignment }
  if (made.pairs) made.pairs = made.pairs.map((pair) => ({ ...pair, residual: Math.hypot(...sub(apply(made.transform, pair.scan), pair.model)) }))
  if (made.pairs && made.pairs.length > 0) made.rms = rmsOf(made.pairs.map((pair) => pair.residual))
  if (Math.abs(made.transform.s - 1) > 1e-9) made.scaled = true
  else delete made.scaled
  const rough = roughOf(made)
  if (rough) made.rough = rough
  else delete made.rough
  return made
}

/** When a fit's free scale is within 3 % of the ratio of two units: the unit the scan looks to be in, and that ratio. Null otherwise. */
export function unitHint(freeScale: number, importedAs: ScanUnit): { unit: ScanUnit; factor: number } | null {
  for (const unit of ['mm', 'cm', 'm', 'in'] as const) {
    if (unit === importedAs) continue
    const factor = UNIT_MM[unit] / UNIT_MM[importedAs]
    if (Math.abs(freeScale / factor - 1) <= 0.03) return { unit, factor }
  }
  return null
}

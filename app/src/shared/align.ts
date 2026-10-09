import type { Quat, Vec3 } from './marks'
import { type ScanTransform, type ScanUnit, UNIT_MM } from './scans'

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

/**
 * The plane nearest a set of points, least squares: through their (weighted) centroid, with how far they lie
 * from it (rms, mm). Null for fewer than three or for points in a line. Which way the normal looks is not said.
 */
export function fitPlane(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number } | null {
  if (points.length < 3) return null
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
  const seen = unit(plane.normal)
  const up = unit(onto.normal)
  const q = between(dot(seen, facing) < 0 ? times(seen, -1) : seen, up)
  // About the patch's own point, which then goes along the target's normal onto the target.
  const turned = sub(plane.origin, rotate(q, plane.origin))
  return { q, s: 1, t: add(turned, times(up, dot(sub(onto.origin, plane.origin), up))) }
}

/** A fit of pairs: the transform, how far each pair is left apart (mm) and their rms, and what the scale would be were it free. */
export interface PairFit { transform: ScanTransform; residuals: number[]; rms: number; freeScale: number }

/**
 * The least-squares move (Umeyama) taking `scan[i]` to `model[i]`: rigid, or with one scale for all when
 * `scale` is set. An error in words for fewer than three pairs or points in a line.
 */
export function fitPairs(scan: Vec3[], model: Vec3[], opts: { scale?: boolean } = {}): PairFit | { error: string } {
  if (scan.length !== model.length || scan.length < 3) return { error: 'an alignment needs at least three pairs of points' }
  const [from, to] = [spread(scan), spread(model)]
  if (!from || inALine(from.values)) return { error: 'the scan points are in a line: an alignment needs three that are not' }
  if (!to || inALine(to.values)) return { error: 'the model points are in a line: an alignment needs three that are not' }
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
  const q = unitQuat([vectors[1][top], vectors[2][top], vectors[3][top], vectors[0][top]])
  // Umeyama's scale: the one that leaves the least between the turned scan points and the model's.
  const freeScale = a.reduce((sum, p, i) => sum + dot(rotate(q, p), b[i]), 0) / a.reduce((sum, p) => sum + dot(p, p), 0)
  const s = opts.scale ? freeScale : 1
  const transform: ScanTransform = { q, s, t: sub(to.centre, times(rotate(q, from.centre), s)) }
  const residuals = scan.map((p, i) => Math.hypot(...sub(apply(transform, p), model[i])))
  return { transform, residuals, rms: Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length), freeScale }
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

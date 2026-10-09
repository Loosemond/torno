import { apply, eigenSymmetric, rotate } from './align'
import { count } from './format'
import type { RegionMark, Vec3 } from './marks'
import type { Scan, ScanMesh, ScanTransform } from './scans'

// What a region of a scan is, worked out from the scan's mesh and the bits of its mask. Plain arrays, no
// three.js: main says these numbers when a region is kept, and nobody else does.

/** What main alone says of a region (`REGION_KEYS`). `local` is in the scan's own frame. */
export interface RegionStats { triangles: number; area: number; local: RegionMark['local'] }

const BITS = Uint8Array.from({ length: 256 }, (_, byte) => byte.toString(2).split('1').length - 1)

/** How many bits of a bitset are set. */
export function popcount(bits: Uint8Array): number {
  let count = 0
  for (let n = 0; n < bits.length; n++) count += BITS[bits[n]]
  return count
}

/** How many bytes the bitset of a mesh of `triangles` triangles has. */
export const bytesFor = (triangles: number): number => Math.ceil(triangles / 8)

/**
 * Why bits are no region of a mesh of `triangles` triangles, or null: another length than one bit a triangle, or
 * a bit set past the last triangle.
 */
export function bitsRefused(bits: Uint8Array, triangles: number): string | null {
  if (bits.length !== bytesFor(triangles)) return `${bits.length} bytes of triangles do not fit a mesh of ${count(triangles)} triangles: ${bytesFor(triangles)} bytes`
  const spare = triangles & 7
  if (spare !== 0 && bits[bits.length - 1] >> spare !== 0) return `the region names a triangle past the last of the mesh (${count(triangles)} triangles)`
  return null
}

/**
 * What a region is, from the mesh and its bits: main's to say, never the window's. Null for no triangle.
 *
 * Two passes over the set's triangles. The first: the area, the area-weighted centroid, the box of their corners
 * along the scan's axes, and the plane nearest their surface with how far it lies from it (one or two triangles
 * have the plane of the first, and lie in it as far as can be said). The second: the box they fill along the
 * axes they spread along (`local.box`), which is the size the region has, however it lies in the scan.
 */
export function regionStats(mesh: Pick<ScanMesh, 'vertices' | 'triangles'>, bits: Uint8Array): RegionStats | null {
  const { vertices, triangles } = mesh
  const total = triangles.length / 3
  let count = 0
  let area = 0
  const sum = [0, 0, 0]
  // Second moments of the surface about the first triangle met, so that a region far from the origin loses no digits.
  const moment = [0, 0, 0, 0, 0, 0]
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  // Where the first triangle is, and the normal of the first that has an area.
  let at: Vec3 | null = null
  let normal: Vec3 | null = null
  const p = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let byte = 0; byte < bits.length; byte++) {
    if (bits[byte] === 0) continue
    for (let bit = 0; bit < 8; bit++) {
      const t = byte * 8 + bit
      if ((bits[byte] & (1 << bit)) === 0 || t >= total) continue
      for (let corner = 0; corner < 3; corner++) {
        const v = triangles[t * 3 + corner] * 3
        for (let axis = 0; axis < 3; axis++) {
          const c = vertices[v + axis]
          p[corner * 3 + axis] = c
          if (c < min[axis]) min[axis] = c
          if (c > max[axis]) max[axis] = c
        }
      }
      const [ux, uy, uz, vx, vy, vz] = [p[3] - p[0], p[4] - p[1], p[5] - p[2], p[6] - p[0], p[7] - p[1], p[8] - p[2]]
      const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
      const twice = Math.hypot(n[0], n[1], n[2])
      const a = twice / 2
      const c: Vec3 = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3]
      at ??= c
      if (normal === null && twice > 0) normal = [n[0] / twice, n[1] / twice, n[2] / twice]
      const d = [c[0] - at[0], c[1] - at[1], c[2] - at[2]]
      count += 1
      area += a
      for (let axis = 0; axis < 3; axis++) sum[axis] += a * d[axis]
      // The second moments of the triangle's own surface, not of its middle: (A / 12) (Σ pp' + (Σ p)(Σ p)'), about `at`.
      // (The middles of the two triangles of a cell lie askew, and a strip of them would be told as turned.)
      const q = [p[0] - at[0], p[1] - at[1], p[2] - at[2], p[3] - at[0], p[4] - at[1], p[5] - at[2], p[6] - at[0], p[7] - at[1], p[8] - at[2]]
      const [sx, sy, sz] = [q[0] + q[3] + q[6], q[1] + q[4] + q[7], q[2] + q[5] + q[8]]
      const w = a / 12
      moment[0] += w * (q[0] * q[0] + q[3] * q[3] + q[6] * q[6] + sx * sx)
      moment[1] += w * (q[0] * q[1] + q[3] * q[4] + q[6] * q[7] + sx * sy)
      moment[2] += w * (q[0] * q[2] + q[3] * q[5] + q[6] * q[8] + sx * sz)
      moment[3] += w * (q[1] * q[1] + q[4] * q[4] + q[7] * q[7] + sy * sy)
      moment[4] += w * (q[1] * q[2] + q[4] * q[5] + q[7] * q[8] + sy * sz)
      moment[5] += w * (q[2] * q[2] + q[5] * q[5] + q[8] * q[8] + sz * sz)
    }
  }
  if (count === 0 || at === null) return null
  // Triangles of no area weigh nothing: a region of those alone is where its first one is.
  const mean = area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : [0, 0, 0]
  const centroid: Vec3 = [at[0] + mean[0], at[1] + mean[1], at[2] + mean[2]]
  const facing = normal ?? ([0, 0, 1] as Vec3)
  let plane = { origin: centroid, normal: facing, rms: 0 }
  // The axes the region spreads along, most first: of the plane nearest its centroids when they say one, else of
  // its first triangle's plane, with the line the centroids lie along in it.
  let axes: [Vec3, Vec3, Vec3] = inPlaneOf(facing, null)
  if (area > 0) {
    const m = moment.map((value) => value / area)
    const cov = [
      [m[0] - mean[0] * mean[0], m[1] - mean[0] * mean[1], m[2] - mean[0] * mean[2]],
      [m[1] - mean[0] * mean[1], m[3] - mean[1] * mean[1], m[4] - mean[1] * mean[2]],
      [m[2] - mean[0] * mean[2], m[4] - mean[1] * mean[2], m[5] - mean[2] * mean[2]]
    ]
    const { values, vectors } = eigenSymmetric(cov)
    const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
    const [least, middle, most] = order.map((i) => Math.max(values[i], 0))
    const axis = (n: number): Vec3 => unit([vectors[0][order[n]], vectors[1][order[n]], vectors[2][order[n]]])
    // Fewer than three triangles, or all of it along one line: no plane is fitted, it has its first triangle's.
    if (count >= 3 && !(middle <= 1e-6 * most || most <= 1e-18)) {
      plane = { origin: centroid, normal: axis(0), rms: Math.sqrt(least) }
      axes = [axis(2), axis(1), axis(0)]
    } else axes = inPlaneOf(facing, most > 1e-18 ? axis(2) : null)
  }
  // How far its triangles' corners reach along each of those axes, either way from the centroid.
  const low = [Infinity, Infinity, Infinity]
  const high = [-Infinity, -Infinity, -Infinity]
  for (let byte = 0; byte < bits.length; byte++) {
    if (bits[byte] === 0) continue
    for (let bit = 0; bit < 8; bit++) {
      const t = byte * 8 + bit
      if ((bits[byte] & (1 << bit)) === 0 || t >= total) continue
      for (let corner = 0; corner < 3; corner++) {
        const v = triangles[t * 3 + corner] * 3
        const d = [vertices[v] - centroid[0], vertices[v + 1] - centroid[1], vertices[v + 2] - centroid[2]]
        for (let k = 0; k < 3; k++) {
          const along = d[0] * axes[k][0] + d[1] * axes[k][1] + d[2] * axes[k][2]
          if (along < low[k]) low[k] = along
          if (along > high[k]) high[k] = along
        }
      }
    }
  }
  // Longest side first, whatever the centroids spread along most.
  const by = [0, 1, 2].sort((i, j) => high[j] - low[j] - (high[i] - low[i]))
  const centre: Vec3 = [0, 1, 2].map((c) => centroid[c] + by.reduce((sum, k) => sum + ((low[k] + high[k]) / 2) * axes[k][c], 0)) as Vec3
  // Never -0: what is kept is read back from a file, which has no such number.
  const box = { centre: centre.map((c) => c + 0) as Vec3, axes: by.map((k) => axes[k].map((c) => c + 0)) as [Vec3, Vec3, Vec3], half: by.map((k) => (high[k] - low[k]) / 2 + 0) as Vec3 }
  return { triangles: count, area, local: { centroid, bbox: { min, max }, plane, box } }
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Three axes square to one another, the last a normal: the first as near `along` as lies in the plane, or any direction of it. */
function inPlaneOf(normal: Vec3, along: Vec3 | null): [Vec3, Vec3, Vec3] {
  let first = along ? cross(cross(normal, along), normal) : ([0, 0, 0] as Vec3)
  if (Math.hypot(...first) < 1e-9) first = cross(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
  first = unit(first)
  return [first, unit(cross(normal, first)), normal]
}

/** The box a region fills along its own axes: its middle, the axes (longest side first), and half its size along each. */
export type PrincipalBox = RegionMark['local']['box']

/**
 * A region's numbers in the object frame of a layout the scan is aligned in: moved, turned, and at the size a
 * fit gave the scan. `box` is its own box there; `bbox` is the box along the layout's axes that holds that one
 * (the region is within it; it is not the region's size unless it lies along the axes).
 */
export function regionInLayout(region: Pick<RegionMark, 'area' | 'local'>, transform: ScanTransform): { area: number; centroid: Vec3; bbox: { min: Vec3; max: Vec3 }; plane: { origin: Vec3; normal: Vec3; rms: number }; box: PrincipalBox; flat: boolean } {
  const { centroid, plane, box, bbox } = region.local
  const scale = Math.abs(transform.s)
  const there: PrincipalBox = { centre: apply(transform, box.centre), axes: box.axes.map((axis) => rotate(transform.q, axis)) as [Vec3, Vec3, Vec3], half: box.half.map((h) => h * scale) as Vec3 }
  const turned = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 }
  for (const x of [bbox.min[0], bbox.max[0]]) {
    for (const y of [bbox.min[1], bbox.max[1]]) {
      for (const z of [bbox.min[2], bbox.max[2]]) {
        const corner = apply(transform, [x, y, z])
        for (let axis = 0; axis < 3; axis++) {
          turned.min[axis] = Math.min(turned.min[axis], corner[axis])
          turned.max[axis] = Math.max(turned.max[axis], corner[axis])
        }
      }
    }
  }
  const reach = [0, 1, 2].map((c) => there.axes.reduce((sum, axis, k) => sum + Math.abs(axis[c]) * there.half[k], 0))
  return {
    area: region.area * transform.s * transform.s,
    centroid: apply(transform, centroid),
    // It is within the box round its own box, and within the box round the scan frame's box of it: so within what the two share.
    bbox: { min: there.centre.map((c, axis) => Math.max(c - reach[axis], turned.min[axis])) as Vec3, max: there.centre.map((c, axis) => Math.min(c + reach[axis], turned.max[axis])) as Vec3 },
    plane: { origin: apply(transform, plane.origin), normal: rotate(transform.q, plane.normal), rms: plane.rms * scale },
    box: there,
    flat: isFlat(there)
  }
}

/** A region is flat when it is this thin against its lesser side (and one thinner than `FLAT_LEAST_MM` always is): judged on its own box, so the same however its scan is turned. */
export const FLAT_SHARE = 0.25
export const FLAT_LEAST_MM = 0.5

/** Whether a region is roughly flat: thin against the lesser of its two other sides. */
export function isFlat(box: Pick<PrincipalBox, 'half'>): boolean {
  const [, middle, thin] = [...box.half].sort((a, b) => b - a)
  return 2 * thin <= Math.max(FLAT_LEAST_MM, FLAT_SHARE * 2 * middle)
}

/** What says which mesh of a scan a region was painted on: the source it was read from, its counts, and the unit and up axis it was read with. Another, and its triangles are others. */
export function meshIdentity(scan: { source: Pick<Scan['source'], 'sha256'>; imported: Pick<Scan['imported'], 'vertices' | 'triangles' | 'unit' | 'up'> }): string {
  return [scan.source.sha256, scan.imported.vertices, scan.imported.triangles, scan.imported.unit, scan.imported.up].join('|')
}

/** What the file of a region's triangles is called, less `.mask`: its mark's number, and after it was painted again, which painting. */
export function maskStem(mark: Pick<RegionMark, 'id'> & { mask?: number }): string {
  return mark.mask === undefined ? mark.id : `${mark.id}.${mark.mask}`
}

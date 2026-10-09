import { apply, eigenSymmetric, rotate } from './align'
import type { RegionMark, Vec3 } from './marks'
import type { ScanMesh, ScanTransform } from './scans'

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
  if (bits.length !== bytesFor(triangles)) return `${bits.length} bytes of triangles do not fit a mesh of ${triangles.toLocaleString('en-US')} triangles: ${bytesFor(triangles)} bytes`
  const spare = triangles & 7
  if (spare !== 0 && bits[bits.length - 1] >> spare !== 0) return `the region names a triangle past the last of the mesh (${triangles.toLocaleString('en-US')} triangles)`
  return null
}

/**
 * What a region is, from the mesh and its bits: main's to say, never the window's. Null for no triangle.
 *
 * One pass over the set's triangles: the area, the area-weighted centroid, the box of their corners, and the
 * plane nearest their centroids (each weighing its area) with how far they lie from it. A set whose centroids
 * are in a line or in one place has the plane of its first triangle, and lies in it as far as can be said.
 */
export function regionStats(mesh: Pick<ScanMesh, 'vertices' | 'triangles'>, bits: Uint8Array): RegionStats | null {
  const { vertices, triangles } = mesh
  const total = triangles.length / 3
  let count = 0
  let area = 0
  const sum = [0, 0, 0]
  // Second moments of the centroids about the first one met, so that a region far from the origin loses no digits.
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
      moment[0] += a * d[0] * d[0]
      moment[1] += a * d[0] * d[1]
      moment[2] += a * d[0] * d[2]
      moment[3] += a * d[1] * d[1]
      moment[4] += a * d[1] * d[2]
      moment[5] += a * d[2] * d[2]
    }
  }
  if (count === 0 || at === null) return null
  // Triangles of no area weigh nothing: a region of those alone is where its first one is.
  const mean = area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : [0, 0, 0]
  const centroid: Vec3 = [at[0] + mean[0], at[1] + mean[1], at[2] + mean[2]]
  const flat = { origin: centroid, normal: normal ?? ([0, 0, 1] as Vec3), rms: 0 }
  let plane = flat
  if (area > 0 && count >= 3) {
    const m = moment.map((value) => value / area)
    const cov = [
      [m[0] - mean[0] * mean[0], m[1] - mean[0] * mean[1], m[2] - mean[0] * mean[2]],
      [m[1] - mean[0] * mean[1], m[3] - mean[1] * mean[1], m[4] - mean[1] * mean[2]],
      [m[2] - mean[0] * mean[2], m[4] - mean[1] * mean[2], m[5] - mean[2] * mean[2]]
    ]
    const { values, vectors } = eigenSymmetric(cov)
    const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
    const [least, middle, most] = order.map((i) => Math.max(values[i], 0))
    // In a line, or in one place: no plane is said by the centroids.
    if (!(middle <= 1e-6 * most || most <= 1e-18)) {
      const axis: Vec3 = [vectors[0][order[0]], vectors[1][order[0]], vectors[2][order[0]]]
      const length = Math.hypot(...axis) || 1
      plane = { origin: centroid, normal: [axis[0] / length, axis[1] / length, axis[2] / length], rms: Math.sqrt(least) }
    }
  }
  return { triangles: count, area, local: { centroid, bbox: { min, max }, plane } }
}

/** A region's numbers in the object frame of a layout the scan is aligned in: moved, turned, and at the size a fit gave the scan. */
export function regionInLayout(region: Pick<RegionMark, 'area' | 'local'>, transform: ScanTransform): { area: number; centroid: Vec3; bbox: { min: Vec3; max: Vec3 }; plane: { origin: Vec3; normal: Vec3; rms: number } } {
  const { centroid, bbox, plane } = region.local
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const x of [bbox.min[0], bbox.max[0]]) {
    for (const y of [bbox.min[1], bbox.max[1]]) {
      for (const z of [bbox.min[2], bbox.max[2]]) {
        const corner = apply(transform, [x, y, z])
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], corner[axis])
          max[axis] = Math.max(max[axis], corner[axis])
        }
      }
    }
  }
  return {
    area: region.area * transform.s * transform.s,
    centroid: apply(transform, centroid),
    bbox: { min, max },
    plane: { origin: apply(transform, plane.origin), normal: rotate(transform.q, plane.normal), rms: plane.rms * Math.abs(transform.s) }
  }
}

/** Under this share of its box's diagonal (and never under half a millimetre) a region lies about one plane: it is said to be flat, and to how much. */
export const FLAT_SHARE = 0.05
export const FLAT_LEAST_MM = 0.5

/** Whether a region is roughly flat: its triangles lie within a twentieth of its size from one plane. */
export function isFlat(region: { bbox: { min: Vec3; max: Vec3 }; plane: { rms: number } }): boolean {
  const diagonal = Math.hypot(...region.bbox.max.map((c, axis) => c - region.bbox.min[axis]))
  return region.plane.rms <= Math.max(FLAT_LEAST_MM, FLAT_SHARE * diagonal)
}

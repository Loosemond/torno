import type { StrokeMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'
import { along, dot, sub, unit } from './Tool'

/** A plane to draw on: a point of it, and its two axes (unit vectors, object frame). A point of it is `origin + u·x + v·y`, in millimetres. */
export type Plane = NonNullable<StrokeMark['plane']>

/** Within this of a principal axis, a view is taken to look along it. */
const AXIS_WITHIN_DEG = 0.5
const AXIS_COS = Math.cos((AXIS_WITHIN_DEG * Math.PI) / 180)
const LETTERS = ['X', 'Y', 'Z'] as const

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** The principal axis a unit vector runs along, to within half a degree: 0, 1 or 2; -1 for none. */
function axisOf(v: Vec3): number {
  return v.findIndex((c) => Math.abs(c) >= AXIS_COS)
}

/** A unit vector that runs along a principal axis to within half a degree, as exactly that axis; any other as it is. */
function squared(v: Vec3): Vec3 {
  const axis = axisOf(v)
  // `+ 0`: no negative zeros in what is stored.
  return axis < 0 ? v : (v.map((c, i) => (i === axis ? Math.sign(c) : 0) + 0) as Vec3)
}

/**
 * The plane that faces a camera, through a point: `x` is the view's right and
 * `y` its up. When the view looks along a principal axis to within half a
 * degree the plane is that principal plane exactly, and its label names it
 * and where it is: the two axes it spans, the one along `x` first, then the
 * fixed one and its coordinate; any other is `view plane`. Either way the
 * label then says which way the plane's own two axes run, `u` along `x` and
 * `v` along `y`: `XZ at y = 40.0 (u = +X, v = +Z)`. The same plane seen from
 * the other side has its `u` the other way, and says so, so a profile is
 * never read mirrored by whoever has only the label.
 */
export function viewPlane(camera: Pick<Camera, 'position' | 'target' | 'up'>, through: Vec3): Plane {
  const looks = squared(unit(sub(camera.target, camera.position)) ?? [0, 1, 0])
  // The camera's up, made square to the way it looks.
  const lean = dot(camera.up, looks)
  const up = unit(sub(camera.up, [looks[0] * lean, looks[1] * lean, looks[2] * lean])) ?? (Math.abs(looks[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0])
  const y = squared(up)
  const x = squared(unit(cross(looks, y)) ?? [1, 0, 0]).map((c) => c + 0) as Vec3
  const origin: Vec3 = [...through]

  const axes = `(u = ${direction(x)}, v = ${direction(y)})`
  const fixed = axisOf(looks)
  if (fixed < 0) return { origin, x, y, label: `view plane ${axes}` }
  const across = axisOf(x)
  const first = across >= 0 ? across : [0, 1, 2].find((i) => i !== fixed)!
  const second = [0, 1, 2].find((i) => i !== fixed && i !== first)!
  const at = through[fixed].toFixed(1)
  return { origin, x, y, label: `${LETTERS[first]}${LETTERS[second]} at ${LETTERS[fixed].toLowerCase()} = ${at === '-0.0' ? '0.0' : at} ${axes}` }
}

/** Which way a unit vector points, in a label: `+X` or `-Z` along a principal axis, else its three numbers to the hundredth. */
function direction(v: Vec3): string {
  const axis = v.findIndex((c) => Math.abs(c) === 1)
  if (axis >= 0 && v.every((c, i) => i === axis || c === 0)) return `${v[axis] > 0 ? '+' : '-'}${LETTERS[axis]}`
  return `[${v.map((c) => Math.round(c * 100) / 100 + 0).join(', ')}]`
}

/** A plane's label without the directions of its axes: `XZ at y = 40.0`, `view plane`. For where there is room for a few words only. */
export function planeName(label: string): string {
  return label.split(' (')[0]
}

/** A point of the object frame in a plane's own two axes, in millimetres from its origin. What is off the plane is dropped. */
export function toPlane(plane: Plane, point: Vec3): [number, number] {
  const from = sub(point, plane.origin)
  return [dot(from, plane.x), dot(from, plane.y)]
}

/** A point of a plane, given in its own axes, in the object frame. */
export function fromPlane(plane: Plane, [u, v]: [number, number]): Vec3 {
  return along(along(plane.origin, plane.x, u), plane.y, v)
}

/** Where a ray meets a plane; null when it runs along it. */
export function rayOnPlane(ray: { origin: Vec3; direction: Vec3 }, plane: Plane): Vec3 | null {
  const normal = cross(plane.x, plane.y)
  const slope = dot(ray.direction, normal)
  if (Math.abs(slope) < 1e-9) return null
  return along(ray.origin, ray.direction, dot(sub(plane.origin, ray.origin), normal) / slope)
}

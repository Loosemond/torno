import * as THREE from 'three'
import { type BuiltPart, faceOfTriangle } from './partMesh'

type Vec3 = [number, number, number]

/**
 * What is under the pointer: a face or an edge of a part. `point` and `normal`
 * are in the object frame, in millimetres; an edge has no normal. `distance`
 * is measured along the pointer's ray from where it starts. `ref` names the
 * face or edge in the layout shown: `lid/F12`, `lid/E3`.
 */
export interface Hit {
  partKey: string
  part: string
  kind: 'face' | 'edge'
  index: number
  ref: string
  point: Vec3
  normal: Vec3 | null
  distance: number
}

/** How near the pointer must be to an edge to pick it, in pixels. */
export const EDGE_REACH_PX = 6
/** How far behind the nearest face an edge may lie and still be picked, in millimetres. */
export const EDGE_BEHIND_MM = 0.5
/** Edges near the pointer that are looked at before giving up on them all being hidden. */
const EDGE_TRIES = 8
/** Where a segment that passes behind the eye is cut, as a clip-space w. */
const MIN_W = 1e-6

export function refOf(part: string, kind: 'face' | 'edge', index: number): string {
  return `${part}/${kind === 'face' ? 'F' : 'E'}${index}`
}

/** A ref taken apart: a face or an edge of a part, or the part itself (`index` -1). */
export function parseRef(ref: string): { part: string; kind: 'part' | 'face' | 'edge'; index: number } {
  const m = /^(.+)\/([FE])(\d+)$/.exec(ref)
  if (!m) return { part: ref, kind: 'part', index: -1 }
  return { part: m[1], kind: m[2] === 'F' ? 'face' : 'edge', index: Number(m[3]) }
}

/**
 * The edge a segment belongs to, or -1 if the part has no such segment.
 * `edgeStarts` holds the segment number at which each edge starts, with the
 * total at the end (`BuiltPart.edgeStarts`).
 */
export function edgeOfSegment(edgeStarts: Uint32Array, segment: number): number {
  const edges = edgeStarts.length - 1
  if (!(segment >= 0) || edges < 1 || segment >= edgeStarts[edges]) return -1
  // The last edge whose start is at or before the segment; edges without
  // segments share a start with the next one and are passed over.
  let lo = 0
  let hi = edges - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (edgeStarts[mid] <= segment) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Segments as they fall on a canvas of `width` × `height` pixels: x1 y1 x2 y2
 * each, y down. `positions` holds six numbers per segment (x1 y1 z1 x2 y2 z2)
 * and `mvp` is the matrix that takes them to clip space, column by column. A
 * segment wholly behind the eye is four NaNs; one that crosses it is cut. The
 * result is `into` when that is long enough.
 */
export function projectSegments(positions: ArrayLike<number>, mvp: ArrayLike<number>, width: number, height: number, into?: Float32Array): Float32Array {
  const count = Math.floor(positions.length / 6)
  const out = into && into.length >= count * 4 ? into : new Float32Array(count * 4)
  const [m0, m1, m3, m4, m5, m7, m8, m9, m11, m12, m13, m15] = [mvp[0], mvp[1], mvp[3], mvp[4], mvp[5], mvp[7], mvp[8], mvp[9], mvp[11], mvp[12], mvp[13], mvp[15]]
  const halfW = width / 2
  const halfH = height / 2
  for (let i = 0; i < count; i++) {
    const p = i * 6
    const o = i * 4
    const [ax, ay, az, bx, by, bz] = [positions[p], positions[p + 1], positions[p + 2], positions[p + 3], positions[p + 4], positions[p + 5]]
    let x1 = m0 * ax + m4 * ay + m8 * az + m12
    let y1 = m1 * ax + m5 * ay + m9 * az + m13
    let w1 = m3 * ax + m7 * ay + m11 * az + m15
    let x2 = m0 * bx + m4 * by + m8 * bz + m12
    let y2 = m1 * bx + m5 * by + m9 * bz + m13
    let w2 = m3 * bx + m7 * by + m11 * bz + m15
    if (w1 < MIN_W && w2 < MIN_W) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = Number.NaN
      continue
    }
    if (w1 < MIN_W) {
      const t = (MIN_W - w1) / (w2 - w1)
      x1 += (x2 - x1) * t
      y1 += (y2 - y1) * t
      w1 = MIN_W
    } else if (w2 < MIN_W) {
      const t = (MIN_W - w2) / (w1 - w2)
      x2 += (x1 - x2) * t
      y2 += (y1 - y2) * t
      w2 = MIN_W
    }
    out[o] = (x1 / w1 + 1) * halfW
    out[o + 1] = (1 - y1 / w1) * halfH
    out[o + 2] = (x2 / w2 + 1) * halfW
    out[o + 3] = (1 - y2 / w2) * halfH
  }
  return out
}

export interface SegmentNear {
  segment: number
  /** From the pointer to the nearest point of the segment, in pixels. */
  distance: number
}

/** The segments within `radius` pixels of a point of the canvas, nearest first. `screen` is what `projectSegments` returns. */
export function segmentsNear(screen: ArrayLike<number>, px: number, py: number, radius: number): SegmentNear[] {
  const found: SegmentNear[] = []
  const reach = radius * radius
  for (let o = 0, segment = 0; o + 3 < screen.length; o += 4, segment++) {
    const x1 = screen[o]
    const y1 = screen[o + 1]
    const dx = screen[o + 2] - x1
    const dy = screen[o + 3] - y1
    const length = dx * dx + dy * dy
    let t = length > 0 ? ((px - x1) * dx + (py - y1) * dy) / length : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x1 + dx * t - px
    const ey = y1 + dy * t - py
    const d = ex * ex + ey * ey
    // A segment behind the eye is NaN, and fails this.
    if (d <= reach) found.push({ segment, distance: Math.sqrt(d) })
  }
  return found.sort((a, b) => a.distance - b.distance)
}

/** The segment nearest to the pointer within `radius` pixels, or null when none is. */
export function pickEdge(screen: ArrayLike<number>, pointer: [number, number], radius: number): SegmentNear | null {
  return segmentsNear(screen, pointer[0], pointer[1], radius)[0] ?? null
}

/** The point of the segment from `a` to `b` that is nearest to a ray; `direction` has length 1. */
export function closestOnSegment(a: Vec3, b: Vec3, origin: Vec3, direction: Vec3): Vec3 {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const w: Vec3 = [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]]
  const uu = dot(u, u)
  const ud = dot(u, direction)
  const denominator = uu - ud * ud
  // Along the ray, or a point: every point of it is as near as the first.
  let s = denominator > 1e-12 * Math.max(uu, 1) ? (ud * dot(direction, w) - dot(u, w)) / denominator : 0
  s = s < 0 ? 0 : s > 1 ? 1 : s
  return [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** A part that can be picked: one that is drawn. */
export interface Pickable {
  key: string
  name: string
  built: BuiltPart
}

const raycaster = new THREE.Raycaster()
raycaster.firstHitOnly = true
const scratch = new WeakMap<BuiltPart, Float32Array>()
const mvp = new THREE.Matrix4()
const va = new THREE.Vector3()
const vb = new THREE.Vector3()
const vp = new THREE.Vector3()

/**
 * What a pointer at `ndc` (-1 to 1 across the canvas, y up) is on, among the
 * parts given: the nearest face under it, or an edge within six pixels of it
 * that no face hides. An edge within reach wins over the face. `size` is the
 * canvas in CSS pixels. The world matrices of the camera and the parts must be
 * current. Faceted parts have no edges to pick: theirs are creases, not edges
 * of the model.
 */
export function pickParts(
  parts: Pickable[],
  camera: THREE.Camera,
  ndc: { x: number; y: number },
  size: { width: number; height: number },
  opts: { edges?: boolean } = {}
): Hit | null {
  aim(camera, ndc.x, ndc.y)
  const ray = raycaster.ray.clone()
  const face = nearestFace(parts)
  if (opts.edges === false) return face
  return nearestEdge(parts, camera, ray, [((ndc.x + 1) / 2) * size.width, ((1 - ndc.y) / 2) * size.height], size) ?? face
}

/** The ray a pointer at `ndc` looks along, in the object frame. */
export function pointerRay(camera: THREE.Camera, ndc: { x: number; y: number }): { origin: Vec3; direction: Vec3 } {
  aim(camera, ndc.x, ndc.y)
  return { origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() }
}

/**
 * Points the raycaster through a place on the canvas. Its ray starts at the
 * eye, or for an orthographic camera on the near plane: three.js starts that
 * one at the camera, which may sit inside the parts it shows.
 */
function aim(camera: THREE.Camera, x: number, y: number): void {
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
  if (camera instanceof THREE.OrthographicCamera) raycaster.ray.origin.addScaledVector(raycaster.ray.direction, camera.near)
}

/** The first face the raycaster's ray meets. */
function nearestFace(parts: Pickable[]): Hit | null {
  let best: { part: Pickable; hit: THREE.Intersection } | null = null
  for (const part of parts) {
    const [hit] = raycaster.intersectObject(part.built.mesh, false)
    if (hit && (!best || hit.distance < best.hit.distance)) best = { part, hit }
  }
  if (!best) return null
  const { part, hit } = best
  const index = faceOfTriangle(part.built.faceStarts, hit.faceIndex ?? -1)
  if (index < 0) return null
  // Part-local, like the mesh: turned into the object frame with the part.
  const local = hit.normal ?? hit.face?.normal
  const normal = local ? local.clone().transformDirection(part.built.group.matrixWorld).toArray() : null
  return { partKey: part.key, part: part.name, kind: 'face', index, ref: refOf(part.name, 'face', index), point: hit.point.toArray(), normal, distance: hit.distance }
}

function nearestEdge(parts: Pickable[], camera: THREE.Camera, ray: THREE.Ray, pointer: [number, number], size: { width: number; height: number }): Hit | null {
  const near: { part: Pickable; segment: number; distance: number }[] = []
  for (const part of parts) {
    const { built } = part
    if (built.faceted) continue
    const positions = built.edges.geometry.getAttribute('position')?.array
    if (!positions || positions.length < 6) continue
    mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(built.group.matrixWorld)
    const screen = projectSegments(positions, mvp.elements, size.width, size.height, scratch.get(built))
    scratch.set(built, screen)
    // The array may be longer than this part needs: only its own segments are looked at.
    for (const found of segmentsNear(screen.subarray(0, Math.floor(positions.length / 6) * 4), pointer[0], pointer[1], EDGE_REACH_PX)) near.push({ part, ...found })
  }
  near.sort((a, b) => a.distance - b.distance)

  const origin = ray.origin.toArray()
  const direction = ray.direction.toArray()
  const tried = new Set<string>()
  for (const { part, segment } of near) {
    const index = edgeOfSegment(part.built.edgeStarts, segment)
    const id = `${part.key}/${index}`
    if (index < 0 || tried.has(id)) continue
    if (tried.size >= EDGE_TRIES) break
    tried.add(id)

    const positions = part.built.edges.geometry.getAttribute('position')
    const world = part.built.group.matrixWorld
    va.fromBufferAttribute(positions, segment * 2).applyMatrix4(world)
    vb.fromBufferAttribute(positions, segment * 2 + 1).applyMatrix4(world)
    const point = closestOnSegment(va.toArray(), vb.toArray(), origin, direction)

    // Seen from the eye, is a face in front of that point of the edge? The
    // faces the edge bounds are at its own depth, and do not count.
    vp.fromArray(point).project(camera)
    aim(camera, vp.x, vp.y)
    const depth = vp.fromArray(point).sub(raycaster.ray.origin).dot(raycaster.ray.direction)
    const front = nearestFace(parts)
    if (front && front.distance < depth - EDGE_BEHIND_MM) continue

    const distance = vp.fromArray(point).sub(ray.origin).dot(ray.direction)
    return { partKey: part.key, part: part.name, kind: 'edge', index, ref: refOf(part.name, 'edge', index), point, normal: null, distance }
  }
  return null
}

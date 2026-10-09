import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { regionStats } from '../../shared/regions'

// Painting on a scan: which of its triangles are in a set, and what gathers them. A set is the bits of a
// `.mask` (bit `i & 7` of byte `i >> 3` for triangle `i`, the triangle's number in the mesh file), so what was
// painted is sent to main as it is. Everything here works in the scan's own frame, through its bounds tree:
// a stroke touches the triangles under the brush and no others.

/** Told of every triangle that joins or leaves a set, and when it is emptied: what draws the set follows it without looking at all of it. */
export interface SetWatcher {
  changed(triangle: number, on: boolean): void
  cleared(): void
}

/** A set of triangles of a scan as the bits of a `.mask`. */
export class TriangleSet {
  readonly bits: Uint8Array
  count = 0
  /** Whoever draws the set, while it is drawn. */
  watch: SetWatcher | null = null

  constructor(
    readonly triangles: number,
    bits?: Uint8Array
  ) {
    this.bits = new Uint8Array(Math.ceil(triangles / 8))
    if (bits) {
      this.bits.set(bits.subarray(0, this.bits.length))
      for (let t = 0; t < triangles; t++) if (this.has(t)) this.count += 1
    }
  }

  has(triangle: number): boolean {
    return (this.bits[triangle >> 3] & (1 << (triangle & 7))) !== 0
  }

  /** True when it was not in. A number that is no triangle of the mesh is never in. */
  add(triangle: number): boolean {
    if (!(triangle >= 0 && triangle < this.triangles) || this.has(triangle)) return false
    this.bits[triangle >> 3] |= 1 << (triangle & 7)
    this.count += 1
    this.watch?.changed(triangle, true)
    return true
  }

  /** True when it was in. */
  delete(triangle: number): boolean {
    if (!(triangle >= 0 && triangle < this.triangles) || !this.has(triangle)) return false
    this.bits[triangle >> 3] &= ~(1 << (triangle & 7))
    this.count -= 1
    this.watch?.changed(triangle, false)
    return true
  }

  clear(): void {
    this.bits.fill(0)
    this.count = 0
    this.watch?.cleared()
  }

  /** Calls `each` with every triangle of the set, in order. */
  forEach(each: (triangle: number) => void): void {
    for (let byte = 0; byte < this.bits.length; byte++) {
      if (this.bits[byte] === 0) continue
      for (let bit = 0; bit < 8; bit++) if (this.bits[byte] & (1 << bit)) each(byte * 8 + bit)
    }
  }
}

/** A triangle whose middle is this far into the half a section takes away is still of what is kept: it is cut, and seen. */
const KEPT_WITHIN = 1e-6
const sphere = new THREE.Sphere()
const middle = new THREE.Vector3()
const normal = new THREE.Vector3()
const corner = new THREE.Vector3()
const towardsEye = new THREE.Vector3()

/**
 * Calls `each` with the triangles whose centroid is within `radius` of `centre` (the scan's own frame) and,
 * when `towards` is given, that face it: whose normal has a share along it. Each once, in no order. With
 * `keeps`, the plane of a section in the scan's frame, only those on the side it keeps (its positive side): what
 * a cut has taken away is not drawn, and is not taken.
 */
export function gatherSphere(tree: MeshBVH, _geometry: THREE.BufferGeometry, centre: THREE.Vector3, radius: number, towards: THREE.Vector3 | null, each: (triangle: number) => void, keeps: THREE.Plane | null = null): void {
  sphere.set(centre, radius)
  tree.shapecast({
    intersectsBounds: (box) => box.intersectsSphere(sphere),
    intersectsTriangle: (triangle, index) => {
      triangle.getMidpoint(middle)
      if (sphere.containsPoint(middle) && (keeps === null || keeps.distanceToPoint(middle) >= -KEPT_WITHIN) && (towards === null || triangle.getNormal(normal).dot(towards) > 0)) each(index)
      return false
    }
  })
}

/**
 * Calls `each` with the triangles whose centroid is on the inner side of every plane (a frustum through a
 * rectangle of the screen, in the scan's own frame: a plane's normal points inwards) and that face `eye`, a
 * point; with `away`, those that face away from it instead (a scan wound the other way round shows its back);
 * with `through`, those that face either way. With `keeps`, only those on the side a section keeps. It does
 * not look at what hides what: a triangle behind another that faces the eye is taken too.
 */
export function gatherBox(tree: MeshBVH, _geometry: THREE.BufferGeometry, planes: THREE.Plane[], eye: THREE.Vector3, each: (triangle: number) => void, opts: { away?: boolean; through?: boolean; keeps?: THREE.Plane | null } = {}): void {
  const { away = false, through = false, keeps = null } = opts
  tree.shapecast({
    // A box that is wholly on the outer side of one plane holds nothing.
    intersectsBounds: (box) =>
      planes.every((plane) => {
        corner.set(plane.normal.x > 0 ? box.max.x : box.min.x, plane.normal.y > 0 ? box.max.y : box.min.y, plane.normal.z > 0 ? box.max.z : box.min.z)
        return plane.distanceToPoint(corner) >= 0
      }),
    intersectsTriangle: (triangle, index) => {
      triangle.getMidpoint(middle)
      if (!planes.every((plane) => plane.distanceToPoint(middle) >= 0) || (keeps !== null && keeps.distanceToPoint(middle) < -KEPT_WITHIN)) return false
      if (through || triangle.getNormal(normal).dot(towardsEye.copy(eye).sub(middle)) > 0 !== away) each(index)
      return false
    }
  })
}

/**
 * Grows a set over what is flat with it: triangles within `reach` of one already in it, no further than
 * `flat` from the set's best-fit plane and turned no more than `degrees` from it, either way round. At most
 * `most` are added; returns how many were. The plane is that of the set as it was given, and does not follow
 * what is added.
 *
 * It looks round one triangle of every cell of a grid a quarter of `reach` wide that the set comes to hold, not
 * round every triangle: what is within 0.57 of `reach` of any triangle in the set is always looked at, and
 * what is within `reach` of one usually. That is what keeps a large patch to a moment.
 */
export function growFlat(tree: MeshBVH, geometry: THREE.BufferGeometry, set: TriangleSet, opts: { flat?: number; degrees?: number; reach?: number; most?: number } = {}): number {
  const { flat = 2, degrees = 15, reach = 3, most = 200_000 } = opts
  const position = geometry.getAttribute('position').array as Float32Array
  const index = geometry.index!.array
  const stats = regionStats({ vertices: position, triangles: index as Uint32Array }, set.bits)
  if (!stats || !(reach > 0) || most <= 0) return 0
  const { plane } = stats.local
  const origin = new THREE.Vector3().fromArray(plane.origin)
  const along = new THREE.Vector3().fromArray(plane.normal)
  const least = Math.cos(THREE.MathUtils.degToRad(degrees))
  const centroid = (t: number, into: THREE.Vector3): THREE.Vector3 => {
    const [a, b, c] = [index[t * 3] * 3, index[t * 3 + 1] * 3, index[t * 3 + 2] * 3]
    return into.set((position[a] + position[b] + position[c]) / 3, (position[a + 1] + position[b + 1] + position[c + 1]) / 3, (position[a + 2] + position[b + 2] + position[c + 2]) / 3)
  }
  const cell = reach / 4
  const looked = new Set<string>()
  const queue: number[] = []
  set.forEach((t) => queue.push(t))
  const at = new THREE.Vector3()
  const round = new THREE.Sphere()
  let added = 0
  for (let n = 0; n < queue.length && added < most; n++) {
    centroid(queue[n], at)
    const key = `${Math.floor(at.x / cell)},${Math.floor(at.y / cell)},${Math.floor(at.z / cell)}`
    if (looked.has(key)) continue
    looked.add(key)
    round.set(at, reach)
    tree.shapecast({
      intersectsBounds: (box) => added < most && box.intersectsSphere(round),
      intersectsTriangle: (triangle, t) => {
        if (set.has(t)) return false
        triangle.getMidpoint(middle)
        if (!round.containsPoint(middle) || Math.abs(along.dot(middle) - along.dot(origin)) > flat) return false
        if (Math.abs(triangle.getNormal(normal).dot(along)) < least) return false
        set.add(t)
        queue.push(t)
        added += 1
        return added >= most
      }
    })
  }
  return added
}

/** The index that draws only a set's triangles over the scan's own positions. */
export function tintIndex(set: TriangleSet, index: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(set.count * 3)
  let n = 0
  set.forEach((t) => {
    out[n++] = index[t * 3]
    out[n++] = index[t * 3 + 1]
    out[n++] = index[t * 3 + 2]
  })
  return out
}

/** More ranges than this in one go are sent as the one stretch that holds them all. */
const MOST_RANGES = 64

/**
 * The index that draws a set as it is painted: room for every triangle of the scan, of which the first
 * `count` slots are the set's. A triangle that joins takes the next slot; one that leaves gives its slot to the
 * last. So a stroke writes only the slots of the triangles it touched, and `ranges` says which, for whoever
 * sends them to the graphics card: the index is never built again.
 */
export class PaintedIndex implements SetWatcher {
  readonly array: Uint32Array
  count = 0
  /** The slot each triangle is in, -1 for one that is not drawn. */
  private readonly slot: Int32Array
  /** The triangle in each slot. */
  private readonly held: Uint32Array
  /** Slots written since `taken`: first and one past the last, slot by slot or in runs. */
  private dirty: Array<[number, number]> = []

  constructor(
    private readonly index: ArrayLike<number>,
    triangles: number
  ) {
    this.array = new Uint32Array(triangles * 3)
    this.slot = new Int32Array(triangles).fill(-1)
    this.held = new Uint32Array(triangles)
  }

  /** Takes up a set as it is: the watcher of a set that already holds triangles. */
  fill(set: TriangleSet): void {
    this.cleared()
    set.forEach((t) => this.changed(t, true))
  }

  changed(triangle: number, on: boolean): void {
    const at = this.slot[triangle]
    if (on) {
      if (at >= 0) return
      this.put(this.count, triangle)
      this.count += 1
      return
    }
    if (at < 0) return
    const last = this.count - 1
    if (at !== last) this.put(at, this.held[last])
    this.slot[triangle] = -1
    this.count = last
  }

  cleared(): void {
    for (let n = 0; n < this.count; n++) this.slot[this.held[n]] = -1
    this.count = 0
    this.dirty = []
  }

  /**
   * The stretches of the index written since this was last asked, as `[start, count]` in its numbers (three a
   * triangle), and forgets them. Few: neighbours are joined, and too many become the one stretch that holds them.
   */
  ranges(): Array<[number, number]> {
    const dirty = this.dirty.filter(([from]) => from < this.count).sort((a, b) => a[0] - b[0])
    this.dirty = []
    const joined: Array<[number, number]> = []
    for (const [from, to] of dirty) {
      const last = joined[joined.length - 1]
      if (last && from <= last[1]) last[1] = Math.max(last[1], to)
      else joined.push([from, to])
    }
    const few = joined.length > MOST_RANGES ? [[joined[0][0], joined[joined.length - 1][1]] as [number, number]] : joined
    return few.map(([from, to]) => [from * 3, (Math.min(to, this.count) - from) * 3])
  }

  private put(at: number, triangle: number): void {
    this.array[at * 3] = this.index[triangle * 3]
    this.array[at * 3 + 1] = this.index[triangle * 3 + 1]
    this.array[at * 3 + 2] = this.index[triangle * 3 + 2]
    this.held[at] = triangle
    this.slot[triangle] = at
    const last = this.dirty[this.dirty.length - 1]
    if (last && last[1] === at) last[1] = at + 1
    else this.dirty.push([at, at + 1])
  }
}

import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { number } from '../../shared/format'
import { KEPT_WITHIN_MM, keepsNothing, keptDepth } from '../../shared/cut'
import { type SectionPlane, axisForm } from '../../shared/view'
import type { BuiltPart } from './partMesh'

type Vec3 = [number, number, number]

export type Axis = 'x' | 'y' | 'z'
/** A box in the object frame, as a part or a scene has it. */
export interface Box {
  min: ArrayLike<number>
  max: ArrayLike<number>
}

const AXES: Axis[] = ['x', 'y', 'z']

// ---- planes, as plain numbers ----

/** The plane a face lies in where it was pointed at, removing what is in front of the face. Null where there is no normal. */
export function planeFromFace(hit: { point: Vec3; normal: Vec3 | null }): SectionPlane | null {
  const length = hit.normal ? Math.hypot(...hit.normal) : 0
  if (!hit.normal || !(length > 1e-9)) return null
  return { origin: [...hit.point], normal: hit.normal.map((c) => c / length + 0) as Vec3 }
}

/** The plane `mm` further along its normal: less is removed for a positive distance. */
export function movedAlongNormal(plane: SectionPlane, mm: number): SectionPlane {
  return { origin: plane.origin.map((c, i) => c + plane.normal[i] * mm) as Vec3, normal: plane.normal }
}

/** The same plane, removing the other side. */
export function flipped(plane: SectionPlane): SectionPlane {
  return { origin: plane.origin, normal: plane.normal.map((c) => -c + 0) as Vec3 }
}

/** How far a plane with this normal can go and still meet a box: its offsets from the centre of the box at the two corners furthest apart along the normal, in millimetres. */
export function sectionExtent(box: Box, normal: Vec3): { min: number; max: number } {
  const half = normal.reduce((sum, c, i) => sum + (Math.abs(c) * (box.max[i] - box.min[i])) / 2, 0)
  return { min: -half, max: half }
}

/** The offset of a plane: its distance from the centre of a box, along its normal and signed, in millimetres. */
export function sectionOffset(plane: SectionPlane, box: Box): number {
  const centre = centreOf(box)
  return plane.normal.reduce((sum, c, i) => sum + c * (plane.origin[i] - centre[i]), 0) + 0
}

/**
 * The offset a typed text asks for, in millimetres (a comma is a point), or
 * null when it is no number or the plane is there already. It is held
 * against the offset the plane has, to the millionth of a millimetre a plane
 * is kept to, and not against how that is written: at 120, the four digits
 * shown, a typed 120.04 is another place.
 */
export function typedOffset(text: string, offset: number): number | null {
  const typed = text.trim().replace(',', '.')
  const mm = typed === '' ? Number.NaN : Number(typed)
  return Number.isFinite(mm) && Math.abs(mm - offset) > 1e-6 ? mm : null
}

/** The plane at an offset (see `sectionOffset`), which is kept within the box. One that is no number leaves the plane where it is. */
export function atOffset(plane: SectionPlane, box: Box, mm: number): SectionPlane {
  if (!Number.isFinite(mm)) return plane
  const { min, max } = sectionExtent(box, plane.normal)
  // To the millionth of a millimetre: what is left of adding tenths is not an offset anyone asked for.
  const to = Math.round(Math.min(Math.max(mm, min), max) * 1e6) / 1e6
  return movedAlongNormal(plane, to - sectionOffset(plane, box))
}

/** The axis a normal runs along and which way, or null for a plane across none. */
export function axisOf(normal: Vec3): { axis: Axis; sign: 1 | -1 } | null {
  const along = axisForm({ origin: [0, 0, 0], normal })
  return along && { axis: along.axis, sign: along.sign }
}

/** A section in words, for the caption of a picture: where the plane is, and which side of it is not drawn. */
export function describeSection(plane: SectionPlane): string {
  const along = axisOf(plane.normal)
  if (along) {
    const i = AXES.indexOf(along.axis)
    return `cut at ${along.axis} = ${number(plane.origin[i])}, ${along.sign > 0 ? '+' : '-'}${along.axis.toUpperCase()} side removed`
  }
  return `cut through (${plane.origin.map(number).join(', ')}), side along (${plane.normal.map(number).join(', ')}) removed`
}

/**
 * The rectangle a plane is drawn as: in the plane, around everything of a box
 * seen along the normal, with a margin. `centre` is its middle, `u` the
 * direction of its width; its height runs along normal × u.
 */
export function planeRect(plane: SectionPlane, box: Box): { centre: Vec3; u: Vec3; width: number; height: number } {
  const n = plane.normal
  // Across an axis the rectangle is square to the other two.
  const ref: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]
  const u = unit(cross(ref, n))
  const v = cross(n, u)
  const middle = centreOf(box)
  const onPlane = movedAlongNormal({ origin: middle, normal: n }, sectionOffset(plane, box)).origin
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (let corner = 0; corner < 8; corner++) {
    const d = [0, 1, 2].map((i) => ((corner >> i) & 1 ? box.max[i] : box.min[i]) - onPlane[i])
    const du = d[0] * u[0] + d[1] * u[1] + d[2] * u[2]
    const dv = d[0] * v[0] + d[1] * v[1] + d[2] * v[2]
    u0 = Math.min(u0, du)
    u1 = Math.max(u1, du)
    v0 = Math.min(v0, dv)
    v1 = Math.max(v1, dv)
  }
  const margin = Math.max(Math.max(u1 - u0, v1 - v0) * RECT_MARGIN, 1)
  const centre = onPlane.map((c, i) => c + (u[i] * (u0 + u1)) / 2 + (v[i] * (v0 + v1)) / 2 + 0) as Vec3
  return { centre, u, width: u1 - u0 + 2 * margin, height: v1 - v0 + 2 * margin }
}

/** How much wider than the parts the plane is drawn, on each side, as a share of its longer side. */
const RECT_MARGIN = 0.06

function centreOf(box: Box): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1] + 0, a[2] * b[0] - a[0] * b[2] + 0, a[0] * b[1] - a[1] * b[0] + 0]
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(...v)
  return [v[0] / length + 0, v[1] / length + 0, v[2] / length + 0]
}

// ---- the cut, as it is drawn ----

// What a section keeps of a box, as plain numbers, is `shared/cut.ts`'s to say: main plans pictures by the same rule.
export { KEPT_WITHIN_MM, keptDepth, keepsNothing }

/**
 * Whether a section leaves nothing of a part, given the box around it. A part
 * with any thickness across the plane goes by `keepsNothing`: it is gone when
 * it only touches the plane. A flat sheet (a face, a sketch) has nothing but
 * what lies in one plane: lying in the section's it is what the section
 * keeps, and it is gone only when it is beyond it.
 */
export function leavesNothing(box: Box, plane: SectionPlane): boolean {
  const { min, max } = sectionExtent(box, plane.normal)
  if (max - min > 2 * KEPT_WITHIN_MM) return keepsNothing(box, plane)
  return keptDepth(box, plane) < -KEPT_WITHIN_MM
}

/**
 * Whether a point of a view is within `reach` pixels of a segment as the
 * camera draws it. `pointer` and `size` are in pixels of the view, from its
 * top left; the camera's matrices are current. False when either end of the
 * segment is behind the camera or outside what it shows: nothing is drawn
 * there to take hold of, and a point behind the eye would be mirrored onto
 * the view.
 */
export function nearSegmentOnScreen(camera: THREE.Camera, a: THREE.Vector3, b: THREE.Vector3, pointer: [number, number], size: { width: number; height: number }, reach: number): boolean {
  const ends: Array<[number, number]> = []
  const clip = new THREE.Vector4()
  for (const end of [a, b]) {
    clip.set(end.x, end.y, end.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
    if (!(clip.w > 0) || Math.abs(clip.x) > clip.w || Math.abs(clip.y) > clip.w || Math.abs(clip.z) > clip.w) return false
    ends.push([((clip.x / clip.w + 1) / 2) * size.width, ((1 - clip.y / clip.w) / 2) * size.height])
  }
  const [[ax, ay], [bx, by]] = ends
  const [dx, dy] = [bx - ax, by - ay]
  const length = dx * dx + dy * dy
  const t = length > 0 ? Math.min(Math.max(((pointer[0] - ax) * dx + (pointer[1] - ay) * dy) / length, 0), 1) : 0
  return Math.hypot(ax + dx * t - pointer[0], ay + dy * t - pointer[1]) <= reach
}

/** How much of black the cut face of a part has over the part's own colour: a step darker, like sawn stock beside a finished face. */
export const CAP_SHADE = 0.24

/** The colour the cut face of a part is drawn in, given the part's. */
export function capColour(hex: string): string {
  const c = new THREE.Color(hex).lerp(BLACK, CAP_SHADE)
  return `#${c.getHexString()}`
}

const BLACK = new THREE.Color(0, 0, 0)
/** Drawn after the parts (0) and before what is highlighted on them (1 and up): each part's three passes one after the other. */
const ORDER_FROM = 0.0001
/** The rectangle of the plane comes after every cut face. */
const ORDER_UNTIL = 0.8
/** The handle on screen, in pixels. */
const HANDLE = { shaft: 34, head: 11, headRadius: 4.5, shaftRadius: 0.8, foot: 2.6 }

const UNIT_QUAD = new THREE.PlaneGeometry(1, 1)

interface Cap {
  /** Count the back and the front faces the plane leaves, in the stencil: where they differ, the plane is inside the part. */
  back: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  front: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  /** The plane itself, drawn where that count is not zero. */
  face: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  /** Where the plane meets the part's surface: the outline of the cut face, drawn like the part's edges. */
  rim: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
  /** The plane, in the part's own frame, the outline was last worked out for; empty for none. */
  rimOf: string
}

/**
 * Where a plane meets a part's surface, as segments (x1 y1 z1 x2 y2 z2 each)
 * in the part's own frame: one for every triangle the plane goes through,
 * found through the part's bounds tree. From the mesh, so as fine as the mesh
 * is; it is drawn, and nothing is told of it. `into` is used when it is long
 * enough; the count is of segments.
 */
export function cutOutline(geometry: THREE.BufferGeometry, plane: THREE.Plane, into?: Float32Array): { segments: Float32Array; count: number } {
  const tree = geometry.boundsTree as MeshBVH | undefined
  let segments = into ?? new Float32Array(6 * 64)
  let count = 0
  if (!tree) return { segments, count }
  const ends = [new THREE.Vector3(), new THREE.Vector3()]
  tree.shapecast({
    intersectsBounds: (box) => plane.intersectsBox(box),
    intersectsTriangle: (triangle) => {
      const corners = [triangle.a, triangle.b, triangle.c]
      const d = corners.map((corner) => plane.distanceToPoint(corner))
      let found = 0
      for (let i = 0; i < 3 && found < 2; i++) {
        const j = (i + 1) % 3
        // An edge that goes through the plane; one that ends on it counts with the side it comes from.
        if (d[i] >= 0 === d[j] >= 0) continue
        ends[found++].lerpVectors(corners[i], corners[j], d[i] / (d[i] - d[j]))
      }
      if (found < 2) return false
      if ((count + 1) * 6 > segments.length) {
        const longer = new Float32Array(segments.length * 2)
        longer.set(segments)
        segments = longer
      }
      ends[0].toArray(segments, count * 6)
      ends[1].toArray(segments, count * 6 + 3)
      count += 1
      return false
    }
  })
  return { segments, count }
}

/**
 * The section through the parts of a viewport: one plane that takes away what
 * is on one side of it. The parts' own materials are clipped by it, and each
 * closed solid gets its cut face drawn in its own colour, a step darker, by
 * counting in the stencil (three.js's stencil caps): per part, so that parts
 * that overlap do not close one another. A part that is not a closed solid (a
 * scan, an open shell) is clipped and shown from both sides, with no cut face.
 *
 * Nothing but the parts and what is highlighted on them is clipped: the marks,
 * the grid and the gizmo are not. The plane is drawn as a hairline rectangle,
 * with a handle while it can be dragged; neither is in a picture.
 */
export class SectionCut {
  /** The rectangle and the handle. Add this to the scene. */
  readonly decor = new THREE.Group()
  /** What a material is clipped by while there is a section. One array, one plane: moving the section changes no material. */
  readonly planes: THREE.Plane[]
  private readonly clip = new THREE.Plane()
  private plane: SectionPlane | null = null
  private box: Box = { min: [0, 0, 0], max: [0, 0, 0] }
  private readonly parts = new Set<BuiltPart>()
  private readonly caps = new Map<BuiltPart, Cap>()
  private readonly looks = new Map<BuiltPart, Look>()
  /** The parts the plane leaves nothing of: not drawn while it is where it is. */
  private readonly gone = new Set<BuiltPart>()
  private readonly frame: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private readonly handle = new THREE.Group()
  private readonly handleMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true })
  private handleShown = false
  private decorShown = true
  private readonly quad = new THREE.Matrix4()
  private readonly centre = new THREE.Vector3()

  /**
   * `others` is told what else is to be clipped by: the planes, or null.
   * `hide` is told of each part whether the section leaves nothing of it, for
   * whatever else is drawn on the part and is to go with it.
   */
  constructor(
    private readonly others: (planes: THREE.Plane[] | null) => void = () => {},
    private readonly hide: (built: BuiltPart, gone: boolean) => void = () => {}
  ) {
    this.planes = [this.clip]
    const corners = new THREE.BufferGeometry()
    corners.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
    this.frame = new THREE.LineLoop(corners, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }))
    this.frame.matrixAutoUpdate = false
    this.frame.frustumCulled = false
    this.frame.renderOrder = 0.9

    // Along +Z from the origin, in pixels: a foot on the plane, a shaft and a head.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(HANDLE.shaftRadius, HANDLE.shaftRadius, HANDLE.shaft, 8).rotateX(Math.PI / 2).translate(0, 0, HANDLE.shaft / 2), this.handleMaterial)
    const head = new THREE.Mesh(new THREE.ConeGeometry(HANDLE.headRadius, HANDLE.head, 20).rotateX(Math.PI / 2).translate(0, 0, HANDLE.shaft + HANDLE.head / 2), this.handleMaterial)
    const foot = new THREE.Mesh(new THREE.SphereGeometry(HANDLE.foot, 16, 10), this.handleMaterial)
    for (const mesh of [shaft, head, foot]) {
      mesh.renderOrder = 30
      mesh.frustumCulled = false
    }
    this.handle.add(shaft, head, foot)
    this.decor.name = 'section'
    this.decor.add(this.frame, this.handle)
    this.decor.visible = false
  }

  get(): SectionPlane | null {
    return this.plane
  }

  /** The plane as what is clipped by it has it: what it keeps is on its positive side. Null for no section. */
  keeps(): THREE.Plane | null {
    return this.plane ? this.clip : null
  }

  /** Cuts by a plane, or by none. `box` is around the parts the plane is drawn across. */
  set(plane: SectionPlane | null, box: Box): void {
    const was = this.plane !== null
    this.plane = plane
    this.box = box
    if (was !== (plane !== null)) {
      for (const built of this.parts) this.clipPart(built)
      this.others(plane ? this.planes : null)
    }
    this.place()
  }

  /** The colours of the rectangle and of the handle. */
  setColours(outline: string, handle: string): void {
    this.frame.material.color.set(outline)
    this.handleMaterial.color.set(handle)
  }

  /** Whether the handle is drawn: while the plane is the pointer's to drag. */
  showHandle(shown: boolean): void {
    this.handleShown = shown
    this.handle.visible = shown
  }

  /** Whether the rectangle and the handle are drawn at all: they are not in a picture. */
  showDecor(shown: boolean): void {
    this.decorShown = shown
    this.decor.visible = shown && this.plane !== null
  }

  /** Keeps the handle the same size on screen: `mmPerPx` gives the millimetres a pixel is at a point. */
  sizeHandle(mmPerPx: (at: THREE.Vector3) => number): void {
    if (!this.plane || !this.handleShown) return
    this.handle.scale.setScalar(mmPerPx(this.centre))
  }

  /** Grows a sphere to hold the rectangle. */
  extend(sphere: THREE.Sphere): THREE.Sphere {
    if (!this.plane) return sphere
    const corner = new THREE.Vector3()
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) sphere.expandByPoint(corner.set(x, y, 0).applyMatrix4(this.quad))
    return sphere
  }

  /** A part is drawn from now on: it is cut like the others, once `set` or `place` has been called with it where it belongs. */
  add(built: BuiltPart): void {
    this.parts.add(built)
    this.clipPart(built)
  }

  /** Whether the plane leaves nothing of a part (`leavesNothing`): it is not drawn, and is not there to be pointed at. */
  removed(built: BuiltPart): boolean {
    return this.gone.has(built)
  }

  /** Of the parts that are drawn (switched on, of the layout shown): how many there are, and of how many the section leaves something. */
  leftToSee(): { shown: number; kept: number } {
    let shown = 0
    let kept = 0
    for (const built of this.parts) {
      if (!built.group.visible) continue
      shown += 1
      if (!this.gone.has(built)) kept += 1
    }
    return { shown, kept }
  }

  /** The handle as it is drawn, from its foot on the plane to its tip, in the object frame; null while it is not drawn. */
  handleSpan(mmPerPx: (at: THREE.Vector3) => number): [THREE.Vector3, THREE.Vector3] | null {
    if (!this.plane || !this.handleShown || !this.decorShown) return null
    const reach = (HANDLE.shaft + HANDLE.head) * mmPerPx(this.centre)
    return [this.centre.clone(), this.centre.clone().addScaledVector(new THREE.Vector3().fromArray(this.plane.normal), reach)]
  }

  /**
   * Works out the outlines of the cut faces that are about to be drawn: of
   * the parts that are, where the plane goes through them, and only when the
   * plane is another than the outline was last worked out for. Call before
   * drawing. Returns how many it worked out.
   */
  outline(): number {
    const plane = this.plane
    if (!plane) return 0
    const n = new THREE.Vector3().fromArray(plane.normal)
    const origin = new THREE.Vector3().fromArray(plane.origin)
    const inverse = new THREE.Matrix4()
    const exact = new THREE.Plane()
    let worked = 0
    for (const [built, cap] of this.caps) {
      if (!built.group.visible || this.gone.has(built)) continue
      // In the part's own frame, like its edges.
      exact.setFromNormalAndCoplanarPoint(n, origin).applyMatrix4(inverse.copy(built.group.matrix).invert())
      const key = `${exact.normal.x},${exact.normal.y},${exact.normal.z},${exact.constant}`
      if (key === cap.rimOf) continue
      cap.rimOf = key
      const geometry = built.mesh.geometry
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      if (!exact.intersectsBox(geometry.boundingBox!)) {
        cap.rim.geometry.setDrawRange(0, 0)
        continue
      }
      worked += 1
      const was = cap.rim.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
      const { segments, count } = cutOutline(geometry, exact, was?.array as Float32Array | undefined)
      if (was?.array === segments) was.needsUpdate = true
      else {
        // Grown: a buffer keeps the length it was made with.
        cap.rim.geometry.dispose()
        cap.rim.geometry = new THREE.BufferGeometry()
        cap.rim.geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3))
      }
      cap.rim.geometry.setDrawRange(0, count * 2)
    }
    return worked
  }

  /** A part is going: what was made for it goes first. */
  forget(built: BuiltPart): void {
    this.parts.delete(built)
    this.looks.delete(built)
    this.gone.delete(built)
    built.mesh.visible = true
    built.edges.visible = true
    const cap = this.caps.get(built)
    if (!cap) return
    this.caps.delete(built)
    for (const mesh of [cap.back, cap.front, cap.face, cap.rim]) {
      built.group.remove(mesh)
      mesh.material.dispose()
    }
    cap.rim.geometry.dispose()
  }

  /** The colour and the opacity a part is drawn in, and the colour of its edges: its cut face and the outline of that follow. */
  look(built: BuiltPart, color: string, opacity: number, edges: string): void {
    const look = { color, opacity, edges }
    this.looks.set(built, look)
    const cap = this.caps.get(built)
    if (cap) lookCap(cap, look)
  }

  /**
   * Brings what is drawn in line with the plane and with where the parts are.
   * Call when a part was moved. The outlines of the cut faces are left for
   * `outline`, which is asked before a frame is drawn.
   */
  place(): void {
    const plane = this.plane
    this.decor.visible = this.decorShown && plane !== null
    this.sortOut()
    if (!plane) return
    const n = new THREE.Vector3().fromArray(plane.normal)
    const origin = new THREE.Vector3().fromArray(plane.origin)
    this.clip.set(n.clone().negate(), n.dot(origin) + KEPT_WITHIN_MM)

    const rect = planeRect(plane, this.box)
    const u = new THREE.Vector3().fromArray(rect.u)
    const v = n.clone().cross(u)
    this.centre.fromArray(rect.centre)
    this.quad.makeBasis(u.clone().multiplyScalar(rect.width), v.clone().multiplyScalar(rect.height), n).setPosition(this.centre)
    this.frame.matrix.copy(this.quad)
    this.handle.position.copy(this.centre)
    this.handle.quaternion.setFromUnitVectors(Z, n)

    const inverse = new THREE.Matrix4()
    // Each part's three passes one after the other, numbered from the parts there are now.
    const step = Math.min(0.0001, (ORDER_UNTIL - ORDER_FROM) / Math.max(this.caps.size * 3, 1))
    let pass = 0
    for (const [built, cap] of this.caps) {
      // The quad is of the object frame, and hangs under the part to be hidden with it.
      cap.face.matrix.copy(inverse.copy(built.group.matrix).invert()).multiply(this.quad)
      for (const mesh of [cap.back, cap.front, cap.face]) mesh.renderOrder = ORDER_FROM + pass++ * step
      // The outline with the cut face: it is of the same pass.
      cap.rim.renderOrder = cap.face.renderOrder
    }
  }

  /**
   * Says of each part whether the plane leaves anything of it, and has those
   * it leaves nothing of not drawn: neither their surface and edges (the
   * sheet of them that lies in the plane) nor a cut face.
   */
  private sortOut(): void {
    const plane = this.plane
    const local = new THREE.Matrix4()
    const point = new THREE.Vector3()
    const normal = new THREE.Vector3()
    for (const built of this.parts) {
      let gone = false
      if (plane) {
        // In the part's own frame, where its box is tight around it.
        built.group.updateMatrix()
        local.copy(built.group.matrix).invert()
        const geometry = built.mesh.geometry
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        const { min, max } = geometry.boundingBox!
        point.fromArray(plane.origin).applyMatrix4(local)
        normal.fromArray(plane.normal).transformDirection(local)
        gone = !geometry.boundingBox!.isEmpty() && leavesNothing({ min: min.toArray(), max: max.toArray() }, { origin: point.toArray(), normal: normal.toArray() })
      }
      if (gone !== this.gone.has(built)) this.hide(built, gone)
      if (gone) this.gone.add(built)
      else this.gone.delete(built)
      built.mesh.visible = !gone
      built.edges.visible = !gone
      const cap = this.caps.get(built)
      if (cap) for (const mesh of [cap.back, cap.front, cap.face, cap.rim]) mesh.visible = plane !== null && !gone
    }
  }

  dispose(): void {
    for (const built of [...this.parts]) this.forget(built)
    this.frame.geometry.dispose()
    this.frame.material.dispose()
    for (const child of this.handle.children) (child as THREE.Mesh).geometry.dispose()
    this.handleMaterial.dispose()
  }

  /** Has a part's materials clipped, or not, and makes its cut face the first time there is a section. */
  private clipPart(built: BuiltPart): void {
    const planes = this.plane ? this.planes : null
    built.mesh.material.clippingPlanes = planes
    built.edges.material.clippingPlanes = planes
    // A part that is no closed solid has no cut face: its inside is shown instead of nothing.
    const side = planes && !built.solid ? THREE.DoubleSide : THREE.FrontSide
    if (built.mesh.material.side !== side) {
      built.mesh.material.side = side
      built.mesh.material.needsUpdate = true
    }
    let cap = this.caps.get(built)
    if (planes && !cap && built.solid) {
      cap = this.makeCap(built)
      this.caps.set(built, cap)
      const look = this.looks.get(built)
      if (look) lookCap(cap, look)
    }
  }

  private makeCap(built: BuiltPart): Cap {
    const count = (side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        side,
        clippingPlanes: this.planes,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op
      })
    const back = new THREE.Mesh(built.mesh.geometry, count(THREE.BackSide, THREE.IncrementWrapStencilOp))
    const front = new THREE.Mesh(built.mesh.geometry, count(THREE.FrontSide, THREE.DecrementWrapStencilOp))
    const face = new THREE.Mesh(
      UNIT_QUAD,
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        // Pushed back like the parts' own surfaces, so the outline drawn on it wins the depth test.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        // Whatever it covers is zero again for the next part.
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp
      })
    )
    face.matrixAutoUpdate = false
    // A part that is not closed after all leaves counts where the quad does not reach: none is left for the next part.
    face.onAfterRender = (renderer) => renderer.clearStencil()
    const rim = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
    rim.geometry.setDrawRange(0, 0)
    // Their place in the order of drawing is given by `place`.
    for (const mesh of [back, front, face, rim]) {
      mesh.frustumCulled = false
      mesh.raycast = () => {} // never picked: a cut face is no face of the model
      built.group.add(mesh)
    }
    return { back, front, face, rim, rimOf: '' }
  }
}

const Z = new THREE.Vector3(0, 0, 1)

interface Look {
  color: string
  opacity: number
  edges: string
}

/** A see-through part has a see-through cut face, drawn among the see-through things, and its counting with it. */
function lookCap(cap: Cap, look: Look): void {
  const transparent = look.opacity < 1
  cap.face.material.color.set(capColour(look.color))
  cap.rim.material.color.set(look.edges)
  for (const material of [cap.back.material, cap.front.material, cap.face.material, cap.rim.material]) {
    if (material.transparent !== transparent) material.needsUpdate = true
    material.transparent = transparent
    material.opacity = look.opacity
  }
  cap.face.material.depthWrite = !transparent
  cap.rim.material.depthWrite = !transparent
}

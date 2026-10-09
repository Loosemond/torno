import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { type Mark, type ShapeKind, type ShapeMark, type StrokeMark, type Vec3, MIN_SHAPE_SIZE } from '../../../shared/marks'

/** The colours marks are drawn in: by author, and the grey of a shape that is only a reference. */
export interface MarkColours {
  user: string
  agent: string
  reference: string
}

// Sizes on screen, in pixels: these hold whatever the zoom.
export const DOT_PX = 3
/** How far a pin's leader stands off the surface, to where its label hangs. */
export const LEADER_PX = 20
const HEAD_LENGTH_PX = 16
const HEAD_RADIUS_PX = 5.5
const STROKE_PX = 2.5
const LEADER_LINE_PX = 1.25
const OUTLINE_PX = 1.5
const DASH_PX = { remove: [7, 4], 'keep-out': [2, 4] } as const
/** How much wider the lines of the active mark are. */
const ACTIVE_WIDTH = 1.5

const FILL_OPACITY = 0.25
/** What is left of a mark where a part is in front of it. */
export const BEHIND = 0.35
const PLANE_OPACITY = 0.1
/** How far the rectangle of a stroke's plane reaches past the stroke, as a share of the stroke's size. */
const PLANE_MARGIN = 0.15

/**
 * The size a shape takes when `wanted` is asked of it, having been `from`:
 * always millimetres a shape of its kind can have. No axis is under 0.1 mm; a
 * cylinder's two diameters are equal and a sphere's three, following whichever
 * of them was changed; a plane has no thickness. Where `wanted` is no number,
 * the size stays what it was.
 */
export function fitSize(kind: ShapeKind, wanted: Vec3, from: Vec3): Vec3 {
  const size = wanted.map((mm, i) => (Number.isFinite(mm) ? Math.max(mm, MIN_SHAPE_SIZE) : from[i])) as Vec3
  // The diameter that was changed, or the first when none was.
  const changed = (axes: number[]): number => size[axes.find((i) => size[i] !== from[i]) ?? axes[0]]
  switch (kind) {
    case 'box':
      return size
    case 'cylinder': {
      const diameter = changed([0, 1])
      return [diameter, diameter, size[2]]
    }
    case 'sphere': {
      const diameter = changed([0, 1, 2])
      return [diameter, diameter, diameter]
    }
    case 'plane':
      return [size[0], size[1], 0]
  }
}

/** After the parts and what is highlighted on them. */
const ORDER = 20

const UNIT_SPHERE = new THREE.SphereGeometry(1, 20, 14)
// Tip at the origin, pointing along +Z, one unit long and one unit in radius.
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 20).rotateX(Math.PI / 2).translate(0, 0, -0.5)

/** What `rescale` reads from the root of a mark's objects. */
interface Sizing {
  /** Groups kept the same size on screen: scaled by the millimetres a pixel is at their place. */
  constant: Array<{ object: THREE.Object3D; at: THREE.Vector3 }>
  /** Line materials, with their width in pixels. */
  lines: Array<{ material: LineMaterial; width: number }>
  /** Dashed ones: dash and gap in pixels, measured where the mark is. */
  dashes: Array<{ material: LineMaterial; dash: number; gap: number; at: THREE.Vector3 }>
  active: boolean
}

/** Collects what a mark is made of while it is built. */
class Parts {
  readonly root = new THREE.Group()
  readonly sizing: Sizing = { constant: [], lines: [], dashes: [], active: false }

  constructor(readonly color: string) {}

  /**
   * One thing drawn twice: where nothing is in front of it, as it is; where a
   * part is, at `BEHIND` of its opacity. Neither writes depth, and both are
   * pulled towards the viewer by the same hair, so what lies on a surface
   * counts as in front of it and every pixel is drawn by exactly one of them.
   */
  private twin<M extends THREE.Material>(name: string, material: M, make: (material: M) => THREE.Object3D): THREE.Group {
    const group = new THREE.Group()
    group.name = name
    const behind = material.clone() as M
    behind.opacity = material.opacity * BEHIND
    behind.depthFunc = THREE.GreaterDepth
    for (const [m, order] of [[behind, ORDER], [material, ORDER + 1]] as const) {
      m.transparent = true
      m.depthWrite = false
      m.polygonOffset = true
      m.polygonOffsetFactor = -2
      m.polygonOffsetUnits = -8
      const object = make(m)
      object.renderOrder = order
      object.raycast = () => {} // never picked
      group.add(object)
    }
    return group
  }

  mesh(name: string, geometry: THREE.BufferGeometry, opts: { opacity?: number; side?: THREE.Side; color?: string } = {}): THREE.Group {
    const material = new THREE.MeshBasicMaterial({ color: opts.color ?? this.color, opacity: opts.opacity ?? 1, side: opts.side ?? THREE.FrontSide })
    return this.twin(name, material, (m) => new THREE.Mesh(geometry, m))
  }

  private lineMaterial(width: number, dashed?: { dash: number; gap: number; at: THREE.Vector3 }): { material: LineMaterial; register: (twinOf: THREE.Group) => void } {
    const material = new LineMaterial({ color: this.color, linewidth: width, dashed: dashed !== undefined })
    return {
      material,
      register: (group) => {
        for (const child of group.children) {
          const m = (child as Line2).material
          this.sizing.lines.push({ material: m, width })
          if (dashed) this.sizing.dashes.push({ material: m, ...dashed })
        }
      }
    }
  }

  /** A line through points, of a width in pixels. */
  line(name: string, points: Vec3[], width: number): THREE.Group {
    const geometry = new LineGeometry().setPositions(points.flat())
    const { material, register } = this.lineMaterial(width)
    const group = this.twin(name, material, (m) => new Line2(geometry, m))
    register(group)
    return group
  }

  /** Separate segments, given as pairs of points, of a width in pixels; dashed when asked. */
  segments(name: string, positions: number[], width: number, dashed?: { dash: number; gap: number; at: THREE.Vector3 }): THREE.Group {
    const geometry = new LineSegmentsGeometry().setPositions(positions)
    const { material, register } = this.lineMaterial(width, dashed)
    const group = this.twin(name, material, (m) => {
      const lines = new LineSegments2(geometry, m)
      if (dashed) lines.computeLineDistances()
      return lines
    })
    register(group)
    return group
  }

  /** A group at a point whose contents are sized in pixels. */
  constant(at: Vec3, ...children: THREE.Object3D[]): THREE.Group {
    const group = new THREE.Group()
    group.position.fromArray(at)
    group.add(...children)
    this.sizing.constant.push({ object: group, at: group.position })
    return group
  }

  dot(at: Vec3, radius = DOT_PX): THREE.Group {
    const ball = this.mesh('', UNIT_SPHERE)
    ball.scale.setScalar(radius)
    const group = this.constant(at, ball)
    group.name = 'dot'
    return group
  }
}

/**
 * The points of a stroke in the object frame: its own on a surface, or those
 * of its plane, `origin + x·u + y·v`.
 */
export function strokePoints(mark: StrokeMark): Vec3[] {
  if (mark.space === 'surface') return mark.points ?? []
  const plane = mark.plane
  if (!plane) return []
  return (mark.points2d ?? []).map(([u, v]) => plane.origin.map((o, i) => o + plane.x[i] * u + plane.y[i] * v) as Vec3)
}

/** The corner of a shape its label hangs from, or its top: in the object frame. */
export function shapeLabelPoint(mark: ShapeMark): Vec3 {
  const [x, y, z] = mark.size
  const local = mark.shape === 'box' || mark.shape === 'plane' ? new THREE.Vector3(x / 2, y / 2, z / 2) : new THREE.Vector3(0, 0, z / 2)
  return local.applyQuaternion(quaternionOf(mark)).add(new THREE.Vector3().fromArray(mark.position)).toArray()
}

/**
 * Where a mark's label hangs, in the object frame, and for a pin the direction
 * its leader stands off the surface: the label is at the end of that.
 */
export function labelAnchor(mark: Mark): { point: Vec3; leader?: Vec3 } {
  switch (mark.kind) {
    case 'pin':
      return { point: mark.anchor.point, leader: unit(mark.anchor.normal) }
    case 'pick':
      return { point: mark.anchor.point }
    case 'arrow':
      return { point: mark.from.point }
    case 'stroke':
      return { point: strokePoints(mark)[0] ?? mark.anchor.point }
    case 'shape':
      return { point: shapeLabelPoint(mark) }
  }
}

/** Points that bound what is drawn of a mark, in the object frame: what the camera's clip planes must keep in. */
export function markPoints(mark: Mark): Vec3[] {
  switch (mark.kind) {
    case 'pin':
    case 'pick':
      return [mark.anchor.point]
    case 'arrow':
      return [mark.from.point, mark.to]
    case 'stroke':
      return [mark.anchor.point, ...strokePoints(mark)]
    case 'shape': {
      const q = quaternionOf(mark)
      const centre = new THREE.Vector3().fromArray(mark.position)
      const half = mark.size.map((s) => s / 2)
      const corners: Vec3[] = []
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(new THREE.Vector3(sx * half[0], sy * half[1], sz * half[2]).applyQuaternion(q).add(centre).toArray())
      return corners
    }
  }
}

/**
 * The three.js objects of one mark, in the object frame. A pick's face or edge
 * is not here: it is tinted on the part itself. `scale` is the millimetres a
 * pixel is where the mark is, until `rescale` says better.
 *
 * Children by name. pin: `dot`, `leader`. pick: `dot`. arrow: `tail`, `shaft`,
 * `head`. stroke: `line` (a `dot` for a single point), and `plane` for one
 * drawn on a plane, shown while the mark is the active one. shape: `fill`,
 * `outline`.
 */
export function build(mark: Mark, colours: MarkColours, scale: number): THREE.Object3D {
  const reference = mark.kind === 'shape' && mark.intent === 'reference'
  const parts = new Parts(reference ? colours.reference : colours[mark.author])
  const { root } = parts
  root.name = mark.id
  root.userData.sizing = parts.sizing

  switch (mark.kind) {
    case 'pin': {
      const leader = parts.constant(mark.anchor.point, parts.line('', [[0, 0, 0], scaled(unit(mark.anchor.normal), LEADER_PX)], LEADER_LINE_PX))
      leader.name = 'leader'
      root.add(parts.dot(mark.anchor.point), leader)
      break
    }
    case 'pick':
      root.add(parts.dot(mark.anchor.point, DOT_PX - 0.5))
      break
    case 'arrow': {
      const from = new THREE.Vector3().fromArray(mark.from.point)
      const to = new THREE.Vector3().fromArray(mark.to)
      const tail = parts.dot(mark.from.point, DOT_PX - 0.5)
      tail.name = 'tail'
      const cone = parts.mesh('', UNIT_CONE)
      cone.scale.set(HEAD_RADIUS_PX, HEAD_RADIUS_PX, HEAD_LENGTH_PX)
      const head = parts.constant(mark.to, cone)
      head.name = 'head'
      const along = to.clone().sub(from)
      if (along.lengthSq() > 0) head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along.normalize())
      root.add(tail, parts.line('shaft', [mark.from.point, mark.to], STROKE_PX), head)
      break
    }
    case 'stroke': {
      const points = strokePoints(mark)
      if (points.length >= 2) root.add(parts.line('line', points, STROKE_PX))
      else root.add(parts.dot(points[0] ?? mark.anchor.point))
      if (mark.space === 'plane' && mark.plane) {
        const plane = strokePlane(parts, mark)
        plane.visible = false
        root.add(plane)
      }
      break
    }
    case 'shape':
      addShape(parts, mark)
      break
  }
  rescale(root, () => scale, 1)
  return root
}

/** The plane a stroke was drawn on: a rectangle around the stroke, in the plane's own axes. */
function strokePlane(parts: Parts, mark: StrokeMark): THREE.Group {
  const plane = mark.plane!
  const points = mark.points2d ?? []
  const us = points.map((p) => p[0])
  const vs = points.map((p) => p[1])
  const [u0, u1, v0, v1] = points.length > 0 ? [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)] : [0, 0, 0, 0]
  const margin = Math.max((u1 - u0) * PLANE_MARGIN, (v1 - v0) * PLANE_MARGIN, 2)
  const at = (u: number, v: number): Vec3 => plane.origin.map((o, i) => o + plane.x[i] * u + plane.y[i] * v) as Vec3
  const corners = [at(u0 - margin, v0 - margin), at(u1 + margin, v0 - margin), at(u1 + margin, v1 + margin), at(u0 - margin, v1 + margin)]

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const group = new THREE.Group()
  group.name = 'plane'
  group.add(parts.mesh('', geometry, { opacity: PLANE_OPACITY, side: THREE.DoubleSide }), parts.line('', [...corners, corners[0]], 1))
  return group
}

function addShape(parts: Parts, mark: ShapeMark): void {
  const [x, y, z] = mark.size
  const body = new THREE.Group()
  body.position.fromArray(mark.position)
  body.quaternion.copy(quaternionOf(mark))

  let geometry: THREE.BufferGeometry
  let outline: number[]
  switch (mark.shape) {
    case 'box': {
      geometry = new THREE.BoxGeometry(x, y, z)
      const edges = new THREE.EdgesGeometry(geometry)
      outline = [...edges.getAttribute('position').array]
      edges.dispose()
      break
    }
    case 'cylinder': {
      // Its axis is the shape's own Z.
      geometry = new THREE.CylinderGeometry(x / 2, x / 2, z, 48).rotateX(Math.PI / 2)
      const top = circle(x / 2, 'z').map((p, i) => (i % 3 === 2 ? z / 2 : p))
      outline = [...top, ...top.map((p, i) => (i % 3 === 2 ? -z / 2 : p))]
      for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) outline.push((sx * x) / 2, (sy * x) / 2, -z / 2, (sx * x) / 2, (sy * x) / 2, z / 2)
      break
    }
    case 'sphere':
      geometry = new THREE.SphereGeometry(x / 2, 40, 24)
      outline = [...circle(x / 2, 'x'), ...circle(x / 2, 'y'), ...circle(x / 2, 'z')]
      break
    case 'plane':
      geometry = new THREE.PlaneGeometry(x, y)
      outline = [-x, -y, x, -y, x, -y, x, y, x, y, -x, y, -x, y, -x, -y].flatMap((value, i) => (i % 2 === 0 ? [value / 2] : [value / 2, 0]))
      break
  }

  const dash = mark.intent === 'remove' || mark.intent === 'keep-out' ? DASH_PX[mark.intent] : undefined
  body.add(
    parts.mesh('fill', geometry, { opacity: FILL_OPACITY, side: mark.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide }),
    parts.segments('outline', outline, OUTLINE_PX, dash && { dash: dash[0], gap: dash[1], at: body.position })
  )
  parts.root.add(body)
}

/**
 * Brings what is sized in pixels in line with a view: `mmPerPx` says how many
 * millimetres a pixel is at a point, `unit` how many of the picture's pixels a
 * nominal one is (1 on screen; more in a large picture, so marks keep their
 * share of it).
 */
export function rescale(object: THREE.Object3D, mmPerPx: (at: THREE.Vector3) => number, unit: number): void {
  const sizing = object.userData.sizing as Sizing | undefined
  if (!sizing) return
  for (const { object: group, at } of sizing.constant) group.scale.setScalar(mmPerPx(at) * unit)
  const wider = sizing.active ? ACTIVE_WIDTH : 1
  for (const { material, width } of sizing.lines) material.linewidth = width * wider * unit
  for (const { material, dash, gap, at } of sizing.dashes) {
    // Line distances are in millimetres; the dashes are wanted in pixels.
    material.dashScale = 1 / (mmPerPx(at) * unit)
    material.dashSize = dash
    material.gapSize = gap
  }
}

/** Whether the mark is the one being worked on: its lines are drawn wider, and a stroke shows its plane. Takes effect at the next `rescale`. */
export function setActive(object: THREE.Object3D, active: boolean): void {
  const sizing = object.userData.sizing as Sizing | undefined
  if (sizing) sizing.active = active
  const plane = object.getObjectByName('plane')
  if (plane) plane.visible = active
}

/** Frees what `build` made. */
export function dispose(object: THREE.Object3D): void {
  object.traverse((child) => {
    const drawn = child as THREE.Mesh
    if (!drawn.geometry) return
    if (drawn.geometry !== UNIT_SPHERE && drawn.geometry !== UNIT_CONE) drawn.geometry.dispose()
    ;(drawn.material as THREE.Material).dispose()
  })
}

/** A circle about an axis as line segments, 64 of them. */
function circle(radius: number, axis: 'x' | 'y' | 'z'): number[] {
  const out: number[] = []
  const at = (i: number): Vec3 => {
    const a = (i / 64) * Math.PI * 2
    const [c, s] = [Math.cos(a) * radius, Math.sin(a) * radius]
    return axis === 'x' ? [0, c, s] : axis === 'y' ? [c, 0, s] : [c, s, 0]
  }
  for (let i = 0; i < 64; i++) out.push(...at(i), ...at(i + 1))
  return out
}

/** A shape's rotation; one that is no rotation at all (all zeros) turns nothing. */
function quaternionOf(mark: ShapeMark): THREE.Quaternion {
  const q = new THREE.Quaternion().fromArray(mark.rotation)
  return q.lengthSq() > 0 ? q.normalize() : q.identity()
}

/** A direction of length one; straight up for none. */
function unit(v: Vec3 | undefined): Vec3 {
  const length = v ? Math.hypot(...v) : 0
  return v && length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1]
}

function scaled(v: Vec3, by: number): Vec3 {
  return [v[0] * by, v[1] * by, v[2] * by]
}

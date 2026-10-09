type Vec3 = [number, number, number]

/**
 * What the kernel says of a part, a face or an edge: its `describe` reply
 * (`kernel/src/torno_kernel/queries.py`). Lengths are millimetres, positions
 * and directions are in the object frame. `key` and `ref` are as asked on the
 * wire, with the layout in front: `assembly:lid`, `assembly:lid/F12`.
 */
export type Described = DescribedPart | DescribedFace | DescribedEdge

export interface DescribedPart {
  kind: 'part'
  key: string
  bbox: { min: Vec3; max: Vec3 }
  volume: number
  area: number
  faceCount: number
  edgeCount: number
  valid: boolean
  descriptor: string       // "part, 40 × 30 × 5 mm, 6000 mm³, 6 faces"
}

export interface DescribedFace {
  kind: 'face'
  ref: string
  type: string             // "plane", "cylinder", ...
  area: number
  center: Vec3
  normal: Vec3 | null      // at `center`; null where the surface has none
  radius: number | null    // of a cylinder or a sphere
  descriptor: string       // "plane, normal +Z, z = 20, 1180 mm²"
}

export interface DescribedEdge {
  kind: 'edge'
  ref: string
  type: string             // "line", "circle", ...
  length: number
  center: Vec3
  descriptor: string       // "circle, radius 4, 25.13 mm"
}

/** One end of a measurement, as the window names it: a ref of the layout (`lid`, `lid/F12`, `lid/E3`), a point of it, or both: the feature the ref names, measured at or near the point. */
export interface MeasureTarget {
  ref?: string
  point?: Vec3
}

/**
 * What `measure` is asked: the kind, the layout the ends are in, the end `a`
 * and, for a distance or an angle, `b`; for a mass, a density in g/cm³.
 */
export interface MeasureArgs {
  kind: 'distance' | 'angle' | 'radius' | 'diameter' | 'thickness' | 'bbox' | 'volume' | 'area' | 'mass'
  layout: string
  a: MeasureTarget
  b?: MeasureTarget
  density?: number
}

/**
 * What the kernel measured, exactly, on the B-rep
 * (`kernel/src/torno_kernel/measure.py`): a value with its unit and how it
 * was taken, between which points when it has two, or a box.
 */
export type Measured = MeasuredValue | MeasuredBox

export interface MeasuredValue {
  kind: Exclude<MeasureArgs['kind'], 'bbox'>
  value: number
  unit: 'mm' | 'deg' | 'mm2' | 'mm3' | 'g'
  how: string              // "between planes", "axis to axis", "minimum", "wall, along the normal", ...
  points?: [Vec3, Vec3]
  exact: boolean
  /** Of a mass: the density it was worked out with, g/cm³, and the volume, mm³. */
  density?: number
  volume?: number
  /** Of the tube of a torus: the radius of the ring it runs round. */
  major?: number
  /** Of a wall's thickness: how far the point given was from the face it was laid on, mm. */
  moved?: number
}

export interface MeasuredBox {
  kind: 'bbox'
  min: Vec3
  max: Vec3
  size: Vec3
  unit: 'mm'
  how: string
  exact: boolean           // false on faces that are neither flat nor cylinders
}

/**
 * What a plane cuts of the parts of a layout, exactly, from the B-rep: the
 * kernel's `section` reply (`kernel/src/torno_kernel/section.py`). A point
 * `[u, v]` of a loop is `origin + u·x + v·y` in the frame of the layout.
 */
export interface Sectioned {
  plane: { origin: Vec3; normal: Vec3; x: Vec3; y: Vec3 }
  parts: SectionedPart[]
  /** The box of every point, in `[u, v]`; null when nothing is cut. */
  bounds: { min: [number, number]; max: [number, number] } | null
}

export interface SectionedPart {
  part: string
  /** Closed loops largest first, open ones after them. */
  loops: SectionLoop[]
  /** mm²; null of a part that is no solid and gave loops that are not closed. */
  area: number | null
  areaExact: boolean
  /** How many of its loops are not closed: none of a solid. */
  open: number
  how: string              // "cross-section of the solid", "outline of the surface: the part is not a solid", ...
}

export interface SectionLoop {
  /** mm along the plane's `x` and `y`. A closed loop's last point joins its first, which is not told twice. */
  points: [number, number][]
  closed: boolean
  /** Positive round material, negative round a hole in it, null of a loop that is not closed. */
  area: number | null
  areaExact: boolean
  /** How far the points may stray from the true outline, mm. */
  deflection: number
}

/** What the kernel's `check` says (`kernel/src/torno_kernel/checks.py`). */
export interface CheckedOverlap { volume: number; bbox: { min: Vec3; max: Vec3 } | null }
export interface CheckedClearance { distance: number; points: [Vec3, Vec3]; overlapping: boolean | null; how: string }
export interface CheckedMesh { watertight: boolean; openEdges: number; where: Vec3[]; triangles: number }

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

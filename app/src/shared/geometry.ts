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

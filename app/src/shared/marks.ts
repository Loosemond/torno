import type { Camera } from './view'
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]            // x y z w

export interface Anchor {
  point: Vec3
  normal?: Vec3
  part?: string            // part name; absent for a point in empty space
  ref?: string             // `lid` | `lid/F12` | `lid/E3`, refreshed after each build
  descriptor?: string      // from the kernel: "plane, normal +Z, z = 20, 1180 mm²"
}
export type MarkStatus = 'draft' | 'sent' | 'resolved'
export type AnchorState = 'ok' | 'drifted' | 'orphaned'
export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'plane'
export type ShapeIntent = 'add' | 'remove' | 'keep-out' | 'reference'

interface MarkBase {
  id: string               // 'M3'
  author: 'user' | 'agent'
  note: string
  status: MarkStatus
  anchorState: AnchorState
  layout: string
  revision: number         // build it was placed on
  camera: Camera           // the view it was placed from
  createdAt: string        // ISO
  resolvedNote?: string
}
export interface PinMark extends MarkBase { kind: 'pin'; anchor: Anchor }
export interface PickMark extends MarkBase { kind: 'pick'; target: 'face' | 'edge' | 'part'; anchor: Anchor }
export interface ArrowMark extends MarkBase { kind: 'arrow'; from: Anchor; to: Vec3 }
export interface StrokeMark extends MarkBase {
  kind: 'stroke'
  space: 'surface' | 'plane'
  anchor: Anchor                                         // first point
  points?: Vec3[]                                        // surface strokes
  plane?: { origin: Vec3; x: Vec3; y: Vec3; label: string }   // label: "XZ at y = 40.0"
  points2d?: [number, number][]                          // plane strokes, mm in plane axes
}
export interface ShapeMark extends MarkBase {
  kind: 'shape'
  shape: ShapeKind
  intent: ShapeIntent
  position: Vec3
  rotation: Quat
  size: Vec3               // box: x y z; cylinder: diameter, diameter, height; sphere: diameter ×3; plane: width, height, 0
  anchor?: Anchor          // where it was first placed
}
export type Mark = PinMark | PickMark | ArrowMark | StrokeMark | ShapeMark
export type MarkKind = Mark['kind']
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** What a caller supplies; main adds id, status, anchorState, createdAt. */
export type NewMark = DistributiveOmit<Mark, 'id' | 'status' | 'anchorState' | 'createdAt'>
export type MarkPatch = Partial<Pick<MarkBase, 'note' | 'status' | 'resolvedNote'>> &
  Partial<Pick<ShapeMark, 'intent' | 'position' | 'rotation' | 'size' | 'shape'>>
export interface MarksFile { next: number; marks: Mark[] }

/** The anchors a mark carries: where it is tied to the geometry. A shape placed in empty space has none. */
export function markAnchors(mark: Mark): Anchor[] {
  switch (mark.kind) {
    case 'pin':
    case 'pick':
    case 'stroke':
      return [mark.anchor]
    case 'arrow':
      return [mark.from]
    case 'shape':
      return mark.anchor ? [mark.anchor] : []
  }
}

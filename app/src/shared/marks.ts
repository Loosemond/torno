import type { Camera } from './view'
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]            // x y z w

export interface Anchor {
  point: Vec3
  normal?: Vec3
  part?: string            // part name; absent for a point in empty space
  ref?: string             // `lid` | `lid/F12` | `lid/E3`, refreshed after each build
  descriptor?: string      // from the kernel: "plane, normal +Z, z = 20, 1180 mm²"
  /**
   * How far its part had been spread for display (`Part.arranged`) on the build
   * the anchor was placed on or last checked against: zeros for a part that
   * was not moved. Main sets it. When a later build spreads the part
   * otherwise, the mark is moved by the difference, so it stays where it was
   * put on the part. Absent: never recorded (a mark from before this was
   * kept, or one on no part), and the next check records it without moving
   * the mark.
   */
  arranged?: Vec3
  /** The edge the point is on, when it is on one: `lid/E40`. Then `ref` is that edge too. */
  edge?: string
  /** The two faces that meet at `edge`: `['lid/F12', 'lid/F40']`. */
  between?: [string, string]
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
  /** Who resolved it. Set by main, on a mark that is resolved. */
  resolvedBy?: 'user' | 'agent'
  /** The person has seen that the agent resolved it. Only ever true, on a mark the agent resolved. */
  acknowledged?: boolean
  /** It has been given to the agent with a prompt at least once. Set by main; only ever true. */
  sentBefore?: boolean
  /**
   * The revision of the last build its anchors were checked against. Set by
   * main. Absent: not checked in this run of torno. Revisions count from 1
   * each time an object is opened, so what a file says of an earlier run is
   * dropped when it is read.
   */
  checkedRevision?: number
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
/** What main alone says of a mark: no caller supplies these. */
export const MAIN_ONLY_KEYS = ['resolvedBy', 'acknowledged', 'sentBefore', 'checkedRevision'] as const
/** What a caller supplies; main adds id, status, anchorState, createdAt, and what only it says. */
export type NewMark = DistributiveOmit<Mark, 'id' | 'status' | 'anchorState' | 'createdAt' | (typeof MAIN_ONLY_KEYS)[number]>
/** `acknowledged` may only be set, and only on a mark the agent resolved. */
export type MarkPatch = Partial<Pick<MarkBase, 'note' | 'status' | 'resolvedNote' | 'acknowledged'>> &
  Partial<Pick<ShapeMark, 'intent' | 'position' | 'rotation' | 'size' | 'shape'>>
export interface MarksFile { next: number; marks: Mark[] }
/** Where a mark is put again, by a click on a part: the anchor found there, on which build and from which view. */
export interface Replacement { anchor: Anchor; revision: number; camera: Camera }

/** The least a side, a diameter or a height of a shape can be, in millimetres: main holds a size to it, and the gizmo and the fields stop there. */
export const MIN_SHAPE_SIZE = 0.1

/** The most points a stroke keeps. Main cuts a longer one there; whoever draws one sends no more. */
export const MAX_STROKE_POINTS = 400

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

/** The most points of a surface stroke that are checked against a build, besides its first. */
export const STROKE_SAMPLES = 8

/**
 * Points of a surface stroke after its first, evenly spaced along its list and
 * ending with its last: at most `most`. The first is the stroke's anchor, and
 * is checked as such. None for any other mark: a profile on a plane lies on
 * nothing.
 */
export function strokeSamples(mark: Mark, most = STROKE_SAMPLES): Vec3[] {
  if (mark.kind !== 'stroke' || mark.space !== 'surface') return []
  const rest = (mark.points ?? []).slice(1)
  if (rest.length <= most) return rest
  return Array.from({ length: most }, (_, i) => rest[Math.round(((i + 1) * rest.length) / most) - 1])
}

/**
 * Whether nothing has checked an open mark against the build there is: its
 * ref and descriptor are then of an older build, or of whoever placed it.
 * `revision` is that of the last build that worked; with none, nothing is unchecked.
 */
export function isUnchecked(mark: Mark, revision: number | undefined): boolean {
  return mark.status !== 'resolved' && revision !== undefined && revision > 0 && mark.checkedRevision !== revision
}

/** A mark the agent resolved and the person has not yet said they have seen: it stays among the open ones in the panel. */
export function awaitsAcknowledgement(mark: Mark): boolean {
  return mark.status === 'resolved' && mark.resolvedBy === 'agent' && mark.acknowledged !== true
}

const moved = (p: Vec3, by: Vec3): Vec3 => [p[0] + by[0], p[1] + by[1], p[2] + by[2]]

/**
 * A mark with everything it holds in the frame of its layout moved by `by`:
 * its anchor's point, an arrow's end, the points of a stroke on the surface,
 * the origin of a stroke's plane, a shape's position. Used when the part it
 * is on is spread otherwise than it was (`Anchor.arranged`).
 */
export function translated<M extends Mark>(mark: M, by: Vec3): M {
  const at = (anchor: Anchor): Anchor => ({ ...anchor, point: moved(anchor.point, by) })
  const m: Mark = mark
  switch (m.kind) {
    case 'pin':
    case 'pick':
      return { ...m, anchor: at(m.anchor) } as M
    case 'arrow':
      return { ...m, from: at(m.from), to: moved(m.to, by) } as M
    case 'stroke':
      return {
        ...m,
        anchor: at(m.anchor),
        ...(m.points ? { points: m.points.map((p) => moved(p, by)) } : {}),
        ...(m.plane ? { plane: { ...m.plane, origin: moved(m.plane.origin, by) } } : {})
      } as M
    case 'shape':
      return { ...m, position: moved(m.position, by), ...(m.anchor ? { anchor: at(m.anchor) } : {}) } as M
  }
}

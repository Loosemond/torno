import type { Anchor } from '../../shared/marks'
import type { Part } from '../../shared/scene'

const LEAST_TOLERANCE_MM = 0.5
const TOLERANCE_OF_DIAGONAL = 0.005
/**
 * How far from an edge a point may be and still be on it, in mm, whatever the
 * size of the part: edges lie closer to one another than surfaces do (the two
 * of a 1 mm chamfer), and a tolerance that grew with the part would take one
 * for the other.
 */
export const EDGE_TOLERANCE_MM = 0.5

/**
 * How far from the surface of a part an anchor may be and still be on it, in
 * mm: half a percent of the diagonal of the part's bounding box, and never
 * less than half a millimetre.
 */
export function tolerance(bbox: Part['bbox'] | undefined): number {
  if (!bbox) return LEAST_TOLERANCE_MM
  const diagonal = Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2])
  return Math.max(LEAST_TOLERANCE_MM, TOLERANCE_OF_DIAGONAL * diagonal)
}

/** The edge a pin's anchor says it is on: the one it names, or its ref when that is an edge of its part (as the Pin tool leaves it). */
export function edgeOfPin(anchor: Anchor): string | undefined {
  if (anchor.part === undefined) return undefined
  const isEdge = (ref: string | undefined): ref is string => ref !== undefined && ref.startsWith(`${anchor.part}/`) && /^E\d+$/.test(ref.slice(anchor.part!.length + 1))
  return isEdge(anchor.edge) ? anchor.edge : isEdge(anchor.ref) ? anchor.ref : undefined
}

/** What the kernel's `nearest` says of a point that bears on which edge it is on. */
export interface NearEdge {
  /** How far the point is from the surface of its part. */
  distance?: unknown
  support?: unknown
  /** The edge the nearest point of the part lies on, when it lies on one: however far from the point that is. */
  edgeUnder?: unknown
  /** Of the edge the point was asked about with: whether the part has one of that number, and how far the point is from it. */
  edgeFound?: unknown
  edgeDistance?: unknown
}

/**
 * Whether the edge `edge` of a part is under a point, by what `nearest` said
 * of the point; `tolerance` is that of the part's surface (`tolerance`). It
 * is when the point is on the surface and the kernel found it on that very
 * edge, or when it is within `EDGE_TOLERANCE_MM` of the edge of that number.
 *
 * This is the one rule for it: a pin, or an end of a dimension, is judged to
 * be on the edge it names by it (`judgePin`), and a dimension is measured
 * through an edge only by it (`measureDimension`). That the nearest point of
 * the part is on the edge says nothing by itself: it is, however far the
 * edge has moved away.
 */
export function edgeIsUnder(near: NearEdge, edge: string, tolerance: number): boolean {
  const within = (distance: unknown, most: number): boolean => typeof distance === 'number' && distance >= 0 && distance <= most
  if (near.support === 'edge' && near.edgeUnder === edge && within(near.distance, tolerance)) return true
  return near.edgeFound === true && within(near.edgeDistance, EDGE_TOLERANCE_MM)
}

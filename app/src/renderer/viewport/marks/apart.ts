import { type ExplodePart, type ExplodeState, explodeOffsets } from '../../../shared/explode'
import { type Mark, type Vec3, markAnchors, markEndParts } from '../../../shared/marks'

// How a mark is drawn while the parts of its layout are drawn apart (explode). Never the mark: what is kept and
// told of it is where it was put on the parts as built. Only its objects and its label are drawn elsewhere.

/** By part name, how far the part is drawn from where it is. */
export type Offsets = Readonly<Record<string, Vec3>>
/** By part name, the part's box as built: what says which part the head of an arrow points at. */
export type PartBoxes = Readonly<Record<string, { min: Vec3; max: Vec3 }>>

/** Drawn where it is. */
export const STILL: Vec3 = [0, 0, 0]
/** How far each end of a mark is drawn from where it is: one end for most marks; two for a dimension between two ends, and for an arrow whose head is at another part than its foot. */
function endOffsets(mark: Mark, offsets: Offsets, boxes: PartBoxes): Vec3[] {
  return markEndParts(mark, boxes).map((part) => (part !== undefined && offsets[part]) || STILL)
}

/**
 * How a mark is drawn while parts are drawn apart: moved by this much, or `'split'`: its ends are on parts that
 * moved differently, and it is drawn between them where they are drawn (`spanning`), dimmed and dashed. A mark
 * goes with the part its anchor ties it to; a dimension has two ends, and so has an arrow whose head is at
 * another part (`boxes` says which; without them an arrow goes with its foot). A mark on no part, and a region
 * of a scan, do not move: nor does a scan.
 */
export function markOffset(mark: Mark, offsets: Offsets, boxes: PartBoxes = {}): Vec3 | 'split' {
  const moved = endOffsets(mark, offsets, boxes)
  if (moved.length === 0) return STILL
  return moved.every((m) => m.every((c, i) => Math.abs(c - moved[0][i]) < 1e-9)) ? moved[0] : 'split'
}

const plus = (point: Vec3, by: Vec3): Vec3 => [point[0] + by[0], point[1] + by[1], point[2] + by[2]]

/**
 * A mark whose ends moved differently, as it is drawn: each end where its part is drawn. For drawing only: the
 * line it makes is as long as the parts are drawn apart, which is no measure of anything, so it is drawn dashed
 * and dimmed, and the value beside a dimension stays the kernel's, of the parts as built.
 */
export function spanning(mark: Mark, offsets: Offsets, boxes: PartBoxes = {}): Mark {
  const [first, second] = endOffsets(mark, offsets, boxes)
  if (second === undefined) return mark
  if (mark.kind === 'arrow') return { ...mark, from: { ...mark.from, point: plus(mark.from.point, first) }, to: plus(mark.to, second) }
  if (mark.kind !== 'dimension' || !mark.b) return mark
  return { ...mark, a: { ...mark.a, point: plus(mark.a.point, first) }, b: { ...mark.b, point: plus(mark.b.point, second) }, ...(mark.points ? { points: [plus(mark.points[0], first), plus(mark.points[1], second)] as [Vec3, Vec3] } : {}) }
}

/**
 * The marks of a layout that span parts an explode draws apart, by number, in the order of their numbers: those
 * drawn dashed between their parts. Of the marks that are drawn at all: not a resolved one, nor one whose parts
 * are all among `hidden`. Worked out from the parts and the explode alone, so it is the same before the viewport
 * has drawn a frame of it.
 */
export function spanningMarks(marks: readonly Mark[], layout: string, parts: readonly ExplodePart[], explode: ExplodeState | null, hidden: ReadonlySet<string> = new Set()): string[] {
  const offsets = explodeOffsets(parts, explode)
  if (Object.keys(offsets).length === 0) return []
  const boxes = Object.fromEntries(parts.map((part) => [part.name, part.bbox]))
  const drawn = (mark: Mark): boolean => mark.status !== 'resolved' && mark.kind !== 'region' && mark.layout === layout && !markAnchors(mark).every((anchor) => anchor.part !== undefined && hidden.has(anchor.part))
  return marks.filter((mark) => drawn(mark) && markOffset(mark, offsets, boxes) === 'split').map((mark) => mark.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}

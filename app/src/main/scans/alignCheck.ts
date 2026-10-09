import type { Vec3 } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { AlignmentCheck, ScanAlignment } from '../../shared/scans'
import { isBusy } from '../kernel/client'
import { type AskedAnchor, type NearestAnchor, answered } from '../marks/reanchor'
import { tolerance } from '../marks/tolerance'
import type { ScanStore } from './store'

// Whether an alignment still holds after a build. An alignment says where a scan stands in the object frame of
// one layout; a build can move the model out from under it (a face the person clicked is elsewhere) or spread
// the layout's parts otherwise (`Part.arranged`). Nothing is moved or fitted again here: it is found, and said.

/** How far a part may have been spread otherwise and still be where it was, in mm. */
const SPREAD_EPSILON = 1e-6
const NOT_SPREAD: Vec3 = [0, 0, 0]

/** The model points an alignment was tied to, with the part each was clicked on. */
export function anchoredPoints(alignment: ScanAlignment): Array<{ part: string; point: Vec3 }> {
  const points: Array<{ part: string; point: Vec3 }> = []
  for (const pair of alignment.pairs ?? []) if (pair.part !== undefined) points.push({ part: pair.part, point: pair.model })
  if (alignment.floor?.part !== undefined) points.push({ part: alignment.floor.part, point: alignment.floor.point })
  return points
}

/**
 * What a build makes of one alignment. `parts` are those of its layout on that build; `nearest` answers
 * `anchoredPoints`, in order. Pure.
 *
 * `off` counts the points whose part the layout no longer has, or that are further from that part than a
 * mark may be and still be on it (`tolerance`). `moved` names the parts torno spreads otherwise than when it
 * was aligned (`alignment.frame`): of the parts the alignment is tied to, or, for one tied to none (typed,
 * nudged, a floor on the ground), of every part of the layout. A part the frame says nothing of came with a
 * later build: it was never where it is not.
 */
export function judgeAlignment(alignment: ScanAlignment, parts: Part[], nearest: Array<NearestAnchor | undefined>, revision: number): AlignmentCheck {
  const points = anchoredPoints(alignment)
  let off = 0
  let worst = 0
  points.forEach(({ part }, i) => {
    const said = nearest[i]
    const there = parts.find((p) => p.name === part)
    if (!there || !answered(said)) {
      off += 1
      return
    }
    worst = Math.max(worst, said.distance)
    if (said.distance > tolerance(there.bbox)) off += 1
  })
  const tied = new Set(points.map((point) => point.part))
  const moved = parts
    .filter((part) => (tied.size === 0 || tied.has(part.name)) && Object.hasOwn(alignment.frame, part.name))
    .filter((part) => (part.arranged ?? NOT_SPREAD).some((c, axis) => Math.abs(c - alignment.frame[part.name][axis]) > SPREAD_EPSILON))
    .map((part) => part.name)
  return { revision, of: points.length, off, worst, moved }
}

/**
 * The parts an alignment that was just made ties itself to (the pairs of a fit, the face under a floor) which
 * torno moved for display on the build it was made on (`frame`): between such a part and anything else nothing
 * is the model's, so nothing can be aligned to it.
 */
export function tiedToMoved(alignment: Pick<ScanAlignment, 'steps' | 'pairs' | 'floor'>, frame: Record<string, Vec3>): string[] {
  const last = alignment.steps[alignment.steps.length - 1]
  const tied = last === 'pairs' ? (alignment.pairs ?? []).map((pair) => pair.part) : last === 'floor' ? [alignment.floor?.part] : []
  const moved = (part: string | undefined): part is string => part !== undefined && Object.hasOwn(frame, part) && frame[part].some((c) => Math.abs(c) > SPREAD_EPSILON)
  return [...new Set(tied.filter(moved))]
}

export interface AlignCheckDeps {
  scans: Pick<ScanStore, 'list' | 'checked'>
  /** The last successful build of an object: a new one has another scene. */
  scene(objectId: string): { revision: number; scene: Scene } | undefined
  /** What the kernel says of each anchor, in order; rejects when it could not be asked. */
  nearest(objectId: string, layout: string, anchors: AskedAnchor[]): Promise<NearestAnchor[]>
}

/**
 * Checks every alignment of an object's scans against its last build: for each alignment of a layout that
 * build has, one `nearest` query for the model points it is tied to (none when it is tied to none), and what
 * `judgeAlignment` makes of it is kept (`ScanStore.checked`). False when the kernel could not be asked of some,
 * or could say nothing of a point, `'busy'` when that was because it is busy: to be tried again (`retrying`),
 * and nothing is kept of those meanwhile. When a newer build lands while it runs, what was found is dropped:
 * that build has its own check.
 */
export async function checkAlignments(deps: AlignCheckDeps, objectId: string): Promise<boolean | 'busy'> {
  const last = deps.scene(objectId)
  if (!last) return true
  const { scene, revision } = last
  const superseded = (): boolean => deps.scene(objectId)?.scene !== scene
  let scans: Awaited<ReturnType<ScanStore['list']>>
  try {
    scans = await deps.scans.list(objectId)
  } catch {
    return false
  }
  let went: boolean | 'busy' = true
  for (const scan of scans) {
    for (const [layout, alignment] of Object.entries(scan.alignments)) {
      if (!scene.layouts.includes(layout)) continue
      const points = anchoredPoints(alignment)
      let nearest: NearestAnchor[] = []
      if (points.length > 0) {
        try {
          nearest = await deps.nearest(objectId, layout, points)
        } catch (e) {
          if (superseded()) return true
          went = isBusy(e) ? 'busy' : went === 'busy' ? 'busy' : false
          continue
        }
        // The part is there and the kernel could say nothing of a point: not "off", not known.
        if (nearest.length !== points.length || nearest.some((one) => one?.found === true && !answered(one))) {
          if (went === true) went = false
          continue
        }
      }
      if (superseded()) return true
      await deps.scans.checked(objectId, scan.id, layout, judgeAlignment(alignment, scene.parts.filter((part) => part.layout === layout), nearest, revision)).catch(() => {})
    }
  }
  return went
}

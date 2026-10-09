import type { Vec3 } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import { type AlignmentCheck, type ScanAlignment, type ScanInfo, standingOf } from '../../shared/scans'
import { NOT_HELD } from '../builds'
import { KernelError, isBusy } from '../kernel/client'
import { type AskedAnchor, type NearestAnchor, type Retrying, answered, nearestReply, retrying } from '../marks/reanchor'
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
 * later build: it was never where it is not. An alignment the person confirmed (`confirmed.held`) is judged
 * by how far the model has moved from where it was under each point then: what was confirmed is not raised
 * again, and the model moving since is, whichever way (back under the point too). `worst` is then that move.
 */
export function judgeAlignment(alignment: ScanAlignment, parts: Part[], nearest: Array<NearestAnchor | undefined>, revision: number): AlignmentCheck {
  const points = anchoredPoints(alignment)
  let off = 0
  let worst = 0
  // What the person confirmed is the ground it is judged from: where the model then was under each point, or that its part was not there.
  const held = alignment.confirmed?.held
  points.forEach(({ part }, i) => {
    const said = nearest[i]
    const there = parts.find((p) => p.name === part)
    const was = held?.[i]
    if (!there || !answered(said)) {
      if (was !== null) off += 1
      return
    }
    // Unconfirmed: how far the model is from the point. Confirmed: how far the model has moved from where it was confirmed, whichever way.
    const by = was ? Math.hypot(said.point[0] - was[0], said.point[1] - was[1], said.point[2] - was[2]) : said.distance
    worst = Math.max(worst, by)
    if (by > tolerance(there.bbox)) off += 1
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

/**
 * The model as it stands under an alignment now, for what is recorded when the person says it still holds
 * (`ScanStore.alignmentHolds`): the last build, how it spreads the layout, and where the model is under each
 * point the alignment is tied to (the point of its part nearest to it), null for one whose part is not there. Rejects when there is no such build, or
 * the kernel cannot say: nothing is confirmed against what is not known.
 */
export async function heldNow(deps: Pick<AlignCheckDeps, 'scene' | 'nearest'>, objectId: string, layout: string, alignment: ScanAlignment): Promise<{ revision: number; frame: Record<string, Vec3>; held: Array<Vec3 | null> }> {
  const last = deps.scene(objectId)
  const parts = last?.scene.parts.filter((part) => part.layout === layout) ?? []
  if (!last || parts.length === 0) throw new Error(`no build of this object has a layout named ${layout}: there is nothing to hold the alignment against`)
  const frame = Object.fromEntries(parts.map((part): [string, Vec3] => [part.name, part.arranged ? [...part.arranged] : [...NOT_SPREAD]]))
  const points = anchoredPoints(alignment)
  if (points.length === 0) return { revision: last.revision, frame, held: [] }
  let nearest: NearestAnchor[]
  try {
    nearest = await deps.nearest(objectId, layout, points)
  } catch (e) {
    throw new Error(`the model could not be asked where its points are now (${e instanceof Error ? e.message : String(e)}): try again`)
  }
  if (nearest.length !== points.length || nearest.some((one) => one?.found === true && !answered(one))) throw new Error('the model could not say where every point is now: try again')
  if (deps.scene(objectId)?.scene !== last.scene) throw new Error('the model was built again meanwhile: look again')
  return { revision: last.revision, frame, held: nearest.map((one) => (answered(one) ? [...one.point] : null)) }
}

/** Whether some alignment, of a layout the last build has, was not checked against that build: a check is then to be asked for again. */
export function uncheckedOn(scans: Array<Pick<ScanInfo, 'alignments' | 'checks'>>, layouts: string[], revision: number): boolean {
  return scans.some((scan) => Object.keys(scan.alignments).some((layout) => layouts.includes(layout) && standingOf(scan, layout, revision).unchecked))
}

/** How often an alignment that was not checked against the last build is asked about again, for as long as it is not. */
export const RECHECK_EVERY_MS = 30_000

/**
 * Asks again, every `RECHECK_EVERY_MS`, for the check of every object of `objects()` whose scans have an
 * alignment that was not checked against its last build (`recheck` looks and asks): the three quick retries
 * of a check that failed are not the end of it. Returns what stops it, as when the workspace is closed.
 */
export function keepChecking(objects: () => string[], recheck: (objectId: string) => void | Promise<void>, every = RECHECK_EVERY_MS): () => void {
  const timer = setInterval(() => {
    for (const objectId of objects()) void Promise.resolve(recheck(objectId)).catch(() => {})
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface AlignCheckDeps {
  scans: Pick<ScanStore, 'list' | 'checked'> & Partial<Pick<ScanStore, 'uncheckedFor'>>
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
 * and nothing is kept of those meanwhile. Not to be tried again when the kernel no longer holds the build
 * (`no_build`): that is said of the alignment, until the next build. When a newer build lands while it runs, what was found is dropped:
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
          // The kernel let the build go (to make room, or its worker died): no asking again brings it back, and
          // none is made. It is said, and the next build has its own check.
          if (e instanceof KernelError && e.kind === 'no_build') {
            await deps.scans.uncheckedFor?.(objectId, scan.id, layout, { revision, reason: `${NOT_HELD}: it is checked when the model is next built` }).catch(() => {})
            continue
          }
          went = isBusy(e) ? 'busy' : went === 'busy' ? 'busy' : false
          // Not silence: the scan says that it could not be checked, and why, until a check says something.
          await deps.scans.uncheckedFor?.(objectId, scan.id, layout, { revision, reason: e instanceof Error ? e.message : String(e) }).catch(() => {})
          continue
        }
        // The part is there and the kernel could say nothing of a point: not "off", not known.
        if (nearest.length !== points.length || nearest.some((one) => one?.found === true && !answered(one))) {
          if (went === true) went = false
          await deps.scans.uncheckedFor?.(objectId, scan.id, layout, { revision, reason: 'the kernel could not say where a point of the model is' }).catch(() => {})
          continue
        }
      }
      if (superseded()) return true
      // With the alignment as it was judged: one confirmed or made anew meanwhile is not given this verdict.
      await deps.scans.checked(objectId, scan.id, layout, judgeAlignment(alignment, scene.parts.filter((part) => part.layout === layout), nearest, revision), alignment).catch(() => {})
    }
  }
  return went
}

/**
 * The check of an object's alignments as main runs it (`retrying`): after every build, every 30 s and whenever
 * the scans are listed while one is unchecked, and after what the person does to an alignment. Only the last
 * may have the object built again to be answered (`restore`): asked unasked, a kernel that no longer holds the
 * build says so and is left alone.
 */
export function checkingAlignments(
  deps: Pick<AlignCheckDeps, 'scans' | 'scene'> & { query(objectId: string, name: 'nearest', args: object, opts: { restore: boolean }): Promise<unknown> },
  log?: (message: string) => void
): Retrying {
  return retrying(
    (objectId, restore) =>
      checkAlignments({ scans: deps.scans, scene: deps.scene, nearest: async (id, layout, anchors) => nearestReply(await deps.query(id, 'nearest', { layout, anchors }, { restore }), anchors) }, objectId),
    log,
    'check the alignments of the scans of'
  )
}

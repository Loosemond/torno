import { isDeepStrictEqual } from 'node:util'
import type { Described } from '../../shared/geometry'
import { type Anchor, type AnchorState, type Vec3, markAnchors } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Builds } from '../builds'
import { KernelError } from '../kernel/client'
import type { MarkStore } from './store'

/**
 * What the kernel's `nearest` says of one anchor: the point of its part's
 * surface nearest to it, the face that point is on (`lid/F12`, no layout in
 * front), and how far the two are apart; or that the layout has no such part.
 */
export type NearestAnchor =
  | { part: string; found: true; point: Vec3; normal: Vec3 | null; ref: string; distance: number; descriptor: string | null }
  | { part: string; found: false }

export type Judged = { anchor: Anchor; state: AnchorState }

const LEAST_TOLERANCE_MM = 0.5
const TOLERANCE_OF_DIAGONAL = 0.005
const WORST_FIRST: AnchorState[] = ['orphaned', 'drifted', 'ok']

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

/**
 * An anchor as a new build leaves it. Its part gone: orphaned, and kept as it
 * was, so that it is found again if the part comes back. Otherwise its ref,
 * normal and descriptor are those of the face now nearest, and it is drifted
 * when that face is further away than `tolerance`. The point is never moved:
 * it is where the person put it.
 */
export function judge(anchor: Anchor, nearest: NearestAnchor, tolerance: number): Judged {
  if (!nearest.found) return { anchor, state: 'orphaned' }
  const refreshed: Anchor = { point: anchor.point, part: anchor.part, ref: nearest.ref }
  // Without them rather than with the old ones, which were said of another face.
  if (nearest.normal) refreshed.normal = nearest.normal
  if (typeof nearest.descriptor === 'string') refreshed.descriptor = nearest.descriptor
  return { anchor: refreshed, state: nearest.distance <= tolerance ? 'ok' : 'drifted' }
}

export interface ReanchorDeps {
  marks: Pick<MarkStore, 'list' | 'reanchor'>
  query: Builds['query']
  /** The last successful build of an object: a new one is a new value. */
  scene(objectId: string): Scene | undefined
  /** Told, once per call, what could not be checked. */
  log?(message: string): void
}

/**
 * Check the unresolved marks of an object against its last successful build:
 * one `nearest` query per layout, for every anchor that names a part, and one
 * write of what changed. An anchor that names no part (a point in space) is
 * always ok; a mark is as bad as the worst of its anchors.
 *
 * A query that fails leaves the marks it was about as they were, and is
 * logged, once for the whole call. When a newer build arrives meanwhile
 * (`scene` answers another value) everything is dropped: the answers were
 * about geometry that is no longer shown, and that build has its own call.
 *
 * A pick of a whole part keeps the part as its ref. A pick of an edge keeps
 * its edge while the build still has an edge of that number where the mark
 * is; otherwise its ref becomes the face now nearest, and it is drifted.
 */
export async function reanchorAll(deps: ReanchorDeps, objectId: string): Promise<void> {
  const scene = deps.scene(objectId)
  if (!scene) return
  const superseded = (): boolean => deps.scene(objectId) !== scene
  const marks = (await deps.marks.list(objectId)).filter((mark) => mark.status !== 'resolved')
  if (superseded()) return

  const failures: string[] = []
  /** By anchor, as listed: how the build leaves it. Without an entry it could not be asked about. */
  const judged = new Map<Anchor, Judged>()
  const toleranceOf = (layout: string, part: string | undefined): number =>
    tolerance(scene.parts.find((p) => p.layout === layout && p.name === part)?.bbox)

  const byLayout = new Map<string, Anchor[]>()
  for (const mark of marks) {
    for (const anchor of markAnchors(mark)) {
      if (anchor.part === undefined) continue
      const anchors = byLayout.get(mark.layout) ?? []
      byLayout.set(mark.layout, anchors)
      anchors.push(anchor)
    }
  }
  for (const [layout, anchors] of byLayout) {
    if (!scene.layouts.includes(layout)) {
      // The kernel would refuse the layout; the scene already says none of its parts is there.
      for (const anchor of anchors) judged.set(anchor, judge(anchor, { part: anchor.part!, found: false }, 0))
      continue
    }
    let found: NearestAnchor[]
    try {
      const asked = anchors.map(({ part, point }) => ({ part: part!, point }))
      found = nearestReply(await deps.query(objectId, 'nearest', { layout, anchors: asked }), asked)
    } catch (e) {
      if (superseded()) return
      failures.push(`layout ${layout}: ${messageOf(e)}`)
      continue
    }
    if (superseded()) return
    anchors.forEach((anchor, i) => judged.set(anchor, judge(anchor, found[i], toleranceOf(layout, anchor.part))))
  }

  // `nearest` names faces. What a pick of an edge or of a whole part points at is asked about by its own ref.
  const picks = marks.filter((mark) => mark.kind === 'pick' && mark.target !== 'face' && (judged.get(mark.anchor)?.state ?? 'orphaned') !== 'orphaned')
  await Promise.all(
    picks.map(async (mark) => {
      if (mark.kind !== 'pick') return
      const { anchor: old, layout } = mark
      const onFace = judged.get(old)!
      const part = old.part!
      const ref = mark.target === 'part' ? part : old.ref?.startsWith(`${part}/E`) ? old.ref : undefined
      let described: Described | null = null
      try {
        if (ref !== undefined) described = await deps.query<Described>(objectId, 'describe', { ref: `${layout}:${ref}` })
      } catch (e) {
        // `bad_ref`: the build has no such edge. Anything else, and it is not known what is there.
        if (!(e instanceof KernelError && e.kind === 'bad_ref')) {
          judged.delete(old)
          failures.push(`${mark.id}: ${messageOf(e)}`)
          return
        }
      }
      if (mark.target === 'part') {
        const { descriptor: _ofTheFace, ...rest } = onFace.anchor
        const descriptor = described?.kind === 'part' && typeof described.descriptor === 'string' ? { descriptor: described.descriptor } : {}
        judged.set(old, { anchor: { ...rest, ref: part, ...descriptor }, state: onFace.state })
      } else if (described?.kind === 'edge' && mayBeOn(old.point, described, toleranceOf(layout, part))) {
        judged.set(old, { anchor: { ...onFace.anchor, ref: ref!, descriptor: described.descriptor }, state: onFace.state })
      } else {
        judged.set(old, { anchor: onFace.anchor, state: 'drifted' })
      }
    })
  )
  if (superseded()) return

  const changes: Array<{ id: string; anchors: Anchor[]; anchorState: AnchorState }> = []
  for (const mark of marks) {
    const anchors = markAnchors(mark)
    const now = anchors.map((anchor): Judged | undefined => (anchor.part === undefined ? { anchor, state: 'ok' } : judged.get(anchor)))
    if (!now.every((j) => j !== undefined)) continue
    const anchorState = WORST_FIRST.find((state) => now.some((j) => j.state === state)) ?? 'ok'
    if (anchorState === mark.anchorState && now.every((j, i) => isDeepStrictEqual(j.anchor, anchors[i]))) continue
    changes.push({ id: mark.id, anchors: now.map((j) => j.anchor), anchorState })
  }
  if (changes.length > 0) await deps.marks.reanchor(objectId, changes)
  if (failures.length > 0) (deps.log ?? console.error)(`cannot check the marks of ${objectId} against its last build: ${failures.join('; ')}`)
}

/** The answers of a `nearest` reply, when there is one for each anchor asked about, in order. Throws otherwise. */
function nearestReply(reply: unknown, asked: Array<{ part: string }>): NearestAnchor[] {
  const found = (reply as { anchors?: unknown } | null)?.anchors
  const whole =
    Array.isArray(found) &&
    found.length === asked.length &&
    found.every((one: Partial<NearestAnchor> | null, i) => {
      if (one?.part !== asked[i].part) return false
      return one.found === false || (one.found === true && typeof one.ref === 'string' && typeof one.distance === 'number' && Number.isFinite(one.distance))
    })
  if (!whole) throw new Error('the kernel did not answer for each anchor')
  return found as NearestAnchor[]
}

/**
 * Whether a point can be on an edge, from where its middle is and how long it
 * is: no point of a curve is further from its middle than half its length. An
 * edge number that now belongs to an edge somewhere else fails this.
 */
function mayBeOn(point: Vec3, edge: { center: Vec3; length: number }, tolerance: number): boolean {
  if (!Array.isArray(edge.center) || typeof edge.length !== 'number') return false
  const away = Math.hypot(point[0] - edge.center[0], point[1] - edge.center[1], point[2] - edge.center[2])
  return away <= edge.length / 2 + tolerance
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * `run`, one at a time per object: asked for an object while it runs for that
 * one, it runs once more afterwards, however often it was asked. A run that
 * rejects is logged and nothing more.
 */
export function coalesced(run: (objectId: string) => Promise<void>, log: (message: string) => void = console.error): (objectId: string) => void {
  /** The objects it is running for, and whether it was asked again for them meanwhile. */
  const running = new Map<string, { again: boolean }>()
  return (objectId) => {
    const current = running.get(objectId)
    if (current) {
      current.again = true
      return
    }
    const mine = { again: false }
    running.set(objectId, mine)
    void (async () => {
      do {
        mine.again = false
        try {
          await run(objectId)
        } catch (e) {
          log(`cannot re-anchor the marks of ${objectId}: ${messageOf(e)}`)
        }
      } while (mine.again)
      running.delete(objectId)
    })()
  }
}


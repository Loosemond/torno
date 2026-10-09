import { isDeepStrictEqual } from 'node:util'
import type { Described } from '../../shared/geometry'
import { type Anchor, type AnchorState, type Mark, type Vec3, markAnchors } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Builds } from '../builds'
import { KernelError } from '../kernel/client'
import type { MarkStore } from './store'

/**
 * What the kernel's `nearest` says of one anchor: the point of its part's
 * surface nearest to it, the face that point is on (`lid/F12`, no layout in
 * front), and how far the two are apart; or that the layout has no such part.
 *
 * For an anchor sent with the `edge` it was put on (`lid/E3`), also whether
 * the part has an edge of that number and, if so, how far the anchor's point
 * is from it and what it is.
 */
export type NearestAnchor =
  | ({ part: string; found: true; point: Vec3; normal: Vec3 | null; ref: string; distance: number; descriptor: string | null } & EdgeOfAnchor)
  | { part: string; found: false }

type EdgeOfAnchor = { edgeFound?: undefined } | { edgeFound: false } | { edgeFound: true; edgeDistance: number; edgeDescriptor: string | null }

/** An anchor as `nearest` is asked about it. */
type AskedAnchor = { part: string; point: Vec3; edge?: string }

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
 * its edge ref, and is ok only while the build has an edge of that number
 * within the tolerance of the mark's point: the kernel measures that distance.
 * Otherwise it is drifted, whatever the surface did.
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

  /** By anchor: what the kernel said of it. */
  const nearest = new Map<Anchor, NearestAnchor>()
  const byLayout = new Map<string, Array<{ anchor: Anchor; asked: AskedAnchor }>>()
  for (const mark of marks) {
    for (const anchor of markAnchors(mark)) {
      if (anchor.part === undefined) continue
      const entries = byLayout.get(mark.layout) ?? []
      byLayout.set(mark.layout, entries)
      const edge = edgeRef(mark)
      entries.push({ anchor, asked: { part: anchor.part, point: anchor.point, ...(edge === undefined ? {} : { edge }) } })
    }
  }
  for (const [layout, entries] of byLayout) {
    if (!scene.layouts.includes(layout)) {
      // The kernel would refuse the layout; the scene already says none of its parts is there.
      for (const { anchor, asked } of entries) judged.set(anchor, judge(anchor, { part: asked.part, found: false }, 0))
      continue
    }
    let found: NearestAnchor[]
    try {
      const asked = entries.map((entry) => entry.asked)
      found = nearestReply(await deps.query(objectId, 'nearest', { layout, anchors: asked }), asked)
    } catch (e) {
      if (superseded()) return
      failures.push(`layout ${layout}: ${messageOf(e)}`)
      continue
    }
    if (superseded()) return
    entries.forEach(({ anchor }, i) => {
      nearest.set(anchor, found[i])
      judged.set(anchor, judge(anchor, found[i], toleranceOf(layout, anchor.part)))
    })
  }

  // `nearest` names faces. What a pick of an edge or of a whole part points at is not a face.
  const picks = marks.filter((mark) => mark.kind === 'pick' && mark.target !== 'face' && nearest.get(mark.anchor)?.found === true)
  await Promise.all(
    picks.map(async (mark) => {
      if (mark.kind !== 'pick') return
      const { anchor: old, layout } = mark
      const onFace = judged.get(old)!
      const part = old.part!
      if (mark.target === 'edge') {
        const edge = edgeRef(mark)
        const said = nearest.get(old)
        if (edge === undefined || said?.found !== true) {
          // It never named an edge: all that can be said is what face is there.
          judged.set(old, { anchor: onFace.anchor, state: 'drifted' })
        } else {
          // Only the descriptor is refreshed. An edge has no one normal, so the anchor is given none.
          // The ref is kept even when its number is no longer that of the edge under the point (of no
          // edge now, or of one somewhere else): the mark is then said to have drifted, and a build
          // that puts the edge back under the point finds the mark on it again. The descriptor is
          // then of the face under the point: it never describes an edge the mark is not on.
          const onEdge = said.edgeFound === true && said.edgeDistance <= toleranceOf(layout, part)
          const what = onEdge ? said.edgeDescriptor : onFace.anchor.descriptor
          const { descriptor: _old, ...rest } = old
          judged.set(old, { anchor: { ...rest, ...(typeof what === 'string' ? { descriptor: what } : {}) }, state: onEdge ? onFace.state : 'drifted' })
        }
        return
      }
      let described: Described | null = null
      try {
        described = await deps.query<Described>(objectId, 'describe', { ref: `${layout}:${part}` })
      } catch (e) {
        // `bad_ref` cannot be, of a part `nearest` has just found. Anything else, and it is not known what is there.
        if (!(e instanceof KernelError && e.kind === 'bad_ref')) {
          judged.delete(old)
          failures.push(`${mark.id}: ${messageOf(e)}`)
          return
        }
      }
      const { descriptor: _ofTheFace, ...rest } = onFace.anchor
      const descriptor = described?.kind === 'part' && typeof described.descriptor === 'string' ? { descriptor: described.descriptor } : {}
      judged.set(old, { anchor: { ...rest, ref: part, ...descriptor }, state: onFace.state })
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

/** The edge a mark was put on, as its anchor names it: of a pick of an edge whose ref is one of its part's edges. */
function edgeRef(mark: Mark): string | undefined {
  if (mark.kind !== 'pick' || mark.target !== 'edge') return undefined
  const { part, ref } = mark.anchor
  return part !== undefined && ref !== undefined && /^E\d+$/.test(ref.slice(part.length + 1)) && ref.startsWith(`${part}/`) ? ref : undefined
}

/**
 * The answers of a `nearest` reply, when there is one for each anchor asked
 * about, in order, and each that named an edge is told of it. Throws otherwise.
 */
function nearestReply(reply: unknown, asked: AskedAnchor[]): NearestAnchor[] {
  const found = (reply as { anchors?: unknown } | null)?.anchors
  const whole =
    Array.isArray(found) &&
    found.length === asked.length &&
    found.every((one: Record<string, unknown> | null, i) => {
      if (one?.part !== asked[i].part) return false
      if (one.found === false) return true
      if (one.found !== true || typeof one.ref !== 'string' || !isDistance(one.distance)) return false
      if (asked[i].edge === undefined) return true
      return one.edgeFound === false || (one.edgeFound === true && isDistance(one.edgeDistance))
    })
  if (!whole) throw new Error('the kernel did not answer for each anchor')
  return found as NearestAnchor[]
}

function isDistance(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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


/**
 * Have the marks of an object checked (`reanchor`) whenever the store says
 * some have not been against the build there is: a mark just added, which
 * carries the refs of whatever build its maker saw, and one reopened, which
 * no build since it was resolved has been asked about. What the check itself
 * writes is neither, so it does not call for another.
 */
export function followMarks(store: Pick<MarkStore, 'on'>, reanchor: (objectId: string) => void): void {
  store.on('unchecked', ({ objectId }) => reanchor(objectId))
}

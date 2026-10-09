import { verdictOf } from '../../shared/dimension'
import type { MeasureArgs, MeasureTarget, Measured } from '../../shared/geometry'
import type { Anchor, DimensionMark, Mark, Measurement, NewMark, Vec3 } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import type { Builds } from '../builds'
import { KernelError } from '../kernel/client'
import { sanitiseMark } from './file'
import type { MarkStore } from './store'

/** How long a new dimension waits for its value before it appears without one, to be given it when it comes. */
export const APPEARS_AFTER_MS = 300

export interface MeasureDeps {
  query: Builds['query']
  /** The last successful build of an object. */
  scene(objectId: string): { revision: number; scene: Scene } | undefined
}

/**
 * An end of a measurement as the kernel takes it: a ref with the layout in
 * front, and the point it is measured at; without a ref, the point as a point
 * of the layout.
 */
function target(layout: string, end: MeasureTarget): object {
  const point = end.point ? { point: [end.point[0], end.point[1], end.point[2]] } : {}
  return typeof end.ref === 'string' && end.ref !== '' ? { ref: `${layout}:${end.ref}`, ...point } : { layout, ...point }
}

/** `measure` as it goes to the kernel (`kernel/src/torno_kernel/measure.py`). */
function wire(args: MeasureArgs): object {
  return { kind: args.kind, a: target(args.layout, args.a), ...(args.b ? { b: target(args.layout, args.b) } : {}), ...(args.density === undefined ? {} : { density: args.density }) }
}

/** What the kernel said, as the person reads it: its refs without the layout in front, as they are everywhere in the window. */
function plain(e: unknown, layout: string): string {
  const message = e instanceof Error ? e.message : String(e)
  return layout ? message.replaceAll(`${layout}:`, '') : message
}

/**
 * What the kernel is asked of a dimension: its kind of measurement, and each
 * end by the ref it has (a face, an edge or a part), with the layout in
 * front, and the point it was put at; an end with no ref is the point alone.
 * A second end goes only where the measurement is taken between two.
 */
export function measureRequest(mark: Pick<DimensionMark, 'measure' | 'layout' | 'a' | 'b'>): object {
  const end = (anchor: Anchor): MeasureTarget => ({ ...(anchor.ref === undefined ? {} : { ref: anchor.ref }), point: anchor.point })
  const between = mark.measure === 'distance' || mark.measure === 'angle'
  return wire({ kind: mark.measure, layout: mark.layout, a: end(mark.a), ...(between && mark.b ? { b: end(mark.b) } : {}) })
}

const isPoint = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c))

/**
 * Measures a dimension on the last build of its object: the kernel is asked
 * with each end's ref and point, and what comes back is the value in full,
 * how it was taken, the points it was taken between, the revision of the
 * build it is of, and the verdict against what the mark expects. A wall's
 * thickness is asked at the point of the face nearest to the end (`onItsFace`);
 * the end itself stays where it was put.
 *
 * When the kernel says the thing cannot be measured (an end names nothing in
 * this build, or the kind of measurement is not one of such ends), there is
 * no value, and `refused` is why. Anything else that goes wrong (no build, a
 * kernel that does not answer) rejects, with a plain message: nothing is
 * known of the dimension then.
 */
export async function measureDimension(
  deps: MeasureDeps,
  objectId: string,
  mark: Pick<DimensionMark, 'measure' | 'layout' | 'a' | 'b' | 'expected' | 'tolerance'>
): Promise<Measurement & { refused?: string }> {
  // A build that lands while the kernel is asked leaves it unsaid which the answer is of: asked again, once.
  for (let tries = 0; ; tries++) {
    const before = deps.scene(objectId)?.revision
    if (before === undefined) throw new Error(`there is no build of ${objectId} to measure on`)
    const request = measureRequest(mark.measure === 'thickness' ? { ...mark, a: await onItsFace(deps, objectId, mark.layout, mark.a) } : mark)
    let reply: Partial<Record<'value' | 'how' | 'points', unknown>> | null
    let refused: string | undefined
    try {
      reply = await deps.query(objectId, 'measure', request)
    } catch (e) {
      if (!(e instanceof KernelError && (e.kind === 'bad_ref' || e.kind === 'bad_request'))) throw new Error(plain(e, mark.layout))
      reply = null
      refused = plain(e, mark.layout)
    }
    const measuredRevision = deps.scene(objectId)?.revision
    if (measuredRevision !== before && tries === 0) continue
    if (measuredRevision === undefined || measuredRevision !== before) throw new Error(`${objectId} was built again while it was measured`)
    if (refused !== undefined) return { measuredRevision, refused }
    if (typeof reply?.value !== 'number' || !Number.isFinite(reply.value) || typeof reply.how !== 'string') throw new Error('the kernel did not answer with a measurement')
    const { value, how, points } = reply
    const between: { points?: [Vec3, Vec3] } = Array.isArray(points) && points.length === 2 && isPoint(points[0]) && isPoint(points[1]) ? { points: [points[0], points[1]] } : {}
    const verdict = verdictOf({ ...mark, value })
    return { value, how, ...between, measuredRevision, ...(verdict ? { verdict } : {}) }
  }
}

/**
 * An end as a wall is measured from it: at the point of its face nearest to
 * where it was put. The point clicked is on the mesh that is drawn, which on
 * a curved face lies a hair off the surface, and the kernel measures a wall
 * only from a point on the face. The end is left where it is when the kernel
 * does not say, or finds the nearest point of the part on another face: the
 * kernel's own refusal then says what is wrong.
 */
async function onItsFace(deps: Pick<MeasureDeps, 'query'>, objectId: string, layout: string, end: Anchor): Promise<Anchor> {
  if (end.part === undefined || end.ref === undefined) return end
  try {
    const reply = await deps.query<{ anchors?: Array<{ found?: boolean; ref?: unknown; point?: unknown } | null> }>(objectId, 'nearest', { layout, anchors: [{ part: end.part, point: end.point }] })
    const near = reply?.anchors?.[0]
    return near?.found === true && near.ref === end.ref && isPoint(near.point) ? { ...end, point: [near.point[0], near.point[1], near.point[2]] } : end
  } catch {
    return end
  }
}

type Marks = Pick<MarkStore, 'add' | 'measured' | 'remove'>

/**
 * Keeps a new dimension, measured: the kernel is asked at once, and when it
 * answers within `APPEARS_AFTER_MS` the dimension is added with its value, in
 * one change. When it takes longer the dimension appears without one, and is
 * given it when it comes. Resolves with the mark as it then is.
 *
 * A dimension the kernel cannot measure is not kept (one that had appeared is
 * taken away again), and the promise rejects with the kernel's reason: two
 * ends that have no angle between them, a face with no radius. What is no
 * dimension at all is the store's to refuse, and the kernel is not asked.
 */
export async function addDimension(deps: MeasureDeps & { marks: Marks }, objectId: string, mark: NewMark, status: 'draft' | 'sent' = 'draft'): Promise<Mark> {
  const probe = sanitiseMark({ ...Object(mark), id: 'M1', status: 'draft', anchorState: 'ok', createdAt: '' })
  if (probe?.kind !== 'dimension') return deps.marks.add(objectId, mark, status)

  type Outcome = { measured: Measurement & { refused?: string } } | { failed: Error }
  const measuring: Promise<Outcome> = measureDimension(deps, objectId, probe).then(
    (measured) => ({ measured }),
    (e: unknown) => ({ failed: e instanceof Error ? e : new Error(String(e)) })
  )
  const kept = (outcome: Outcome): Measurement => {
    if ('failed' in outcome) throw outcome.failed
    const { refused, ...measured } = outcome.measured
    if (refused !== undefined) throw new Error(refused)
    return measured
  }

  let timer: NodeJS.Timeout | undefined
  const quick = await Promise.race([measuring, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), APPEARS_AFTER_MS)))])
  clearTimeout(timer)
  if (quick) return deps.marks.add(objectId, mark, status, kept(quick))

  const added = await deps.marks.add(objectId, mark, status)
  let measured: Measurement
  try {
    measured = kept(await measuring)
  } catch (e) {
    await deps.marks.remove(objectId, added.id).catch(() => {})
    throw e
  }
  return (await deps.marks.measured(objectId, added.id, probe, measured)) ?? added
}

/**
 * Measures a dimension again and writes what the kernel says now: its value,
 * or that it is not measurable. When the kernel could not be asked, the
 * dimension is left as it is, and that is logged.
 */
export async function remeasure(deps: MeasureDeps & { marks: Pick<MarkStore, 'measured'>; log?(message: string): void }, objectId: string, mark: DimensionMark): Promise<void> {
  try {
    const { refused: _why, ...measured } = await measureDimension(deps, objectId, mark)
    await deps.marks.measured(objectId, mark.id, mark, measured)
  } catch (e) {
    ;(deps.log ?? console.error)(`cannot measure ${mark.id} of ${objectId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * `measure`, as the window asks it of an object's last good build: refs are
 * of the layout named, and go to the kernel with it in front, as
 * `geometry:describe` sends them. Rejects with a plain message, the kernel's
 * when it refused.
 */
export async function measure(query: Builds['query'], objectId: string, args: MeasureArgs): Promise<Measured> {
  const whole = typeof args === 'object' && args !== null && typeof args.kind === 'string' && typeof args.layout === 'string' && args.layout !== '' && typeof args.a === 'object' && args.a !== null
  if (!whole || (args.b !== undefined && (typeof args.b !== 'object' || args.b === null))) throw new Error('measure needs a kind, a layout and an end a: a ref, a point, or both')
  try {
    return await query<Measured>(objectId, 'measure', wire(args))
  } catch (e) {
    throw new Error(plain(e, args.layout))
  }
}

import { measuredValue, unmeasuredText, valueText } from '../../shared/dimension'
import type { Described } from '../../shared/geometry'
import type { Anchor, MeasureKind, Vec3 } from '../../shared/marks'
import { toolStore } from '../state/tools'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { DESCRIBE_WITHIN_MS, REPEAT_MS, REPEAT_PX, anchorFromHit, dot, sub, within, type Tool, type ToolContext } from './Tool'

/** How long the kernel's reason for refusing a measurement stays at the pointer. */
export const REFUSAL_MS = 4000
/** How long the pointer rests on a face or an edge before the kernel is asked what it is. */
const DESCRIBE_AFTER_MS = 150
/** The value just measured stays at the pointer until the pointer has moved this far from where it was read out. */
const RESULT_PX = 12

/** An end of a measurement as it was clicked: on what, and whether as a bare point (Shift). */
interface End {
  hit: Hit
  bare: boolean
}

/** Whether what the kernel describes has a radius to measure: a cylindrical, spherical or toroidal face, or a circular edge. */
export function isRound(described: Described | null): boolean {
  if (described?.kind === 'face') return ['cylinder', 'sphere', 'torus'].includes(described.type)
  return described?.kind === 'edge' && described.type === 'circle'
}

/**
 * What the mesh says a measurement between two picks will be, to read out
 * while the second is pending: the distance between the two points clicked,
 * or the angle between the normals there. It is an estimate, shown with `≈`:
 * the kernel measures between the features themselves (two planes, two axes),
 * and its value is what the dimension gets. Null where the mesh says nothing
 * (an angle to an edge, which has no normal).
 */
export function estimate(measure: 'distance' | 'angle', a: Pick<Hit, 'point' | 'normal'>, b: Pick<Hit, 'point' | 'normal'>): string | null {
  if (measure === 'distance') return `≈ ${Math.hypot(...sub(b.point, a.point)).toFixed(1)} mm`
  if (!a.normal || !b.normal) return null
  const cosine = dot(a.normal, b.normal) / (Math.hypot(...a.normal) * Math.hypot(...b.normal))
  return Number.isFinite(cosine) ? `≈ ${Math.round((Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI)}°` : null
}

/**
 * The measure tool. A click on a face or an edge is the first end of a
 * measurement, a second click the other end: the dimension between them is
 * kept, a distance or, when that is what is chosen, an angle. A double click
 * on something round (a hole, a cylinder, a circular edge) keeps its diameter
 * at once, or its radius when that is chosen. `T` over a face keeps the
 * thickness of the wall under the pointer. With Shift a click is a bare
 * point: where it was clicked, tied to no face.
 *
 * While the second end is pending the line to the pointer is drawn and an
 * estimate from the mesh read out, marked `≈`. The value of the dimension is
 * the kernel's: main measures it as it keeps the mark, and it is read out in
 * place of the estimate. When the kernel refuses the measurement (no angle
 * between a plane and a cylinder), nothing is kept and its reason is read out
 * for `REFUSAL_MS`. Escape drops the first end; the tool stays in hand.
 */
export function measureTool(): Tool {
  /** The first end, once clicked: where and when, and whether it has a radius (asked of the kernel at the click). */
  let first: (End & { client: [number, number]; at: number; round: Promise<boolean> }) | null = null
  /** What the pointer is on, for `T`. */
  let hover: { hit: Hit; client: [number, number] } | null = null
  /** Counts the dimensions committed: the one still waiting on main owns the draft drawn meanwhile. */
  let committing = 0
  /** What is read out and must not be written over by the hover: the kernel's reason until its time is up, or the value just measured until the pointer moves on. */
  let held: { until: number; timer?: ReturnType<typeof setTimeout>; client: [number, number]; within: number } | null = null
  let rest: ReturnType<typeof setTimeout> | undefined

  const release = (): void => {
    clearTimeout(held?.timer)
    held = null
  }
  /** Whether the readout is still held, for a pointer now at `client`. */
  const holding = (client: [number, number]): boolean => {
    if (!held) return false
    if (performance.now() < held.until || Math.hypot(client[0] - held.client[0], client[1] - held.client[1]) <= held.within) return true
    release()
    return false
  }

  const drawFirst = (ctx: ToolContext, to: Vec3 | null = null): void => {
    if (first) ctx.viewport.setDraft({ kind: 'dimension', from: first.hit.point, to })
  }

  const end = async (of: End, ctx: ToolContext): Promise<Anchor> => (of.bare ? { point: of.hit.point } : anchorFromHit(of.hit, ctx.describe))

  const commit = async (measure: MeasureKind, a: End, b: End | null, client: [number, number], ctx: ToolContext): Promise<void> => {
    // As they are now: the kernel is asked before the mark is made, and the view may move meanwhile.
    const { layout, revision, camera } = ctx
    const mine = ++committing
    ctx.viewport.setDraft({ kind: 'dimension', from: a.hit.point, to: b ? b.hit.point : null })
    try {
      const [from, to] = await Promise.all([end(a, ctx), b ? end(b, ctx) : null])
      const mark = await ctx.commit({ kind: 'dimension', measure, author: 'user', note: '', layout, revision, camera, a: from, ...(to ? { b: to } : {}) })
      if (mine !== committing || mark.kind !== 'dimension') return
      // The kernel's value, in place of the estimate: until the pointer moves on.
      release()
      held = { until: 0, client: hover?.client ?? client, within: RESULT_PX }
      // One the kernel could not be asked about yet is kept without a value, and says so.
      const value = measuredValue(mark, revision)
      ctx.readout.show(held.client, mark.id, value === undefined ? unmeasuredText(revision) : [valueText(mark.measure, value), mark.how ?? ''].filter(Boolean).join(' '))
    } catch (e) {
      if (mine !== committing) return
      // Main did not keep it, and why is the kernel's to say: no angle between these two, no radius of that.
      release()
      const at = hover?.client ?? client
      held = { until: performance.now() + REFUSAL_MS, client: at, within: 0 }
      held.timer = setTimeout(() => {
        held = null
        ctx.readout.hide()
      }, REFUSAL_MS)
      ctx.readout.say(at, e instanceof Error ? e.message : String(e))
    } finally {
      // Its draft, unless a first end was clicked meanwhile, whose own is drawn now.
      if (mine === committing && !first) ctx.viewport.setDraft(null)
    }
  }

  const drop = (ctx: ToolContext): void => {
    first = null
    ctx.viewport.setDraft(null)
  }

  const click = (e: ViewportPointer, hit: Hit, ctx: ToolContext): void => {
    const now = performance.now()
    if (!first) {
      const bare = e.shift
      // A bare point has no radius. Of anything else the kernel says what it is: asked now, so a double click need not wait.
      const round = bare ? Promise.resolve(false) : within(ctx.describe(hit.ref), DESCRIBE_WITHIN_MS).then(isRound)
      first = { hit, bare, client: e.client, at: now, round }
      // Whatever was being committed is on its own from here: the draft is this end's.
      committing += 1
      release()
      drawFirst(ctx)
      return
    }
    const begun = first
    const repeat = Math.hypot(e.client[0] - begun.client[0], e.client[1] - begun.client[1]) <= REPEAT_PX && now - begun.at <= REPEAT_MS
    if (repeat) {
      // The second half of a double click: the diameter of something round, and of anything else nothing more than the first click.
      void begun.round.then((round) => {
        if (!round || first !== begun) return
        first = null
        return commit(toolStore.getState().round, begun, null, e.client, ctx)
      })
      return
    }
    first = null
    void commit(toolStore.getState().between, begun, { hit, bare: e.shift }, e.client, ctx)
  }

  const hovering = (e: ViewportPointer, hit: Hit, ctx: ToolContext): void => {
    hover = { hit, client: e.client }
    ctx.viewport.setHover(hit)
    clearTimeout(rest)
    if (first) drawFirst(ctx, hit.point)
    if (holding(e.client)) return
    if (first) {
      const { between } = toolStore.getState()
      ctx.readout.show(e.client, estimate(between, first.hit, hit) ?? between, hit.ref)
      return
    }
    // Nothing under way: what the first end would be on, and what the kernel says it is, once the pointer rests.
    const { ref } = hit
    const known = ctx.descriptor(ref)
    ctx.readout.show(e.client, ref, known)
    if (known !== undefined) return
    rest = setTimeout(() => {
      void ctx.describe(ref).then((said) => {
        if (said && hover?.hit.ref === ref && !first && !held) ctx.readout.describe(said.descriptor)
      })
    }, DESCRIBE_AFTER_MS)
  }

  return {
    id: 'measure',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'click') {
        if (e.hit) click(e, e.hit, ctx)
        return
      }
      if (e.type === 'down' || e.type === 'up') return
      if (e.type === 'move' && e.hit && e.buttons === 0) return hovering(e, e.hit, ctx)
      // Beside the parts, turning the camera, or gone: nothing is pointed at. The first end stays drawn.
      clearTimeout(rest)
      hover = null
      ctx.viewport.setHover(null)
      if (first) drawFirst(ctx)
      if (!holding(e.client)) ctx.readout.hide()
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      if (ctx.stale !== null) return false
      if (e.key === 'Escape') {
        if (!first) return false
        drop(ctx)
        return true
      }
      if (e.key.toUpperCase() !== 'T' || !hover || hover.hit.kind !== 'face') return false
      // A key held down repeats: one wall, one dimension.
      if (e.repeat) return true
      // The wall under the pointer: whatever end was pending is dropped for it.
      first = null
      void commit('thickness', { hit: hover.hit, bare: false }, null, hover.client, ctx)
      return true
    },
    cancel(ctx: ToolContext) {
      committing += 1
      clearTimeout(rest)
      release()
      first = null
      hover = null
      ctx.viewport.setHover(null)
      ctx.viewport.setDraft(null)
      ctx.readout.hide()
    }
  }
}

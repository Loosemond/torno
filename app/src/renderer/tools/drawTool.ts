import { MAX_STROKE_POINTS, type Vec3 } from '../../shared/marks'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { fromPlane, planeName, rayOnPlane, toPlane, viewPlane, type Plane } from './planes'
import { simplify } from './simplify'
import { MIN_LENGTH_MM, anchorFromHit, type Tool, type ToolContext } from './Tool'

/** The pointer is sampled each time it has travelled this far, in pixels. */
export const SAMPLE_PX = 3
/** Points nearer than this to the line through their neighbours are dropped when the stroke is kept, in millimetres. */
export const TOLERANCE_MM = 0.2

type Client = [number, number]
type Drawing = {
  /** Where the pointer was last sampled. */
  last: Client
  /** What the stroke started on; null beside the parts. */
  start: Hit | null
} & ({ on: 'surface'; points: Vec3[] } | { on: 'plane'; plane: Plane; points: [number, number][] })

function centre(box: { min: Vec3; max: Vec3 }): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
}

/** The points of what is being drawn, in the object frame. */
function inSpace(drawing: Drawing): Vec3[] {
  if (drawing.on === 'surface') return drawing.points
  const { plane } = drawing
  return drawing.points.map((p) => fromPlane(plane, p))
}

/** How long a drawn line is, from its first point to its last along it. */
function lengthOf(points: number[][]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(...points[i].map((c, k) => c - points[i - 1][k]))
  return length
}

/** How far apart the points of a drawn line lie at most: the diagonal of the box around them. */
function spanOf(points: number[][]): number {
  if (points.length === 0) return 0
  return Math.hypot(...points[0].map((_, k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]))))
}

/** How wide and how high a drawing on a plane is, in millimetres: `12.0 × 7.5 mm`. */
function extent(points: [number, number][]): string {
  const us = points.map((p) => p[0])
  const vs = points.map((p) => p[1])
  return `${(Math.max(...us) - Math.min(...us)).toFixed(1)} × ${(Math.max(...vs) - Math.min(...vs)).toFixed(1)} mm`
}

/**
 * The draw tool: press, draw, let go. What is drawn depends on the view.
 *
 * On a locked view (one of the orthographic standard views, not turned since)
 * the stroke lies on the plane that faces the camera, through the point of the
 * part it starts on, or through the middle of the scene when it starts beside
 * the parts. It is kept as 2D points in millimetres on that plane: a profile.
 *
 * On any other view the stroke lies on the surface: it starts on a part, and
 * each sample is where the pointer is on a part then; those beside the parts
 * are left out. A press beside the parts turns the camera as ever.
 *
 * Either way the stroke is simplified when it is let go (to at most the
 * points main keeps: it would cut more without a word), a stroke of fewer
 * than two points, shorter than 0.1 mm, or whose simplified points all lie
 * within 0.1 mm of one another is none, and the wheel still zooms
 * while drawing. On a locked view every press of the left button draws, so
 * a press with Alt held is left alone: it turns the camera, as on any view.
 */
export function drawTool(): Tool {
  let drawing: Drawing | null = null
  /** Counts the strokes let go: the one still waiting on main owns the draft drawn meanwhile. */
  let placing = 0

  const drop = (ctx: ToolContext): void => {
    drawing = null
    ctx.viewport.setNavigation(true)
    ctx.readout.hide()
  }

  /** Takes the pointer's place as a point of the stroke, if it has one there. */
  const sample = (e: ViewportPointer, ctx: ToolContext): boolean => {
    if (!drawing) return false
    drawing.last = e.client
    if (drawing.on === 'plane') {
      const point = rayOnPlane(e.ray, drawing.plane)
      if (!point) return false
      drawing.points.push(toPlane(drawing.plane, point))
      return true
    }
    // Faces only: within reach of an edge, the point would be on the edge and not under the pointer.
    const hit = ctx.viewport.pick(e.client[0], e.client[1], { edges: false })
    if (!hit) return false
    drawing.points.push(hit.point)
    return true
  }

  const place = async (drawn: Drawing, ctx: ToolContext): Promise<void> => {
    const { layout, revision, camera } = ctx
    const mine = ++placing
    const base = { kind: 'stroke', author: 'user', note: '', layout, revision, camera } as const
    try {
      const first = inSpace(drawn)[0]
      const anchor = drawn.start ? { ...(await anchorFromHit(drawn.start, ctx.describe)), point: first } : { point: first }
      const mark =
        drawn.on === 'surface'
          ? await ctx.commit({ ...base, space: 'surface', anchor, points: drawn.points })
          : await ctx.commit({ ...base, space: 'plane', anchor, plane: drawn.plane, points2d: drawn.points })
      ctx.openNote(mark)
    } catch {
      // Main refused it, and whoever made `commit` has said so: there is no stroke.
    } finally {
      if (mine === placing) ctx.viewport.setDraft(null)
    }
  }

  return {
    id: 'draw',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'down') {
        // With Alt the press is the camera's: the way to turn a locked view with this tool in hand.
        if (!(e.buttons & 1) || e.alt) return
        const locked = ctx.viewport.lockedView() !== null
        if (!locked && !e.hit) return
        if (locked) {
          const plane = viewPlane(ctx.camera, e.hit?.point ?? centre(ctx.viewport.bounds()))
          drawing = { on: 'plane', plane, points: [], start: e.hit, last: e.client }
          sample(e, ctx)
        } else {
          drawing = { on: 'surface', points: [e.hit!.point], start: e.hit, last: e.client }
        }
        ctx.viewport.setNavigation(false, { wheel: true })
        ctx.viewport.setHover(null)
        ctx.readout.hide()
        return
      }
      if (!drawing) {
        // Nothing under way: what a stroke would start on.
        if (e.type === 'move' && e.hit && e.buttons === 0) {
          ctx.viewport.setHover(e.hit)
          ctx.readout.show(e.client, e.hit.ref)
        } else if (e.type === 'move' && e.buttons === 0 && ctx.viewport.lockedView() !== null) {
          // Beside the parts on a locked view a press draws too: which plane on, and how to turn the view instead.
          ctx.viewport.setHover(null)
          ctx.readout.say(e.client, `Draws on ${planeName(viewPlane(ctx.camera, centre(ctx.viewport.bounds())).label)}. Alt-drag or Iso (1) to turn the view`)
        } else if (e.type !== 'click') {
          ctx.viewport.setHover(null)
          ctx.readout.hide()
        }
        return
      }
      // The pointer was taken away, or moves with no button held: a release that never came. The stroke is nobody's.
      if (e.type === 'cancel' || (e.type === 'move' && !(e.buttons & 1))) {
        ctx.viewport.setDraft(null)
        return drop(ctx)
      }
      if (e.type !== 'move' && e.type !== 'up') return

      const travelled = Math.hypot(e.client[0] - drawing.last[0], e.client[1] - drawing.last[1])
      if (e.type === 'move') {
        if (travelled < SAMPLE_PX || !sample(e, ctx)) return
        ctx.viewport.setDraft({ kind: 'stroke', points: inSpace(drawing) })
        if (drawing.on === 'plane') ctx.readout.show(e.client, drawing.plane.label, extent(drawing.points))
        return
      }
      // Let go: the stroke ends where the pointer is, however near the last sample that is.
      if (travelled > 0 && drawing.points.length >= 2) sample(e, ctx)
      // Each kind by itself: its points are of two numbers or of three.
      const drawn: Drawing =
        drawing.on === 'surface'
          ? { ...drawing, points: simplify(drawing.points, TOLERANCE_MM, MAX_STROKE_POINTS) }
          : { ...drawing, points: simplify(drawing.points, TOLERANCE_MM, MAX_STROKE_POINTS) }
      // Measured as it was drawn: a small circle is short from end to end, and long. And as it will be
      // kept: a line out and back within the tolerance is two points in one place once it is simplified.
      const short = lengthOf(drawing.points) < MIN_LENGTH_MM || spanOf(drawn.points) < MIN_LENGTH_MM
      drop(ctx)
      if (drawn.points.length < 2 || short) return ctx.viewport.setDraft(null)
      // Stays drawn, as it will be kept, until main has it.
      ctx.viewport.setDraft({ kind: 'stroke', points: inSpace(drawn) })
      void place(drawn, ctx)
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      if (e.key !== 'Escape' || !drawing) return false
      ctx.viewport.setDraft(null)
      drop(ctx)
      return true
    },
    cancel(ctx: ToolContext) {
      placing += 1
      ctx.viewport.setHover(null)
      ctx.viewport.setDraft(null)
      drop(ctx)
    }
  }
}

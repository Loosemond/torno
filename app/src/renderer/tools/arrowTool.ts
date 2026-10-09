import type { Vec3 } from '../../shared/marks'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { DRAG_PX, along, anchorFromHit, dot, sub, unit, type Tool, type ToolContext } from './Tool'

/** With Shift, a drag this near a principal axis runs along it; any other runs along the normal. */
const AXIS_SNAP_DEG = 15
const AXES: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
/** Past this cosine between a line and the pointer's ray, the line is seen end on. */
const END_ON = 0.999

type Ray = ViewportPointer['ray']

/** Where a ray meets the plane through `point` with normal `normal`; null when it runs along the plane. */
function onPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const slope = dot(ray.direction, normal)
  if (Math.abs(slope) < 1e-9) return null
  return along(ray.origin, ray.direction, dot(sub(point, ray.origin), normal) / slope)
}

/**
 * The head of an arrow that starts at `start`, for a pointer looking along
 * `ray`: where the ray meets the plane through the start that faces the
 * camera (`view` is the way the camera looks). With `snap` it is held to a
 * line through the start instead: a principal axis when the drag is within 15°
 * of one, else the surface normal at the start, and it is the point of that
 * line nearest the ray. A line seen end on has no such point, and keeps the
 * length of the drag. Millimetres, object frame.
 */
export function arrowHead(start: Vec3, normal: Vec3 | null, ray: Ray, view: Vec3, snap: boolean): Vec3 {
  const free = onPlane(ray, start, view) ?? start
  if (!snap) return free
  const drag = sub(free, start)
  const direction = unit(drag)
  if (!direction) return start
  const limit = Math.cos((AXIS_SNAP_DEG * Math.PI) / 180)
  const axis = AXES.find((a) => dot(a, direction) >= limit) ?? (normal && unit(normal))
  if (!axis) return free
  const across = dot(axis, ray.direction)
  if (Math.abs(across) > END_ON) return along(start, axis, Math.hypot(...drag))
  // The point of the line start + t·axis nearest the ray.
  const toStart = sub(start, ray.origin)
  const t = (across * dot(ray.direction, toStart) - dot(axis, toStart)) / (1 - across * across)
  return along(start, axis, t)
}

/** A number of millimetres with its sign, to a tenth: `+12.0`, `-3.5`, `0.0`. */
function signed(mm: number): string {
  const text = mm.toFixed(1)
  return mm > 0 && text !== '0.0' ? `+${text}` : text === '-0.0' ? '0.0' : text
}

/**
 * The arrow tool: press on a part, drag, let go. The arrow says "move this
 * that way": its head follows the pointer on the plane that faces the camera,
 * or with Shift along the normal or an axis, and its length and vector are
 * read out beside it. A drag of less than 4 px is no arrow. A press beside
 * the parts turns the camera as ever.
 */
export function arrowTool(): Tool {
  let drag: { start: Hit; client: [number, number]; view: Vec3 } | null = null
  /** Counts the arrows let go: the one still waiting on main owns the draft drawn meanwhile. */
  let placing = 0

  const drop = (ctx: ToolContext): void => {
    drag = null
    ctx.viewport.setNavigation(true)
    ctx.readout.hide()
  }

  const place = async (start: Hit, to: Vec3, ctx: ToolContext): Promise<void> => {
    const { layout, revision, camera } = ctx
    const mine = ++placing
    try {
      const from = await anchorFromHit(start, ctx.describe)
      ctx.openNote(await ctx.commit({ kind: 'arrow', author: 'user', note: '', layout, revision, camera, from, to }))
    } catch {
      // Main refused it, and whoever made `commit` has said so: there is no arrow.
    } finally {
      if (mine === placing) ctx.viewport.setDraft(null)
    }
  }

  return {
    id: 'arrow',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'down') {
        if (!e.hit || !(e.buttons & 1)) return
        const view = unit(sub(ctx.camera.target, ctx.camera.position)) ?? e.ray.direction
        drag = { start: e.hit, client: e.client, view }
        ctx.viewport.setNavigation(false)
        ctx.viewport.setHover(null)
        return
      }
      if (!drag) {
        // Nothing under way: what an arrow would start on.
        if (e.type === 'move' && e.hit && e.buttons === 0) {
          ctx.viewport.setHover(e.hit)
          ctx.readout.show(e.client, e.hit.ref)
        } else if (e.type !== 'click') {
          ctx.viewport.setHover(null)
          ctx.readout.hide()
        }
        return
      }
      if (e.type === 'cancel') {
        ctx.viewport.setDraft(null)
        return drop(ctx)
      }
      if (e.type !== 'move' && e.type !== 'up') return

      const { start, client, view } = drag
      const from = start.point
      const to = arrowHead(from, start.normal, e.ray, view, e.shift)
      const far = Math.hypot(e.client[0] - client[0], e.client[1] - client[1]) >= DRAG_PX
      if (e.type === 'move') {
        ctx.viewport.setDraft(far ? { kind: 'arrow', from, to } : null)
        const [dx, dy, dz] = sub(to, from)
        if (far) ctx.readout.show(e.client, `${Math.hypot(dx, dy, dz).toFixed(1)} mm`, `${signed(dx)}, ${signed(dy)}, ${signed(dz)}`)
        else ctx.readout.hide()
        return
      }
      drop(ctx)
      if (!far || Math.hypot(...sub(to, from)) === 0) return ctx.viewport.setDraft(null)
      // Stays drawn until main has it.
      ctx.viewport.setDraft({ kind: 'arrow', from, to })
      void place(start, to, ctx)
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      if (e.key !== 'Escape' || !drag) return false
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

import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { anchorFromHit, type Tool, type ToolContext } from './Tool'

/**
 * The pin tool: a click on a part leaves a pin there and opens its note. A
 * click beside the parts does nothing, and dragging turns the camera as ever.
 * The tool stays in hand, for the next pin.
 */
export function pinTool(): Tool {
  /** Counts the pins placed: the one still waiting on main owns the draft drawn meanwhile. */
  let placing = 0

  const place = async (hit: Hit, ctx: ToolContext): Promise<void> => {
    // As they are now: the kernel is asked before the mark is made, and the view may move meanwhile.
    const { layout, revision, camera } = ctx
    const mine = ++placing
    ctx.viewport.setDraft({ kind: 'pin', point: hit.point, normal: hit.normal })
    try {
      const anchor = await anchorFromHit(hit, ctx.describe)
      ctx.openNote(await ctx.commit({ kind: 'pin', author: 'user', note: '', layout, revision, camera, anchor }))
    } catch {
      // Main refused it, and whoever made `commit` has said so: there is no pin.
    } finally {
      if (mine === placing) ctx.viewport.setDraft(null)
    }
  }

  return {
    id: 'pin',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'click' && e.hit) void place(e.hit, ctx)
      // Once it is placed, the pin says where it is: the hover makes way for it and its note.
      if (e.type === 'click' || e.type === 'cancel' || !e.hit) {
        ctx.viewport.setHover(null)
        ctx.readout.hide()
        return
      }
      // What the pin would be on.
      ctx.viewport.setHover(e.hit)
      ctx.readout.show(e.client, e.hit.ref)
    },
    cancel(ctx: ToolContext) {
      placing += 1
      ctx.viewport.setHover(null)
      ctx.viewport.setDraft(null)
      ctx.readout.hide()
    }
  }
}

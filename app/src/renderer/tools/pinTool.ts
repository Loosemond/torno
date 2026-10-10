import { pressed } from '../../shared/keys'
import type { Hit } from '../viewport/picking'
import type { ViewportPointer } from '../viewport/Viewport'
import { anchorFromHit, clickGuard, type Tool, type ToolContext } from './Tool'

/**
 * The pin tool: a click on a part leaves a pin there and opens its note. A
 * click beside the parts does nothing, and dragging turns the camera as ever.
 * The tool stays in hand, for the next pin. A double click is one pin.
 *
 * While a mark is being put somewhere else (`ctx.replacing`), the click on a
 * part moves that mark there instead, and the tool is put down for the one
 * that was in hand before; Escape leaves the mark where it is.
 */
export function pinTool(): Tool {
  /** Counts the pins placed: the one still waiting on main owns the draft drawn meanwhile. */
  let placing = 0
  const clicks = clickGuard()

  const place = async (hit: Hit, ctx: ToolContext, kept: () => void): Promise<void> => {
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
      kept()
      if (mine === placing) ctx.viewport.setDraft(null)
    }
  }

  const move = async (id: string, hit: Hit, ctx: ToolContext, kept: () => void): Promise<void> => {
    const { revision, camera } = ctx
    const mine = ++placing
    ctx.viewport.setDraft({ kind: 'pin', point: hit.point, normal: hit.normal })
    try {
      const anchor = await anchorFromHit(hit, ctx.describe)
      await ctx.replace?.(id, { anchor, revision, camera })
    } catch {
      // Main refused it, and whoever made `replace` has said so: the mark is where it was.
    } finally {
      kept()
      if (mine === placing) ctx.viewport.setDraft(null)
      // Of this mark only: another may have been taken up to be moved while the kernel was asked about this one.
      ctx.endReplace?.(id)
    }
  }

  return {
    id: 'pin',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      const replacing = ctx.replacing ?? null
      if (e.type === 'click' && e.hit) {
        const kept = clicks.begin(e.client)
        if (kept) void (replacing === null ? place(e.hit, ctx, kept) : move(replacing, e.hit, ctx, kept))
      }
      // Beside the parts there is nothing to put it on: said, since the tool is in hand for this one thing.
      if (replacing !== null && e.type === 'move' && !e.hit && e.buttons === 0) {
        ctx.viewport.setHover(null)
        ctx.readout.say(e.client, `Click the part where ${replacing} should be. Esc leaves it where it is`)
        return
      }
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
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      if (!pressed(e, 'escape') || (ctx.replacing ?? null) === null) return false
      ctx.endReplace?.()
      return true
    },
    cancel(ctx: ToolContext) {
      placing += 1
      ctx.viewport.setHover(null)
      ctx.viewport.setDraft(null)
      ctx.readout.hide()
    }
  }
}

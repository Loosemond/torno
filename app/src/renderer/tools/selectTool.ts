import { actions, store } from '../state/store'
import type { ViewportPointer } from '../viewport/Viewport'
import type { Tool, ToolContext } from './Tool'

/** How long the pointer rests on a face or an edge before the kernel is asked what it is. */
const DESCRIBE_AFTER_MS = 150

/**
 * The select tool: what is under the pointer is marked and named beside it,
 * a click selects it, with Shift adds it or takes it out, and a click on
 * nothing clears the selection. Dragging turns the camera as ever. Where each
 * ref was clicked is remembered with it, for a note left on the selection.
 */
export function selectTool(): Tool {
  let hovered: string | null = null
  let rest: ReturnType<typeof setTimeout> | undefined
  const stop = (ctx: ToolContext): void => {
    clearTimeout(rest)
    hovered = null
    ctx.viewport.setHover(null)
    ctx.readout.hide()
  }
  return {
    id: 'select',
    cursor: 'default',
    cancel: stop,
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'click') {
        if (!e.hit) return actions.setSelection([])
        const at = { point: e.hit.point, normal: e.hit.normal }
        if (e.shift) actions.toggleSelection(e.hit.ref, at)
        else actions.setSelection([e.hit.ref], { [e.hit.ref]: at })
        return
      }
      const { hit } = e
      if (e.type === 'cancel' || !hit) return stop(ctx)

      const { ref } = hit
      const { objectId, revision } = ctx
      hovered = ref
      ctx.viewport.setHover(hit)
      const known = ctx.descriptor(ref)
      ctx.readout.show(e.client, ref, known)
      clearTimeout(rest)
      if (known !== undefined) return
      rest = setTimeout(() => {
        void ctx.describe(ref).then((said) => {
          const now = store.getState()
          if (said && hovered === ref && now.objectId === objectId && now.revision === revision) ctx.readout.describe(said.descriptor)
        })
      }, DESCRIBE_AFTER_MS)
    }
  }
}

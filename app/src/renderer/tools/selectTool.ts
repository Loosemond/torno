import { actions, store } from '../state/store'
import { toolStore } from '../state/tools'
import type { ViewportPointer } from '../viewport/Viewport'
import { REPEAT_MS, REPEAT_PX, type Tool, type ToolContext } from './Tool'
import type { Hit } from '../viewport/picking'

/** How long the pointer rests on a face or an edge before the kernel is asked what it is. */
const DESCRIBE_AFTER_MS = 150

/**
 * The select tool: what is under the pointer is marked and named beside it,
 * a click selects it, with Shift adds it or takes it out, and a click on
 * nothing clears the selection. Dragging turns the camera as ever. Where each
 * ref was clicked is remembered with it, for a note left on the selection.
 * What a click takes is the scope (`selectScope`): a face or an edge, one of the two, or the whole part; with
 * any, a double click on a face or an edge takes its part.
 */

/** The ref a hit gives in a scope: null where the scope passes it over. */
export function refInScope(hit: Pick<Hit, 'kind' | 'part' | 'ref'>, scope: string): string | null {
  if (scope === 'part') return hit.part
  if (scope === 'face' || scope === 'edge') return hit.kind === scope ? hit.ref : null
  return hit.ref
}

export function selectTool(): Tool {
  let hovered: string | null = null
  let rest: ReturnType<typeof setTimeout> | undefined
  let last: { part: string; client: [number, number]; at: number } | null = null
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
        if (!e.hit) {
          last = null
          return actions.setSelection([])
        }
        const scope = toolStore.getState().selectScope
        const now = performance.now()
        const twice = scope === 'any' && !e.shift && last !== null && last.part === e.hit.part && now - last.at <= REPEAT_MS && Math.hypot(e.client[0] - last.client[0], e.client[1] - last.client[1]) <= REPEAT_PX
        last = twice || e.shift ? null : { part: e.hit.part, client: e.client, at: now }
        const ref = twice ? e.hit.part : refInScope(e.hit, scope)
        if (ref === null) return
        const at = { point: e.hit.point, normal: e.hit.normal }
        if (e.shift) actions.toggleSelection(ref, at)
        else actions.setSelection([ref], { [ref]: at })
        return
      }
      const { hit } = e
      if (e.type === 'cancel' || !hit) return stop(ctx)
      const ref = refInScope(hit, toolStore.getState().selectScope)
      if (ref === null) return stop(ctx)
      const { objectId, revision } = ctx
      hovered = ref
      ctx.viewport.setHover({ ...hit, ref })
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

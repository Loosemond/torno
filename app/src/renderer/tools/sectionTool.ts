import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Vec3 } from '../../shared/marks'
import type { SectionPlane } from '../../shared/view'
import { actions, store } from '../state/store'
import type { Hit } from '../viewport/picking'
import { atOffset, planeFromFace, planeRect, sectionExtent, sectionOffset, shownMm } from '../viewport/section'
import type { ViewportPointer } from '../viewport/Viewport'
import { DESCRIBE_WITHIN_MS, DRAG_PX, dot, sub, within, type Tool, type ToolContext } from './Tool'

/** Whether the next click on a flat face puts the plane on it. It changes on a click or a key, never on a pointer move. */
export const sectionStore = createStore<{ fromFace: boolean }>(() => ({ fromFace: false }))

export function useFromFace(): boolean {
  return useZustand(sectionStore, (s) => s.fromFace)
}

/** Wait for a click on a flat face to put the plane on, or stop waiting. */
export function setFromFace(fromFace: boolean): void {
  if (sectionStore.getState().fromFace !== fromFace) sectionStore.setState({ fromFace })
}

/** Said at the pointer while a face is waited for. */
export const PICK_A_FACE = 'Click a flat face to put the plane on it'
export const NOT_FLAT = 'That face is not flat: the plane needs a flat one'

/** Looking along the plane's normal more nearly than this (as a cosine), a drag has no way along it on screen: it goes by its height instead. */
const ALONG_VIEW = 0.98
/** How many pixels of such a drag take the plane across the whole of the parts. */
const ACROSS_PX = 300

/**
 * How far along a line a pointer's ray passes it: the distance from `at`
 * along `normal` (of length 1) of the point of the line nearest to the ray.
 * Null when the ray runs along the line: every point of it is as near.
 */
export function alongNormal(ray: { origin: Vec3; direction: Vec3 }, at: Vec3, normal: Vec3): number | null {
  const b = dot(normal, ray.direction)
  if (Math.abs(b) > ALONG_VIEW) return null
  const w = sub(at, ray.origin)
  return (b * dot(ray.direction, w) - dot(normal, w)) / (1 - b * b)
}

interface Drag {
  /** The plane when the button went down, and how far along its normal the pointer was then (null when the view looks along it). */
  from: SectionPlane
  at: Vec3
  start: number | null
  client: [number, number]
  /** The plane as the drag has it now; null until the pointer has gone far enough to be dragging. */
  to: SectionPlane | null
}

/**
 * The section tool: with a plane on, dragging anywhere in the viewport moves
 * it along its normal (with Alt the drag turns the camera, as with any tool
 * that takes every press), and the arrow keys nudge it by a millimetre, with
 * Shift by a tenth. While a face is waited for (`sectionStore.fromFace`), a
 * click on a flat face puts the plane on it instead; the kernel says whether
 * it is flat, and which way it faces.
 *
 * The plane moves in the viewport with every move of the drag and is kept
 * (`actions.setSection`) once, when the drag is let go.
 */
export function sectionTool(): Tool {
  let drag: Drag | null = null

  const moved = (e: ViewportPointer, d: Drag, ctx: ToolContext): SectionPlane => {
    const box = ctx.viewport.sectionBox?.() ?? ctx.viewport.bounds()
    const { min, max } = sectionExtent(box, d.from.normal)
    const now = d.start === null ? null : alongNormal(e.ray, d.at, d.from.normal)
    // Up the screen is along the normal where the view gives no other way of telling.
    const by = now === null || d.start === null ? ((d.client[1] - e.client[1]) / ACROSS_PX) * (max - min) : now - d.start
    return atOffset(d.from, box, sectionOffset(d.from, box) + by)
  }

  const end = (ctx: ToolContext): void => {
    const d = drag
    drag = null
    ctx.viewport.setNavigation(true)
    ctx.readout.hide()
    if (d?.to) actions.setSection(d.to)
  }

  const fromFace = async (hit: Hit, ctx: ToolContext, client: [number, number]): Promise<void> => {
    const { objectId, revision, layout } = ctx
    const said = await within(ctx.describe(hit.ref), DESCRIBE_WITHIN_MS)
    const now = store.getState()
    if (now.objectId !== objectId || now.revision !== revision || now.layout !== layout || !sectionStore.getState().fromFace) return
    if (said?.kind === 'face' && said.type !== 'plane') return ctx.readout.say(client, NOT_FLAT)
    // The kernel's normal is exact; which of its two ways is out of the part, the surface under the pointer says.
    let normal = hit.normal
    if (said?.kind === 'face' && said.normal) normal = hit.normal && dot(said.normal, hit.normal) < 0 ? (said.normal.map((c) => -c) as Vec3) : said.normal
    const plane = planeFromFace({ point: hit.point, normal })
    if (!plane) return
    setFromFace(false)
    ctx.viewport.setHover(null)
    ctx.readout.hide()
    actions.setSection(plane)
  }

  return {
    id: 'section',
    cursor: 'ns-resize',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (sectionStore.getState().fromFace) {
        if (e.type === 'click') {
          // The face under the pointer, also within reach of one of its edges.
          const face = e.hit?.kind === 'face' ? e.hit : ctx.viewport.pick(e.client[0], e.client[1], { edges: false })
          if (face) void fromFace(face, ctx, e.client)
          return
        }
        if (e.type === 'cancel') {
          ctx.viewport.setHover(null)
          return ctx.readout.hide()
        }
        if (e.buttons !== 0) return // turning the camera to find the face
        ctx.viewport.setHover(e.hit?.kind === 'face' ? e.hit : null)
        if (e.hit?.kind === 'face') ctx.readout.show(e.client, e.hit.ref, ctx.descriptor(e.hit.ref))
        else ctx.readout.say(e.client, PICK_A_FACE)
        return
      }

      if (e.type === 'down') {
        const plane = ctx.viewport.getSection?.() ?? null
        // With Alt the press is the camera's.
        if (!(e.buttons & 1) || e.alt || !plane) return
        const at = planeRect(plane, ctx.viewport.sectionBox?.() ?? ctx.viewport.bounds()).centre
        drag = { from: plane, at, start: alongNormal(e.ray, at, plane.normal), client: e.client, to: null }
        ctx.viewport.setNavigation(false, { wheel: true })
        return
      }
      if (!drag) return
      if (e.type === 'cancel' || e.type === 'up' || !(e.buttons & 1)) return end(ctx)
      if (e.type !== 'move') return
      if (!drag.to && Math.hypot(e.client[0] - drag.client[0], e.client[1] - drag.client[1]) < DRAG_PX) return
      drag.to = moved(e, drag, ctx)
      ctx.viewport.setSection?.(drag.to)
      ctx.readout.show(e.client, `${shownMm(sectionOffset(drag.to, ctx.viewport.sectionBox?.() ?? ctx.viewport.bounds()))} mm`)
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      if (e.key === 'Escape' && sectionStore.getState().fromFace) {
        setFromFace(false)
        ctx.viewport.setHover(null)
        ctx.readout.hide()
        return true
      }
      const way = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
      const plane = store.getState().section
      if (way === 0 || !plane || drag) return false
      const box = ctx.viewport.sectionBox?.() ?? ctx.viewport.bounds()
      // To the micron: tenths added up are not tenths to the last digit.
      actions.setSection(atOffset(plane, box, Math.round((sectionOffset(plane, box) + way * (e.shiftKey ? 0.1 : 1)) * 1000) / 1000))
      return true
    },
    cancel(ctx: ToolContext) {
      if (drag) end(ctx)
      setFromFace(false)
      ctx.viewport.setHover(null)
      ctx.readout.hide()
    }
  }
}

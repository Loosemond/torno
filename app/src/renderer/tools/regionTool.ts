import * as THREE from 'three'
import type { Camera } from '../../shared/view'
import { alignStore, scanInHand } from '../state/align'
import { NOTHING_PAINTED_STATE, radiusOf, regionStore, usualRadius } from '../state/region'
import { actions, store } from '../state/store'
import { toolStore } from '../state/tools'
import { TriangleSet, gatherBox, gatherSphere, growFlat } from '../viewport/scanPaint'
import { type ScanHit, meshOf } from '../viewport/scans'
import type { Viewport, ViewportPointer } from '../viewport/Viewport'
import { boxOutline, boxPlanes } from './regionBox'
import { tintRegions } from './regionTints'
import { DRAG_PX, type Tool, type ToolContext, type ToolViewport } from './Tool'

export { boxPlanes }

// The Region tool: the person paints the part of a scan they want to name, and keeps it as a mark. What is
// painted is a set of the scan's triangles, held here and drawn by the viewport; nothing of a stroke goes
// through React or the store until the stroke ends. Main keeps the region: it is sent the bits and works out
// the rest from the mesh.

export const NO_SCAN = 'Import a scan first'
export const NOT_INDEXED = 'The scan is still being indexed'
export const NOTHING_PAINTED = 'Paint some of the scan first: a region needs at least one triangle'
export const CHOOSE_SCAN = 'Press on the scan to paint on'
export function paintingOn(scan: string): string {
  return `Painting on ${scan}: keep or clear that first`
}
function readAgain(scan: string): string {
  return `${scan} was read again: what was painted on it was of the mesh it had`
}

/** `[` and `]` change the brush's radius by a quarter. */
const BRUSH_STEP = 1.25
/** Grow to flat: how far off the plane, how far turned from it, how far it reaches in brush radii, and the most it adds. */
const GROW = { flat: 2, degrees: 15, reach: 2, most: 200_000 }
/** Between two events of a stroke the brush is set down this many radii apart, and no more often than this. */
const STAMP_EVERY = 0.5
const MOST_STAMPS = 48

type Painter = Pick<ToolViewport, 'paintScan' | 'scanTree' | 'showBrush'>
/** What one stroke, one box or one growing changed: taken back as one. */
interface Step { added: number[]; removed: number[] }
interface Painting {
  objectId: string
  scan: string
  /** Which mesh of that scan it is of (`meshOf`): read again, the scan has another. */
  mesh: string
  set: TriangleSet
  /** Its area in the scan's own millimetres. */
  area: number
  steps: Step[]
  viewport: Painter
  paint: { touched(): void } | null
}

/** What is painted and not yet kept: one set, on one scan of one object, whichever viewport draws it. */
let painting: Painting | null = null
/** Main has been asked to keep it. */
let sending = false
/** Where the pointer last was, for what is said from a key or a button. */
let lastClient: [number, number] = [0, 0]
/** The viewport of the window, for what the bar asks with no pointer event at hand (`connectRegion`). */
let host: Pick<Viewport, 'getCamera' | 'paintScan' | 'scanTree' | 'showBrush'> | null = null

const a = new THREE.Vector3()
const b = new THREE.Vector3()
const c = new THREE.Vector3()

/** The area of a triangle of a geometry, in its own units. */
function areaOf(geometry: THREE.BufferGeometry, triangle: number): number {
  const position = geometry.getAttribute('position')
  const index = geometry.index!.array
  a.fromBufferAttribute(position, index[triangle * 3])
  b.fromBufferAttribute(position, index[triangle * 3 + 1]).sub(a)
  c.fromBufferAttribute(position, index[triangle * 3 + 2]).sub(a)
  return b.cross(c).length() / 2
}

/** Says in the bar how much is painted: once a stroke has ended, never during one. */
function publish(): void {
  const scale = painting ? (painting.viewport.scanTree?.(painting.scan)?.built.group.scale.x ?? 1) : 1
  regionStore.setState(painting ? { scan: painting.scan, count: painting.set.count, area: painting.area * scale * scale, canUndo: painting.steps.length > 0 } : NOTHING_PAINTED_STATE)
}

/** Puts down what is painted, without keeping it. */
function drop(notice: string | null = null): void {
  painting?.viewport.paintScan?.(null, null)
  painting = null
  regionStore.setState({ ...NOTHING_PAINTED_STATE, refused: null, notice })
}

/** What is painted is of a scan of the object on show, and of the mesh that scan has: of anything else it is dropped. */
function stillThere(): void {
  if (!painting) return
  const s = store.getState()
  const scan = s.objectId === painting.objectId ? s.scans.find((one) => one.id === painting!.scan) : undefined
  if (!scan) drop()
  else if (meshOf(scan) !== painting.mesh) drop(readAgain(scan.id))
}

/** Empties what is painted: "Clear". */
export function clearRegion(): void {
  drop()
}

/** Takes back the last stroke, box or growing. */
export function undoStroke(): void {
  stillThere()
  const step = painting?.steps.pop()
  if (!painting || !step) return
  const geometry = painting.viewport.scanTree?.(painting.scan)?.built.mesh.geometry
  for (const t of step.added) if (painting.set.delete(t) && geometry) painting.area -= areaOf(geometry, t)
  for (const t of step.removed) if (painting.set.add(t) && geometry) painting.area += areaOf(geometry, t)
  if (painting.set.count === 0) painting.area = 0
  painting.paint?.touched()
  publish()
}

/** The brush's radius on a scan, in millimetres of the view: the one chosen, or the usual share of the scan's size as it stands. */
function brushRadius(scan: string, viewport: Painter): number {
  const chosen = radiusOf(regionStore.getState().radius)
  if (chosen !== null) return chosen
  const info = store.getState().scans.find((one) => one.id === scan)
  return info ? usualRadius(info, viewport.scanTree?.(scan)?.built.group.scale.x ?? 1) : 1
}

/** Grows what is painted over what lies flat with it: "Grow to flat". One step, taken back as one. */
export function growRegion(): void {
  stillThere()
  if (!painting || painting.set.count === 0) return void regionStore.setState({ notice: NOTHING_PAINTED })
  const found = painting.viewport.scanTree?.(painting.scan)
  if (!found) return
  const scale = found.built.group.scale.x
  const before = painting.set.bits.slice()
  growFlat(found.tree, found.built.mesh.geometry, painting.set, { flat: GROW.flat / scale, degrees: GROW.degrees, reach: (GROW.reach * brushRadius(painting.scan, painting.viewport)) / scale, most: GROW.most })
  const step: Step = { added: [], removed: [] }
  painting.set.forEach((t) => {
    if ((before[t >> 3] & (1 << (t & 7))) !== 0) return
    step.added.push(t)
    painting!.area += areaOf(found.built.mesh.geometry, t)
  })
  if (step.added.length > 0) painting.steps.push(step)
  painting.paint?.touched()
  publish()
}

type Keeper = Pick<ToolContext, 'layout' | 'revision' | 'camera' | 'openNote' | 'readout'>

/**
 * Has main keep what is painted as a region mark, and opens its note: "Keep", and Enter. Main is sent the scan
 * and the bits and says the rest. A set with no triangle is not sent. What main refuses is said, at the pointer
 * and in the bar, and what was painted stays in hand.
 */
export async function keepRegion(ctx?: Keeper): Promise<void> {
  stillThere()
  if (sending) return
  const say = (text: string): void => {
    ctx?.readout.say(lastClient, text)
  }
  const hand = painting
  if (!hand || hand.set.count === 0) {
    regionStore.setState({ notice: NOTHING_PAINTED })
    return say(NOTHING_PAINTED)
  }
  const s = store.getState()
  const camera: Camera | undefined = ctx?.camera ?? host?.getCamera()
  if (!camera) return
  sending = true
  regionStore.setState({ sending: true, refused: null, notice: null })
  try {
    const mark = await window.torno.marks.addRegion(hand.objectId, { scan: hand.scan, note: '', layout: ctx?.layout ?? s.layout, revision: ctx?.revision ?? s.revision, camera, bits: hand.set.bits.slice() })
    sending = false
    // What was in hand went into it.
    if (painting === hand) drop()
    else regionStore.setState({ sending: false })
    if (ctx) ctx.openNote(mark)
    else actions.openNote({ objectId: hand.objectId, layout: mark.layout, id: mark.id })
  } catch (e) {
    sending = false
    const message = e instanceof Error ? e.message : String(e)
    regionStore.setState({ sending: false, refused: message })
    say(message)
  }
}

export function regionTool(): Tool {
  /** What a held press is doing: a stroke of the brush, or a box. */
  let drag:
    | { kind: 'stroke'; erase: boolean; step: Step; last: THREE.Vector3 | null }
    | { kind: 'box'; erase: boolean; from: ViewportPointer; outline: ReturnType<typeof boxOutline> }
    | null = null
  const inverse = new THREE.Matrix4()
  const centre = new THREE.Vector3()
  const towards = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const along = new THREE.Vector3()

  /** Whether a triangle of a scan faces away from a direction, in the scan's own frame: it is seen from behind, as every triangle of a scan wound the other way round is. */
  const facesAway = (found: NonNullable<ReturnType<Viewport['scanTree']>>, triangle: number, to: THREE.Vector3): boolean => {
    const index = found.built.mesh.geometry.index!.array
    const position = found.built.mesh.geometry.getAttribute('position')
    if (!(triangle >= 0 && triangle * 3 + 2 < index.length)) return false
    a.fromBufferAttribute(position, index[triangle * 3])
    b.fromBufferAttribute(position, index[triangle * 3 + 1]).sub(a)
    c.fromBufferAttribute(position, index[triangle * 3 + 2]).sub(a)
    return normal.copy(b).cross(c).dot(to) < 0
  }

  /** Takes up a scan to paint on, or the one already in hand; null, having said why, when it cannot be painted on. */
  const begin = (scan: string, e: ViewportPointer, ctx: ToolContext): Painting | null => {
    if (painting) {
      if (painting.scan === scan) return painting
      ctx.readout.say(e.client, paintingOn(painting.scan))
      return null
    }
    const info = store.getState().scans.find((one) => one.id === scan)
    const found = ctx.viewport.scanTree?.(scan)
    if (!info || !found) {
      ctx.readout.say(e.client, NOT_INDEXED)
      return null
    }
    const set = new TriangleSet(found.built.triangles)
    painting = { objectId: ctx.objectId, scan, mesh: meshOf(info), set, area: 0, steps: [], viewport: ctx.viewport, paint: ctx.viewport.paintScan?.(scan, set) ?? null }
    regionStore.setState({ scan, refused: null, notice: null })
    return painting
  }

  /** Sets the brush down at a point of the scan's own frame: takes what is under it, or takes it out. */
  const stamp = (hand: Painting, found: NonNullable<ReturnType<Viewport['scanTree']>>, at: THREE.Vector3, radius: number, erase: boolean, step: Step): void => {
    const { geometry } = found.built.mesh
    gatherSphere(found.tree, geometry, at, radius, towards, (t) => {
      if (erase) {
        if (!hand.set.delete(t)) return
        step.removed.push(t)
        hand.area -= areaOf(geometry, t)
      } else {
        if (!hand.set.add(t)) return
        step.added.push(t)
        hand.area += areaOf(geometry, t)
      }
    })
  }

  /** The brush at what the pointer is on, as a stroke goes: set down along the way from where it last was. */
  const brush = (e: ViewportPointer, hit: ScanHit, ctx: ToolContext): void => {
    if (drag?.kind !== 'stroke' || !painting) return
    const found = ctx.viewport.scanTree?.(painting.scan)
    if (!found) return
    const scale = found.built.group.scale.x
    const radius = brushRadius(painting.scan, ctx.viewport) / scale
    inverse.copy(found.built.group.matrix).invert()
    // The way the triangle under the pointer faces: those that face the same way are taken, whichever way the scan is wound.
    towards.fromArray(e.ray.direction).negate().transformDirection(inverse)
    if (facesAway(found, hit.triangle, towards)) towards.negate()
    centre.fromArray(hit.local)
    const from = drag.last
    if (from) {
      const steps = Math.min(Math.floor(from.distanceTo(centre) / (radius * STAMP_EVERY)), MOST_STAMPS)
      for (let n = 1; n < steps; n++) stamp(painting, found, along.copy(from).lerp(centre, n / steps), radius, drag.erase, drag.step)
    }
    stamp(painting, found, centre, radius, drag.erase, drag.step)
    drag.last = (drag.last ?? new THREE.Vector3()).copy(centre)
    painting.paint?.touched()
  }

  const ring = (hit: ScanHit | null, ctx: ToolContext, erase: boolean): void => {
    const shown = hit && (!painting || painting.scan === hit.scan) && regionStore.getState().mode === 'brush'
    ctx.viewport.showBrush?.(shown ? { centre: hit.point, normal: hit.normal, radius: brushRadius(hit.scan, ctx.viewport), erase } : null)
  }

  /** The press is let go, or cut short: what it changed is one step, and the bar is told how much is painted. */
  const end = (ctx: ToolContext, e?: ViewportPointer): void => {
    if (!drag) return
    const was = drag
    drag = null
    ctx.viewport.setNavigation(true)
    if (was.kind === 'box') {
      was.outline.remove()
      if (e && painting) box(was.from, e, was.erase, ctx)
    } else if (painting && was.step.added.length + was.step.removed.length > 0) painting.steps.push(was.step)
    if (painting && painting.set.count === 0) painting.area = 0
    publish()
  }

  /** Takes what a rectangle of the screen goes round, between where it was pressed and where it was let go. */
  const box = (from: ViewportPointer, to: ViewportPointer, erase: boolean, ctx: ToolContext): void => {
    if (!painting || Math.hypot(to.client[0] - from.client[0], to.client[1] - from.client[1]) < DRAG_PX) return
    const found = ctx.viewport.scanTree?.(painting.scan)
    const planes = boxPlanes(ctx.camera, from.ray, to.ray)
    if (!found || !planes) return
    inverse.copy(found.built.group.matrix).invert()
    // Where the eye is: a point for a camera that has one, far back along its rays for one that has none.
    const eye = new THREE.Vector3().fromArray(from.ray.origin)
    if (ctx.camera.ortho) eye.addScaledVector(new THREE.Vector3().fromArray(from.ray.direction), -1e7)
    const { geometry } = found.built.mesh
    const step: Step = { added: [], removed: [] }
    const hand = painting
    // What is seen in the middle of the box says which way round the scan shows itself there: that side is taken.
    const seen = ctx.viewport.pickScan((from.client[0] + to.client[0]) / 2, (from.client[1] + to.client[1]) / 2)
    const away = seen?.scan === hand.scan && facesAway(found, seen.triangle, towards.fromArray(from.ray.direction).negate().transformDirection(inverse))
    const take = (t: number): void => {
      if (erase) {
        if (!hand.set.delete(t)) return
        step.removed.push(t)
        hand.area -= areaOf(geometry, t)
      } else {
        if (!hand.set.add(t)) return
        step.added.push(t)
        hand.area += areaOf(geometry, t)
      }
    }
    gatherBox(found.tree, geometry, planes.map((plane) => plane.clone().applyMatrix4(inverse)), eye.applyMatrix4(inverse), take, away)
    if (step.added.length + step.removed.length > 0) hand.steps.push(step)
    hand.paint?.touched()
  }

  return {
    id: 'region',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      lastClient = e.client
      stillThere()
      const { scans } = store.getState()
      const erasing = regionStore.getState().erase || e.ctrl === true
      if (e.type === 'cancel') {
        end(ctx)
        ctx.viewport.showBrush?.(null)
        return
      }
      if (drag) {
        // Let go, or a move with no button held: a release that was not seen.
        if (e.type === 'up' || (e.type === 'move' && !(e.buttons & 1))) return end(ctx, e.type === 'up' ? e : undefined)
        if (e.type !== 'move') return
        if (drag.kind === 'box') return drag.outline.set(drag.from.client, e.client)
        const hit = ctx.viewport.pickScan(e.client[0], e.client[1])
        const on = hit && painting && hit.scan === painting.scan ? hit : null
        // Off the scan the stroke is not carried across: it begins again where the pointer comes back on.
        if (on) brush(e, on, ctx)
        else drag.last = null
        ring(on, ctx, drag.erase)
        return
      }
      if (scans.length === 0) {
        ctx.viewport.showBrush?.(null)
        if (e.type === 'down' || (e.type === 'move' && e.buttons === 0)) ctx.readout.say(e.client, NO_SCAN)
        return
      }
      if (e.type === 'down') {
        // With Alt the press is the camera's, as with every tool that takes a press.
        if (!(e.buttons & 1) || e.alt) return
        const hit = ctx.viewport.pickScan(e.client[0], e.client[1])
        if (e.shift || regionStore.getState().mode === 'box') {
          const scan = painting?.scan ?? scanInHand(alignStore.getState().scan, scans)?.id ?? hit?.scan
          if (scan === undefined) return ctx.readout.say(e.client, CHOOSE_SCAN)
          if (!begin(scan, e, ctx)) return
          const outline = boxOutline(ctx.viewport.canvas)
          outline.set(e.client, e.client)
          drag = { kind: 'box', erase: erasing, from: e, outline }
          ctx.viewport.setNavigation(false, { wheel: true })
          ctx.viewport.showBrush?.(null)
          ctx.readout.hide()
          return
        }
        // Beside the scan the press is the camera's.
        if (!hit || !begin(hit.scan, e, ctx)) return
        drag = { kind: 'stroke', erase: erasing, step: { added: [], removed: [] }, last: null }
        ctx.viewport.setNavigation(false, { wheel: true })
        ctx.readout.hide()
        brush(e, hit, ctx)
        ring(hit, ctx, erasing)
        return
      }
      if (e.type === 'move' && e.buttons === 0) {
        ring(ctx.viewport.pickScan(e.client[0], e.client[1]), ctx, erasing)
        ctx.readout.hide()
      }
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === '[' || key === ']') {
        const scan = painting?.scan ?? scanInHand(alignStore.getState().scan, store.getState().scans)?.id
        const now = radiusOf(regionStore.getState().radius) ?? (scan === undefined ? null : brushRadius(scan, ctx.viewport))
        if (now !== null) regionStore.setState({ radius: radiusOf(key === ']' ? now * BRUSH_STEP : now / BRUSH_STEP) })
        return true
      }
      if (key === 'e') return regionStore.setState({ erase: !regionStore.getState().erase }), true
      if (key === 'z') return undoStroke(), true
      if (key === 'Enter') {
        // On a button of the bar Enter is that button's: it is not also "Keep".
        if (typeof Element !== 'undefined' && e.target instanceof Element && e.target.closest('button')) return false
        return void keepRegion(ctx), true
      }
      if (key === 'Escape') {
        // Leaves without keeping: what was painted is put down, and the pane puts the tool down after it.
        end(ctx)
        drop()
        ctx.viewport.showBrush?.(null)
        return false
      }
      return false
    },
    cancel(ctx: ToolContext) {
      end(ctx)
      ctx.viewport.showBrush?.(null)
    }
  }
}

/**
 * Joins the Region tool to a viewport: the regions kept are tinted on their scans (`tintRegions`); what is
 * painted is drawn only while the tool is in hand, and dropped with its object or its scan. Returns what
 * undoes it.
 */
export function connectRegion(viewport: Pick<Viewport, 'getCamera' | 'paintScan' | 'scanTree' | 'showBrush' | 'setRegions'>): () => void {
  host = viewport
  const offTints = tintRegions(viewport)
  const offStore = store.subscribe((s, prev) => {
    if (s.scans !== prev.scans || s.objectId !== prev.objectId) stillThere()
  })
  // What is painted is on show while the tool is in hand, and is put away, not dropped, while another is.
  const offTool = toolStore.subscribe((t, prev) => {
    if (t.tool === prev.tool || !painting) return
    if (t.tool === 'region') painting.paint = viewport.paintScan(painting.scan, painting.set)
    else if (prev.tool === 'region') {
      viewport.paintScan(null, null)
      painting.paint = null
    }
  })
  return () => {
    offStore()
    offTool()
    offTints()
    drop()
    host = null
  }
}

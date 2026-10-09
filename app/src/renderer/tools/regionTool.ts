import * as THREE from 'three'
import { count } from '../../shared/format'
import type { RegionMark } from '../../shared/marks'
import { maskStem } from '../../shared/regions'
import { maskBits } from '../../shared/scans'
import type { Camera } from '../../shared/view'
import { alignStore, scanInHand } from '../state/align'
import { NOTHING_PAINTED_STATE, radiusOf, regionStore, usualRadius } from '../state/region'
import { actions, store } from '../state/store'
import { setTool, toolStore } from '../state/tools'
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
//
// A painting is never lost by accident. Only "Clear" discards one, and Undo brings that back while the tool is
// in hand. Another tool, Escape, another object: the painting waits, of its object and its scan, and is there
// when the person comes back (in this run: it is not saved). It goes only with its scan, or with the mesh it
// was painted on, and then the bar says so.

export const NO_SCAN = 'Import a scan first'
export const NOT_INDEXED = 'The scan is still being indexed'
export const NOTHING_PAINTED = 'Paint some of the scan first: a region needs at least one triangle'
export const CHOOSE_SCAN = 'Press on the scan to paint on'
export const KEEPING = 'Keeping it: paint on once it is kept'
export const IN_HAND = 'Keep or clear the painting in hand first'
export const CLEARED = 'Cleared. Undo brings it back'
export function paintingOn(scan: string): string {
  return `Painting on ${scan}: keep or clear that first`
}
/** Said in the bar when a painting that waited is in hand again. */
export function waiting(triangles: number, scan: string): string {
  return `A painting of ${count(triangles)} ${triangles === 1 ? 'triangle' : 'triangles'} on ${scan} is waiting: Keep or Clear, or paint on`
}
function readAgain(scan: string): string {
  return `${scan} was read again: what was painted on it was of the mesh it had`
}
function scanGone(scan: string): string {
  return `${scan} is gone: what was painted on it went with it`
}

/** `[` and `]` change the brush's radius by a quarter. */
const BRUSH_STEP = 1.25
/** Grow to flat: how far off the plane, how far turned from it, how far it reaches in brush radii, and the most it adds. */
const GROW = { flat: 2, degrees: 15, reach: 2, most: 200_000 }
/** Between two events of a stroke the brush is set down this many radii apart, and no more often than this. */
const STAMP_EVERY = 0.5
const MOST_STAMPS = 48
/** A part this much nearer than the scan along the pointer's ray is in front of it: the scan is not what is seen there. */
const IN_FRONT_MM = 1e-3

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
  /** The kept region it is a painting-again of, by its mark's number; absent for a new one. */
  editing?: string
}

/** What is painted and not yet kept, by object: one painting of one scan each, waiting while another object is on show. */
const paintings = new Map<string, Painting>()
/** What "Clear" last put down, by object: Undo brings it back until something else is painted. */
const cleared = new Map<string, Painting>()
/** The painting the viewport draws now, and what tells the tint that it changed. */
let drawn: { of: Painting; on: Painter; paint: { touched(): void } | null } | null = null
/** Main has been asked to keep it. */
let sending = false
/** Where the pointer last was, for what is said from a key or a button. */
let lastClient: [number, number] = [0, 0]
/** The viewport that draws: the window's (`connectRegion`), or the one the last pointer event came from. */
let painter: Painter | null = null
let host: Pick<Viewport, 'getCamera'> | null = null

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

/**
 * The painting of the object on show, if it has one: it goes only when its scan is gone or is another mesh than
 * it was painted on, and the bar then says which.
 */
function current(): Painting | null {
  const s = store.getState()
  const mine = s.objectId === null ? undefined : paintings.get(s.objectId)
  if (!mine) return null
  const scan = s.scans.find((one) => one.id === mine.scan)
  if (scan && meshOf(scan) === mine.mesh) return mine
  paintings.delete(mine.objectId)
  regionStore.setState({ notice: scan ? readAgain(mine.scan) : scanGone(mine.scan), refused: null })
  return null
}

/** Has the viewport draw the painting of the object on show while the tool is in hand, and none otherwise: it waits unseen. */
function show(): void {
  const wanted = toolStore.getState().tool === 'region' ? current() : null
  if (drawn && (drawn.of !== wanted || drawn.on !== painter)) {
    drawn.on.paintScan?.(null, null)
    drawn = null
  }
  if (wanted && !drawn && painter) drawn = { of: wanted, on: painter, paint: painter.paintScan?.(wanted.scan, wanted.set) ?? null }
}

/** Says in the bar how much is painted: once a stroke has ended, never during one. */
function publish(): void {
  const mine = current()
  show()
  const objectId = store.getState().objectId
  const back = objectId !== null && cleared.has(objectId)
  if (!mine) return regionStore.setState({ ...NOTHING_PAINTED_STATE, editing: null, canUndo: back })
  const scale = painter?.scanTree?.(mine.scan)?.built.group.scale.x ?? 1
  regionStore.setState({ scan: mine.scan, count: mine.set.count, area: mine.area * scale * scale, canUndo: mine.steps.length > 0, editing: mine.editing ?? null })
}

/** Puts down what is painted, without keeping it: "Clear", the one way a painting is discarded. Undo brings it back. */
export function clearRegion(): void {
  const mine = current()
  if (!mine) return
  paintings.delete(mine.objectId)
  if (mine.set.count > 0) cleared.set(mine.objectId, mine)
  regionStore.setState({ refused: null, notice: mine.set.count > 0 ? CLEARED : null })
  publish()
}

/** Takes back the last stroke, box or growing; with nothing painted, what "Clear" last put down. */
export function undoStroke(): void {
  const mine = current()
  const objectId = store.getState().objectId
  if (!mine) {
    const back = objectId === null ? undefined : cleared.get(objectId)
    if (!back) return
    cleared.delete(back.objectId)
    paintings.set(back.objectId, back)
    regionStore.setState({ notice: null })
    return publish()
  }
  const step = mine.steps.pop()
  if (!step) return
  const geometry = painter?.scanTree?.(mine.scan)?.built.mesh.geometry
  for (const t of step.added) if (mine.set.delete(t) && geometry) mine.area -= areaOf(geometry, t)
  for (const t of step.removed) if (mine.set.add(t) && geometry) mine.area += areaOf(geometry, t)
  if (mine.set.count === 0) mine.area = 0
  drawn?.paint?.touched()
  publish()
}

/** The brush's radius on a scan, in millimetres of the view: the one chosen, or the usual share of the scan's size as it stands. */
function brushRadius(scan: string, viewport: Painter): number {
  const chosen = radiusOf(regionStore.getState().radius)
  if (chosen !== null) return chosen
  const info = store.getState().scans.find((one) => one.id === scan)
  return info ? usualRadius(info, viewport.scanTree?.(scan)?.built.group.scale.x ?? 1) : 1
}

/** Grows what is painted over what lies flat with it: "Grow to flat". One step, taken back as one. Says when it stopped at the most it adds at once. */
export function growRegion(): void {
  const mine = current()
  if (!mine || mine.set.count === 0) return void regionStore.setState({ notice: NOTHING_PAINTED })
  const found = painter?.scanTree?.(mine.scan)
  if (!found || !painter) return
  const scale = found.built.group.scale.x
  const before = mine.set.bits.slice()
  const grown = growFlat(found.tree, found.built.mesh.geometry, mine.set, { flat: GROW.flat / scale, degrees: GROW.degrees, reach: (GROW.reach * brushRadius(mine.scan, painter)) / scale, most: GROW.most })
  const step: Step = { added: [], removed: [] }
  mine.set.forEach((t) => {
    if ((before[t >> 3] & (1 << (t & 7))) !== 0) return
    step.added.push(t)
    mine.area += areaOf(found.built.mesh.geometry, t)
  })
  if (step.added.length > 0) mine.steps.push(step)
  drawn?.paint?.touched()
  regionStore.setState({ notice: grown >= GROW.most ? `Grew by ${count(grown)} triangles, the most at once: grow again to go on` : grown === 0 ? 'Nothing flat with it is within reach' : null })
  publish()
}

type Keeper = Pick<ToolContext, 'layout' | 'revision' | 'camera' | 'openNote' | 'readout'>

/**
 * Has main keep what is painted: "Keep", and Enter. A new painting becomes a region mark, whose note then
 * opens; a painting-again of a kept region becomes that region's triangles. Main is sent the bits and says the
 * rest. A set with no triangle is not sent. What main refuses is said, at the pointer and in the bar, and what
 * was painted stays in hand.
 */
export async function keepRegion(ctx?: Keeper): Promise<void> {
  if (sending) return
  const say = (text: string): void => {
    ctx?.readout.say(lastClient, text)
  }
  const hand = current()
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
    const bits = hand.set.bits.slice()
    const mark = hand.editing ? await window.torno.marks.repaintRegion(hand.objectId, hand.editing, bits) : await window.torno.marks.addRegion(hand.objectId, { scan: hand.scan, note: '', layout: ctx?.layout ?? s.layout, revision: ctx?.revision ?? s.revision, camera, bits })
    sending = false
    regionStore.setState({ sending: false })
    // What was in hand went into it.
    if (paintings.get(hand.objectId) === hand) paintings.delete(hand.objectId)
    cleared.delete(hand.objectId)
    publish()
    if (hand.editing) return
    // A region is of its scan in every layout: its note opens in the one on show.
    if (ctx) ctx.openNote(mark)
    else actions.openNote({ objectId: hand.objectId, layout: store.getState().layout, id: mark.id })
  } catch (e) {
    sending = false
    const message = e instanceof Error ? e.message : String(e)
    regionStore.setState({ sending: false, refused: message })
    say(message)
  }
}

/**
 * Takes a kept region in hand to paint it again: "Edit" on its row. Its triangles, asked of main, are the
 * painting; "Keep" then makes them the region's. Not while another painting is in hand.
 */
export async function editRegion(mark: RegionMark): Promise<void> {
  const s = store.getState()
  const { objectId } = s
  if (!objectId || sending) return
  if ((current()?.set.count ?? 0) > 0) {
    setTool('region')
    return regionStore.setState({ notice: IN_HAND })
  }
  const scan = s.scans.find((one) => one.id === mark.scan)
  if (!scan || mark.anchorState === 'orphaned') return
  try {
    const bits = maskBits(new Uint8Array(await window.torno.scans.mask(objectId, mark.scan, maskStem(mark))), scan.imported.triangles)
    if (store.getState().objectId !== objectId || (current()?.set.count ?? 0) > 0) return
    paintings.set(objectId, { objectId, scan: mark.scan, mesh: meshOf(scan), set: new TriangleSet(scan.imported.triangles, bits), area: mark.area, steps: [], editing: mark.id })
    cleared.delete(objectId)
    regionStore.setState({ refused: null, notice: `Painting ${mark.id} again: Keep makes this the region, Clear leaves it as it was` })
    setTool('region')
    publish()
  } catch (e) {
    regionStore.setState({ refused: e instanceof Error ? e.message : String(e) })
  }
}

export function regionTool(): Tool {
  /** What a held press is doing: a stroke of the brush, or a box. */
  let drag:
    | { kind: 'stroke'; of: Painting; erase: boolean; step: Step; last: THREE.Vector3 | null }
    | { kind: 'box'; of: Painting; erase: boolean; from: ViewportPointer; outline: ReturnType<typeof boxOutline> }
    | null = null
  const inverse = new THREE.Matrix4()
  const centre = new THREE.Vector3()
  const towards = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const along = new THREE.Vector3()
  type Found = NonNullable<ReturnType<Viewport['scanTree']>>

  /** Whether a triangle of a scan faces away from a direction, in the scan's own frame: it is seen from behind, as every triangle of a scan wound the other way round is. */
  const facesAway = (found: Found, triangle: number, to: THREE.Vector3): boolean => {
    const index = found.built.mesh.geometry.index!.array
    const position = found.built.mesh.geometry.getAttribute('position')
    if (!(triangle >= 0 && triangle * 3 + 2 < index.length)) return false
    a.fromBufferAttribute(position, index[triangle * 3])
    b.fromBufferAttribute(position, index[triangle * 3 + 1]).sub(a)
    c.fromBufferAttribute(position, index[triangle * 3 + 2]).sub(a)
    return normal.copy(b).cross(c).dot(to) < 0
  }

  /**
   * What of a scan the pointer is on, where the scan is what is drawn there: not behind a part that is in front
   * of it (the viewport's own pick says which part is seen), nor in the half a section has taken away.
   */
  const onScan = (e: ViewportPointer, ctx: ToolContext): ScanHit | null => {
    const hit = ctx.viewport.pickScan(e.client[0], e.client[1])
    return hit && !(e.hit && e.hit.distance < hit.distance - IN_FRONT_MM) ? hit : null
  }

  /** The side a section keeps, as a plane in a scan's own frame (`inverse` is set for it); null with no section. */
  const kept = (ctx: ToolContext): THREE.Plane | null => {
    const section = ctx.viewport.getSection?.()
    if (!section) return null
    const away = new THREE.Vector3().fromArray(section.normal).negate()
    return new THREE.Plane().setFromNormalAndCoplanarPoint(away, new THREE.Vector3().fromArray(section.origin)).applyMatrix4(inverse)
  }

  /** Takes up a scan to paint on, or the painting already in hand; null, having said why, when it cannot be painted on. */
  const begin = (scan: string, e: ViewportPointer, ctx: ToolContext): Painting | null => {
    const mine = current()
    if (mine) {
      if (mine.scan === scan) return mine
      ctx.readout.say(e.client, paintingOn(mine.scan))
      return null
    }
    const info = store.getState().scans.find((one) => one.id === scan)
    const found = ctx.viewport.scanTree?.(scan)
    if (!info || !found) {
      ctx.readout.say(e.client, NOT_INDEXED)
      return null
    }
    const made: Painting = { objectId: ctx.objectId, scan, mesh: meshOf(info), set: new TriangleSet(found.built.triangles), area: 0, steps: [] }
    paintings.set(ctx.objectId, made)
    // Something else is painted: what "Clear" put down is no longer what Undo brings back.
    cleared.delete(ctx.objectId)
    regionStore.setState({ scan, refused: null, notice: null })
    show()
    return made
  }

  /** Takes a triangle, or takes it out, as one more change of a step. */
  const change = (hand: Painting, geometry: THREE.BufferGeometry, erase: boolean, step: Step) => (t: number): void => {
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

  /** The brush at what the pointer is on, as a stroke goes: set down along the way from where it last was. */
  const brush = (e: ViewportPointer, hit: ScanHit, ctx: ToolContext): void => {
    if (drag?.kind !== 'stroke') return
    const hand = drag.of
    const found = ctx.viewport.scanTree?.(hand.scan)
    if (!found) return
    const scale = found.built.group.scale.x
    const radius = brushRadius(hand.scan, ctx.viewport) / scale
    inverse.copy(found.built.group.matrix).invert()
    // The way the triangle under the pointer faces: those that face the same way are taken, whichever way the scan is wound.
    towards.fromArray(e.ray.direction).negate().transformDirection(inverse)
    if (facesAway(found, hit.triangle, towards)) towards.negate()
    const keeps = kept(ctx)
    const take = change(hand, found.built.mesh.geometry, drag.erase, drag.step)
    centre.fromArray(hit.local)
    const from = drag.last
    if (from) {
      const steps = Math.min(Math.floor(from.distanceTo(centre) / (radius * STAMP_EVERY)), MOST_STAMPS)
      for (let n = 1; n < steps; n++) gatherSphere(found.tree, found.built.mesh.geometry, along.copy(from).lerp(centre, n / steps), radius, towards, take, keeps)
    }
    gatherSphere(found.tree, found.built.mesh.geometry, centre, radius, towards, take, keeps)
    drag.last = (drag.last ?? new THREE.Vector3()).copy(centre)
    drawn?.paint?.touched()
  }

  const ring = (hit: ScanHit | null, ctx: ToolContext, erase: boolean): void => {
    const mine = paintings.get(ctx.objectId)
    const shown = hit && (!mine || mine.scan === hit.scan) && regionStore.getState().mode === 'brush'
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
      if (e && current() === was.of) box(was.of, was.from, e, was.erase, ctx)
    } else if (was.step.added.length + was.step.removed.length > 0) was.of.steps.push(was.step)
    if (was.of.set.count === 0) was.of.area = 0
    publish()
  }

  /** The stroke or the box under way is given up: what the stroke changed is put back, and nothing else is touched. */
  const giveUp = (ctx: ToolContext): void => {
    if (!drag) return
    const was = drag
    drag = null
    ctx.viewport.setNavigation(true)
    if (was.kind === 'box') was.outline.remove()
    else {
      const geometry = ctx.viewport.scanTree?.(was.of.scan)?.built.mesh.geometry
      for (const t of was.step.added) if (was.of.set.delete(t) && geometry) was.of.area -= areaOf(geometry, t)
      for (const t of was.step.removed) if (was.of.set.add(t) && geometry) was.of.area += areaOf(geometry, t)
      drawn?.paint?.touched()
    }
    publish()
  }

  /** Takes what a rectangle of the screen goes round, between where it was pressed and where it was let go. */
  const box = (hand: Painting, from: ViewportPointer, to: ViewportPointer, erase: boolean, ctx: ToolContext): void => {
    if (Math.hypot(to.client[0] - from.client[0], to.client[1] - from.client[1]) < DRAG_PX) return
    const found = ctx.viewport.scanTree?.(hand.scan)
    const planes = boxPlanes(ctx.camera, from.ray, to.ray)
    if (!found || !planes) return
    inverse.copy(found.built.group.matrix).invert()
    // Where the eye is: a point for a camera that has one, far back along its rays for one that has none.
    const eye = new THREE.Vector3().fromArray(from.ray.origin)
    if (ctx.camera.ortho) eye.addScaledVector(new THREE.Vector3().fromArray(from.ray.direction), -1e7)
    const step: Step = { added: [], removed: [] }
    // What is seen in the middle of the box says which way round the scan shows itself there: that side is taken.
    const seen = ctx.viewport.pickScan((from.client[0] + to.client[0]) / 2, (from.client[1] + to.client[1]) / 2)
    const away = seen?.scan === hand.scan && facesAway(found, seen.triangle, towards.fromArray(from.ray.direction).negate().transformDirection(inverse))
    gatherBox(found.tree, found.built.mesh.geometry, planes.map((plane) => plane.clone().applyMatrix4(inverse)), eye.applyMatrix4(inverse), change(hand, found.built.mesh.geometry, erase, step), { away, through: regionStore.getState().through, keeps: kept(ctx) })
    if (step.added.length + step.removed.length > 0) hand.steps.push(step)
    drawn?.paint?.touched()
  }

  return {
    id: 'region',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      lastClient = e.client
      painter = ctx.viewport
      const { scans } = store.getState()
      const erasing = regionStore.getState().erase || e.ctrl === true
      if (e.type === 'cancel') {
        end(ctx)
        ctx.viewport.showBrush?.(null)
        return
      }
      if (drag) {
        // Its scan went, or its object: nothing more of the press is the painting's.
        if (current() !== drag.of) return giveUp(ctx)
        // Let go, or a move with no button held: a release that was not seen.
        if (e.type === 'up' || (e.type === 'move' && !(e.buttons & 1))) return end(ctx, e.type === 'up' ? e : undefined)
        if (e.type !== 'move') return
        if (drag.kind === 'box') return drag.outline.set(drag.from.client, e.client)
        const hit = onScan(e, ctx)
        const on = hit && hit.scan === drag.of.scan ? hit : null
        // Off the scan, or behind a part, the stroke is not carried across: it begins again where the pointer comes back on.
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
        // What is being kept is what was painted when it was sent: nothing is added to it meanwhile.
        if (sending) return ctx.readout.say(e.client, KEEPING)
        const hit = onScan(e, ctx)
        if (e.shift || regionStore.getState().mode === 'box') {
          // On the scan pressed on; with none under the press, the one in hand elsewhere.
          const scan = current()?.scan ?? hit?.scan ?? scanInHand(alignStore.getState().scan, scans)?.id
          if (scan === undefined) return ctx.readout.say(e.client, CHOOSE_SCAN)
          const hand = begin(scan, e, ctx)
          if (!hand) return
          const outline = boxOutline(ctx.viewport.canvas)
          outline.set(e.client, e.client)
          drag = { kind: 'box', of: hand, erase: erasing, from: e, outline }
          ctx.viewport.setNavigation(false, { wheel: true })
          ctx.viewport.showBrush?.(null)
          ctx.readout.hide()
          return
        }
        // Beside the scan, or on a part in front of it, the press is the camera's.
        const hand = hit && begin(hit.scan, e, ctx)
        if (!hit || !hand) return
        drag = { kind: 'stroke', of: hand, erase: erasing, step: { added: [], removed: [] }, last: null }
        ctx.viewport.setNavigation(false, { wheel: true })
        ctx.readout.hide()
        brush(e, hit, ctx)
        ring(hit, ctx, erasing)
        return
      }
      if (e.type === 'move' && e.buttons === 0) {
        ring(onScan(e, ctx), ctx, erasing)
        ctx.readout.hide()
      }
    },
    onKey(e: KeyboardEvent, ctx: ToolContext) {
      painter = ctx.viewport
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === '[' || key === ']') {
        const scan = current()?.scan ?? scanInHand(alignStore.getState().scan, store.getState().scans)?.id
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
        // In the middle of a stroke it gives up that stroke, and no more. Otherwise it is not the tool's: the
        // pane puts the tool down, and what is painted waits.
        if (!drag) return false
        giveUp(ctx)
        ctx.viewport.showBrush?.(null)
        return true
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
 * painted is drawn only while the tool is in hand and its object on show, and waits otherwise. Returns what
 * undoes it.
 */
export function connectRegion(viewport: Pick<Viewport, 'getCamera' | 'paintScan' | 'scanTree' | 'showBrush' | 'setRegions'>): () => void {
  host = viewport
  painter = viewport
  const offTints = tintRegions(viewport)
  /** Says in the bar that a painting which waited is in hand again. */
  const back = (): void => {
    const mine = toolStore.getState().tool === 'region' ? current() : null
    if (mine && mine.set.count > 0) regionStore.setState({ notice: waiting(mine.set.count, mine.scan), refused: null })
  }
  publish()
  const offStore = store.subscribe((s, prev) => {
    if (s.scans === prev.scans && s.objectId === prev.objectId) return
    // Another object, or its scans changed: the painting of the one on show is the one in hand, if it has one.
    if (s.objectId !== prev.objectId) regionStore.setState({ notice: null, refused: null })
    publish()
    if (s.objectId !== prev.objectId) back()
  })
  const offTool = toolStore.subscribe((t, prev) => {
    if (t.tool === prev.tool) return
    if (prev.tool === 'region') viewport.showBrush(null)
    publish()
    if (t.tool === 'region') back()
  })
  return () => {
    offStore()
    offTool()
    offTints()
    if (drawn) drawn.on.paintScan?.(null, null)
    drawn = null
    host = null
    painter = null
  }
}

/** For tests: nothing is painted, cleared or waiting anywhere. */
export function forgetPaintings(): void {
  if (drawn) drawn.on.paintScan?.(null, null)
  drawn = null
  paintings.clear()
  cleared.clear()
  sending = false
  painter = null
}

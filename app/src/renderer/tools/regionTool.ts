import * as THREE from 'three'
import { alignStore, scanInHand } from '../state/align'
import { radiusOf, regionStore } from '../state/region'
import { store } from '../state/store'
import { toolStore } from '../state/tools'
import { TriangleSet, gatherBox, gatherSphere } from '../viewport/scanPaint'
import { type ScanHit, meshOf } from '../viewport/scans'
import type { Viewport, ViewportPointer } from '../viewport/Viewport'
import { boxOutline, boxPlanes } from './regionBox'
import { CHOOSE_SCAN, KEEPING, NOT_INDEXED, NO_SCAN, type Painting, type Step, areaOf, brushRadius, cleared, current, isSending, join, keepRegion, paintOn, paintingOn, paintings, pointerAt, publish, show, touched, undoStroke, waiting } from './regionPainting'
import { tintRegions } from './regionTints'
import { boxMeetsBrush, stampTriangles } from './stamp'
import { DRAG_PX, type Tool, type ToolContext } from './Tool'

export { boxPlanes }

// The Region tool: the person paints the part of a scan they want to name, and keeps it as a mark. What is
// painted is a set of the scan's triangles, held in ./regionPainting and drawn by the viewport; nothing of a
// stroke goes through React or the store until the stroke ends. Main keeps the region: it is sent the bits and
// works out the rest from the mesh.

/** `[` and `]` change the brush's radius by a quarter. */
const BRUSH_STEP = 1.25
/** Between two events of a stroke the brush is set down this many radii apart, and no more often than this. */
const STAMP_EVERY = 0.5
const MOST_STAMPS = 48
/** A part this much nearer than the scan along the pointer's ray is in front of it: the scan is not what is seen there. */
const IN_FRONT_MM = 1e-3

/** Said in the bar after a stroke of which a stamp met `STAMP_TESTS`: what it did not ask about it left, and another stroke takes it. */
export const SLOWER = 'Near a part the brush paints slower: stroke again to take what it left'

const a = new THREE.Vector3()
const b = new THREE.Vector3()
const c = new THREE.Vector3()

/** The middle of a triangle of a geometry, in its own frame, into `out`. */
function centroid(geometry: THREE.BufferGeometry, triangle: number, out: THREE.Vector3): THREE.Vector3 {
  const position = geometry.getAttribute('position')
  const index = geometry.index!.array
  a.fromBufferAttribute(position, index[triangle * 3])
  b.fromBufferAttribute(position, index[triangle * 3 + 1])
  c.fromBufferAttribute(position, index[triangle * 3 + 2])
  return out.copy(a).add(b).add(c).divideScalar(3)
}

export function regionTool(): Tool {
  /** What a held press is doing: a stroke of the brush, or a box. */
  let drag:
    | { kind: 'stroke'; of: Painting; erase: boolean; step: Step; last: THREE.Vector3 | null; seen?: Seen; slowed?: boolean }
    | { kind: 'box'; of: Painting; erase: boolean; from: ViewportPointer; outline: ReturnType<typeof boxOutline> }
    | null = null
  const inverse = new THREE.Matrix4()
  const centre = new THREE.Vector3()
  const towards = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const along = new THREE.Vector3()
  const world = new THREE.Vector3()
  const rim = new THREE.Vector3()
  const middle = new THREE.Vector3()
  const seen = new THREE.Vector3()
  type Found = NonNullable<ReturnType<Viewport['scanTree']>>
  /** What a stroke knows of the view it is drawn in, for as long as the camera is as it was (`view`): where the box of each part is drawn, and of each triangle asked about whether a part hides it. */
  interface Seen { view: string; boxes: Array<Array<[number, number] | null>>; hidden: Map<number, boolean> }

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
    if (!hit) return null
    // An edge is found some pixels off it: beside a part's outline it is no part in front. A face of the part is, where there is one.
    const front = e.hit?.kind === 'edge' ? ctx.viewport.pick(e.client[0], e.client[1], { partsOnly: true, edges: false }) : e.hit
    return front && front.distance < hit.distance - IN_FRONT_MM ? null : hit
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

  /**
   * The brush at what the pointer is on, as a stroke goes: set down along the way from where it last was. A stamp
   * is a ball round a point of the scan, and takes nothing of it that a part hides.
   */
  const brush = (e: ViewportPointer, hit: ScanHit, ctx: ToolContext): void => {
    if (drag?.kind !== 'stroke') return
    const hand = drag.of
    const found = ctx.viewport.scanTree?.(hand.scan)
    // Where a point is drawn is what says whether a part hides it: a viewport that cannot say paints nothing.
    if (!found || !ctx.viewport.project) return
    const project = (point: THREE.Vector3): [number, number] => ctx.viewport.project!(point.toArray())
    const scale = found.built.group.scale.x
    const radius = brushRadius(hand.scan, ctx.viewport) / scale
    inverse.copy(found.built.group.matrix).invert()
    // The way the triangle under the pointer faces: those that face the same way are taken, whichever way the scan is wound.
    towards.fromArray(e.ray.direction).negate().transformDirection(inverse)
    if (facesAway(found, hit.triangle, towards)) towards.negate()
    const keeps = kept(ctx)
    const take = change(hand, found.built.mesh.geometry, drag.erase, drag.step)
    const geometry = found.built.mesh.geometry
    const { matrix } = found.built.group
    const { erase } = drag
    // How far a point of the object frame is along the ray that sees it, as a pick measures a part: from the eye, or from the plane the rays of a camera with no eye start on.
    const origin = new THREE.Vector3().fromArray(e.ray.origin)
    const forward = new THREE.Vector3().fromArray(e.ray.direction)
    const depthOf = (point: THREE.Vector3): number => (ctx.camera.ortho ? seen.copy(point).sub(origin).dot(forward) : point.distanceTo(origin))
    /** Whether a part is drawn in front of a point of the object frame: at its pixel a face of a part is nearer. Its faces alone: an edge is found some pixels off it. */
    const partBefore = (point: THREE.Vector3): boolean => {
      const [x, y] = project(point)
      const part = ctx.viewport.pick(x, y, { partsOnly: true, edges: false })
      return part !== null && part.distance < depthOf(point) - IN_FRONT_MM
    }
    // Across the screen, a brush radius long: from the middle of a stamp to its rim as it is seen.
    const look = new THREE.Vector3().fromArray(ctx.camera.target).sub(new THREE.Vector3().fromArray(ctx.camera.position)).normalize()
    const across = look.clone().cross(new THREE.Vector3().fromArray(ctx.camera.up))
    if (across.lengthSq() < 1e-12) across.set(1, 0, 0)
    across.normalize().multiplyScalar(radius * scale)
    // What is known of the view holds while the camera is where it was: the wheel may zoom in the middle of a stroke.
    const view = JSON.stringify(ctx.camera)
    if (drag.seen?.view !== view) {
      const eye = new THREE.Vector3().fromArray(ctx.camera.position)
      // Where the box of each part that is drawn is on the screen: a part can hide only what is drawn inside that.
      const boxes = (ctx.viewport.partBoxes?.() ?? [ctx.viewport.bounds()]).map(({ min, max }) =>
        [min[0], max[0]].flatMap((x) => [min[1], max[1]].flatMap((y) => [min[2], max[2]].map((z) => (ctx.camera.ortho || seen.set(x, y, z).sub(eye).dot(look) > 1e-6 ? project(seen.set(x, y, z)) : null))))
      )
      drag.seen = { view, boxes, hidden: new Map() }
    }
    const { boxes, hidden: known } = drag.seen
    const stroke = drag
    /** One stamp, at a point of the scan's own frame: what a part hides of the scan under it is left (`stampTriangles`). */
    const stamp = (at: THREE.Vector3): void => {
      // Only what the stamp would change: what is asked about is then what is still to take.
      const gathered: number[] = []
      gatherSphere(found.tree, geometry, at, radius, towards, (t) => void (hand.set.has(t) === erase && gathered.push(t)), keeps)
      if (gathered.length === 0) return
      // The square round the stamp on the screen: with the box of a part in it, each triangle is asked about.
      world.copy(at).applyMatrix4(matrix)
      const [x, y] = project(world)
      const [rx, ry] = project(rim.copy(world).add(across))
      const pixels = Math.hypot(rx - x, ry - y)
      const near = boxes.some((corners) => boxMeetsBrush(corners, x, y, pixels))
      const { taken, capped } = stampTriangles(gathered, near, (t) => known.get(t), (t) => {
        const is = partBefore(centroid(geometry, t, middle).applyMatrix4(matrix))
        known.set(t, is)
        return is
      })
      if (capped) stroke.slowed = true
      for (const t of taken) take(t)
    }
    centre.fromArray(hit.local)
    const from = drag.last
    if (from) {
      const steps = Math.min(Math.floor(from.distanceTo(centre) / (radius * STAMP_EVERY)), MOST_STAMPS)
      for (let n = 1; n < steps; n++) stamp(along.copy(from).lerp(centre, n / steps))
    }
    stamp(centre)
    drag.last = (drag.last ?? new THREE.Vector3()).copy(centre)
    touched()
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
    // Said once the stroke has ended, as everything of a stroke is: some stamp left triangles for the next.
    if (was.kind === 'stroke' && was.slowed) regionStore.setState({ notice: SLOWER })
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
      touched()
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
    touched()
  }

  return {
    id: 'region',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      pointerAt(e.client)
      paintOn(ctx.viewport)
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
        if (isSending()) return ctx.readout.say(e.client, KEEPING)
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
      paintOn(ctx.viewport)
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
  join(viewport)
  const offTints = tintRegions(viewport)
  /** Says in the bar that a painting which waited is in hand again. */
  const back = (): void => {
    const mine = toolStore.getState().tool === 'region' ? current() : null
    if (mine && mine.set.count > 0) regionStore.setState({ notice: waiting(mine.set.count, mine.scan), refused: null })
  }
  publish()
  const offStore = store.subscribe((s, prev) => {
    // Another workspace: what was painted was of the one that was left, whose objects may be named alike.
    if (s.workspace?.root !== prev.workspace?.root) {
      paintings.clear()
      cleared.clear()
    }
    if (s.scans === prev.scans && s.objectId === prev.objectId && s.scansKnown === prev.scansKnown && s.workspace?.root === prev.workspace?.root) return
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
    join(null)
  }
}

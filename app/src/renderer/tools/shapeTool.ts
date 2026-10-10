import { which } from '../../shared/keys'
import * as THREE from 'three'
import type { Quat, ShapeKind, ShapeMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'
import { actions, store, type TornoState } from '../state/store'
import { GIZMO_MODES, setGizmo, toolStore, type GizmoMode } from '../state/tools'
import { TYPING } from '../ui/typing'
import type { Hit } from '../viewport/picking'
import type { Viewport, ViewportPointer } from '../viewport/Viewport'
import { along, anchorFromHit, clickGuard, sub, unit, type Tool, type ToolContext } from './Tool'

/** How large a shape is when it is placed, as a share of the scene from corner to corner. */
const DEFAULT_SHARE = 0.15
/** A view that meets the ground further than this many times its own reach from what it looks at does not meet it, for placing. */
const GROUND_WITHIN = 10

const Z = new THREE.Vector3(0, 0, 1)

/**
 * A shape as it is first placed on a surface: every side 15% of the scene's
 * diagonal (`sceneSize`, in mm) to the whole millimetre and at least one, its
 * Z along the surface's normal, sitting on the surface with the middle of its
 * bottom at the point. A plane lies in the surface. Where there is no normal
 * (an edge, the ground) it stands upright.
 */
export function defaultShape(kind: ShapeKind, hit: { point: Vec3; normal: Vec3 | null }, sceneSize: number): Pick<ShapeMark, 'position' | 'rotation' | 'size'> {
  const side = Math.max(Math.round(sceneSize * DEFAULT_SHARE), 1)
  const normal = (hit.normal && unit(hit.normal)) ?? [0, 0, 1]
  const turn = new THREE.Quaternion().setFromUnitVectors(Z, new THREE.Vector3().fromArray(normal))
  const height = kind === 'plane' ? 0 : side
  return {
    position: along(hit.point, normal, height / 2),
    rotation: turn.toArray().map((c) => c + 0) as Quat,
    size: [side, side, height]
  }
}

/**
 * Where a shape goes when it is placed beside the parts: where the middle of
 * the view meets the ground (the plane z = `ground`). A view that runs along
 * the ground, looks away from it, or meets it far off has no such point worth
 * having: the shape goes under what the camera looks at.
 */
export function groundPoint(camera: Pick<Camera, 'position' | 'target'>, ground: number): Vec3 {
  const looks = sub(camera.target, camera.position)
  const under: Vec3 = [camera.target[0], camera.target[1], ground]
  if (Math.abs(looks[2]) < 1e-9) return under
  const t = (ground - camera.target[2]) / looks[2]
  // `t` is in reaches of the camera: 1 is as far past the target as the camera is before it.
  if (t < -1 || t > GROUND_WITHIN) return under
  return [camera.target[0] + looks[0] * t, camera.target[1] + looks[1] * t, ground]
}

/** A shape's rotation as the angles the fields show: degrees about its own X, then Y, then Z. One that is no rotation at all is none. */
export function eulerOf(rotation: Quat): Vec3 {
  const q = new THREE.Quaternion().fromArray(rotation)
  if (q.lengthSq() === 0) return [0, 0, 0]
  const e = new THREE.Euler().setFromQuaternion(q.normalize(), 'XYZ')
  return [e.x, e.y, e.z].map((radians) => THREE.MathUtils.radToDeg(radians) + 0) as Vec3
}

/** The rotation those angles are. */
export function quatOf(degrees: Vec3): Quat {
  const [x, y, z] = degrees.map((d) => THREE.MathUtils.degToRad(d))
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray().map((c) => c + 0) as Quat
}

/**
 * The shape tool: a click on a part places the shape chosen in the palette
 * there, sitting on the surface, to be added; a click beside the parts places
 * it on the ground at the middle of the view. Its note opens, and it is the
 * active mark, with a gizmo to move, turn and size it (`connectShapeEdit`).
 * Dragging turns the camera as ever. The tool stays in hand; a double click is
 * one shape.
 */
export function shapeTool(chosen: () => ShapeKind = () => toolStore.getState().shape): Tool {
  const clicks = clickGuard()

  const place = async (hit: Hit | null, ctx: ToolContext, kept: () => void): Promise<void> => {
    // As they are now: the kernel is asked before the mark is made, and the view may move meanwhile.
    const { layout, revision, camera } = ctx
    const box = ctx.viewport.bounds()
    const on = hit ?? { point: groundPoint(camera, box.min[2]), normal: null }
    const shape = chosen()
    const placed = defaultShape(shape, on, Math.hypot(...sub(box.max, box.min)))
    try {
      const anchor = hit ? { anchor: await anchorFromHit(hit, ctx.describe) } : {}
      ctx.openNote(await ctx.commit({ kind: 'shape', shape, intent: 'add', author: 'user', note: '', layout, revision, camera, ...placed, ...anchor }))
    } catch {
      // Main refused it, and whoever made `commit` has said so: there is no shape.
    } finally {
      kept()
    }
  }

  return {
    id: 'shape',
    cursor: 'crosshair',
    onPointer(e: ViewportPointer, ctx: ToolContext) {
      if (e.type === 'click') {
        const kept = clicks.begin(e.client)
        if (kept) void place(e.hit, ctx, kept)
      }
      if (e.type === 'click' || e.type === 'cancel' || !e.hit) {
        ctx.viewport.setHover(null)
        ctx.readout.hide()
        return
      }
      // What the shape would sit on.
      ctx.viewport.setHover(e.hit)
      ctx.readout.show(e.client, e.hit.ref)
    },
    cancel(ctx: ToolContext) {
      ctx.viewport.setHover(null)
      ctx.readout.hide()
    }
  }
}

/** The shape the gizmo is on: the active mark, when it is a shape of the layout shown that is not resolved. */
export function editedShape(s: Pick<TornoState, 'marks' | 'activeMark' | 'layout'>): ShapeMark | null {
  const mark = s.activeMark === null ? undefined : s.marks.find((m) => m.id === s.activeMark)
  return mark?.kind === 'shape' && mark.status !== 'resolved' && mark.layout === s.layout ? mark : null
}

/**
 * Puts the gizmo on the active mark while that is a shape, whichever tool is
 * in hand, and has main keep what a drag of it made of the shape: one change
 * for each drag, when it is let go. `G`, `R` and `T` choose between moving,
 * turning and sizing while a shape is active and the keys are not being typed
 * somewhere. Returns what undoes it.
 */
export function connectShapeEdit(viewport: Pick<Viewport, 'editShape'>): () => void {
  let on: { id: string | null; mode: GizmoMode } = { id: null, mode: toolStore.getState().gizmo }

  const apply = (force = false): void => {
    const s = store.getState()
    const { objectId } = s
    const id = editedShape(s)?.id ?? null
    const mode = toolStore.getState().gizmo
    if (!force && id === on.id && mode === on.mode) return
    on = { id, mode }
    viewport.editShape(id, mode, (shape) => {
      if (!objectId || id === null) return
      window.torno.marks.update(objectId, id, shape).catch((e: unknown) => {
        actions.setMarksProblem({ objectId, message: `The shape was not changed: ${e instanceof Error ? e.message : String(e)}` })
        // Back to the shape main has.
        apply(true)
      })
    })
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
    if (e.target instanceof Element && e.target.closest(TYPING)) return
    const wanted = GIZMO_MODES[which(e, 'gizmo')]
    if (!wanted || !editedShape(store.getState())) return
    setGizmo(wanted.mode)
    e.preventDefault()
  }

  apply(true)
  const offStore = store.subscribe(() => apply())
  const offTool = toolStore.subscribe(() => apply())
  window.addEventListener('keydown', onKey)
  return () => {
    offStore()
    offTool()
    window.removeEventListener('keydown', onKey)
    viewport.editShape(null, on.mode, () => {})
  }
}

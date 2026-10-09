import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { Quat, ShapeKind, ShapeMark, Vec3 } from '../../shared/marks'
import { fitSize } from './marks/markObjects'

/** A shape as the gizmo leaves it: where it is, how it is turned, and its size in millimetres. */
export type ShapeTransform = Pick<ShapeMark, 'position' | 'rotation' | 'size'>
/** What the gizmo on a shape does to it: move it, turn it, or change its size. */
export type GizmoMode = 'translate' | 'rotate' | 'scale'
type PointerKind = 'move' | 'down' | 'up' | 'cancel'

/** How large the gizmo is on screen, against three.js's own. */
const GIZMO_SIZE = 0.72
/** What a drag of the gizmo leaves is kept to the hundredth of a millimetre: this many steps to one. */
const STEPS_PER_MM = 100

/**
 * Whether a pointer event is the gizmo's and not the tool's, and whether the
 * press it belongs to began on the gizmo (to be handed back with the next
 * event of that press). The gizmo has the pointer over a handle while no
 * button is held, and for the whole of a press that began on a handle, its
 * release included; a move with no button held ends a press whose release was
 * missed. A press that began elsewhere stays the tool's wherever it
 * goes: a stroke drawn across a handle is not cut short, though the gizmo
 * still notices the pointer passing over it.
 */
export function gizmoTakes(gizmo: { dragging: boolean; onHandle: boolean }, e: { kind: PointerKind; buttons: number }, press: boolean): { takes: boolean; press: boolean } {
  // A move with no button held: the press is over, though its release never reached the canvas.
  const released = e.kind === 'move' && e.buttons === 0
  const began = e.kind === 'down' ? gizmo.dragging || gizmo.onHandle : press && !released
  const hovering = e.kind === 'move' && e.buttons === 0 && gizmo.onHandle
  return { takes: began || hovering || gizmo.dragging, press: e.kind === 'up' || e.kind === 'cancel' ? false : began }
}

/**
 * What a drag has made of a shape, from where the gizmo has put its stand-in:
 * only what the gizmo's way changes. Moving gives the position, to the
 * hundredth of a millimetre (of a scan, as it is); turning the rotation; sizing the size, worked out
 * from the size the drag began with (`from`) and the stand-in's scale, which is
 * then put back to 1: a shape is so many millimetres, never a scale.
 */
export function draggedTo(mode: GizmoMode, kind: ShapeKind | undefined, from: Vec3 | undefined, stand: THREE.Object3D): Partial<ShapeTransform> {
  const round = (mm: number): number => Math.round(mm * STEPS_PER_MM) / STEPS_PER_MM + 0
  switch (mode) {
    case 'translate':
      // A scan is held at a point of its own, which is at no round place: how far it was moved from there is what is rounded, by who moves it.
      return { position: kind === undefined ? stand.position.toArray() : (stand.position.toArray().map(round) as Vec3) }
    case 'rotate':
      return { rotation: stand.quaternion.clone().normalize().toArray() as Quat }
    case 'scale': {
      const scale = stand.scale.toArray()
      stand.scale.set(1, 1, 1)
      // What has no size (a scan) is never sized.
      if (kind === undefined || from === undefined) return {}
      return { size: fitSize(kind, from.map((mm, i) => round(mm * Math.abs(scale[i]))) as Vec3, from) }
    }
  }
}

/** What the gizmo holds: a shape mark, or a scan by a point of it. Only a shape has a size. */
export interface GizmoSubject { position: Vec3; rotation: Quat; shape?: ShapeKind; size?: Vec3 }

/** What the gizmo is asked to be on, and who hears what a drag made of it. */
export interface GizmoEdit { id: string; mode: GizmoMode; onChange: (change: Partial<ShapeTransform>) => void }

/** The one thing the gizmo is on, of what it was asked to be on: the scan being moved by hand, while there is one; else the shape being edited. */
export function editingOf(asked: { shape: GizmoEdit | null; scan: GizmoEdit | null }): GizmoEdit | null {
  return asked.scan ?? asked.shape
}

/** What the gizmo needs of the viewport it is in. */
export interface GizmoHost {
  /** What has this id (a shape mark's, or a scan's), if it is drawn in the layout shown. */
  subject(id: string): GizmoSubject | null
  /** Draw it as a drag has it for now. */
  preview(id: string, change: Partial<ShapeTransform>): void
  /** A drag of the gizmo began or ended: the camera is not the pointer's meanwhile. */
  dragging(on: boolean): void
  /** Something of the gizmo changed that a frame should show. */
  redraw(): void
}

/**
 * The gizmo on the shape being edited: three.js's TransformControls on a
 * stand-in object that is where the shape is. It listens to the canvas itself;
 * the viewport asks `takes` of every pointer event before a tool hears of it.
 * While it is dragged the shape is drawn as the drag has it and nothing is
 * told; when it is let go, whoever asked for the edit hears once what changed.
 * It is no part of a picture for the agent (`hide`), and is never picked.
 */
export class ShapeGizmo {
  private readonly controls: TransformControls
  private readonly stand = new THREE.Object3D()
  /** What the gizmo is asked to be on: a shape, a scan, or both, of which it is on one (`editingOf`). */
  private readonly asked: { shape: GizmoEdit | null; scan: GizmoEdit | null } = { shape: null, scan: null }
  /** While it is dragged: what it is on, the size that had when the drag began, and what the drag has made of it so far. */
  private drag: { id: string; shape?: ShapeKind; size?: Vec3; made: Partial<ShapeTransform> | null } | null = null
  /** The press under way began on the gizmo. */
  private press = false

  /** Construct it before the viewport listens to the canvas: its own listeners then run first, and `takes` knows what they found. */
  constructor(
    camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: GizmoHost
  ) {
    this.controls = new TransformControls(camera, canvas)
    this.controls.setSize(GIZMO_SIZE)
    this.controls.addEventListener('change', () => this.host.redraw())
    this.controls.addEventListener('dragging-changed', this.onDragging)
    this.controls.addEventListener('objectChange', this.onMoved)
    this.controls.addEventListener('axis-changed', this.onAxis)
  }

  /** What to add to the scene. */
  get objects(): THREE.Object3D[] {
    return [this.stand, this.controls.getHelper()]
  }

  get dragging(): boolean {
    return this.controls.dragging
  }

  /**
   * Ends a drag whose release will not arrive (the window was left with the
   * button held): the shape stays as it was dragged to, as on a release, and
   * no longer follows the pointer. Nothing when no drag is under way.
   */
  endDrag(): void {
    if (this.controls.dragging) this.controls.pointerUp(null)
  }

  /** The shape to be on and what dragging does, or null for no shape; `of: 'scan'` for the scan to be on instead, which has the gizmo while there is one. Call `place` after. */
  edit(id: string | null, mode: GizmoMode, onChange: (change: Partial<ShapeTransform>) => void, of: 'shape' | 'scan' = 'shape'): void {
    this.asked[of] = id === null ? null : { id, mode, onChange }
  }

  private get editing(): GizmoEdit | null {
    return editingOf(this.asked)
  }

  /** Brings the gizmo to the shape being edited, as the shape now is, or takes it away when that is not drawn. A drag under way is left alone. */
  place(): void {
    const mark = this.editing && this.host.subject(this.editing.id)
    if (!mark || !this.editing) {
      if (this.controls.object) this.controls.detach()
      this.drag = null
      delete this.canvas.dataset.gizmo
      return
    }
    if (this.controls.dragging) return
    this.stand.position.fromArray(mark.position)
    const turn = this.stand.quaternion.fromArray(mark.rotation)
    // A rotation that is no rotation at all (all zeros) turns nothing.
    if (turn.lengthSq() > 0) turn.normalize()
    else turn.identity()
    this.stand.scale.set(1, 1, 1)
    if (this.controls.object !== this.stand) this.controls.attach(this.stand)
    this.controls.setMode(this.editing.mode)
    // A plane has no thickness to size.
    this.controls.showZ = !(this.editing.mode === 'scale' && mark.shape === 'plane')
    this.canvas.dataset.gizmo = this.editing.mode
  }

  /** Whether a pointer event on the canvas is the gizmo's, and so not the tool's. Ask once for each event, in order. */
  takes(kind: PointerKind, buttons: number): boolean {
    const said = gizmoTakes({ dragging: this.controls.dragging, onHandle: this.controls.object !== undefined && this.controls.axis !== null }, { kind, buttons }, this.press)
    this.press = said.press
    return said.takes
  }

  /** Whether the gizmo answers the pointer at all. Off while a tool drags: its handles do not light up under a stroke. */
  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled
    if (!enabled && !this.controls.dragging) this.controls.axis = null
  }

  setCamera(camera: THREE.Camera): void {
    this.controls.camera = camera
  }

  /** The colours of its three axes, and of the handle under the pointer. */
  setColours(x: string, y: string, z: string, active: string): void {
    this.controls.setColors(x, y, z, active)
  }

  /** Takes the gizmo out of what is drawn, for a picture; returns what puts it back. */
  hide(): () => void {
    const helper = this.controls.getHelper()
    const shown = helper.visible
    helper.visible = false
    return () => {
      helper.visible = shown
    }
  }

  dispose(): void {
    this.controls.detach()
    this.controls.getHelper().dispose()
    this.controls.dispose()
  }

  /** Which handle the pointer is on, for the cursor: an attribute of the canvas, set when it changes. */
  private readonly onAxis = (): void => {
    if (this.controls.axis) this.canvas.dataset.gizmoAxis = this.controls.axis
    else delete this.canvas.dataset.gizmoAxis
  }

  private readonly onDragging = (): void => {
    const editing = this.editing
    const mark = editing && this.host.subject(editing.id)
    if (this.controls.dragging) {
      this.drag = editing && mark ? { id: editing.id, shape: mark.shape, size: mark.size, made: null } : null
      this.host.dragging(true)
      return
    }
    const drag = this.drag
    this.drag = null
    this.host.dragging(false)
    this.place()
    // Told to whoever asked for the edit of what was dragged, if that is still what the gizmo is on.
    if (drag?.made && this.editing?.id === drag.id) this.editing.onChange(drag.made)
  }

  /** The gizmo moved its stand-in: the shape is drawn as that makes it. */
  private readonly onMoved = (): void => {
    if (!this.drag || this.editing?.id !== this.drag.id) return
    this.drag.made = draggedTo(this.editing.mode, this.drag.shape, this.drag.size, this.stand)
    this.host.preview(this.drag.id, this.drag.made)
  }
}

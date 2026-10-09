import type * as THREE from 'three'
import type { Camera } from '../../shared/view'
import { type Hit, pointerRay } from './picking'
import type { ShapeGizmo } from './ShapeGizmo'

type Vec3 = [number, number, number]

/**
 * The pointer over the canvas. `hit` is what it is on, among the parts shown;
 * null while a drag turns the camera. A `click` follows the `up` of a press
 * released where it was made; `cancel` says the pointer left or was taken away.
 */
export interface ViewportPointer {
  type: 'move' | 'down' | 'up' | 'click' | 'cancel'
  hit: Hit | null
  /** Where the pointer looks along, in the object frame. */
  ray: { origin: Vec3; direction: Vec3 }
  client: [number, number]
  buttons: number
  shift: boolean
  /** Alt is held: a tool that takes every press leaves this one to the camera. */
  alt: boolean
}

/** A press released within this many pixels and milliseconds of where and when it was made is a click, not a drag. */
const CLICK_PX = 4
const CLICK_MS = 400
const POINTER_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'pointerleave'] as const

/** The left button's press: where and when. */
export interface Press {
  x: number
  y: number
  at: number
}

/** Whether an event of the left button, at a place and a time, ends `press` as a click: near enough to it and soon enough after. */
export function isClick(press: Press | null, e: { button: number; x: number; y: number; at: number }): boolean {
  return press !== null && e.button === 0 && Math.hypot(e.x - press.x, e.y - press.y) <= CLICK_PX && e.at - press.at <= CLICK_MS
}

/** By how much a turn of the wheel brings the camera closer (over 1) or takes it away (under 1): the orbit's own step. */
export function wheelZoom(deltaY: number, deltaMode: number): number {
  const by = 0.95 ** (Math.abs(deltaY) * 0.01 * (deltaMode === 1 ? 16 : 1)) // lines to pixels, as the orbit takes them
  return deltaY < 0 ? 1 / by : by
}

/** What the routing of the pointer needs of the viewport it is in. */
export interface PointerHost {
  readonly canvas: HTMLCanvasElement
  /** The orbit: whether the pointer moves the camera. */
  readonly orbit: { enabled: boolean }
  readonly gizmo: Pick<ShapeGizmo, 'dragging' | 'takes' | 'setEnabled'>
  /** The camera drawn with. */
  camera(): THREE.Camera
  /** A point of the window as the camera sees it: -1 to 1 across the canvas, y up. Null while the canvas has no size. */
  canvasPoint(clientX: number, clientY: number): { ndc: { x: number; y: number } } | null
  /** What a point of the window is on. */
  pick(clientX: number, clientY: number): Hit | null
  /** Brings the matrices a ray is cast with up to date. */
  syncMatrices(): void
  /** The camera as it is, and a way to put it elsewhere at once, ending a move under way. */
  view(): Camera
  setView(camera: Camera): void
}

/**
 * The pointer over a viewport's canvas: every event of it is told to one
 * listener as a `ViewportPointer`, but for those that are the gizmo's. It
 * knows whether a button is held, wherever it is let go, and so when the
 * camera may be the pointer's again; and it zooms by the wheel while a tool
 * has the pointer and asked for that.
 */
export class PointerRouter {
  private listener: ((e: ViewportPointer) => void) | null = null
  /** The tool has been told the pointer is the gizmo's. */
  private gizmoHasPointer = false
  /** Whether the camera is the pointer's to move, as last asked; whether the wheel zooms while it is not; and whether a button is down on the canvas. */
  private navigation = true
  private wheelZooms = false
  private held = false
  /** The left button's press, until it is released. */
  private press: Press | null = null

  /** Construct it after the orbit and the gizmo: their listeners on the canvas then run first, and the gizmo has said whether the pointer is on it. */
  constructor(private readonly host: PointerHost) {
    for (const type of POINTER_EVENTS) host.canvas.addEventListener(type, this.onPointerEvent)
    host.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    // A button let go beside the canvas, or the window left mid-drag: the canvas is told of neither.
    window.addEventListener('pointerup', this.onReleasedAnywhere)
    window.addEventListener('blur', this.onReleasedAnywhere)
  }

  /** There is one listener: a second call replaces the first. */
  listen(cb: (e: ViewportPointer) => void): void {
    this.listener = cb
  }

  /** See `Viewport.setNavigation`. Switched back on while a button is still held, the orbit stays off until the button is let go. */
  setNavigation(enabled: boolean, opts: { wheel?: boolean } = {}): void {
    this.navigation = enabled
    this.wheelZooms = !enabled && opts.wheel === true
    this.host.gizmo.setEnabled(enabled) // a tool that drags has the pointer to itself: no handle lights up under it
    if (!enabled || !this.held) this.host.orbit.enabled = enabled
  }

  /** Whether a button is down in the viewport, on the canvas or on the gizmo. */
  get busy(): boolean {
    return this.held || this.host.gizmo.dragging
  }

  /** A drag of the gizmo began or ended: the drag is the gizmo's, not the orbit's. */
  gizmoDragging(on: boolean): void {
    if (on) this.host.orbit.enabled = false
    else if (!this.held) this.host.orbit.enabled = this.navigation
  }

  dispose(): void {
    this.listener = null
    for (const type of POINTER_EVENTS) this.host.canvas.removeEventListener(type, this.onPointerEvent)
    this.host.canvas.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('pointerup', this.onReleasedAnywhere)
    window.removeEventListener('blur', this.onReleasedAnywhere)
  }

  private readonly onPointerEvent = (e: PointerEvent): void => {
    const { host } = this
    const kind = e.type === 'pointermove' ? 'move' : e.type === 'pointerdown' ? 'down' : e.type === 'pointerup' ? 'up' : 'cancel'
    const press = this.press
    if (kind === 'down') this.press = e.button === 0 ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null
    else if (kind !== 'move') this.press = null
    this.held = e.buttons !== 0
    if (!this.held && !host.gizmo.dragging) host.orbit.enabled = this.navigation
    // Over a handle of the gizmo, or in a press that began on one, the pointer is the gizmo's: the tool is told once that it has gone.
    const gizmos = host.gizmo.takes(kind, e.buttons)
    const cb = this.listener
    const at = host.canvasPoint(e.clientX, e.clientY)
    if (!cb || !at) return

    if (gizmos) {
      if (!this.gizmoHasPointer) cb({ type: 'cancel', hit: null, ray: pointerRay(host.camera(), at.ndc), client: [e.clientX, e.clientY], buttons: e.buttons, shift: e.shiftKey, alt: e.altKey })
      this.gizmoHasPointer = true
      return
    }
    this.gizmoHasPointer = false

    // Nothing is pointed at while a drag turns the camera.
    const turning = kind === 'move' && e.buttons !== 0 && host.orbit.enabled
    const hit = kind === 'cancel' || turning ? null : host.pick(e.clientX, e.clientY)
    host.syncMatrices()
    const event = { hit, ray: pointerRay(host.camera(), at.ndc), client: [e.clientX, e.clientY] as [number, number], buttons: e.buttons, shift: e.shiftKey, alt: e.altKey }
    cb({ type: kind, ...event })
    if (kind === 'up' && isClick(press, { button: e.button, x: e.clientX, y: e.clientY, at: e.timeStamp })) cb({ type: 'click', ...event })
  }

  private readonly onReleasedAnywhere = (e: Event): void => {
    if (e.type === 'blur' || (e as PointerEvent).buttons === 0) this.held = false
  }

  /**
   * The wheel while a tool has the pointer and asked to keep it zooming: the
   * orbit is switched off then, and takes no wheel in the middle of a drag in
   * any case. Zooms as the orbit does, by the same step; an orthographic
   * camera keeps what is under the pointer where it is, a perspective one
   * comes nearer its target. The camera is not turned.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.navigation || !this.wheelZooms || e.deltaY === 0) return
    e.preventDefault()
    const { host } = this
    const closer = wheelZoom(e.deltaY, e.deltaMode)
    const c = host.view()
    const at = host.canvasPoint(e.clientX, e.clientY)
    if (!c.ortho || !at) {
      const position = c.position.map((p, i) => c.target[i] + (p - c.target[i]) / closer) as Vec3
      return host.setView({ ...c, position })
    }
    host.syncMatrices()
    const { origin, direction } = pointerRay(host.camera(), at.ndc)
    // The pointer's place on the plane through the target that faces the camera.
    const off = origin.map((o, i) => o - c.target[i])
    const depth = off[0] * direction[0] + off[1] * direction[1] + off[2] * direction[2]
    const shift = off.map((o, i) => (o - direction[i] * depth) * (1 - 1 / closer))
    host.setView({ ...c, zoom: c.zoom * closer, position: c.position.map((p, i) => p + shift[i]) as Vec3, target: c.target.map((t, i) => t + shift[i]) as Vec3 })
  }
}

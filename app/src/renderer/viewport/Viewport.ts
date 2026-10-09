import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Mark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, SectionPlane, ViewName } from '../../shared/view'
import { Highlights, MARK_LAYERS, type HighlightLayer } from './highlight'
import { labelAnchor, markPoints } from './marks/markObjects'
import { mmPerPx, type Placed } from './marks/labels'
import { MarkLayer, type Draft } from './marks/MarkLayer'
import { chipSize, drawLabels, overlayFonts, type LabelStyle } from './overlay'
import { colorFor, colorsByName, edgeTint, mix } from './palette'
import { buildPart, type BuiltPart, disposePart } from './partMesh'
import { type Hit, pickUnder } from './picking'
import { NAMED_ASPECT, PictureMaker, type ImageRequest, type Picture } from './picture'
import { PointerRouter, type ViewportPointer } from './pointer'
import { SectionCut } from './section'
import { ShapeGizmo, type GizmoMode, type ShapeTransform } from './ShapeGizmo'
import { DEFAULT_FOV, fitCamera, gridStep, lockedViewOf, viewDirection } from './views'

export interface LayerState {
  visible?: boolean
  color?: string
  opacity?: number
}

interface Entry {
  part: Part
  built: BuiltPart
}

interface Theme {
  surface: string
  hairline: string
  ink: string
  muted: string
  accent: string
  agent: string
  user: string
  panel: string
  /** The three axes of the gizmo. */
  axisX: string
  axisY: string
  axisZ: string
}

export type { GizmoMode, ImageRequest, Picture, ShapeTransform, ViewportPointer }

type AnyCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

type Vec3 = [number, number, number]

/** The light values of styles/tokens.css, used where no stylesheet is loaded. */
const LIGHT_THEME: Theme = { surface: '#F1EFEA', hairline: '#DAD6CE', ink: '#22252A', muted: '#6C7178', accent: '#1D46B8', agent: '#2B8A5C', user: '#CF3F2C', panel: '#FAF9F6', axisX: '#9A3350', axisY: '#4C7F2C', axisZ: '#2E5FA9' }

const SETTLE_MS = 150
/** How near the handle of the section's plane the pointer must be to take hold of it, in pixels. */
export const SECTION_HANDLE_REACH_PX = 12
const MOVE_MS = 240
/** How far a stale part's colour is taken towards the background. */
const STALE_FADE = 0.6
/** What `fit` and the named views frame when no part is shown. */
const EMPTY_BOX = { min: [-50, -50, 0], max: [50, 50, 50] }

/**
 * The three.js viewport: parts, ground, camera and pictures for the agent.
 * Imperative on purpose, so no per-frame state passes through React. Z is up,
 * units are millimetres. It draws only when something changed.
 */
export class Viewport {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly perspective = new THREE.PerspectiveCamera(DEFAULT_FOV, NAMED_ASPECT, 0.1, 1000)
  private readonly orthographic = new THREE.OrthographicCamera()
  private camera: AnyCamera = this.perspective
  private readonly controls: OrbitControls
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 2.1)
  private readonly ground = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())

  private readonly entries = new Map<string, Entry>()
  private readonly layers = new Map<string, LayerState>()
  private colors = new Map<string, string>()
  private layouts: string[] = []
  private layout = ''
  private stale = false
  /** False until a scene with parts has been framed; after that the camera is the user's. */
  private framed = false
  /** Everything drawn in the current layout, for the clip planes: the parts and the grid (`groundExtent`), and the marks. */
  private extent = new THREE.Sphere(new THREE.Vector3(), 100)
  private groundExtent = this.extent

  private theme: Theme = LIGHT_THEME
  private readonly scheme: MediaQueryList | null
  private aspect = NAMED_ASPECT
  private fov = DEFAULT_FOV
  private frame = 0
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly settledListeners: ((c: Camera) => void)[] = []
  private readonly drawnListeners = new Set<() => void>()
  private move: { from: Camera; to: Camera; start: number } | null = null
  private disposed = false

  private readonly highlights = new Highlights()
  /** The section through the parts: what is highlighted on them is cut with them. */
  private readonly section = new SectionCut((planes) => this.highlights.setClipping(planes))
  /** Whether the last `pick` ended on the cut face of a solid. */
  private onCut = false
  private readonly marks = new MarkLayer(markColours(LIGHT_THEME))
  /** The marks of the object as last given, resolved ones too: `focusMark` goes to any of them. */
  private allMarks: Mark[] = []
  /** Over the canvas, for the labels of the marks: drawn anew with every frame, never through React. */
  private readonly labelCanvas: HTMLCanvasElement | null
  /** The gizmo on the shape being edited. */
  private readonly gizmo: ShapeGizmo
  private readonly pointer: PointerRouter
  private readonly pictures: PictureMaker

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // The stencil is what the cut faces of a section are counted in (section.ts).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true })
    this.renderer.localClippingEnabled = true
    // Pictures for the agent are encoded by hand to match these two (see Encoder in picture.ts).
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping

    for (const camera of [this.perspective, this.orthographic]) camera.up.set(0, 0, 1)
    this.perspective.position.set(120, -120, 96)

    // The sky is +Z. With the key light riding on the camera, no side goes black.
    const sky = new THREE.HemisphereLight(0xffffff, 0xc8c4bc, 1.5)
    sky.position.set(0, 0, 1)
    this.scene.add(sky, this.keyLight, this.keyLight.target)

    // Drawn first and kept out of the depth buffer, so parts resting on the
    // ground cover it without flicker.
    this.ground.material.depthWrite = false
    this.ground.renderOrder = -1
    this.ground.frustumCulled = false
    this.scene.add(this.ground, this.marks.group, this.section.decor)

    this.labelCanvas = canvas.parentElement ? document.createElement('canvas') : null
    if (this.labelCanvas) {
      this.labelCanvas.className = 'mark-labels'
      canvas.after(this.labelCanvas)
    }
    // A label drawn before its face has loaded is in the fallback face: draw again once it is there.
    void overlayFonts().then(() => this.invalidate())

    this.controls = new OrbitControls(this.perspective, canvas)
    this.controls.enableDamping = false
    this.controls.screenSpacePanning = true
    this.controls.zoomToCursor = true
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('start', this.onControlStart)
    this.controls.addEventListener('change', this.onCameraChange)

    // Before this class listens to the pointer: by then the gizmo has said whether the pointer is on it.
    this.gizmo = new ShapeGizmo(this.perspective, canvas, {
      shape: (id) => {
        const mark = this.marks.markOf(this.layout, id)
        return mark?.kind === 'shape' ? mark : null
      },
      preview: (id, shape) => {
        this.marks.preview(id, shape)
        this.extent = this.measured()
        this.invalidate()
      },
      dragging: (on) => this.pointer.gizmoDragging(on),
      redraw: () => this.invalidate()
    })
    this.scene.add(...this.gizmo.objects)

    // After the orbit and the gizmo, whose listeners on the canvas are to run before its own.
    this.pointer = new PointerRouter({
      canvas,
      orbit: this.controls,
      gizmo: this.gizmo,
      camera: () => this.camera,
      canvasPoint: (x, y) => this.canvasPoint(x, y),
      pick: (x, y) => this.pick(x, y),
      pickedCut: () => this.onCut,
      syncMatrices: () => this.syncMatrices(),
      view: () => this.getCamera(),
      setView: (c) => {
        this.move = null
        this.applyCamera(c)
      }
    })
    this.pictures = new PictureMaker({
      renderer: this.renderer,
      scene: this.scene,
      marks: this.marks,
      highlights: this.highlights,
      closed: () => this.disposed,
      layouts: () => this.layouts,
      layout: () => this.layout,
      aspect: () => this.aspect,
      parts: () => this.entries.values(),
      currentView: () => this.getCamera(),
      namedView: (name, parts, aspect) => this.namedCamera(name, boxOf(parts) ?? EMPTY_BOX, aspect, true),
      cameraFor: (view, aspect, extent) => this.pictureCamera(view, aspect, extent),
      hiddenParts: (layout, drawn) => this.hiddenParts(layout, drawn),
      hideGizmo: () => this.gizmo.hide(),
      section: () => this.section.get(),
      cutBy: (plane, layout, decor) => this.cutBy(plane, layout, decor),
      layGround: (layout) => this.rebuildGround(layout),
      groundExtent: () => this.groundExtent,
      tintPicks: (layout) => this.tintPicks(layout),
      showMarks: () => this.showMarks(),
      colours: () => ({ ...this.labelStyle(), muted: this.theme.muted })
    })

    // Without preventDefault the browser never restores a lost context.
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    this.scheme?.addEventListener('change', this.onSchemeChange)
    this.readTheme()

    this.rebuildGround(this.layout)
    this.resize()
    this.invalidate()
  }

  /** Shows a new build. The camera stays where it is, unless this is the first scene with parts. */
  setScene(scene: Scene, blob: ArrayBuffer): void {
    const seen = new Set<string>()
    for (const part of scene.parts) {
      seen.add(part.key)
      let entry = this.entries.get(part.key)
      if (entry && entry.part.hash === part.hash) {
        entry.part = part
      } else {
        if (entry) this.discard(entry)
        entry = { part, built: buildPart(part, blob) }
        this.entries.set(part.key, entry)
        this.scene.add(entry.built.group)
        this.section.add(entry.built)
      }
      // `loc` is the tessellator's local → object transform; it can differ between builds of the same shape.
      entry.built.group.position.fromArray(part.loc.t)
      entry.built.group.quaternion.fromArray(part.loc.q)
    }
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue
      this.discard(entry)
      this.entries.delete(key)
    }

    this.layouts = [...scene.layouts]
    if (!this.layouts.includes(this.layout)) this.layout = this.layouts[0] ?? ''
    this.colors = colorsByName(scene.parts.map((p) => p.name))
    this.refresh()

    if (!this.framed && this.shownParts().length > 0) {
      this.framed = true
      this.setView('iso', false)
    }
    this.invalidate()
  }

  /**
   * The marks of the object on show, of every layout: those of the layout
   * shown that are not resolved are drawn, each with its number. A mark's
   * objects are made once and again only when the mark itself changes.
   */
  setMarks(marks: Mark[]): void {
    this.allMarks = marks
    this.marks.setMarks(marks)
    this.showMarks()
    this.extent = this.measured()
    this.tintPicks(this.layout)
    this.gizmo.place()
    this.invalidate()
  }

  /**
   * Puts a gizmo on a shape mark of the layout shown, to move it, turn it or
   * size it by dragging; null takes the gizmo away. While it is dragged the
   * shape is drawn as the drag has it, and nothing is told; when it is let go
   * `onChange` is called once, with what of the shape the drag changed: its
   * position, its rotation or its size, by `mode`. Sizing changes the size in
   * millimetres, never a scale: no axis under 0.1 mm, a cylinder's two
   * diameters and a sphere's three kept equal, a plane kept flat. The mark is
   * the caller's to change: if it is not changed to what `onChange` was given,
   * calling this again draws it as it is.
   */
  editShape(id: string | null, mode: GizmoMode, onChange: (shape: Partial<ShapeTransform>) => void): void {
    this.gizmo.edit(id, mode, onChange)
    // As main has them: a drag that came to nothing leaves no trace.
    this.marks.setMarks(this.allMarks)
    this.extent = this.measured()
    this.gizmo.place()
    this.invalidate()
  }

  /** The mark being worked on, or null: its label is ringed, its lines are wider, and a stroke shows its plane. On screen only: a picture for the agent draws every mark alike. */
  setActiveMark(id: string | null): void {
    this.marks.setActive(id)
    this.invalidate()
  }

  /** Goes to the view a mark was placed from. The layout is the caller's to switch: this moves the camera only. */
  focusMark(id: string): void {
    const mark = this.allMarks.find((m) => m.id === id)
    if (mark) this.setView(mark.camera, true)
  }

  /** Where the label of a mark of the layout shown is on the canvas, in client pixels, and whether it is in view; null for a mark that is not drawn. */
  markLabel(id: string): { x: number; y: number; visible: boolean } | null {
    const rect = this.canvas.getBoundingClientRect()
    const label = this.placedLabel(id)
    return label ? { x: rect.left + label.box.x + label.box.w / 2, y: rect.top + label.box.y + label.box.h / 2, visible: label.visible } : null
  }

  /** The label of a mark of the layout shown as it is placed on the canvas, in the canvas's own pixels. */
  private placedLabel(id: string): Placed | null {
    const rect = this.canvas.getBoundingClientRect()
    this.syncMatrices()
    const size = { width: rect.width, height: rect.height }
    const ctx = this.labelCanvas?.getContext('2d')
    if (!ctx || size.width === 0 || size.height === 0) return null
    return this.marks.labels(this.layout, this.camera, size, 1, chipSize(ctx, 1)).find((l) => l.id === id) ?? null
  }

  /**
   * What a mark of the layout shown covers on the canvas, in client pixels:
   * its points and the chip of its number. `at` is where it is anchored.
   * Null for a mark that is not drawn. For whatever is put beside a mark.
   */
  markBox(id: string): { left: number; top: number; right: number; bottom: number; at: [number, number]; visible: boolean } | null {
    const mark = this.marks.markOf(this.layout, id)
    const label = mark && this.placedLabel(id)
    if (!mark || !label) return null
    const rect = this.canvas.getBoundingClientRect()
    const at = this.project(labelAnchor(mark).point)
    const xs = [at[0], rect.left + label.box.x, rect.left + label.box.x + label.box.w]
    const ys = [at[1], rect.top + label.box.y, rect.top + label.box.y + label.box.h]
    for (const point of markPoints(mark)) {
      const [x, y] = this.project(point)
      xs.push(x)
      ys.push(y)
    }
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), at, visible: label.visible }
  }

  /**
   * What the pointer is making, drawn until it is a mark: a pin where it was
   * clicked, an arrow being dragged, a stroke being drawn. Null for nothing. It goes straight to the
   * scene: nothing of a drag passes through React or the marks.
   */
  setDraft(draft: Draft | null): void {
    this.marks.setDraft(draft)
    this.extent = this.measured()
    this.invalidate()
  }

  /** Calls back after every frame drawn: what is laid over the view (the note of a mark) follows the camera with it. Returns what stops it. */
  onDrawn(cb: () => void): () => void {
    this.drawnListeners.add(cb)
    return () => this.drawnListeners.delete(cb)
  }

  /** Shows the parts of one layout. A layout the scene does not have is ignored. */
  setLayout(layout: string): void {
    if (layout === this.layout || !this.layouts.includes(layout)) return
    this.layout = layout
    this.refresh()
    this.invalidate()
  }

  /** Sets visibility, colour or opacity of one part; what is left out keeps its value. Remembered across rebuilds. */
  setLayer(key: string, s: LayerState): void {
    const was = this.layers.get(key)
    this.layers.set(key, { ...was, ...s })
    const entry = this.entries.get(key)
    if (entry) this.applyLook(entry)
    if (entry && (was?.visible !== false) !== (this.layers.get(key)?.visible !== false)) {
      // The marks on a part come and go with it.
      this.showMarks()
      this.extent = this.measured()
      this.tintPicks(this.layout)
      this.gizmo.place()
    }
    this.invalidate()
  }

  /** Shows the marks of the layout on screen, but for those on the parts switched off. */
  private showMarks(): void {
    this.marks.show(this.layout, this.hiddenParts(this.layout))
  }

  /**
   * The names of the parts of a layout that are not drawn: those switched
   * off, or, given the keys of the parts a picture draws, every other.
   */
  private hiddenParts(layout: string, drawn?: ReadonlySet<string>): Set<string> {
    const hidden = new Set<string>()
    for (const { part } of this.entries.values()) {
      if (part.layout !== layout) continue
      if (drawn ? !drawn.has(part.key) : this.layers.get(part.key)?.visible === false) hidden.add(part.name)
    }
    return hidden
  }

  /** Dims the parts, to say they are older than the latest build attempt. */
  setStale(stale: boolean): void {
    if (stale === this.stale) return
    this.stale = stale
    for (const entry of this.entries.values()) this.applyLook(entry)
    this.invalidate()
  }

  /** Goes to a standard view, fitted to the visible parts in the current projection, or to a given camera. */
  setView(v: ViewName | Camera, animate = false): void {
    const to = typeof v === 'string' ? this.namedCamera(v, this.visibleBox(), this.aspect, this.camera === this.orthographic) : v
    const from = this.getCamera()
    if (animate && from.ortho === to.ortho) {
      this.move = { from, to, start: performance.now() }
      this.invalidate()
    } else {
      this.move = null
      this.applyCamera(to)
    }
  }

  /** Switches projection, keeping the part the same size at the camera's target. */
  setOrtho(ortho: boolean): void {
    const c = this.getCamera()
    if (c.ortho === ortho) return
    this.move = null
    if (ortho) {
      this.applyCamera({ ...c, ortho: true })
    } else {
      // An orthographic camera magnifies by zoom; a perspective one by coming closer.
      const position = c.position.map((p, i) => c.target[i] + (p - c.target[i]) / c.zoom) as Vec3
      this.applyCamera({ ...c, ortho: false, position, zoom: 1 })
    }
  }

  /** Frames the visible parts without turning the camera. */
  fit(): void {
    const c = this.getCamera()
    const dir = c.target.map((t, i) => t - c.position[i])
    this.move = null
    this.applyCamera(fitCamera(this.visibleBox(), dir, c.up, this.aspect, this.fov, c.ortho))
  }

  /**
   * The standard view the camera is locked on: orthographic, exactly one of
   * front, back, left, right, top and bottom, and not turned since. Panning
   * and zooming keep the lock; orbiting and perspective lose it. Null otherwise.
   */
  lockedView(): ViewName | null {
    return lockedViewOf(this.getCamera())
  }

  /** The box around the parts shown (failing that, around the layout), in the object frame. */
  bounds(): { min: Vec3; max: Vec3 } {
    const { min, max } = this.visibleBox()
    return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }
  }

  getCamera(): Camera {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      up: up.toArray(),
      ortho: this.camera === this.orthographic,
      fov: this.fov,
      zoom: this.camera.zoom
    }
  }

  // ---- pointing ----

  /**
   * What a point of the window is on: a face, or an edge within reach of it,
   * of the parts of the current layout that are switched on. A part that is
   * hidden is never hit; one that is see-through is hit like any other.
   * Coordinates are the browser's client pixels; the answer is in the object frame.
   */
  pick(clientX: number, clientY: number, opts?: { edges?: boolean }): Hit | null {
    const at = this.canvasPoint(clientX, clientY)
    if (!at) return null
    this.syncMatrices()
    // Not what is switched off, nor what the section leaves nothing of.
    const parts = [...this.entries.values()].filter((e) => e.built.group.visible && !this.section.removed(e.built)).map((e) => ({ key: e.part.key, name: e.part.name, built: e.built }))
    const keeps = this.section.keeps()
    const picked = pickUnder(parts, this.camera, at.ndc, at.size, { ...opts, cut: keeps && { keeps } })
    this.onCut = picked.cut
    return picked.hit
  }

  // ---- the section ----

  /**
   * Cuts the parts by a plane, or by none: what is on the side its normal
   * points to is not drawn, and each closed solid shows its cut face in its
   * own colour, a step darker. A part that is not a closed solid is cut open,
   * and one the plane only touches or leaves nothing of is not drawn at all.
   * The marks, the grid and the gizmo are not cut; a mark anchored in the half
   * taken away is drawn dimmed. With a section, only what is drawn can be
   * pointed at: on a cut face `pick` finds nothing.
   *
   * Cheap enough to call with every move of a drag: the frame is drawn once.
   */
  setSection(plane: SectionPlane | null): void {
    this.cutBy(plane, this.layout, true)
    this.extent = this.measured()
    this.invalidate()
  }

  getSection(): SectionPlane | null {
    return this.section.get()
  }

  /** Whether the plane has its handle: an arrow at its middle, along its normal, while the plane is the pointer's to drag. */
  showSectionHandle(shown: boolean): void {
    this.section.showHandle(shown)
    this.invalidate()
  }

  /** Whether a point of the window is on the handle of the plane, or within `SECTION_HANDLE_REACH_PX` of it. False while there is no handle. */
  onSectionHandle(clientX: number, clientY: number): boolean {
    this.syncMatrices()
    const span = this.section.handleSpan((at) => mmPerPx(this.camera, at, this.canvas.clientHeight || 1))
    if (!span) return false
    const [ax, ay] = this.project(span[0].toArray())
    const [bx, by] = this.project(span[1].toArray())
    const [dx, dy] = [bx - ax, by - ay]
    const length = dx * dx + dy * dy
    const t = length > 0 ? Math.min(Math.max(((clientX - ax) * dx + (clientY - ay) * dy) / length, 0), 1) : 0
    return Math.hypot(ax + dx * t - clientX, ay + dy * t - clientY) <= SECTION_HANDLE_REACH_PX
  }

  /** The box the section is laid across: around every part of the layout shown, switched on or not, in the object frame. */
  sectionBox(): { min: Vec3; max: Vec3 } {
    const { min, max } = this.boxOfLayout(this.layout)
    return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }
  }

  private boxOfLayout(layout: string): { min: number[]; max: number[] } {
    return boxOf(this.partsOf(layout)) ?? EMPTY_BOX
  }

  /** Cuts by a plane laid across a layout's parts; `decor` says whether the plane itself is drawn. */
  private cutBy(plane: SectionPlane | null, layout: string, decor: boolean): void {
    this.section.showDecor(decor)
    this.section.set(plane, this.boxOfLayout(layout))
    this.marks.setSection(plane)
    // A picture is drawn at once, with the parts it shows already switched on; the screen's frame asks in `draw`.
    if (!decor) this.section.outline()
  }

  /** A sphere around everything drawn in the layout shown: the parts and the grid, the marks, the plane of the section. */
  private measured(): THREE.Sphere {
    return this.section.extend(this.marks.extend(this.groundExtent.clone(), this.layout))
  }

  /** Where a point of the object frame falls in the window, in client pixels. */
  project(point: Vec3): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    this.syncMatrices()
    const v = new THREE.Vector3().fromArray(point).project(this.camera)
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height]
  }

  /** Marks what the pointer is on; null for nothing. */
  setHover(hit: Hit | null): void {
    this.highlight('hover', hit ? [hit.ref] : [])
  }

  /** Marks the selection, in the accent colour. Refs are of the layout shown: `lid/F12`, `lid/E3`, `lid`. */
  setSelection(refs: string[]): void {
    this.highlight('selection', refs)
  }

  /** Marks what the agent points at, in the colour of its marks. */
  setAgentHighlight(refs: string[]): void {
    this.highlight('agent', refs)
  }

  /**
   * Has `cb` told what the pointer does over the canvas. There is one listener:
   * whoever calls this routes the events on, and a second call replaces the first.
   */
  onPointer(cb: (e: ViewportPointer) => void): void {
    this.pointer.listen(cb)
  }

  /**
   * Whether dragging turns, pans and zooms the camera. A tool that drags
   * switches it off meanwhile. Switched back on while a button is still held,
   * it stays off until the button is let go: the rest of a drag that a tool
   * gave up does not turn the camera. With `wheel`, switching it off leaves
   * the wheel zooming: a long stroke is drawn across more than one zoom.
   */
  setNavigation(enabled: boolean, opts: { wheel?: boolean } = {}): void {
    this.pointer.setNavigation(enabled, opts)
  }

  /**
   * Whether the person has a button down in the viewport: turning the camera,
   * dragging an arrow, a stroke or a handle of the gizmo. What would change
   * the view under them waits.
   */
  pointerBusy(): boolean {
    return this.pointer.busy
  }

  /** Calls back 150 ms after the camera stops moving, however it was moved. */
  onCameraSettled(cb: (c: Camera) => void): void {
    this.settledListeners.push(cb)
  }

  /**
   * A still picture for the agent, with an axis triad and a scale bar. It is
   * drawn off screen in one go: the user's camera, layout and the frame on
   * screen are left alone, and it works while the window is hidden. `size` is
   * the long edge in pixels. Named views are orthographic, 4:3 and fitted to the
   * parts shown; `current` is what the user sees.
   *
   * A request given as a function is asked for in the same turn as the drawing,
   * after every wait that comes before it: what it reads then (the scene on
   * show, its revision) is what the picture is of.
   */
  renderImage(request: ImageRequest | (() => ImageRequest)): Promise<Picture> {
    return this.pictures.render(request)
  }

  /** Matches the drawing buffer to the canvas's size on the page. Call when the canvas is resized. */
  resize(): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width === 0 || height === 0) return
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(width, height, false)
    if (this.labelCanvas) {
      this.labelCanvas.width = Math.round(width * window.devicePixelRatio)
      this.labelCanvas.height = Math.round(height * window.devicePixelRatio)
    }
    this.aspect = width / height
    // Resizing clears the canvas: draw now rather than show a blank frame.
    this.draw()
  }

  dispose(): void {
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    clearTimeout(this.settleTimer)
    this.settledListeners.length = 0
    this.drawnListeners.clear()
    this.pointer.dispose()
    this.scheme?.removeEventListener('change', this.onSchemeChange)
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.controls.dispose()
    this.gizmo.dispose()
    this.section.dispose()
    for (const entry of this.entries.values()) this.discard(entry)
    this.entries.clear()
    this.highlights.dispose()
    this.marks.dispose()
    this.labelCanvas?.remove()
    this.ground.geometry.dispose()
    this.ground.material.dispose()
    this.pictures.dispose()
    this.renderer.dispose()
  }

  // ---- parts ----

  private discard(entry: Entry): void {
    this.highlights.forget(entry.built)
    this.section.forget(entry.built)
    this.scene.remove(entry.built.group)
    disposePart(entry.built)
  }

  /** Brings every part's look and the ground in line with the current layout, layers and theme. */
  private refresh(): void {
    for (const entry of this.entries.values()) this.applyLook(entry)
    this.groundExtent = this.rebuildGround(this.layout)
    // The parts may have moved, and the plane is laid across those of this layout.
    this.cutBy(this.section.get(), this.layout, true)
    this.showMarks()
    this.extent = this.measured()
    this.highlights.apply(this.partNamed) // the refs may name other geometry now, or none
    this.tintPicks(this.layout)
    this.gizmo.place() // a shape of another layout is not there to hold
  }

  /**
   * Tints what a layout's pick marks are on, in their authors' colours. A ref
   * that names nothing in the scene as it is now (a face that is gone, a part
   * that is) tints nothing: the mark is still drawn at its point.
   */
  private tintPicks(layout: string): void {
    const refs = this.marks.pickRefs(layout)
    const partNamed = (name: string): BuiltPart | undefined => this.entries.get(`${layout}:${name}`)?.built
    this.highlights.set('userMark', refs.user)
    this.highlights.set('agentMark', refs.agent)
    for (const layer of MARK_LAYERS) this.highlights.apply(partNamed, layer)
  }

  private labelStyle(): LabelStyle {
    return { user: this.theme.user, agent: this.theme.agent, paper: this.theme.panel, surface: this.theme.surface, ink: this.theme.ink }
  }

  private highlight(layer: HighlightLayer, refs: string[]): void {
    if (!this.highlights.set(layer, refs)) return
    this.highlights.apply(this.partNamed, layer)
    this.invalidate()
  }

  /** A part of the layout shown, by name. */
  private readonly partNamed = (name: string): BuiltPart | undefined => this.entries.get(`${this.layout}:${name}`)?.built

  /** A point of the window as the camera sees it: -1 to 1 across the canvas, y up. Null while the canvas has no size. */
  private canvasPoint(clientX: number, clientY: number): { ndc: { x: number; y: number }; size: { width: number; height: number } } | null {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = { x: ((clientX - rect.left) / rect.width) * 2 - 1, y: 1 - ((clientY - rect.top) / rect.height) * 2 }
    return { ndc, size: { width: rect.width, height: rect.height } }
  }

  /** Brings the matrices that picking reads up to date: a frame may not have been drawn since they changed. */
  private syncMatrices(): void {
    setProjection(this.camera, this.controls.target, this.fov, this.aspect, this.extent)
    this.camera.updateMatrixWorld()
    this.scene.updateMatrixWorld()
  }

  private applyLook(entry: Entry): void {
    const { part, built } = entry
    const layer = this.layers.get(part.key)
    const base = toHex(layer?.color ?? this.colors.get(part.name) ?? colorFor(part.name, -1))
    const surface = toHex(this.theme.surface)
    const fade = (hex: string) => (this.stale ? mix(hex, surface, STALE_FADE) : hex)
    built.mesh.material.color.set(fade(base))
    built.edges.material.color.set(fade(edgeTint(base)))

    const opacity = Math.min(Math.max(layer?.opacity ?? 1, 0), 1)
    for (const material of [built.mesh.material, built.edges.material]) {
      const transparent = opacity < 1
      if (material.transparent !== transparent) material.needsUpdate = true
      material.transparent = transparent
      material.opacity = opacity
      material.depthWrite = !transparent
    }
    this.section.look(built, fade(base), opacity, fade(edgeTint(base)))
    built.group.visible = part.layout === this.layout && layer?.visible !== false
  }

  /** Parts of the current layout that are switched on. */
  private shownParts(): Part[] {
    return [...this.entries.values()].filter((e) => e.built.group.visible).map((e) => e.part)
  }

  /** What `fit` and the named views frame: the parts shown, else the whole layout. */
  private visibleBox(): { min: number[]; max: number[] } {
    return boxOf(this.shownParts()) ?? boxOf(this.partsOf(this.layout)) ?? EMPTY_BOX
  }

  private partsOf(layout: string): Part[] {
    return [...this.entries.values()].filter((e) => e.part.layout === layout).map((e) => e.part)
  }

  // ---- ground and theme ----

  /**
   * Lays the grid under a layout's parts, on the lowest z of the layout, and
   * returns a sphere around the parts and the grid.
   */
  private rebuildGround(layout: string): THREE.Sphere {
    const box = boxOf(this.partsOf(layout)) ?? EMPTY_BOX
    const [x0, y0, z] = box.min
    const [x1, y1, z1] = box.max
    const size = Math.max(x1 - x0, y1 - y0) || z1 - z || 10
    const step = gridStep(size)
    const pad = Math.max(size / 2, step * 2)
    const left = Math.floor((x0 - pad) / step) * step
    const right = Math.ceil((x1 + pad) / step) * step
    const near = Math.floor((y0 - pad) / step) * step
    const far = Math.ceil((y1 + pad) / step) * step

    const points: number[] = []
    for (let i = 0, n = Math.round((right - left) / step); i <= n; i++) {
      const x = left + i * step
      points.push(x, near, z, x, far, z)
    }
    for (let i = 0, n = Math.round((far - near) / step); i <= n; i++) {
      const y = near + i * step
      points.push(left, y, z, right, y, z)
    }
    this.ground.geometry.dispose()
    this.ground.geometry = new THREE.BufferGeometry()
    this.ground.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))

    const all = new THREE.Box3(new THREE.Vector3(left, near, z), new THREE.Vector3(right, far, Math.max(z1, z)))
    return all.getBoundingSphere(new THREE.Sphere())
  }

  private readTheme(): void {
    const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
    const read = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback
    this.theme = {
      surface: read('--surface', LIGHT_THEME.surface),
      hairline: read('--hairline', LIGHT_THEME.hairline),
      ink: read('--ink', LIGHT_THEME.ink),
      muted: read('--muted', LIGHT_THEME.muted),
      accent: read('--accent', LIGHT_THEME.accent),
      agent: read('--agent-mark', LIGHT_THEME.agent),
      user: read('--user-mark', LIGHT_THEME.user),
      panel: read('--panel', LIGHT_THEME.panel),
      axisX: read('--axis-x', LIGHT_THEME.axisX),
      axisY: read('--axis-y', LIGHT_THEME.axisY),
      axisZ: read('--axis-z', LIGHT_THEME.axisZ)
    }
    // The axes keep their usual colours, toned to the palette; the handle under the pointer is ink, like anything pressed.
    this.gizmo.setColours(toHex(this.theme.axisX), toHex(this.theme.axisY), toHex(this.theme.axisZ), toHex(this.theme.ink))
    this.highlights.setColors(this.theme)
    this.marks.setColours(markColours(this.theme))
    this.section.setColours(toHex(this.theme.muted), toHex(this.theme.accent))
    this.showMarks()
    this.scene.background = new THREE.Color(this.theme.surface)
    this.ground.material.color.set(this.theme.hairline)
  }

  private readonly onSchemeChange = (): void => {
    this.readTheme()
    for (const entry of this.entries.values()) this.applyLook(entry) // stale parts fade towards the surface
    this.invalidate()
  }

  // ---- camera ----

  private namedCamera(name: ViewName, box: { min: number[]; max: number[] }, aspect: number, ortho: boolean): Camera {
    const { dir, up } = viewDirection(name)
    return fitCamera(box, dir, up, aspect, this.fov, ortho)
  }

  private applyCamera(c: Camera): void {
    const camera = c.ortho ? this.orthographic : this.perspective
    const target = new THREE.Vector3().fromArray(c.target)
    const position = new THREE.Vector3().fromArray(c.position)
    const offset = position.clone().sub(target)
    const dist = offset.length() || 1
    // The orbit keeps Z up, which says nothing about a camera looking straight
    // along Z. Lean it by a hair, so that `up` ends up at the top of the screen.
    if (Math.abs(offset.z) > dist * (1 - 1e-10)) {
      const lean = new THREE.Vector3(c.up[0], c.up[1], 0)
      if (lean.lengthSq() > 0) position.addScaledVector(lean.normalize(), -Math.sign(offset.z) * dist * 1e-5)
    }
    camera.position.copy(position)
    camera.zoom = c.zoom
    this.fov = c.fov
    this.camera = camera
    this.gizmo.setCamera(camera)
    this.controls.object = camera
    this.controls.target.copy(target)
    this.controls.update()
    this.onCameraChange()
  }

  private readonly onControlStart = (): void => {
    this.move = null // the user takes over from a camera move
  }

  private readonly onCameraChange = (): void => {
    // Keep the projection current between frames too: zooming to the cursor reads it.
    setProjection(this.camera, this.controls.target, this.fov, this.aspect, this.extent)
    this.invalidate()
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      const camera = this.getCamera()
      for (const cb of this.settledListeners) cb(camera)
    }, SETTLE_MS)
  }

  /** One step of an animated camera move; clears `move` once it has arrived. */
  private stepMove(now: number): void {
    const move = this.move
    if (!move) return
    const t = Math.min((now - move.start) / MOVE_MS, 1)
    if (t >= 1) {
      this.move = null
      this.applyCamera(move.to)
      return
    }
    const k = t * t * (3 - 2 * t)
    const { from, to } = move
    const vec = (a: Vec3) => new THREE.Vector3().fromArray(a)
    const target = vec(from.target).lerp(vec(to.target), k)
    const a = vec(from.position).sub(vec(from.target))
    const b = vec(to.position).sub(vec(to.target))
    const [la, lb] = [a.length(), b.length()]
    // Swing the camera round the target rather than cutting through the part.
    const turn = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize())
    const offset = a
      .normalize()
      .applyQuaternion(new THREE.Quaternion().slerp(turn, k))
      .multiplyScalar(la * (lb / la) ** k)
    this.applyCamera({
      ...to,
      position: target.clone().add(offset).toArray(),
      target: target.toArray(),
      zoom: from.zoom * (to.zoom / from.zoom) ** k
    })
  }

  private aimKeyLight(camera: THREE.Camera, target: THREE.Vector3): void {
    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    // From behind the viewer, above and to the left.
    this.keyLight.position.set(
      target.x + m[8] + 0.55 * m[4] - 0.4 * m[0],
      target.y + m[9] + 0.55 * m[5] - 0.4 * m[1],
      target.z + m[10] + 0.55 * m[6] - 0.4 * m[2]
    )
    this.keyLight.target.position.copy(target)
    this.keyLight.target.updateMatrixWorld()
  }

  /** A camera of its own for a picture of a view, with its frustum around `extent`; the key light is aimed along it. */
  private pictureCamera(view: Camera, aspect: number, extent: THREE.Sphere): AnyCamera {
    const camera: AnyCamera = view.ortho ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera()
    camera.up.fromArray(view.up)
    camera.position.fromArray(view.position)
    camera.zoom = view.zoom
    const target = new THREE.Vector3().fromArray(view.target)
    camera.lookAt(target)
    setProjection(camera, target, view.fov, aspect, extent)
    this.aimKeyLight(camera, target)
    return camera
  }

  // ---- drawing ----

  /** Asks for one frame. Any number of changes before it share that frame. */
  private invalidate(): void {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0
      this.stepMove(now)
      this.draw()
      if (this.move) this.invalidate()
    })
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
  }

  /** three.js has made its GPU state again by now; the canvas is blank until something draws. */
  private readonly onContextRestored = (): void => {
    this.invalidate()
  }

  private draw(): void {
    if (this.disposed) return
    setProjection(this.camera, this.controls.target, this.fov, this.aspect, this.extent)
    this.aimKeyLight(this.camera, this.controls.target)
    const size = { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
    this.camera.updateMatrixWorld()
    this.marks.update(this.camera, size)
    this.section.sizeHandle((at) => mmPerPx(this.camera, at, size.height))
    this.section.outline()
    this.renderer.render(this.scene, this.camera)
    this.drawLabels(size)
    for (const cb of this.drawnListeners) cb()
  }

  /** The labels of the marks, on the canvas that lies over the 3D one. */
  private drawLabels(size: { width: number; height: number }): void {
    const ctx = this.labelCanvas?.getContext('2d')
    if (!this.labelCanvas || !ctx || size.width === 0 || size.height === 0) return
    ctx.setTransform(this.labelCanvas.width / size.width, 0, 0, this.labelCanvas.height / size.height, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    const labels = this.marks.labels(this.layout, this.camera, size, 1, chipSize(ctx, 1))
    drawLabels(ctx, labels, this.labelStyle(), 1, this.marks.activeId)
  }

}

/**
 * Sets a camera's frustum for a view of `target`. An orthographic camera shows
 * what a perspective one at the same place would show at the target (three.js
 * then divides by `camera.zoom`), which is the rule `visibleHeight` states. The
 * clip planes hug `extent`, so depth precision follows the size of the scene.
 */
function setProjection(camera: AnyCamera, target: THREE.Vector3, fovDeg: number, aspect: number, extent: THREE.Sphere): void {
  const reach = camera.position.distanceTo(extent.center)
  const radius = extent.radius * 1.05
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = fovDeg
    camera.aspect = aspect
    camera.far = reach + radius
    camera.near = Math.max(reach - radius, camera.far / 5000)
  } else {
    const half = camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)
    camera.top = half
    camera.bottom = -half
    camera.right = half * aspect
    camera.left = -half * aspect
    camera.near = reach - radius // may be negative: an orthographic camera can sit inside the scene
    camera.far = reach + radius
  }
  camera.updateProjectionMatrix()
}

/** The box around some parts, in the object frame, or null for none. */
function boxOf(parts: Part[]): { min: number[]; max: number[] } | null {
  if (parts.length === 0) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], part.bbox.min[i])
      max[i] = Math.max(max[i], part.bbox.max[i])
    }
  }
  return { min, max }
}

function markColours(theme: Theme): { user: string; agent: string; reference: string } {
  return { user: toHex(theme.user), agent: toHex(theme.agent), reference: toHex(theme.muted) }
}

/** Any CSS colour as #RRGGBB. */
function toHex(color: string): string {
  return `#${new THREE.Color(color).getHexString()}`
}

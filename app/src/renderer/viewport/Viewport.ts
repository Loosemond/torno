import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Mark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, ViewName } from '../../shared/view'
import { Highlights, MARK_LAYERS, type HighlightLayer } from './highlight'
import { labelAnchor, markPoints } from './marks/markObjects'
import type { Placed } from './marks/labels'
import { MarkLayer, type Draft } from './marks/MarkLayer'
import { PERSPECTIVE_NOTE, chipSize, drawLabels, drawOverlay, overlayUnit, type LabelStyle } from './overlay'
import { colorFor, colorsByName, edgeTint, mix } from './palette'
import { buildPart, type BuiltPart, disposePart } from './partMesh'
import { type Hit, pickParts, pointerRay } from './picking'
import { DEFAULT_FOV, fitCamera, gridStep, viewDirection, visibleHeight } from './views'

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
}

type AnyCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

/** What to draw for a picture: a view, a layout and the keys of the parts to show. `size` is the long edge in pixels. */
export interface ImageRequest {
  view: 'current' | ViewName | Camera
  layout: string
  visibleKeys: string[]
  size?: number
  /** Whether the marks of the layout are drawn, with their numbers. True when left out. */
  marks?: boolean
}

export interface Picture {
  png: Uint8Array
  width: number
  height: number
  caption: string
}
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
}

/** The light values of styles/tokens.css, used where no stylesheet is loaded. */
const LIGHT_THEME: Theme = { surface: '#F1EFEA', hairline: '#DAD6CE', ink: '#22252A', muted: '#6C7178', accent: '#1D46B8', agent: '#2B8A5C', user: '#CF3F2C', panel: '#FAF9F6' }

/** A press released within this many pixels and milliseconds of where and when it was made is a click, not a drag. */
const CLICK_PX = 4
const CLICK_MS = 400
const POINTER_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'pointerleave'] as const

const SETTLE_MS = 150
const MOVE_MS = 240
/** How far a stale part's colour is taken towards the background. */
const STALE_FADE = 0.6
/** Long edge of a picture for the agent, in pixels. */
const MAX_IMAGE = 2000
const DEFAULT_IMAGE = 1280
const MIN_IMAGE = 64
const NAMED_ASPECT = 4 / 3
/** How much larger the number of a mark is in a picture than on screen: a picture is read at a glance, and often scaled down first. */
const PICTURE_CHIP = 1.3
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
  private readonly marks = new MarkLayer(markColours(LIGHT_THEME))
  /** The marks of the object as last given, resolved ones too: `focusMark` goes to any of them. */
  private allMarks: Mark[] = []
  /** Over the canvas, for the labels of the marks: drawn anew with every frame, never through React. */
  private readonly labelCanvas: HTMLCanvasElement | null
  private pointerListener: ((e: ViewportPointer) => void) | null = null
  /** Whether the camera is the pointer's to move, as last asked, and whether a button is down on the canvas. */
  private navigation = true
  private held = false
  /** The left button's press, until it is released: where and when. */
  private press: { x: number; y: number; at: number } | null = null

  private imageTargets: { width: number; height: number; drawn: THREE.WebGLRenderTarget; encoded: THREE.WebGLRenderTarget } | null = null
  private readonly encoder = new Encoder()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    // Pictures for the agent are encoded by hand to match these two (see Encoder).
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
    this.scene.add(this.ground, this.marks.group)

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

    for (const type of POINTER_EVENTS) canvas.addEventListener(type, this.onPointerEvent)

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
    this.marks.show(this.layout)
    this.extent = this.marks.extend(this.groundExtent.clone(), this.layout)
    this.tintPicks(this.layout)
    this.invalidate()
  }

  /** The mark being worked on, or null: its label is ringed, its lines are wider, and a stroke shows its plane. */
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
   * clicked, an arrow being dragged. Null for nothing. It goes straight to the
   * scene: nothing of a drag passes through React or the marks.
   */
  setDraft(draft: Draft | null): void {
    this.marks.setDraft(draft)
    this.extent = this.marks.extend(this.groundExtent.clone(), this.layout)
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
    this.layers.set(key, { ...this.layers.get(key), ...s })
    const entry = this.entries.get(key)
    if (entry) this.applyLook(entry)
    this.invalidate()
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
    const parts = [...this.entries.values()].filter((e) => e.built.group.visible).map((e) => ({ key: e.part.key, name: e.part.name, built: e.built }))
    return pickParts(parts, this.camera, at.ndc, at.size, opts)
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
    this.pointerListener = cb
  }

  /**
   * Whether dragging turns, pans and zooms the camera. A tool that drags
   * switches it off meanwhile. Switched back on while a button is still held,
   * it stays off until the button is let go: the rest of a drag that a tool
   * gave up does not turn the camera.
   */
  setNavigation(enabled: boolean): void {
    this.navigation = enabled
    if (!enabled || !this.held) this.controls.enabled = enabled
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
  async renderImage(request: ImageRequest | (() => ImageRequest)): Promise<Picture> {
    // Before anything is drawn: nothing below may wait between hiding parts and restoring them.
    await overlayFonts()
    if (this.disposed) throw new Error('The viewport is closed')
    if (this.renderer.getContext().isContextLost()) throw new Error('The 3D view has lost its graphics context; try again in a moment')
    const req = typeof request === 'function' ? request() : request
    if (!this.layouts.includes(req.layout)) {
      const known = this.layouts.length > 0 ? `the layouts are ${this.layouts.join(', ')}` : 'nothing has been built yet'
      throw new Error(`No layout "${req.layout}": ${known}`)
    }
    const aspect = req.view === 'current' ? this.aspect : NAMED_ASPECT
    const size = typeof req.size === 'number' && Number.isFinite(req.size) ? req.size : DEFAULT_IMAGE
    const long = Math.round(Math.min(Math.max(size, MIN_IMAGE), MAX_IMAGE))
    const width = aspect >= 1 ? long : Math.max(1, Math.round(long * aspect))
    const height = aspect >= 1 ? Math.max(1, Math.round(long / aspect)) : long

    const wanted = new Set(req.visibleKeys)
    const shown = [...this.entries.values()].filter((e) => e.part.layout === req.layout && wanted.has(e.part.key))
    const box = boxOf(shown.map((e) => e.part)) ?? EMPTY_BOX

    let view: Camera
    let viewName: string
    if (req.view === 'current') {
      view = this.getCamera()
      viewName = 'current'
    } else if (typeof req.view === 'string') {
      view = this.namedCamera(req.view, box, aspect, true)
      viewName = req.view
    } else {
      view = req.view
      viewName = 'custom'
    }

    const withMarks = req.marks !== false
    const unit = overlayUnit(width, height)
    const otherLayout = req.layout !== this.layout

    // Everything from here to the end of `finally` is synchronous, so no frame on screen sees it.
    const before = new Map([...this.entries.values()].map((e) => [e, e.built.group.visible]))
    this.highlights.setVisible(false) // a picture is of the parts and the marks, not of what the person points at
    const camera: AnyCamera = view.ortho ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera()
    // Fat lines take their width in pixels from the renderer's viewport, which is the
    // canvas's whatever is being drawn to: for the picture it is the picture's size.
    const onScreen = this.renderer.getViewport(new THREE.Vector4())
    let pixels: Uint8ClampedArray<ArrayBuffer>
    try {
      this.renderer.setViewport(0, 0, width, height)
      for (const entry of this.entries.values()) entry.built.group.visible = false
      for (const entry of shown) entry.built.group.visible = true
      let extent = otherLayout ? this.rebuildGround(req.layout) : this.groundExtent
      this.marks.show(withMarks ? req.layout : null)
      this.marks.showDraft(false) // not a mark yet
      if (withMarks) {
        extent = this.marks.extend(extent.clone(), req.layout)
        this.highlights.setVisible(true, MARK_LAYERS)
        if (otherLayout) this.tintPicks(req.layout)
      }

      camera.up.fromArray(view.up)
      camera.position.fromArray(view.position)
      camera.zoom = view.zoom
      const target = new THREE.Vector3().fromArray(view.target)
      camera.lookAt(target)
      setProjection(camera, target, view.fov, aspect, extent)
      this.aimKeyLight(camera, target)
      // In the picture's own pixels: a dot is as large a share of a big picture as of a small one.
      this.marks.update(camera, { width, height }, unit)

      const targets = this.targetsFor(width, height)
      this.renderer.setRenderTarget(targets.drawn)
      this.renderer.render(this.scene, camera)
      this.encoder.render(this.renderer, targets.drawn.texture, targets.encoded)
      pixels = new Uint8ClampedArray(width * height * 4)
      this.renderer.readRenderTargetPixels(targets.encoded, 0, 0, width, height, pixels)
    } finally {
      this.renderer.setViewport(onScreen)
      this.renderer.setRenderTarget(null)
      for (const [entry, visible] of before) entry.built.group.visible = visible
      this.highlights.setVisible(true)
      this.marks.show(this.layout) // sized for the screen again by the next frame drawn
      this.marks.showDraft(true)
      if (otherLayout) {
        this.rebuildGround(this.layout)
        if (withMarks) this.tintPicks(this.layout)
      }
    }

    const picture = new OffscreenCanvas(width, height)
    const ctx = picture.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas to compose the picture')
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    drawOverlay(ctx, {
      width,
      height,
      right: [m[0], m[1], m[2]],
      up: [m[4], m[5], m[6]],
      mmPerPx: view.ortho ? visibleHeight(view) / height : null,
      ink: this.theme.ink,
      muted: this.theme.muted,
      surface: this.theme.surface
    })
    if (withMarks) {
      // With the camera of the picture, which for a named view is not the one on screen.
      const labels = this.marks.labels(req.layout, camera, { width, height }, unit, chipSize(ctx, unit * PICTURE_CHIP))
      drawLabels(ctx, labels, this.labelStyle(), unit * PICTURE_CHIP)
    }
    const blob = await picture.convertToBlob({ type: 'image/png' })
    const png = new Uint8Array(await blob.arrayBuffer())

    const names = shown.map((e) => e.part.name).join(', ') || 'none'
    const projection = view.ortho ? 'orthographic' : PERSPECTIVE_NOTE
    const caption = `view ${viewName} · layout ${req.layout} · parts ${names} · ${projection} · ${width}×${height}`
    return { png, width, height, caption }
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
    this.pointerListener = null
    for (const type of POINTER_EVENTS) this.canvas.removeEventListener(type, this.onPointerEvent)
    this.scheme?.removeEventListener('change', this.onSchemeChange)
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.controls.dispose()
    for (const entry of this.entries.values()) this.discard(entry)
    this.entries.clear()
    this.highlights.dispose()
    this.marks.dispose()
    this.labelCanvas?.remove()
    this.ground.geometry.dispose()
    this.ground.material.dispose()
    this.imageTargets?.drawn.dispose()
    this.imageTargets?.encoded.dispose()
    this.encoder.dispose()
    this.renderer.dispose()
  }

  // ---- parts ----

  private discard(entry: Entry): void {
    this.highlights.forget(entry.built)
    this.scene.remove(entry.built.group)
    disposePart(entry.built)
  }

  /** Brings every part's look and the ground in line with the current layout, layers and theme. */
  private refresh(): void {
    for (const entry of this.entries.values()) this.applyLook(entry)
    this.groundExtent = this.rebuildGround(this.layout)
    this.extent = this.marks.extend(this.groundExtent.clone(), this.layout)
    this.marks.show(this.layout)
    this.highlights.apply(this.partNamed) // the refs may name other geometry now, or none
    this.tintPicks(this.layout)
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

  private readonly onPointerEvent = (e: PointerEvent): void => {
    const kind = e.type === 'pointermove' ? 'move' : e.type === 'pointerdown' ? 'down' : e.type === 'pointerup' ? 'up' : 'cancel'
    const press = this.press
    if (kind === 'down') this.press = e.button === 0 ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null
    else if (kind !== 'move') this.press = null
    this.held = e.buttons !== 0
    if (!this.held) this.controls.enabled = this.navigation
    const cb = this.pointerListener
    const at = this.canvasPoint(e.clientX, e.clientY)
    if (!cb || !at) return

    // Nothing is pointed at while a drag turns the camera.
    const turning = kind === 'move' && e.buttons !== 0 && this.controls.enabled
    const hit = kind === 'cancel' || turning ? null : this.pick(e.clientX, e.clientY)
    this.syncMatrices()
    const event = { hit, ray: pointerRay(this.camera, at.ndc), client: [e.clientX, e.clientY] as [number, number], buttons: e.buttons, shift: e.shiftKey }
    cb({ type: kind, ...event })
    const still = press && e.button === 0 && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= CLICK_PX && e.timeStamp - press.at <= CLICK_MS
    if (kind === 'up' && still) cb({ type: 'click', ...event })
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
      panel: read('--panel', LIGHT_THEME.panel)
    }
    this.highlights.setColors(this.theme)
    this.marks.setColours(markColours(this.theme))
    this.marks.show(this.layout)
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

  private targetsFor(width: number, height: number): NonNullable<Viewport['imageTargets']> {
    const have = this.imageTargets
    if (have && have.width === width && have.height === height) return have
    have?.drawn.dispose()
    have?.encoded.dispose()
    this.imageTargets = {
      width,
      height,
      // Linear light, so half floats: eight bits would band in the shadows.
      drawn: new THREE.WebGLRenderTarget(width, height, { samples: 4, type: THREE.HalfFloatType }),
      encoded: new THREE.WebGLRenderTarget(width, height, { depthBuffer: false })
    }
    return this.imageTargets
  }
}

/**
 * Turns a render target's picture into what the screen would show. three.js
 * writes linear light into a render target and applies the output colour space
 * only when drawing to the canvas; read back as it is, the picture comes out
 * dark. This pass applies the sRGB curve (the renderer uses sRGB output and no
 * tone mapping) and flips the rows, since a read-back starts at the bottom row.
 */
class Encoder {
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { map: { value: null as THREE.Texture | null } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = vec2(uv.x, 1.0 - uv.y);
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(sRGBTransferOETF(texture2D(map, vUv)).rgb, 1.0);
      }`,
    depthTest: false,
    depthWrite: false
  })
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
  private readonly camera = new THREE.Camera()

  constructor() {
    this.quad.frustumCulled = false
  }

  /** Leaves `to` as the renderer's current target. */
  render(renderer: THREE.WebGLRenderer, from: THREE.Texture, to: THREE.WebGLRenderTarget): void {
    this.material.uniforms.map.value = from
    renderer.setRenderTarget(to)
    renderer.render(this.quad, this.camera)
    this.material.uniforms.map.value = null
  }

  dispose(): void {
    this.quad.geometry.dispose()
    this.material.dispose()
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

let fontsLoaded: Promise<unknown> | undefined

/**
 * The faces the overlay is set in, loaded once. A canvas does not wait for a
 * web font: text drawn before it has arrived comes out in the fallback face.
 */
function overlayFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve()
  fontsLoaded ??= Promise.all(
    ['12px "IBM Plex Mono"', '600 12px "IBM Plex Mono"', '12px "IBM Plex Sans"'].map((font) => document.fonts.load(font))
  ).catch(() => {}) // a face that cannot be loaded leaves the fallback, as before
  return fontsLoaded
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

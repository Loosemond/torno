import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, LookResult, ViewName } from '../../shared/view'
import { PERSPECTIVE_NOTE, drawOverlay } from './overlay'
import { colorFor, colorsByName, edgeTint, mix } from './palette'
import { buildPart, type BuiltPart } from './partMesh'
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
}

type AnyCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera
type Vec3 = [number, number, number]

/** The light values of styles/tokens.css, used where no stylesheet is loaded. */
const LIGHT_THEME: Theme = { surface: '#F1EFEA', hairline: '#DAD6CE', ink: '#22252A', muted: '#6C7178' }

const SETTLE_MS = 150
const MOVE_MS = 240
/** How far a stale part's colour is taken towards the background. */
const STALE_FADE = 0.6
/** Long edge of a picture for the agent, in pixels. */
const MAX_IMAGE = 2000
const MIN_IMAGE = 64
const NAMED_ASPECT = 4 / 3
/** What `fit` and the named views frame when no part is shown. */
const EMPTY_BOX = { min: [-50, -50, 0], max: [50, 50, 50] }

/**
 * The three.js viewport: parts, ground, camera and pictures for the agent.
 * Imperative on purpose, so no per-frame state passes through React. Z is up,
 * units are millimetres. It draws only when something changed.
 */
export class Viewport {
  private readonly canvas: HTMLCanvasElement
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
  /** Everything drawn in the current layout, for the clip planes. */
  private extent = new THREE.Sphere(new THREE.Vector3(), 100)

  private theme: Theme = LIGHT_THEME
  private readonly scheme: MediaQueryList | null
  private aspect = NAMED_ASPECT
  private fov = DEFAULT_FOV
  private frame = 0
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly settledListeners: ((c: Camera) => void)[] = []
  private move: { from: Camera; to: Camera; start: number } | null = null
  private disposed = false

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
    const sky = new THREE.HemisphereLight(0xffffff, 0x8c8880, 1.5)
    sky.position.set(0, 0, 1)
    this.scene.add(sky, this.keyLight, this.keyLight.target)

    // Drawn first and kept out of the depth buffer, so parts resting on the
    // ground cover it without flicker.
    this.ground.material.depthWrite = false
    this.ground.renderOrder = -1
    this.ground.frustumCulled = false
    this.scene.add(this.ground)

    this.controls = new OrbitControls(this.perspective, canvas)
    this.controls.enableDamping = false
    this.controls.screenSpacePanning = true
    this.controls.zoomToCursor = true
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    this.controls.addEventListener('start', this.onControlStart)
    this.controls.addEventListener('change', this.onCameraChange)

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
   */
  async renderImage(req: { view: 'current' | ViewName | Camera; layout: string; visibleKeys: string[]; size: number }): Promise<LookResult> {
    if (!this.layouts.includes(req.layout)) {
      const known = this.layouts.length > 0 ? `the layouts are ${this.layouts.join(', ')}` : 'nothing has been built yet'
      throw new Error(`No layout "${req.layout}": ${known}`)
    }
    const aspect = req.view === 'current' ? this.aspect : NAMED_ASPECT
    const long = Math.round(Math.min(Math.max(req.size, MIN_IMAGE), MAX_IMAGE))
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

    // Everything from here to `restore` is synchronous, so no frame on screen sees it.
    const before = new Map([...this.entries.values()].map((e) => [e, e.built.group.visible]))
    for (const entry of this.entries.values()) entry.built.group.visible = false
    for (const entry of shown) entry.built.group.visible = true
    const extent = req.layout === this.layout ? this.extent : this.rebuildGround(req.layout)

    const camera: AnyCamera = view.ortho ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera()
    camera.up.fromArray(view.up)
    camera.position.fromArray(view.position)
    camera.zoom = view.zoom
    const target = new THREE.Vector3().fromArray(view.target)
    camera.lookAt(target)
    setProjection(camera, target, view.fov, aspect, extent)
    this.aimKeyLight(camera, target)

    let pixels: Uint8ClampedArray<ArrayBuffer>
    try {
      const targets = this.targetsFor(width, height)
      this.renderer.setRenderTarget(targets.drawn)
      this.renderer.render(this.scene, camera)
      this.encoder.render(this.renderer, targets.drawn.texture, targets.encoded)
      pixels = new Uint8ClampedArray(width * height * 4)
      this.renderer.readRenderTargetPixels(targets.encoded, 0, 0, width, height, pixels)
    } finally {
      this.renderer.setRenderTarget(null)
      for (const [entry, visible] of before) entry.built.group.visible = visible
      if (req.layout !== this.layout) this.rebuildGround(this.layout)
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
    this.aspect = width / height
    // Resizing clears the canvas: draw now rather than show a blank frame.
    this.draw()
  }

  dispose(): void {
    this.disposed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    clearTimeout(this.settleTimer)
    this.settledListeners.length = 0
    this.scheme?.removeEventListener('change', this.onSchemeChange)
    this.controls.dispose()
    for (const entry of this.entries.values()) this.discard(entry)
    this.entries.clear()
    this.ground.geometry.dispose()
    this.ground.material.dispose()
    this.imageTargets?.drawn.dispose()
    this.imageTargets?.encoded.dispose()
    this.encoder.dispose()
    this.renderer.dispose()
  }

  // ---- parts ----

  private discard(entry: Entry): void {
    const { group, mesh, edges } = entry.built
    this.scene.remove(group)
    mesh.geometry.dispose()
    mesh.material.dispose()
    edges.geometry.dispose()
    edges.material.dispose()
  }

  /** Brings every part's look and the ground in line with the current layout, layers and theme. */
  private refresh(): void {
    for (const entry of this.entries.values()) this.applyLook(entry)
    this.extent = this.rebuildGround(this.layout)
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
      muted: read('--muted', LIGHT_THEME.muted)
    }
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

  private draw(): void {
    if (this.disposed) return
    setProjection(this.camera, this.controls.target, this.fov, this.aspect, this.extent)
    this.aimKeyLight(this.camera, this.controls.target)
    this.renderer.render(this.scene, this.camera)
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

/** Any CSS colour as #RRGGBB. */
function toHex(color: string): string {
  return `#${new THREE.Color(color).getHexString()}`
}

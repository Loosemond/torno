import { Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, EdgesGeometry, FrontSide, BackSide, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, Plane, SRGBColorSpace, Scene, Sphere, Vector3, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { groundOf } from '../../renderer/viewport/ground'
import { aimKeyLight, makeLights } from '../../renderer/viewport/lights'
import type { Theme } from '../../renderer/viewport/theme'
import { DEFAULT_FOV, fitCamera, viewDirection } from '../../renderer/viewport/views'
import { keepsNothing } from '../../shared/cut'
import { type ExportPart, type ExportScan, type MeshArrays, own } from '../../shared/exportdata'
import { CREASE_ANGLE } from '../../shared/faceted'
import type { Vec3 } from '../../shared/marks'
import { edgeTint, mix } from '../../shared/palette'
import type { Camera, SectionPlane, ViewName } from '../../shared/view'

// What the page draws: the parts of one layout of one object, with three.js. It is the app's viewport reduced
// (the plan's D10): the same lights, the same ground, the same standard views and the same colours, by the same
// modules; a cut is made by clipping alone, with the inside of a part in a darker tone of its colour; a mark is
// a line and a label. Nothing is picked and nothing is measured here. A frame is drawn when asked, never in a loop.

/** How far the inside of a cut part is taken towards the ink. */
const INSIDE = 0.24

export interface ScanArraysOf { positions: Float32Array; colours: Uint8Array | null; triangles: Uint32Array }

interface DrawnPart {
  part: ExportPart
  group: Group
  front: MeshStandardMaterial
  back: MeshStandardMaterial
  inside: Mesh
  lines: LineBasicMaterial
}

interface DrawnScan { scan: ExportScan; group: Group; material: MeshStandardMaterial }

/** What is on show: which parts, how far apart, cut where. */
export interface Shown {
  visible: Record<string, boolean>
  offsets: Record<string, Vec3>
  section: SectionPlane | null
  scans: Record<string, { visible: boolean; opacity: number }>
}

const POINT = new Vector3()

export class Model {
  readonly renderer: WebGLRenderer
  readonly controls: OrbitControls
  private readonly scene = new Scene()
  private readonly lights = makeLights()
  private readonly perspective = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 1000)
  private readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
  private camera: PerspectiveCamera | OrthographicCamera = this.perspective
  private readonly grid = new LineSegments(new BufferGeometry(), new LineBasicMaterial())
  private readonly parts = new Group()
  private readonly scans = new Group()
  private readonly plane = new Plane()
  private drawn: DrawnPart[] = []
  private drawnScans: DrawnScan[] = []
  private theme: Theme
  private shown: Shown = { visible: {}, offsets: {}, section: null, scans: {} }
  /** Round everything that is drawn, where it is drawn: what the camera must keep between its planes. */
  private extent = new Sphere(new Vector3(), 1)
  /** Round the parts of the layout as built: what a standard view is fitted to. */
  private box = { min: [0, 0, 0], max: [1, 1, 1] }
  private waiting = false
  private grounded = ''

  /** Throws when the browser gives no WebGL 2 context. `onDraw` is called after every frame drawn. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    theme: Theme,
    private readonly onDraw: () => void
  ) {
    this.theme = theme
    this.renderer = new WebGLRenderer({ canvas, antialias: true })
    // What three.js would only write to a console nobody reads: the page says it (`undrawn`).
    this.renderer.debug.onShaderError = () => void (this.refused = true)
    canvas.addEventListener('webglcontextlost', () => void (this.lost = true))
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false
      this.request()
    })
    this.renderer.localClippingEnabled = true
    this.perspective.up.set(0, 0, 1)
    this.orthographic.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = false
    this.controls.addEventListener('change', () => this.request())
    this.grid.material.transparent = true
    this.scene.add(this.lights.sky, this.lights.key, this.lights.key.target, this.grid, this.parts, this.scans)
    this.setTheme(theme)
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    this.renderer.setClearColor(new Color(theme.surface))
    this.grid.material.color.set(theme.hairline)
    for (const one of this.drawn) one.back.color.set(mix(one.part.color, hex(theme.ink), INSIDE))
    for (const one of this.drawnScans) if (!one.scan.colours) one.material.color.set(theme.scan)
    this.request()
  }

  /** The canvas takes the size its element has. */
  resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1)
    const height = Math.max(this.canvas.clientHeight, 1)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height, false)
    this.request()
  }

  private aspect(): number {
    return Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1)
  }

  /** The parts of one layout, from their meshes; what was drawn before is let go. */
  setParts(parts: readonly ExportPart[], meshes: ReadonlyMap<string, MeshArrays>): void {
    for (const one of this.drawn) {
      one.group.traverse((child) => {
        if (child instanceof Mesh || child instanceof LineSegments) child.geometry.dispose()
      })
      one.front.dispose()
      one.back.dispose()
      one.lines.dispose()
    }
    this.parts.clear()
    this.drawn = parts.map((part) => {
      const arrays = meshes.get(part.mesh)!
      const surface = new BufferGeometry()
      surface.setAttribute('position', new BufferAttribute(arrays.positions, 3))
      surface.setAttribute('normal', new BufferAttribute(arrays.normals, 3))
      surface.setIndex(new BufferAttribute(arrays.triangles, 1))
      const seeThrough = part.opacity < 1
      // As the app draws a part (`partMesh.ts`): pushed back a little, so the edges drawn on it win the depth test.
      const look = { roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: seeThrough, opacity: part.opacity, depthWrite: !seeThrough, clippingPlanes: [] as Plane[] }
      const front = new MeshStandardMaterial({ ...look, color: part.color, side: FrontSide })
      // What a cut lays open: the inside of the part, in a darker tone of its colour. Drawn only while it is cut.
      const back = new MeshStandardMaterial({ ...look, color: mix(part.color, hex(this.theme.ink), INSIDE), side: BackSide })
      const inside = new Mesh(surface, back)
      inside.visible = false
      let edges: BufferGeometry
      if (part.creased) edges = new EdgesGeometry(surface, CREASE_ANGLE)
      else {
        edges = new BufferGeometry()
        edges.setAttribute('position', new BufferAttribute(arrays.edges, 3))
      }
      const lines = new LineBasicMaterial({ color: edgeTint(part.color), transparent: seeThrough, opacity: part.opacity, clippingPlanes: [] })
      const group = new Group()
      group.add(new Mesh(surface, front), inside, new LineSegments(edges, lines))
      this.parts.add(group)
      return { part, group, front, back, inside, lines }
    })
    const all = new Box3()
    for (const { part } of this.drawn) all.union(new Box3(new Vector3(...part.bbox.min), new Vector3(...part.bbox.max)))
    this.box = all.isEmpty() ? { min: [0, 0, 0], max: [1, 1, 1] } : { min: all.min.toArray(), max: all.max.toArray() }
  }

  /** The grid, under what is drawn where it is drawn: parts drawn apart downwards do not sink through it. */
  private layGround(box: { min: number[]; max: number[] }): void {
    const key = JSON.stringify(box)
    if (key === this.grounded) return
    this.grounded = key
    this.grid.geometry.dispose()
    this.grid.geometry = new BufferGeometry()
    this.grid.geometry.setAttribute('position', new BufferAttribute(new Float32Array(groundOf(box).points), 3))
  }

  /** The box round the parts of the layout as built. */
  bounds(): { min: number[]; max: number[] } {
    return this.box
  }

  /** The scans that stand in this layout, from their meshes. */
  setScans(scans: ReadonlyArray<{ scan: ExportScan; arrays: ScanArraysOf }>, layout: string): void {
    for (const one of this.drawnScans) {
      one.group.traverse((child) => child instanceof Mesh && child.geometry.dispose())
      one.material.dispose()
    }
    this.scans.clear()
    this.drawnScans = []
    const colour = new Color()
    for (const { scan, arrays } of scans) {
      const placed = own(scan.placed, layout)
      if (!placed) continue
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3))
      geometry.setIndex(new BufferAttribute(arrays.triangles, 1))
      if (arrays.colours) {
        // The file's colours are as they are shown; the renderer works in linear light.
        const linear = new Float32Array(arrays.colours.length)
        for (let i = 0; i < linear.length; i += 3) colour.setRGB(arrays.colours[i] / 255, arrays.colours[i + 1] / 255, arrays.colours[i + 2] / 255, SRGBColorSpace).toArray(linear, i)
        geometry.setAttribute('color', new BufferAttribute(linear, 3))
      }
      geometry.computeVertexNormals()
      const material = new MeshStandardMaterial({ color: arrays.colours ? '#ffffff' : this.theme.scan, vertexColors: arrays.colours !== null, roughness: 1, metalness: 0, side: DoubleSide, transparent: true, clippingPlanes: [] })
      const group = new Group()
      group.position.fromArray(placed.t)
      group.quaternion.fromArray(placed.q)
      group.scale.setScalar(placed.s)
      group.add(new Mesh(geometry, material))
      this.scans.add(group)
      this.drawnScans.push({ scan, group, material })
    }
  }

  /** Which parts are drawn, how far from where they are, and cut by what. */
  apply(shown: Shown): void {
    this.shown = shown
    const planes: Plane[] = []
    if (shown.section) {
      // torno's plane takes away the side its normal points to; three.js keeps the side its plane's normal points to.
      const [nx, ny, nz] = shown.section.normal
      this.plane.normal.set(-nx, -ny, -nz)
      this.plane.constant = nx * shown.section.origin[0] + ny * shown.section.origin[1] + nz * shown.section.origin[2]
      planes.push(this.plane)
    }
    const all = new Box3()
    for (const one of this.drawn) {
      const by = shown.offsets[one.part.name] ?? [0, 0, 0]
      one.group.position.set(one.part.loc.t[0] + by[0], one.part.loc.t[1] + by[1], one.part.loc.t[2] + by[2])
      one.group.quaternion.fromArray(one.part.loc.q)
      // A part the plane leaves nothing of is not drawn, as in torno (`keepsNothing`), nor one thinned to nothing.
      one.group.visible = shown.visible[one.part.name] !== false && one.part.opacity > 0 && !(shown.section && keepsNothing(one.part.bbox, shown.section))
      one.inside.visible = shown.section !== null
      for (const material of [one.front, one.back, one.lines]) material.clippingPlanes = planes
      if (one.group.visible) all.union(new Box3(new Vector3(...one.part.bbox.min), new Vector3(...one.part.bbox.max)).translate(new Vector3(...by)))
    }
    for (const one of this.drawnScans) {
      const view = shown.scans[one.scan.id]
      one.group.visible = view?.visible !== false
      one.material.opacity = view?.opacity ?? 1
      one.material.depthWrite = one.material.opacity >= 1
      one.material.clippingPlanes = planes
      if (one.group.visible) {
        const box = new Box3(new Vector3(...one.scan.lo), new Vector3(...one.scan.lo).add(new Vector3(...one.scan.span)))
        one.group.updateMatrixWorld(true)
        all.union(box.applyMatrix4(one.group.matrixWorld))
      }
    }
    all.union(new Box3(new Vector3(...(this.box.min as Vec3)), new Vector3(...(this.box.max as Vec3))))
    this.layGround(this.drawnBox())
    this.grid.geometry.computeBoundingBox()
    if (this.grid.geometry.boundingBox && !this.grid.geometry.boundingBox.isEmpty()) all.union(this.grid.geometry.boundingBox)
    all.getBoundingSphere(this.extent)
    this.request()
  }

  /** The box round what is drawn of the parts, where it is drawn: what "Fit" frames. */
  private drawnBox(): { min: number[]; max: number[] } {
    const all = new Box3()
    for (const one of this.drawn) {
      if (!one.group.visible) continue
      const by = this.shown.offsets[one.part.name] ?? [0, 0, 0]
      all.union(new Box3(new Vector3(...one.part.bbox.min), new Vector3(...one.part.bbox.max)).translate(new Vector3(...by)))
    }
    return all.isEmpty() ? this.box : { min: all.min.toArray(), max: all.max.toArray() }
  }

  getCamera(): Camera {
    const ortho = this.camera === this.orthographic
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: [0, 0, 1], ortho, fov: this.perspective.fov, zoom: this.camera.zoom }
  }

  /** Looks as `camera` does. The page's camera always stands with Z up: a view from straight above or below keeps the way up it was saved with, any other roll is not kept. */
  setCamera(camera: Camera): void {
    const next = camera.ortho ? this.orthographic : this.perspective
    const target = new Vector3(...camera.target)
    const position = new Vector3(...camera.position)
    const looks = target.clone().sub(position)
    const reach = looks.length()
    if (!(reach > 0)) return
    looks.divideScalar(reach)
    // Straight down or up, "up" on screen is whatever the camera was a hair off towards: the way the view says.
    if (Math.abs(looks.z) > 0.999999) position.addScaledVector(new Vector3(...camera.up).setZ(0).normalize(), 1e-4 * reach * Math.sign(looks.z))
    this.perspective.fov = camera.fov > 0 && camera.fov < 180 ? camera.fov : DEFAULT_FOV
    next.zoom = camera.zoom > 0 ? camera.zoom : 1
    next.position.copy(position)
    this.camera = next
    this.controls.object = next
    this.controls.target.copy(target)
    this.controls.update()
    this.request()
  }

  /** A standard view, or the view there is, fitted to what is drawn. */
  fit(view?: ViewName): void {
    const now = this.getCamera()
    const dir = [now.target[0] - now.position[0], now.target[1] - now.position[1], now.target[2] - now.position[2]]
    // Looking straight down or up, the way up on screen is kept as it is.
    const vertical = Math.abs(dir[2]) > 0.999999 * Math.hypot(dir[0], dir[1], dir[2])
    const looks = view ? viewDirection(view) : { dir, up: vertical ? this.screenUp() : [0, 0, 1] }
    this.setCamera(fitCamera(this.drawnBox(), looks.dir, looks.up, this.aspect(), this.perspective.fov, now.ortho))
  }

  /** What points up on screen now, in the object frame. */
  private screenUp(): number[] {
    this.camera.updateMatrixWorld()
    const m = this.camera.matrixWorld.elements
    return [m[4], m[5], m[6]]
  }

  /** The same view, in perspective or without: what is at the target stays the size it is. */
  setOrtho(ortho: boolean): void {
    const now = this.getCamera()
    if (now.ortho === ortho) return
    const offset = new Vector3(...now.position).sub(new Vector3(...now.target))
    // An orthographic view shows what a perspective one at its place would show at the target, magnified by its zoom.
    const position = ortho ? now.position : (new Vector3(...now.target).add(offset.divideScalar(now.zoom)).toArray() as Vec3)
    this.setCamera({ ...now, position, ortho, zoom: 1 })
  }

  /** Turns the camera to a point: it becomes what the view turns about. */
  lookAt(point: Vec3): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    this.controls.target.fromArray(point)
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
    this.request()
  }

  /** By the keys: about the target, in radians, and nearer by a factor. */
  orbit(around: number, over: number, nearer = 1): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    const reach = offset.length()
    const azimuth = Math.atan2(offset.y, offset.x) + around
    const polar = Math.min(Math.max(Math.acos(Math.min(Math.max(offset.z / reach, -1), 1)) + over, 0.001), Math.PI - 0.001)
    if (this.camera === this.orthographic) this.camera.zoom *= nearer
    const far = this.camera === this.orthographic ? reach : reach / nearer
    this.camera.position.set(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar)).multiplyScalar(far).add(this.controls.target)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.request()
  }

  /** A frame, once, when the browser next draws. */
  request(): void {
    if (this.waiting) return
    this.waiting = true
    requestAnimationFrame(() => {
      this.waiting = false
      this.draw()
    })
  }

  private frame(): void {
    const aspect = this.aspect()
    const camera = this.camera
    const far = camera.position.distanceTo(this.extent.center)
    const reach = camera.position.distanceTo(this.controls.target)
    if (camera instanceof PerspectiveCamera) {
      camera.aspect = aspect
      camera.near = Math.max(far - this.extent.radius, (far + this.extent.radius) / 5000, 0.01)
      camera.far = far + this.extent.radius + 1
    } else {
      const half = reach * Math.tan((this.perspective.fov * Math.PI) / 360)
      camera.top = half
      camera.bottom = -half
      camera.left = -half * aspect
      camera.right = half * aspect
      camera.near = far - this.extent.radius - 1
      camera.far = far + this.extent.radius + 1
    }
    camera.updateProjectionMatrix()
    aimKeyLight(this.lights.key, camera, this.controls.target)
  }

  /** Draws a frame now. */
  draw(): void {
    this.frame()
    this.renderer.render(this.scene, this.camera)
    this.onDraw()
  }

  /** The browser took the context away, and has not given it back. */
  private lost = false
  /** A program of the parts' materials did not compile or link. */
  private refused = false

  /**
   * Why nothing of the parts or the scans is on the canvas, in words for the person; null when something is.
   * It draws a frame for the asking, without the grid, and looks at it: whatever the browser's own timing, and
   * whatever it did with the frames before. Asked only while something is switched on and nothing cuts it away.
   */
  undrawn(): string | null {
    const gl = this.renderer.getContext()
    if (this.lost || gl.isContextLost()) return 'the browser took its 3D drawing away from this page'
    this.renderer.clear()
    const [r, g, b] = this.read(0.5, 0.5)
    this.grid.visible = false
    this.frame()
    this.renderer.render(this.scene, this.camera)
    const [w, h] = [gl.drawingBufferWidth, gl.drawingBufferHeight]
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    this.grid.visible = true
    this.draw()
    if (w === 0 || h === 0) return 'the page gave the 3D view no room'
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b) > 6) return null
    }
    return this.refused ? 'its graphics driver would not take what draws them' : 'a frame was drawn, and nothing of the parts is in it'
  }

  /** Where a point of the object frame is drawn, in CSS pixels from the canvas's top left, and whether it is in front of the camera. */
  project(point: Vec3, by: Vec3 = [0, 0, 0]): { x: number; y: number; visible: boolean } {
    const v = POINT.set(point[0] + by[0], point[1] + by[1], point[2] + by[2]).project(this.camera)
    return { x: ((v.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - v.y) / 2) * this.canvas.clientHeight, visible: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2 }
  }

  /** Whether a point is in the half a section takes away. */
  cutAway(point: Vec3): boolean {
    const plane = this.shown.section
    return plane !== null && (point[0] - plane.origin[0]) * plane.normal[0] + (point[1] - plane.origin[1]) * plane.normal[1] + (point[2] - plane.origin[2]) * plane.normal[2] > 0
  }

  /** The colour of the parts and the scans drawn at a point of the canvas, in fractions of it, on a frame drawn for the asking without the grid and the marks; and the colour of the ground alone. */
  pixel(fx: number, fy: number): [number, number, number, number] {
    this.grid.visible = false
    this.frame()
    this.renderer.render(this.scene, this.camera)
    const read = this.read(fx, fy)
    this.grid.visible = true
    this.draw()
    return read
  }

  ground(): [number, number, number] {
    this.renderer.clear()
    const [r, g, b] = this.read(0.5, 0.5)
    this.draw()
    return [r, g, b]
  }

  private read(fx: number, fy: number): [number, number, number, number] {
    const gl = this.renderer.getContext()
    const out = new Uint8Array(4)
    const x = Math.min(Math.max(Math.floor(fx * gl.drawingBufferWidth), 0), gl.drawingBufferWidth - 1)
    const y = Math.min(Math.max(Math.floor((1 - fy) * gl.drawingBufferHeight), 0), gl.drawingBufferHeight - 1)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return [out[0], out[1], out[2], out[3]]
  }
}

/** Any CSS colour of a token as #RRGGBB. */
function hex(colour: string): string {
  return `#${new Color(colour).getHexString()}`
}

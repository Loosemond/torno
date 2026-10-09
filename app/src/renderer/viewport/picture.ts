import * as THREE from 'three'
import type { Part } from '../../shared/scene'
import type { Camera, SectionPlane, ViewName } from '../../shared/view'
import { MARK_LAYERS, type Highlights } from './highlight'
import type { MarkLayer } from './marks/MarkLayer'
import { PERSPECTIVE_NOTE, chipSize, drawLabels, drawOverlay, overlayFonts, overlayUnit, type LabelStyle } from './overlay'
import { reaching, type ScanLayer, type ShownScan } from './scans'
import { describeSection } from './section'
import { visibleHeight } from './views'

/** What to draw for a picture: a view, a layout and the keys of the parts to show. `size` is the long edge in pixels. */
export interface ImageRequest {
  view: 'current' | ViewName | Camera
  layout: string
  visibleKeys: string[]
  size?: number
  /** Whether the marks of the layout are drawn, with their numbers. True when left out. */
  marks?: boolean
  /** What the parts are cut by: `'current'`, and when left out, the section on screen; null for none; or a plane of the picture's own. */
  section?: SectionPlane | 'current' | null
  /** The scans drawn with the parts: `'current'`, and when left out, those switched on on screen; false for none; or those of these ids. */
  scans?: 'current' | false | string[]
}

export interface Picture {
  png: Uint8Array
  width: number
  height: number
  caption: string
}

/** Long edge of a picture for the agent, in pixels. */
const MAX_IMAGE = 2000
const DEFAULT_IMAGE = 1280
const MIN_IMAGE = 64
/** Width to height of a picture of a named view, and of the viewport until its canvas has a size. */
export const NAMED_ASPECT = 4 / 3
/** How much larger the number of a mark is in a picture than on screen: a picture is read at a glance, and often scaled down first. */
const PICTURE_CHIP = 1.3

/** A part as a picture needs it: what it is, and whether it is drawn. */
export interface PicturePart {
  readonly part: Part
  readonly built: { readonly group: { visible: boolean } }
}

/** What a picture needs of the viewport it is of. */
export interface PictureHost {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly marks: Pick<MarkLayer, 'activeId' | 'setActive' | 'show' | 'showDraft' | 'extend' | 'update' | 'labels'>
  readonly highlights: Pick<Highlights, 'setVisible'>
  readonly scans: Pick<ScanLayer, 'showOnly' | 'shown' | 'box'>
  /** The viewport has been disposed of. */
  closed(): boolean
  /** The layouts of the scene on show, and the one on screen. */
  layouts(): readonly string[]
  layout(): string
  /** Width to height of the canvas. */
  aspect(): number
  /** Every part built, of every layout. */
  parts(): Iterable<PicturePart>
  /** The camera as the person has it. */
  currentView(): Camera
  /** A standard view, orthographic, fitted to some parts (to a stand-in box for none). */
  namedView(name: ViewName, parts: Part[], aspect: number): Camera
  /** A camera of its own for a picture, with its frustum around `extent` and the key light aimed along it. */
  cameraFor(view: Camera, aspect: number, extent: THREE.Sphere): THREE.Camera
  /** The names of the parts of a layout that are not among those drawn. */
  hiddenParts(layout: string, drawn: ReadonlySet<string>): Set<string>
  /** Takes the gizmo out of what is drawn; returns what puts it back. */
  hideGizmo(): () => void
  /** The section on screen, or null. */
  section(): SectionPlane | null
  /** Cuts the parts by a plane laid across a layout's parts, or by none; `decor` says whether the plane itself is drawn. */
  cutBy(plane: SectionPlane | null, layout: string, decor: boolean): void
  /** Lays the grid under a layout's parts and returns a sphere around the parts and the grid. */
  layGround(layout: string): THREE.Sphere
  /** That sphere for the layout on screen, as last laid. */
  groundExtent(): THREE.Sphere
  /** Tints what a layout's pick marks are on. */
  tintPicks(layout: string): void
  /** Shows the marks as the screen has them. */
  showMarks(): void
  /** The colours of the labels, and a quieter ink for notes. */
  colours(): LabelStyle & { muted: string }
}

/** The pixels of a picture whose long edge was asked to be `size`: within 64 and 2000, 1280 when not said. */
export function pictureSize(size: number | undefined, aspect: number): { width: number; height: number } {
  const asked = typeof size === 'number' && Number.isFinite(size) ? size : DEFAULT_IMAGE
  const long = Math.round(Math.min(Math.max(asked, MIN_IMAGE), MAX_IMAGE))
  const width = aspect >= 1 ? long : Math.max(1, Math.round(long * aspect))
  const height = aspect >= 1 ? Math.max(1, Math.round(long / aspect)) : long
  return { width, height }
}

/** What a picture draws: a layout, those of its parts to show, and whether its marks are in it. */
export interface PictureState {
  layout: string
  shown: readonly PicturePart[]
  withMarks: boolean
  /** The ids of the scans drawn with the parts, each where this layout puts it; null for none. */
  scans: string[] | null
  /** What the parts and the scans are cut by, or null. The plane itself is not drawn. */
  section: SectionPlane | null
  /** The names of the layout's parts the picture leaves out: a mark on one is left out with it. */
  notDrawn: ReadonlySet<string>
  width: number
  height: number
}

/**
 * Has the scene be what a picture is of while `draw` runs, and what the screen
 * shows again after it, whether or not `draw` throws. `draw` is given a sphere
 * around all that is drawn, and leaves the renderer on any target it likes.
 * Nothing in here waits: no frame on screen sees the scene in between.
 *
 * A picture is of the parts, the scans and the marks: not of what the person points at,
 * of what they hold a shape by, of which mark they are working on, of what
 * is not a mark yet, or of the plane they cut by (the cut itself is in it).
 */
export function asPictured<T>(host: PictureHost, state: PictureState, draw: (extent: THREE.Sphere) => T): T {
  const otherLayout = state.layout !== host.layout()
  const parts = [...host.parts()]
  const before = new Map(parts.map((p) => [p, p.built.group.visible]))
  host.highlights.setVisible(false)
  const showGizmo = host.hideGizmo()
  const active = host.marks.activeId
  const cut = host.section()
  // Fat lines take their width in pixels from the renderer's viewport, which is the
  // canvas's whatever is being drawn to: for the picture it is the picture's size.
  const onScreen = host.renderer.getViewport(new THREE.Vector4())
  let scansBack = (): void => {}
  try {
    host.renderer.setViewport(0, 0, state.width, state.height)
    for (const p of parts) p.built.group.visible = false
    for (const p of state.shown) p.built.group.visible = true
    scansBack = host.scans.showOnly(state.scans, state.layout)
    host.cutBy(state.section, state.layout, false)
    let extent = otherLayout ? host.layGround(state.layout) : host.groundExtent()
    // A scan may stand far from the parts: the camera reaches what is drawn of it.
    const around = host.scans.box()
    if (around) extent = reaching(extent.clone(), around, extent)
    host.marks.setActive(null)
    host.marks.show(state.withMarks ? state.layout : null, state.notDrawn)
    host.marks.showDraft(false)
    if (state.withMarks) {
      extent = host.marks.extend(extent.clone(), state.layout)
      host.highlights.setVisible(true, MARK_LAYERS)
      // Of the marks the picture draws: other parts may be switched on in it than on screen.
      host.tintPicks(state.layout)
    }
    return draw(extent)
  } finally {
    host.renderer.setViewport(onScreen)
    host.renderer.setRenderTarget(null)
    for (const [p, visible] of before) p.built.group.visible = visible
    scansBack()
    host.cutBy(cut, host.layout(), true)
    showGizmo()
    host.highlights.setVisible(true)
    host.marks.setActive(active)
    host.showMarks() // sized for the screen again by the next frame drawn
    host.marks.showDraft(true)
    if (otherLayout) host.layGround(host.layout())
    if (state.withMarks) host.tintPicks(host.layout())
  }
}

/**
 * The scans a picture has, as its caption says them: ` · scans S1 at 60 %, S2`, how thin only of one that is; nothing
 * for none. A scan that is not aligned in the picture's layout is not where the model is, and one whose alignment the
 * last build put in doubt may not be, nor one that is only rough: whoever reads the picture is told, with the scan's name.
 */
export function scansNote(drawn: ReadonlyArray<Pick<ShownScan, 'id' | 'opacity' | 'aligned' | 'stale'> & Partial<Pick<ShownScan, 'rough'>>>, layout: string): string {
  if (drawn.length === 0) return ''
  const said = drawn.map((scan) => {
    const thin = scan.opacity < 1 ? ` at ${Math.round(scan.opacity * 100)} %` : ''
    const where = !scan.aligned
      ? ` (not aligned in ${layout}: drawn where it was imported)`
      : scan.stale
        ? ` (its alignment in ${layout} may no longer hold: ${scan.stale}${scan.rough ? `; it is rough: ${scan.rough}` : ''})`
        : scan.rough
          ? ` (aligned roughly in ${layout}: ${scan.rough})`
          : ''
    return `${scan.id}${thin}${where}`
  })
  return ` · scans ${said.join(', ')}`
}

/**
 * Still pictures of a viewport for the agent, each with an axis triad and a
 * scale bar. One is drawn off screen in one go: the person's camera, the layout
 * and the frame on screen are left alone, and it works while the window is hidden.
 */
export class PictureMaker {
  private targets: { width: number; height: number; drawn: THREE.WebGLRenderTarget; encoded: THREE.WebGLRenderTarget } | null = null
  private readonly encoder = new Encoder()

  constructor(private readonly host: PictureHost) {}

  /** See `Viewport.renderImage`. */
  async render(request: ImageRequest | (() => ImageRequest)): Promise<Picture> {
    const host = this.host
    // Before anything is drawn: nothing below may wait between hiding parts and restoring them.
    await overlayFonts()
    if (host.closed()) throw new Error('The viewport is closed')
    if (host.renderer.getContext().isContextLost()) throw new Error('The 3D view has lost its graphics context; try again in a moment')
    const req = typeof request === 'function' ? request() : request
    const layouts = host.layouts()
    if (!layouts.includes(req.layout)) {
      const known = layouts.length > 0 ? `the layouts are ${layouts.join(', ')}` : 'nothing has been built yet'
      throw new Error(`No layout "${req.layout}": ${known}`)
    }
    const aspect = req.view === 'current' ? host.aspect() : NAMED_ASPECT
    const { width, height } = pictureSize(req.size, aspect)

    const wanted = new Set(req.visibleKeys)
    const shown = [...host.parts()].filter((p) => p.part.layout === req.layout && wanted.has(p.part.key))

    let view: Camera
    let viewName: string
    if (req.view === 'current') {
      view = host.currentView()
      viewName = 'current'
    } else if (typeof req.view === 'string') {
      view = host.namedView(req.view, shown.map((p) => p.part), aspect)
      viewName = req.view
    } else {
      view = req.view
      viewName = 'custom'
    }

    const withMarks = req.marks !== false
    // Those switched on on screen, unless the picture names its own or wants none.
    const scans = req.scans === false ? null : Array.isArray(req.scans) ? req.scans : host.scans.shown().filter((scan) => scan.visible).map((scan) => scan.id)
    const section = req.section === undefined || req.section === 'current' ? host.section() : req.section
    // A mark on a part the picture leaves out is left out with it.
    const notDrawn = host.hiddenParts(req.layout, wanted)
    const unit = overlayUnit(width, height)

    // Everything from here to the end of `asPictured` is synchronous, so no frame on screen sees it.
    const { camera, pixels, drawn } = asPictured(host, { layout: req.layout, shown, withMarks, scans, section, notDrawn, width, height }, (extent) => {
      const camera = host.cameraFor(view, aspect, extent)
      // In the picture's own pixels: a dot is as large a share of a big picture as of a small one.
      host.marks.update(camera, { width, height }, unit)

      const targets = this.targetsFor(width, height)
      host.renderer.setRenderTarget(targets.drawn)
      host.renderer.render(host.scene, camera)
      this.encoder.render(host.renderer, targets.drawn.texture, targets.encoded)
      const pixels = new Uint8ClampedArray(width * height * 4)
      host.renderer.readRenderTargetPixels(targets.encoded, 0, 0, width, height, pixels)
      // What was drawn of the scans: one whose mesh has not come is not in the picture, and is not said to be.
      return { camera, pixels, drawn: host.scans.shown().filter((scan) => scan.visible) }
    })

    const picture = new OffscreenCanvas(width, height)
    const ctx = picture.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas to compose the picture')
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    const colours = host.colours()
    drawOverlay(ctx, {
      width,
      height,
      right: [m[0], m[1], m[2]],
      up: [m[4], m[5], m[6]],
      mmPerPx: view.ortho ? visibleHeight(view) / height : null,
      ink: colours.ink,
      muted: colours.muted,
      surface: colours.surface
    })
    if (withMarks) {
      // With the camera of the picture, which for a named view is not the one on screen.
      const labels = host.marks.labels(req.layout, camera, { width, height }, unit, chipSize(ctx, unit * PICTURE_CHIP), notDrawn)
      drawLabels(ctx, labels, colours, unit * PICTURE_CHIP)
    }
    const blob = await picture.convertToBlob({ type: 'image/png' })
    const png = new Uint8Array(await blob.arrayBuffer())

    const names = shown.map((p) => p.part.name).join(', ') || 'none'
    const projection = view.ortho ? 'orthographic' : PERSPECTIVE_NOTE
    const cutNote = section ? ` · ${describeSection(section)}` : ''
    const caption = `view ${viewName} · layout ${req.layout} · parts ${names}${scansNote(drawn, req.layout)}${cutNote} · ${projection} · ${width}×${height}`
    return { png, width, height, caption }
  }

  dispose(): void {
    this.targets?.drawn.dispose()
    this.targets?.encoded.dispose()
    this.encoder.dispose()
  }

  private targetsFor(width: number, height: number): NonNullable<PictureMaker['targets']> {
    const have = this.targets
    if (have && have.width === width && have.height === height) return have
    have?.drawn.dispose()
    have?.encoded.dispose()
    this.targets = {
      width,
      height,
      // Linear light, so half floats: eight bits would band in the shadows.
      // With a stencil: the cut faces of a section are counted in it.
      drawn: new THREE.WebGLRenderTarget(width, height, { samples: 4, type: THREE.HalfFloatType, stencilBuffer: true }),
      encoded: new THREE.WebGLRenderTarget(width, height, { depthBuffer: false })
    }
    return this.targets
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

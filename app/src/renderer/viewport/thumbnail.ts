import * as THREE from 'three'
import { type ExplodeState, explodeOffsets, explodeShown } from '../../shared/explode'
import type { Vec3 } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { SceneFile } from '../../shared/scenefile'
import type { ThumbnailOf } from '../../shared/show'
import { type SectionPlane, sectionOf } from '../../shared/view'
import { drawnAt, drawnBox } from './explode'
import { aimKeyLight, makeLights } from './lights'
import { colorFor, colorsByName, edgeTint } from './palette'
import { type BuiltPart, buildPart, disposePart } from './partMesh'
import { Encoder, pngOf } from './picture'
import { SectionCut, keepsNothing } from './section'
import { toHex } from './theme'
import { DEFAULT_FOV, fitCamera, viewDirection } from './views'

// The picture on an object's card: a small scene of its own, drawn off screen with the viewport's renderer from a
// build main has already broadcast. The object need not be the one on show, and nothing on screen changes for it.
// Only parts are in it: no mark, no scan (a scan may show the real world), no grid, no gizmo, and a clear ground,
// so that one picture sits on the card's own surface in either theme. The parts' colours are the same in both.

export const THUMB_WIDTH = 480
export const THUMB_HEIGHT = 360
/** How much of the picture's half width or height the parts reach, from its middle. */
const FILL = 0.86

/** How an object was last looked at, as far as a thumbnail follows it: what its scene file keeps of the layout, the parts, the section and the explode. */
export type ThumbnailView = Pick<SceneFile, 'layout' | 'layers' | 'section' | 'explode'>

/** The layout a thumbnail is of when the object was never looked at in another: `assembly` when the build has it, else its first. */
export function thumbnailLayout(layouts: readonly string[]): string | null {
  return layouts.includes('assembly') ? 'assembly' : (layouts[0] ?? null)
}

export interface ThumbnailPlan {
  layout: string
  /** The parts drawn. */
  parts: Part[]
  /** How many parts of the layout are left out. */
  hidden: number
  /** By part key: the colour and the opacity each is drawn in. */
  looks: Record<string, { color: string; opacity: number }>
  section: SectionPlane | null
  explode: ExplodeState | null
  /** By part name, how far each is drawn from where it is; `{}` when none is. */
  offsets: Record<string, Vec3>
  /** Round the parts of the layout as built, and round the parts drawn where they are drawn. */
  layoutBox: { min: number[]; max: number[] }
  box: { min: number[]; max: number[] }
}

/**
 * What a thumbnail of a build draws, given how its object was last looked at (its scene file; nothing for an
 * object never looked at): the layout kept, when the build still has it; of its parts those switched on, in the
 * colours they have in the window; cut by the section kept, or drawn apart, as the window would (`explodeShown`:
 * never both). Null for a build with no part in that layout.
 *
 * A picture of nothing says nothing of the object, so what would leave it empty is passed over: with every part
 * switched off all are drawn, and a section that leaves nothing of what is drawn is left out.
 */
export function thumbnailPlan(scene: Scene, view?: ThumbnailView): ThumbnailPlan | null {
  const layout = view?.layout !== undefined && scene.layouts.includes(view.layout) ? view.layout : thumbnailLayout(scene.layouts)
  if (layout === null) return null
  const all = scene.parts.filter((part) => part.layout === layout)
  if (all.length === 0) return null
  const on = all.filter((part) => view?.layers[part.name]?.visible !== false)
  const parts = on.length > 0 ? on : all
  const colours = colorsByName(scene.parts.map((part) => part.name))
  const looks: ThumbnailPlan['looks'] = {}
  for (const part of parts) {
    const layer = view?.layers[part.name]
    looks[part.key] = { color: layer?.color ?? colours.get(part.name) ?? colorFor(part.name, -1), opacity: Math.min(Math.max(layer?.opacity ?? 1, 0), 1) }
  }
  const plane = sectionOf(view?.section)
  const section = plane && !parts.every((part) => keepsNothing(part.bbox, plane)) ? plane : null
  // Of the layout's parts, drawn or not: a part is drawn apart from those it belongs with.
  const explode = explodeShown(view?.explode?.[layout], section, all)
  const offsets = explodeOffsets(all, explode)
  return { layout, parts, hidden: all.length - parts.length, looks, section, explode, offsets, layoutBox: drawnBox(all, {})!, box: drawnBox(parts, offsets)! }
}

export class ThumbnailMaker {
  private readonly stage = new THREE.Scene()
  private readonly lights = makeLights()
  private readonly encoder = new Encoder()
  // As a picture for the agent is drawn: linear light in half floats, with a stencil for the cut faces of a section.
  private readonly drawn = new THREE.WebGLRenderTarget(THUMB_WIDTH, THUMB_HEIGHT, { samples: 4, type: THREE.HalfFloatType, stencilBuffer: true })
  private readonly encoded = new THREE.WebGLRenderTarget(THUMB_WIDTH, THUMB_HEIGHT, { depthBuffer: false })

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.stage.add(this.lights.sky, this.lights.key, this.lights.key.target)
  }

  /**
   * A picture of the parts of one layout of any scene, as `thumbnailPlan` has them, seen from the standard iso
   * view, on a clear ground: parts and their edges, nothing else. Null for a scene with no part to draw.
   * Everything up to the encoding of the PNG happens at once, and the renderer is left as it was found.
   */
  async render(scene: Scene, blob: ArrayBuffer, view?: ThumbnailView): Promise<({ png: Uint8Array } & ThumbnailOf) | null> {
    const plan = thumbnailPlan(scene, view)
    if (!plan) return null
    const renderer = this.renderer
    const was = { target: renderer.getRenderTarget(), colour: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), planes: renderer.clippingPlanes }
    const built: BuiltPart[] = []
    const cut = plan.section ? new SectionCut() : null
    let encoding: Promise<Uint8Array>
    try {
      for (const part of plan.parts) {
        const one = buildPart(part, blob, { tree: false })
        built.push(one)
        const look = plan.looks[part.key]
        const colour = toHex(look.color)
        const see = look.opacity < 1
        one.mesh.material.color.set(colour)
        one.edges.material.color.set(edgeTint(colour))
        for (const material of [one.mesh.material, one.edges.material]) {
          material.transparent = see
          material.opacity = look.opacity
          material.depthWrite = !see
        }
        one.group.position.fromArray(drawnAt(part, plan.offsets))
        one.group.updateMatrix()
        this.stage.add(one.group)
        cut?.add(one)
        cut?.look(one, colour, look.opacity, edgeTint(colour))
      }
      if (cut) {
        // The plane itself is not in a picture: the parts are cut, and their cut faces drawn.
        cut.showDecor(false)
        cut.set(plan.section, plan.layoutBox)
        cut.outline()
      }
      const camera = cameraFor(plan.box)
      aimKeyLight(this.lights.key, camera, new THREE.Vector3(...centreOf(plan.box)))
      renderer.setRenderTarget(this.drawn)
      renderer.setClearColor(0x000000, 0)
      renderer.clippingPlanes = []
      renderer.render(this.stage, camera)
      // The pixels are read before this returns; only the writing of the PNG is waited for.
      encoding = pngOf(renderer, this.encoder, this.drawn, this.encoded, { alpha: true })
    } finally {
      renderer.setRenderTarget(was.target)
      renderer.setClearColor(was.colour, was.alpha)
      renderer.clippingPlanes = was.planes
      cut?.dispose()
      for (const one of built) {
        this.stage.remove(one.group)
        disposePart(one)
      }
    }
    const of: ThumbnailOf = { layout: plan.layout, parts: plan.parts.length }
    if (plan.section) of.cut = true
    if (plan.explode) of.apart = true
    if (plan.hidden > 0) of.hidden = plan.hidden
    return { png: await encoding, ...of }
  }

  dispose(): void {
    this.drawn.dispose()
    this.encoded.dispose()
    this.encoder.dispose()
  }
}

const centreOf = (box: { min: number[]; max: number[] }): Vec3 => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]

/**
 * The standard iso view, in perspective, of what is in a box: fitted to the sphere round it (`fitCamera`), then
 * brought nearer until the box itself reaches `FILL` of the picture, so that a flat or a long part is not a
 * speck in the middle of its card.
 */
function cameraFor(box: { min: number[]; max: number[] }): THREE.PerspectiveCamera {
  const aspect = THUMB_WIDTH / THUMB_HEIGHT
  const { dir, up } = viewDirection('iso')
  const view = fitCamera(box, dir, up, aspect, DEFAULT_FOV, false)
  const camera = new THREE.PerspectiveCamera(view.fov, aspect)
  camera.up.fromArray(view.up)
  const target = new THREE.Vector3().fromArray(view.target)
  const from = new THREE.Vector3().fromArray(view.position).sub(target)
  const radius = Math.max(Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2, 0.5)
  const corner = new THREE.Vector3()
  const place = (): void => {
    camera.position.copy(target).add(from)
    camera.lookAt(target)
    const reach = from.length()
    camera.far = reach + radius * 1.05
    camera.near = Math.max(reach - radius * 1.05, camera.far / 5000)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }
  place()
  for (let pass = 0; pass < 3; pass++) {
    let reached = 0
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]).project(camera)
      reached = Math.max(reached, Math.abs(corner.x), Math.abs(corner.y))
    }
    // Never nearer than the sphere round the box allows, and not at all for a box with no size.
    if (!(reached > 1e-6) || !Number.isFinite(reached)) break
    from.multiplyScalar(Math.max(reached / FILL, (radius * 1.2) / from.length()))
    place()
  }
  return camera
}

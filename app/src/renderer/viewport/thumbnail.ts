import * as THREE from 'three'
import type { Vec3 } from '../../shared/marks'
import { edgeTint } from '../../shared/palette'
import type { Scene } from '../../shared/scene'
import type { ThumbnailOf } from '../../shared/show'
import { THUMB_HEIGHT, THUMB_WIDTH, type ThumbnailView, thumbnailPlan } from '../../shared/thumbnail'
import { drawnAt } from './explode'
import { aimKeyLight, makeLights } from './lights'
import { type BuiltPart, buildPart, disposePart } from './partMesh'
import { Encoder, pngOf } from './picture'
import { SectionCut } from './section'
import { toHex } from './theme'
import { DEFAULT_FOV, fitCamera, viewDirection } from './views'

export { THUMB_HEIGHT, THUMB_WIDTH, thumbnailLayout, thumbnailPlan, type ThumbnailPlan, type ThumbnailView } from '../../shared/thumbnail'

// The picture on an object's card: a small scene of its own, drawn off screen with the viewport's renderer from a
// build main has already broadcast. The object need not be the one on show, and nothing on screen changes for it.
// Only parts are in it: no mark, no scan (a scan may show the real world), no grid, no gizmo, and a clear ground,
// so that one picture sits on the card's own surface in either theme. The parts' colours are the same in both.
// What it draws is `shared/thumbnail.ts` `thumbnailPlan`'s to say.

/** How much of the picture's half width or height the parts reach, from its middle. */
const FILL = 0.86

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

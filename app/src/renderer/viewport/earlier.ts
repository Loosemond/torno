import * as THREE from 'three'
import type { Part } from '../../shared/scene'
import { buildPart, disposePart, type BuiltPart } from './partMesh'

/** How much of an earlier build shows through: the surfaces, and its edges. Enough to see where it stood, little enough to see the current build through it. */
export const EARLIER_SURFACE_OPACITY = 0.28
export const EARLIER_EDGE_OPACITY = 0.8

/**
 * An earlier build of the model, drawn over the current one for display only (#56): its parts where that build had
 * them, translucent and tinted, with their edges, in `--muted`: the colour of the old edges the ghosts of a build that
 * just landed show, and no mark's. Nothing here is pointed at (no bounds tree, no ray hits it), nothing measured from, nothing
 * a picture for the agent shows (`hide`), and nothing is written. It stays until it is cleared. The geometries it is given
 * are made here from the bytes of that build's meshes and disposed of at `clear`.
 */
export class Earlier {
  readonly group = new THREE.Group()
  private parts: Array<{ part: string; built: BuiltPart }> = []

  constructor() {
    this.group.name = 'earlier'
  }

  /** True while an earlier build is drawn. */
  get on(): boolean {
    return this.parts.length > 0
  }

  /** The keys of the parts drawn, in the order of the build. */
  keys(): string[] {
    return this.parts.map((p) => p.part)
  }

  /** Draws these parts of an earlier build (the ones of the layout shown), from the bytes of its meshes. Whatever was drawn before is put away first. */
  show(parts: readonly Part[], blob: ArrayBuffer, tint: string): void {
    this.clear()
    for (const part of parts) {
      const built = buildPart(part, blob, { tree: false })
      built.mesh.material.color.set(tint)
      built.mesh.material.transparent = true
      built.mesh.material.opacity = EARLIER_SURFACE_OPACITY
      built.mesh.material.depthWrite = false
      built.mesh.renderOrder = 1
      built.mesh.raycast = () => {}
      built.edges.material.color.set(tint)
      built.edges.material.transparent = true
      built.edges.material.opacity = EARLIER_EDGE_OPACITY
      built.edges.renderOrder = 2
      built.edges.raycast = () => {}
      this.group.add(built.group)
      this.parts.push({ part: part.key, built })
    }
  }

  /** The colour of what is drawn follows the theme. */
  tint(colour: string): void {
    for (const { built } of this.parts) {
      built.mesh.material.color.set(colour)
      built.edges.material.color.set(colour)
    }
  }

  /** Takes it out of what is drawn, and returns what puts it back (a picture is of the model alone). */
  hide(): () => void {
    const was = this.group.visible
    this.group.visible = false
    return () => {
      this.group.visible = was
    }
  }

  /** Puts it away and frees what it made. True when something was drawn. */
  clear(): boolean {
    const had = this.on
    for (const { built } of this.parts) {
      this.group.remove(built.group)
      disposePart(built)
    }
    this.parts = []
    return had
  }
}

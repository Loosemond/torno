import * as THREE from 'three'

/** How long the old edges and the outline of a part that changed stay at full strength after a build lands, ms. */
export const GHOST_HOLD_MS = 1000
/** Then they fade once, over this long, ms, and are gone. */
export const GHOST_FADE_MS = 500
export const GHOST_MS = GHOST_HOLD_MS + GHOST_FADE_MS

/** How strong the ghosts are `elapsed` ms after a build landed: 1 while held, falling to 0, and 0 once over. `still`: no fade, held and then gone. */
export function ghostLevel(elapsed: number, still = false): number {
  if (elapsed >= GHOST_MS) return 0
  if (elapsed <= GHOST_HOLD_MS || still) return 1
  return 1 - (elapsed - GHOST_HOLD_MS) / GHOST_FADE_MS
}

/** A part that changed, as the ghosts need it: where its old edges stood and its new ones stand, and their segments (part-local, 6 numbers each). */
export interface GhostItem {
  /** Which part, as the scene keys it: `layout:name`. */
  part: string
  layout: string
  before: { edges: THREE.BufferGeometry; position: THREE.Vector3; quaternion: THREE.Quaternion }
  /** Absent for a part that did not come out of the build with edges to draw. */
  after: { edges: THREE.BufferGeometry; position: THREE.Vector3; quaternion: THREE.Quaternion } | null
}

/**
 * What the viewport shows for a moment after a build lands: of each part that changed, its old edges where they
 * were, in `--muted` and seen through the part, and its new edges in the accent over the part. Neither is a mark
 * and neither is in a picture (`hide`). They go by themselves, once (`GHOST_MS`), or at once (`end`): a key, a click,
 * another layout, a section or an explode. Every geometry given is owned from then on and disposed of at the end.
 */
export class Ghosts {
  readonly group = new THREE.Group()
  private items: GhostItem[] = []
  private materials: THREE.LineBasicMaterial[] = []
  private began = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private still = false
  private held = false

  constructor(private readonly onEnd: () => void = () => {}) {
    this.group.name = 'ghosts'
  }

  /** For a test that captures the window: while held, the ghosts do not go by themselves (a key, a click or a new layout still end them). */
  hold(held: boolean): void {
    this.held = held
    if (held) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** True while some are shown. */
  get on(): boolean {
    return this.items.length > 0
  }

  /** The keys of the parts shown changed, in the order given. */
  keys(): string[] {
    return this.items.map((i) => i.part)
  }

  /** Shows these, from `now` (`performance.now()`), in these colours. An earlier set is ended first. */
  begin(items: GhostItem[], look: { old: string; fresh: string }, now: number, still = false): void {
    this.end(false)
    if (items.length === 0) return
    this.items = items
    this.began = now
    this.still = still
    const old = new THREE.LineBasicMaterial({ color: look.old, transparent: true, depthTest: false })
    const fresh = new THREE.LineBasicMaterial({ color: look.fresh, transparent: true })
    this.materials = [old, fresh]
    for (const item of items) {
      this.add(item.before, old, 2)
      if (item.after) this.add(item.after, fresh, 3)
    }
    // Over by its own clock, not by frames: nothing waits on a frame being drawn.
    if (!this.held) this.timer = setTimeout(() => this.end(), GHOST_MS + 50)
  }

  private add(at: NonNullable<GhostItem['after']>, material: THREE.LineBasicMaterial, order: number): void {
    const lines = new THREE.LineSegments(at.edges, material)
    lines.position.copy(at.position)
    lines.quaternion.copy(at.quaternion)
    lines.renderOrder = order
    lines.raycast = () => {}
    this.group.add(lines)
  }

  /** Brings the strength to `now`. False once none is left to draw (the ghosts are gone). */
  step(now: number): boolean {
    if (!this.on) return false
    const level = this.held ? 1 : ghostLevel(now - this.began, this.still)
    if (level <= 0) {
      this.end()
      return false
    }
    for (const m of this.materials) m.opacity = level
    return true
  }

  /** Takes them out of what is drawn, and returns what puts them back (a picture is of the model alone). */
  hide(): () => void {
    const was = this.group.visible
    this.group.visible = false
    return () => {
      this.group.visible = was
    }
  }

  /** Puts them away now. `told`: whether the viewport is told, to draw the frame without them. */
  end(told = true): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.on) return
    for (const line of [...this.group.children] as THREE.LineSegments[]) {
      this.group.remove(line)
      line.geometry.dispose()
    }
    for (const m of this.materials) m.dispose()
    this.materials = []
    this.items = []
    if (told) this.onEnd()
  }
}

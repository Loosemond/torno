import * as THREE from 'three'
import { type ExplodePart, type ExplodeState, explodeOffsets, isExploded } from '../../shared/explode'
import type { Vec3 } from '../../shared/marks'
import type { Hit } from './picking'

// Explode in the viewport: the parts of the layout shown are drawn apart, and nothing else is. A part is where
// the build placed it; what is here is only how far from there its group is drawn, now and once a move has
// ended. Whatever leaves the viewport as a position is of the part as built: `asBuilt` takes the offset away
// from every pick.

/** How long the parts take to go apart or to come together when that is asked in one go (a key, the agent), in milliseconds. */
export const EXPLODE_MS = 220

export type Offsets = Readonly<Record<string, Vec3>>

const NONE: Offsets = {}
const STILL: Vec3 = [0, 0, 0]

/**
 * How far each part of one layout is drawn from where it is, by part name: as it is drawn now (`offsets`) and as
 * it will be once it has got there (`target`). Asked with a time, it goes there over `EXPLODE_MS` from wherever
 * it is, a step with every frame (`step`); without, at once, as under a slider that is being dragged.
 */
export class PartsApart {
  private state: ExplodeState | null = null
  private drawn: Offsets = NONE
  private aim: Offsets = NONE
  private move: { from: Offsets; start: number } | null = null

  /** The explode the parts are drawn by, or are on their way to; null for none. */
  get(): ExplodeState | null {
    return this.state
  }

  /** How far each part is drawn from where it is, now; `{}` when none is. */
  offsets(): Offsets {
    return this.drawn
  }

  /** How far each part will be drawn from where it is once the move under way has ended. */
  target(): Offsets {
    return this.aim
  }

  /** Whether any part is drawn off where it is, or is about to be. */
  get any(): boolean {
    return this.drawn !== NONE || this.aim !== NONE
  }

  /** Whether the parts are on their way: `step` has more to say. */
  get moving(): boolean {
    return this.move !== null
  }

  /** Draws these parts apart so, or together for null: over a moment that starts at `startAt`, or at once without. */
  set(explode: ExplodeState | null, parts: readonly ExplodePart[], startAt?: number): void {
    this.state = isExploded(explode) ? explode : null
    this.aim = offsetsOf(parts, this.state)
    if (startAt === undefined || (this.drawn === NONE && this.aim === NONE)) {
      this.move = null
      this.drawn = this.aim
    } else {
      this.move = { from: this.drawn, start: startAt }
    }
  }

  /** The parts are others (another layout, another build): they are drawn apart by the same explode, at once. */
  over(parts: readonly ExplodePart[]): void {
    this.set(this.state, parts)
  }

  /** Moves the parts on to where they are at `now`. False when nothing changed: no move is under way. */
  step(now: number): boolean {
    const move = this.move
    if (!move) return false
    const t = Math.min(Math.max((now - move.start) / EXPLODE_MS, 0), 1)
    if (t >= 1) {
      this.move = null
      this.drawn = this.aim
      return true
    }
    // Fast away, slow to rest.
    const eased = 1 - (1 - t) ** 3
    const between: Record<string, Vec3> = {}
    for (const name of new Set([...Object.keys(move.from), ...Object.keys(this.aim)])) {
      const from = move.from[name] ?? STILL
      const to = this.aim[name] ?? STILL
      between[name] = [from[0] + (to[0] - from[0]) * eased, from[1] + (to[1] - from[1]) * eased, from[2] + (to[2] - from[2]) * eased]
    }
    this.drawn = between
    return true
  }
}

function offsetsOf(parts: readonly ExplodePart[], explode: ExplodeState | null): Offsets {
  const offsets = explodeOffsets(parts, explode)
  return Object.keys(offsets).length === 0 ? NONE : offsets
}

/**
 * A hit as it is answered: on the part as built. The ray met the part where it is drawn; how far that is from
 * where the part is, is taken away from the point. Its ref, its normal and how far along the ray it was met are
 * the same either way: parts are moved, never turned.
 */
export function asBuilt<H extends Pick<Hit, 'part' | 'point'>>(hit: H | null, offsets: Offsets): H | null {
  const by = hit ? offsets[hit.part] : undefined
  if (!hit || !by || (by[0] === 0 && by[1] === 0 && by[2] === 0)) return hit
  return { ...hit, point: [hit.point[0] - by[0], hit.point[1] - by[1], hit.point[2] - by[2]] }
}

/** The box round some parts as they are drawn: each part's box moved by how far the part is drawn off. Null for no parts. */
export function drawnBox(parts: readonly ExplodePart[], offsets: Offsets): { min: number[]; max: number[] } | null {
  if (parts.length === 0) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) {
    const by = offsets[part.name] ?? STILL
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], part.bbox.min[i] + by[i])
      max[i] = Math.max(max[i], part.bbox.max[i] + by[i])
    }
  }
  return { min, max }
}

/** Where something of a part is drawn: where it is (`loc.t`: the part's own place, or a point of it), off by how far the part is drawn apart. */
export function drawnAt(part: { name: string; loc: { t: Vec3 } }, offsets: Offsets): Vec3 {
  const by = offsets[part.name] ?? STILL
  return [part.loc.t[0] + by[0], part.loc.t[1] + by[1], part.loc.t[2] + by[2]]
}

/**
 * A sphere round some parts as built, grown to hold them where they are drawn and where they are going: the
 * camera's near and far planes reach them there. The same sphere when nothing is apart; never changed itself.
 */
export function reachingApart(sphere: THREE.Sphere, parts: readonly ExplodePart[], apart: Pick<PartsApart, 'any' | 'offsets' | 'target'>): THREE.Sphere {
  if (!apart.any) return sphere
  const all = sphere.clone()
  for (const offsets of [apart.offsets(), apart.target()]) {
    const box = drawnBox(parts, offsets)
    if (box) all.union(new THREE.Box3(new THREE.Vector3().fromArray(box.min), new THREE.Vector3().fromArray(box.max)).getBoundingSphere(new THREE.Sphere()))
  }
  return all
}

/**
 * Whether any of some parts, drawn off by `offsets`, is outside the view: a corner of its box is projected off
 * the screen (`project` answers in fractions of the half size of the view, -1 to 1 across it). What decides
 * whether drawing the parts apart is followed by fitting them: only when one of them would no longer be seen whole.
 */
export function leavesView(parts: readonly ExplodePart[], offsets: Offsets, project: (point: Vec3) => readonly [number, number]): boolean {
  for (const part of parts) {
    const by = offsets[part.name] ?? STILL
    for (let corner = 0; corner < 8; corner++) {
      const [x, y] = project([0, 1, 2].map((i) => ((corner >> i) & 1 ? part.bbox.max[i] : part.bbox.min[i]) + by[i]) as Vec3)
      if (!(Math.abs(x) <= 1 && Math.abs(y) <= 1)) return true
    }
  }
  return false
}

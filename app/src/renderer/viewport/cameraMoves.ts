import * as THREE from 'three'
import type { Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'

/** How long the camera takes to go to a view it is sent to. */
export const MOVE_MS = 240

/** Where a camera on its way from one view to another is, a share `k` of the way (0 to 1): swung round the target rather than cut through the part. */
export function between(from: Camera, to: Camera, k: number): Camera {
  const vec = (a: Vec3): THREE.Vector3 => new THREE.Vector3().fromArray(a)
  const target = vec(from.target).lerp(vec(to.target), k)
  const a = vec(from.position).sub(vec(from.target))
  const b = vec(to.position).sub(vec(to.target))
  const [la, lb] = [a.length(), b.length()]
  const turn = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize())
  const offset = a
    .normalize()
    .applyQuaternion(new THREE.Quaternion().slerp(turn, k))
    .multiplyScalar(la * (lb / la) ** k)
  return { ...to, position: target.clone().add(offset).toArray(), target: target.toArray(), zoom: from.zoom * (to.zoom / from.zoom) ** k }
}

/**
 * The camera's move to a view it was sent to, over `MOVE_MS`. `step` says where it is now, and forgets the move
 * once it has arrived. A press is answered from the camera as it is at the press, wherever the move has got
 * to: what is clicked is what is seen. Nothing jumps the move to its end.
 */
export class CameraMove {
  private move: { from: Camera; to: Camera; start: number } | null = null

  get under(): boolean {
    return this.move !== null
  }

  /** Where the camera is going, while it is on its way; null when it is at rest. */
  get goal(): Camera | null {
    return this.move?.to ?? null
  }

  begin(from: Camera, to: Camera, now: number): void {
    this.move = { from, to, start: now }
  }

  /** Gives the move up where it is. */
  drop(): void {
    this.move = null
  }

  step(now: number): Camera | null {
    const move = this.move
    if (!move) return null
    const t = Math.min((now - move.start) / MOVE_MS, 1)
    if (t >= 1) {
      this.move = null
      return move.to
    }
    return between(move.from, move.to, t * t * (3 - 2 * t))
  }

}

/**
 * Where a camera is put to look at `c.target` from `c.position`. An orbit that keeps Z up says nothing about a
 * camera looking straight along Z: it is leant by a hair, so that `up` ends up at the top of the screen.
 */
export function standingAt(c: Camera): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = new THREE.Vector3().fromArray(c.target)
  const position = new THREE.Vector3().fromArray(c.position)
  const offset = position.clone().sub(target)
  const dist = offset.length() || 1
  if (Math.abs(offset.z) > dist * (1 - 1e-10)) {
    const lean = new THREE.Vector3(c.up[0], c.up[1], 0)
    if (lean.lengthSq() > 0) position.addScaledVector(lean.normalize(), -Math.sign(offset.z) * dist * 1e-5)
  }
  return { position, target }
}

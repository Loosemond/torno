import * as THREE from 'three'
import type { Vec3 } from '../../shared/marks'

/** The brush of the Region tool where the pointer is on a scan: its middle and the way the surface faces there, in the object frame, and its radius in millimetres. */
export interface BrushRing { centre: Vec3; normal: Vec3; radius: number; erase?: boolean }

const SEGMENTS = 48
const middle = new THREE.Vector3()
const across = new THREE.Vector3()
const along = new THREE.Vector3()
const seen = new THREE.Vector3()

/** The ring as points on the surface's own plane, in the object frame: a circle of the brush's radius about its middle. */
export function ringPoints(ring: BrushRing, segments = SEGMENTS): Vec3[] {
  const normal = new THREE.Vector3().fromArray(ring.normal)
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1)
  normal.normalize()
  // Any direction in the plane: square to the normal and to the axis it leans on least.
  across.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0).cross(normal).normalize()
  along.copy(normal).cross(across)
  middle.fromArray(ring.centre)
  return Array.from({ length: segments }, (_, n) => {
    const turn = (2 * Math.PI * n) / segments
    return seen.copy(middle).addScaledVector(across, ring.radius * Math.cos(turn)).addScaledVector(along, ring.radius * Math.sin(turn)).toArray() as Vec3
  })
}

/**
 * Draws the brush as a ring lying on the scan: on the canvas of the marks' labels, so over everything and in
 * no picture for the agent. In the colour of the person's marks, dashed while it erases. `camera`'s matrices are
 * up to date; `size` is the view in pixels.
 */
export function drawBrushRing(ctx: CanvasRenderingContext2D, ring: BrushRing | null, camera: THREE.Camera, size: { width: number; height: number }, colours: { mark: string; paper: string }): void {
  if (!ring) return
  const points: Array<[number, number]> = []
  for (const point of ringPoints(ring)) {
    seen.fromArray(point).project(camera)
    // Behind the camera, or past what it draws: a ring with a part of it nowhere is not drawn.
    if (!(seen.z >= -1 && seen.z <= 1)) return
    points.push([((seen.x + 1) / 2) * size.width, ((1 - seen.y) / 2) * size.height])
  }
  const trace = (): void => {
    ctx.beginPath()
    points.forEach(([x, y], n) => (n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.closePath()
  }
  ctx.save()
  // A light line under the coloured one: the ring reads on a dark scan and on a pale one.
  trace()
  ctx.lineWidth = 3
  ctx.strokeStyle = colours.paper
  ctx.globalAlpha = 0.7
  ctx.stroke()
  trace()
  ctx.globalAlpha = 1
  ctx.lineWidth = 1.5
  ctx.strokeStyle = colours.mark
  ctx.setLineDash(ring.erase ? [4, 3] : [])
  ctx.stroke()
  ctx.restore()
}

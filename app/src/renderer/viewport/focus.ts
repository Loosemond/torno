import * as THREE from 'three'
import type { Camera, SectionPlane } from '../../shared/view'

type Vec3 = [number, number, number]

/** Where an orthographic camera's line of sight starts: this far back from the middle of the focus, mm, beyond anything in the scene. */
const FAR_BACK = 1e5

/** A part as the line of sight is cast at it: its name, and its mesh when it has one (it is placed by its group, whose matrices are brought up to date here). */
export interface Occluder {
  name: string
  mesh?: THREE.Mesh
}

/**
 * Which of these parts stand between the camera and the middle of a focus, nearest first: the line from the camera
 * to the middle of `box` meets them before it comes to the box (a part's own near face lies on the box's, not before
 * it, so a part is never in its own way, but it is in the way of a face on its far side). A line is cast at the
 * middle only: a focus that is half covered is not told as hidden. What a cut takes away (`section`) is not in the
 * way, and a line that starts inside the box meets nothing before it. Synchronous, and leaves the meshes as they were.
 */
export function hiddenBehind(parts: readonly Occluder[], camera: Camera, box: { min: readonly number[]; max: readonly number[] }, section: SectionPlane | null = null): string[] {
  const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2))
  const look = new THREE.Vector3(...camera.target).sub(new THREE.Vector3(...camera.position)).normalize()
  const origin = camera.ortho ? centre.clone().addScaledVector(look, -FAR_BACK) : new THREE.Vector3(...camera.position)
  const toward = camera.ortho ? look : centre.clone().sub(origin).normalize()
  const enters = entering(origin, toward, box)
  if (enters === null) return []
  // The box's own surface is not a part of the way to it: the mesh of a curved face lies a little off the box that holds it.
  const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2])
  const before = enters - Math.max(0.02, 0.005 * diagonal)
  const ray = new THREE.Raycaster(origin, toward)
  ray.near = 0
  ray.far = Math.max(before, 0)
  const found: Array<{ name: string; at: number }> = []
  for (const part of parts) {
    if (!part.mesh || !(before > 0)) continue
    part.mesh.updateWorldMatrix(true, false)
    const material = part.mesh.material as THREE.Material
    const side = material.side
    // Both faces: from inside a part the line meets its back faces first, and a cut part is capped where it is cut.
    material.side = THREE.DoubleSide
    let hits: THREE.Intersection[]
    try {
      hits = ray.intersectObject(part.mesh, false)
    } finally {
      material.side = side
    }
    const kept = hits.find((hit) => section === null || !removed(hit.point, section))
    if (kept) found.push({ name: part.name, at: kept.distance })
  }
  return found.sort((a, b) => a.at - b.at).map((one) => one.name)
}

/** Whether a point lies on the side of a section that is not drawn. */
function removed(point: THREE.Vector3, section: SectionPlane): boolean {
  return (point.x - section.origin[0]) * section.normal[0] + (point.y - section.origin[1]) * section.normal[1] + (point.z - section.origin[2]) * section.normal[2] > 0
}

/** How far along a line it first meets a box (0 when it starts inside), or null when it misses it. */
function entering(origin: THREE.Vector3, direction: THREE.Vector3, box: { min: readonly number[]; max: readonly number[] }): number | null {
  let near = -Infinity
  let far = Infinity
  const o = origin.toArray() as Vec3
  const d = direction.toArray() as Vec3
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < box.min[i] || o[i] > box.max[i]) return null
      continue
    }
    const [a, b] = [(box.min[i] - o[i]) / d[i], (box.max[i] - o[i]) / d[i]]
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
  }
  return near <= far && far >= 0 ? Math.max(near, 0) : null
}

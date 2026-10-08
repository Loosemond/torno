import * as THREE from 'three'
import { bufView, type Part } from '../../shared/scene'

export interface BuiltPart {
  /** Parent of `mesh` and `edges`, placed by `part.loc`. Add this to the scene. */
  group: THREE.Group
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  /** The B-rep edges. */
  edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
  /** Index offset at which each face's triangles start, with the total at the end. */
  faceStarts: Uint32Array
}

/**
 * The three.js objects for one part. The geometry owns copies of its data, so
 * the blob can be released afterwards. Colours are left for the caller to set.
 */
export function buildPart(part: Part, blob: ArrayBuffer): BuiltPart {
  const m = part.mesh

  const surface = new THREE.BufferGeometry()
  surface.setAttribute('position', new THREE.BufferAttribute(bufView(blob, m.vertices, Float32Array).slice(), 3))
  surface.setAttribute('normal', new THREE.BufferAttribute(bufView(blob, m.normals, Float32Array).slice(), 3))
  surface.setIndex(new THREE.BufferAttribute(bufView(blob, m.triangles, Uint32Array).slice(), 1))
  const mesh = new THREE.Mesh(
    surface,
    new THREE.MeshStandardMaterial({
      roughness: 0.75,
      metalness: 0,
      flatShading: false,
      // Push the surface back a little so the edges drawn on it win the depth test.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    })
  )

  const lines = new THREE.BufferGeometry()
  lines.setAttribute('position', new THREE.BufferAttribute(bufView(blob, m.edges, Float32Array).slice(), 3))
  const edges = new THREE.LineSegments(lines, new THREE.LineBasicMaterial())

  const perFace = bufView(blob, m.trianglesPerFace, Uint32Array)
  const faceStarts = new Uint32Array(perFace.length + 1)
  for (let i = 0; i < perFace.length; i++) faceStarts[i + 1] = faceStarts[i] + perFace[i] * 3

  // `loc` is the tessellator's local → object transform; the buffers are part-local.
  const group = new THREE.Group()
  group.name = part.key
  group.position.fromArray(part.loc.t)
  group.quaternion.fromArray(part.loc.q)
  group.add(mesh, edges)

  return { group, mesh, edges, faceStarts }
}

/**
 * The face a triangle belongs to, or -1 if the triangle is not in the mesh.
 * `triangle` is a triangle number (index offset / 3), as a raycast reports it.
 */
export function faceOfTriangle(faceStarts: Uint32Array, triangle: number): number {
  const offset = triangle * 3
  const faces = faceStarts.length - 1
  if (!(offset >= 0) || faces < 1 || offset >= faceStarts[faces]) return -1
  // The last face whose start is at or before the offset; empty faces share a
  // start with the next one and are passed over.
  let lo = 0
  let hi = faces - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (faceStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

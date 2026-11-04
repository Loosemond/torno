import * as THREE from 'three'
import type { BuiltPart } from './partMesh'
import { parseRef } from './picking'

/**
 * The box round some faces and edges (`lid/F12`, `lid/E3`, or `lid` for all of it) as they are drawn: from the
 * triangles and segments of the drawn mesh, with the part's place and how far it is drawn apart. Only for framing
 * the camera, never a number told to anyone. Null when the refs name nothing drawn.
 */
export function selectionBox(partNamed: (name: string) => BuiltPart | undefined, refs: readonly string[]): { min: number[]; max: number[] } | null {
  const box = new THREE.Box3()
  const at = new THREE.Vector3()
  for (const ref of refs) {
    const { part, kind, index } = parseRef(ref)
    const built = partNamed(part)
    if (!built) continue
    built.group.updateWorldMatrix(true, false)
    if (kind === 'edge') {
      const from = built.edgeStarts[index]
      const to = built.edgeStarts[index + 1]
      if (to === undefined || to <= from) continue
      const positions = built.edges.geometry.getAttribute('position')
      for (let i = from * 2; i < to * 2; i++) box.expandByPoint(at.fromBufferAttribute(positions, i).applyMatrix4(built.group.matrixWorld))
      continue
    }
    const starts = built.faceStarts
    const from = kind === 'part' ? 0 : starts[index]
    const to = kind === 'part' ? starts[starts.length - 1] : starts[index + 1]
    if (to === undefined || to <= from) continue
    const positions = built.mesh.geometry.getAttribute('position')
    const indices = built.mesh.geometry.getIndex()
    for (let i = from; i < to; i++) box.expandByPoint(at.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(built.group.matrixWorld))
  }
  return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() }
}

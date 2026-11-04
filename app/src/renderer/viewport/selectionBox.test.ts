import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { BuiltPart } from './partMesh'
import { selectionBox } from './selectionBox'

// Two triangles, one face each, a segment for each of two edges.
function built(): BuiltPart {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry())
  mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 10, 10, 12, 10, 10, 10, 14, 10], 3))
  mesh.geometry.setIndex([0, 1, 2, 3, 4, 5])
  const edges = new THREE.LineSegments(new THREE.BufferGeometry())
  edges.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 5, 0, 0, 0, 0, 7, 0, 0, 9], 3))
  const group = new THREE.Group()
  group.position.set(100, 0, 0)
  return { group, mesh, edges, faceted: false, solid: true, faceStarts: new Uint32Array([0, 3, 6]), edgeStarts: new Uint32Array([0, 1, 2]) } as unknown as BuiltPart
}

describe('the box of a selection, from the drawn mesh', () => {
  const part = built()
  const of = (name: string) => (name === 'lid' ? part : undefined)

  it('is that of a face, where the part is drawn', () => {
    expect(selectionBox(of, ['lid/F1'])).toEqual({ min: [110, 10, 10], max: [112, 14, 10] })
  })
  it('is that of an edge, and of a face and an edge together', () => {
    expect(selectionBox(of, ['lid/E1'])).toEqual({ min: [100, 0, 7], max: [100, 0, 9] })
    expect(selectionBox(of, ['lid/F0', 'lid/E0'])).toEqual({ min: [100, 0, 0], max: [105, 1, 0] })
  })
  it('is that of the whole part for its name, and null for what is not drawn', () => {
    expect(selectionBox(of, ['lid'])).toEqual({ min: [100, 0, 0], max: [112, 14, 10] })
    expect(selectionBox(of, ['gone/F0', 'lid/F9'])).toBeNull()
  })
})

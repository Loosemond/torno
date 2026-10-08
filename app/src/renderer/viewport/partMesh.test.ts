import { describe, expect, it } from 'vitest'
import type { Buf, Part } from '../../shared/scene'
import { buildPart, faceOfTriangle } from './partMesh'

/** Packs typed arrays into one blob, the way the kernel does. */
function pack(arrays: Record<string, Float32Array | Uint32Array>): { blob: ArrayBuffer; bufs: Record<string, Buf> } {
  const total = Object.values(arrays).reduce((n, a) => n + a.byteLength, 0)
  const blob = new ArrayBuffer(total)
  const bytes = new Uint8Array(blob)
  const bufs: Record<string, Buf> = {}
  let offset = 0
  for (const [name, a] of Object.entries(arrays)) {
    bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset)
    bufs[name] = { offset, length: a.byteLength }
    offset += a.byteLength
  }
  return { blob, bufs }
}

// Two faces: a quad (2 triangles) and a hexagon-ish fan (4 triangles), 10 vertices.
const vertices = new Float32Array(30).map((_, i) => i * 0.5)
const normals = new Float32Array(30).map((_, i) => (i % 3 === 2 ? 1 : 0))
const triangles = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 4, 7, 8, 4, 8, 9])
const edges = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1e-7]) // last one degenerate
const { blob, bufs } = pack({
  vertices,
  normals,
  triangles,
  edges,
  trianglesPerFace: new Uint32Array([2, 4]),
  segmentsPerEdge: new Uint32Array([1, 1, 1]),
  faceTypes: new Uint32Array([0, 0]),
  edgeTypes: new Uint32Array([0, 0, 0])
})

const s = Math.SQRT1_2
const part: Part = {
  key: 'assembly:base',
  name: 'base',
  layout: 'assembly',
  loc: { t: [-20, -15, -2.5], q: [0, 0, s, s] }, // 90° about Z
  bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] },
  volume: 6000,
  faceCount: 2,
  edgeCount: 3,
  triangleCount: 6,
  valid: true,
  hash: 'abc',
  mesh: bufs as unknown as Part['mesh']
}

describe('buildPart', () => {
  const built = buildPart(part, blob)

  it('makes faceStarts the running index offset with a leading 0', () => {
    expect(Array.from(built.faceStarts)).toEqual([0, 6, 18])
  })

  it('gives the geometry the right vertex and index counts', () => {
    const g = built.mesh.geometry
    expect(g.getAttribute('position').count).toBe(10)
    expect(g.getAttribute('normal').count).toBe(10)
    expect(g.getIndex()?.count).toBe(18)
    expect(Array.from(g.getIndex()!.array)).toEqual(Array.from(triangles))
    expect(Array.from(g.getAttribute('position').array)).toEqual(Array.from(vertices))
  })

  it('draws every edge segment, degenerate ones included', () => {
    expect(built.edges.geometry.getAttribute('position').count).toBe(6)
  })

  it('puts mesh and edges under a group that carries loc', () => {
    expect(built.mesh.parent).toBe(built.group)
    expect(built.edges.parent).toBe(built.group)
    expect(built.group.position.toArray()).toEqual([-20, -15, -2.5])
    expect(built.group.quaternion.toArray()).toEqual([0, 0, s, s])
    expect(built.mesh.position.toArray()).toEqual([0, 0, 0])
  })

  it('uses the standard material the look calls for', () => {
    const m = built.mesh.material
    expect(m.roughness).toBe(0.75)
    expect(m.metalness).toBe(0)
    expect(m.flatShading).toBe(false)
    expect(m.polygonOffset).toBe(true)
    expect(m.polygonOffsetFactor).toBeGreaterThan(0)
  })

  it('owns its data, so the blob can be released', () => {
    const copy = blob.slice(0)
    const b = buildPart(part, copy)
    new Uint8Array(copy).fill(0)
    expect(Array.from(b.mesh.geometry.getAttribute('position').array)).toEqual(Array.from(vertices))
    expect(Array.from(b.faceStarts)).toEqual([0, 6, 18])
  })
})

describe('faceOfTriangle', () => {
  const faceStarts = new Uint32Array([0, 6, 18])

  it('maps triangles 0–1 to face 0 and 2–5 to face 1', () => {
    expect([0, 1, 2, 3, 4, 5].map((t) => faceOfTriangle(faceStarts, t))).toEqual([0, 0, 1, 1, 1, 1])
  })

  it('returns -1 outside the mesh', () => {
    expect(faceOfTriangle(faceStarts, 6)).toBe(-1)
    expect(faceOfTriangle(faceStarts, -1)).toBe(-1)
  })

  it('skips faces with no triangles', () => {
    const starts = new Uint32Array([0, 3, 3, 3, 9]) // faces 1 and 2 are empty
    expect([0, 1, 2].map((t) => faceOfTriangle(starts, t))).toEqual([0, 3, 3])
  })

  it('agrees with a linear scan on a larger mesh', () => {
    const counts = [3, 1, 7, 2, 2, 9, 1, 4]
    const starts = new Uint32Array(counts.length + 1)
    counts.forEach((c, i) => (starts[i + 1] = starts[i] + c * 3))
    let t = 0
    counts.forEach((c, face) => {
      for (let k = 0; k < c; k++) expect(faceOfTriangle(starts, t++)).toBe(face)
    })
  })
})

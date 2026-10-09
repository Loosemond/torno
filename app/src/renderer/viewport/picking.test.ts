import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Buf, Part } from '../../shared/scene'
import { buildPart } from './partMesh'
import { closestOnSegment, edgeOfSegment, parseRef, pickEdge, pickParts, type Pickable, projectSegments, refOf, segmentsNear } from './picking'

describe('edgeOfSegment', () => {
  // Three edges of 2, 0 and 3 segments.
  const starts = new Uint32Array([0, 2, 2, 5])

  it('maps a segment to the edge whose range holds it, at both ends of the range', () => {
    expect(edgeOfSegment(starts, 0)).toBe(0)
    expect(edgeOfSegment(starts, 1)).toBe(0)
    expect(edgeOfSegment(starts, 2)).toBe(2)
    expect(edgeOfSegment(starts, 4)).toBe(2)
  })

  it('passes over an edge with no segments, wherever it is', () => {
    expect(edgeOfSegment(new Uint32Array([0, 0, 1, 1, 3, 3]), 0)).toBe(1)
    expect(edgeOfSegment(new Uint32Array([0, 0, 1, 1, 3, 3]), 1)).toBe(3)
    expect(edgeOfSegment(new Uint32Array([0, 0, 1, 1, 3, 3]), 2)).toBe(3)
  })

  it('is -1 for a segment the part does not have', () => {
    expect(edgeOfSegment(starts, 5)).toBe(-1)
    expect(edgeOfSegment(starts, -1)).toBe(-1)
    expect(edgeOfSegment(starts, Number.NaN)).toBe(-1)
    expect(edgeOfSegment(new Uint32Array([0]), 0)).toBe(-1)
    expect(edgeOfSegment(new Uint32Array(0), 0)).toBe(-1)
  })
})

describe('refOf and parseRef', () => {
  it('names a face and an edge of a part', () => {
    expect(refOf('lid', 'face', 12)).toBe('lid/F12')
    expect(refOf('lid', 'edge', 0)).toBe('lid/E0')
  })

  it('reads back what refOf wrote, and a part on its own', () => {
    expect(parseRef('lid/F12')).toEqual({ part: 'lid', kind: 'face', index: 12 })
    expect(parseRef('lid/E0')).toEqual({ part: 'lid', kind: 'edge', index: 0 })
    expect(parseRef('lid')).toEqual({ part: 'lid', kind: 'part', index: -1 })
    // Only the last piece is an index: a name may hold a slash.
    expect(parseRef('a/F1/E2')).toEqual({ part: 'a/F1', kind: 'edge', index: 2 })
    expect(parseRef('lid/F')).toEqual({ part: 'lid/F', kind: 'part', index: -1 })
  })
})

describe('pickEdge', () => {
  // x1 y1 x2 y2 per segment, in pixels.
  const screen = new Float32Array([
    0, 0, 100, 0, // 0: along the top
    100, 0, 100, 100, // 1: down the right
    0, 10, 100, 10, // 2: 10 px under the top
    Number.NaN, Number.NaN, Number.NaN, Number.NaN // 3: behind the eye
  ])

  it('chooses the nearest segment within the radius', () => {
    expect(pickEdge(screen, [50, 3], 6)).toEqual({ segment: 0, distance: 3 })
    expect(pickEdge(screen, [50, 6], 6)).toEqual({ segment: 2, distance: 4 })
    expect(pickEdge(screen, [97, 50], 6)).toEqual({ segment: 1, distance: 3 })
  })

  it('measures to the end of a segment, not to the line through it', () => {
    expect(pickEdge(screen, [104, -3], 6)).toEqual({ segment: 0, distance: 5 })
    expect(pickEdge(screen, [110, 0], 6)).toBeNull()
  })

  it('chooses none beyond the radius; on the radius is within', () => {
    expect(pickEdge(screen, [50, 50], 6)).toBeNull()
    expect(pickEdge(screen, [50, -6], 6)).toEqual({ segment: 0, distance: 6 })
    expect(pickEdge(screen, [50, -6.01], 6)).toBeNull()
    expect(pickEdge(new Float32Array(0), [0, 0], 6)).toBeNull()
  })

  it('lists every segment within the radius, nearest first', () => {
    expect(segmentsNear(screen, 50, 5, 6).map((s) => s.segment)).toEqual([0, 2])
    expect(segmentsNear(screen, 50, 5.5, 6).map((s) => s.segment)).toEqual([2, 0])
  })

  it('finds a segment that has shrunk to a point', () => {
    expect(pickEdge(new Float32Array([5, 5, 5, 5]), [8, 9], 6)).toEqual({ segment: 0, distance: 5 })
  })
})

describe('projectSegments', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  // Column-major, like three.js: w = -z, the rest as it is. The eye looks down -Z.
  const eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]

  it('puts clip space on the canvas, y down', () => {
    const out = projectSegments(new Float32Array([0, 0, 0, 1, 1, 0, -1, -1, 0, 0.5, 0, 0]), identity, 200, 100)
    expect(Array.from(out)).toEqual([100, 50, 200, 0, 0, 100, 150, 50])
  })

  it('divides by w', () => {
    const out = projectSegments(new Float32Array([1, 1, -2, 0, 0, -1]), eye, 200, 100)
    expect(Array.from(out)).toEqual([150, 25, 100, 50])
  })

  it('leaves out a segment behind the eye, and cuts one that crosses it', () => {
    const out = projectSegments(new Float32Array([0, 0, 1, 1, 0, 2, 0, 0, -1, 0, 0, 1]), eye, 200, 100)
    expect(Array.from(out.subarray(0, 4)).every(Number.isNaN)).toBe(true)
    expect(Array.from(out.subarray(4, 8))).toEqual([100, 50, 100, 50])
    expect(Array.from(out.subarray(4, 8)).every(Number.isFinite)).toBe(true)
  })

  it('writes into the array it is given when that is long enough', () => {
    const into = new Float32Array(8)
    expect(projectSegments(new Float32Array(6), identity, 2, 2, into)).toBe(into)
    expect(projectSegments(new Float32Array(18), identity, 2, 2, into)).not.toBe(into)
  })
})

describe('closestOnSegment', () => {
  it('is the point of the segment nearest to a ray', () => {
    // A ray down -Z through (3, 1): nearest on the X axis segment is (3, 0, 0).
    expect(closestOnSegment([0, 0, 0], [10, 0, 0], [3, 1, 50], [0, 0, -1])).toEqual([3, 0, 0])
  })

  it('stops at the ends', () => {
    expect(closestOnSegment([0, 0, 0], [10, 0, 0], [30, 1, 50], [0, 0, -1])).toEqual([10, 0, 0])
    expect(closestOnSegment([0, 0, 0], [10, 0, 0], [-4, 1, 50], [0, 0, -1])).toEqual([0, 0, 0])
  })

  it('is an end when the segment runs along the ray, or is a point', () => {
    expect(closestOnSegment([0, 0, 0], [0, 0, 5], [1, 0, 50], [0, 0, -1])).toEqual([0, 0, 0])
    expect(closestOnSegment([2, 2, 2], [2, 2, 2], [1, 0, 50], [0, 0, -1])).toEqual([2, 2, 2])
  })
})

/** Packs typed arrays into one blob, the way the kernel does. */
function pack(arrays: Record<string, Float32Array | Uint32Array>): { blob: ArrayBuffer; mesh: Part['mesh'] } {
  const blob = new ArrayBuffer(Object.values(arrays).reduce((n, a) => n + a.byteLength, 0))
  const bufs: Record<string, Buf> = {}
  let offset = 0
  for (const [name, a] of Object.entries(arrays)) {
    new Uint8Array(blob).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset)
    bufs[name] = { offset, length: a.byteLength }
    offset += a.byteLength
  }
  return { blob, mesh: bufs as unknown as Part['mesh'] }
}

/**
 * A plate of `size` mm in its own XY plane, facing its +Z: two faces (the
 * lower and the upper half), and four edges round it, the second in two
 * segments. `loc` stands it up: its +Z is the object's -Y, its Y the object's Z.
 */
function plate(name: string, size: number, t: [number, number, number]): Pickable {
  const h = size / 2
  const { blob, mesh } = pack({
    vertices: new Float32Array([0, 0, 0, size, 0, 0, size, h, 0, 0, h, 0, size, size, 0, 0, size, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]),
    edges: new Float32Array([0, 0, 0, size, 0, 0, size, 0, 0, size, h, 0, size, h, 0, size, size, 0, size, size, 0, 0, size, 0, 0, size, 0, 0, 0, 0]),
    trianglesPerFace: new Uint32Array([2, 2]),
    segmentsPerEdge: new Uint32Array([1, 2, 1, 1]),
    faceTypes: new Uint32Array(2),
    edgeTypes: new Uint32Array(4)
  })
  const part: Part = {
    key: `assembly:${name}`,
    name,
    layout: 'assembly',
    loc: { t, q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }, // 90° about X
    bbox: { min: t, max: [t[0] + size, t[1], t[2] + size] },
    volume: 0,
    faceCount: 2,
    edgeCount: 4,
    triangleCount: 4,
    valid: true,
    hash: name,
    mesh
  }
  const built = buildPart(part, blob)
  built.group.updateMatrixWorld(true)
  return { key: part.key, name, built }
}

describe('pickParts', () => {
  // Looking along +Y at a 20 mm square around (105, 0, 5), on a canvas of 200 px: 10 px to the millimetre.
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000)
  camera.up.set(0, 0, 1)
  camera.position.set(105, -50, 5)
  camera.lookAt(105, 0, 5)
  camera.updateMatrixWorld()
  const size = { width: 200, height: 200 }
  /** The pointer over a point of the object's XZ plane. */
  const over = (x: number, z: number) => ({ x: (x - 105) / 10, y: (z - 5) / 10 })
  const near = (v: number[] | null, to: number[]) => v!.forEach((c, i) => expect(c).toBeCloseTo(to[i], 4))

  const base = plate('plate', 10, [100, 0, 0])

  it('hits the face under the pointer, in the object frame', () => {
    const lower = pickParts([base], camera, over(104, 2), size)!
    expect(lower).toMatchObject({ partKey: 'assembly:plate', part: 'plate', kind: 'face', index: 0, ref: 'plate/F0' })
    near(lower.point, [104, 0, 2])
    near(lower.normal, [0, -1, 0])
    expect(lower.distance).toBeCloseTo(49.9, 3) // from the near plane
    expect(pickParts([base], camera, over(104, 8), size)).toMatchObject({ kind: 'face', index: 1, ref: 'plate/F1' })
  })

  it('hits nothing beside the parts, and nothing when there are none', () => {
    expect(pickParts([base], camera, over(98, 5), size)).toBeNull()
    expect(pickParts([], camera, over(104, 2), size)).toBeNull()
  })

  it('prefers an edge within 6 px to the face under the pointer', () => {
    const hit = pickParts([base], camera, over(104, 0.5), size)!
    expect(hit).toMatchObject({ part: 'plate', kind: 'edge', index: 0, ref: 'plate/E0', normal: null })
    near(hit.point, [104, 0, 0])
    // From outside the part too, where no face is.
    expect(pickParts([base], camera, over(104, -0.5), size)).toMatchObject({ kind: 'edge', index: 0 })
    expect(pickParts([base], camera, over(104, 0.7), size)).toMatchObject({ kind: 'face', index: 0 })
    expect(pickParts([base], camera, over(104, -0.7), size)).toBeNull()
  })

  it('names the edge of a segment, not the segment', () => {
    // The right side is edge 1 in two segments; the top is edge 2.
    expect(pickParts([base], camera, over(109.8, 2), size)).toMatchObject({ kind: 'edge', index: 1 })
    expect(pickParts([base], camera, over(109.8, 8), size)).toMatchObject({ kind: 'edge', index: 1 })
    expect(pickParts([base], camera, over(105, 9.8), size)).toMatchObject({ kind: 'edge', index: 2 })
  })

  it('leaves edges alone when asked for faces only', () => {
    expect(pickParts([base], camera, over(104, 0.5), size, { edges: false })).toMatchObject({ kind: 'face', index: 0 })
  })

  it('does not reach an edge through a face in front of it', () => {
    // A larger plate 5 mm nearer the eye covers the first.
    const cover = plate('cover', 30, [90, -5, -10])
    expect(pickParts([base, cover], camera, over(104, 0.5), size)).toMatchObject({ part: 'cover', kind: 'face' })
    // One 0.3 mm in front is within what an edge may lie behind.
    const skin = plate('skin', 30, [90, -0.3, -10])
    expect(pickParts([base, skin], camera, over(104, 0.5), size)).toMatchObject({ part: 'plate', kind: 'edge', index: 0 })
    // The nearer part's own faces are hit as faces.
    expect(pickParts([base, cover], camera, over(104, 3), size)).toMatchObject({ part: 'cover', kind: 'face' })
  })
})

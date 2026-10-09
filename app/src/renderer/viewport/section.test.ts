import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import type { Part } from '../../shared/scene'
import { sectionOf, snappedSection } from '../../shared/view'
import { buildPart } from './partMesh'
import { SectionCut, atOffset, axisOf, capColour, cutOutline, describeSection, keepsNothing, flipped, movedAlongNormal, planeFromFace, planeOnAxis, planeRect, sectionExtent, sectionOffset } from './section'

const BOX = { min: [-20, -15, -2.5], max: [20, 15, 22.5] }

describe('planeFromFace', () => {
  it('lies on the face, and removes what is in front of it', () => {
    expect(planeFromFace({ point: [20, 3, 1], normal: [1, 0, 0] })).toEqual({ origin: [20, 3, 1], normal: [1, 0, 0] })
  })

  it('takes a normal of any length as a direction', () => {
    const plane = planeFromFace({ point: [0, 0, 5], normal: [0, 3, 4] })!
    expect(plane.normal[0]).toBe(0)
    expect(plane.normal[1]).toBeCloseTo(0.6)
    expect(plane.normal[2]).toBeCloseTo(0.8)
  })

  it('is none where there is no normal: an edge, or a normal of no length', () => {
    expect(planeFromFace({ point: [0, 0, 0], normal: null })).toBeNull()
    expect(planeFromFace({ point: [0, 0, 0], normal: [0, 0, 0] })).toBeNull()
  })
})

describe('planeOnAxis', () => {
  it('goes through the middle of the box, its normal along the axis', () => {
    expect(planeOnAxis('x', BOX)).toEqual({ origin: [0, 0, 10], normal: [1, 0, 0] })
    expect(planeOnAxis('y', BOX)).toEqual({ origin: [0, 0, 10], normal: [0, 1, 0] })
    expect(planeOnAxis('z', BOX)).toEqual({ origin: [0, 0, 10], normal: [0, 0, 1] })
  })

  it('goes through the box at a share of its extent along the axis', () => {
    expect(planeOnAxis('z', BOX, 0).origin).toEqual([0, 0, -2.5])
    expect(planeOnAxis('z', BOX, 1).origin).toEqual([0, 0, 22.5])
    expect(planeOnAxis('x', BOX, 0.25).origin).toEqual([-10, 0, 10])
  })
})

describe('moving and flipping', () => {
  it('moves along the normal by millimetres, either way', () => {
    const plane = planeOnAxis('z', BOX)
    expect(movedAlongNormal(plane, 2.5)).toEqual({ origin: [0, 0, 12.5], normal: [0, 0, 1] })
    expect(movedAlongNormal(plane, -0.1).origin[2]).toBeCloseTo(9.9)
    const skew = { origin: [1, 2, 3] as [number, number, number], normal: [0, 0.6, 0.8] as [number, number, number] }
    expect(movedAlongNormal(skew, 5).origin).toEqual([1, 5, 7])
  })

  it('flips to remove the other side, through the same points', () => {
    const plane = { origin: [1, 2, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }
    expect(flipped(plane)).toEqual({ origin: [1, 2, 3], normal: [0, 0, -1] })
    expect(flipped(flipped(plane))).toEqual(plane)
    // No negative zero: it would be written to the scene file as it is.
    expect(Object.is(flipped(plane).normal[0], 0)).toBe(true)
  })
})

describe('the offset the bar shows', () => {
  it('runs across the box along the normal, about its centre', () => {
    expect(sectionExtent(BOX, [1, 0, 0])).toEqual({ min: -20, max: 20 })
    expect(sectionExtent(BOX, [0, 0, -1])).toEqual({ min: -12.5, max: 12.5 })
    // Along a diagonal, from corner to corner.
    const diagonal = sectionExtent({ min: [0, 0, 0], max: [10, 10, 0] }, [Math.SQRT1_2, Math.SQRT1_2, 0])
    expect(diagonal.max).toBeCloseTo(Math.hypot(10, 10) / 2)
    expect(diagonal.min).toBeCloseTo(-Math.hypot(10, 10) / 2)
  })

  it('is the signed distance of the plane from the centre of the box, along the normal', () => {
    expect(sectionOffset(planeOnAxis('z', BOX), BOX)).toBe(0)
    expect(sectionOffset({ origin: [7, 7, 12.5], normal: [0, 0, 1] }, BOX)).toBe(2.5)
    expect(sectionOffset({ origin: [7, 7, 12.5], normal: [0, 0, -1] }, BOX)).toBe(-2.5)
  })

  it('puts the plane at an offset, kept within the box', () => {
    const plane = planeOnAxis('z', BOX)
    expect(sectionOffset(atOffset(plane, BOX, 4), BOX)).toBeCloseTo(4)
    expect(atOffset(plane, BOX, 4).origin).toEqual([0, 0, 14])
    expect(sectionOffset(atOffset(plane, BOX, 400), BOX)).toBe(12.5)
    expect(sectionOffset(atOffset(plane, BOX, -400), BOX)).toBe(-12.5)
    expect(atOffset(plane, BOX, Number.NaN)).toEqual(plane)
  })
})

describe('axisOf', () => {
  it('names the axis a normal is along, and which way', () => {
    expect(axisOf([0, 0, 1])).toEqual({ axis: 'z', sign: 1 })
    expect(axisOf([-1, 0, 0])).toEqual({ axis: 'x', sign: -1 })
    expect(axisOf([0, 0.6, 0.8])).toBeNull()
  })
})

describe('describeSection', () => {
  it('says where an axis plane is and which side is removed', () => {
    expect(describeSection({ origin: [3, 4, 12.5], normal: [0, 0, 1] })).toBe('cut at z = 12.5, +Z side removed')
    expect(describeSection({ origin: [-10.12345, 4, 1], normal: [-1, 0, 0] })).toBe('cut at x = -10.12, -X side removed')
  })

  it('gives a point and the normal of any other plane', () => {
    expect(describeSection({ origin: [1, 2, 3], normal: [0, 0.6, 0.8] })).toBe('cut through (1, 2, 3), side along (0, 0.6, 0.8) removed')
  })
})

describe('planeRect', () => {
  it('is the cross-section of the box for an axis plane, with a margin, centred on the box', () => {
    const rect = planeRect({ origin: [5, 5, 12.5], normal: [0, 0, 1] }, BOX)
    expect(rect.centre).toEqual([0, 0, 12.5])
    expect(Math.abs(rect.u[0]) + Math.abs(rect.u[1])).toBeCloseTo(1)
    expect(rect.u[2]).toBeCloseTo(0)
    // 40 × 30, in whichever order, and a margin on every side.
    const sides = [rect.width, rect.height].sort((a, b) => a - b)
    expect(sides[0]).toBeGreaterThan(30)
    expect(sides[1]).toBeGreaterThan(40)
    expect(sides[1]).toBeLessThan(40 * 1.25)
  })

  it('covers the whole box seen along any normal', () => {
    const normal: [number, number, number] = [0.48, 0.6, 0.64]
    const rect = planeRect({ origin: [0, 0, 10], normal }, BOX)
    const v = [normal[1] * rect.u[2] - normal[2] * rect.u[1], normal[2] * rect.u[0] - normal[0] * rect.u[2], normal[0] * rect.u[1] - normal[1] * rect.u[0]]
    for (const x of [BOX.min[0], BOX.max[0]]) {
      for (const y of [BOX.min[1], BOX.max[1]]) {
        for (const z of [BOX.min[2], BOX.max[2]]) {
          const d = [x - rect.centre[0], y - rect.centre[1], z - rect.centre[2]]
          expect(Math.abs(d[0] * rect.u[0] + d[1] * rect.u[1] + d[2] * rect.u[2])).toBeLessThan(rect.width / 2)
          expect(Math.abs(d[0] * v[0] + d[1] * v[1] + d[2] * v[2])).toBeLessThan(rect.height / 2)
        }
      }
    }
  })
})

describe('sectionOf', () => {
  it('keeps a plane, its normal made a unit vector', () => {
    expect(sectionOf({ origin: [1, 2, 3], normal: [0, 0, 2] })).toEqual({ origin: [1, 2, 3], normal: [0, 0, 1] })
    expect(sectionOf({ origin: [1, 2, 3], normal: [0, 0, -1], more: true })).toEqual({ origin: [1, 2, 3], normal: [0, 0, -1] })
  })

  it('is none for anything that is not a plane', () => {
    for (const not of [null, undefined, 'current', 3, [], {}, { origin: [1, 2, 3] }, { origin: [1, 2], normal: [0, 0, 1] }, { origin: [1, 2, 3], normal: [0, 0, 0] }, { origin: [1, Number.NaN, 3], normal: [0, 0, 1] }, { origin: [1, 2, 3], normal: [0, Infinity, 1] }, { origin: ['1', 2, 3], normal: [0, 0, 1] }]) {
      expect(sectionOf(not)).toBeNull()
    }
  })
})

describe('cutOutline', () => {
  const cube = new THREE.BoxGeometry(10, 10, 10)
  cube.boundsTree = new MeshBVH(cube, { indirect: true })
  const length = (segments: Float32Array, count: number): number => {
    let sum = 0
    for (let i = 0; i < count * 6; i += 6) sum += Math.hypot(segments[i + 3] - segments[i], segments[i + 4] - segments[i + 1], segments[i + 5] - segments[i + 2])
    return sum
  }

  it('is where the plane meets the surface: one segment for every triangle it goes through', () => {
    const { segments, count } = cutOutline(cube, new THREE.Plane(new THREE.Vector3(0, 0, -1), 2))
    expect(count).toBe(8) // two triangles on each of the four sides
    for (let i = 0; i < count * 6; i += 3) expect(segments[i + 2]).toBeCloseTo(2)
    expect(length(segments, count)).toBeCloseTo(40)
  })

  it('is nothing where the plane misses the part, and writes into the array it is given while that is long enough', () => {
    const given = new Float32Array(6 * 2)
    const missed = cutOutline(cube, new THREE.Plane(new THREE.Vector3(0, 0, -1), 20), given)
    expect(missed.count).toBe(0)
    expect(missed.segments).toBe(given)
    // A slanted plane through the middle crosses more triangles than the array holds: a longer one comes back.
    const slanted = cutOutline(cube, new THREE.Plane(new THREE.Vector3(1, 1, 0).normalize(), 0), given)
    expect(slanted.count).toBeGreaterThan(2)
    expect(slanted.segments).not.toBe(given)
    expect(length(slanted.segments, slanted.count)).toBeCloseTo(2 * 10 + 2 * Math.hypot(10, 10))
  })

  it('is none for a part with nothing to look through', () => {
    expect(cutOutline(new THREE.BufferGeometry(), new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)).count).toBe(0)
  })
})

describe('capColour', () => {
  it('is the part\'s colour, a step darker', () => {
    expect(capColour('#C28B6C')).toBe('#ac7a5f')
    expect(capColour('#7B93B4')).toBe('#6c829f')
  })
})

describe('keepsNothing', () => {
  // The post of the bracket: from z = 2.5 to 22.5.
  const POST = { min: [-4, -4, 2.5], max: [4, 4, 22.5] }

  it('says a part the plane only touches is taken away whole, and one it goes through is not', () => {
    expect(keepsNothing(POST, { origin: [0, 0, 2.5], normal: [0, 0, 1] })).toBe(true)
    expect(keepsNothing(POST, { origin: [0, 0, 2.501], normal: [0, 0, 1] })).toBe(true)
    expect(keepsNothing(POST, { origin: [0, 0, 2.6], normal: [0, 0, 1] })).toBe(false)
    expect(keepsNothing(POST, { origin: [0, 0, -5], normal: [0, 0, 1] })).toBe(true)
    // The other side taken away: the post is kept whole, also where it only touches.
    expect(keepsNothing(POST, { origin: [0, 0, 2.5], normal: [0, 0, -1] })).toBe(false)
    expect(keepsNothing(POST, { origin: [0, 0, 22.5], normal: [0, 0, -1] })).toBe(true)
  })

  it('goes by the corner that is furthest into the half kept, whatever the normal', () => {
    const n = Math.SQRT1_2
    expect(keepsNothing({ min: [0, 0, 0], max: [10, 10, 10] }, { origin: [0, 0, 0], normal: [n, n, 0] })).toBe(true)
    expect(keepsNothing({ min: [0, 0, 0], max: [10, 10, 10] }, { origin: [1, 0, 0], normal: [n, n, 0] })).toBe(false)
  })
})

describe('snappedSection', () => {
  it('keeps a plane to the millionth of a millimetre: what adding tenths leaves is not kept', () => {
    expect(snappedSection({ origin: [0.1 + 0.2, 10.149999999999999, 2.7755575615628914e-17], normal: [0, 0, 1] })).toEqual({ origin: [0.3, 10.15, 0], normal: [0, 0, 1] })
    expect(Object.is(snappedSection({ origin: [-1e-9, 0, 0], normal: [1, 0, 0] }).origin[0], 0)).toBe(true)
  })
})

describe('what the bar and the caption show of noise', () => {
  it('is 0, not what is left of adding and taking away', () => {
    const plane = atOffset(atOffset({ origin: [0, 0, 10.15], normal: [0, 0, 1] }, BOX, 1.15), BOX, 0.15)
    expect(describeSection({ origin: [0, 0, 2.7755575615628914e-17], normal: [0, 0, 1] })).toBe('cut at z = 0, +Z side removed')
    expect(sectionOffset(plane, BOX)).toBeCloseTo(0.15, 6)
  })
})

/** A box from `min` to `max` as the kernel would give it: closed, six faces. */
function solid(name: string, min: number[], max: number[]): { part: Part; blob: ArrayBuffer } {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const faces = [
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  ]
  const arrays = {
    vertices: new Float32Array(faces.flat(2)),
    normals: new Float32Array(72),
    triangles: new Uint32Array(faces.flatMap((_, i) => [0, 1, 2, 0, 2, 3].map((c) => i * 4 + c))),
    edges: new Float32Array([x0, y0, z0, x1, y0, z0]),
    trianglesPerFace: new Uint32Array([2, 2, 2, 2, 2, 2]),
    segmentsPerEdge: new Uint32Array([1]),
    faceTypes: new Uint32Array(6),
    edgeTypes: new Uint32Array(1)
  }
  const blob = new ArrayBuffer(Object.values(arrays).reduce((n, a) => n + a.byteLength, 0))
  const mesh: Record<string, { offset: number; length: number }> = {}
  let offset = 0
  for (const [key, a] of Object.entries(arrays)) {
    new Uint8Array(blob).set(new Uint8Array(a.buffer), offset)
    mesh[key] = { offset, length: a.byteLength }
    offset += a.byteLength
  }
  const part = { key: `assembly:${name}`, name, layout: 'assembly', loc: { t: [0, 0, 0], q: [0, 0, 0, 1] }, bbox: { min, max }, volume: 1, faceCount: 6, edgeCount: 1, triangleCount: 12, valid: true, hash: name, mesh } as unknown as Part
  return { part, blob }
}

describe('SectionCut', () => {
  const SCENE = { min: [-20, -15, -2.5], max: [20, 15, 22.5] }
  function bracket() {
    const base = solid('base', [-20, -15, -2.5], [20, 15, 2.5])
    const post = solid('post', [-4, -4, 2.5], [4, 4, 22.5])
    const built = { base: buildPart(base.part, base.blob), post: buildPart(post.part, post.blob) }
    const cut = new SectionCut()
    cut.add(built.base)
    cut.add(built.post)
    return { cut, ...built }
  }
  /** What of a part is drawn besides its own surface and edges: the passes of its cut face. */
  const extras = (built: ReturnType<typeof buildPart>) => built.group.children.filter((child) => child !== built.mesh && child !== built.edges)
  const rim = (built: ReturnType<typeof buildPart>) => extras(built).find((child) => (child as THREE.LineSegments).isLineSegments) as THREE.LineSegments | undefined

  it('draws nothing of a part the plane only touches: no sheet where it rested, and it is not there to be pointed at', () => {
    const { cut, base, post } = bracket()
    cut.set({ origin: [0, 0, 2.5], normal: [0, 0, 1] }, SCENE)
    expect(cut.removed(post)).toBe(true)
    expect([post.mesh.visible, post.edges.visible, ...extras(post).map((o) => o.visible)]).toEqual([false, false, false, false, false, false])
    // The base under it is whole: it has a cut face only in name, for the plane lies on its top.
    expect(cut.removed(base)).toBe(false)
    expect(base.mesh.visible).toBe(true)

    // Flipped, it is the base that is gone and the post that stands whole.
    cut.set({ origin: [0, 0, 2.5], normal: [0, 0, -1] }, SCENE)
    expect([cut.removed(base), cut.removed(post)]).toEqual([true, false])
    expect([base.mesh.visible, post.mesh.visible]).toEqual([false, true])

    // Through the post, and with no section, everything is drawn again.
    cut.set({ origin: [0, 0, 12.5], normal: [0, 0, 1] }, SCENE)
    expect([cut.removed(base), cut.removed(post), post.mesh.visible, post.edges.visible]).toEqual([false, false, true, true])
    cut.set(null, SCENE)
    expect([cut.removed(base), base.mesh.visible, base.edges.visible]).toEqual([false, true, true])
    expect(extras(post).every((o) => !o.visible)).toBe(true)
  })

  it('works out the outline of a cut face when it is about to be drawn, once for a plane, and only of parts that are drawn', () => {
    const { cut, base, post } = bracket()
    cut.set({ origin: [0, 0, 12.5], normal: [0, 0, 1] }, SCENE)
    const drawn = () => rim(post)!.geometry.drawRange.count
    expect(drawn()).toBe(0) // nothing yet: moving the plane costs no outline
    expect(cut.outline()).toBe(1) // the post's; the base is not met by the plane
    expect(drawn()).toBe(16) // eight segments round the post
    expect(cut.outline()).toBe(0)
    cut.set({ origin: [0, 0, 12.5], normal: [0, 0, 1] }, SCENE)
    expect(cut.outline()).toBe(0)
    cut.set({ origin: [0, 0, 14], normal: [0, 0, 1] }, SCENE)
    post.group.visible = false // switched off, or of another layout
    expect(cut.outline()).toBe(0)
    post.group.visible = true
    expect(cut.outline()).toBe(1)
    expect(base.group.children.length).toBeGreaterThan(2)
  })

  it('numbers the passes of the cut faces from the parts there are: the numbers do not grow with the session', () => {
    const { cut, base, post } = bracket()
    cut.set({ origin: [0, 0, 12.5], normal: [0, 0, 1] }, SCENE)
    const orders = () => [...extras(base), ...extras(post)].map((o) => o.renderOrder)
    const first = orders()
    expect(Math.max(...first)).toBeLessThan(0.9)
    expect(new Set(first).size).toBe(6) // back, front and face of each; the outline with its face
    for (let i = 0; i < 50; i++) {
      const again = solid('post', [-4, -4, 2.5], [4, 4, 22.5])
      const built = buildPart(again.part, again.blob)
      cut.add(built)
      cut.set(cut.get(), SCENE)
      cut.forget(built)
    }
    cut.set(cut.get(), SCENE)
    expect(orders()).toEqual(first)
  })

  it('finds the outline of a cut through a hundred thousand triangles in a few milliseconds', () => {
    const ball = new THREE.SphereGeometry(20, 320, 160)
    ball.boundsTree = new MeshBVH(ball, { indirect: true })
    expect(ball.index!.count / 3).toBeGreaterThan(100_000)
    const plane = new THREE.Plane(new THREE.Vector3(0.2, 0.3, -1).normalize(), 3)
    let segments: Float32Array | undefined
    cutOutline(ball, plane) // warmed
    const started = performance.now()
    for (let i = 0; i < 20; i++) segments = cutOutline(ball, plane, segments).segments
    const each = (performance.now() - started) / 20
    console.log(`cutOutline, ${ball.index!.count / 3} triangles: ${each.toFixed(2)} ms`)
    expect(each).toBeLessThan(20)
  })
})

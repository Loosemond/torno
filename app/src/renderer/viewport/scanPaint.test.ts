import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { grid } from '../../test/scanFixtures'
import { PaintedIndex, TriangleSet, gatherBox, gatherSphere, growFlat, tintIndex } from './scanPaint'

function meshOf(made: { vertices: number[]; triangles: number[] }): { geometry: THREE.BufferGeometry; tree: MeshBVH; centroid(t: number): THREE.Vector3 } {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(made.vertices), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(made.triangles), 1))
  const corner = (t: number, k: number): THREE.Vector3 => new THREE.Vector3().fromArray(made.vertices, made.triangles[t * 3 + k] * 3)
  return { geometry, tree: new MeshBVH(geometry, { indirect: true }), centroid: (t) => corner(t, 0).add(corner(t, 1)).add(corner(t, 2)).divideScalar(3) }
}
const UP = new THREE.Vector3(0, 0, 1)

describe('TriangleSet', () => {
  it('keeps its triangles as the bits of a mask', () => {
    const set = new TriangleSet(12)
    expect(set.bits).toHaveLength(2)
    expect([set.add(0), set.add(9), set.add(9)]).toEqual([true, true, false])
    expect([...set.bits]).toEqual([0b00000001, 0b00000010])
    expect([set.count, set.has(9), set.has(3)]).toEqual([2, true, false])
    expect([set.delete(9), set.delete(9), set.count]).toEqual([true, false, 1])
    expect(new TriangleSet(12, new Uint8Array([3, 0])).count).toBe(2)
    set.clear()
    expect(set.count).toBe(0)
  })
})

describe('gathering triangles', () => {
  const sheet = meshOf(grid(30))

  it('takes those whose middle is within the brush, and only those that face the eye', () => {
    const centre = new THREE.Vector3(0.2, 0.3, 0)
    const got: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, UP, (t) => got.push(t))
    const expected = Array.from({ length: 1682 }, (_, t) => t).filter((t) => sheet.centroid(t).distanceTo(centre) <= 1.2)
    expect(got.sort((a, b) => a - b)).toEqual(expected)
    expect(expected.length).toBeGreaterThan(4)
    const fromBelow: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, new THREE.Vector3(0, 0, -1), (t) => fromBelow.push(t))
    expect(fromBelow).toEqual([])
    const either: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, null, (t) => either.push(t))
    expect(either).toHaveLength(expected.length)
  })

  it('takes those inside a box of the screen', () => {
    // Four planes round the column x from 0 to 3, y from -2 to 2, seen from above.
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 3), new THREE.Plane(new THREE.Vector3(0, 1, 0), 2), new THREE.Plane(new THREE.Vector3(0, -1, 0), 2)]
    const got: number[] = []
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, 100), (t) => got.push(t))
    const expected = Array.from({ length: 1682 }, (_, t) => t).filter((t) => {
      const c = sheet.centroid(t)
      return c.x >= 0 && c.x <= 3 && c.y >= -2 && c.y <= 2
    })
    expect(got.sort((a, b) => a - b)).toEqual(expected)
    // Beyond the brief's test: seen from below nothing faces the eye, and all of it faces away.
    const below: number[] = []
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, -100), (t) => below.push(t))
    expect(below).toEqual([])
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, -100), (t) => below.push(t), { away: true })
    expect(below.sort((a, b) => a - b)).toEqual(expected)
    // Fix round 1: "through" takes both sides, and nothing of the half a section has taken away is taken (M4).
    const both: number[] = []
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, -100), (t) => both.push(t), { through: true })
    expect(both.sort((a, b) => a - b)).toEqual(expected)
    // A section that keeps x <= 1.5.
    const keeps = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1.5)
    const kept: number[] = []
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, 100), (t) => kept.push(t), { keeps })
    expect(kept.sort((a, b) => a - b)).toEqual(expected.filter((t) => sheet.centroid(t).x <= 1.5))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(expected.length)
    const brushed: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, new THREE.Vector3(1.5, 0, 0), 2, UP, (t) => brushed.push(t), keeps)
    expect(brushed.length).toBeGreaterThan(0)
    expect(brushed.every((t) => sheet.centroid(t).x <= 1.5)).toBe(true)
  })
})

describe('growFlat', () => {
  it('spreads over what is flat with the set and stops at a step', () => {
    // Flat at 0 up to x = 5, then 10 higher: the cells that climb the step are steep.
    const stepped = meshOf(grid(30, 1, (x) => (x > 5 ? 10 : 0)))
    const set = new TriangleSet(1682)
    gatherSphere(stepped.tree, stepped.geometry, new THREE.Vector3(-10, 0, 0), 1.5, UP, (t) => set.add(t))
    const before = set.count
    const added = growFlat(stepped.tree, stepped.geometry, set, { flat: 2, degrees: 15, reach: 2 })
    expect(added).toBe(set.count - before)
    // The low part is the 20 columns of vertices from -14.5 to 4.5: 19 cells by 29, two triangles each.
    expect(set.count).toBe(19 * 29 * 2)
    for (let t = 0; t < 1682; t++) if (set.has(t)) expect(stepped.centroid(t).z).toBeLessThan(0.01)
  })

  it('adds no more than it is allowed', () => {
    const sheet = meshOf(grid(30))
    const set = new TriangleSet(1682)
    set.add(0)
    expect(growFlat(sheet.tree, sheet.geometry, set, { reach: 2, most: 100 })).toBe(100)
    expect(set.count).toBe(101)
  })
})

describe('tintIndex', () => {
  it('draws the set and nothing else', () => {
    const set = new TriangleSet(4)
    set.add(1)
    set.add(3)
    expect([...tintIndex(set, [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32])]).toEqual([10, 11, 12, 30, 31, 32])
  })
})

// Beyond the brief's tests.
describe('PaintedIndex', () => {
  const index = [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42]
  const drawn = (painted: PaintedIndex): number[][] => Array.from({ length: painted.count }, (_, n) => [...painted.array.subarray(n * 3, n * 3 + 3)]).sort((a, b) => a[0] - b[0])

  it('follows a set a triangle at a time, writing only the slots that changed', () => {
    const set = new TriangleSet(5)
    const painted = new PaintedIndex(index, 5)
    set.watch = painted
    set.add(1)
    set.add(3)
    set.add(4)
    expect(drawn(painted)).toEqual([[10, 11, 12], [30, 31, 32], [40, 41, 42]])
    // Three triangles joined, one after the other: one stretch of nine numbers.
    expect(painted.ranges()).toEqual([[0, 9]])
    expect(painted.ranges()).toEqual([])
    // One leaves from the front: the last takes its slot, and that slot alone is written.
    set.delete(1)
    expect(drawn(painted)).toEqual([[30, 31, 32], [40, 41, 42]])
    expect(painted.ranges()).toEqual([[0, 3]])
    // The last one leaves: nothing is written, there is only less to draw.
    set.delete(3)
    expect(painted.count).toBe(1)
    expect(painted.ranges()).toEqual([])
    set.add(0)
    set.clear()
    expect([painted.count, painted.ranges()]).toEqual([0, []])
    set.add(2)
    expect(drawn(painted)).toEqual([[20, 21, 22]])
  })

  it('draws the same triangles as the set after any run of strokes, and takes up a set that is already painted', () => {
    const big = meshOf(grid(30))
    const of = big.geometry.index!.array
    const set = new TriangleSet(1682)
    const painted = new PaintedIndex(of, 1682)
    set.watch = painted
    let seed = 7
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let stroke = 0; stroke < 60; stroke++) {
      const centre = new THREE.Vector3(next() * 28 - 14, next() * 28 - 14, 0)
      const erase = next() < 0.4
      gatherSphere(big.tree, big.geometry, centre, 1 + next() * 4, null, (t) => (erase ? set.delete(t) : set.add(t)))
      const ranges = painted.ranges()
      expect(ranges.length).toBeLessThanOrEqual(64)
      for (const [start, count] of ranges) expect(start + count).toBeLessThanOrEqual(painted.count * 3)
    }
    expect(painted.count).toBe(set.count)
    expect([...painted.array.subarray(0, painted.count * 3)].join()).not.toBe('')
    const key = (a: ArrayLike<number>, n: number): string => `${a[n * 3]},${a[n * 3 + 1]},${a[n * 3 + 2]}`
    const expected = tintIndex(set, of)
    expect(Array.from({ length: painted.count }, (_, n) => key(painted.array, n)).sort()).toEqual(Array.from({ length: set.count }, (_, n) => key(expected, n)).sort())
    const again = new PaintedIndex(of, 1682)
    again.fill(set)
    expect(again.count).toBe(set.count)
    expect(again.ranges()).toEqual([[0, set.count * 3]])
  })
})

describe('a set', () => {
  it('takes no triangle the mesh does not have, and says each of its own in order', () => {
    const set = new TriangleSet(12)
    expect([set.add(12), set.add(-1), set.add(Number.NaN), set.count]).toEqual([false, false, false, 0])
    set.add(11)
    set.add(2)
    const seen: number[] = []
    set.forEach((t) => seen.push(t))
    expect(seen).toEqual([2, 11])
  })
})

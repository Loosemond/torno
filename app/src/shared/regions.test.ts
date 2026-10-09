import { describe, expect, it } from 'vitest'
import { grid, meshBin } from '../test/scanFixtures'
import { isFlat, maskStem, meshIdentity, popcount, regionInLayout, regionStats } from './regions'
import { parseScanMesh } from './scans'

// A sheet of 5 × 5 vertices 10 mm apart: 32 triangles of 50 mm² each, from -20 to 20.
const mesh = parseScanMesh(meshBin(grid(5, 10)))
const bits = (triangles: number[]): Uint8Array => {
  const made = new Uint8Array(4)
  for (const t of triangles) made[t >> 3] |= 1 << (t & 7)
  return made
}

describe('regionStats', () => {
  it('counts, measures and places a region from the mesh', () => {
    // The first cell of the sheet: triangles 0 and 1, the square from (-20, -20) to (-10, -10).
    const stats = regionStats(mesh, bits([0, 1]))!
    expect(stats.triangles).toBe(2)
    expect(stats.area).toBeCloseTo(100, 9)
    expect(stats.local.centroid.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([-15, -15, 0])
    expect(stats.local.bbox).toEqual({ min: [-20, -20, 0], max: [-10, -10, 0] })
    expect(Math.abs(stats.local.plane.normal[2])).toBeCloseTo(1, 9)
    expect(stats.local.plane.rms).toBeLessThan(1e-6)
    expect(regionStats(mesh, bits([]))).toBeNull()
    expect(popcount(bits([0, 1, 9, 31]))).toBe(4)
  })

  it('gives one triangle the plane it lies in', () => {
    const stats = regionStats(mesh, bits([5]))!
    expect(stats.triangles).toBe(1)
    expect(Math.abs(stats.local.plane.normal[2])).toBeCloseTo(1, 9)
    expect(stats.local.plane.rms).toBe(0)
  })
})

describe('regionInLayout', () => {
  it('puts a region where its scan stands, at the size a fit gave the scan', () => {
    const stats = regionStats(mesh, bits([0, 1]))!
    const there = regionInLayout(stats, { t: [100, 0, 5], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], s: 2 })
    expect(there.area).toBeCloseTo(400, 9)
    // (-15, -15, 0) turned a quarter about Z is (15, -15, 0); doubled and moved.
    expect(there.centroid.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([130, -30, 5])
    expect(there.bbox.min.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([120, -40, 5])
    expect(there.bbox.max.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([140, -20, 5])
    expect(Math.abs(there.plane.normal[2])).toBeCloseTo(1, 9)
  })
})

// Fix round 1 (I4): the region's own box, and what "flat" is judged from.
describe('the principal box of a region', () => {
  /** A strip `long` × `wide` mm of `n` cells along it, lying along a direction of the XY plane turned by `degrees`, lifted by `bump(u)`. */
  const strip = (long: number, wide: number, n: number, degrees: number, bump: (u: number) => number = () => 0) => {
    const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)]
    const vertices: number[] = []
    const triangles: number[] = []
    for (let i = 0; i <= n; i++) {
      for (const v of [-wide / 2, wide / 2]) {
        const u = (i / n - 0.5) * long
        vertices.push(100 + c * u - s * v, 50 + s * u + c * v, 7 + bump(u))
      }
    }
    for (let i = 0; i < n; i++) triangles.push(2 * i, 2 * i + 2, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 1)
    return { mesh: { vertices: new Float32Array(vertices), triangles: new Uint32Array(triangles) }, all: new Uint8Array(Math.ceil((2 * n) / 8)).fill(255) }
  }
  const near = (got: number[], want: number[], digits = 1): void => got.forEach((c, i) => expect(c).toBeCloseTo(want[i], digits))

  it('is the size the region has along its own axes, however it lies in the scan', () => {
    const { mesh, all } = strip(200, 10, 40, 45)
    const stats = regionStats(mesh, all.subarray(0, 10))!
    // The box of the scan's frame says 148 × 148; its own says 200 × 10 × 0.
    expect(stats.local.bbox.max[0] - stats.local.bbox.min[0]).toBeGreaterThan(140)
    near(stats.local.box.half, [100, 5, 0])
    near(stats.local.box.centre, [100, 50, 7])
    // Its long side along the diagonal, whichever way round; its thin one along Z.
    expect(Math.abs(stats.local.box.axes[0][0])).toBeCloseTo(Math.SQRT1_2, 3)
    expect(Math.abs(stats.local.box.axes[0][1])).toBeCloseTo(Math.SQRT1_2, 3)
    expect(Math.abs(stats.local.box.axes[2][2])).toBeCloseTo(1, 6)
    expect(isFlat(stats.local.box)).toBe(true)
    // Turned by an alignment that lays it along X, and doubled: 400 × 20, along X, within a box of 400 × 20.
    const q: [number, number, number, number] = [0, 0, Math.sin(-Math.PI / 8), Math.cos(-Math.PI / 8)]
    const there = regionInLayout(stats, { t: [0, 0, 0], q, s: 2 })
    near(there.box.half, [200, 10, 0])
    expect(Math.abs(there.box.axes[0][0])).toBeCloseTo(1, 3)
    near(there.bbox.max.map((c, axis) => c - there.bbox.min[axis]), [400, 20, 0], 2)
    expect(there.flat).toBe(true)
  })

  it('calls flat what is thin against its lesser side, the same however the scan is turned, and nothing that is not', () => {
    // A strip laid over something round: 180 long, 60 wide, rising 60 in the middle.
    const over = strip(180, 60, 60, 30, (u) => 60 * Math.cos((u / 180) * Math.PI))
    const stats = regionStats(over.mesh, over.all.subarray(0, 15))!
    expect(stats.local.box.half[2]).toBeGreaterThan(20)
    expect(isFlat(stats.local.box)).toBe(false)
    for (const degrees of [0, 30, 77]) {
      const turn = (degrees * Math.PI) / 360
      expect(regionInLayout(stats, { t: [5, 5, 5], q: [Math.sin(turn), 0, 0, Math.cos(turn)], s: 1 }).flat).toBe(false)
    }
    // A wide sheet that waves by a millimetre is flat; a ribbon 2 mm wide that waves as much is not.
    expect(isFlat({ half: [100, 50, 1] })).toBe(true)
    expect(isFlat({ half: [100, 1, 1] })).toBe(false)
    expect(isFlat({ half: [100, 1, 0.1] })).toBe(true)
  })

  it('has a box for one triangle, and for triangles in a line', () => {
    const one = regionStats(mesh, bits([5]))!
    expect(one.local.box.half[2]).toBeCloseTo(0, 9)
    expect(one.local.box.half[0]).toBeGreaterThan(0)
    expect(Math.abs(one.local.box.axes[2][2])).toBeCloseTo(1, 9)
    const two = regionStats(mesh, bits([0, 1]))!
    near(two.local.box.half, [5, 5, 0])
  })
})

describe('what says which mesh a region is of, and which file holds its triangles', () => {
  it('is the source, the counts and how it was read', () => {
    const scan = { source: { sha256: 'ab'.repeat(32) }, imported: { vertices: 400, triangles: 722, unit: 'mm', up: 'z' } }
    expect(meshIdentity(scan as never)).toBe(`${'ab'.repeat(32)}|400|722|mm|z`)
    expect(maskStem({ id: 'M7' })).toBe('M7')
    expect(maskStem({ id: 'M7', mask: 3 })).toBe('M7.3')
  })
})

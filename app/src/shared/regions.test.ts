import { describe, expect, it } from 'vitest'
import { grid, meshBin } from '../test/scanFixtures'
import { popcount, regionInLayout, regionStats } from './regions'
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

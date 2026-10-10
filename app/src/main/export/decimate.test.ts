import { expect, it } from 'vitest'
import { clusterScan } from './decimate'

/** A flat sheet of n × n squares, two triangles each, 1 mm apart. */
function sheet(n: number, colours = false) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3)
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.set([x, y, 0], (y * (n + 1) + x) * 3)
  const triangles: number[] = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x
    triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1)
  }
  return { positions, colours: colours ? new Uint8Array((n + 1) * (n + 1) * 4).fill(200) : null, triangles: new Uint32Array(triangles) }
}

it('leaves a scan that is small enough as it is', () => {
  const small = sheet(10)
  expect(clusterScan(small, 200)).toBe(small)
})

it('cuts a scan to at most what was asked, keeps it where it was, and keeps its colours', () => {
  const cut = clusterScan(sheet(100, true), 2000)                      // 20,000 triangles
  expect(cut.triangles.length / 3).toBeLessThanOrEqual(2000)
  expect(cut.triangles.length / 3).toBeGreaterThan(500)
  expect(cut.colours).toHaveLength((cut.positions.length / 3) * 4)
  expect(cut.colours![0]).toBe(200)
  let [lo, hi] = [Infinity, -Infinity]
  for (let i = 0; i < cut.positions.length; i += 3) [lo, hi] = [Math.min(lo, cut.positions[i]), Math.max(hi, cut.positions[i])]
  expect(lo).toBeLessThan(5)
  expect(hi).toBeGreaterThan(95)
  // No triangle of nothing: its three corners are three vertices.
  for (let i = 0; i < cut.triangles.length; i += 3) expect(new Set(cut.triangles.subarray(i, i + 3)).size).toBe(3)
  expect(Math.max(...cut.triangles)).toBeLessThan(cut.positions.length / 3)
})

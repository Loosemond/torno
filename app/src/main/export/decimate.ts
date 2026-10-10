import type { ScanArrays } from '../../shared/exportdata'

export type { ScanArrays }

// A scan reduced for an exported page, by clustering its vertices on a grid: every vertex of a cell becomes one,
// at their mean, in their mean colour, and a triangle that is left with fewer than three corners is dropped. It
// is coarse on purpose: what leaves the machine of a scan is a likeness of it, enough to see a part against.

/** How many vertices or triangles are worked through between two pauses of `clusterScanInTurns`. */
const TURN = 200_000

/** At most `most` triangles, by clustering vertices on a grid that is coarsened until it is so; a scan already under it is returned as it is. */
export function clusterScan(scan: ScanArrays, most: number): ScanArrays {
  const rounds = clustering(scan, most, Infinity)
  for (;;) {
    const step = rounds.next()
    if (step.done) return step.value
  }
}

/**
 * The same, for a process that has other things to do: after every `turn` vertices or triangles it waits for
 * `pause` (a turn of the event loop), so that reducing a scan of two million triangles holds nothing up for
 * more than a moment.
 */
export async function clusterScanInTurns(scan: ScanArrays, most: number, pause: () => Promise<void> = () => new Promise((done) => setImmediate(done)), turn = TURN): Promise<ScanArrays> {
  const rounds = clustering(scan, most, turn)
  for (;;) {
    const step = rounds.next()
    if (step.done) return step.value
    await pause()
  }
}

function* clustering(scan: ScanArrays, most: number, turn: number): Generator<void, ScanArrays> {
  if (scan.triangles.length / 3 <= most) return scan
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < scan.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], scan.positions[i])
    hi[i % 3] = Math.max(hi[i % 3], scan.positions[i])
  }
  // From a grid of about `most` cells across its surface, coarser by a quarter until it is few enough.
  let cell = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / Math.sqrt(most * 4), 1e-6)
  for (let round = 0; round < 60; round++, cell *= 1.25) {
    const cut = yield* clustered(scan, lo, cell, turn)
    if (cut.triangles.length / 3 <= most) return cut
  }
  throw new Error('the scan could not be reduced')
}

function* clustered(scan: ScanArrays, lo: number[], cell: number, turn: number): Generator<void, ScanArrays> {
  const SIDE = 2 ** 17
  const of = new Map<number, number>()
  const to = new Uint32Array(scan.positions.length / 3)
  const sums: number[] = []
  const tints: number[] = []
  const counts: number[] = []
  for (let v = 0; v < to.length; v++) {
    if (v > 0 && v % turn === 0) yield
    const x = Math.min(Math.floor((scan.positions[v * 3] - lo[0]) / cell), SIDE - 1)
    const y = Math.min(Math.floor((scan.positions[v * 3 + 1] - lo[1]) / cell), SIDE - 1)
    const z = Math.min(Math.floor((scan.positions[v * 3 + 2] - lo[2]) / cell), SIDE - 1)
    const key = x + y * SIDE + z * SIDE * SIDE
    let n = of.get(key)
    if (n === undefined) {
      n = counts.length
      of.set(key, n)
      counts.push(0)
      sums.push(0, 0, 0)
      tints.push(0, 0, 0, 0)
    }
    to[v] = n
    counts[n] += 1
    for (let i = 0; i < 3; i++) sums[n * 3 + i] += scan.positions[v * 3 + i]
    if (scan.colours) for (let i = 0; i < 4; i++) tints[n * 4 + i] += scan.colours[v * 4 + i]
  }
  const positions = new Float32Array(counts.length * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = sums[i] / counts[Math.floor(i / 3)]
  const colours = scan.colours ? new Uint8Array(counts.length * 4) : null
  if (colours) for (let i = 0; i < colours.length; i++) colours[i] = Math.round(tints[i] / counts[Math.floor(i / 4)])
  const triangles: number[] = []
  for (let i = 0; i < scan.triangles.length; i += 3) {
    if (i > 0 && i % (turn * 3) === 0) yield
    const [a, b, c] = [to[scan.triangles[i]], to[scan.triangles[i + 1]], to[scan.triangles[i + 2]]]
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c)
  }
  return { positions, colours, triangles: new Uint32Array(triangles) }
}

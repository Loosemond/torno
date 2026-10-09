import { describe, expect, it } from 'vitest'
import type { ScanInfo } from '../../shared/scans'
import { MeshAsks } from './scanMeshes'

const scan = (meshState: 'ok' | 'missing' = 'ok', at = '2026-10-10T09:00:00.000Z'): ScanInfo =>
  ({ id: 'S1', name: 'S1', source: { path: '', bytes: 0, mtimeMs: 0, sha256: '' }, imported: { unit: 'mm', up: 'z', assumed: { unit: false, up: false }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [0, 0, 0], max: [1, 1, 1] }, area: 6, at }, alignments: {}, sourceState: 'present', meshState, checks: {} }) as ScanInfo

// Final fix wave (F9, and the re-fetch Task 3 deferred).
describe('which meshes the window asks main for', () => {
  it('asks for a mesh once, and again when the scan has another', () => {
    const asks = new MeshAsks()
    expect(asks.due(scan())).toBe(true)
    expect(asks.due(scan())).toBe(false)
    expect(asks.due(scan('ok', '2026-10-11T09:00:00.000Z'))).toBe(true)
  })

  it('asks again for a mesh that went missing and is back unchanged, and not while it is missing', () => {
    const asks = new MeshAsks()
    expect(asks.due(scan())).toBe(true)
    expect(asks.due(scan('missing'))).toBe(false)
    expect(asks.due(scan('missing'))).toBe(false)
    expect(asks.due(scan())).toBe(true)
  })

  it('does not ask again for a fetch that failed until main has told of the scans anew', () => {
    const asks = new MeshAsks()
    expect(asks.due(scan())).toBe(true)
    asks.fail(scan())
    // Every change of the view comes by here.
    for (let i = 0; i < 5; i++) expect(asks.due(scan())).toBe(false)
    asks.told()
    expect(asks.due(scan())).toBe(true)
    asks.fail(scan())
    asks.clear()
    expect(asks.due(scan())).toBe(true)
  })
})

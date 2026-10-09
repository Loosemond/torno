import { describe, expect, it } from 'vitest'
import { box, meshBin } from '../test/scanFixtures'
import { type ScanAlignment, type ScanImport, alignmentOf, alignmentText, doubtOf, importText, maskBits, maskFile, parseScanMesh, staleText } from './scans'

describe('parseScanMesh', () => {
  it('gives views of the vertices, the colours and the triangles of a mesh.bin', () => {
    const colours = Array.from({ length: 8 }, (_, n) => [n, 2 * n, 3 * n, 255]).flat()
    const mesh = parseScanMesh(meshBin(box([40, 30, 5]), colours))
    expect(mesh.vertices).toHaveLength(24)
    expect([...mesh.vertices.slice(0, 3)]).toEqual([-20, -15, -2.5])
    expect([...mesh.colours!.slice(4, 8)]).toEqual([1, 2, 3, 255])
    expect([...mesh.triangles.slice(0, 3)]).toEqual([0, 1, 3])
    expect(mesh.bbox).toEqual({ min: [-20, -15, -2.5], max: [20, 15, 2.5] })
    expect(parseScanMesh(meshBin(box())).colours).toBeNull()
  })

  it('says what is wrong with bytes that are no mesh.bin', () => {
    const good = meshBin(box())
    expect(() => parseScanMesh(good.slice(0, 40))).toThrow(/not a scan torno wrote/)
    expect(() => parseScanMesh(good.slice(0, good.byteLength - 4))).toThrow(/has 300 bytes, and its header says 304/)
    const other = good.slice(0)
    new DataView(other).setUint32(8, 2, true)
    expect(() => parseScanMesh(other)).toThrow(/version 2/)
    const wild = good.slice(0)
    new Uint32Array(wild, 64 + 96, 1)[0] = 8
    expect(() => parseScanMesh(wild)).toThrow(/a triangle names vertex 8, and there are 8/)
  })
})

describe('a mask', () => {
  it('is one bit a triangle behind a header that says how many', () => {
    const bits = new Uint8Array([0b00000001, 0b00000010])
    const file = maskFile(bits, 12)
    expect(new TextDecoder().decode(file.slice(0, 8))).toBe('TORNOMSK')
    expect(new DataView(file.buffer).getUint32(12, true)).toBe(12)
    expect([...maskBits(file, 12)]).toEqual([1, 2])
    expect(() => maskBits(file, 13)).toThrow(/12 triangles, not 13/)
    expect(() => maskFile(new Uint8Array(3), 12)).toThrow(/2 bytes/)
  })
})

describe('what is said of a scan', () => {
  const imported: ScanImport = { unit: 'm', up: 'y', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-1258.9, -1175.3, 0], max: [1258.9, 1175.3, 1493.6] }, area: 1, at: '' }
  const aligned: ScanAlignment = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['floor'], rms: 0.8, frame: {}, at: '' }

  it('gives its size in millimetres and what was assumed', () => {
    expect(importText(imported)).toBe('2518 × 2351 × 1494 mm, from m, Y up (assumed)')
    expect(importText({ ...imported, assumed: { unit: false, up: true } })).toBe('2518 × 2351 × 1494 mm, from m, Y up (up assumed)')
    expect(importText({ ...imported, assumed: { unit: false, up: false }, reduced: { from: 5_000_000, cell: 2.4 } })).toBe('2518 × 2351 × 1494 mm, from m, Y up, reduced from 5,000,000 triangles')
  })

  it('says how it was aligned, and when a floor is all there is', () => {
    expect(alignmentText(aligned)).toBe('by floor only (plane rms 0.8 mm): its place in that plane is as imported')
    const pairs = [1.8, 3.4, 0.9, 1.2].map((residual) => ({ scan: [0, 0, 0] as [number, number, number], model: [0, 0, 0] as [number, number, number], residual }))
    expect(alignmentText({ ...aligned, steps: ['floor', 'pairs'], pairs, rms: 2.1 })).toBe('by floor + 4 pairs (rms 2.1 mm, worst 3.4 mm)')
    expect(alignmentText({ ...aligned, steps: ['pairs', 'nudge'], pairs, rms: 2.1, scaled: true })).toBe('by 4 pairs (rms 2.1 mm, worst 3.4 mm), scaled + nudge')
    expect(alignmentText({ ...aligned, steps: ['typed'], rms: undefined })).toBe('by typed values')
  })

  // Task 5: what a fit leaves is said to the thousandth of a millimetre, never with the digits of rounding error.
  it('says how well it fits no finer than a fit is known', () => {
    const pairs = [0.000005728, 0.0000024].map((residual) => ({ scan: [0, 0, 0] as [number, number, number], model: [0, 0, 0] as [number, number, number], residual }))
    expect(alignmentText({ ...aligned, steps: ['pairs'], pairs, rms: 0.000004247 })).toBe('by 2 pairs (rms 0 mm, worst 0 mm)')
    expect(alignmentText({ ...aligned, steps: ['pairs'], pairs: [{ ...pairs[0], residual: 0.0126 }], rms: 0.0126 })).toBe('by 1 pair (rms 0.013 mm, worst 0.013 mm)')
  })

  it('says a scan read again from a changed source with what the last build found, as one reason to look', () => {
    expect(staleText(undefined, { sourceChanged: true })).toBe('the scan was imported again from a source that had changed since it was aligned: check the alignment')
    expect(staleText({ revision: 4, of: 0, off: 0, worst: 0, moved: ['lid'] }, { sourceChanged: true })).toBe('the scan was imported again from a source that had changed since it was aligned, and torno has moved lid for display since it was aligned: check the alignment')
    expect(staleText(undefined, {})).toBeNull()
    const scan = { alignments: { print: { ...aligned, sourceChanged: true as const } }, checks: {} }
    expect(doubtOf(scan, 'print')).toBe('the scan was imported again from a source that had changed since it was aligned: check the alignment')
    expect(doubtOf(scan, 'assembly')).toBeNull()
  })

  it('says when the model has moved under an alignment', () => {
    expect(staleText(undefined)).toBeNull()
    expect(staleText({ revision: 4, of: 4, off: 0, worst: 0.1, moved: [] })).toBeNull()
    expect(staleText({ revision: 4, of: 4, off: 2, worst: 6.2, moved: [] })).toBe('the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r4: check the alignment')
    expect(staleText({ revision: 4, of: 0, off: 0, worst: 0, moved: ['lid'] })).toBe('torno has moved lid for display since it was aligned: check the alignment')
  })
})

// Beyond the brief's tests.
describe('and besides', () => {
  const aligned: ScanAlignment = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['floor', 'nudge'], frame: {}, at: '' }

  it('a scan is aligned only in the layouts it has a transform for, whatever they are named', () => {
    expect(alignmentOf({ alignments: { print: aligned } }, 'print')).toBe(aligned)
    expect(alignmentOf({ alignments: { print: aligned } }, 'assembly')).toBeNull()
    expect(alignmentOf({ alignments: {} }, 'toString')).toBeNull()
  })

  it('says both ways an alignment went stale, and every step of one', () => {
    expect(staleText({ revision: 7, of: 3, off: 1, worst: 12.345, moved: ['lid', 'tray'] })).toBe(
      'torno has moved lid, tray for display since it was aligned, and the model is no longer under 1 of its 3 points (worst 12.35 mm off) on r7: check the alignment'
    )
    expect(alignmentText(aligned)).toBe('by floor + nudge')
    expect(alignmentText({ ...aligned, steps: ['floor'] })).toBe('by floor only: its place in that plane is as imported')
  })

  it('reads no region from bytes that are none', () => {
    expect(() => maskBits(new Uint8Array(18), 12)).toThrow(/18 bytes is not a region torno wrote/)
    const cut = maskFile(new Uint8Array(2), 12).slice(0, 17)
    expect(() => maskBits(cut, 12)).toThrow(/has 17 bytes, and its header says 18/)
    // A view into a larger buffer is read where it is.
    const within = new Uint8Array(40)
    within.set(maskFile(new Uint8Array([3, 4]), 12), 8)
    expect([...maskBits(within.subarray(8, 26), 12)]).toEqual([3, 4])
  })
})


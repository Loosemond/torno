import { describe, expect, it } from 'vitest'
import { type Mark, isUnchecked, markAnchors, strokeSamples, translated } from './marks'
import { bufView } from './scene'

function blobOf(floats: number[]): ArrayBuffer {
  return new Float32Array(floats).buffer
}

describe('bufView', () => {
  it('returns a typed view of the right length over the blob', () => {
    const blob = blobOf([1, 2, 3, 4, 5, 6])
    const view = bufView(blob, { offset: 8, length: 12 }, Float32Array)
    expect(view).toBeInstanceOf(Float32Array)
    expect(view.length).toBe(3)
    expect(Array.from(view)).toEqual([3, 4, 5])
  })

  it('views the blob without copying it', () => {
    const blob = blobOf([1, 2])
    const view = bufView(blob, { offset: 4, length: 4 }, Float32Array)
    expect(view.buffer).toBe(blob)
    new Float32Array(blob)[1] = 9
    expect(view[0]).toBe(9)
  })

  it('reads uint32 buffers', () => {
    const blob = new Uint32Array([7, 8, 9]).buffer
    const view = bufView(blob, { offset: 4, length: 8 }, Uint32Array)
    expect(view).toBeInstanceOf(Uint32Array)
    expect(Array.from(view)).toEqual([8, 9])
  })

  it('returns an empty view for a zero-length buffer, even at the end of the blob', () => {
    const blob = blobOf([1, 2])
    expect(bufView(blob, { offset: 8, length: 0 }, Float32Array).length).toBe(0)
  })

  it('throws on a misaligned offset', () => {
    const blob = blobOf([1, 2, 3])
    expect(() => bufView(blob, { offset: 2, length: 4 }, Float32Array)).toThrow(/offset 2 is not a multiple of 4/)
  })

  it('throws on a range past the end of the blob', () => {
    const blob = blobOf([1, 2, 3])
    expect(() => bufView(blob, { offset: 8, length: 8 }, Float32Array)).toThrow(/past the end/)
  })

  it('throws on a length that is not a whole number of elements', () => {
    const blob = blobOf([1, 2, 3])
    expect(() => bufView(blob, { offset: 0, length: 6 }, Float32Array)).toThrow(/length 6/)
  })

  it('throws on a negative offset or length', () => {
    const blob = blobOf([1, 2, 3])
    expect(() => bufView(blob, { offset: -4, length: 4 }, Float32Array)).toThrow(RangeError)
    expect(() => bufView(blob, { offset: 0, length: -4 }, Float32Array)).toThrow(RangeError)
  })
})

describe('strokeSamples', () => {
  const stroke = (count: number, space: 'surface' | 'plane' = 'surface') =>
    ({ kind: 'stroke', space, anchor: { point: [0, 0, 0] }, points: Array.from({ length: count }, (_, i) => [i, 0, 0]) }) as unknown as Mark

  it('gives every point after the first of a short stroke', () => {
    expect(strokeSamples(stroke(4))).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]])
    expect(strokeSamples(stroke(1))).toEqual([])
  })

  it('gives eight of a long one, evenly spaced, the last among them', () => {
    const samples = strokeSamples(stroke(401))
    expect(samples.map((p) => p[0])).toEqual([50, 100, 150, 200, 250, 300, 350, 400])
    expect(strokeSamples(stroke(10)).map((p) => p[0])).toEqual([1, 2, 3, 5, 6, 7, 8, 9])
  })

  it('gives none of a profile on a plane, or of a mark that is no stroke', () => {
    expect(strokeSamples(stroke(20, 'plane'))).toEqual([])
    expect(strokeSamples({ kind: 'pin', anchor: { point: [0, 0, 0] } } as unknown as Mark)).toEqual([])
  })
})

describe('a region mark', () => {
  const region = { id: 'M7', kind: 'region', scan: 'S1', author: 'user', note: 'loom', status: 'sent', anchorState: 'ok', layout: 'print', revision: 12, camera: {}, createdAt: '', triangles: 2, area: 100, local: { centroid: [0, 0, 0], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], rms: 0 } } } as unknown as Mark

  it('is tied to no part and to no build: it has no anchors, is never moved with a part, and is never unchecked', () => {
    expect(markAnchors(region)).toEqual([])
    expect(translated(region, [1, 2, 3])).toBe(region)
    expect(isUnchecked(region, 12)).toBe(false)
    expect(isUnchecked({ ...region, status: 'draft' } as Mark, 13)).toBe(false)
  })
})

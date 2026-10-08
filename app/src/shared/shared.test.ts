import { describe, expect, it } from 'vitest'
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

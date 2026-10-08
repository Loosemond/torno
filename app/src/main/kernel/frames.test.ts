import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, toArrayBuffer } from './frames'

describe('frames', () => {
  it('lays a frame out as two big-endian lengths, the JSON header and the blob', () => {
    const frame = encodeFrame({ a: 1 }, new Uint8Array([9, 8, 7]))
    expect(frame.readUInt32BE(0)).toBe(7)
    expect(frame.readUInt32BE(4)).toBe(3)
    expect(frame.toString('utf8', 8, 15)).toBe('{"a":1}')
    expect([...frame.subarray(15)]).toEqual([9, 8, 7])
  })

  it('round-trips a header and a blob', () => {
    const header = { id: 3, op: 'build', dir: '/tmp/peça' }
    const blob = new Uint8Array([1, 2, 3, 4, 5])
    const frames = new FrameDecoder().push(encodeFrame(header, blob))
    expect(frames).toHaveLength(1)
    expect(frames[0].header).toEqual(header)
    expect([...frames[0].blob]).toEqual([1, 2, 3, 4, 5])
  })

  it('reassembles a frame split across three chunks', () => {
    const frame = encodeFrame({ id: 1, ok: true }, new Uint8Array(100).fill(7))
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 5))).toEqual([])
    expect(decoder.push(frame.subarray(5, 40))).toEqual([])
    const frames = decoder.push(frame.subarray(40))
    expect(frames).toHaveLength(1)
    expect(frames[0].header).toEqual({ id: 1, ok: true })
    expect(frames[0].blob.length).toBe(100)
    expect(frames[0].blob.every((b) => b === 7)).toBe(true)
  })

  it('decodes two frames that arrive in one chunk', () => {
    const chunk = Buffer.concat([encodeFrame({ n: 1 }, new Uint8Array([1])), encodeFrame({ n: 2 })])
    const frames = new FrameDecoder().push(chunk)
    expect(frames.map((f) => f.header)).toEqual([{ n: 1 }, { n: 2 }])
    expect(frames.map((f) => f.blob.length)).toEqual([1, 0])
  })

  it('keeps the start of the next frame for the following chunk', () => {
    const a = encodeFrame({ n: 1 })
    const b = encodeFrame({ n: 2 }, new Uint8Array([4, 5]))
    const decoder = new FrameDecoder()
    const first = decoder.push(Buffer.concat([a, b.subarray(0, 3)]))
    expect(first.map((f) => f.header)).toEqual([{ n: 1 }])
    const second = decoder.push(b.subarray(3))
    expect(second.map((f) => f.header)).toEqual([{ n: 2 }])
    expect([...second[0].blob]).toEqual([4, 5])
  })

  it('handles a zero-length blob, given or omitted', () => {
    const decoder = new FrameDecoder()
    for (const frame of [encodeFrame({ e: 'x' }), encodeFrame({ e: 'x' }, new Uint8Array(0))]) {
      expect(frame.readUInt32BE(4)).toBe(0)
      const [decoded] = decoder.push(frame)
      expect(decoded.header).toEqual({ e: 'x' })
      expect(decoded.blob.length).toBe(0)
    }
  })

  it('gives a header that is not JSON as null and carries on', () => {
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]), Buffer.from('{x')])
    const frames = new FrameDecoder().push(Buffer.concat([bad, encodeFrame({ n: 2 })]))
    expect(frames.map((f) => f.header)).toEqual([null, { n: 2 }])
  })

  it('copies a blob into an ArrayBuffer of its own', () => {
    const [frame] = new FrameDecoder().push(encodeFrame({}, new Uint8Array(new Float32Array([1.5, 2.5]).buffer)))
    const copy = toArrayBuffer(frame.blob)
    expect(copy.byteLength).toBe(8)
    expect([...new Float32Array(copy)]).toEqual([1.5, 2.5])
    frame.blob[0] = 255
    expect(new Float32Array(copy)[0]).toBe(1.5)
  })
})

import { describe, expect, it } from 'vitest'
import { checkedPicture } from './picture'

function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('checkedPicture', () => {
  it('reads the size of a PNG from its header', () => {
    expect(checkedPicture(png(4000, 3000))).toEqual({ width: 4000, height: 3000 })
  })
  it('takes a picture larger than the agent may be given, up to 4000 px', () => {
    expect(checkedPicture(png(3000, 2250))).not.toBeNull()
    expect(checkedPicture(png(4001, 100))).toBeNull()
    expect(checkedPicture(png(100, 4001))).toBeNull()
  })
  it('refuses what is no PNG, has no size, or is too big', () => {
    expect(checkedPicture(png(0, 10))).toBeNull()
    expect(checkedPicture(new Uint8Array(40))).toBeNull()
    expect(checkedPicture('x'.repeat(40))).toBeNull()
    expect(checkedPicture(png(10, 10, 64_000_000))).toBeNull()
  })
})

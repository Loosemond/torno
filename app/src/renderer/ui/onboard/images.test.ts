import { describe, expect, it } from 'vitest'
import { PROMPT_EDGE, extensionOf, fitWithin, imageType } from './images'
import { ERASER_WIDTH, addPoint } from './strokes'

describe('the pictures of the first prompt', () => {
  it('scales the long edge to 1280, keeps the shape, and never makes a picture larger', () => {
    expect(PROMPT_EDGE).toBe(1280)
    expect(fitWithin(3000, 2000)).toEqual({ width: 1280, height: 853 })
    expect(fitWithin(2000, 3000)).toEqual({ width: 853, height: 1280 })
    expect(fitWithin(1280, 700)).toEqual({ width: 1280, height: 700 })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(10000, 1)).toEqual({ width: 1280, height: 1 })
  })

  it('knows a PNG, a JPEG and a WebP by their first bytes, and nothing else', () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png')
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(imageType(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageType(new Uint8Array([]))).toBeNull()
  })

  it('names the copy in reference/ by the extension of the file, in lower case', () => {
    expect(extensionOf('/home/me/IMG_1.JPG')).toBe('.jpg')
    expect(extensionOf('C:\\pics\\two.webp')).toBe('.webp')
    expect(extensionOf('/a/b/noext')).toBe('')
  })
})

describe('the strokes of the board', () => {
  it('leaves out a point that is on the last one, and rounds the rest to a tenth', () => {
    const stroke = { tool: 'pen' as const, width: 3, points: [] as Array<[number, number]> }
    expect(addPoint(stroke, 10.04, 20.06)).toBe(true)
    expect(addPoint(stroke, 10.5, 20.5)).toBe(false)
    expect(addPoint(stroke, 30, 20)).toBe(true)
    expect(stroke.points).toEqual([[10, 20.1], [30, 20]])
    expect(ERASER_WIDTH).toBeGreaterThan(9)
  })
})

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

// A PNG read back by hand, as `pngFixtures.ts` writes one: 8-bit RGBA, not interlaced (what resvg writes), its
// rows unfiltered by the five filters of the format. No library is needed for it.

export interface ReadPng {
  width: number
  height: number
  /** The pixel at x, y: red, green, blue and alpha, 0 to 255. */
  rgba: (x: number, y: number) => [number, number, number, number]
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function readPng(path: string): ReadPng {
  const file = readFileSync(path)
  if (!file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`${path} is not a PNG`)
  let width = 0
  let height = 0
  const data: Buffer[] = []
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    const body = file.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error(`${path} is not 8-bit RGBA without interlacing`)
    } else if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4] : 0
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0
      const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4] : 0
      const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c)
      pixels[y * stride + i] = (line[i] + predicted) & 0xff
    }
  }
  return {
    width,
    height,
    rgba: (x, y) => {
      const at = (y * width + x) * 4
      return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
    }
  }
}

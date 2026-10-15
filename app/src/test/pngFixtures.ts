import { deflateSync } from 'node:zlib'

// A real PNG for a test to write to a temporary folder: a gradient of the colour given, of any size. Built by hand
// (signature, IHDR, one IDAT of filtered rows, IEND) so that no library is needed and a browser decodes it.

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** A `width` x `height` RGB PNG whose red runs across and whose green runs down, with the blue given. */
export function png(width: number, height: number, blue = 120): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 3 + 1)
    rows[at] = 0
    for (let x = 0; x < width; x += 1) {
      rows[at + 1 + x * 3] = Math.floor((x / width) * 255)
      rows[at + 2 + x * 3] = Math.floor((y / height) * 255)
      rows[at + 3 + x * 3] = blue
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

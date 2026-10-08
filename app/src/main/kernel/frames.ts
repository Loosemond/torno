// The kernel's wire format, the same in both directions:
//   u32 BE headerLen | u32 BE blobLen | header (UTF-8 JSON) | blob

const PREFIX = 8

export function encodeFrame(header: object, blob?: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(PREFIX)
  prefix.writeUInt32BE(json.length, 0)
  prefix.writeUInt32BE(blob?.length ?? 0, 4)
  return blob?.length ? Buffer.concat([prefix, json, blob]) : Buffer.concat([prefix, json])
}

/** Reassembles frames from whatever chunks a pipe delivers. */
export class FrameDecoder {
  // Chunks are joined once per frame, not once per chunk: a scene blob of some
  // megabytes arrives in 64 KiB pieces.
  private chunks: Buffer[] = []
  private size = 0
  private frameLength: number | null = null // of the frame at the front, once its prefix is in

  /** Add a chunk and return every frame it completes. A header that is not JSON comes back as null. */
  push(chunk: Buffer): Array<{ header: any; blob: Buffer }> {
    this.chunks.push(chunk)
    this.size += chunk.length
    const frames: Array<{ header: any; blob: Buffer }> = []
    for (;;) {
      if (this.frameLength === null) {
        if (this.size < PREFIX) break
        const front = this.joined()
        this.frameLength = PREFIX + front.readUInt32BE(0) + front.readUInt32BE(4)
      }
      if (this.size < this.frameLength) break
      const data = this.joined()
      const blobStart = PREFIX + data.readUInt32BE(0)
      let header: any = null
      try {
        header = JSON.parse(data.toString('utf8', PREFIX, blobStart))
      } catch {
        // The framing is intact, so the frames after this one are still good.
      }
      frames.push({ header, blob: data.subarray(blobStart, this.frameLength) })
      const rest = data.subarray(this.frameLength)
      this.chunks = rest.length ? [rest] : []
      this.size = rest.length
      this.frameLength = null
    }
    return frames
  }

  private joined(): Buffer {
    if (this.chunks.length !== 1) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]
  }
}

/**
 * A copy of a blob in an ArrayBuffer of its own. A decoded blob is a view into
 * a larger buffer at an arbitrary offset; typed arrays and IPC need it alone.
 */
export function toArrayBuffer(blob: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(blob.byteLength)
  new Uint8Array(copy).set(blob)
  return copy
}

// The pictures a new object is made from, as the first prompt takes them. Main attaches only a PNG or a JPEG of at
// most 2000 px and 5 MB (`main/onboard.ts`); the window decodes (a WebP too) and hands over each picture scaled
// to a long edge of 1280 px. The file a photo comes from stays the person's original: main copies that.

/** The long edge of a picture in the prompt. */
export const PROMPT_EDGE = 1280
/** What main attaches at most, in bytes. */
export const MOST_ATTACHED = 5 * 1024 * 1024
const JPEG_QUALITY = 0.85

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'

/** What the bytes are, by their signature; null for anything else. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const is = (at: number, ...values: number[]): boolean => values.every((v, i) => bytes[at + i] === v)
  if (is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (is(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/** The size a picture is drawn at: its long edge at most `edge`, its shape kept, never larger than it is. */
export function fitWithin(width: number, height: number, edge = PROMPT_EDGE): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= edge) return { width, height }
  const scale = edge / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface Prepared {
  image: Uint8Array
  type: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** The original's size, for the line under the thumbnail. */
  from: { width: number; height: number }
}

/** The extension a photo is copied under into `reference/`: the file's own, in lower case (as main names it). */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * The picture for the prompt: scaled to a long edge of 1280 px, a PNG as a PNG and anything else as a JPEG. A PNG
 * or a JPEG already within the size, and small enough, is handed over as it is. Rejects with a sentence for bytes
 * that are no picture the window can read.
 */
export async function prepareImage(bytes: Uint8Array, name: string): Promise<Prepared> {
  const type = imageType(bytes)
  if (type === null) throw new Error(`${name} is not a PNG, JPEG or WebP picture.`)
  let bitmap: ImageBitmap
  try {
    // The camera's turn (EXIF) is applied: the picture is as it looks.
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }), { imageOrientation: 'from-image' })
  } catch {
    throw new Error(`${name} could not be read as a picture.`)
  }
  try {
    const from = { width: bitmap.width, height: bitmap.height }
    const fit = fitWithin(from.width, from.height)
    const asIs = (type === 'image/png' || type === 'image/jpeg') && fit.width === from.width && fit.height === from.height && bytes.length <= MOST_ATTACHED
    if (asIs) return { image: bytes, type, ...fit, from }
    const canvas = new OffscreenCanvas(fit.width, fit.height)
    const ctx = canvas.getContext('2d')!
    // A JPEG has no transparency: what had none shows white.
    const png = type === 'image/png'
    if (!png) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, fit.width, fit.height)
    }
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height)
    let out = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY })
    let outType: Prepared['type'] = png ? 'image/png' : 'image/jpeg'
    if (out.size > MOST_ATTACHED) {
      // A PNG too heavy for a prompt is sent as a JPEG.
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, fit.width, fit.height)
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
      outType = 'image/jpeg'
    }
    return { image: new Uint8Array(await out.arrayBuffer()), type: outType, ...fit, from }
  } finally {
    bitmap.close()
  }
}

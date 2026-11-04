import { MAX_PICTURE_BYTES, MAX_PICTURE_EDGE } from '../../shared/exportdata'

// A picture of the view the person saves ("Save picture" in the window): the window draws it, main writes it (through
// the save dialog and `writeExport`, like any export), and so main reads what it was given before it writes a file.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = [0x49, 0x48, 0x44, 0x52]

/**
 * The size of a PNG, read from its own header, when `bytes` is one of at most `MAX_PICTURE_BYTES` whose long edge
 * is at most `MAX_PICTURE_EDGE` (4000 px; the agent's pictures stop at 2000, a picture the person keeps need not).
 * Null for anything else. Nothing is decoded.
 */
export function checkedPicture(bytes: unknown): { width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > MAX_PICTURE_BYTES) return null
  if (!PNG.every((b, i) => bytes[i] === b) || !IHDR.every((b, i) => bytes[12 + i] === b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 && Math.max(width, height) <= MAX_PICTURE_EDGE ? { width, height } : null
}

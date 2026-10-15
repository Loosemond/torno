import type { Stroke } from '../../state/onboard'

// The doodle board draws strokes; the strokes are what the draft keeps, and a picture is made from them.

/** The board's own pixels: a doodle is always this size, whatever room the board has on screen. */
export const BOARD = { width: 1200, height: 800 } as const
/** The pen's two widths and the eraser's, in board pixels. */
export const PEN_WIDTHS = { thin: 3, thick: 9 } as const
export const ERASER_WIDTH = 28
/** The ink of a doodle sent to the agent: dark on white, whichever theme the person draws it in. */
export const PNG_INK = '#1a1a1a'
export const PNG_GROUND = '#ffffff'

/** A pointer closer than this to the last point of a stroke (board pixels) adds nothing. */
const MIN_STEP = 1.5

/** Adds a point to a stroke unless it is on the last one. Returns whether it was added. */
export function addPoint(stroke: Stroke, x: number, y: number): boolean {
  const last = stroke.points.at(-1)
  if (last && Math.hypot(x - last[0], y - last[1]) < MIN_STEP) return false
  stroke.points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])
  return true
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Draws one stroke (or the rest of one, from point `from`): a pen in `ink`, the eraser by taking away what is under it. */
export function paintStroke(ctx: Ctx, stroke: Stroke, ink: string, from = 0): void {
  const points = stroke.points
  if (points.length === 0 || from >= points.length) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = stroke.width
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over'
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0][0], points[0][1], stroke.width / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    const start = Math.max(0, from - 1)
    ctx.moveTo(points[start][0], points[start][1])
    for (let i = start + 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1])
    ctx.stroke()
  }
  ctx.restore()
}

/** All the strokes on a clear canvas, in order. */
export function paintStrokes(ctx: Ctx, strokes: readonly Stroke[], ink: string): void {
  ctx.clearRect(0, 0, BOARD.width, BOARD.height)
  for (const stroke of strokes) paintStroke(ctx, stroke, ink)
}

/** The PNG of a doodle: the strokes in dark ink on a white ground, 1200 x 800. */
export async function doodlePng(strokes: readonly Stroke[]): Promise<Uint8Array> {
  const layer = new OffscreenCanvas(BOARD.width, BOARD.height)
  paintStrokes(layer.getContext('2d')!, strokes, PNG_INK)
  const sheet = new OffscreenCanvas(BOARD.width, BOARD.height)
  const ctx = sheet.getContext('2d')!
  ctx.fillStyle = PNG_GROUND
  ctx.fillRect(0, 0, BOARD.width, BOARD.height)
  ctx.drawImage(layer, 0, 0)
  const blob = await sheet.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

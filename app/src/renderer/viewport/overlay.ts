import { scaleBarLength } from './views'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type Vec3 = readonly [number, number, number]

export interface OverlayOptions {
  width: number
  height: number
  /** World directions that point right and up on screen (unit, perpendicular). */
  right: Vec3
  up: Vec3
  /** Millimetres per pixel in an orthographic picture; null in perspective, where no single scale holds. */
  mmPerPx: number | null
  /** Text colour, a quieter one for notes, and the background the picture was drawn on. */
  ink: string
  muted: string
  surface: string
}

export const PERSPECTIVE_NOTE = 'perspective, no scale bar'

const MONO = "'IBM Plex Mono', ui-monospace, monospace"
const SANS = "'IBM Plex Sans', system-ui, sans-serif"
const AXES: { letter: string; axis: Vec3; color: string }[] = [
  { letter: 'X', axis: [1, 0, 0], color: '#D2452F' },
  { letter: 'Y', axis: [0, 1, 0], color: '#2F9460' },
  { letter: 'Z', axis: [0, 0, 1], color: '#2F5FD0' }
]

/**
 * Draws what a still picture needs to be read without the app around it: an
 * axis triad bottom left, and bottom right a scale bar in mm (orthographic) or a
 * note that there is none (perspective).
 */
export function drawOverlay(ctx: Ctx, o: OverlayOptions): void {
  // Sizes are in units of a 1280-pixel-wide picture, so the overlay keeps its proportions.
  const unit = Math.max(Math.max(o.width, o.height) / 1280, 0.5)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  drawTriad(ctx, o, unit)
  if (o.mmPerPx !== null && o.mmPerPx > 0) drawScaleBar(ctx, o, o.mmPerPx, unit)
  else drawNote(ctx, o, unit)
  ctx.restore()
}

function drawTriad(ctx: Ctx, o: OverlayOptions, unit: number): void {
  const length = 38 * unit
  const pad = 26 * unit
  const cx = pad + length
  const cy = o.height - pad - length
  // right × up points at the viewer.
  const toViewer: Vec3 = [
    o.right[1] * o.up[2] - o.right[2] * o.up[1],
    o.right[2] * o.up[0] - o.right[0] * o.up[2],
    o.right[0] * o.up[1] - o.right[1] * o.up[0]
  ]
  const arms = AXES.map((a) => ({
    ...a,
    x: dot(a.axis, o.right),
    y: -dot(a.axis, o.up),
    depth: dot(a.axis, toViewer)
  })).sort((a, b) => a.depth - b.depth) // far ones first, so near ones are drawn over them

  ctx.font = `600 ${Math.round(13 * unit)}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const arm of arms) {
    const flat = Math.hypot(arm.x, arm.y)
    const tipX = cx + arm.x * length
    const tipY = cy + arm.y * length
    ctx.strokeStyle = arm.color
    ctx.fillStyle = arm.color
    ctx.lineWidth = 2 * unit
    let labelX: number
    let labelY: number
    if (flat < 0.15) {
      // The axis runs along the view: a dot, with its letter beside it.
      ctx.beginPath()
      ctx.arc(cx, cy, 3.5 * unit, 0, Math.PI * 2)
      ctx.fill()
      labelX = cx - 11 * unit
      labelY = cy + 11 * unit
    } else {
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(tipX, tipY)
      ctx.stroke()
      labelX = tipX + (arm.x / flat) * 11 * unit
      labelY = tipY + (arm.y / flat) * 11 * unit
    }
    haloText(ctx, arm.letter, labelX, labelY, arm.color, o.surface, unit)
  }
}

function drawScaleBar(ctx: Ctx, o: OverlayOptions, mmPerPx: number, unit: number): void {
  const pad = 26 * unit
  const mm = scaleBarLength(mmPerPx, o.width * 0.25)
  const px = mm / mmPerPx
  const x1 = o.width - pad
  const x0 = x1 - px
  const y = o.height - pad
  const tick = 5 * unit
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(x0, y - tick)
    ctx.lineTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.lineTo(x1, y - tick)
  }
  // A halo in the background colour keeps the bar readable over a part.
  ctx.strokeStyle = o.surface
  ctx.lineWidth = 4.5 * unit
  path()
  ctx.stroke()
  ctx.strokeStyle = o.ink
  ctx.lineWidth = 1.5 * unit
  path()
  ctx.stroke()

  ctx.font = `${Math.round(13 * unit)}px ${MONO}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  haloText(ctx, `${formatLength(mm)} mm`, x1, y - tick - 5 * unit, o.ink, o.surface, unit)
}

function drawNote(ctx: Ctx, o: OverlayOptions, unit: number): void {
  const pad = 26 * unit
  ctx.font = `${Math.round(13 * unit)}px ${SANS}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  haloText(ctx, PERSPECTIVE_NOTE, o.width - pad, o.height - pad, o.muted, o.surface, unit)
}

function haloText(ctx: Ctx, text: string, x: number, y: number, color: string, halo: string, unit: number): void {
  ctx.strokeStyle = halo
  ctx.lineWidth = 3.5 * unit
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

/** A round length without float noise: 20, 0.5, 0.002. */
function formatLength(mm: number): string {
  return String(Number(mm.toPrecision(1)))
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

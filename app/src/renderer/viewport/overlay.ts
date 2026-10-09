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
 * How many pixels of a picture a nominal one is: sizes are in units of a
 * picture 1280 pixels on its long edge, so what is drawn over a picture keeps
 * its share of it.
 */
export function overlayUnit(width: number, height: number): number {
  return Math.max(Math.max(width, height) / 1280, 0.5)
}

/**
 * Draws what a still picture needs to be read without the app around it: an
 * axis triad bottom left, and bottom right a scale bar in mm (orthographic) or a
 * note that there is none (perspective).
 */
export function drawOverlay(ctx: Ctx, o: OverlayOptions): void {
  const unit = overlayUnit(o.width, o.height)
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

/** The colours of the label chips: the two authors', and what is behind and on them. */
export interface LabelStyle {
  user: string
  agent: string
  /** What an agent's chip is filled with and a user's is lettered in: the colour of paper. */
  paper: string
  /** The background of the picture, for the hairline that sets a chip off what is under it. */
  surface: string
  ink: string
  /** What rings the value of a dimension that is not what was expected, and ticks one that is: `--fail` and `--ok` when not given. */
  fail?: string
  ok?: string
}

const CHIP = { height: 17, pad: 5, radius: 4, font: 11.5, border: 1.5, leader: 1.25, halo: 1.5 }

/** A dimension's value beside its number: how far apart the two are, the hairline around the value, and the tick of one that passes. */
const VALUE = { gap: 3, pad: 5, border: 1, hairline: 0.45, failBorder: 2, check: 9, checkGap: 4, weight: 500 }

/** How wide the chip of a mark's number is. */
function numberWidth(advance: number, text: string, unit: number): number {
  return Math.ceil(advance * text.length + 2 * CHIP.pad * unit)
}

/** How wide the value of a dimension is, with the tick of one that passes. */
function valueWidth(advance: number, value: { text: string; verdict?: 'pass' | 'fail' }, unit: number): number {
  return Math.ceil(advance * value.text.length + 2 * VALUE.pad * unit + (value.verdict === 'pass' ? (VALUE.check + VALUE.checkGap) * unit : 0))
}

/** How wide one letter of a chip is: the face is monospaced, so every label is as wide as its letters are many. */
function chipAdvance(ctx: Ctx, unit: number): number {
  ctx.save()
  ctx.font = chipFont(unit)
  const advance = ctx.measureText('M0').width / 2
  ctx.restore()
  return advance
}

/**
 * How large the chip of a label is, for `place`: of its number, and of a
 * dimension's value beside it. `unit` is the pixels of this canvas to a nominal one.
 */
export function chipSize(ctx: Ctx, unit: number): (text: string, value?: { text: string; verdict?: 'pass' | 'fail' }) => { w: number; h: number } {
  const advance = chipAdvance(ctx, unit)
  return (text, value) => ({ w: numberWidth(advance, text, unit) + (value ? VALUE.gap * unit + valueWidth(advance, value, unit) : 0), h: CHIP.height * unit })
}

function chipFont(unit: number): string {
  return `600 ${CHIP.font * unit}px ${MONO}`
}

/**
 * Draws the labels of the marks: each a small chip with the mark's number. The
 * person's are filled with their colour; the agent's are outlined in its own,
 * so that who made a mark shows without telling red from green. A chip that
 * was moved off its point is tied to it by a hairline. `active` is the id of
 * the mark being worked on, whose chip is ringed.
 */
export function drawLabels(
  ctx: Ctx,
  labels: Array<{ id: string; text: string; author: 'user' | 'agent'; x: number; y: number; visible: boolean; box: { x: number; y: number; w: number; h: number }; value?: { text: string; verdict?: 'pass' | 'fail' } }>,
  style: LabelStyle,
  unit: number,
  active: string | null = null
): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.font = chipFont(unit)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const shown = labels.filter((l) => l.visible)

  // The ties first, so that no chip is crossed by another's.
  for (const { x, y, box, author } of shown) {
    const tx = Math.min(Math.max(x, box.x), box.x + box.w)
    const ty = Math.min(Math.max(y, box.y), box.y + box.h)
    if (Math.hypot(tx - x, ty - y) < 3 * unit) continue
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(tx, ty)
    ctx.strokeStyle = style[author]
    ctx.lineWidth = CHIP.leader * unit
    ctx.stroke()
  }

  const advance = shown.some((l) => l.value) ? chipAdvance(ctx, unit) : 0
  const verdicts = shown.some((l) => l.value?.verdict) ? verdictColours(style) : null

  for (const { id, text, author, box: whole, value } of shown) {
    // The number's own chip: all of the box, but for a dimension, whose value stands to its right.
    const box = value ? { ...whole, w: numberWidth(advance, text, unit) } : whole
    const path = (grow: number) => {
      ctx.beginPath()
      ctx.roundRect(whole.x - grow, whole.y - grow, whole.w + 2 * grow, whole.h + 2 * grow, CHIP.radius * unit + grow)
    }
    // A hairline of the background around the chip, so it reads over a part of any colour.
    path(CHIP.halo * unit)
    ctx.fillStyle = style.surface
    ctx.fill()
    if (id === active) {
      path(CHIP.halo * unit + 1.5 * unit)
      ctx.fillStyle = style.ink
      ctx.fill()
      path(CHIP.halo * unit)
      ctx.fillStyle = style.surface
      ctx.fill()
    }
    const inset = (CHIP.border * unit) / 2
    ctx.beginPath()
    ctx.roundRect(box.x + inset, box.y + inset, box.w - 2 * inset, box.h - 2 * inset, CHIP.radius * unit - inset)
    ctx.fillStyle = author === 'user' ? style.user : style.paper
    ctx.fill()
    ctx.strokeStyle = style[author]
    ctx.lineWidth = CHIP.border * unit
    ctx.stroke()
    ctx.fillStyle = author === 'user' ? style.paper : style.agent
    ctx.fillText(text, box.x + box.w / 2, box.y + box.h / 2 + 0.5 * unit)
    if (!value) continue

    // The value, as on a drawing: ink on paper inside a hairline. One that is not what was expected is
    // ringed in the colour of failure; one that is has a small tick after it.
    const failed = value.verdict === 'fail'
    const border = (failed ? VALUE.failBorder : VALUE.border) * unit
    const x = box.x + box.w + VALUE.gap * unit
    const w = whole.x + whole.w - x
    ctx.beginPath()
    ctx.roundRect(x + border / 2, whole.y + border / 2, w - border, whole.h - border, CHIP.radius * unit - border / 2)
    ctx.fillStyle = style.paper
    ctx.fill()
    // A quiet hairline of ink, whoever made it: its number beside it says whose it is, and only failure is in colour.
    ctx.strokeStyle = failed ? (verdicts?.fail ?? style.user) : style.ink
    ctx.globalAlpha = failed ? 1 : VALUE.hairline
    ctx.lineWidth = border
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.font = `${VALUE.weight} ${CHIP.font * unit}px ${MONO}`
    ctx.textAlign = 'left'
    ctx.fillStyle = style.ink
    ctx.fillText(value.text, x + VALUE.pad * unit, whole.y + whole.h / 2 + 0.5 * unit)
    if (value.verdict === 'pass') {
      const left = x + w - (VALUE.pad + VALUE.check) * unit
      const mid = whole.y + whole.h / 2
      ctx.beginPath()
      ctx.moveTo(left, mid + 0.5 * unit)
      ctx.lineTo(left + 3 * unit, mid + 3.5 * unit)
      ctx.lineTo(left + VALUE.check * unit, mid - 3.5 * unit)
      ctx.strokeStyle = verdicts?.ok ?? style.agent
      ctx.lineWidth = 1.5 * unit
      ctx.stroke()
    }
    ctx.font = chipFont(unit)
    ctx.textAlign = 'center'
  }
  ctx.restore()
}

/** The colours of the two verdicts: the style's, or the tokens of the page. */
function verdictColours(style: LabelStyle): { fail?: string; ok?: string } {
  if (style.fail && style.ok) return { fail: style.fail, ok: style.ok }
  const tokens = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const token = (name: string): string | undefined => tokens?.getPropertyValue(name).trim() || undefined
  return { fail: style.fail ?? token('--fail'), ok: style.ok ?? token('--ok') }
}

let fontsLoaded: Promise<unknown> | undefined

/**
 * The faces the overlay is set in, loaded once. A canvas does not wait for a
 * web font: text drawn before it has arrived comes out in the fallback face.
 */
export function overlayFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve()
  fontsLoaded ??= Promise.all(
    ['12px "IBM Plex Mono"', '600 12px "IBM Plex Mono"', '12px "IBM Plex Sans"'].map((font) => document.fonts.load(font))
  ).catch(() => {}) // a face that cannot be loaded leaves the fallback, as before
  return fontsLoaded
}

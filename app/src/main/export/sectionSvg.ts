import type { Sectioned } from '../../shared/geometry'
import type { DimensionMark } from '../../shared/marks'
import { expectedText, measuredValue, valueText } from '../../shared/dimension'

// A drawing of a section for someone who will make the part: the kernel's outlines laid flat in the plane's own
// axes, at true scale (one unit of the file is one millimetre, and so is one of the width and the height it names:
// a 40 mm edge is 40 mm long), with a scale bar and a title block, and the dimensions that lie in the plane with the
// value torno measured and what was expected. The outlines are the kernel's in full, not the thinned ones the agent
// is told; the title block says how far they may stray. Pure: main makes the data, the person's save dialog the file.

type Vec3 = readonly [number, number, number]

/** How far from the plane both ends of a dimension may be for it to lie in it, mm. */
export const IN_PLANE_MM = 0.01
/** The sheet's margin round everything, mm. */
const MARGIN = 12
/** The least width of a sheet, mm: the title block needs it. */
const LEAST_WIDTH = 130
/** The type, mm. */
const TEXT = 3.2
const ROW = 5.4
const INK = '#22252A'
const MUTED = '#646970'
const PAPER = '#FFFFFF'
const FILL = '#E8E5DE'
/** The face of numbers, and of the rest. */
const MONO = "'IBM Plex Mono', ui-monospace, monospace"
const SANS = "'IBM Plex Sans', system-ui, sans-serif"

/** What the title block says besides the cut itself. */
export interface SectionSheetInfo {
  /** The project's name. */
  object: string
  layout: string
  /** The build the outlines were cut on. */
  revision: number
  /** When it was made. */
  date: Date
  /** The marks of the object: the dimensions in the plane are drawn from them. */
  marks: readonly DimensionMark[]
  /** Parts torno moved apart for display are cut where they are shown. */
  spread?: boolean
  /** The hash of the sources the build was made of, when torno knows it. Left out when absent. */
  source?: string
}

/** A drawing of a section: the file, and what it holds of the plane. */
export interface SectionSvg {
  svg: string
  /** The sheet, in mm. */
  width: number
  height: number
  /** The dimensions drawn (by mark id) and those that were not, with why. */
  dimensions: string[]
  left: Array<{ id: string; why: string }>
}

/** A number in full, without the noise of floating point: `0.1 + 0.2` is `0.3`. */
export function full(n: number): string {
  const text = String(Number(n.toPrecision(12)))
  return text === '-0' ? '0' : text
}

/** What was cut of a part, its area in full: `lid 1039.5 mm²`, with `≈` when the kernel's area is not exact. */
function areaLine(part: Sectioned['parts'][number]): string {
  if (part.loops.length === 0) return `${part.part}, not cut`
  if (part.open > 0 || part.area === null) return `${part.part}, open: it bounds no area`
  return `${part.part} ${part.areaExact ? '' : '≈ '}${full(part.area)} mm²`
}

/** `1`, `2`, `5` times a power of ten, the largest not over `limit`: a length for a scale bar. */
export function niceLength(limit: number): number {
  if (!(limit > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(limit))
  const steps = [5, 2, 1].map((m) => m * power)
  return steps.find((s) => s <= limit) ?? power
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
/** Coordinates in the file: millimetres, to a thousandth of one. */
const c = (n: number): string => String(Math.round(n * 1000) / 1000 + 0)

/** Whether the plane's `y` points down in the world: against Z, or, with none of Z, against Y. As the drawing the agent gets. */
function pointsDown(along: Vec3): boolean {
  return Math.abs(along[2]) > 1e-9 ? along[2] < 0 : along[1] < -1e-9
}

interface Line {
  id: string
  a: [number, number]
  b: [number, number]
  text: string
  expected?: string
  verdict?: string
}

/**
 * The drawing of `cut` as an SVG document, with the dimensions among `info.marks` that lie in its plane. A mark is
 * drawn when it is a dimension, not resolved, of this layout, measured on build `info.revision` with the two points
 * the value was taken between, both within `IN_PLANE_MM` of the plane; the others are listed in `left` with why.
 */
export function sectionSvg(cut: Sectioned, info: SectionSheetInfo): SectionSvg {
  const { plane } = cut
  const down = pointsDown(plane.y)
  const inPlane = (p: Vec3): [number, number] => {
    const d = sub(p, plane.origin)
    return [dot(d, plane.x), dot(d, plane.y)]
  }

  // The dimensions that lie in the plane.
  const lines: Line[] = []
  const left: SectionSvg['left'] = []
  for (const mark of info.marks) {
    if (mark.kind !== 'dimension' || mark.status === 'resolved') continue
    if (mark.layout !== info.layout) continue
    const value = measuredValue(mark, info.revision)
    if (value === undefined) {
      left.push({ id: mark.id, why: 'not measured on this build' })
      continue
    }
    const ends = mark.points ?? (mark.b ? ([mark.a.point, mark.b.point] as [Vec3, Vec3]) : undefined)
    if (!ends) continue
    const off = ends.map((p) => Math.abs(dot(sub(p, plane.origin), plane.normal)))
    if (off.some((o) => o > IN_PLANE_MM)) continue
    lines.push({
      id: mark.id,
      a: inPlane(ends[0]),
      b: inPlane(ends[1]),
      text: valueText(mark.measure, value),
      ...(mark.expected === undefined ? {} : { expected: `expected ${expectedText(mark)}` }),
      ...(mark.verdict ? { verdict: mark.verdict } : {})
    })
  }

  // The box of everything drawn, mm along u and v.
  let min: [number, number] = cut.bounds ? [cut.bounds.min[0], cut.bounds.min[1]] : [0, 0]
  let max: [number, number] = cut.bounds ? [cut.bounds.max[0], cut.bounds.max[1]] : [0, 0]
  for (const line of lines) {
    for (const p of [line.a, line.b]) {
      min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])]
      max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])]
    }
  }
  // Room for the labels of the dimensions on either side.
  const room = lines.length > 0 ? 14 : 0
  const drawW = max[0] - min[0] + 2 * room
  const width = Math.max(drawW + 2 * MARGIN, LEAST_WIDTH)
  // A point of the plane as a point of the sheet: mm from the sheet's top left.
  const offsetX = (width - drawW) / 2 + room
  const topY = MARGIN + room
  const at = ([u, v]: readonly [number, number]): [number, number] => [offsetX + (u - min[0]), topY + (down ? v - min[1] : max[1] - v)]

  const body: string[] = []
  // The cut: one path for each part, its holes by the even-odd rule.
  for (const part of cut.parts) {
    const closed = part.loops.filter((loop) => loop.closed && loop.points.length > 2)
    const open = part.loops.filter((loop) => !loop.closed && loop.points.length > 1)
    if (closed.length > 0) {
      const d = closed.map((loop) => `M${loop.points.map((p) => at(p).map(c).join(' ')).join(' L')} Z`).join(' ')
      body.push(`<path data-part="${escape(part.part)}" d="${d}" fill="${FILL}" fill-rule="evenodd" stroke="${INK}" stroke-width="0.35" stroke-linejoin="round"/>`)
    }
    for (const loop of open) {
      body.push(`<path data-part="${escape(part.part)}" d="M${loop.points.map((p) => at(p).map(c).join(' ')).join(' L')}" fill="none" stroke="${INK}" stroke-width="0.35" stroke-dasharray="1.5 1" stroke-linejoin="round"/>`)
    }
  }

  // The dimensions: a line between the two ends with a tick at each, and its words beside the middle.
  for (const line of lines) {
    const [x1, y1] = at(line.a)
    const [x2, y2] = at(line.b)
    const length = Math.hypot(x2 - x1, y2 - y1)
    const [nx, ny] = length > 0 ? [-(y2 - y1) / length, (x2 - x1) / length] : [0, -1]
    const tick = 1.5
    const mx = (x1 + x2) / 2 + nx * 4
    const my = (y1 + y2) / 2 + ny * 4
    const words = [line.id + ' ' + line.text + (line.verdict ? (line.verdict === 'fail' ? ' (fails)' : ' (passes)') : ''), ...(line.expected ? [line.expected] : [])]
    body.push(
      `<g data-dimension="${escape(line.id)}" stroke="${INK}" stroke-width="0.25" fill="none">`,
      `<line x1="${c(x1)}" y1="${c(y1)}" x2="${c(x2)}" y2="${c(y2)}"/>`,
      `<line x1="${c(x1 - nx * tick)}" y1="${c(y1 - ny * tick)}" x2="${c(x1 + nx * tick)}" y2="${c(y1 + ny * tick)}"/>`,
      `<line x1="${c(x2 - nx * tick)}" y1="${c(y2 - ny * tick)}" x2="${c(x2 + nx * tick)}" y2="${c(y2 + ny * tick)}"/>`,
      ...words.map((w, i) => `<text x="${c(mx)}" y="${c(my + i * ROW * 0.8)}" text-anchor="middle" font-family="${MONO}" font-size="${TEXT * 0.85}" stroke="none" fill="${INK}">${escape(w)}</text>`),
      `</g>`
    )
  }

  // The scale bar, under the cut: a length of 1, 2 or 5 times a power of ten that is at most a third of the sheet.
  const barY = topY + (max[1] - min[1]) + room + 8
  const bar = niceLength(Math.max(width / 3, 1))
  const barX = MARGIN
  body.push(
    `<g data-scale-bar="${c(bar)}" stroke="${INK}" stroke-width="0.35" fill="none">`,
    `<line x1="${c(barX)}" y1="${c(barY)}" x2="${c(barX + bar)}" y2="${c(barY)}"/>`,
    `<line x1="${c(barX)}" y1="${c(barY - 1.5)}" x2="${c(barX)}" y2="${c(barY + 1.5)}"/>`,
    `<line x1="${c(barX + bar)}" y1="${c(barY - 1.5)}" x2="${c(barX + bar)}" y2="${c(barY + 1.5)}"/>`,
    `<text x="${c(barX + bar + 2)}" y="${c(barY + 1.1)}" font-family="${MONO}" font-size="${TEXT}" stroke="none" fill="${INK}">${c(bar)} mm</text>`,
    `</g>`
  )

  // The title block: a label and its words in each row. Numbers are in full.
  const deflection = Math.max(0, ...cut.parts.flatMap((part) => part.loops.map((loop) => loop.deflection)))
  const rows: Array<[string, string]> = [
    ['Project', info.object],
    ['Layout', info.layout + (info.spread ? ' (parts spread for display: cut where they are shown)' : '')],
    ['Build', `r${info.revision}`],
    ['Date', info.date.toISOString().slice(0, 10)],
    ['Plane origin', `(${plane.origin.map(full).join(', ')}) mm`],
    ['Plane normal', `(${plane.normal.map(full).join(', ')})`],
    ['Sheet axes', `u along (${plane.x.map(full).join(', ')}), v along (${plane.y.map(full).join(', ')}), ${down ? 'v runs down the sheet' : 'v runs up the sheet'}`],
    ['Scale', '1:1, millimetres: print at 100 %'],
    ['Outlines', `within ${full(deflection)} mm of the true ones`],
    ...cut.parts.map((part): [string, string] => ['Cut', areaLine(part)]),
    ...(info.source ? ([['Source', info.source]] as Array<[string, string]>) : [])
  ]
  const blockTop = barY + 8
  const blockWidth = width - 2 * MARGIN
  const labelW = 28
  body.push(`<g data-title-block="" font-size="${TEXT}">`)
  body.push(`<rect x="${c(MARGIN)}" y="${c(blockTop)}" width="${c(blockWidth)}" height="${c(rows.length * ROW)}" fill="none" stroke="${INK}" stroke-width="0.35"/>`)
  rows.forEach(([label, text], i) => {
    const y = blockTop + i * ROW
    if (i > 0) body.push(`<line x1="${c(MARGIN)}" y1="${c(y)}" x2="${c(MARGIN + blockWidth)}" y2="${c(y)}" stroke="${MUTED}" stroke-width="0.15"/>`)
    body.push(`<text x="${c(MARGIN + 2)}" y="${c(y + ROW * 0.7)}" font-family="${SANS}" fill="${MUTED}">${escape(label)}</text>`)
    body.push(`<text x="${c(MARGIN + labelW)}" y="${c(y + ROW * 0.7)}" font-family="${MONO}" fill="${INK}">${escape(text)}</text>`)
  })
  body.push(`<line x1="${c(MARGIN + labelW - 2)}" y1="${c(blockTop)}" x2="${c(MARGIN + labelW - 2)}" y2="${c(blockTop + rows.length * ROW)}" stroke="${MUTED}" stroke-width="0.15"/>`)
  body.push(`</g>`)

  const height = blockTop + rows.length * ROW + MARGIN
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${c(width)}mm" height="${c(height)}mm" viewBox="0 0 ${c(width)} ${c(height)}">`,
    `<title>${escape(`${info.object}, layout ${info.layout}, section`)}</title>`,
    `<rect width="${c(width)}" height="${c(height)}" fill="${PAPER}"/>`,
    ...body,
    `</svg>`,
    ''
  ].join('\n')
  return { svg, width, height, dimensions: lines.map((line) => line.id), left }
}

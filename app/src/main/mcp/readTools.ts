import { valueText } from '../../shared/dimension'
import type { CheckedClearance, CheckedMesh, CheckedOverlap, Measured, MeasuredValue, SectionLoop, Sectioned } from '../../shared/geometry'
import type { Scene } from '../../shared/scene'
import { type SectionDrawingResult, type SectionPlane, axisForm, cutText, planeOf, planeText } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { KernelError } from '../kernel/client'
import { number, sizes, vector } from '../marks/describe'
import { plain, wire } from '../marks/measure'
import { type End, type EndArg, checkRef, endsOf } from './markTools'
import { type PlaneArg, type ToolDeps, type ToolResult, NO_PLANE, built, clampSize, failure, layoutFor, messageOf, notOpen, ofBuild, tidy } from './tools'

// The tools the agent reads the part with: `measure`, `section` and `check`.
// Each asks the kernel about the last build that worked, and answers with what
// it said as data and with a reading of it in a line, worded as a dimension
// is. Nothing here is taken for exact that the kernel does not say is.

type Vec3 = [number, number, number]

export interface MeasureToolArgs {
  kind: Measured['kind']
  a: EndArg
  b?: EndArg
  density?: number
  layout?: string
}
export interface SectionToolArgs {
  plane: 'current' | PlaneArg
  parts?: string[]
  layout?: string
  size?: number
}
export interface CheckToolArgs {
  kind: 'overlap' | 'clearance' | 'mesh'
  a: string
  b?: string
  layout?: string
}

/** The most points of a loop that the JSON of a section holds, unless one part was asked for. */
export const MAX_LOOP_POINTS = 200

interface Built {
  obj: ObjectInfo
  revision: number
  scene: Scene
}

/**
 * Asks about one build. `ask` is given the last build that worked, checks
 * what it was asked against it and asks the kernel; when another build has
 * landed by the time the kernel has answered, the answer may be of either,
 * and all of it is done again, once, against the new one.
 */
async function ofOneBuild<T>(deps: ToolDeps, objectId: string, ask: (found: Built) => Promise<{ got: T } | ToolResult>): Promise<{ found: Built; got: T } | ToolResult> {
  for (let tries = 0; ; tries++) {
    const found = built(deps, objectId)
    if ('content' in found) return found
    const answer = await ask(found)
    if (deps.scene(objectId)?.revision === found.revision) return 'content' in answer ? answer : { found, got: answer.got }
    if (tries > 0) return failure(`${found.obj.name} was built again while the kernel was asked: call again`)
  }
}

/** Why the kernel gave no answer, as the agent is told: its own words when it refused, without the layout before each ref. */
function refusal(e: unknown, layout: string, what: string): ToolResult {
  if (e instanceof KernelError && e.kind === 'timeout') return failure(`the kernel did not answer within 30 s; the part may be too large for this ${what}`)
  return failure(plain(e, layout))
}

/** A number as data: in full, but for what arithmetic leaves past the ninth decimal, and never -0. */
function clean<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 + 0 : value) as T
  if (Array.isArray(value)) return value.map(clean) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v)])) as T
  return value
}

const reply = (value: object): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

const BETWEEN = ['distance', 'angle']

export async function measureTool(deps: ToolDeps, objectId: string, args: MeasureToolArgs): Promise<ToolResult> {
  const between = BETWEEN.includes(args.kind)
  if (between && args.b === undefined) return failure(`${args.kind} is between two ends: give b`)
  if (!between && args.b !== undefined) return failure(`${args.kind} is of a alone: leave b out`)

  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const ends = await endsOf(deps, objectId, found.scene, found.revision, layout, [['a', args.a], ...(args.b === undefined ? [] : ([['b', args.b]] as Array<['b', EndArg]>))])
    if ('content' in ends) return ends
    const [a, b] = ends
    try {
      // A wall is measured at a point of its face: with none given, at the centre of the face, which the kernel refuses when it is not on it.
      if (args.kind === 'thickness' && a.ref !== undefined && a.point === undefined) {
        const described = await deps.describe(objectId, layout, a.ref)
        if (described.kind === 'face') a.point = described.center
      }
      const end = ({ ref, point }: End): { ref?: string; point?: Vec3 } => ({ ...(ref === undefined ? {} : { ref }), ...(point ? { point } : {}) })
      const request = wire({ kind: args.kind, layout, a: end(a), ...(b ? { b: end(b) } : {}), ...(args.density === undefined ? {} : { density: args.density }) })
      return { got: { layout, a, b, measured: await deps.query<Measured>(objectId, 'measure', request) } }
    } catch (e) {
      return refusal(e, layout, 'measurement')
    }
  })
  if ('content' in asked) return asked
  const { layout, a, b, measured } = asked.got
  const reading = measureReading(measured, a, b)
  if (reading === null) return failure('the kernel did not answer with a measurement')
  return reply({ layout, ...ofBuild(deps, objectId), ...clean(measured), reading })
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isVec = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite)

/**
 * A measurement in a line, as a dimension says its own: the value, how it was
 * taken, and of what. `≈` and `approximate` wherever the kernel does not say
 * the value is exact. Null for a reply that is no measurement.
 */
export function measureReading(measured: Measured, a: End, b?: End): string | null {
  const ends = b ? `${a.text} to ${b.text}` : a.text
  const how = typeof measured?.how === 'string' ? measured.how : ''
  const exact = measured?.exact === true
  const about = exact ? '' : '≈ '
  // Said once: a way that already says it is approximate is not followed by the word.
  const roughly = exact || /approximate/.test(how) ? '' : ', approximate'
  if (measured?.kind === 'bbox') {
    if (!isVec(measured.size) || !isVec(measured.min) || !isVec(measured.max)) return null
    return `bbox ${about}${sizes(measured.size)} mm, from ${vector(measured.min)} to ${vector(measured.max)}, ${how}${roughly}, ${ends}`
  }
  if (!finite(measured?.value)) return null
  const { kind, value } = measured
  switch (kind) {
    case 'distance':
      return `${about}${number(value)} mm ${how}${roughly}, ${ends}`
    case 'angle':
      return `${about}${number(value)}° ${how}${roughly}, ${ends}`
    case 'radius':
    case 'diameter': {
      // Of a radius the way is what the thing is, which its ref says already: said only when it says which radius.
      const which = /^(cylinder|circle|sphere)$/.test(how) || how === '' ? '' : ` (${how})`
      return `${about}${valueText(kind, value)}${which}${roughly}, ${ends}`
    }
    case 'thickness': {
      const at = isVec(measured.points?.[0]) ? measured.points[0] : a.point
      return `${about}${number(value)} mm ${how}${roughly}, ${a.ref ?? ''}${at ? ` at ${vector(at)}` : ''}${moved(measured)}`
    }
    case 'volume':
      return `volume ${about}${number(value)} mm³ ${how}${roughly}, ${ends}`
    case 'area':
      return `area ${about}${number(value)} mm² ${how}${roughly}, ${ends}`
    case 'mass':
      return `mass ${about}${number(value)} g, ${how}${roughly}, ${ends}${finite(measured.volume) ? ` (volume ${number(measured.volume)} mm³)` : ''}`
    default:
      return null
  }
}

/** Said of a wall measured from another point than the one given: the kernel laid it on the face. */
function moved(measured: MeasuredValue): string {
  return finite(measured.moved) && number(measured.moved) !== '0' ? ` (the point was moved ${number(measured.moved)} mm onto the face)` : ''
}

export async function checkTool(deps: ToolDeps, objectId: string, args: CheckToolArgs): Promise<ToolResult> {
  const two = args.kind !== 'mesh'
  if (two && args.b === undefined) return failure(`${args.kind} is of two parts: give b`)
  if (!two && args.b !== undefined) return failure('mesh is of the part a alone: leave b out')

  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    for (const name of two ? [args.a, args.b!] : [args.a]) {
      const checked = checkRef(found.scene, layout, name)
      if (typeof checked === 'string') return failure(checked)
      if (checked.target !== 'part') return failure(`check ${args.kind} is of whole parts, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
    }
    try {
      return { got: { layout, checked: await deps.query<object>(objectId, 'check', { kind: args.kind, layout, a: args.a, ...(two ? { b: args.b } : {}) }) } }
    } catch (e) {
      return refusal(e, layout, 'check')
    }
  })
  if ('content' in asked) return asked
  const { layout, checked } = asked.got
  const reading = checkReading(args, checked)
  if (reading === null) return failure('the kernel did not answer with a check')
  return reply({ layout, ...ofBuild(deps, objectId), kind: args.kind, ...clean(checked), reading })
}

/** A check in a line. Null for a reply that is none. */
export function checkReading(args: Pick<CheckToolArgs, 'kind' | 'a' | 'b'>, checked: object): string | null {
  // Nothing the kernel says of a check is approximate today: were it to say so, the reading would.
  const about = (checked as { exact?: unknown } | null)?.exact === false ? '≈ ' : ''
  const roughly = about ? ', approximate' : ''
  const pair = `between ${args.a} and ${args.b}`
  if (args.kind === 'overlap') {
    const { volume, bbox } = checked as Partial<CheckedOverlap>
    if (!finite(volume)) return null
    if (!bbox || !isVec(bbox.min) || !isVec(bbox.max)) return `no overlap ${pair}`
    return `overlap ${about}${number(volume)} mm³ ${pair}${roughly}, within ${vector(bbox.min)} to ${vector(bbox.max)}`
  }
  if (args.kind === 'clearance') {
    const { distance, overlapping, how } = checked as Partial<CheckedClearance>
    if (!finite(distance)) return null
    const base = `clearance ${about}${number(distance)} mm ${pair}${roughly}`
    if (overlapping === true) return `${base}: the parts overlap`
    // Of a part that is no solid the kernel says how far, and that it cannot say whether they overlap.
    if (overlapping !== false) return `${base}${typeof how === 'string' && how ? ` (${how})` : ''}`
    return distance === 0 ? `${base}: the parts touch` : base
  }
  const { watertight, openEdges, where, triangles } = checked as Partial<CheckedMesh>
  if (typeof watertight !== 'boolean' || !finite(openEdges) || !finite(triangles)) return null
  const count = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
  if (watertight) return `mesh of ${args.a}: closed, ${count(triangles, 'triangle')}`
  if (triangles === 0) return `mesh of ${args.a}: no triangles`
  const first = Array.isArray(where) && isVec(where[0]) ? `, first at ${vector(where[0])}` : ''
  return `mesh of ${args.a}: OPEN, ${count(openEdges, 'open edge')}${first}`
}

export async function sectionTool(deps: ToolDeps, objectId: string, args: SectionToolArgs): Promise<ToolResult> {
  if (args.parts?.length === 0) return failure('parts is empty: name the parts to cut, or leave it out for all of them')
  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const plane = planeAsked(deps, objectId, found.obj, args.plane)
    if ('content' in plane) return plane
    for (const name of args.parts ?? []) {
      const checked = checkRef(found.scene, layout, name)
      if (typeof checked === 'string') return failure(checked)
      if (checked.target !== 'part') return failure(`parts are cut whole, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
    }
    try {
      const cut = await deps.query<Sectioned>(objectId, 'section', { layout, plane, ...(args.parts ? { parts: args.parts } : {}) })
      if (!Array.isArray(cut?.parts) || !isVec(cut.plane?.origin) || !isVec(cut.plane.normal)) return failure('the kernel did not answer with a section')
      return { got: { layout, cut } }
    } catch (e) {
      return refusal(e, layout, 'section')
    }
  })
  if ('content' in asked) return asked
  const { layout, cut } = asked.got
  const { found } = asked

  // One part is given in full; of several, each loop in no more points than can be read.
  const full = args.parts?.length === 1
  let thinnedAny = false
  const parts = cut.parts.map((part) => ({
    ...clean({ ...part, loops: undefined }),
    loops: part.loops.map((loop) => {
      const kept = full ? null : thinned(loop, MAX_LOOP_POINTS)
      if (kept) thinnedAny = true
      const { points, ...rest } = loop
      return { ...clean(rest), ...(kept ? { deflection: clean(kept.deflection), thinned: true, of: points.length } : {}), points: tidy(kept?.points ?? points) }
    })
  }))
  const extent = cut.bounds ? ([cut.bounds.max[0] - cut.bounds.min[0], cut.bounds.max[1] - cut.bounds.min[1]] as [number, number]) : null
  const along = axisForm(cut.plane)
  const title = `${planeText(cut.plane)} · layout ${layout}`
  const reading = extent
    ? `${title}: ${cut.parts.map((part) => `${cutText(part)} in ${part.loops.length} loop${part.loops.length === 1 ? '' : 's'}`).join('; ')}; the cut is ${sizes(extent)} mm`
    : `${title}: the plane cuts ${args.parts ? 'none of these parts' : 'nothing'}`

  const content: ToolResult['content'] = []
  let image: string
  if (!extent) image = 'not drawn: there is nothing to draw'
  else {
    try {
      const drawing = await deps.sectionDrawing({ objectId, layout, section: cut, names: found.scene.parts.map((p) => p.name), size: clampSize(args.size) })
      content.push({ type: 'image', data: Buffer.from(drawing.png).toString('base64'), mimeType: 'image/png' })
      image = `${drawing.width}×${drawing.height}, ${coloursText(drawing, found.obj)}, ${await saved(deps, objectId, drawing.png)}`
    } catch (e) {
      // The outlines are the answer: they are given whether or not they could be drawn.
      image = `not drawn: ${messageOf(e)}`
    }
  }
  content.push({
    type: 'text',
    text: JSON.stringify({
      layout,
      ...ofBuild(deps, objectId),
      plane: { ...clean(cut.plane), ...(along && along.sign > 0 ? { axis: along.axis, at: clean(along.at) } : {}) },
      parts,
      bounds: clean(cut.bounds),
      extent: clean(extent),
      ...(thinnedAny ? { thinned: true } : {}),
      reading,
      image
    })
  })
  return { content }
}

async function saved(deps: ToolDeps, objectId: string, png: Uint8Array): Promise<string> {
  try {
    return `saved as ${await deps.saveImage(objectId, png)}`
  } catch (e) {
    return `not saved: ${messageOf(e)}`
  }
}

function coloursText(drawing: SectionDrawingResult, obj: ObjectInfo): string {
  return drawing.colours === 'window' ? 'the parts in the colours the user sees them in' : `the parts in their default colours (${obj.name} is not the object open in the torno window)`
}

/** The plane a section is asked by: the user's own for `'current'`, which only the object on screen has. */
function planeAsked(deps: ToolDeps, objectId: string, obj: ObjectInfo, asked: SectionToolArgs['plane']): SectionPlane | ToolResult {
  if (asked !== 'current') return planeOf(asked) ?? failure(NO_PLANE)
  const open = deps.openObjectId()
  if (open !== objectId) return failure(`${notOpen(obj, open)}, so the user's section of it is not known: give a plane`)
  return deps.view(objectId)?.section ?? failure('the user has no section on screen: give a plane, as {origin, normal} or {axis, at}')
}

/**
 * A loop in at most `most` of its points, or null when it has no more: those
 * kept are the ones furthest from the line through the rest (the corners
 * first, as Ramer-Douglas-Peucker would keep them), in their order. A closed
 * loop stays closed: its last point still joins its first. `deflection` is
 * how far the true outline may now be from the points: what the kernel
 * allowed itself, and the furthest point that was dropped.
 */
export function thinned(loop: Pick<SectionLoop, 'points' | 'closed' | 'deflection'>, most: number): { points: [number, number][]; deflection: number } | null {
  const points = loop.points
  if (points.length <= most) return null
  // A ring is walked from its first point round to it again.
  const path = loop.closed ? [...points, points[0]] : points
  const keep = new Uint8Array(path.length)
  keep[0] = keep[path.length - 1] = 1
  let kept = loop.closed ? 1 : 2
  /** The point between two kept ones that is furthest from the line through them, and how far. */
  const furthest = (first: number, last: number): { first: number; last: number; at: number; off: number } => {
    const [ax, ay] = path[first]
    const [dx, dy] = [path[last][0] - ax, path[last][1] - ay]
    const length = Math.hypot(dx, dy)
    let at = -1
    let off = -1
    for (let i = first + 1; i < last; i++) {
      const [px, py] = [path[i][0] - ax, path[i][1] - ay]
      // Between ends that are one point (a ring's), how far from that point.
      const d = length < 1e-12 ? Math.hypot(px, py) : Math.abs(dx * py - dy * px) / length
      if (d > off) [at, off] = [i, d]
    }
    return { first, last, at, off }
  }
  const spans = [furthest(0, path.length - 1)]
  while (kept < most) {
    let widest = 0
    for (let i = 1; i < spans.length; i++) if (spans[i].off > spans[widest].off) widest = i
    const span = spans[widest]
    // Nothing left that is off the line through its neighbours: the rest say nothing more.
    if (span.at < 0 || span.off < 1e-9) break
    keep[span.at] = 1
    kept += 1
    spans.splice(widest, 1, furthest(span.first, span.at), furthest(span.at, span.last))
  }
  const strays = Math.max(0, ...spans.map((span) => span.off))
  return { points: points.filter((_, i) => keep[i] === 1), deflection: loop.deflection + strays }
}

import { valueText } from '../../shared/dimension'
import type { CheckedClearance, CheckedMesh, CheckedOverlap, Measured, MeasuredValue, ScanSectioned, SectionLoop, Sectioned } from '../../shared/geometry'
import type { Part, Scene } from '../../shared/scene'
import { type SectionDrawingResult, type SectionPlane, axisForm, cutText, planeText } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { KernelError, isBusy } from '../kernel/client'
import { number, sizes, vector } from '../marks/describe'
import { plain, wire } from '../marks/measure'
import { isMoved, movedForDisplay, spreadApart } from '../marks/spread'
import { type End, type EndArg, checkRef, endsOf } from './markTools'
import { type ScanAsked, SCAN_APPROXIMATE, noteOf, scanFor, scanFrame, scanSpread } from './scanTools'
import { type PlaneArg, type ToolDeps, type ToolResult, SPREAD_NOTE, built, clampSize, failure, layoutFor, messageOf, notOpen, ofBuild, planeArg, tidy } from './tools'

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
  deflection?: number
  /** A scan to cut by the same plane. */
  scan?: string
}
export interface CheckToolArgs {
  kind: 'overlap' | 'clearance' | 'mesh'
  a: string
  b?: string
  layout?: string
}

/** The most points of a scan's lines in a plane that the JSON of a section holds: the drawing is made from all the kernel told. */
export const MAX_SCAN_LINE_POINTS = 2000
/** Said of an end that is a point of a scan, asked for anything but a distance. */
const SCAN_END_DISTANCE = 'only a distance is measured to a point of a scan'
const isScanEnd = (arg: unknown): boolean => typeof arg === 'object' && arg !== null && 'scan' in arg

/** The most points the JSON of a section holds in all, whatever was asked for: what a tool's answer has room for. */
export const MAX_SECTION_POINTS = 4000
/** The fewest points a loop is thinned to, and so the most loops that are told: the smallest beyond them are counted. */
export const MIN_LOOP_POINTS = 8
export const MAX_SECTION_LOOPS = MAX_SECTION_POINTS / MIN_LOOP_POINTS
/** How far the outlines asked of the kernel may stray from the true ones, mm, unless the agent says: fine enough for a round hole to be drawn round. */
export const SECTION_DEFLECTION = 0.01
const NO_DEFLECTION = `deflection is a number of mm, 0.005 to 0.05: how far the outlines may stray from the true ones (default ${SECTION_DEFLECTION})`

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
export async function ofOneBuild<T>(deps: ToolDeps, objectId: string, ask: (found: Built) => Promise<{ got: T } | ToolResult>): Promise<{ found: Built; got: T } | ToolResult> {
  for (let tries = 0; ; tries++) {
    const found = built(deps, objectId)
    if ('content' in found) return found
    const answer = await ask(found)
    if (deps.scene(objectId)?.revision === found.revision) return 'content' in answer ? answer : { found, got: answer.got }
    if (tries > 0) return failure(`${found.obj.name} was built again while the kernel was asked: call again`)
  }
}

/**
 * Why the kernel gave no answer, as the agent is told: its own words when it
 * refused, without the layout before each ref. Of a query that took too long,
 * that the part may be too large for it; but not of one that was answered at
 * once because the worker is still busy with an earlier one (`isBusy`): that
 * says nothing of this question, and is told as the kernel says it.
 */
export function refusal(e: unknown, layout: string, what: string, of = 'the part'): ToolResult {
  if (e instanceof KernelError && e.kind === 'timeout' && !isBusy(e)) return failure(`the kernel did not answer within 30 s; ${of} may be too large for this ${what}`)
  return failure(plain(e, layout))
}

/** A number as data: in full, but for what arithmetic leaves past the ninth decimal, and never -0. */
export function clean<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 + 0 : value) as T
  if (Array.isArray(value)) return value.map(clean) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v)])) as T
  return value
}

const reply = (value: object): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/** A layout torno spread for display has parts that carry how far they were moved (`marks/spread.ts`, where the rule for what is then told is). */
const inLayoutOf = (scene: Scene, layout: string) => (name: string): Part | undefined => scene.parts.find((p) => p.layout === layout && p.name === name)

const BETWEEN = ['distance', 'angle']

export async function measureTool(deps: ToolDeps, objectId: string, args: MeasureToolArgs): Promise<ToolResult> {
  const between = BETWEEN.includes(args.kind)
  if (between && args.b === undefined) return failure(`${args.kind} is between two ends: give b`)
  if (!between && args.b !== undefined) return failure(`${args.kind} is of a alone: leave b out`)
  if (args.kind !== 'distance' && (isScanEnd(args.a) || isScanEnd(args.b))) return failure(SCAN_END_DISTANCE)

  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const ends = await endsOf(deps, objectId, found.scene, found.revision, layout, [['a', args.a], ...(args.b === undefined ? [] : ([['b', args.b]] as Array<['b', EndArg]>))])
    if ('content' in ends) return ends
    const [a, b] = ends
    // A region stands for a point of its scan: of that, as of any point of a scan, only a distance is taken.
    const ofScan = ends.find((end) => end.scan)
    if (ofScan && args.kind !== 'distance') return failure(SCAN_END_DISTANCE)
    // A scan stands where the model's frame has it: against a part torno moved, or one that stood elsewhere when the scan was aligned, nothing is the model's.
    for (const end of ofScan ? ends : []) {
      const scan = ofScan!.scan!
      const against = end.part ? (scanSpread(found.scene, layout, end.part.name) ?? scanFrame(found.scene, layout, found.revision, end.part.name, scan.id, scan.aligned.alignment!)) : null
      if (against !== null) return failure(against)
    }
    // An angle is the same wherever the parts are put: they are moved, never turned. A distance is not.
    const apart = args.kind === 'distance' ? spreadApart(found.scene, layout, a.part?.name, b?.part?.name, 'the distance between') : null
    if (apart !== null) return failure(apart)
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
  // Nothing measured to a point of a scan is exact, whatever the kernel says of the distance from that point.
  const scan = a.scan ?? b?.scan
  // Both ends on scans, and not on the same one: what is said of the one alignment is said of the other too.
  const other = a.scan && b?.scan && b.scan.id !== a.scan.id ? b.scan : undefined
  const because = scan ? (other ? `${scan.id} and ${other.id} are scans` : `${scan.id} is a scan`) : undefined
  const taken = scan ? measureReading({ ...measured, exact: false }, a, b, because) : measureReading(measured, a, b)
  if (taken === null) return failure('the kernel did not answer with a measurement')
  const reading = scan ? `${scan.aligned.first}${other?.aligned.first ?? ''}${taken}. ${scan.aligned.last()}${other ? ` ${other.aligned.last()}` : ''}` : taken
  // Of one part (an end that is a bare point is of none): its points are where the part is shown, and that is said.
  // Of two, the points of an angle are apart as torno put the parts, and are left out where it moved one.
  const parts = [...new Map([a, ...(b ? [b] : [])].flatMap((end) => (end.part ? [[end.part.name, end.part] as const] : []))).values()]
  const { points: _points, ...angleOnly } = measured as Measured & { points?: unknown }
  const told = parts.length === 2 && parts.some(isMoved) ? angleOnly : measured
  const ofOther = other ? { other: { scan: other.id, alignment: other.aligned.data, ...noteOf(other.aligned, '') } } : {}
  const ofScan = scan ? { exact: false, scan: scan.id, alignment: scan.aligned.data, ...ofOther, ...noteOf(scan.aligned, layout), approximate: SCAN_APPROXIMATE } : {}
  return reply({ layout, ...ofBuild(deps, objectId), ...clean(told), ...(parts.length === 1 && !scan ? movedForDisplay(parts[0], layout, told) : {}), ...ofScan, reading })
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isVec = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite)

/**
 * A measurement in a line, as a dimension says its own: the value, how it was
 * taken, and of what. `≈` and `approximate` wherever the kernel does not say
 * the value is exact. Null for a reply that is no measurement.
 */
export function measureReading(measured: Measured, a: End, b?: End, ofScan?: string): string | null {
  const ends = b ? `${a.text} to ${b.text}` : a.text
  const how = typeof measured?.how === 'string' ? measured.how : ''
  const exact = measured?.exact === true
  const about = exact ? '' : '≈ '
  // Said once: a way that already says it is approximate is not followed by the word.
  const because = ofScan ? ` (${ofScan})` : ''
  const roughly = exact ? '' : /approximate/.test(how) ? because : `, approximate${because}`
  if (measured?.kind === 'bbox') {
    if (!isVec(measured.size) || !isVec(measured.min) || !isVec(measured.max)) return null
    // A way that says nothing leaves no comma behind.
    const taken = [how, roughly.replace(/^, /, '')].filter(Boolean).join(', ')
    return [`bbox ${about}${sizes(measured.size)} mm`, `from ${vector(measured.min)} to ${vector(measured.max)}`, taken, ends].filter(Boolean).join(', ')
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
      // Of a face, at a point of it; whatever else was named is said as it was named.
      return `${about}${number(value)} mm ${how}${roughly}, ${a.ref !== undefined && at ? `${a.text} at ${vector(at)}` : a.text}${moved(measured)}`
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
    const parts: Part[] = []
    for (const name of two ? [args.a, args.b!] : [args.a]) {
      const checked = checkRef(found.scene, layout, name)
      if (typeof checked === 'string') return failure(checked)
      if (checked.target !== 'part') return failure(`check ${args.kind} is of whole parts, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
      parts.push(checked.part)
    }
    const apart = two ? spreadApart(found.scene, layout, parts[0].name, parts[1].name, args.kind === 'overlap' ? 'what is shared between' : 'the distance between') : null
    if (apart !== null) return failure(apart)
    try {
      return { got: { layout, part: parts[0], checked: await deps.query<object>(objectId, 'check', { kind: args.kind, layout, a: args.a, ...(two ? { b: args.b } : {}) }) } }
    } catch (e) {
      return refusal(e, layout, 'check')
    }
  })
  if ('content' in asked) return asked
  const { layout, part, checked } = asked.got
  const reading = checkReading(args, checked)
  if (reading === null) return failure('the kernel did not answer with a check')
  // Where the open edges of a mesh are is where its part is shown.
  return reply({ layout, ...ofBuild(deps, objectId), kind: args.kind, ...clean(checked), ...(two ? {} : movedForDisplay(part, layout, checked)), reading })
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
  if (args.deflection !== undefined && !(finite(args.deflection) && args.deflection > 0)) return failure(NO_DEFLECTION)
  // The kernel keeps it between 0.005 and 0.05.
  const deflection = args.deflection ?? SECTION_DEFLECTION
  if (args.scan !== undefined && (typeof args.scan !== 'string' || args.scan === '')) return failure('scan is the number of a scan, as listed by scans: {"scan": "S1"}')
  const asked = await ofOneBuild<{ layout: string; cut: Sectioned; scan?: { of: ScanAsked; lines: ScanSectioned } }>(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const plane = planeAsked(deps, objectId, found.obj, args.plane, layout)
    if ('content' in plane) return plane
    for (const name of args.parts ?? []) {
      const checked = checkRef(found.scene, layout, name)
      if (typeof checked === 'string') return failure(checked)
      if (checked.target !== 'part') return failure(`parts are cut whole, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
    }
    // Before the kernel is asked anything: a scan that is not aligned here is cut nowhere.
    let of: ScanAsked | undefined
    if (args.scan !== undefined) {
      const scan = await scanFor(deps, objectId, layout, found.revision, args.scan)
      if ('content' in scan) return scan
      of = scan
    }
    try {
      const cut = await deps.query<Sectioned>(objectId, 'section', { layout, plane, ...(args.parts ? { parts: args.parts } : {}), deflection })
      if (!Array.isArray(cut?.parts) || !isVec(cut.plane?.origin) || !isVec(cut.plane.normal)) return failure('the kernel did not answer with a section')
      if (!of) return { got: { layout, cut } }
      // By the plane as it was given, as the parts were: the two answers are in the same axes.
      const lines = await deps.query<ScanSectioned>(objectId, 'scan_section', { layout, plane, scan: { ...of.wire, ignore: [], only: null } })
      if (!Array.isArray(lines?.polylines)) return failure('the kernel did not answer with where the plane cuts the scan')
      return { got: { layout, cut, scan: { of, lines } } }
    } catch (e) {
      return refusal(e, layout, 'section')
    }
  })
  if ('content' in asked) return asked
  const { layout, cut, scan } = asked.got
  const { found } = asked
  // The build the outlines were cut on, said now: drawing them takes a while, and another build may land meanwhile.
  const of = { ...ofBuild(deps, objectId), revision: found.revision }
  const inLayout = inLayoutOf(found.scene, layout)
  // Torno moved parts of this layout apart: the cut is of them where they are shown.
  const spread = cut.parts.some((part) => isMoved(inLayout(part.part)))

  // The outlines in no more points than an answer has room for: each loop its share of them, by its length.
  const most = pointsFor(cut.parts.flatMap((part) => part.loops))
  const count = { kept: 0, of: 0, omitted: 0 }
  const parts = cut.parts.map((part) => {
    const told = part.loops.filter((loop) => most.get(loop) !== 0)
    count.omitted += part.loops.length - told.length
    return {
      ...clean({ ...part, loops: undefined }),
      ...(spread ? { arranged: inLayout(part.part)?.arranged ?? [0, 0, 0] } : {}),
      ...(told.length < part.loops.length ? { loopsOmitted: part.loops.length - told.length } : {}),
      loops: told.map((loop) => {
        const kept = thinned(loop, most.get(loop) ?? loop.points.length)
        const { points, ...rest } = loop
        count.kept += (kept?.points ?? points).length
        return { ...clean(rest), ...(kept ? { deflection: clean(kept.deflection), thinned: true, of: points.length } : {}), points: tidy(kept?.points ?? points) }
      })
    }
  })
  for (const part of cut.parts) for (const loop of part.loops) count.of += loop.points.length
  const extent = cut.bounds ? ([cut.bounds.max[0] - cut.bounds.min[0], cut.bounds.max[1] - cut.bounds.min[1]] as [number, number]) : null
  const along = axisForm(cut.plane)
  const title = `${planeText(cut.plane)} · layout ${layout}${spread ? ' (parts spread for display)' : ''}`
  const read = extent
    ? `${title}: ${cut.parts.map((part) => (part.loops.length === 0 ? `the plane does not cut ${part.part}` : `${cutText(part)} in ${part.loops.length} loop${part.loops.length === 1 ? '' : 's'}`)).join('; ')}; the cut is ${sizes(extent)} mm`
    : `${title}: the plane cuts ${args.parts ? 'none of these parts' : scan ? 'nothing of the parts' : 'nothing'}`
  const ofScan = scan ? scanLines(scan.of, scan.lines, layout, spread ? cut.parts.filter((part) => isMoved(inLayout(part.part))).map((part) => part.part) : []) : null
  const reading = `${spread ? `${read}. ${SPREAD_NOTE}` : read}${ofScan ? `. ${ofScan.reading}` : ''}`
  // What there is to draw: the parts' cut, or, where the plane cuts none of them, the scan's lines alone.
  const drawn: Sectioned | null = extent ? cut : scan?.lines.bounds && scan.lines.polylines.length > 0 ? { ...cut, bounds: scan.lines.bounds } : null

  const content: ToolResult['content'] = []
  let image: string
  if (!drawn) image = 'not drawn: there is nothing to draw'
  else {
    try {
      const outline = scan && scan.lines.polylines.length > 0 ? { scan: { id: scan.of.scan.id, polylines: scan.lines.polylines } } : {}
      const drawing = await deps.sectionDrawing({ objectId, layout, section: drawn, names: found.scene.parts.map((p) => p.name), size: clampSize(args.size), spread, ...outline })
      content.push({ type: 'image', data: Buffer.from(drawing.png).toString('base64'), mimeType: 'image/png' })
      // The points are [u, v] whichever way the sheet is turned: where v runs down it, that is said.
      const turned = drawing.vDown ? ', v runs down the sheet so that what is up in the world is up on it' : ''
      image = `${drawing.width}×${drawing.height}, ${coloursText(drawing, found.obj)}${turned}, ${await saved(deps, objectId, drawing.png)}`
    } catch (e) {
      // The outlines are the answer: they are given whether or not they could be drawn.
      image = `not drawn: ${messageOf(e)}`
    }
  }
  content.push({
    type: 'text',
    text: JSON.stringify({
      layout,
      ...of,
      ...(spread ? { note: SPREAD_NOTE } : {}),
      plane: { ...clean(cut.plane), ...(along && along.sign > 0 ? { axis: along.axis, at: clean(along.at) } : {}) },
      parts,
      bounds: clean(cut.bounds),
      extent: clean(extent),
      // Fewer points than the kernel gave: how many of how many, and how many loops were left out altogether.
      ...(count.kept < count.of ? { thinned: true, points: count.kept, of: count.of, ...(count.omitted > 0 ? { loopsOmitted: count.omitted } : {}) } : {}),
      ...(ofScan ? { scan: ofScan.data } : {}),
      reading,
      image
    })
  })
  return { content }
}

/**
 * Where a plane cuts a scan, as a section tells it: the lines in no more points than an answer has room for
 * (`MAX_SCAN_LINE_POINTS`, each line its share by its length), how many the kernel found, how the scan is aligned,
 * and a sentence of it. Nothing of it is exact. `moved` are the parts cut that torno moved for display: the scan is
 * not where it is against those.
 */
function scanLines(of: ScanAsked, lines: ScanSectioned, layout: string, moved: string[]): { data: object; reading: string } {
  const id = of.scan.id
  const loops = lines.polylines.map((line): SectionLoop => ({ points: line.points, closed: line.closed, area: null, areaExact: false, deflection: 0 }))
  const most = pointsFor(loops, MAX_SCAN_LINE_POINTS)
  const told = loops.filter((loop) => most.get(loop) !== 0)
  const polylines = told.map((loop) => ({ points: tidy(thinned(loop, most.get(loop) ?? loop.points.length)?.points ?? loop.points), closed: loop.closed }))
  const points = polylines.reduce((sum, line) => sum + line.points.length, 0)
  const found = finite(lines.pointsFound) ? lines.pointsFound : loops.reduce((sum, loop) => sum + loop.points.length, 0)
  const omitted = (finite(lines.omitted) ? lines.omitted : 0) + loops.length - told.length
  const against = moved.length > 0 ? `torno moved ${moved.join(', ')} for display in layout ${layout}: the scan is not where it is against ${moved.length === 1 ? 'that part' : 'those parts'}` : null
  const notes = [...(noteOf(of.aligned, layout).note ? [noteOf(of.aligned, layout).note!] : []), ...(against ? [against] : [])]
  const crosses =
    polylines.length === 0
      ? `${id} (a scan) does not cross the plane`
      : `≈ ${id} (a scan, approximate) crosses the plane in ${polylines.length} line${polylines.length === 1 ? '' : 's'}${points < found ? `, told in ${points.toLocaleString('en-US')} of the ${found.toLocaleString('en-US')} points found` : ''}${omitted > 0 ? `, and ${omitted} more that ${omitted === 1 ? 'is' : 'are'} not told` : ''}`
  return {
    data: {
      id,
      alignment: of.aligned.data,
      polylines,
      points,
      of: found,
      ...(points < found ? { thinned: true } : {}),
      ...(omitted > 0 ? { linesOmitted: omitted } : {}),
      bounds: clean(lines.bounds),
      exact: false,
      ...(notes.length > 0 ? { note: notes.join('. ') } : {}),
      approximate: SCAN_APPROXIMATE
    },
    reading: `${of.aligned.first}${crosses}${against ? ` (${against})` : ''}. ${of.aligned.last()}`
  }
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
function planeAsked(deps: ToolDeps, objectId: string, obj: ObjectInfo, asked: SectionToolArgs['plane'], layout: string): SectionPlane | ToolResult {
  if (asked !== 'current') return planeArg(asked)
  const open = deps.openObjectId()
  if (open !== objectId) return failure(`${notOpen(obj, open)}, so the user's section of it is not known: give a plane`)
  const view = deps.view(objectId)
  if (!view?.section) return failure('the user has no section on screen: give a plane, as {origin, normal} or {axis, at}')
  // Their plane is laid across the parts they are looking at: in another layout it would cut somewhere they never chose.
  if (view.layout !== layout) return failure(`the user's section is of layout ${view.layout}, the one they are viewing, not of ${layout}: leave layout out, or give a plane`)
  return view.section
}

/** How long a loop is, along its points: what its share of the points goes by. Never told: lengths and areas told are the kernel's. */
function lengthOf(loop: Pick<SectionLoop, 'points' | 'closed'>): number {
  const { points } = loop
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  if (loop.closed && points.length > 1) length += Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1])
  return length
}

/**
 * How many points of each loop of a section are told, when together they have
 * more than `budget`: each loop `MIN_LOOP_POINTS` (or all it has), and its
 * share of the rest by its length, never more than it has; what one loop
 * cannot use goes to the others. With more loops than can each have that few,
 * the shortest get none (0): they are left out, and counted. Empty when all
 * the points fit: nothing is thinned.
 */
export function pointsFor(loops: readonly SectionLoop[], budget = MAX_SECTION_POINTS): Map<SectionLoop, number> {
  const most = new Map<SectionLoop, number>()
  if (loops.reduce((sum, loop) => sum + loop.points.length, 0) <= budget) return most
  const byLength = loops.map((loop) => ({ loop, length: lengthOf(loop) })).sort((a, b) => b.length - a.length)
  const fewest = (loop: SectionLoop): number => Math.min(MIN_LOOP_POINTS, loop.points.length)
  // As many of the longest as can each have its fewest.
  let room = budget
  let open = byLength.filter(({ loop }) => {
    if (fewest(loop) > room) return false
    room -= fewest(loop)
    return true
  })
  for (const { loop } of byLength) if (!open.some((one) => one.loop === loop)) most.set(loop, 0)
  // Each has its fewest; what is left of the budget is shared by length, and what a loop cannot use is shared again.
  const extra = new Map<SectionLoop, number>()
  for (;;) {
    const total = open.reduce((sum, one) => sum + one.length, 0)
    const share = (one: { length: number }): number => (total > 0 ? (room * one.length) / total : room / open.length)
    const spare = (loop: SectionLoop): number => loop.points.length - fewest(loop)
    const whole = open.filter((one) => share(one) >= spare(one.loop))
    if (whole.length === 0) {
      for (const one of open) extra.set(one.loop, Math.floor(share(one)))
      break
    }
    for (const one of whole) {
      extra.set(one.loop, spare(one.loop))
      room -= spare(one.loop)
    }
    open = open.filter((one) => !whole.includes(one))
    if (open.length === 0) break
  }
  for (const [loop, more] of extra) most.set(loop, fewest(loop) + more)
  return most
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

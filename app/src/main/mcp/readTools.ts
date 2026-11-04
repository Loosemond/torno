import { valueText } from '../../shared/dimension'
import type { CheckedBed, CheckedClearance, CheckedMesh, CheckedOverhang, CheckedOverlap, CheckedThin, Measured, MeasuredValue, ScanSectioned, SectionLoop, Sectioned } from '../../shared/geometry'
import type { Part, Scene } from '../../shared/scene'
import { type SectionDrawingResult, type SectionPlane, axisForm, cutText, planeText } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { KernelError, isBusy } from '../kernel/client'
import { scanNumber } from '../../shared/format'
import { type FilletDiagnosis, WHY, diagnosisText, sizeText } from '../../shared/diagnosis'
import { number, sizes, vector } from '../marks/describe'
import { clean, sceneDiff } from '../../shared/diff'
import { plain, wire } from '../marks/measure'
import { isMoved, movedForDisplay, spreadApart, spreadLayout } from '../marks/spread'
import { type End, type EndArg, checkRef, endsOf } from './markTools'
import { type ScanAsked, SCAN_APPROXIMATE, noteOf, saidNow, scanFor, scanFrame, scanSpread } from './scanTools'
import type { PlaneArg } from './schemas'
import { type ToolDeps, type ToolResult, SPREAD_NOTE, built, clampSize, failure, layoutFor, messageOf, notOpen, ofBuild, planeArg, tidy } from './tools'

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
export interface TryFilletToolArgs {
  part?: unknown
  edges?: unknown
  radius?: unknown
  kind?: unknown
  layout?: string
}

export interface CheckToolArgs {
  kind: 'overlap' | 'clearance' | 'interference' | 'mesh' | 'overhang' | 'thin' | 'bed'
  a?: string
  b?: string
  layout?: string
  /** overhang: degrees from vertical, default 45. */
  angle?: number
  /** thin: the least wall, mm. */
  min?: number
  /** bed: the bed, [x, y, z] mm. */
  size?: number[]
}

/** The checks of whether it prints: asked of the print layout unless another is named. */
const PRINTABILITY = ['overhang', 'thin', 'bed']
const OVERHANG_ANGLE = 45

/** Said of an end that is a point of a scan, asked for anything but a distance. */
const SCAN_END_DISTANCE = 'only a distance is measured to a point of a scan'
const isScanEnd = (arg: unknown): boolean => typeof arg === 'object' && arg !== null && 'scan' in arg

/**
 * The most points the JSON of a section holds in all, whatever was asked for: the outlines of the parts and
 * the lines of a scan together, each its share by its length. It is what a tool's answer has room for: on a
 * real scan 4,000 and 2,000 more made 49 KB of one reply.
 */
export const MAX_SECTION_POINTS = 1500
/** The fewest points a loop is thinned to, and so the most loops that are told: the smallest beyond them are counted. */
export const MIN_LOOP_POINTS = 8
export const MAX_SECTION_LOOPS = Math.floor(MAX_SECTION_POINTS / MIN_LOOP_POINTS)
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

export { clean }

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
      const against = end.part ? (scanSpread(found.scene, layout, end.part.name, { id: scan.id, alignments: scan.alignments }) ?? scanFrame(found.scene, layout, found.revision, end.part.name, scan.id, scan.aligned.alignment!)) : null
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
      const measured = await deps.query<Measured>(objectId, 'measure', request)
      // What is said of a scan's alignment is read once the kernel has answered: a check of this build has been by then.
      for (const one of ends) if (one.scan) one.scan.aligned = await saidNow(deps, objectId, layout, found.revision, one.scan.id, one.scan.aligned)
      return { got: { layout, a, b, measured } }
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
      // To a point of a scan: to the tenth, which is finer than any scan is true.
      return `${about}${ofScan ? (Math.abs(value) < 0.05 ? 'under 0.1' : scanNumber(value)) : number(value)} mm ${how}${roughly}, ${ends}`
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
      return `mass ${about}${number(value)} g, ${how}${roughly}, ${ends}${finite(measured.volume) ? ` (volume ${about}${number(measured.volume)} mm³)` : ''}`
    default:
      return null
  }
}

/** Said of a wall measured from another point than the one given: the kernel laid it on the face. */
function moved(measured: MeasuredValue): string {
  return finite(measured.moved) && number(measured.moved) !== '0' ? ` (the point was moved ${number(measured.moved)} mm onto the face)` : ''
}

export async function checkTool(deps: ToolDeps, objectId: string, args: CheckToolArgs): Promise<ToolResult> {
  const two = args.kind === 'overlap' || args.kind === 'clearance'
  const whole = args.kind === 'bed' || args.kind === 'interference'
  if (two && args.b === undefined) return failure(`${args.kind} is of two parts: give b`)
  if (!two && args.b !== undefined) return failure(`${args.kind} is of ${whole ? 'the whole layout' : 'the part a alone'}: leave b out`)
  if (whole && args.a !== undefined) return failure(`${args.kind} is of the whole layout: leave a out`)
  if (!whole && args.a === undefined) return failure(`${args.kind} is of the part a: give a`)
  if (args.kind === 'thin' && args.min === undefined) return failure(`thin needs min, the least wall in mm: {"kind": "thin", "a": "${args.a}", "min": 0.8}`)
  if (args.kind === 'bed' && args.size === undefined) return failure('bed needs size, the bed in mm: {"kind": "bed", "size": [256, 256, 256]}')
  const extra = args.kind === 'overhang' ? { angle: args.angle ?? OVERHANG_ANGLE } : args.kind === 'thin' ? { min: args.min } : args.kind === 'bed' ? { size: args.size } : {}

  const asked = await ofOneBuild(deps, objectId, async (found) => {
    // Whether it prints is of the print layout, where the model has one and no other is asked for.
    const printLayout = PRINTABILITY.includes(args.kind) && args.layout === undefined && found.scene.layouts.includes('print') ? 'print' : args.layout
    const layout = layoutFor(deps, objectId, found.scene, printLayout)
    if (typeof layout !== 'string') return layout
    if (args.kind === 'interference') {
      const apart = spreadLayout(found.scene, layout, 'what the parts share in')
      if (apart !== null) return failure(apart)
    }
    if (whole) {
      try {
        return { got: { layout, part: null as Part | null, checked: await deps.query<object>(objectId, 'check', { kind: args.kind, layout, ...extra }) } }
      } catch (e) {
        return refusal(e, layout, 'check', 'the layout')
      }
    }
    const parts: Part[] = []
    for (const name of two ? [args.a!, args.b!] : [args.a!]) {
      const checked = checkRef(found.scene, layout, name)
      if (typeof checked === 'string') return failure(checked)
      if (checked.target !== 'part') return failure(`check ${args.kind} is of whole parts, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
      parts.push(checked.part)
    }
    const apart = two ? spreadApart(found.scene, layout, parts[0].name, parts[1].name, args.kind === 'overlap' ? 'what is shared between' : 'the distance between') : null
    if (apart !== null) return failure(apart)
    try {
      return { got: { layout, part: parts[0] as Part | null, checked: await deps.query<object>(objectId, 'check', { kind: args.kind, layout, a: args.a, ...(two ? { b: args.b } : {}), ...extra }) } }
    } catch (e) {
      return refusal(e, layout, 'check')
    }
  })
  if ('content' in asked) return asked
  const { layout, part, checked } = asked.got
  const reading = checkReading(args, checked)
  if (reading === null) return failure('the kernel did not answer with a check')
  // Where the open edges of a mesh are is where its part is shown.
  return reply({ layout, ...ofBuild(deps, objectId), kind: args.kind, ...clean(checked), ...(two || part === null ? {} : movedForDisplay(part, layout, checked)), reading })
}

/** The most edges one trial takes: the kernel's `MOST_TRIAL_EDGES`. */
const MOST_TRIAL_EDGES = 200
const TRY_PART = 'try_fillet needs part, the name of a part as scene lists it: {"part": "lid", "edges": ["lid/E3"], "radius": 2}'
const TRY_EDGES = (part: string): string => `edges is a list of refs of edges of ${part}, as describe and the pointer give them: ["${part}/E3", "${part}/E7"]`
const TRY_RADIUS = 'radius is the radius of the fillet (or the length of the chamfer), a number of mm above 0: 2'

/**
 * A fillet or a chamfer of some edges of a part, tried by the kernel on the last build that worked and thrown away
 * (`try_fillet` in queries.py): whether it works and, when it does not, why (`diagnose.py`: the edges that fail
 * alone, the pairs that fail, the largest radius that works, bisected), with a reading (`diagnosisText`). Its
 * edges are named by their refs, of that build, in the frame of the layout. It changes nothing.
 */
export async function tryFilletTool(deps: ToolDeps, objectId: string, args: TryFilletToolArgs): Promise<ToolResult> {
  if (typeof args.part !== 'string' || args.part === '') return failure(TRY_PART)
  const kind = args.kind ?? 'fillet'
  if (kind !== 'fillet' && kind !== 'chamfer') return failure('kind is fillet (the default) or chamfer')
  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const named = checkRef(found.scene, layout, args.part as string)
    if (typeof named === 'string') return failure(named)
    if (named.target !== 'part') return failure(`part is a part, not ${named.target === 'face' ? 'a face' : 'an edge'}: give ${named.part.name}`)
    const part = named.part
    const edges = args.edges
    if (!Array.isArray(edges) || edges.length === 0 || edges.length > MOST_TRIAL_EDGES || !edges.every((e) => typeof e === 'string')) return failure(TRY_EDGES(part.name))
    for (const ref of edges as string[]) {
      const edge = checkRef(found.scene, layout, ref)
      if (!ref.startsWith(`${part.name}/E`) || (typeof edge !== 'string' && edge.target !== 'edge')) return failure(`${ref} is not an edge of ${part.name}: give edges of ${part.name}, ${part.name}/E<n>`)
      // Of the part, and past its last edge: said with how many it has.
      if (typeof edge === 'string') return failure(edge)
    }
    if (typeof args.radius !== 'number' || !Number.isFinite(args.radius) || args.radius <= 0) return failure(TRY_RADIUS)
    try {
      const tried = await deps.query<FilletDiagnosis & { works: boolean }>(objectId, 'try_fillet', { part: `${layout}:${part.name}`, edges, radius: args.radius, kind })
      return { got: { layout, part, tried } }
    } catch (e) {
      return refusal(e, layout, 'trial')
    }
  })
  if ('content' in asked) return asked
  const { layout, part, tried } = asked.got
  const head = `Tried on r${asked.found.revision} and thrown away, nothing changed: `
  const reading = tried.works
    ? `${head}${tried.operation} ${sizeText(tried.operation, tried.size)} of ${tried.edgeCount} edge${tried.edgeCount === 1 ? '' : 's'} works.`
    : `${head}${diagnosisText(tried).slice(WHY.length)}`
  return reply({ layout, ...ofBuild(deps, objectId), part: part.name, ...clean(tried), ...movedForDisplay(part, layout, { points: tried.edges ?? [] }), reading })
}

/** A check in a line. Null for a reply that is none. */
export function checkReading(args: Pick<CheckToolArgs, 'kind' | 'a' | 'b'>, checked: object): string | null {
  // Exact unless the kernel says otherwise: a clearance by `exact`, what two parts share by `volumeExact` and `bboxExact`.
  const about = (checked as { exact?: unknown } | null)?.exact === false ? '≈ ' : ''
  const roughly = about ? ', approximate' : ''
  const pair = `between ${args.a} and ${args.b}`
  // A boolean of a part with a solid turned inside out is no answer to rely on, nor whether two such overlap: the kernel names the parts.
  const reversed = (checked as { reversed?: unknown } | null)?.reversed
  const inside = Array.isArray(reversed) ? reversed.filter((name): name is string => typeof name === 'string') : []
  const broken = inside.length > 0 ? `; ${inside.join(' and ')} ${inside.length === 1 ? 'has' : 'have'} a solid turned inside out (reversed), so this is not to be relied on` : ''
  if (args.kind === 'overlap') {
    const { volume, bbox } = checked as Partial<CheckedOverlap>
    const { volumeExact, bboxExact, how } = checked as { volumeExact?: unknown; bboxExact?: unknown; how?: unknown }
    if (!finite(volume)) return null
    if (!bbox || !isVec(bbox.min) || !isVec(bbox.max)) return `no overlap ${pair}${broken}`
    // The common volume of freeform parts is integrated: told with ≈ and how good the kernel says it is.
    const rough = volumeExact === false
    const good = rough ? ` (${typeof how === 'string' && how.includes('approximate') ? how.slice(how.indexOf('approximate')) : 'approximate'})` : ''
    return `overlap ${rough ? '≈ ' : about}${number(volume)} mm³ ${pair}${good}${roughly}, within ${bboxExact === false ? '≈ ' : ''}${vector(bbox.min)} to ${vector(bbox.max)}${broken}`
  }
  if (args.kind === 'clearance') {
    const { distance, overlapping, how } = checked as Partial<CheckedClearance>
    if (!finite(distance)) return null
    const base = `clearance ${about}${number(distance)} mm ${pair}${roughly}`
    if (overlapping === true) return `${base}: the parts overlap${broken}`
    // Of a part that is no solid the kernel says how far, and that it cannot say whether they overlap.
    if (overlapping !== false) return `${base}${typeof how === 'string' && how ? ` (${how})` : ''}${broken}`
    return `${distance === 0 ? `${base}: the parts touch` : base}${broken}`
  }
  if (args.kind === 'interference') return interferenceReading(checked)
  if (args.kind === 'overhang' || args.kind === 'thin' || args.kind === 'bed') return printReading(args, checked)
  const { watertight, openEdges, where, triangles } = checked as Partial<CheckedMesh>
  if (typeof watertight !== 'boolean' || !finite(openEdges) || !finite(triangles)) return null
  const count = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
  if (watertight) return `mesh of ${args.a}: closed, ${count(triangles, 'triangle')}`
  if (triangles === 0) return `mesh of ${args.a}: no triangles`
  const first = Array.isArray(where) && isVec(where[0]) ? `, first at ${vector(where[0])}` : ''
  return `mesh of ${args.a}: OPEN, ${count(openEdges, 'open edge')}${first}`
}

/** The pairs of a layout that share volume, in a line. Null for a reply that is none. */
function interferenceReading(checked: object): string | null {
  type Pair = { a?: unknown; b?: unknown; volume?: unknown; volumeExact?: unknown }
  const { layout, parts, interfering, touching, clear, sampling, notSolid, listCut } = checked as {
    layout?: unknown; parts?: unknown; interfering?: Pair[]; touching?: Pair[]; clear?: unknown
    sampling?: { measured?: unknown; of?: unknown; complete?: unknown }; notSolid?: unknown; listCut?: unknown
  }
  if (!finite(parts) || !finite(clear) || !Array.isArray(interfering) || !Array.isArray(touching)) return null
  const reversed = (checked as { reversed?: unknown }).reversed
  const names = (list: unknown): string[] => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [])
  const count = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
  const tell = (p: Pair): string => `${p.a} and ${p.b}${finite(p.volume) ? ` ${p.volumeExact === false ? '≈ ' : ''}${number(p.volume)} mm³` : ''}`
  const more = listCut === true ? ' (the list is cut)' : ''
  const head = `${layout === undefined ? 'layout' : String(layout)}: ${count(parts, 'solid part')}`
  const sharing = interfering.length === 0 ? 'no pair shares volume' : `${count(interfering.length, 'pair')} share${interfering.length === 1 ? 's' : ''} volume (${interfering.slice(0, REFS_READ).map(tell).join('; ')}${interfering.length > REFS_READ ? `; and ${interfering.length - REFS_READ} more` : ''})${more}`
  const touches = touching.length === 0 ? '' : `, ${count(touching.length, 'pair')} only touch${touching.length === 1 ? 'es' : ''} (${touching.slice(0, REFS_READ).map((p) => `${p.a} and ${p.b}`).join('; ')}${touching.length > REFS_READ ? `; and ${touching.length - REFS_READ} more` : ''})`
  const cut = sampling?.complete === false && finite(sampling.measured) && finite(sampling.of) ? `; the time ran out after ${sampling.measured} of ${sampling.of} pairs whose boxes meet, the rest are NOT measured` : ''
  const left = names(notSolid).length > 0 ? `; left out, not solids: ${names(notSolid).join(', ')}` : ''
  const broken = names(reversed).length > 0 ? `; ${names(reversed).join(' and ')} ${names(reversed).length === 1 ? 'has' : 'have'} a solid turned inside out (reversed), so this is not to be relied on` : ''
  return `${head}: ${sharing}${touches}; ${count(clear, 'pair')} clear${cut}${left}${broken}`
}

/** At most so many refs are named in a reading: the data holds them all. */
const REFS_READ = 5
const AXES = ['x', 'y', 'z']

/** An overhang, the thin walls or the fit on a bed, in a line. Null for a reply that is none. */
function printReading(args: Pick<CheckToolArgs, 'kind' | 'a'>, checked: object): string | null {
  const count = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
  const refs = (faces: Array<{ ref?: unknown }>, total: number): string => {
    const named = faces.slice(0, REFS_READ).map((f) => String(f.ref)).join(', ')
    return ` (${named}${total > REFS_READ ? `, and ${total - REFS_READ} more` : ''})`
  }
  if (args.kind === 'overhang') {
    const { angle, faces, count: total, area, exact } = checked as Partial<CheckedOverhang>
    if (!finite(angle) || !Array.isArray(faces) || !finite(area)) return null
    const of = `of ${args.a} beyond ${number(angle)}° from vertical`
    if (faces.length === 0) return `no overhang ${of}`
    const n = finite(total) ? total : faces.length
    const rough = exact === false
    return `overhang ${of}: ${count(n, 'face')}, ${rough ? '≈ ' : ''}${number(area)} mm²${refs(faces, n)}${rough ? ', approximate: curved faces judged by sampled normals' : ''}`
  }
  if (args.kind === 'thin') {
    const { min, faces, count: total, thinnest, sampling } = checked as Partial<CheckedThin>
    if (!finite(min) || !Array.isArray(faces)) return null
    const cut = sampling?.complete === false ? '; the time ran out before every face was' : ''
    const approximate = `, approximate: sampled at points of each face${cut}`
    const least = thinnest && finite(thinnest.value) ? thinnest : null
    if (faces.length === 0) return `no wall of ${args.a} under ${number(min)} mm where sampled${least ? `, thinnest ≈ ${number(least.value)} mm` : ''}${approximate}`
    const n = finite(total) ? total : faces.length
    return `walls of ${args.a} under ${number(min)} mm: ${count(n, 'face')}${least ? `, thinnest ≈ ${number(least.value)} mm at ${least.ref}` : ''}${refs(faces, n)}${approximate}`
  }
  const { layout, bed, size, fits, over, exact } = checked as Partial<CheckedBed>
  if (typeof fits !== 'boolean' || !isVec(bed) || !isVec(size) || !isVec(over)) return null
  const rough = exact === false
  const times = (v: number[]): string => v.map((x) => number(x)).join(' × ')
  const head = `${layout ?? 'the'} layout ${fits ? 'fits' : 'does NOT fit'} a bed of ${times(bed)} mm: it is ${rough ? '≈ ' : ''}${times(size)} mm`
  const beyond = over.map((by, i) => (by > 0 ? `${number(by)} mm along ${AXES[i]}` : null)).filter((x) => x !== null)
  return `${head}${beyond.length > 0 ? `, over by ${beyond.join(' and ')}` : ''}${rough ? ', approximate' : ''}`
}

export async function sectionTool(deps: ToolDeps, objectId: string, args: SectionToolArgs): Promise<ToolResult> {
  if (args.parts?.length === 0) return failure('parts is empty: name the parts to cut, or leave it out for all of them')
  if (args.deflection !== undefined && !(finite(args.deflection) && args.deflection > 0)) return failure(NO_DEFLECTION)
  // The kernel keeps it between 0.005 and 0.05.
  const deflection = args.deflection ?? SECTION_DEFLECTION
  if (args.scan !== undefined && (typeof args.scan !== 'string' || args.scan === '')) return failure('scan is the number of a scan, as listed by scans: {"scan": "S1"}')
  const asked = await ofOneBuild<{ layout: string; cut: Sectioned; scan?: { of: ScanAsked; lines: ScanSectioned; drawn: ScanSectioned } }>(deps, objectId, async (found) => {
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
      // The kernel is told how many points to tell: first as many as a reply holds, which the drawing is made from;
      // then, when the parts' outlines need room too, the scan's share of it by length. Its lines are thinned by it, once.
      const cutScan = async (points: number): Promise<ScanSectioned | ToolResult> => {
        const lines = await deps.query<ScanSectioned>(objectId, 'scan_section', { layout, plane, points, scan: { ...of.wire, ignore: [], only: null } })
        return Array.isArray(lines?.polylines) ? lines : failure('the kernel did not answer with where the plane cuts the scan')
      }
      const drawn = await cutScan(MAX_SECTION_POINTS)
      if ('content' in drawn) return drawn
      const share = scanShare(cut, drawn)
      const lines = share === null ? drawn : share < MIN_SCAN_POINTS ? { ...drawn, polylines: [], omitted: (finite(drawn.omitted) ? drawn.omitted : 0) + drawn.polylines.length, thinned: true } : await cutScan(share)
      if ('content' in lines) return lines
      return { got: { layout, cut, scan: { of: { ...of, aligned: await saidNow(deps, objectId, layout, found.revision, of.scan.id, of.aligned) }, lines, drawn } } }
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

  // The outlines in no more points than the answer has room for beside the scan's lines: each loop its share of them, by its length.
  const ofScanPoints = scan ? scan.lines.polylines.reduce((sum, line) => sum + line.points.length, 0) : 0
  const most = pointsFor(cut.parts.flatMap((part) => part.loops), Math.max(0, MAX_SECTION_POINTS - ofScanPoints))
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
  // What was thinned is said: the drawing and the areas are of the outlines in full, the points told are not all of them.
  const fewer = count.kept < count.of ? `, its outlines told in ${count.kept.toLocaleString('en-US')} of the ${count.of.toLocaleString('en-US')} points cut (a reply holds ${MAX_SECTION_POINTS.toLocaleString('en-US')} in all)` : ''
  const read = extent
    ? `${title}: ${cut.parts.map((part) => (part.loops.length === 0 ? `the plane does not cut ${part.part}` : `${cutText(part)} in ${part.loops.length} loop${part.loops.length === 1 ? '' : 's'}`)).join('; ')}; the cut is ${sizes(extent)} mm${fewer}`
    : `${title}: the plane cuts ${args.parts ? 'none of these parts' : scan ? 'nothing of the parts' : 'nothing'}`
  const ofScan = scan ? scanLines(scan.of, scan.lines, layout, spread ? cut.parts.filter((part) => isMoved(inLayout(part.part))).map((part) => part.part) : []) : null
  // The note ends in its own full stop.
  const reading = `${spread ? `${read}. ${ofScan ? SPREAD_NOTE.replace(/\.$/, '') : SPREAD_NOTE}` : read}${ofScan ? `. ${ofScan.reading}` : ''}`
  // What there is to draw: the parts' cut, or, where the plane cuts none of them, the scan's lines alone.
  const drawn: Sectioned | null = extent ? cut : scan?.drawn.bounds && scan.drawn.polylines.length > 0 ? { ...cut, bounds: scan.drawn.bounds } : null

  const content: ToolResult['content'] = []
  let image: string
  if (!drawn) image = 'not drawn: there is nothing to draw'
  else {
    try {
      const outline = scan && scan.drawn.polylines.length > 0 ? { scan: { id: scan.of.scan.id, polylines: scan.drawn.polylines } } : {}
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
      ...(count.kept < count.of ? { thinned: true, points: count.kept, of: count.of, budget: MAX_SECTION_POINTS, ...(count.omitted > 0 ? { loopsOmitted: count.omitted } : {}) } : {}),
      ...(ofScan ? { scan: ofScan.data } : {}),
      reading,
      image
    })
  })
  return { content }
}

/** The fewest points the kernel tells a scan's lines in. */
const MIN_SCAN_POINTS = 2

/**
 * How many points a scan's lines get of what a section's answer holds, when they and the parts' outlines
 * together have more than that: its lines' share by their length, as every loop has its own (`pointsFor`).
 * Null when all of it fits as the kernel told it.
 */
function scanShare(cut: Sectioned, lines: ScanSectioned): number | null {
  const ofScan = lines.polylines.map((line): SectionLoop => ({ points: line.points, closed: line.closed, area: null, areaExact: false, deflection: 0 }))
  const most = pointsFor([...cut.parts.flatMap((part) => part.loops), ...ofScan])
  if (most.size === 0) return null
  const share = ofScan.reduce((sum, loop) => sum + (most.get(loop) ?? loop.points.length), 0)
  return share < ofScan.reduce((sum, loop) => sum + loop.points.length, 0) ? share : null
}

/**
 * Where a plane cuts a scan, as a section tells it: the lines as the kernel told them, in as many points as it
 * was asked for (the scan's share of what the answer holds), to the tenth of a millimetre; how many it found,
 * how the scan is aligned, and a sentence of it. Nothing of it is exact. `moved` are the parts cut that torno
 * moved for display: the scan is not where it is against those.
 */
function scanLines(of: ScanAsked, lines: ScanSectioned, layout: string, moved: string[]): { data: object; reading: string } {
  const id = of.scan.id
  const polylines = lines.polylines.map((line) => ({ points: tidy(line.points), closed: line.closed }))
  const points = polylines.reduce((sum, line) => sum + line.points.length, 0)
  const found = finite(lines.pointsFound) ? lines.pointsFound : points
  const omitted = finite(lines.omitted) ? lines.omitted : 0
  const against = moved.length > 0 ? `torno moved ${moved.join(', ')} for display in layout ${layout}: the scan is not where it is against ${moved.length === 1 ? 'that part' : 'those parts'}` : null
  const notes = [...(noteOf(of.aligned, layout).note ? [noteOf(of.aligned, layout).note!] : []), ...(against ? [against] : [])]
  const untold = omitted > 0 ? `${omitted} ${polylines.length > 0 ? 'more ' : ''}that ${omitted === 1 ? 'is' : 'are'} not told` : ''
  const crosses =
    polylines.length === 0
      ? omitted > 0
        ? `≈ ${id} (a scan, approximate) crosses the plane in ${omitted} line${omitted === 1 ? '' : 's'} ${untold.replace(/^\d+ /, '')}: the parts' outlines took the room, ask for it with fewer parts`
        : `${id} (a scan) does not cross the plane`
      : `≈ ${id} (a scan, approximate) crosses the plane in ${polylines.length} line${polylines.length === 1 ? '' : 's'}${points < found ? `, told in ${points.toLocaleString('en-US')} of the ${found.toLocaleString('en-US')} points found` : ''}${untold ? `, and ${untold}` : ''}`
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
  return drawing.colours === 'window' ? 'the parts in the colours the user sees them in' : `the parts in their default colours (${obj.name} is not the project open in the torno window)`
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

/** Said when the two builds `diff` compares were made from the same sources. */
export const DIFF_SAME_SOURCES = 'Both builds were made from the same sources (the .py files of the project and common/ hash alike), so the model did not change between them.'

export interface DiffToolArgs {
  from?: number
  to?: number
}

type Kept = { revision: number; scene: Scene }

/**
 * What changed between two successful builds that main keeps (`Builds.scenes`: the last two), from what the
 * kernel said of each part as it built it: no query. Nothing is said to be exact that either build does not say is.
 */
export function diffTool(deps: ToolDeps, objectId: string, args: DiffToolArgs): ToolResult {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const kept: Kept[] = deps.scenes?.(objectId) ?? [{ revision: found.revision, scene: found.scene }]
  const revisions = kept.map((k) => k.revision)
  if (kept.length < 2) return failure(`only one successful build so far (revision ${revisions.join(', ')}): there is nothing to compare it with yet`)
  const listed = `revisions ${revisions.slice(0, -1).join(', ')} and ${revisions.at(-1)} are`
  const pick = (revision: number | undefined, fallback: Kept): Kept | ToolResult => {
    if (revision === undefined) return fallback
    return kept.find((k) => k.revision === revision) ?? failure(`revision ${revision} is not kept: ${listed}`)
  }
  const from = pick(args.from, kept.at(-2)!)
  if ('content' in from) return from
  const to = pick(args.to, kept.at(-1)!)
  if ('content' in to) return to

  const diffed = sceneDiff(from.scene, to.scene)
  // What each build was made from, so that a difference that is none of the model's (the same sources) is not taken for one.
  const was = deps.identity?.(objectId, from.revision)
  const now = deps.identity?.(objectId, to.revision)
  const builds = was || now ? { from: { revision: from.revision, ...(was ?? {}) }, to: { revision: to.revision, ...(now ?? {}) } } : undefined
  const notes = [...diffed.notes, ...(was && now && was.sources === now.sources ? [DIFF_SAME_SOURCES] : [])]
  return reply(clean({ object: found.obj.id, from: from.revision, to: to.revision, ...(builds ? { builds } : {}), layouts: diffed.layouts, ...(notes.length > 0 ? { notes } : {}) }))
}

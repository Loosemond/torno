import { apply } from '../../shared/align'
import type { ScanClashed, ScanDeviated } from '../../shared/geometry'
import type { Mark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import { type ScanAlignment, type ScanInfo, type ScanTransform, importText } from '../../shared/scans'
import { number, vector } from '../marks/describe'
import { type AlignmentSaid, alignmentSaid, shownText } from '../scans/said'
import { checkRef } from './markTools'
import { clean, ofOneBuild, refusal } from './readTools'
import { type ToolDeps, type ToolResult, MARK_ID, built, failure, layoutFor, marksOf, messageOf, ofBuild } from './tools'

// The agent's tools for scans: `scans`, `scan_clash` and `scan_deviation`, and what the other tools need to take a
// scan (`scanFor`, the guards). A scan is a mesh of the real thing, measured by a phone or a scanner and put where
// the person aligned it: nothing told of one is exact, every answer says how it is aligned in the layout asked,
// and nothing is asked of the kernel where the scan is not aligned, or of a part that is not where the model has it.

type Vec3 = [number, number, number]

export const SCAN_APPROXIMATE = 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact'
export const PRINT_NOTE = 'layout print poses the parts for the bed: a part is where it is mounted only if the model leaves it there'
export const NO_SCANS = 'this object has no scans: the user imports one in the Scans panel of the torno window'

/** How far round a part scan points are looked at, mm: the kernel's own default and limits (`scanclash.clash`). */
const MARGIN = { least: 0, most: 50, usual: 5 }
/** How many points a deviation measures, and how far from each the other is looked for, mm: the kernel's own limits (`scanclash.deviation`). */
const SAMPLES = { least: 100, most: 20_000, usual: 10_000 }
const WITHIN = { least: 0.1, most: 200, usual: 50 }

export interface ScansArgs { layout?: string }
export interface ScanClashArgs { part: string; scan?: string; ignore?: string[]; margin?: number; layout?: string }
export interface ScanDeviationArgs { part: string; faces?: string[]; scan?: string; region?: string; from?: 'part' | 'scan'; within?: number; samples?: number; layout?: string }

const NO_PART = 'part is the name of a part, as listed by scene: {"part": "tub"}'
const NO_SCAN_ID = 'scan is the number of a scan, as listed by scans: {"scan": "S1"}'
const NO_MARGIN = `margin is a number of mm from ${MARGIN.least} to ${MARGIN.most} (default ${MARGIN.usual}), how far round the part scan points are looked at: {"part": "tub", "margin": 5}`
const NO_IGNORE = 'ignore is a list of the numbers of region marks to leave out: {"part": "tub", "ignore": ["M7"]}'
const NO_SAMPLES = 'samples is a whole number from 100 to 20,000 (default 10,000), how many points are measured: {"part": "tub", "samples": 10000}'
const NO_WITHIN = `within is a number of mm from ${WITHIN.least} to ${WITHIN.most} (default ${WITHIN.usual}), how far from each point the other is looked for: {"part": "tub", "within": 50}`
const NO_FROM = 'from is "part" (points of the part, each to the scan; the default) or "scan" (points of the scan, each to the part): {"part": "tub", "from": "scan"}'
const NO_FACES = 'faces is a list of refs of faces of the part: {"part": "tub", "faces": ["tub/F5"]}'
const NO_REGION = 'region is the number of one region mark of the scan: {"part": "tub", "region": "M7"}'

const count = (n: number): string => n.toLocaleString('en-US')
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const between = (value: unknown, range: { least: number; most: number }): value is number => finite(value) && value >= range.least && value <= range.most
const isVec = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(finite)
const nth = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`
const reply = (value: object): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/**
 * A region of a scan, as far as these tools read one: a mark of kind `region` (Task 8 adds it to `Mark`), whose
 * triangles are the mask beside the scan's mesh. `local` is in the scan's own frame.
 */
export interface RegionOfScan { id: string; kind: 'region'; scan: string; note: string; anchorState: string; local?: { centroid?: Vec3 } }
export const isRegion = (mark: Mark | undefined): boolean => (mark as { kind?: string } | undefined)?.kind === 'region'
export const regionsOf = (marks: readonly Mark[], scan: string): RegionOfScan[] => (marks as unknown as RegionOfScan[]).filter((mark) => mark.kind === 'region' && mark.scan === scan)

/** The scans of an object, or the error to answer with: the object is not in the workspace, or its scans cannot be read. */
async function scansOf(deps: ToolDeps, objectId: string): Promise<ScanInfo[] | ToolResult> {
  if (!deps.object(objectId)) return failure(`unknown object: ${objectId}`)
  try {
    return await deps.scans(objectId)
  } catch (e) {
    return failure(messageOf(e))
  }
}

/** A scan a tool was asked about, where it is aligned, as the kernel is given it. */
export interface ScanAsked {
  scan: ScanInfo
  alignment: ScanAlignment
  /** What is said of that alignment, as of the build asked (`alignmentSaid`): every reply and reading takes its words from here. */
  aligned: AlignmentSaid
  wire: { id: string; path: string; transform: ScanTransform }
  /** Where a region's mask is. */
  mask(markId: string): string
}

/**
 * The scan a tool is asked about (the only one, when none is named), aligned in the layout, as the kernel is given
 * it; or the refusal, each with what to do: there are no scans, several and none named, none of that number, one
 * whose files are being written, one whose mesh is gone, one that is not aligned in that layout. The scans are read
 * here and their paths taken at once after (`ScanStore.paths` is of the scans as last read).
 */
export async function scanFor(deps: ToolDeps, objectId: string, layout: string, revision: number, asked: string | undefined): Promise<ScanAsked | ToolResult> {
  if (asked !== undefined && (typeof asked !== 'string' || asked === '')) return failure(NO_SCAN_ID)
  const scans = await scansOf(deps, objectId)
  if ('content' in scans) return scans
  const busy = deps.scansBusy(objectId)
  // A first import has its number before it is a scan: asked for meanwhile, it is neither unknown nor there.
  const coming = busy.filter((id) => !scans.some((scan) => scan.id === id))
  const importing = (id: string): ToolResult => failure(`${id} is still being imported into this object: ask again when that is done`)
  if (asked !== undefined && coming.includes(asked)) return importing(asked)
  if (scans.length === 0) return coming.length > 0 ? importing(coming.join(', ')) : failure(NO_SCANS)
  if (asked === undefined && scans.length > 1) return failure(`name the scan: ${scans.map((scan) => `${scan.id} (${scan.name})`).join(', ')}`)
  const scan = asked === undefined ? scans[0] : scans.find((one) => one.id === asked)
  if (!scan) return failure(`no scan ${asked}; scans: ${scans.map((one) => one.id).join(', ')}`)
  if (busy.includes(scan.id)) return failure(`${scan.id} is being converted or imported again: ask again when that is done`)
  const paths = deps.scanPaths(objectId, scan.id)
  if (!paths) return failure(`${scan.id} was removed while this was asked: call scans for those there are`)
  if (scan.meshState !== 'ok') return failure(`${scan.id}'s mesh is gone from ${paths.mesh}: the user imports it again from its row in the Scans panel`)
  const aligned = alignmentSaid(scan, layout, revision)
  if (aligned.refused !== null || !aligned.alignment) return failure(aligned.refused ?? `${scan.id} is not aligned in layout ${layout}`)
  const { alignment } = aligned
  return { scan, alignment, aligned, wire: { id: scan.id, path: paths.mesh, transform: alignment.transform }, mask: (markId) => paths.mask(markId) }
}

/** How far torno moved a part to set it beside the others, when it did: a part left where the model placed it has none, or zeros. */
const movedBy = (part: Part | undefined): Vec3 | null => (part?.arranged?.some((c) => Math.abs(c) > 1e-6) ? part.arranged : null)
const inLayout = (scene: Scene, layout: string): Part[] => scene.parts.filter((p) => p.layout === layout)

/**
 * Why a part cannot be checked against a scan where torno moved it, in full, or null: a scan stands where the
 * model's frame has it, and a part torno moved for display is not there. Names the layouts that place the part
 * as the model does, or says to add one, and the parts of this layout that were not moved.
 */
export function scanSpread(scene: Scene, layout: string, part: string): string | null {
  const parts = inLayout(scene, layout)
  if (!movedBy(parts.find((p) => p.name === part))) return null
  const placed = scene.layouts.filter((of) => of !== layout && scene.parts.some((p) => p.layout === of && p.name === part && !movedBy(p)))
  const still = parts.filter((p) => !movedBy(p)).map((p) => p.name)
  const others = still.length > 0 ? `, or check a part torno did not move (${still.join(', ')})` : ''
  const where =
    placed.length > 0
      ? `Ask in a layout that places ${part} as the model does (layouts: ${placed.join(', ')})${others}.`
      : `This object has no layout that places ${part} as it is mounted: add one to the model (def assembly(p))${others}.`
  return `In layout ${layout} torno moved ${part} for display (the parts overlapped as the model placed them), so where the scan is against it there is torno's, not the model's. ${where}`
}

/**
 * Why a part cannot be checked against a scan whose alignment was made on another frame, or null: when the scan was
 * put where it is, torno had this part moved for display (`ScanAlignment.frame`), and the build asked has it
 * elsewhere. Where the scan is against that part was torno's then and is nobody's now. A part the alignment says
 * nothing of came with a later build, and a part that stands as it did is answered.
 */
export function scanFrame(scene: Scene, layout: string, revision: number, part: string, scan: string, alignment: ScanAlignment): string | null {
  const stood = (name: string): boolean => {
    const then = Object.hasOwn(alignment.frame, name) ? alignment.frame[name] : undefined
    const now = movedBy(inLayout(scene, layout).find((p) => p.name === name)) ?? [0, 0, 0]
    return !isVec(then) || then.every((c, axis) => Math.abs(c - now[axis]) <= 1e-6)
  }
  if (stood(part)) return null
  const still = inLayout(scene, layout).filter((p) => p.name !== part && !movedBy(p) && stood(p.name)).map((p) => p.name)
  return `${scan} was aligned in layout ${layout} while torno had ${part} moved by ${vector(alignment.frame[part])} for display, and r${revision} has it where the model places it: where the scan is against ${part} is not known. The user aligns it again with the Align tool${still.length > 0 ? `; a part that stands as it did then can be asked about (${still.join(', ')})` : ''}.`
}

/** The whole part a scan is checked against, or why what was named is none; then why it cannot be checked against this scan in this layout, if it cannot. */
function partFor(scene: Scene, layout: string, name: string, tool: string): Part | ToolResult {
  const checked = checkRef(scene, layout, name)
  if (typeof checked === 'string') return failure(checked)
  if (checked.target !== 'part') return failure(`${tool} is of a whole part, and ${name} is ${checked.target === 'face' ? 'a face' : 'an edge'}: give ${checked.part.name}`)
  return checked.part
}

/** The masks of the regions named, each a region of that scan, or the refusal. */
async function masksOf(deps: ToolDeps, objectId: string, asked: ScanAsked, ids: string[]): Promise<string[] | ToolResult> {
  if (ids.length === 0) return []
  const marks = await marksOf(deps, objectId)
  if ('content' in marks) return marks
  const regions = regionsOf(marks, asked.scan.id)
  const masks: string[] = []
  for (const id of ids) {
    const region = regions.find((mark) => mark.id === id)
    if (!region) return failure(regions.length > 0 ? `${id} is not a region of ${asked.scan.id}; its regions: ${regions.map((mark) => mark.id).join(', ')}` : `${id} is not a region of ${asked.scan.id}, which has no regions: the user paints one on the scan`)
    if (region.anchorState === 'orphaned') return failure(`${id} no longer fits the mesh of ${asked.scan.id} (the scan was converted or imported again since it was painted): the user paints it again`)
    masks.push(asked.mask(id))
  }
  return masks
}

/** What is said beside every answer about a scan: that a print layout poses its parts, and what puts the alignment in doubt. */
export function noteOf(aligned: AlignmentSaid, layout: string): { note?: string } {
  const notes = [...(layout === 'print' ? [PRINT_NOTE] : []), ...(aligned.note ? [aligned.note] : [])]
  return notes.length > 0 ? { note: notes.join('. ') } : {}
}

export async function scansTool(deps: ToolDeps, objectId: string, args: ScansArgs): Promise<ToolResult> {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout
  const scans = await scansOf(deps, objectId)
  if ('content' in scans) return scans
  const marks = await deps.marks(objectId).catch(() => [] as Mark[])
  const busy = deps.scansBusy(objectId)
  const view = deps.openObjectId() === objectId ? deps.view(objectId) : undefined
  const lines: string[] = []
  const told = scans.map((scan) => {
    const { min, max } = scan.imported.bbox
    const aligned = alignmentSaid(scan, layout, found.revision)
    const shown = view?.scans?.find((one) => one.id === scan.id)
    const regions = regionsOf(marks, scan.id)
    const working = busy.includes(scan.id)
    const line = [
      `${count(scan.imported.triangles)} triangles`,
      importText(scan.imported),
      aligned.line,
      ...(shown ? [shownText(shown)] : []),
      ...(regions.length > 0 ? [`${regions.length} region${regions.length === 1 ? '' : 's'}`] : []),
      ...(scan.meshState === 'ok' ? [] : ['its mesh is gone']),
      ...(scan.sourceState === 'present' ? [] : [`its source ${scan.sourceState === 'missing' ? 'is missing' : 'has changed since it was read'}`]),
      ...(working ? ['being converted or imported again'] : [])
    ]
    lines.push(`${scan.id} ${scan.name}: ${line.join(', ')}.`)
    return {
      id: scan.id,
      name: scan.name,
      source: { path: scan.source.path, state: scan.sourceState },
      mesh: scan.meshState,
      ...(working ? { busy: true } : {}),
      triangles: scan.imported.triangles,
      vertices: scan.imported.vertices,
      unit: scan.imported.unit,
      up: scan.imported.up,
      // Whether each was guessed from the format and the size, not chosen by the person.
      assumed: scan.imported.assumed,
      ...(scan.imported.reduced ? { reducedFrom: scan.imported.reduced.from } : {}),
      size: clean(max.map((c, axis) => c - min[axis])),
      ...(shown ? { visible: shown.visible, opacity: shown.opacity, ...(shown.loaded === false ? { loaded: false } : {}) } : {}),
      alignment: aligned.data,
      alignedIn: Object.keys(scan.alignments),
      // Where it stands in this layout: the box of its own box's corners, in the frame of the layout.
      ...(aligned.alignment ? { bbox: placedBox(aligned.alignment.transform, min, max) } : {}),
      regions: regions.map((mark) => `${mark.id} ${JSON.stringify(mark.note)}`)
    }
  })
  const coming = busy.filter((id) => !scans.some((scan) => scan.id === id))
  if (coming.length > 0) lines.push(`${coming.join(', ')} ${coming.length === 1 ? 'is' : 'are'} still being imported.`)
  const reading = lines.length > 0 ? lines.join(' ') : 'no scans: the user imports one in the Scans panel of the torno window'
  return reply({ layout, ...ofBuild(deps, objectId), scans: told, approximate: SCAN_APPROXIMATE, reading })
}

/** The box round a scan's own box where a transform puts it. */
function placedBox(transform: ScanTransform, min: Vec3, max: Vec3): { min: Vec3; max: Vec3 } {
  const corners: Vec3[] = []
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(apply(transform, [x, y, z]))
  const along = (pick: (...values: number[]) => number): Vec3 => [0, 1, 2].map((axis) => pick(...corners.map((corner) => corner[axis]))) as Vec3
  return clean({ min: along(Math.min), max: along(Math.max) })
}

export async function scanClashTool(deps: ToolDeps, objectId: string, args: ScanClashArgs): Promise<ToolResult> {
  if (typeof args?.part !== 'string' || args.part === '') return failure(NO_PART)
  if (args.margin !== undefined && !between(args.margin, MARGIN)) return failure(NO_MARGIN)
  if (args.ignore !== undefined && !(Array.isArray(args.ignore) && args.ignore.every((id) => typeof id === 'string' && MARK_ID.test(id)))) return failure(NO_IGNORE)
  const margin = args.margin ?? MARGIN.usual
  const ignore = [...new Set(args.ignore ?? [])]
  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const part = partFor(found.scene, layout, args.part, 'scan_clash')
    if ('content' in part) return part
    const of = await scanFor(deps, objectId, layout, found.revision, args.scan)
    if ('content' in of) return of
    const apart = scanSpread(found.scene, layout, part.name) ?? scanFrame(found.scene, layout, found.revision, part.name, of.scan.id, of.alignment)
    if (apart !== null) return failure(apart)
    const masks = await masksOf(deps, objectId, of, ignore)
    if ('content' in masks) return masks
    try {
      const said = await deps.query<ScanClashed>(objectId, 'scan_clash', { layout, part: part.name, margin, scan: { ...of.wire, ignore: masks, only: null } })
      if (!finite(said?.inside?.count) || !finite(said.points?.checked) || !Array.isArray(said.inside.clusters)) return failure('the kernel did not answer with a clash')
      return { got: { layout, of, said } }
    } catch (e) {
      return refusal(e, layout, 'check against a scan', 'the part or the scan')
    }
  })
  if ('content' in asked) return asked
  const { layout, of, said } = asked.got
  const { revision } = asked.found
  const reading = clashReading(args.part, layout, revision, of.scan.id, of.aligned, said, { margin, ignore })
  return reply({ layout, ...ofBuild(deps, objectId), revision, alignment: of.aligned.data, ...clean(said), scan: of.scan.id, exact: false, ...noteOf(of.aligned, layout), approximate: SCAN_APPROXIMATE, reading })
}

/**
 * A clash in a line: how many scan points are inside the part and in how many clusters, the deepest, how many scan
 * triangles cross its surface, the nearest point outside; then what the count is short of (points thinned, time
 * run out, regions left out, points not taken on the B-rep), and how the scan is aligned. What puts the alignment
 * in doubt is said first. Counts are of what was checked: of a thinned or unfinished answer that is said in the
 * count itself.
 */
export function clashReading(part: string, layout: string, revision: number, scan: string, aligned: AlignmentSaid, said: ScanClashed, asked: { margin?: number; ignore?: string[] } = {}): string {
  const { points, inside, sampling } = said
  const margin = number(asked.margin ?? MARGIN.usual)
  const tried = said.crossings?.triangles
  const every = sampling?.every ?? 1
  // Of each kind, as many as were to be judged: fewer were when the time ran out.
  const due = Math.ceil(points.candidates / Math.max(every, 1))
  const dueTriangles = tried ? Math.ceil(tried.candidates / Math.max(tried.every, 1)) : 0
  const short = [...(points.checked < due ? [`${count(points.checked)} of ${count(due)} points checked`] : []), ...(tried && tried.checked < dueTriangles ? [`${count(tried.checked)} of ${count(dueTriangles)} triangles tried`] : [])]
  const sampled = every > 1 || points.checked < due
  const least = inside.crossingAtLeast === true
  const why = least ? ` (${tried && tried.every > 1 ? `only every ${nth(tried.every)} was tried` : 'the time ran out'})` : ''
  const crossing = inside.crossing > 0 ? `${least ? 'at least ' : ''}${count(inside.crossing)} scan ${inside.crossing === 1 ? 'triangle crosses' : 'triangles cross'} its surface${why}` : ''
  const noCrossing = least ? `no scan triangle was found to cross its surface among those tried${why}` : 'no scan triangle crosses its surface'
  const touching = points.touching > 0 ? `${count(points.touching)} scan ${points.touching === 1 ? 'point lies' : 'points lie'} on its surface, counted on neither side` : ''
  const after = [
    ...(every > 1 ? [`every ${nth(every)} point checked`] : []),
    ...(sampling?.partial ? [`the time ran out after ${number(sampling.seconds)} s${short.length > 0 ? ` with ${short.join(' and ')}` : ': not every point told could be taken on the B-rep'}`] : []),
    ...(points.ignored > 0 ? [`${count(points.ignored)} points of ${asked.ignore?.join(', ') || 'its regions'} left out`] : []),
    ...(sampling?.retakesFailed > 0 ? [`${count(sampling.retakesFailed)} ${sampling.retakesFailed === 1 ? 'point' : 'points'} could not be taken on the B-rep`] : [])
  ]
  const head = `scan_clash ${part} vs ${scan} (${layout}, r${revision}): ${aligned.first}`
  const tail = (said: string, under: string): string => `${head}${said}${after.map((one) => `, ${one}`).join('')}. ${aligned.last(under)}`

  if (inside.count === 0) {
    if (points.candidates === 0) return tail(`no scan point is within ${margin} mm of the part${crossing ? `, but ${crossing}` : ''}`, 'a distance')
    const checked = `(≈ ${count(points.checked)} checked within ${margin} mm of it${every > 1 ? `, every ${nth(every)} point` : ''})`
    const nearest = said.nearest ? `nearest ${number(said.nearest.distance)} mm from ${said.nearest.face}` : points.checked > 0 ? 'the nearest was not taken on the B-rep' : ''
    const pieces = [`no scan point is inside the part ${checked}${crossing ? `, but ${crossing}` : ` and ${noCrossing}`}`, touching, nearest].filter(Boolean)
    // The thinning is said with the count: not once more after it.
    return `${head}${pieces.join('; ')}${after.filter((one) => !one.startsWith('every ')).map((one) => `, ${one}`).join('')}. ${aligned.last('a distance')}`
  }
  const clusters = inside.clusters.length + (inside.clustersOmitted ?? 0)
  const told = inside.clustersOmitted > 0 ? ` (the ${inside.clusters.length} largest ${inside.clusters.length === 1 ? 'is' : 'are'} told)` : ''
  const deepest = said.deepest ? `deepest ${number(said.deepest.depth)} mm at ${vector(said.deepest.at)} under ${said.deepest.under}` : 'how deep was not taken on the B-rep'
  const counted = sampled ? `≈ ${count(inside.count)} of the scan points checked are inside the part` : `≈ ${count(inside.count)} scan ${inside.count === 1 ? 'point' : 'points'} inside the part`
  const nearest = said.nearest ? `nearest scan point outside ${number(said.nearest.distance)} mm from ${said.nearest.face}` : ''
  const pieces = [`${counted} in ${count(clusters)} cluster${clusters === 1 ? '' : 's'}${told}, ${deepest}`, crossing || noCrossing, touching, nearest].filter(Boolean)
  return tail(pieces.join('; '), 'a depth')
}

/** The numbers of the faces named, each a face of that part, or the refusal. */
function facesOf(scene: Scene, layout: string, part: Part, refs: string[]): number[] | ToolResult {
  const faces: number[] = []
  for (const ref of refs) {
    const named = /^(.*)\/F(\d+)$/.exec(ref)
    if (!named || named[1] !== part.name) return failure(`${ref} is not a face of ${part.name}: give refs such as ${part.name}/F0`)
    const checked = checkRef(scene, layout, ref)
    if (typeof checked === 'string') return failure(checked)
    if (!faces.includes(Number(named[2]))) faces.push(Number(named[2]))
  }
  return faces
}

export async function scanDeviationTool(deps: ToolDeps, objectId: string, args: ScanDeviationArgs): Promise<ToolResult> {
  if (typeof args?.part !== 'string' || args.part === '') return failure(NO_PART)
  if (args.samples !== undefined && !(between(args.samples, SAMPLES) && Number.isInteger(args.samples))) return failure(NO_SAMPLES)
  if (args.within !== undefined && !between(args.within, WITHIN)) return failure(NO_WITHIN)
  if (args.from !== undefined && args.from !== 'part' && args.from !== 'scan') return failure(NO_FROM)
  if (args.faces !== undefined && !(Array.isArray(args.faces) && args.faces.length > 0 && args.faces.every((ref) => typeof ref === 'string'))) return failure(NO_FACES)
  if (args.region !== undefined && !(typeof args.region === 'string' && MARK_ID.test(args.region))) return failure(NO_REGION)
  const within = args.within ?? WITHIN.usual
  const samples = args.samples ?? SAMPLES.usual
  const from = args.from ?? 'part'
  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const part = partFor(found.scene, layout, args.part, 'scan_deviation')
    if ('content' in part) return part
    const faces = args.faces ? facesOf(found.scene, layout, part, args.faces) : null
    if (faces !== null && 'content' in faces) return faces
    const of = await scanFor(deps, objectId, layout, found.revision, args.scan)
    if ('content' in of) return of
    const apart = scanSpread(found.scene, layout, part.name) ?? scanFrame(found.scene, layout, found.revision, part.name, of.scan.id, of.alignment)
    if (apart !== null) return failure(apart)
    const masks = await masksOf(deps, objectId, of, args.region === undefined ? [] : [args.region])
    if ('content' in masks) return masks
    try {
      const said = await deps.query<ScanDeviated>(objectId, 'scan_deviation', { layout, part: part.name, faces, from, within, samples, scan: { ...of.wire, ignore: [], only: masks[0] ?? null } })
      if (!finite(said?.samples) || !finite(said.compared) || typeof said.sampling !== 'object' || said.sampling === null) return failure('the kernel did not answer with a deviation')
      return { got: { layout, of, faces, said } }
    } catch (e) {
      return refusal(e, layout, 'check against a scan', 'the part or the scan')
    }
  })
  if ('content' in asked) return asked
  const { layout, of, faces, said } = asked.got
  const { revision } = asked.found
  const what = faces ? facesText(args.part, faces) : args.part
  const reading = deviationReading(what, layout, revision, of.scan.id, of.aligned, said, { within })
  return reply({
    layout,
    ...ofBuild(deps, objectId),
    revision,
    alignment: of.aligned.data,
    ...clean(said),
    scan: of.scan.id,
    ...(args.region === undefined ? {} : { region: args.region }),
    exact: false,
    ...noteOf(of.aligned, layout),
    approximate: SCAN_APPROXIMATE,
    reading
  })
}

/** `plate/F5`; `plate/F5, F7 and 3 more faces`. */
function facesText(part: string, faces: number[]): string {
  const named = faces.slice(0, 3).map((face, i) => (i === 0 ? `${part}/F${face}` : `F${face}`))
  return `${named.join(', ')}${faces.length > named.length ? ` and ${faces.length - named.length} more face${faces.length - named.length === 1 ? '' : 's'}` : ''}`
}

/**
 * A deviation in a line: the median, the mean and the most, from how many points of which to which; then what
 * that count is short of what was asked and why, how many distances are unsure and by how much, the side of the
 * part the scan is on, how many had nothing within reach, and the furthest. What puts the alignment in doubt is
 * said first, and how the scan is aligned last.
 */
export function deviationReading(of: string, layout: string, revision: number, scan: string, aligned: AlignmentSaid, said: ScanDeviated, asked: { within?: number } = {}): string {
  const within = number(asked.within ?? WITHIN.usual)
  const head = `scan_deviation ${of} vs ${scan} (${layout}, r${revision}): ${aligned.first}`
  const last = (under?: string): string => ` ${aligned.last(under)}`
  const { sampling } = said
  if (said.samples === 0 && sampling.partial) return `${head}the time ran out before any point was measured: ask for fewer samples or a smaller within.${last()}`
  if (!said.distance) return `${head}nothing of the scan is within ${within} mm of ${said.faces ? 'those faces' : 'the part'}.${last()}`
  const fromPart = said.from !== 'scan'
  // Fewer than were asked, and the time did not run out: there are no more.
  const fewer =
    !sampling.partial && sampling.asked > said.samples ? ` (${count(sampling.asked)} were asked: ${fromPart ? `the part has no more, ${number(sampling.surface)} mm apart` : `no more are within ${within} mm of it`})` : ''
  // By how much, when the kernel says: its own words hold the figure (`how`), which is no field of the reply.
  const bound = /may be told up to ([\d.]+) mm too far/.exec(said.how ?? '')?.[1]
  const spacing = fromPart ? sampling.scanSurface : sampling.surface
  const unsure =
    sampling.unsure > 0
      ? `${count(sampling.unsure)} of the distances may be told ${bound ? `up to ${bound} mm too far` : `too far, by less than the spacing of the points that stand for ${fromPart ? 'the scan' : "the part's mesh"}${finite(spacing) ? ` (${number(spacing)} mm)` : ''}`}`
      : ''
  const side = !said.signed ? 'the part is no solid, so no side is told' : fromPart ? `the scan is inside the part at ${said.signed.inside > 0 ? count(said.signed.inside) : 'none'} of them` : `${said.signed.inside > 0 ? count(said.signed.inside) : 'none'} of them ${said.signed.inside === 1 ? 'is' : 'are'} inside the part`
  const furthest = said.worst
    ? `furthest at ${vector(said.worst.at)} ${fromPart ? 'on' : 'from'} ${said.worst.face}${sampling.retakesFailed > 0 ? ", which could not be taken on the B-rep: its distance is to the part's mesh" : ''}`
    : ''
  const { p50, mean, max, p95 } = said.distance
  const pieces = [
    `≈ ${number(p50)} mm median, ${number(mean)} mm mean, ${number(max)} mm at most (95 % within ${number(p95)} mm), from ${count(said.compared)} ${fromPart ? 'points of the part to the scan' : 'scan points to the part'}${fewer}`,
    ...(sampling.partial ? [`the time ran out: ${count(said.samples)} of the ${count(sampling.asked)} asked were measured`] : []),
    unsure,
    side,
    ...(said.beyond > 0 ? [`${count(said.beyond)} more had no ${fromPart ? 'scan' : 'part'} within ${within} mm`] : []),
    furthest
  ].filter(Boolean)
  return `${head}${pieces.join('; ')}.${last('a distance')}`
}

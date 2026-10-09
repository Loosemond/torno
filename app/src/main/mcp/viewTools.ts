import { type DimensionStanding, standingOf } from '../../shared/dimension'
import type { DimensionMark, Mark } from '../../shared/marks'
import { letGoText } from '../../shared/build'
import { type ExplodeState, EXPLODED_NOTE, NOT_EXPLODED_AND_CUT, explodeArg, explodeText, isExploded } from '../../shared/explode'
import type { ScanInfo } from '../../shared/scans'
import type { Scene } from '../../shared/scene'
import { type Camera, type LookRequest, type LookResult, type SectionPlane, type ShowRequest, type ShowResult, axisForm } from '../../shared/view'
import { alignmentSaid } from '../scans/said'
import { unknownKeys } from './keys'
import { NO_LOOK_SCANS, NO_SCAN_OPACITY, NO_SHOW_SCANS, isScanOpacity, scanColourFor, scanIds } from './scanTools'
import { type LookArgs, type ShowArgs, CAMERA_KEYS, FOV, explodeHelp } from './schemas'
import { type ToolDeps, type ToolResult, SPREAD_NOTE, TRACEBACK_LINES, built, clampSize, failure, lastLines, messageOf, notOpen, onScreen, planeArg, tidy } from './tools'

// The tools of the view: `scene`, which says what the object is and what the user sees of it, `look`, a picture
// from the window, and `show`, which changes what the window shows for now.

/** Why a view given as a camera holds a key a camera does not take, or a lens or a zoom that is none; or null. */
export const cameraKeys = (view: unknown): string | null => {
  const wrong = unknownKeys(view, CAMERA_KEYS, 'view, as a camera,')
  if (wrong !== null || typeof view !== 'object' || view === null) return wrong
  const { fov, zoom } = view as { fov?: number; zoom?: number }
  if (zoom !== undefined && !(Number.isFinite(zoom) && zoom > 0)) return 'view, as a camera, takes a zoom above 0 (1 is not zoomed), as scene gives it'
  if (fov !== undefined && !(Number.isFinite(fov) && fov >= 1 && fov <= 120)) return 'view, as a camera, takes a fov between 1 and 120 degrees, as scene gives it'
  return null
}

/**
 * `marks` are the object's, when they could be read: the unresolved
 * dimensions that have an expected value are then counted by how they stand
 * on the last build, so that the check after an edit says at once whether
 * the person's checks still hold. `scans` are the object's, when they could
 * be read: each is named, with whether it is aligned in the layout the answer
 * is for (the one on screen, else the first).
 */
export function sceneTool(deps: ToolDeps, objectId: string, marks?: readonly Mark[], scans?: readonly ScanInfo[]): ToolResult {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { obj, build, scene, revision } = found
  const checks = (marks ?? []).filter((m): m is DimensionMark => m.kind === 'dimension' && m.status !== 'resolved').map((m) => standingOf(m, revision)).filter((stands) => stands !== 'measured')
  const count = (...of: DimensionStanding[]): number => checks.filter((stands) => of.includes(stands)).length

  const open = deps.openObjectId() === objectId
  const view = open ? deps.view(objectId) : undefined
  // Layers are switched by part name, in every layout at once; the view names the keys of the layout shown.
  const shown = view && new Set(view.visible.map((key) => scene.parts.find((p) => p.key === key)?.name))
  const hideable = view && new Set(scene.parts.filter((p) => p.layout === view.layout).map((p) => p.name))

  const error = build.error && {
    kind: build.error.kind,
    message: build.error.message,
    ...(build.error.traceback ? { traceback: lastLines(build.error.traceback, TRACEBACK_LINES) } : {})
  }
  const notes: string[] = []
  if (!open) notes.push(`${notOpen(obj, deps.openObjectId())}, so what is visible, the camera and the section are not known.`)
  const letGo = letGoText(build)
  if (letGo) notes.push(letGo)
  if (scene.parts.some((p) => p.arranged)) notes.push(SPREAD_NOTE)
  const scanLayout = view && scene.layouts.includes(view.layout) ? view.layout : scene.layouts[0]
  if (scans && scans.length > 0) notes.push(`How each scan is aligned is said for layout ${scanLayout}, in a word (aligned, rough, in doubt, not checked, not aligned): call scans for the whole of it.`)
  // The parts are drawn apart on their screen: said, so that nothing told here is taken for where they are drawn.
  const explode = view && isExploded(view.explode) ? view.explode : null
  if (explode) notes.push(`The user's view is ${explodeText(explode)}: ${EXPLODED_NOTE}.`)
  const result = {
    object: obj.id,
    model: scene.model,
    build: {
      status: build.status,
      revision: build.revision,
      ...(build.seconds === undefined ? {} : { seconds: round(build.seconds) }),
      stale: build.stale,
      ...(build.letGo ? { letGo: build.letGo } : {}),
      ...(error ? { error } : {})
    },
    layout: view?.layout ?? null,
    layouts: scene.layouts,
    parts: scene.parts.map((p) => ({
      name: p.name,
      layout: p.layout,
      // A part with no namesake in the layout shown has not been seen to be switched off.
      ...(shown && hideable ? { visible: shown.has(p.name) || !hideable.has(p.name) } : {}),
      size: p.bbox.max.map((max, i) => round(max - p.bbox.min[i])),
      bbox: { min: p.bbox.min.map(round), max: p.bbox.max.map(round) },
      volume: round(p.volume),
      faces: p.faceCount,
      edges: p.edgeCount,
      valid: p.valid,
      ...(p.arranged ? { arranged: p.arranged.map(round) } : {})
    })),
    camera: view
      ? { ...view.camera, position: view.camera.position.map(round), target: view.camera.target.map(round), up: view.camera.up.map(round) }
      : null,
    // The user's own cut, if they have one: what is on the side its normal points to is not drawn.
    section: view?.section ? sectionData(view.section) : null,
    // How their screen draws the parts apart, if it does. For display only: every part above is where it was built.
    explode,
    // Of the last build that worked (`build.revision`): call marks for which, and why.
    ...(checks.length > 0 ? { dimensions: { pass: count('pass'), fail: count('fail'), notMeasured: count('unmeasured', 'unmeasurable') } } : {}),
    // How each alignment stands, not a bare yes: one that is rough, in doubt or was never checked against this build is not "aligned: true".
    ...(scans && scans.length > 0 ? { scans: scans.map((scan) => scanStanding(scan, scanLayout, revision)) } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {})
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

/** A scan as `scene` names it: with how its alignment in a layout stands, in a word, and what that rests on. */
function scanStanding(scan: ScanInfo, layout: string | undefined, revision: number): object {
  const said = layout === undefined ? null : alignmentSaid(scan, layout, revision)
  return { id: scan.id, name: scan.name, triangles: scan.imported.triangles, alignment: said?.state ?? 'not aligned', ...(said?.data.basis ? { basis: said.data.basis } : {}), ...(scan.meshState === 'ok' ? {} : { mesh: scan.meshState }) }
}

/** A section as the agent is told it: its point and its normal, and, when it is across an axis, also in the short form it may give one in. */
function sectionData(plane: SectionPlane): object {
  const along = axisForm(plane)
  return { origin: plane.origin.map(round), normal: tidy(plane.normal), ...(along && along.sign > 0 ? { axis: along.axis, at: round(along.at) } : {}) }
}

export async function lookTool(deps: ToolDeps, objectId: string, args: LookArgs): Promise<ToolResult> {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { obj, scene, revision } = found
  // The window draws whatever object it has open, and a request does not say
  // which is meant: asked for another, it would answer with the wrong one.
  const elsewhere = (open: string | null) => failure(`${notOpen(obj, open)}. Ask the user to open it.`)
  if (deps.openObjectId() !== objectId) return elsewhere(deps.openObjectId())

  const wrong = cameraKeys(args.view)
  if (wrong !== null) return failure(wrong)
  const view = cameraOf(args.view)
  if (view === null) return failure('position and target are the same')
  const request: LookRequest = { view, size: clampSize(args.size) }
  if (args.layout !== undefined) request.layout = args.layout
  if (args.parts !== undefined) request.parts = args.parts
  if (args.marks !== undefined) request.marks = args.marks
  if (args.section === null || args.section === 'current') request.section = args.section
  else if (args.section !== undefined) {
    const plane = planeArg(args.section)
    if ('content' in plane) return plane
    request.section = plane
  }
  if (args.scans === false) request.scans = false
  else if (args.scans !== undefined && args.scans !== true) {
    const ids = await scanIds(deps, objectId, args.scans, NO_LOOK_SCANS)
    if ('content' in ids) return ids
    request.scans = ids
  }
  if (args.scanColour !== undefined) {
    const colouring = await scanColourFor(deps, objectId, scene, revision, args.layout, args.scanColour)
    if ('content' in colouring) return colouring
    request.scanColour = colouring
  }
  // As on screen unless the picture says how far apart it draws the parts; never apart and cut.
  const explode = explodeAsked(args.explode)
  if (typeof explode === 'string') return failure(explode)
  request.explode = explode === undefined ? 'current' : explode
  if (isExploded(explode) && (args.section === undefined || args.section === 'current' ? deps.view(objectId)?.section : args.section)) return failure(NOT_EXPLODED_AND_CUT)
  if (args.frame !== undefined) {
    if (args.frame !== 'parts' && args.frame !== 'all') return failure('frame is "parts" (the default: a named view is fitted to the parts drawn) or "all" (to the scans drawn with them)')
    request.frame = args.frame
  }

  let picture: LookResult
  try {
    picture = await deps.look(objectId, request)
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e))
  }
  // The picture says what it is of: the window may have moved on, or a build
  // may have ended, between the request and the answer, and what main knows
  // now is not what was drawn.
  if (picture.objectId !== objectId) return elsewhere(picture.objectId)

  let saved: string
  try {
    saved = `saved as ${await deps.saveImage(objectId, picture.png)}`
  } catch (e) {
    saved = `not saved: ${e instanceof Error ? e.message : String(e)}`
  }
  return {
    content: [
      { type: 'image', data: Buffer.from(picture.png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `${picture.caption}${spreadBesideScans(scene, picture)}${await undrawnScans(deps, objectId, args.scans === false ? [] : Array.isArray(args.scans) ? args.scans : undefined)}\nrevision r${picture.revision}${staleNote(deps, objectId, picture)}\n${saved}` }
    ]
  }
}

/**
 * Said once after the caption of a picture, or of what the window shows, that draws a scan in a layout whose
 * parts torno spread for display: the scan stands where the model's frame has it, and the parts torno moved do
 * not. The picture shows a lid inside a wing, and whoever reads it must know that is torno's doing. '' otherwise.
 */
export function spreadBesideScans(scene: Scene, shown: { layout?: string; scans?: string[] }): string {
  if (!shown.layout || !shown.scans?.length) return ''
  const parts = scene.parts.filter((part) => part.layout === shown.layout)
  const moved = parts.filter((part) => part.arranged?.some((c) => Math.abs(c) > 1e-6)).map((part) => part.name)
  if (moved.length === 0) return ''
  const still = parts.filter((part) => !moved.includes(part.name)).map((part) => part.name)
  return `\nThe parts of layout ${shown.layout} were spread for display: ${moved.join(', ')} ${moved.length === 1 ? 'is' : 'are'} not where ${shown.scans.join(', ')} ${shown.scans.length === 1 ? 'has' : 'have'} ${moved.length === 1 ? 'it' : 'them'}${still.length > 0 ? ` (${still.join(', ')} ${still.length === 1 ? 'is' : 'are'} where the model places ${still.length === 1 ? 'it' : 'them'})` : ''}.`
}

/** Said of the scans that are not in a picture because their mesh is gone from the disk: of those asked for, or of all when none was named. '' when the scans cannot be read, or none is so. */
async function undrawnScans(deps: ToolDeps, objectId: string, asked: string[] | undefined): Promise<string> {
  const scans = await deps.scans(objectId).catch(() => [] as ScanInfo[])
  const gone = scans.filter((scan) => scan.meshState !== 'ok' && (asked === undefined || asked.includes(scan.id))).map((scan) => scan.id)
  return gone.length === 0 ? '' : `\n${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} not drawn: ${gone.length === 1 ? 'its mesh is' : 'their meshes are'} gone from the disk (the user imports ${gone.length === 1 ? 'it' : 'them'} again from the Scans panel).`
}

/** What to say after the revision of a picture whose parts are not the latest build's. '' when they are. */
function staleNote(deps: ToolDeps, objectId: string, picture: { revision: number; stale: boolean }): string {
  const latest = deps.scene(objectId)?.revision ?? picture.revision
  if (latest > picture.revision) return `, stale: r${latest} was built while this picture was made; look again to see it`
  if (!picture.stale) return ''
  const status = deps.build(objectId)?.status
  const why = status === 'building' ? 'a build is running' : status === 'failed' ? 'the latest build failed' : 'a newer build was started'
  return `, stale: ${why}, so these are still the parts of r${picture.revision}`
}

/**
 * How far apart the agent asks for the parts to be drawn: undefined when it does not say, null for together
 * (`null`, or the number 0), an explode, or what to answer when it gave something that is none.
 */
function explodeAsked(given: unknown): ExplodeState | null | undefined | string {
  if (given === undefined) return undefined
  if (given === null || given === 0) return null
  const explode = explodeArg(given)
  if (explode === null) return `explode is ${explodeHelp}`
  // An amount of nothing, with an axis or a scale: together all the same.
  return isExploded(explode) ? explode : null
}

/** The camera to ask the window for, or null for one that looks nowhere: its position is its target. */
export function cameraOf(view: LookArgs['view']): NonNullable<LookRequest['view']> | null {
  if (view === undefined) return 'current'
  if (typeof view === 'string') return view
  const along = view.position.map((p, i) => view.target[i] - p)
  if (along.every((d) => d === 0)) return null
  // Looking straight up or down, Z cannot be up: Y is.
  const vertical = along[0] === 0 && along[1] === 0
  const made: Camera = { position: view.position, target: view.target, up: view.up ?? (vertical ? [0, 1, 0] : [0, 0, 1]), ortho: view.ortho ?? false, fov: view.fov ?? FOV, zoom: view.zoom ?? 1 }
  return made
}

export async function showTool(deps: ToolDeps, objectId: string, args: ShowArgs): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const { obj, scene } = found
  if (args.view === undefined && args.layout === undefined && args.parts === undefined && args.section === undefined && args.scans === undefined && args.scanOpacity === undefined && args.explode === undefined) return failure('nothing to show: give a view, a layout, parts, a section, an explode or scans')
  if (args.layout !== undefined && !scene.layouts.includes(args.layout)) return failure(`no layout '${args.layout}'; layouts: ${scene.layouts.join(', ')}`)
  if (args.parts?.length === 0) return failure('parts is empty: name the parts to leave switched on')

  const request: ShowRequest = { objectId }
  if (args.view !== undefined) {
    const wrong = cameraKeys(args.view)
    if (wrong !== null) return failure(wrong)
    const view = cameraOf(args.view)
    if (view === null) return failure('position and target are the same')
    if (view !== 'current') request.view = view
  }
  if (args.layout !== undefined) request.layout = args.layout
  if (args.parts !== undefined) request.parts = args.parts
  if (args.section === null) request.section = null
  else if (args.section !== undefined) {
    const plane = planeArg(args.section)
    if ('content' in plane) return plane
    request.section = plane
  }
  const explode = explodeAsked(args.explode)
  if (typeof explode === 'string') return failure(explode)
  if (explode !== undefined) request.explode = explode
  // Never apart and cut: the cut this call makes, or the one on their screen unless this call takes it away.
  if (isExploded(explode) && (args.section === undefined ? deps.view(objectId)?.section : args.section)) return failure(NOT_EXPLODED_AND_CUT)
  if (args.scans !== undefined) {
    const ids = await scanIds(deps, objectId, args.scans, NO_SHOW_SCANS)
    if ('content' in ids) return ids
    request.scans = ids
  }
  if (args.scanOpacity !== undefined) {
    if (!isScanOpacity(args.scanOpacity)) return failure(NO_SCAN_OPACITY)
    request.scanOpacity = args.scanOpacity
  }

  let shown: ShowResult
  try {
    shown = await deps.show(objectId, request)
  } catch (e) {
    return failure(messageOf(e))
  }
  if (shown.objectId !== objectId) return failure(`${notOpen(obj, shown.objectId)}. Ask the user to open it.`)
  return { content: [{ type: 'text', text: `${shown.caption}${spreadBesideScans(scene, shown)}${await undrawnScans(deps, objectId, args.scans)}\nrevision r${shown.revision}${staleNote(deps, objectId, shown)}\nThe user's viewport now shows this.` }] }
}

/** To 0.01 mm. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded // never -0
}

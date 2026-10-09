import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BuildState } from '../../shared/build'
import type { Described } from '../../shared/geometry'
import type { Mark, MarkPatch, MeasureKind, NewMark, Quat, ShapeIntent, ShapeKind } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import {
  type AxisPlane,
  type Camera,
  type HighlightResult,
  type LookRequest,
  type LookResult,
  type SectionDrawingRequest,
  type SectionDrawingResult,
  type SectionPlane,
  type ShowRequest,
  type ShowResult,
  type ViewState,
  axisForm,
  planeOf
} from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { describeMark, markData } from '../marks/describe'
import type { Unmeasured } from '../marks/measure'
import { movedForDisplay } from '../marks/spread'
import type { AskedAnchor, NearestAnchor } from '../marks/reanchor'
import { type EndArg, addMarkTool, checkRef, highlightTool, resolveMarkTool } from './markTools'
import { checkTool, measureTool, sectionTool } from './readTools'

/** What the tools need of torno. All of it is about objects of the open workspace, by id. */
export interface ToolDeps {
  object(objectId: string): ObjectInfo | undefined
  build(objectId: string): BuildState | undefined
  /** The last successful build. */
  scene(objectId: string): { revision: number; scene: Scene } | undefined
  /** The camera, layout and visible parts of an object as the window last showed it. */
  view(objectId: string): ViewState | undefined
  /** The object the window shows now: the only one it can make a picture of. */
  openObjectId(): string | null
  /**
   * A picture from the window, which says which object and revision it drew:
   * it may not be the one asked for. Rejects with a text for the agent.
   */
  look(objectId: string, req: LookRequest): Promise<LookResult>
  /** Writes `.torno/views/<n>.png`, keeps the newest 20, returns the path. */
  saveImage(objectId: string, png: Uint8Array): Promise<string>
  /** Every mark of an object, oldest first. */
  marks(objectId: string): Promise<Mark[]>
  /** Keeps a mark of the agent's and gives it its number. Rejects with a text for the agent. */
  addMark(objectId: string, mark: NewMark): Promise<Mark>
  /**
   * Keeps a dimension of the agent's, measured by the kernel as it is kept. Rejects with the kernel's reason when it
   * cannot be measured, and nothing is kept. One kept without a value of the last build says why (`unmeasured`).
   */
  addDimension(objectId: string, mark: NewMark): Promise<{ mark: Mark; unmeasured?: Unmeasured; reason?: string }>
  /** Changes a mark. Rejects with a text that names the marks there are when there is none of that id. */
  updateMark(objectId: string, id: string, patch: MarkPatch): Promise<Mark>
  /** What the kernel says of a part, a face or an edge of the last successful build, in a layout. Rejects with a text. */
  describe(objectId: string, layout: string, ref: string): Promise<Described>
  /**
   * For each anchor, the point of its part's surface nearest to it, and the face that is on; for one that
   * names an `edge` of its part, also how far its point is from that edge. Rejects with a text.
   */
  nearest(objectId: string, layout: string, anchors: AskedAnchor[]): Promise<NearestAnchor[]>
  /** Changes what the window shows of the object it has open, and says what it shows then. Rejects with a text. */
  show(objectId: string, req: ShowRequest): Promise<ShowResult>
  /** Tints refs of the layout on screen in the agent's colour, with a note beside them. Rejects with a text. */
  highlight(objectId: string, layout: string, refs: string[], note?: string): Promise<HighlightResult>
  /**
   * Asks the kernel about the last successful build of an object: an exact measurement, what a plane cuts, a check
   * of two parts or of a mesh. Refs go with the layout in front. Rejects with a `KernelError`, whose kind says why.
   */
  query<T = unknown>(objectId: string, name: 'measure' | 'section' | 'check', args: object): Promise<T>
  /** A 2D drawing of what the kernel says a plane cuts, made by the window, whichever object it shows. Rejects with a text. */
  sectionDrawing(req: SectionDrawingRequest): Promise<SectionDrawingResult>
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  [key: string]: unknown
  content: Block[]
  isError?: boolean
}

export const MIN_SIZE = 256
export const MAX_SIZE = 2000
export const DEFAULT_SIZE = 1280

const TRACEBACK_LINES = 30
// The field of view of the viewport's own camera: DEFAULT_FOV in src/renderer/viewport/views.ts.
export const FOV = 35

/** The most part names a tool takes in one call. */
const MAX_PARTS = 64

export const SPREAD_NOTE =
  'The parts of the print layout overlapped as the model placed them, so they were spread along X for display; arranged is how far each was moved.'

const VIEW_NAMES = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const
const vec3 = z.tuple([z.number(), z.number(), z.number()])
/** A plane, in either form the agent may give one in. */
const planeInput = z.union([z.object({ origin: vec3, normal: vec3 }), z.object({ axis: z.enum(['x', 'y', 'z']), at: z.number() })])
const planeHelp = '{origin, normal}, a point of the plane and its normal in mm in the frame of the layout, or {axis, at} for the plane across x, y or z at that coordinate, its normal along +axis'
/** Said of a plane that is none. */
export const NO_PLANE = 'that is not a plane: give {origin: [x, y, z], normal: [x, y, z]} with a normal that is not all zeros, or {axis: "x" | "y" | "z", at: number}'
const cameraInput = z.object({ position: vec3, target: vec3, up: vec3.optional(), ortho: z.boolean().optional() })

const lookInput = {
  view: z
    .union([z.enum(['current', ...VIEW_NAMES]), cameraInput])
    .optional()
    .describe(
      "'current' (the default) is the user's own camera. iso, front, back, left, right, top and bottom are orthographic views fitted to the parts. Or a camera: {position, target, up?, ortho?} in mm, Z up."
    ),
  layout: z.string().optional().describe('The layout to draw, as listed by scene. Default: the one on screen.'),
  parts: z.array(z.string()).max(MAX_PARTS).optional().describe('Names of the parts to draw. Default: the parts the user has switched on.'),
  size: z.number().optional().describe(`Long edge of the image in pixels, ${MIN_SIZE} to ${MAX_SIZE}. Default ${DEFAULT_SIZE}.`),
  marks: z.boolean().optional().describe("Draw the user's and your marks with their numbers. Default true."),
  section: z
    .union([z.literal('current'), planeInput])
    .nullable()
    .optional()
    .describe(`The cut the parts are drawn with: 'current' (the default) is the user's own section, if they have one; null draws them whole; or a plane of your own, ${planeHelp}. What lies on the side the normal points to is not drawn: with {axis, at}, what is at a greater x, y or z than at is removed.`)
}

export type PlaneArg = SectionPlane | AxisPlane

export interface LookArgs {
  view?: 'current' | (typeof VIEW_NAMES)[number] | { position: Vec3; target: Vec3; up?: Vec3; ortho?: boolean }
  layout?: string
  parts?: string[]
  size?: number
  marks?: boolean
  section?: 'current' | PlaneArg | null
}

type Vec3 = [number, number, number]

const refText = 'A ref names a part (lid), one of its faces (lid/F12) or edges (lid/E3), as given by marks, scene and describe.'
const layoutText = 'The layout the refs are of, as listed by scene. Default: the one on screen.'

const marksInput = {
  status: z
    .enum(['draft', 'sent', 'resolved', 'open'])
    .optional()
    .describe('Only the marks of that status: draft (not yet given to you with a prompt), sent, resolved, or open for all that are not resolved. Default: all.')
}

const describeInput = {
  ref: z.string().describe(`${refText} Or the number of a mark (M3), which returns that mark.`),
  layout: z.string().optional().describe(layoutText)
}

const highlightInput = {
  refs: z.array(z.string()).min(1).max(50).describe(`${refText} A mark number (M3) stands for what that mark is on.`),
  note: z.string().optional().describe('A short line shown beside them, such as the question you are asking.'),
  layout: z.string().optional().describe('The layout the refs are of. It must be the one on screen, which is the default.')
}

const showInput = {
  view: z
    .union([z.enum(VIEW_NAMES), cameraInput])
    .optional()
    .describe('iso, front, back, left, right, top or bottom, fitted to the parts shown; or a camera: {position, target, up?, ortho?} in mm, Z up. Default: the camera stays.'),
  layout: z.string().optional().describe('The layout to switch to, as listed by scene. Default: the one on screen stays.'),
  parts: z.array(z.string()).max(MAX_PARTS).optional().describe('Names of the parts to leave switched on; every other part of the layout is hidden. Default: no part is switched.'),
  section: planeInput
    .nullable()
    .optional()
    .describe(`A cut to put on the user's screen: ${planeHelp}; what lies on the side the normal points to is not drawn: with {axis, at}, what is at a greater x, y or z than at is removed. null takes their section away. Default: it stays as it is.`)
}

export const SHAPES = ['box', 'cylinder', 'sphere', 'plane'] as const
export const INTENTS = ['add', 'remove', 'keep-out', 'reference'] as const
export const MEASURES = ['distance', 'angle', 'radius', 'diameter', 'thickness'] as const satisfies readonly MeasureKind[]

/** An end of a measurement, as the agent names one. */
const endInput = z.union([z.string(), z.object({ ref: z.string().optional(), point: vec3.optional() })])
const endText =
  'A ref of a face or an edge (lid/F12, lid/E3), the number of a mark (M3: what that mark is on), {point: [x, y, z]} in mm in the frame of the layout, or {ref, point} for the feature the ref names, taken at that point of it.'

const addMarkInput = {
  kind: z
    .enum(['pin', 'pick', 'arrow', 'shape', 'dimension'])
    .describe('pin: a point. pick: a whole part, face or edge. arrow: from a point, a direction and a length. shape: a box, cylinder, sphere or plane in space. dimension: an exact measurement that stays on the part, given by measure, a and, between two ends, b.'),
  note: z.string().describe('What the mark says to the user, in a line.'),
  ref: z.string().optional().describe(`What a pin, a pick or the start of an arrow is on. ${refText} Without a point, the mark is put at the centre of the face or edge. A pin given an edge is a pin on that edge.`),
  point: vec3.optional().describe('Where a pin is, or an arrow starts: [x, y, z] in mm in the frame of the layout. Without a ref, it is tied to the part whose surface it is on, if any.'),
  to: vec3.optional().describe('Where an arrow ends: [x, y, z] in mm.'),
  by: vec3.optional().describe('Instead of to, never with it: the vector from the start of an arrow to its end, in mm.'),
  shape: z.enum(SHAPES).optional().describe('For a shape: which.'),
  size: vec3.optional().describe('For a shape, in mm: a box is [x, y, z]; a cylinder [diameter, diameter, height] along its Z; a sphere [diameter, diameter, diameter]; a plane [width, height, 0].'),
  position: vec3.optional().describe('For a shape: its centre, [x, y, z] in mm.'),
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('For a shape: a quaternion [x, y, z, w]. Default: not turned.'),
  intent: z.enum(INTENTS).optional().describe('For a shape: material to add, material to remove, a volume to keep out of, or only a reference.'),
  measure: z.enum(MEASURES).optional().describe('For a dimension: what is measured. distance and angle are between a and b; radius, diameter and thickness are of a alone.'),
  a: endInput.optional().describe(`For a dimension: its first end. ${endText} A wall's thickness is measured at a point of a face: {ref, point}.`),
  b: endInput.optional().describe('For a dimension of a distance or an angle: its other end, given as a is.'),
  expected: z.number().optional().describe('For a dimension: what it should measure, in mm or degrees. The dimension then passes or fails on every build.'),
  tolerance: z.number().optional().describe('For a dimension: how far from expected it may be, zero or more. Default 0.05 mm, 0.1° for an angle.'),
  layout: z.string().optional().describe('The layout the mark is in, whose frame its coordinates are in. Default: the one on screen.')
}

const measureInput = {
  kind: z
    .enum(['distance', 'angle', 'radius', 'diameter', 'thickness', 'bbox', 'volume', 'area', 'mass'])
    .describe(
      'distance (between parallel planes, between axes, from a point to a plane, else the minimum) and angle are between a and b. radius and diameter are of a round face or a circular edge; thickness of a wall, from a point of a face along its inward normal; bbox of a part, a face or an edge; area of a part or a face; volume and mass of a part.'
    ),
  a: endInput.describe(`What is measured, or its first end. ${endText} A whole part (lid) where the kind takes one.`),
  b: endInput.optional().describe('The other end of a distance or an angle, given as a is.'),
  density: z.number().optional().describe('For mass: g/cm³. Default 1.24, PLA, and the reply says so.'),
  layout: z.string().optional().describe(layoutText)
}

const sectionInput = {
  plane: z.union([z.literal('current'), planeInput]).describe(`The plane to cut by: ${planeHelp}; or 'current' for the user's own section.`),
  parts: z.array(z.string()).max(MAX_PARTS).optional().describe('Names of the parts to cut. Default: every part of the layout. Name one part to get its outline in full, up to 2,000 points a loop.'),
  layout: z.string().optional().describe('The layout to cut, as listed by scene. Default: the one on screen.'),
  size: z.number().optional().describe(`Long edge of the drawing in pixels, ${MIN_SIZE} to ${MAX_SIZE}. Default ${DEFAULT_SIZE}.`)
}

const checkInput = {
  kind: z.enum(['overlap', 'clearance', 'mesh']).describe('overlap and clearance are of the two parts a and b; mesh is of the part a.'),
  a: z.string().describe('The name of a part, as listed by scene.'),
  b: z.string().optional().describe('The name of the other part, for overlap and clearance.'),
  layout: z.string().optional().describe('The layout the parts are in, as listed by scene. Default: the one on screen.')
}

const resolveMarkInput = {
  id: z.string().describe('The number of the mark: M3.'),
  note: z.string().optional().describe('What was done about it, in a line, for the user.')
}

export interface MarksArgs {
  status?: 'draft' | 'sent' | 'resolved' | 'open'
}
export interface DescribeArgs {
  ref: string
  layout?: string
}
export interface HighlightArgs {
  refs: string[]
  note?: string
  layout?: string
}
export interface ShowArgs {
  view?: (typeof VIEW_NAMES)[number] | { position: Vec3; target: Vec3; up?: Vec3; ortho?: boolean }
  layout?: string
  parts?: string[]
  section?: PlaneArg | null
}
export interface AddMarkArgs {
  kind: 'pin' | 'pick' | 'arrow' | 'shape' | 'dimension'
  note: string
  ref?: string
  point?: Vec3
  to?: Vec3
  by?: Vec3
  shape?: ShapeKind
  size?: Vec3
  position?: Vec3
  rotation?: Quat
  intent?: ShapeIntent
  measure?: MeasureKind
  a?: EndArg
  b?: EndArg
  expected?: number
  tolerance?: number
  layout?: string
}
export interface ResolveMarkArgs {
  id: string
  note?: string
}

export const TOOLS = {
  scene: {
    description:
      'Returns JSON for the object this session works on: the build status, revision and error, its layouts, every part with size, bounding box, volume, face and edge counts in mm, and what the user sees (layout, visible parts, camera). Call it after every edit of the model to check that the build passed, and whenever you need dimensions.'
  },
  look: {
    description:
      "Returns a PNG of the object drawn by the same viewport the user is looking at, with a caption naming the view, layout, parts, revision and whether the parts are stale. Call it with no arguments to see exactly what the user sees, or with a named view, a camera, a layout or a list of parts to check the shape after a change.",
    inputSchema: lookInput
  },
  marks: {
    description:
      "Returns JSON with the revision of the build it is of, a stale note when a newer build is running or failed, and the marks on this object, the user's and your own: each with its number (M3), kind, note, status, layout, the ref and descriptor of what it is on, its coordinates in mm in the frame of its layout, for a stroke its points, and a line that says it in words. Marks are how the user points at the part; new ones come with the prompt as a line each, so call this for all of their data, or when a prompt says more marks were left out. An anchorState other than ok means the build moved the surface or dropped the part, and a checkedRevision that is absent or is not the revision means the mark has not been checked against that build: either way the ref may no longer name what the mark is on.",
    inputSchema: marksInput
  },
  describe: {
    description:
      'Returns JSON with the exact geometry of a part, a face or an edge: its type, size, area or length, centre, normal or radius, a one-line descriptor, the revision of the build it was measured on, and a stale note when a newer build is running or failed. Refs come from marks, scene and earlier describe calls; face and edge numbers change when the model is rebuilt, so describe a ref again after an edit before relying on it.',
    inputSchema: describeInput
  },
  highlight: {
    description:
      "Returns which refs are now tinted in the user's viewport in your colour, with your note beside them, until the user clicks there or 60 s pass. Use it to ask \"this one?\" before a change that would be costly to get wrong, and then wait for the answer.",
    inputSchema: highlightInput
  },
  show: {
    description:
      "Returns a caption of what the user's viewport shows after it was changed to the view, layout, parts or section you gave. It moves the user's own camera, hides the parts you leave out and cuts their view, so use it only to show them something, and say that you did; to see for yourself, call look.",
    inputSchema: showInput
  },
  add_mark: {
    description:
      "Returns the number and a one-line description of a mark you placed on the object, which the user sees in the viewport and in their list of marks in your colour, and the revision of the build it was placed on. Use it to show where you made a change, or to point at the place a question is about; refs come from marks, scene and describe. A dimension is measured at once, in mm or degrees, and again on every build, and one you give an expected value becomes a pinned check the user sees: it is listed with every prompt while it fails.",
    inputSchema: addMarkInput
  },
  resolve_mark: {
    description:
      "Returns the mark, now resolved: the user sees it in their list as resolved by you, with your note, until they confirm or reopen it. Call it for each mark of the user's once you have acted on it and checked the result.",
    inputSchema: resolveMarkInput
  },
  measure: {
    description:
      "Returns JSON with one measurement of the last build and a reading of it in a line: the distance or angle between two ends, the radius or diameter of a round face or edge, the thickness of a wall at a point of a face, or the bbox, volume, area or mass of a part, in mm, degrees, mm², mm³ and grams, with how it was taken (between planes, axis to axis, minimum). Values are exact, from the B-rep, unless the reply has exact false and the reading says approximate. Measure before you state a size or a fit, instead of working it out from the model's code or writing a script.",
    inputSchema: measureInput
  },
  section: {
    description:
      "Returns a 2D drawing and JSON of what a plane cuts of the parts: for each part its outlines from the B-rep, as loops of [u, v] points in mm along the plane's own axes (x and y in the reply), with their areas in mm² (negative round a hole) and the extent of the whole cut. A loop is a polyline within its deflection of the true outline (0.05 mm, more when thinned: loops are thinned to 200 points each unless you ask for one part), and an area is exact only where areaExact is true. Use it to see inside a part and to check a wall or a fit across a cut; to see the cut in 3D as the user would, call look with a section.",
    inputSchema: sectionInput
  },
  check: {
    description:
      'Returns JSON and a reading in a line of one check of the last build: overlap is the volume two parts share, in mm³; clearance the least distance between two parts, in mm, with the points it is between; mesh whether the mesh a part is drawn and exported with is closed, with where its open edges are. Overlap and clearance are exact, from the B-rep, unless the reply says approximate, and overlap and mesh can take seconds on large parts. Use it after changing parts that must fit together, and before saying a part is ready to print.',
    inputSchema: checkInput
  }
}

/** The tools of one object's MCP server. */
export function registerTools(server: McpServer, deps: ToolDeps, objectId: string): void {
  server.registerTool('scene', { description: TOOLS.scene.description }, async () => sceneTool(deps, objectId))
  server.registerTool('look', TOOLS.look, async (args) => lookTool(deps, objectId, args))
  server.registerTool('marks', TOOLS.marks, async (args) => marksTool(deps, objectId, args))
  server.registerTool('describe', TOOLS.describe, async (args) => describeTool(deps, objectId, args))
  server.registerTool('highlight', TOOLS.highlight, async (args) => highlightTool(deps, objectId, args))
  server.registerTool('show', TOOLS.show, async (args) => showTool(deps, objectId, args))
  server.registerTool('add_mark', TOOLS.add_mark, async (args) => addMarkTool(deps, objectId, args))
  server.registerTool('resolve_mark', TOOLS.resolve_mark, async (args) => resolveMarkTool(deps, objectId, args))
  server.registerTool('measure', TOOLS.measure, async (args) => measureTool(deps, objectId, args))
  server.registerTool('section', TOOLS.section, async (args) => sectionTool(deps, objectId, args))
  server.registerTool('check', TOOLS.check, async (args) => checkTool(deps, objectId, args))
}

export function failure(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export const notOpen = (obj: ObjectInfo, open: string | null): string => `${obj.name} is not the object open in the torno window (open: ${open ?? 'none'})`

/**
 * The last successful build of an object, or the error to answer with: the
 * object is not in the workspace, or nothing of it has been built.
 */
export function built(deps: ToolDeps, objectId: string): { obj: ObjectInfo; build: BuildState; revision: number; scene: Scene } | ToolResult {
  const obj = deps.object(objectId)
  if (!obj) return failure(`unknown object: ${objectId}`)
  const build = deps.build(objectId)
  const last = deps.scene(objectId)
  if (build && last) return { obj, build, ...last }
  if (!build) return failure(`no build yet: ${obj.name} has not been opened in the torno window`)
  const traceback = lastLines(build.error?.traceback, TRACEBACK_LINES)
  return failure(`no build yet: ${build.status}${build.error ? `: ${build.error.message}` : ''}${traceback ? `\n${traceback}` : ''}`)
}

export function sceneTool(deps: ToolDeps, objectId: string): ToolResult {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { obj, build, scene } = found

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
  if (scene.parts.some((p) => p.arranged)) notes.push(SPREAD_NOTE)
  const result = {
    object: obj.id,
    model: scene.model,
    build: {
      status: build.status,
      revision: build.revision,
      ...(build.seconds === undefined ? {} : { seconds: round(build.seconds) }),
      stale: build.stale,
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
    ...(notes.length > 0 ? { note: notes.join(' ') } : {})
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

/** A section as the agent is told it: its point and its normal, and, when it is across an axis, also in the short form it may give one in. */
function sectionData(plane: SectionPlane): object {
  const along = axisForm(plane)
  return { origin: plane.origin.map(round), normal: tidy(plane.normal), ...(along && along.sign > 0 ? { axis: along.axis, at: round(along.at) } : {}) }
}

export async function lookTool(deps: ToolDeps, objectId: string, args: LookArgs): Promise<ToolResult> {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { obj } = found
  // The window draws whatever object it has open, and a request does not say
  // which is meant: asked for another, it would answer with the wrong one.
  const elsewhere = (open: string | null) => failure(`${notOpen(obj, open)}. Ask the user to open it.`)
  if (deps.openObjectId() !== objectId) return elsewhere(deps.openObjectId())

  const view = camera(args.view)
  if (view === null) return failure('position and target are the same')
  const request: LookRequest = { view, size: clampSize(args.size) }
  if (args.layout !== undefined) request.layout = args.layout
  if (args.parts !== undefined) request.parts = args.parts
  if (args.marks !== undefined) request.marks = args.marks
  if (args.section === null || args.section === 'current') request.section = args.section
  else if (args.section !== undefined) {
    const plane = planeOf(args.section)
    if (!plane) return failure(NO_PLANE)
    request.section = plane
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
      { type: 'text', text: `${picture.caption}\nrevision r${picture.revision}${staleNote(deps, objectId, picture)}\n${saved}` }
    ]
  }
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

/** The camera to ask the window for, or null for one that looks nowhere: its position is its target. */
function camera(view: LookArgs['view']): NonNullable<LookRequest['view']> | null {
  if (view === undefined) return 'current'
  if (typeof view === 'string') return view
  const along = view.position.map((p, i) => view.target[i] - p)
  if (along.every((d) => d === 0)) return null
  // Looking straight up or down, Z cannot be up: Y is.
  const vertical = along[0] === 0 && along[1] === 0
  const made: Camera = { position: view.position, target: view.target, up: view.up ?? (vertical ? [0, 1, 0] : [0, 0, 1]), ortho: view.ortho ?? false, fov: FOV, zoom: 1 }
  return made
}

/** Coordinates as the agent is given them: to a tenth of a micron, which is past what any of them means. */
export function tidy<T>(value: T): T {
  if (typeof value === 'number') {
    const rounded = Math.round(value * 1e4) / 1e4
    return (rounded === 0 ? 0 : rounded) as T
  }
  if (Array.isArray(value)) return value.map(tidy) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, tidy(v)])) as T
  return value
}

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(tidy(value)) }] })
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const MARK_ID = /^M\d+$/

/** The marks of an object, or the error to answer with: the object is not in the workspace, or its marks cannot be read. */
export async function marksOf(deps: ToolDeps, objectId: string): Promise<Mark[] | ToolResult> {
  if (!deps.object(objectId)) return failure(`unknown object: ${objectId}`)
  try {
    return await deps.marks(objectId)
  } catch (e) {
    return failure(messageOf(e))
  }
}

export const noMark = (id: string, marks: Mark[]): ToolResult => failure(`no mark ${id}; marks: ${marks.map((m) => m.id).join(', ') || 'none'}`)

/**
 * A mark as data, with the line that says it in words. The data of a mark
 * that moved or lost its part still holds the ref it was placed on beside what
 * the kernel says is under it now; the line pairs nothing that may not agree.
 * Given the revision of the last build, the line says when the mark was not
 * checked against it. A dimension has a value in its data only where its line
 * gives one: as measured on that build (`markData`).
 */
const withLine = (mark: Mark, revision?: number): object => ({ ...markData(mark, revision), line: describeMark(mark, { revision }) })

/** Why the last successful build of an object is not of its model as it now is: a build is running, or the latest failed. '' otherwise. */
export function behind(deps: ToolDeps, objectId: string): string {
  const status = deps.build(objectId)?.status
  return status === 'building' ? 'a build is running' : status === 'failed' ? 'the latest build failed' : ''
}

/**
 * Which build an answer made from what main knows is of: its revision (null
 * before the first), and, while that is not the latest attempt, a note that
 * says so. The marks, their refs and what the kernel says are all of the last
 * build that worked.
 */
export function ofBuild(deps: ToolDeps, objectId: string): { revision: number | null; stale?: string } {
  const revision = deps.scene(objectId)?.revision ?? null
  const why = revision === null ? '' : behind(deps, objectId)
  return { revision, ...(why ? { stale: `${why}, so this is still what is known of r${revision}: refs and descriptors may not hold for the model as it now is` } : {}) }
}

export async function marksTool(deps: ToolDeps, objectId: string, args: MarksArgs): Promise<ToolResult> {
  const marks = await marksOf(deps, objectId)
  if ('content' in marks) return marks
  const wanted = args.status
  const build = ofBuild(deps, objectId)
  const listed = marks.filter((m) => wanted === undefined || (wanted === 'open' ? m.status !== 'resolved' : m.status === wanted))
  return json({ ...build, marks: listed.map((m) => withLine(m, build.revision ?? undefined)) })
}

/**
 * The layout a tool works in: the one asked for, else the one on screen, else
 * the first. An error that names the layouts when the build has none of that name.
 */
export function layoutFor(deps: ToolDeps, objectId: string, scene: Scene, asked: string | undefined): string | ToolResult {
  const onScreen = deps.openObjectId() === objectId ? deps.view(objectId)?.layout : undefined
  const layout = asked ?? (onScreen !== undefined && scene.layouts.includes(onScreen) ? onScreen : scene.layouts[0])
  if (layout === undefined || !scene.layouts.includes(layout)) return failure(`no layout '${asked ?? ''}'; layouts: ${scene.layouts.join(', ') || 'none'}`)
  return layout
}

export async function describeTool(deps: ToolDeps, objectId: string, args: DescribeArgs): Promise<ToolResult> {
  if (MARK_ID.test(args.ref)) {
    const marks = await marksOf(deps, objectId)
    if ('content' in marks) return marks
    const mark = marks.find((m) => m.id === args.ref)
    const build = ofBuild(deps, objectId)
    return mark ? json({ ...build, mark: withLine(mark, build.revision ?? undefined) }) : noMark(args.ref, marks)
  }
  const found = built(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout
  const checked = checkRef(found.scene, layout, args.ref)
  if (typeof checked === 'string') return failure(checked)
  try {
    const described = await deps.describe(objectId, layout, args.ref)
    // As of the answer: a build may have ended while the kernel was asked. Its centre and its box are where the part is shown.
    return json({ layout, ...ofBuild(deps, objectId), ...described, ...movedForDisplay(checked.part, layout) })
  } catch (e) {
    return failure(messageOf(e))
  }
}

/** The object a tool that touches the window works on, or the error to answer with when the window shows another. */
export function onScreen(deps: ToolDeps, objectId: string): { obj: ObjectInfo; revision: number; scene: Scene } | ToolResult {
  const found = built(deps, objectId)
  if ('content' in found) return found
  if (deps.openObjectId() !== objectId) return failure(`${notOpen(found.obj, deps.openObjectId())}. Ask the user to open it.`)
  return found
}

export async function showTool(deps: ToolDeps, objectId: string, args: ShowArgs): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const { obj, scene } = found
  if (args.view === undefined && args.layout === undefined && args.parts === undefined && args.section === undefined) return failure('nothing to show: give a view, a layout, parts or a section')
  if (args.layout !== undefined && !scene.layouts.includes(args.layout)) return failure(`no layout '${args.layout}'; layouts: ${scene.layouts.join(', ')}`)
  if (args.parts?.length === 0) return failure('parts is empty: name the parts to leave switched on')

  const request: ShowRequest = { objectId }
  if (args.view !== undefined) {
    const view = camera(args.view)
    if (view === null) return failure('position and target are the same')
    if (view !== 'current') request.view = view
  }
  if (args.layout !== undefined) request.layout = args.layout
  if (args.parts !== undefined) request.parts = args.parts
  if (args.section === null) request.section = null
  else if (args.section !== undefined) {
    const plane = planeOf(args.section)
    if (!plane) return failure(NO_PLANE)
    request.section = plane
  }

  let shown: ShowResult
  try {
    shown = await deps.show(objectId, request)
  } catch (e) {
    return failure(messageOf(e))
  }
  if (shown.objectId !== objectId) return failure(`${notOpen(obj, shown.objectId)}. Ask the user to open it.`)
  return { content: [{ type: 'text', text: `${shown.caption}\nrevision r${shown.revision}${staleNote(deps, objectId, shown)}\nThe user's viewport now shows this.` }] }
}

export function clampSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_SIZE
  return Math.round(Math.min(Math.max(size, MIN_SIZE), MAX_SIZE))
}

/** To 0.01 mm. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded // never -0
}

function lastLines(text: string | undefined, count: number): string {
  return (text ?? '').trimEnd().split('\n').slice(-count).join('\n')
}

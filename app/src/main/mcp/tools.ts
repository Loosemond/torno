import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BuildState } from '../../shared/build'
import type { Described } from '../../shared/geometry'
import { type Anchor, type Mark, type MarkPatch, type NewMark, type Quat, type ShapeIntent, type ShapeKind, markAnchors } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, HighlightResult, LookRequest, LookResult, ShowRequest, ShowResult, ViewState } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { describeMark, number, vector } from '../marks/describe'
import { MAX_NOTE } from '../marks/file'
import { type AskedAnchor, type NearestAnchor, EDGE_TOLERANCE_MM, judge, tolerance } from '../marks/reanchor'

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
const FOV = 35

const SPREAD_NOTE =
  'The parts of the print layout overlapped as the model placed them, so they were spread along X for display; arranged is how far each was moved.'

const VIEW_NAMES = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const
const vec3 = z.tuple([z.number(), z.number(), z.number()])
const cameraInput = z.object({ position: vec3, target: vec3, up: vec3.optional(), ortho: z.boolean().optional() })

const lookInput = {
  view: z
    .union([z.enum(['current', ...VIEW_NAMES]), cameraInput])
    .optional()
    .describe(
      "'current' (the default) is the user's own camera. iso, front, back, left, right, top and bottom are orthographic views fitted to the parts. Or a camera: {position, target, up?, ortho?} in mm, Z up."
    ),
  layout: z.string().optional().describe('The layout to draw, as listed by scene. Default: the one on screen.'),
  parts: z.array(z.string()).optional().describe('Names of the parts to draw. Default: the parts the user has switched on.'),
  size: z.number().optional().describe(`Long edge of the image in pixels, ${MIN_SIZE} to ${MAX_SIZE}. Default ${DEFAULT_SIZE}.`),
  marks: z.boolean().optional().describe("Draw the user's and your marks with their numbers. Default true.")
}

export interface LookArgs {
  view?: 'current' | (typeof VIEW_NAMES)[number] | { position: Vec3; target: Vec3; up?: Vec3; ortho?: boolean }
  layout?: string
  parts?: string[]
  size?: number
  marks?: boolean
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
  parts: z.array(z.string()).optional().describe('Names of the parts to leave switched on; every other part of the layout is hidden. Default: no part is switched.')
}

const SHAPES = ['box', 'cylinder', 'sphere', 'plane'] as const
const INTENTS = ['add', 'remove', 'keep-out', 'reference'] as const

const addMarkInput = {
  kind: z.enum(['pin', 'pick', 'arrow', 'shape']).describe('pin: a point. pick: a whole part, face or edge. arrow: from a point, a direction and a length. shape: a box, cylinder, sphere or plane in space.'),
  note: z.string().describe('What the mark says to the user, in a line.'),
  ref: z.string().optional().describe(`What a pin, a pick or the start of an arrow is on. ${refText} Without a point, the mark is put at the centre of the face or edge.`),
  point: vec3.optional().describe('Where a pin is, or an arrow starts: [x, y, z] in mm in the frame of the layout. Without a ref, it is tied to the part whose surface it is on, if any.'),
  to: vec3.optional().describe('Where an arrow ends: [x, y, z] in mm.'),
  by: vec3.optional().describe('Instead of to: the vector from the start of an arrow to its end, in mm.'),
  shape: z.enum(SHAPES).optional().describe('For a shape: which.'),
  size: vec3.optional().describe('For a shape, in mm: a box is [x, y, z]; a cylinder [diameter, diameter, height] along its Z; a sphere [diameter, diameter, diameter]; a plane [width, height, 0].'),
  position: vec3.optional().describe('For a shape: its centre, [x, y, z] in mm.'),
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('For a shape: a quaternion [x, y, z, w]. Default: not turned.'),
  intent: z.enum(INTENTS).optional().describe('For a shape: material to add, material to remove, a volume to keep out of, or only a reference.'),
  layout: z.string().optional().describe('The layout the mark is in, whose frame its coordinates are in. Default: the one on screen.')
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
}
export interface AddMarkArgs {
  kind: 'pin' | 'pick' | 'arrow' | 'shape'
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
      "Returns JSON of the marks on this object, the user's and your own: each with its number (M3), kind, note, status, the ref and descriptor of what it is on, its coordinates in mm, and for a stroke its points. Marks are how the user points at the part; new ones come with the prompt as a line each, so call this for all of their data, or when a prompt says more marks were left out.",
    inputSchema: marksInput
  },
  describe: {
    description:
      'Returns JSON with the exact geometry of a part, a face or an edge: its type, size, area or length, centre, normal or radius, and a one-line descriptor. Refs come from marks, scene and earlier describe calls; face and edge numbers change when the model is rebuilt, so describe a ref again after an edit before relying on it.',
    inputSchema: describeInput
  },
  highlight: {
    description:
      "Returns which refs are now tinted in the user's viewport in your colour, with your note beside them, until the user clicks there or 60 s pass. Use it to ask \"this one?\" before a change that would be costly to get wrong, and then wait for the answer.",
    inputSchema: highlightInput
  },
  show: {
    description:
      "Returns a caption of what the user's viewport shows after it was changed to the view, layout or parts you gave. It moves the user's own camera and hides the parts you leave out, so use it only to show them something, and say that you did; to see for yourself, call look.",
    inputSchema: showInput
  },
  add_mark: {
    description:
      "Returns the number and a one-line description of a mark you placed on the object, which the user sees in the viewport and in their list of marks in your colour. Use it to show where you made a change, or to point at the place a question is about; refs come from marks, scene and describe.",
    inputSchema: addMarkInput
  },
  resolve_mark: {
    description:
      "Returns the mark, now resolved, which moves it to the user's resolved list with your note. Call it for each mark of the user's once you have acted on it and checked the result.",
    inputSchema: resolveMarkInput
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
}

function failure(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

const notOpen = (obj: ObjectInfo, open: string | null): string => `${obj.name} is not the object open in the torno window (open: ${open ?? 'none'})`

/**
 * The last successful build of an object, or the error to answer with: the
 * object is not in the workspace, or nothing of it has been built.
 */
function built(deps: ToolDeps, objectId: string): { obj: ObjectInfo; build: BuildState; revision: number; scene: Scene } | ToolResult {
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
  if (!open) notes.push(`${notOpen(obj, deps.openObjectId())}, so what is visible and the camera are not known.`)
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
    ...(notes.length > 0 ? { note: notes.join(' ') } : {})
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
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
function tidy<T>(value: T): T {
  if (typeof value === 'number') {
    const rounded = Math.round(value * 1e4) / 1e4
    return (rounded === 0 ? 0 : rounded) as T
  }
  if (Array.isArray(value)) return value.map(tidy) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, tidy(v)])) as T
  return value
}

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(tidy(value)) }] })
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const MARK_ID = /^M\d+$/

/** The marks of an object, or the error to answer with: the object is not in the workspace, or its marks cannot be read. */
async function marksOf(deps: ToolDeps, objectId: string): Promise<Mark[] | ToolResult> {
  if (!deps.object(objectId)) return failure(`unknown object: ${objectId}`)
  try {
    return await deps.marks(objectId)
  } catch (e) {
    return failure(messageOf(e))
  }
}

const noMark = (id: string, marks: Mark[]): ToolResult => failure(`no mark ${id}; marks: ${marks.map((m) => m.id).join(', ') || 'none'}`)

export async function marksTool(deps: ToolDeps, objectId: string, args: MarksArgs): Promise<ToolResult> {
  const marks = await marksOf(deps, objectId)
  if ('content' in marks) return marks
  const wanted = args.status
  return json(marks.filter((m) => wanted === undefined || (wanted === 'open' ? m.status !== 'resolved' : m.status === wanted)))
}

/**
 * The layout a tool works in: the one asked for, else the one on screen, else
 * the first. An error that names the layouts when the build has none of that name.
 */
function layoutFor(deps: ToolDeps, objectId: string, scene: Scene, asked: string | undefined): string | ToolResult {
  const onScreen = deps.openObjectId() === objectId ? deps.view(objectId)?.layout : undefined
  const layout = asked ?? (onScreen !== undefined && scene.layouts.includes(onScreen) ? onScreen : scene.layouts[0])
  if (layout === undefined || !scene.layouts.includes(layout)) return failure(`no layout '${asked ?? ''}'; layouts: ${scene.layouts.join(', ') || 'none'}`)
  return layout
}

interface CheckedRef {
  part: Part
  target: 'part' | 'face' | 'edge'
}

/**
 * What a ref names in a layout of a build, or why it names nothing there, in
 * words that say what there is: the parts, or how many faces or edges the part has.
 */
function checkRef(scene: Scene, layout: string, ref: string): CheckedRef | string {
  const parts = scene.parts.filter((p) => p.layout === layout)
  const whole = parts.find((p) => p.name === ref)
  if (whole) return { part: whole, target: 'part' }
  const sub = /^(.*)\/([FE])(\d+)$/.exec(ref)
  const part = sub && parts.find((p) => p.name === sub[1])
  if (!sub || !part) {
    const name = sub ? sub[1] : ref
    const form = sub || !ref.includes('/') ? '' : '; a ref is a part, part/F<n> or part/E<n>'
    return `no part '${name}' in layout ${layout} (parts: ${parts.map((p) => p.name).join(', ') || 'none'})${form}`
  }
  const [letter, plural, count] = sub[2] === 'F' ? ['F', 'faces', part.faceCount] : ['E', 'edges', part.edgeCount]
  if (Number(sub[3]) >= count) return `${part.name} has ${count} ${plural}${count > 0 ? `, ${letter}0 to ${letter}${count - 1}` : ''}: there is no ${letter}${sub[3]}`
  return { part, target: sub[2] === 'F' ? 'face' : 'edge' }
}

export async function describeTool(deps: ToolDeps, objectId: string, args: DescribeArgs): Promise<ToolResult> {
  if (MARK_ID.test(args.ref)) {
    const marks = await marksOf(deps, objectId)
    if ('content' in marks) return marks
    const mark = marks.find((m) => m.id === args.ref)
    return mark ? json(mark) : noMark(args.ref, marks)
  }
  const found = built(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout
  const checked = checkRef(found.scene, layout, args.ref)
  if (typeof checked === 'string') return failure(checked)
  try {
    return json({ layout, ...(await deps.describe(objectId, layout, args.ref)) })
  } catch (e) {
    return failure(messageOf(e))
  }
}

/** The object a tool that touches the window works on, or the error to answer with when the window shows another. */
function onScreen(deps: ToolDeps, objectId: string): { obj: ObjectInfo; revision: number; scene: Scene } | ToolResult {
  const found = built(deps, objectId)
  if ('content' in found) return found
  if (deps.openObjectId() !== objectId) return failure(`${notOpen(found.obj, deps.openObjectId())}. Ask the user to open it.`)
  return found
}

export async function highlightTool(deps: ToolDeps, objectId: string, args: HighlightArgs): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout

  const refs: string[] = []
  const wrong: string[] = []
  let marks: Mark[] | undefined
  for (const ref of args.refs) {
    let named = ref
    if (MARK_ID.test(ref)) {
      if (!marks) {
        const read = await marksOf(deps, objectId)
        if ('content' in read) return read
        marks = read
      }
      const mark = marks.find((m) => m.id === ref)
      const on = mark && markAnchors(mark)[0]?.ref
      if (!mark) wrong.push(`no mark ${ref} (marks: ${marks.map((m) => m.id).join(', ') || 'none'})`)
      else if (mark.layout !== layout) wrong.push(`${ref} is in layout ${mark.layout}, not ${layout}`)
      else if (!on) wrong.push(`${ref} is not on a part, a face or an edge`)
      if (!mark || mark.layout !== layout || !on) continue
      named = on
    }
    const checked = checkRef(found.scene, layout, named)
    if (typeof checked === 'string') wrong.push(named === ref ? checked : `${ref} is on ${named}, but ${checked}`)
    else if (!refs.includes(named)) refs.push(named)
  }
  // All or nothing: a question about three faces is not asked of two.
  if (wrong.length > 0) return failure(`nothing was highlighted: ${wrong.join('; ')}`)

  const note = args.note?.trim().slice(0, MAX_NOTE)
  let done: HighlightResult
  try {
    done = await deps.highlight(objectId, layout, refs, note || undefined)
  } catch (e) {
    return failure(messageOf(e))
  }
  if (done.objectId !== objectId) return failure(`${notOpen(found.obj, done.objectId)}. Ask the user to open it.`)
  const newer = done.revision !== found.revision ? ` The window shows r${done.revision}, not r${found.revision}: check the refs with describe.` : ''
  return {
    content: [
      {
        type: 'text',
        text: `highlighted ${done.refs.join(', ')} in layout ${done.layout} for the user${note ? `, with the note "${note}"` : ''}, until they click in the viewport or 60 s pass.${newer}`
      }
    ]
  }
}

export async function showTool(deps: ToolDeps, objectId: string, args: ShowArgs): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const { obj, scene } = found
  if (args.view === undefined && args.layout === undefined && args.parts === undefined) return failure('nothing to show: give a view, a layout or parts')
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

  let shown: ShowResult
  try {
    shown = await deps.show(objectId, request)
  } catch (e) {
    return failure(messageOf(e))
  }
  if (shown.objectId !== objectId) return failure(`${notOpen(obj, shown.objectId)}. Ask the user to open it.`)
  return { content: [{ type: 'text', text: `${shown.caption}\nrevision r${shown.revision}${staleNote(deps, objectId, shown)}\nThe user's viewport now shows this.` }] }
}

/**
 * Where a mark of the agent's is tied to the geometry, as a re-anchored one
 * would be: the ref, the point, the normal there and what the kernel says of
 * it. Given a ref alone, the middle of that edge, or the point of the surface
 * nearest the centre of that face or part; given a point
 * alone, the part whose surface the point is on, or nothing but the point when
 * it is on none. `said` is what the agent should know of how that went.
 */
async function anchorFor(
  deps: ToolDeps,
  objectId: string,
  scene: Scene,
  layout: string,
  ref: string | undefined,
  point: Vec3 | undefined
): Promise<{ anchor: Anchor; target?: CheckedRef['target']; said?: string } | ToolResult> {
  const parts = scene.parts.filter((p) => p.layout === layout)
  try {
    if (ref === undefined) {
      if (!point) return failure('give a ref or a point')
      const found = parts.length > 0 ? await deps.nearest(objectId, layout, parts.map((p) => ({ part: p.name, point }))) : []
      let best: Anchor | undefined
      let least = Infinity
      found.forEach((one, i) => {
        if (!one.found || one.distance >= least) return
        const judged = judge({ point, part: one.part }, one, tolerance(parts[i].bbox))
        if (judged.state !== 'ok') return
        least = one.distance
        best = judged.anchor
      })
      return best ? { anchor: best } : { anchor: { point }, said: 'The point is on no part of this layout, so the mark is tied to none.' }
    }

    const checked = checkRef(scene, layout, ref)
    if (typeof checked === 'string') return failure(checked)
    const { part, target } = checked
    const described = await deps.describe(objectId, layout, ref)
    // A centre the kernel measured carries the noise of measuring: -3.5e-15 is 0.
    const base: Anchor = { point: point ?? tidy(centreOf(described, part)), part: part.name, ref, descriptor: described.descriptor }
    if (described.kind === 'face' && described.normal) base.normal = described.normal
    // The middle of an edge is on the edge: there is nothing to ask.
    if (target === 'edge' && !point) return { anchor: base, target }
    const [near] = await deps.nearest(objectId, layout, [{ part: part.name, point: base.point, ...(target === 'edge' ? { edge: ref } : {}) }])
    if (!near?.found) return { anchor: base, target }
    const within = near.distance <= tolerance(part.bbox)
    if (point) {
      if (target === 'edge') {
        // As the check that follows the adding would find it: off its edge, the mark would be said to have drifted at once.
        if (near.edgeFound !== true) return failure(`the kernel did not say how far the point ${vector(point)} is from ${ref}: leave the point out to use the middle of the edge`)
        if (near.edgeDistance > EDGE_TOLERANCE_MM) return failure(`the point ${vector(point)} is ${number(near.edgeDistance)} mm from ${ref}: give a point on the edge, or leave the point out to use its middle`)
        return { anchor: base, target }
      }
      if (!within) return failure(`the point ${vector(point)} is ${number(near.distance)} mm from the surface of ${part.name}: give a point on it, or leave the point out to use the centre of ${ref}`)
      // A pin or an arrow is on the face that is under its point, as it will be found to be after the next build.
      if (target === 'face' && near.ref !== ref) {
        const { anchor } = judge({ point, part: part.name }, near, Infinity)
        return { anchor, target, said: `The point is on ${near.ref}, not ${ref}: the mark is tied to ${near.ref}.` }
      }
      if (near.normal) base.normal = near.normal
      return { anchor: base, target }
    }
    // The mark is checked against the build the moment it is kept, and one whose point is off the surface
    // is said to have drifted. The centre of a face may not be on it (a cylinder's is on its axis, a ring's
    // in its hole), and that of a part is inside it: the mark goes to the point of the surface nearest to it.
    const anchor: Anchor = { ...base, point: tidy(near.point) }
    if (near.normal) anchor.normal = near.normal
    if (target === 'face' && near.ref !== ref && !within) {
      return { anchor, target, said: `The centre of ${ref} is not on it: the mark is at the nearest point of the surface of ${part.name}, ${vector(near.point)}, which is on ${near.ref}. Give a point on ${ref} to put it there.` }
    }
    return { anchor, target }
  } catch (e) {
    return failure(messageOf(e))
  }
}

function centreOf(described: Described, part: Part): Vec3 {
  if (described.kind !== 'part') return described.center
  const { min, max } = described.bbox ?? part.bbox
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

/**
 * A view of a mark the agent placed, for "go to its view" in the window: at
 * the mark from the side its surface faces, far enough back to see the parts.
 */
function markCamera(scene: Scene, layout: string, at: Vec3, normal: Vec3 | undefined): Camera {
  const parts = scene.parts.filter((p) => p.layout === layout)
  let diagonal = 0
  if (parts.length > 0) {
    const min = [0, 1, 2].map((i) => Math.min(...parts.map((p) => p.bbox.min[i])))
    const max = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p.bbox.max[i])))
    diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  }
  const distance = Math.max(50, 1.7 * diagonal)
  // The usual three-quarter view, from the side of each axis that the surface faces.
  const from = [1, -1, 0.8].map((c, i) => (normal && Math.abs(normal[i]) > 0.3 ? Math.abs(c) * Math.sign(normal[i]) : c))
  const length = Math.hypot(from[0], from[1], from[2])
  const position = at.map((c, i) => c + (from[i] / length) * distance) as Vec3
  return { position, target: at, up: [0, 0, 1], ortho: false, fov: FOV, zoom: 1 }
}

export async function addMarkTool(deps: ToolDeps, objectId: string, args: AddMarkArgs): Promise<ToolResult> {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { scene, revision } = found
  const layout = layoutFor(deps, objectId, scene, args.layout)
  if (typeof layout !== 'string') return layout
  const base = { author: 'agent', note: args.note.slice(0, MAX_NOTE), layout, revision } as const

  let mark: NewMark
  let said: string | undefined
  if (args.kind === 'shape') {
    const missing = (['shape', 'size', 'position', 'intent'] as const).filter((key) => args[key] === undefined)
    if (missing.length > 0) return failure(`a shape needs ${missing.join(', ')}: shape is one of ${SHAPES.join(', ')}; intent one of ${INTENTS.join(', ')}; size and position are [x, y, z] in mm`)
    const [x, y, z] = args.size!
    const flat = args.shape === 'plane'
    if (x <= 0 || (args.shape !== 'cylinder' && args.shape !== 'sphere' && y <= 0) || (!flat && args.shape !== 'sphere' && z <= 0)) return failure(`the size of a ${args.shape} must be positive: ${vector(args.size!)}`)
    const size: Vec3 = args.shape === 'cylinder' ? [x, x, z] : args.shape === 'sphere' ? [x, x, x] : flat ? [x, y, 0] : [x, y, z]
    const rotation = args.rotation ?? [0, 0, 0, 1]
    const length = Math.hypot(...rotation)
    if (length < 1e-9) return failure('rotation is a quaternion [x, y, z, w]: it cannot be all zeros')
    let anchor: Anchor | undefined
    if (args.ref !== undefined) {
      const tied = await anchorFor(deps, objectId, scene, layout, args.ref, args.point)
      if ('content' in tied) return tied
      anchor = tied.anchor
      said = tied.said
    }
    mark = {
      ...base,
      kind: 'shape',
      shape: args.shape!,
      intent: args.intent!,
      position: args.position!,
      rotation: rotation.map((c) => c / length) as Quat,
      size,
      camera: markCamera(scene, layout, args.position!, undefined),
      ...(anchor ? { anchor } : {})
    }
  } else {
    if (args.kind === 'pick' && args.ref === undefined) return failure('a pick needs a ref: the part, face or edge it is of. For a point, place a pin')
    if (args.ref === undefined && args.point === undefined) return failure(`${args.kind === 'arrow' ? 'an arrow' : 'a pin'} needs a ref or a point${args.kind === 'arrow' ? ' to start from' : ''}`)
    if (args.kind === 'arrow' && args.to === undefined && args.by === undefined) return failure('an arrow needs to (where it ends) or by (the vector from its start), in mm')
    const tied = await anchorFor(deps, objectId, scene, layout, args.ref, args.point)
    if ('content' in tied) return tied
    const { anchor } = tied
    said = tied.said
    const camera = markCamera(scene, layout, anchor.point, anchor.normal)
    if (args.kind === 'pin') mark = { ...base, kind: 'pin', anchor, camera }
    else if (args.kind === 'pick') mark = { ...base, kind: 'pick', target: tied.target ?? 'part', anchor, camera }
    else {
      const to = args.to ?? (anchor.point.map((c, i) => c + args.by![i]) as Vec3)
      if (to.every((c, i) => Math.abs(c - anchor.point[i]) < 1e-6)) return failure(`the arrow would end where it starts, at ${vector(anchor.point)}`)
      mark = { ...base, kind: 'arrow', from: anchor, to, camera }
    }
  }

  let added: Mark
  try {
    added = await deps.addMark(objectId, mark)
  } catch (e) {
    return failure(messageOf(e))
  }
  return { content: [{ type: 'text', text: `placed in layout ${layout}: ${describeMark(added)}${said ? `\n${said}` : ''}` }] }
}

export async function resolveMarkTool(deps: ToolDeps, objectId: string, args: ResolveMarkArgs): Promise<ToolResult> {
  if (!deps.object(objectId)) return failure(`unknown object: ${objectId}`)
  if (!MARK_ID.test(args.id)) {
    const marks = await marksOf(deps, objectId)
    return 'content' in marks ? marks : noMark(args.id, marks)
  }
  const note = args.note?.trim().slice(0, MAX_NOTE)
  try {
    const mark = await deps.updateMark(objectId, args.id, { status: 'resolved', ...(note ? { resolvedNote: note } : {}) })
    return { content: [{ type: 'text', text: `resolved: ${describeMark(mark)}${mark.resolvedNote ? `\nnote: ${mark.resolvedNote}` : ''}` }] }
  } catch (e) {
    return failure(messageOf(e))
  }
}

function clampSize(size: number | undefined): number {
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

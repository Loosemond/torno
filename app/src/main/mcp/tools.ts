import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BuildState } from '../../shared/build'
import type { Scene } from '../../shared/scene'
import type { Camera, LookRequest, LookResult, ViewState } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'

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

const lookInput = {
  view: z
    .union([
      z.enum(['current', ...VIEW_NAMES]),
      z.object({ position: vec3, target: vec3, up: vec3.optional(), ortho: z.boolean().optional() })
    ])
    .optional()
    .describe(
      "'current' (the default) is the user's own camera. iso, front, back, left, right, top and bottom are orthographic views fitted to the parts. Or a camera: {position, target, up?, ortho?} in mm, Z up."
    ),
  layout: z.string().optional().describe('The layout to draw, as listed by scene. Default: the one on screen.'),
  parts: z.array(z.string()).optional().describe('Names of the parts to draw. Default: the parts the user has switched on.'),
  size: z.number().optional().describe(`Long edge of the image in pixels, ${MIN_SIZE} to ${MAX_SIZE}. Default ${DEFAULT_SIZE}.`)
}

export interface LookArgs {
  view?: 'current' | (typeof VIEW_NAMES)[number] | { position: Vec3; target: Vec3; up?: Vec3; ortho?: boolean }
  layout?: string
  parts?: string[]
  size?: number
}

type Vec3 = [number, number, number]

export const TOOLS = {
  scene: {
    description:
      'Returns JSON for the object this session works on: the build status, revision and error, its layouts, every part with size, bounding box, volume, face and edge counts in mm, and what the user sees (layout, visible parts, camera). Call it after every edit of the model to check that the build passed, and whenever you need dimensions.'
  },
  look: {
    description:
      "Returns a PNG of the object drawn by the same viewport the user is looking at, with a caption naming the view, layout, parts, revision and whether the parts are stale. Call it with no arguments to see exactly what the user sees, or with a named view, a camera, a layout or a list of parts to check the shape after a change.",
    inputSchema: lookInput
  }
}

/** The tools of one object's MCP server. */
export function registerTools(server: McpServer, deps: ToolDeps, objectId: string): void {
  server.registerTool('scene', { description: TOOLS.scene.description }, async () => sceneTool(deps, objectId))
  server.registerTool('look', TOOLS.look, async (args) => lookTool(deps, objectId, args))
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
function staleNote(deps: ToolDeps, objectId: string, picture: LookResult): string {
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

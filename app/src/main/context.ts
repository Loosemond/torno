import type { BuildState } from '../shared/build'
import type { Scene } from '../shared/scene'
import type { ViewState } from '../shared/view'
import type { ObjectInfo } from '../shared/workspace'

/** The most the agent is given with a prompt, in characters. */
export const CONTEXT_LIMIT = 1500

const TRACEBACK_LINES = 12
const MESSAGE_LIMIT = 400
const TOOLS = 'Tools: mcp__torno__scene, mcp__torno__look.'

export interface ContextDeps {
  object(objectId: string): ObjectInfo | undefined
  build(objectId: string): BuildState | undefined
  /** The last successful build. */
  scene(objectId: string): { revision: number; scene: Scene } | undefined
  /** What the window shows of the object, when it is the one open there. */
  view(objectId: string): ViewState | undefined
  /** The object the window shows. */
  openObjectId(): string | null
  now?(): number
}

/**
 * What the agent is told with every prompt in an object: whether the last build
 * worked, and what is on screen. At most CONTEXT_LIMIT characters; '' for an
 * object that is not in the workspace.
 */
export function contextFor(deps: ContextDeps, objectId: string): string {
  // Every part below is fitted to the limit by what it can spare; this cut
  // holds for what none of them foresaw, such as a very long name.
  return cutEnd(describe(deps, objectId), CONTEXT_LIMIT)
}

function describe(deps: ContextDeps, objectId: string): string {
  const obj = deps.object(objectId)
  if (!obj) return ''
  // The window shows one object; of another, nothing is on screen: no layout, and no parts "showing".
  const open = deps.openObjectId() === objectId
  const head = open ? `[torno] ${obj.name}` : `[torno] ${obj.name} · not open in the torno window`
  const onScreen = open ? 'showing' : 'last built'
  const build = deps.build(objectId)
  if (!build || build.status === 'idle') return `${head} · not built yet.`

  if (build.status === 'building') {
    const running =
      build.startedAt === undefined ? '' : ` (${Math.max(0, Math.floor(((deps.now?.() ?? Date.now()) - build.startedAt) / 1000))} s so far)`
    const shown = build.revision > 0 ? `${onScreen} r${build.revision}` : 'nothing built yet'
    return `${head} · building${running} · ${shown}.`
  }

  if (build.status === 'failed') {
    const shown = build.revision > 0 ? `${onScreen} r${build.revision}${open ? ' (stale)' : ''}` : 'nothing built yet'
    const first = `${head} · BUILD FAILED · ${shown}.`
    const message = cutEnd(build.error?.message ?? 'no reason was given', MESSAGE_LIMIT)
    const traceback = lastLines(build.error?.traceback ?? '', TRACEBACK_LINES)
    const room = CONTEXT_LIMIT - first.length - message.length - 2
    if (!traceback || room < 2) return `${first}\n${message}`
    // What is cut is the start of the traceback: its end says what went wrong.
    return `${first}\n${message}\n${cutStart(traceback, room)}`
  }

  const duration = build.seconds === undefined ? '' : ` (${build.seconds.toFixed(1)} s)`
  const start = `${head} · build ok · r${build.revision}${duration}`
  const scene = deps.scene(objectId)?.scene
  if (!scene) return `${start}. ${TOOLS}`
  if (!open) {
    const lead = `${start} · parts: `
    const names = [...new Set(scene.parts.map((p) => p.name))]
    return `${lead}${fitted(names, '', CONTEXT_LIMIT - lead.length - TOOLS.length - 2)}. ${TOOLS}`
  }
  const view = deps.view(objectId)
  const layout = view && scene.layouts.includes(view.layout) ? view.layout : (scene.layouts[0] ?? '')
  const parts = scene.parts.filter((p) => p.layout === layout)
  const hidden = view ? parts.filter((p) => !view.visible.includes(p.key)).map((p) => p.name) : []
  const lead = `${start} · layout ${layout} · parts: `
  const names = parts.map((p) => p.name)
  const room = CONTEXT_LIMIT - lead.length - TOOLS.length - 2
  return `${lead}${fitted(names, hidden.length > 0 ? ` (hidden: ${hidden.join(', ')})` : '', room)}. ${TOOLS}`
}

/** The names and what follows them, or as many of the names as fit in `room` characters. */
function fitted(names: string[], after: string, room: number): string {
  const full = names.join(', ') + after
  return full.length <= room ? full : someOf(names, room)
}

/** As many of the names as fit in `room` characters, and how many were left out. */
function someOf(names: string[], room: number): string {
  let text = ''
  for (let i = 0; i < names.length; i += 1) {
    const next = i === 0 ? names[i] : `${text}, ${names[i]}`
    const rest = ` and ${names.length - i - 1} more`
    if (next.length + rest.length > room) return `${text} and ${names.length - i} more`
    text = next
  }
  return text
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n')
}

function cutEnd(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function cutStart(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`
}

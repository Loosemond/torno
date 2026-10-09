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
  now?(): number
}

/**
 * What the agent is told with every prompt in an object: whether the last build
 * worked, and what is on screen. At most CONTEXT_LIMIT characters; '' for an
 * object that is not in the workspace.
 */
export function contextFor(deps: ContextDeps, objectId: string): string {
  const obj = deps.object(objectId)
  if (!obj) return ''
  const head = `[torno] ${obj.name}`
  const build = deps.build(objectId)
  if (!build || build.status === 'idle') return `${head} · not built yet.`

  if (build.status === 'building') {
    const seconds = Math.max(0, Math.floor(((deps.now?.() ?? Date.now()) - (build.startedAt ?? 0)) / 1000))
    const shown = build.revision > 0 ? `showing r${build.revision}` : 'nothing built yet'
    return `${head} · building (${seconds} s so far) · ${shown}.`
  }

  if (build.status === 'failed') {
    const shown = build.revision > 0 ? `showing r${build.revision} (stale)` : 'nothing built yet'
    const first = `${head} · BUILD FAILED · ${shown}.`
    const message = cutEnd(build.error?.message ?? 'no reason was given', MESSAGE_LIMIT)
    const traceback = lastLines(build.error?.traceback ?? '', TRACEBACK_LINES)
    if (!traceback) return `${first}\n${message}`
    // What is cut is the start of the traceback: its end says what went wrong.
    return `${first}\n${message}\n${cutStart(traceback, CONTEXT_LIMIT - first.length - message.length - 2)}`
  }

  const duration = build.seconds === undefined ? '' : ` (${build.seconds.toFixed(1)} s)`
  const start = `${head} · build ok · r${build.revision}${duration}`
  const scene = deps.scene(objectId)?.scene
  if (!scene) return `${start}. ${TOOLS}`
  const view = deps.view(objectId)
  const layout = view && scene.layouts.includes(view.layout) ? view.layout : (scene.layouts[0] ?? '')
  const parts = scene.parts.filter((p) => p.layout === layout)
  const hidden = view ? parts.filter((p) => !view.visible.includes(p.key)).map((p) => p.name) : []
  const lead = `${start} · layout ${layout} · parts: `
  const names = parts.map((p) => p.name)
  const room = CONTEXT_LIMIT - lead.length - TOOLS.length - 2
  const full = names.join(', ') + (hidden.length > 0 ? ` (hidden: ${hidden.join(', ')})` : '')
  return `${lead}${full.length <= room ? full : someOf(names, room)}. ${TOOLS}`
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

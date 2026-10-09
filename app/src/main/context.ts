import type { BuildState } from '../shared/build'
import type { Mark } from '../shared/marks'
import type { Scene } from '../shared/scene'
import type { ViewState } from '../shared/view'
import type { ObjectInfo } from '../shared/workspace'
import { describeMark } from './marks/describe'

/** The most the agent is given with a prompt, in characters. */
export const CONTEXT_LIMIT = 6000
/** The most of it that says how the build stands, when there are marks to tell of as well. */
const STATUS_LIMIT = 2000
/** The most of it that lists the numbers of the marks still open. */
const OPEN_LIMIT = 300

const TRACEBACK_LINES = 12
const MESSAGE_LIMIT = 400
const MARKS_HEAD = 'Marks from the user (drawn in look pictures with these numbers):'

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

/** What goes with a prompt, and the marks it tells of for the first time: sent, once the agent has it. */
export interface PromptContext {
  text: string
  sentMarkIds: string[]
}

/**
 * What the agent is told with every prompt in an object: whether the last build
 * worked, what is on screen, each mark the person has left since the last
 * prompt (the drafts, oldest first, a line each) and the numbers of the marks
 * still open. At most CONTEXT_LIMIT characters: drafts that do not fit are
 * counted, not listed, and are not among `sentMarkIds`. Nothing for an object
 * that is not in the workspace.
 *
 * It changes nothing: whoever delivers the text turns `sentMarkIds` into sent.
 */
export function contextFor(deps: ContextDeps, objectId: string, marks: readonly Mark[] = []): PromptContext {
  // The agent's own marks are never news to it, whatever their status.
  const drafts = marks.filter((m) => m.status === 'draft' && m.author === 'user')
  const open = marks.filter((m) => m.status !== 'resolved' && !drafts.includes(m))
  const told = drafts.length > 0 || open.length > 0
  const limit = told ? STATUS_LIMIT : CONTEXT_LIMIT
  // Every part of it is fitted to the limit by what it can spare; the cut holds for what none of them
  // foresaw, such as a very long name.
  const lines = [cutEnd(status(deps, objectId, limit), limit)]
  if (lines[0] === '') return { text: '', sentMarkIds: [] }
  const openLine = open.length > 0 ? `Open marks: ${fitted(open.map((m) => m.id), '', OPEN_LIMIT)}` : ''
  const sentMarkIds: string[] = []
  if (drafts.length > 0) {
    const named = layoutNamed(deps, objectId)
    lines.push(MARKS_HEAD)
    const more = (count: number): string => `… and ${count} more: call mcp__torno__marks`
    let used = lines.join('\n').length + (openLine ? openLine.length + 1 : 0)
    for (const [i, mark] of drafts.entries()) {
      // A mark's coordinates and refs are in the frame of its layout, which may not be the one named above.
      const line = `${describeMark(mark)}${mark.layout === named ? '' : ` [in layout ${mark.layout}]`}`
      const after = drafts.length - i - 1
      // Room is kept for the line that says how many are left out, should the next one not fit.
      if (used + 1 + line.length + (after > 0 ? 1 + more(after).length : 0) > CONTEXT_LIMIT) {
        lines.push(more(drafts.length - i))
        break
      }
      lines.push(line)
      used += 1 + line.length
      sentMarkIds.push(mark.id)
    }
  }
  if (openLine) lines.push(openLine)
  return { text: lines.join('\n'), sentMarkIds }
}

/** The layout on screen of an object that is open in the window: the one asked for by the view, when the build has it. */
function layoutShown(view: ViewState | undefined, scene: Scene): string {
  return view && scene.layouts.includes(view.layout) ? view.layout : (scene.layouts[0] ?? '')
}

/**
 * The layout the agent takes a mark to be in when nothing says otherwise: the
 * one the first line names (`status` does for a build that worked, of the
 * object open in the window), or the only one such an object has.
 */
function layoutNamed(deps: ContextDeps, objectId: string): string | undefined {
  const scene = deps.scene(objectId)?.scene
  if (!scene || deps.openObjectId() !== objectId) return undefined
  if (deps.build(objectId)?.status === 'ok') return layoutShown(deps.view(objectId), scene)
  return scene.layouts.length === 1 ? scene.layouts[0] : undefined
}

/** How the build stands and what is on screen, in at most `limit` characters. */
function status(deps: ContextDeps, objectId: string, limit: number): string {
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
    const room = limit - first.length - message.length - 2
    if (!traceback || room < 2) return `${first}\n${message}`
    // What is cut is the start of the traceback: its end says what went wrong.
    return `${first}\n${message}\n${cutStart(traceback, room)}`
  }

  const duration = build.seconds === undefined ? '' : ` (${build.seconds.toFixed(1)} s)`
  const start = `${head} · build ok · r${build.revision}${duration}`
  const scene = deps.scene(objectId)?.scene
  if (!scene) return `${start}.`
  if (!open) {
    const lead = `${start} · parts: `
    const names = [...new Set(scene.parts.map((p) => p.name))]
    return `${lead}${fitted(names, '', limit - lead.length - 1)}.`
  }
  const view = deps.view(objectId)
  const layout = layoutShown(view, scene)
  const parts = scene.parts.filter((p) => p.layout === layout)
  const hidden = view ? parts.filter((p) => !view.visible.includes(p.key)).map((p) => p.name) : []
  const lead = `${start} · layout ${layout} · parts: `
  const names = parts.map((p) => p.name)
  const room = limit - lead.length - 1
  return `${lead}${fitted(names, hidden.length > 0 ? ` (hidden: ${hidden.join(', ')})` : '', room)}.`
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

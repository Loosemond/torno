import { type ChatItem, TORNO_TOOL_PREFIX } from '../../../shared/chat'
import type { Verdict } from '../../../shared/sanity'

/** The tools of Claude Code that write a file. */
const WRITES = new Set(['Edit', 'Write', 'MultiEdit'])

/** What a turn did, said from its own items and nothing else: no number here that the kernel did not give. */
export interface TurnSummary {
  /** The files the agent edited or wrote, in the order it first did, by path as the tool was given it, and how many times. */
  files: Array<{ path: string; edits: number }>
  /** The builds the turn's edits started. `from`: the build on show when the prompt was sent; `to`: the last that worked. */
  builds?: { from?: number; to?: number; failed: number; lastFailed: boolean }
  /** The marks the agent placed and the marks it resolved, as `M3`. */
  added: string[]
  resolved: string[]
  /** The dimensions whose verdict at the end of the turn is another than at its start, as far as the builds measured them. */
  dimensions: Array<{ id: string; now: Verdict }>
}

/** The items of one turn: after the turn before it, up to its own end. Empty for an id that is not a turn. */
export function itemsOfTurn(items: readonly ChatItem[], turnId: string): ChatItem[] {
  const end = items.findIndex((item) => item.kind === 'turn' && item.id === turnId)
  if (end < 0) return []
  let start = end
  while (start > 0 && items[start - 1].kind !== 'turn') start -= 1
  return items.slice(start, end)
}

const base = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** The place an edit tool was given: its `file_path`. */
function pathOf(input: unknown): string | undefined {
  const path = typeof input === 'object' && input !== null ? (input as { file_path?: unknown }).file_path : undefined
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** The number of a mark an `add_mark` placed, from what it answered: `placed in layout main: (yours) M5 pin ...`. */
function placedMark(result: string | undefined): string | undefined {
  return result === undefined ? undefined : /placed in layout [^\n]*?: (?:\([^)]*\) )?(M\d+)\b/.exec(result)?.[1]
}

/** What the items of a turn (`itemsOfTurn`) did to the project. */
export function turnSummary(items: readonly ChatItem[]): TurnSummary {
  const files = new Map<string, number>()
  const added: string[] = []
  const resolved: string[] = []
  let from: number | undefined
  let to: number | undefined
  let failed = 0
  let built = 0
  let lastFailed = false
  const first = new Map<string, Verdict>()
  const last = new Map<string, Verdict>()

  for (const item of items) {
    if (item.kind === 'context' && !item.forTool) {
      // The build on show when the prompt was sent: the start of "r1 → r3".
      if (from === undefined && item.revision !== undefined) from = item.revision
    } else if (item.kind === 'context') {
      if (item.buildState === 'ok') {
        built += 1
        lastFailed = false
        if (item.revision !== undefined) to = item.revision
      } else if (item.buildState === 'failed') {
        built += 1
        failed += 1
        lastFailed = true
      }
      for (const change of item.digest?.dimensions ?? []) {
        if (!first.has(change.id)) first.set(change.id, change.was)
        last.set(change.id, change.now)
      }
    } else if (item.kind === 'tool' && item.state === 'done') {
      if (WRITES.has(item.name)) {
        const path = pathOf(item.input)
        if (path) files.set(path, (files.get(path) ?? 0) + 1)
      } else if (item.name === `${TORNO_TOOL_PREFIX}add_mark`) {
        const id = placedMark(item.result)
        if (id && !added.includes(id)) added.push(id)
      } else if (item.name === `${TORNO_TOOL_PREFIX}resolve_mark`) {
        const id = typeof item.input === 'object' && item.input !== null ? (item.input as { id?: unknown }).id : undefined
        if (typeof id === 'string' && /^M\d+$/.test(id) && item.result?.startsWith('resolved:') && !resolved.includes(id)) resolved.push(id)
      }
    }
  }

  const dimensions = [...last].flatMap(([id, now]) => (first.get(id) === now ? [] : [{ id, now }]))
  return {
    files: [...files].map(([path, edits]) => ({ path, edits })),
    ...(built > 0 ? { builds: { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), failed, lastFailed } } : {}),
    added,
    resolved,
    dimensions
  }
}

/** Whether the turn changed anything this can say. */
export const isEmpty = (s: TurnSummary): boolean => s.files.length === 0 && !s.builds && s.added.length === 0 && s.resolved.length === 0 && s.dimensions.length === 0

/** The most of a kind named one by one; the rest are counted. */
const MOST = 3

const list = (names: string[], what: string): string => (names.length <= MOST ? names.join(', ') : `${names.slice(0, MOST).join(', ')} and ${names.length - MOST} more ${what}`)

/** What a dimension's verdict became, in words. */
const NOW: Record<Verdict, string> = { pass: 'now passes', fail: 'now fails', none: 'is no longer measured' }

/** The account as short phrases, one for each thing: `hollow.py edited ×2`, `r1 → r3 ok`, `resolved M1`, `added M5`, `M3 now passes`. */
export function summaryParts(s: TurnSummary): string[] {
  const parts: string[] = []
  if (s.files.length > 0) {
    const names = s.files.map((f) => base(f.path))
    const times = s.files.reduce((n, f) => n + f.edits, 0)
    parts.push(s.files.length === 1 ? `${names[0]} edited${times > 1 ? ` ×${times}` : ''}` : `${list(names, 'files')} edited`)
  }
  if (s.builds) {
    const { from, to, failed, lastFailed } = s.builds
    if (lastFailed) parts.push(failed > 1 ? `${failed} builds failed` : 'build failed')
    else {
      const range = to === undefined ? 'built' : from !== undefined && from !== to ? `r${from} → r${to} ok` : `r${to} ok`
      parts.push(failed > 0 ? `${range} after ${failed} failed ${failed === 1 ? 'build' : 'builds'}` : range)
    }
  }
  if (s.resolved.length > 0) parts.push(`resolved ${list(s.resolved, 'marks')}`)
  if (s.added.length > 0) parts.push(`added ${list(s.added, 'marks')}`)
  for (const d of s.dimensions.slice(0, MOST)) parts.push(`${d.id} ${NOW[d.now]}`)
  if (s.dimensions.length > MOST) parts.push(`${s.dimensions.length - MOST} more dimensions changed`)
  return parts
}

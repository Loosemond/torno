import type { ChatItem } from '../../../shared/chat'
import { isTaskTool } from './taskList'

// A turn of thirty `Read`, `Grep` and `Bash` calls is thirty lines. Once the turn is over, a run of three or more of
// the agent's own tools that finished is drawn as one line, "Read 3 files, Grep ×2, Bash", to open. Drawing only: the
// items are the transcript, and folding changes none of them.

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** The fewest tools that fold. */
export const FOLD_AT = 3

/** One thing the pane draws: an item as it is, or a run of tools drawn as one line (`items` are all it holds, the tools and the thoughts between them). */
export type Entry = { kind: 'item'; item: ChatItem } | { kind: 'fold'; id: string; items: ChatItem[]; label: string }

/** Whether a tool is one that folds: the agent's own, finished, with nothing under it that is not its line (a picture, the build it started) and no list of tasks. */
export function foldable(item: ChatItem, under: ReadonlySet<string>): item is Tool {
  return item.kind === 'tool' && !item.torno && item.state === 'done' && item.images.length === 0 && !under.has(item.id) && !isTaskTool(item)
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A tool's name as the line says it: `mcp__server__tool` as `server · tool`. */
const nameOf = (name: string): string => (name.startsWith('mcp__') ? name.slice(5).replace('__', ' · ') : name)

/** "Read 3 files, Grep ×2, Bash": what the run did, each tool once, in the order it first came. */
export function foldLabel(tools: readonly Tool[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (name === 'Read' ? `Read ${plural(n, 'file', 'files')}` : n === 1 ? nameOf(name) : `${nameOf(name)} ×${n}`)).join(', ')
}

/**
 * The items as they are drawn: every run of `FOLD_AT` tools or more that `foldable` accepts, which lies before the end
 * of a turn (a turn still going on shows every line as it comes), as one entry. A thought between two tools of a run is
 * part of it; any other item ends it. `under` is the ids of the items something is drawn under.
 */
export function foldRuns(order: readonly ChatItem[], under: ReadonlySet<string>): Entry[] {
  const lastTurn = order.map((item) => item.kind).lastIndexOf('turn')
  const out: Entry[] = []
  let at = 0
  while (at < order.length) {
    const item = order[at]
    if (at < lastTurn && foldable(item, under)) {
      // To the last tool of the run: thoughts that are over may stand between.
      let end = at
      for (let next = at + 1; next < lastTurn; next++) {
        const one = order[next]
        if (foldable(one, under)) end = next
        else if (!(one.kind === 'thinking' && !one.streaming)) break
      }
      const items = order.slice(at, end + 1)
      const tools = items.filter((one): one is Tool => one.kind === 'tool')
      if (tools.length >= FOLD_AT) {
        out.push({ kind: 'fold', id: items[0].id, items, label: foldLabel(tools) })
        at = end + 1
        continue
      }
    }
    out.push({ kind: 'item', item })
    at++
  }
  return out
}

import { memo, useMemo, useRef, useState } from 'react'
import type { ChatItem } from '../../../shared/chat'
import { drawn } from '../../state/chat'
import { numbered } from '../numbered'
import { AskCard } from './AskCard'
import { BuildLine } from './BuildLine'
import { Markdown } from './markdown'
import { YOUR_MESSAGE } from './gone'
import { DrawnOverLine } from './DrawnOver'
import { Pictures } from './Pictures'
import { RefChip } from './RefChip'
import { useChatOffers } from './offers'
import { ToolCard } from './ToolCard'
import { type Entry, foldRuns } from './fold'
import { TasksCard } from './Tasks'
import { isTaskTool, listsAt } from './taskList'
import { TurnEnd } from './TurnEnd'
import { netParts, turnSummary, type TurnAccount } from './turnSummary'

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

/** Under test only: how many times each item has been drawn, for the check that a delta draws its own item and no other. */
const counted = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test')
function counting(id: string): void {
  if (!counted) return
  const counts = ((window as unknown as { __tornoChatRenders?: Record<string, number> }).__tornoChatRenders ??= {})
  counts[id] = (counts[id] ?? 0) + 1
}

/** The still dot of something under way: set by the one-second beat the pane keeps, and by no animation that runs on. */
function Dot({ beat }: { beat: boolean }) {
  return <span className="chat-dot" data-beat={beat ? undefined : 'off'} aria-hidden="true" />
}

/**
 * What torno added to a prompt, under it: the marks it told of, the build, the selection, as chips that are live,
 * and the exact text the agent was given, to open out.
 */
const Added = memo(function Added({ item }: { item: Of<'context'> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="chat-item chat-added" data-kind="context">
      <div className="chat-added-line">
        <span className="chat-added-label">torno added</span>
        {item.marks.map((id) => (
          <RefChip key={id} value={id} />
        ))}
        {item.revision !== undefined && item.buildState && (
          <span className="chat-added-build">
            {item.buildState === 'failed' ? (
              <>
                build after <RefChip value={`r${item.revision}`} /> <span data-verdict="failed">failed</span>
              </>
            ) : (
              <>
                <RefChip value={`r${item.revision}`} /> <span data-verdict={item.buildState}>{item.buildState}</span>
              </>
            )}
          </span>
        )}
        {item.selection && item.selection.length > 0 && (
          <span className="chat-added-selection">
            selection:{' '}
            {item.selection.map((ref) => (
              <RefChip key={ref} value={ref} />
            ))}
          </span>
        )}
        {item.instructions !== undefined && item.instructions > 0 && (
          <span className="chat-added-instructions" title="The instruction files Claude Code reads here, named in the text below">
            <span className="num">{item.instructions}</span> instruction {item.instructions === 1 ? 'file' : 'files'}
          </span>
        )}
        <button type="button" className="chat-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide text' : 'Show text'}
        </button>
      </div>
      {open && <pre className="chat-pre chat-added-text selectable">{item.text}</pre>}
    </div>
  )
})

const User = memo(function User({ item }: { item: Of<'user'> }) {
  return (
    <div className="chat-item chat-user" data-kind="user" data-state={item.state}>
      {item.text !== '' && <p className="chat-user-text selectable">{numbered(item.text)}</p>}
      <Pictures images={item.images} what={YOUR_MESSAGE} />
      {item.drawing && (
        <p className="chat-user-drawing">
          <DrawnOverLine drawn={item.drawing} />
        </p>
      )}
      {item.state === 'queued' && <p className="chat-user-state">Queued</p>}
      {item.state === 'not-sent' && <p className="chat-user-state">Not sent</p>}
    </div>
  )
})

/**
 * One item of the transcript. Memoized: an item that did not change (the pane keeps its object) is not drawn again
 * for what else changes; `beat` is passed only to the items that show a dot, a constant to the rest.
 */
export const ItemView = memo(function ItemView({ item, beat, account }: { item: ChatItem; beat: boolean; account?: TurnAccount }) {
  counting(item.id)
  switch (item.kind) {
    case 'user':
      return <User item={item} />
    case 'context':
      return item.forTool ? <BuildLine item={item} /> : <Added item={item} />
    case 'text':
      return (
        <div className="chat-item chat-text" data-kind="text">
          <Markdown text={item.text} />
          {item.streaming && <Dot beat={beat} />}
        </div>
      )
    case 'thinking':
      return (
        <p className="chat-item chat-note" data-kind="thinking">
          {item.streaming ? (
            <>
              Thinking <Dot beat={beat} />
            </>
          ) : item.seconds !== undefined ? (
            <>Thought for {numbered(`${Math.max(1, Math.round(item.seconds))} s`)}</>
          ) : (
            'Thought'
          )}
        </p>
      )
    case 'tool':
      return <ToolCard item={item} beat={beat} />
    case 'ask':
      return <AskCard item={item} />
    case 'turn':
      return <TurnEnd item={item} account={account} />
    case 'note':
      return item.action === 'terminal' ? (
        <TerminalOffer item={item} />
      ) : (
        <p className="chat-item chat-note" data-kind="note" data-tone={item.tone}>
          {numbered(item.text)}
        </p>
      )
  }
})

/** A note with "Use the terminal" beside it, when the pane offers it (`useChatOffers`); the words alone otherwise. */
function TerminalOffer({ item }: { item: Of<'note'> }) {
  const { terminal } = useChatOffers()
  return (
    <p className="chat-item chat-note chat-offer" data-kind="note" data-tone={item.tone}>
      <span>{numbered(item.text)}</span>
      {terminal && (
        <button type="button" className="button button-quiet" disabled={terminal.disabled} title="Run this project's sessions in Claude Code's own terminal. The same conversation goes on." onClick={terminal.take}>
          Use the terminal
        </button>
      )}
    </p>
  )
}

/** Whether an item is something under way, which shows a dot that beats. */
const underWay = (item: ChatItem): boolean => ((item.kind === 'text' || item.kind === 'thinking') && item.streaming) || (item.kind === 'tool' && item.state === 'running')

/**
 * A run of the agent's tools, once its turn has ended, as one line: what it did ("Read 3 files, Grep ×2, Bash"), to
 * open into the lines themselves. Drawing only: the items are the same ones.
 */
function ToolFold({ entry }: { entry: Extract<Entry, { kind: 'fold' }> }) {
  const [open, setOpen] = useState(false)
  const count = entry.items.filter((item) => item.kind === 'tool').length
  return (
    <div className="chat-fold" data-fold={entry.id}>
      <div className="chat-item chat-tool chat-fold-head" data-kind="fold">
        <div className="chat-tool-row">
          <button type="button" className="chat-tool-line" aria-expanded={open} aria-label={`${entry.label}: ${count} tools`} title={entry.label} onClick={() => setOpen(!open)} />
          <span className="chat-tool-label">{numbered(entry.label)}</span>
          <span className="chat-tool-steps">{numbered(`${count} tools`)}</span>
        </div>
      </div>
      {open &&
        entry.items.map((item) => (
          <div key={item.id} className="chat-group" data-id={item.id}>
            <ItemView item={item} beat />
          </div>
        ))}
    </div>
  )
}

/** The items in the order they are drawn, with each `context` under the prompt, or the tool card, it was made for: a prompt's as what torno added to it, a tool's as the build it started. A run of the agent's tools that is over is one line (`foldRuns`), and its task list is a card (`TasksCard`). */
export function ChatItems({ items, beat }: { items: ChatItem[]; beat: boolean }) {
  const order = useMemo(() => drawn(items), [items])
  const under = useMemo(() => {
    const byUser = new Map<string, Array<Of<'context'>>>()
    for (const item of order) if (item.kind === 'context') byUser.set(item.forUser, [...(byUser.get(item.forUser) ?? []), item])
    return byUser
  }, [order])
  const ids = useMemo(() => new Set(order.map((item) => item.id)), [order])
  // What is drawn on its own: a context whose prompt or card is here is drawn under that one.
  const entries = useMemo(() => foldRuns(order.filter((item) => !(item.kind === 'context' && ids.has(item.forUser))), new Set(under.keys())), [order, ids, under])
  const lists = useMemo(() => listsAt(order), [order])
  // What each turn did, kept as the same object while it says the same, so that a turn already drawn is not drawn again.
  const kept = useRef(new Map<string, { said: string; account: TurnAccount }>())
  const accounts = useMemo(() => {
    const out = new Map<string, TurnAccount>()
    let turn: ChatItem[] = []
    for (const item of order) {
      if (item.kind !== 'turn') {
        turn.push(item)
        continue
      }
      const account = { summary: turnSummary(turn), net: netParts(turn) }
      const said = JSON.stringify(account)
      const was = kept.current.get(item.id)
      const same = was?.said === said ? was.account : account
      kept.current.set(item.id, { said, account: same })
      out.set(item.id, same)
      turn = []
    }
    return out
  }, [order])
  return (
    <>
      {entries.map((entry, at) => {
        if (entry.kind === 'fold') return <ToolFold key={entry.id} entry={entry} />
        const item = entry.item
        // The list the agent keeps: `TodoWrite` is its list whole, a card of its own; the task tools are lines, and the list stands under the last of a run of them.
        const next = entries[at + 1]
        const last = item.kind === 'tool' && (item.name === 'TodoWrite' || next?.kind !== 'item' || !isTaskTool(next.item))
        const list = isTaskTool(item) && item.state === 'done' && last ? lists.get(item.id) : undefined
        const listed = list && list.length > 0 ? list : undefined
        return (
          <div key={item.id} className="chat-group" data-id={item.id}>
            {item.kind === 'tool' && item.name === 'TodoWrite' && listed ? <TasksCard list={listed} /> : <ItemView item={item} beat={underWay(item) ? beat : true} account={accounts.get(item.id)} />}
            {under.get(item.id)?.map((context) => (context.forTool ? <BuildLine key={context.id} item={context} /> : <Added key={context.id} item={context} />))}
            {listed && !(item.kind === 'tool' && item.name === 'TodoWrite') && <TasksCard list={listed} />}
          </div>
        )
      })}
    </>
  )
}

import { useMemo, useState } from 'react'
import { type ChatItem, pulledFromTorno } from '../../../shared/chat'
import { drawn } from '../../state/chat'
import { numbered } from '../numbered'
import { contextChips } from './contextChips'
import { Markdown } from './markdown'
import { Pictures } from './Pictures'
import { RefChip } from './RefChip'
import { ToolCard } from './ToolCard'

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

/** The still dot of something under way: set by the one-second beat the pane keeps, and by no animation that runs on. */
function Dot({ beat }: { beat: boolean }) {
  return <span className="chat-dot" data-beat={beat ? undefined : 'off'} aria-hidden="true" />
}

/**
 * What torno added to a prompt, under it: the marks it told of, the build, the selection, as chips that are live,
 * and the exact text the agent was given, to open out.
 */
function Added({ item }: { item: Of<'context'> }) {
  const [open, setOpen] = useState(false)
  const chips = useMemo(() => contextChips(item.text), [item.text])
  return (
    <div className="chat-item chat-added" data-kind="context">
      <div className="chat-added-line">
        <span className="chat-added-label">torno added</span>
        {item.marks.map((id) => (
          <RefChip key={id} value={id} />
        ))}
        {chips.build && (
          <span className="chat-added-build">
            <RefChip value={`r${chips.build.revision}`} /> <span data-verdict={chips.build.state}>{chips.build.state === 'ok' ? 'ok' : chips.build.state}</span>
          </span>
        )}
        {chips.selection.length > 0 && (
          <span className="chat-added-selection">
            selection:{' '}
            {chips.selection.map((ref) => (
              <RefChip key={ref} value={ref} />
            ))}
          </span>
        )}
        <button type="button" className="chat-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide text' : 'Show text'}
        </button>
      </div>
      {open && <pre className="chat-pre chat-added-text selectable">{item.text}</pre>}
    </div>
  )
}

function User({ item }: { item: Of<'user'> }) {
  return (
    <div className="chat-item chat-user" data-kind="user" data-state={item.state}>
      {item.text !== '' && <p className="chat-user-text selectable">{item.text}</p>}
      <Pictures images={item.images} what="Your message" />
      {item.state === 'queued' && <p className="chat-user-state">Queued</p>}
      {item.state === 'not-sent' && <p className="chat-user-state">Not sent</p>}
    </div>
  )
}

function Turn({ item }: { item: Of<'turn'> }) {
  const pulled = pulledFromTorno(item.pulled)
  const head = item.stopped ? 'Stopped' : item.ok ? `Done in ${item.seconds < 10 ? item.seconds.toFixed(1) : Math.round(item.seconds)} s` : `Failed${item.error ? `: ${item.error}` : ''}`
  return (
    <p className="chat-item chat-turn" data-kind="turn" data-ok={item.ok && !item.stopped ? '' : undefined}>
      {numbered(head)}
      {pulled && <> · {numbered(pulled)}</>}
    </p>
  )
}

/** Where a card that asks the person will stand (Task 4's `AskCard`): until then, a line that says it is asked. */
function Ask({ item }: { item: Of<'ask'> }) {
  const said = item.state === 'ended' ? 'Not answered: the session ended' : item.state === 'allowed' ? 'Allowed' : item.state === 'denied' ? 'Denied' : 'Waiting for your answer'
  return (
    <p className="chat-item chat-note" data-kind="ask" data-state={item.state}>
      Claude Code asks to use <span className="num">{item.toolName.replace(/^mcp__torno__/, 'torno · ')}</span> · {said}
    </p>
  )
}

/** One item of the transcript. A `context` is drawn under its prompt, and not here. */
export function ItemView({ item, beat }: { item: ChatItem; beat: boolean }) {
  switch (item.kind) {
    case 'user':
      return <User item={item} />
    case 'context':
      return <Added item={item} />
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
      return <Ask item={item} />
    case 'turn':
      return <Turn item={item} />
    case 'note':
      return (
        <p className="chat-item chat-note" data-kind="note" data-tone={item.tone}>
          {item.text}
        </p>
      )
  }
}

/** The items in the order they are drawn, with each `context` under the prompt it was made for. */
export function ChatItems({ items, beat }: { items: ChatItem[]; beat: boolean }) {
  const order = useMemo(() => drawn(items), [items])
  const under = useMemo(() => {
    const byUser = new Map<string, Array<Of<'context'>>>()
    for (const item of order) if (item.kind === 'context') byUser.set(item.forUser, [...(byUser.get(item.forUser) ?? []), item])
    return byUser
  }, [order])
  const ids = useMemo(() => new Set(order.map((item) => item.id)), [order])
  return (
    <>
      {order.map((item) => {
        // One whose prompt is not here (it is among the earlier turns, or gone) is drawn where it stands.
        if (item.kind === 'context' && ids.has(item.forUser)) return null
        return (
          <div key={item.id} className="chat-group" data-id={item.id}>
            <ItemView item={item} beat={beat} />
            {item.kind === 'user' && under.get(item.id)?.map((context) => <Added key={context.id} item={context} />)}
          </div>
        )
      })}
    </>
  )
}


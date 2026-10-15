import { memo, useMemo, useState } from 'react'
import { type ChatItem, toolLabel } from '../../../shared/chat'
import { numbered } from '../numbered'
import { Pictures } from './Pictures'
import { useChatPlace } from './place'
import { RefText } from './RefText'

type Tool = Extract<ChatItem, { kind: 'tool' }>

const STATE_WORD: Record<Tool['state'], string> = { running: 'running', done: 'done', error: 'failed', stopped: 'stopped', denied: 'denied', cancelled: 'cancelled' }
/** How much of an input or a result is shown before "Show all". */
const SHOWN_LINES = 12
/** Past this, even "Show all" shows no more: the item holds no more than 50,000 characters, and a page of them is slow to lay out. */
const SHOW_ALL_LIMIT = 20_000

function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === undefined || input === null) return ''
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return String(input)
  }
}

/** Lines of monospace text, the first few, with a way to see them all. */
function Lines({ label, text }: { label: string; text: string }) {
  const [all, setAll] = useState(false)
  if (text === '') return null
  const lines = text.split('\n')
  const more = lines.length > SHOWN_LINES
  const shown = all || !more ? text : lines.slice(0, SHOWN_LINES).join('\n')
  return (
    <div className="chat-lines">
      <p className="chat-lines-label">{label}</p>
      <pre className="chat-pre selectable">
        <RefText text={shown.length > SHOW_ALL_LIMIT ? `${shown.slice(0, SHOW_ALL_LIMIT)}…` : shown} />
      </pre>
      {more && !all && (
        <button type="button" className="chat-more" onClick={() => setAll(true)}>
          Show all {numbered(`${lines.length} lines`)}
        </button>
      )}
    </div>
  )
}

/**
 * A tool the agent used, on one line: what it did, and how it went. It opens to its input and its result. One of
 * torno's own has a thin rule in the accent colour, and its pictures under the line.
 */
export const ToolCard = memo(function ToolCard({ item, beat }: { item: Tool; beat: boolean }) {
  const [open, setOpen] = useState(false)
  const where = useChatPlace()
  const label = useMemo(() => toolLabel(item.name, item.input, where), [item.name, item.input, where])
  const full = useMemo(() => toolLabel(item.name, item.input), [item.name, item.input])
  // Only an open card needs its input as text.
  const input = useMemo(() => (open ? inputText(item.input) : ''), [open, item.input])
  return (
    <div className="chat-item chat-tool" data-kind="tool" data-torno={item.torno ? '' : undefined} data-state={item.state}>
      <button type="button" className="chat-tool-line" title={full} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chat-tool-label">{numbered(label)}</span>
        {item.steps !== undefined && <span className="chat-tool-steps">{numbered(`${item.steps} ${item.steps === 1 ? 'step' : 'steps'}`)}</span>}
        <span className="chat-tool-state">
          {item.state === 'running' && <span className="chat-dot" data-beat={beat ? undefined : 'off'} aria-hidden="true" />}
          {STATE_WORD[item.state]}
        </span>
      </button>
      {item.images.length > 0 && <Pictures images={item.images} what={label} />}
      {open && (
        <div className="chat-tool-body">
          <Lines label="Input" text={input} />
          {item.inside !== undefined && item.inside.length > 0 && <Lines label="Inside" text={item.inside.join('\n')} />}
          <Lines label="Result" text={item.result ?? ''} />
          {item.result === undefined && item.state !== 'running' && <p className="chat-lines-label">No result</p>}
        </div>
      )}
    </div>
  )
})

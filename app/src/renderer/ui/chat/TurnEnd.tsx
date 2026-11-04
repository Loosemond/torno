import { Children, createContext, memo, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { type ChatItem, pulledFromTorno } from '../../../shared/chat'
import { numbered } from '../numbered'
import { AskSession } from './AskCard'
import { ChangesSheet } from './ChangesSheet'
import { isEmpty, summaryParts, type TurnAccount } from './turnSummary'

type TurnItem = Extract<ChatItem, { kind: 'turn' }>

/** Whether the turn edited a `.py` file: only then is there a model file whose change can be seen. */
const editedModel = (account: TurnAccount | undefined): boolean => account?.summary.files.some((f) => f.path.endsWith('.py')) ?? false

/**
 * The row of buttons under a turn's account, one for each thing the person may do with that turn. "See changes" is the
 * first; whatever else is offered for the turn (to take it back) is a button in this row, given the same turn.
 */
function TurnActions({ children }: { children: ReactNode }) {
  if (Children.toArray(children).length === 0) return null
  return <div className="chat-turn-actions">{children}</div>
}

/** "See changes": opens the sheet of what the turn did to the model's file, over the transcript. */
function SeeChanges({ item, account, row }: { item: TurnItem; account: TurnAccount; row: RefObject<HTMLDivElement | null> }) {
  const sessionId = useContext(AskSession)
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Over the transcript, not inside the group it is in: a group is contained (`content-visibility`), and would clip it.
  const host = open ? row.current?.closest('.chat-scroll') : null
  const close = (): void => {
    setOpen(false)
    // The focus goes back to the button it was taken from.
    requestAnimationFrame(() => button.current?.focus())
  }
  return (
    <>
      <button ref={button} type="button" className="button button-quiet" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        See changes
      </button>
      {open && host && <ChangesSheet sessionId={sessionId} turnId={item.id} net={account.net} host={host} onClose={close} />}
    </>
  )
}

/**
 * The id of the turn that "Undo" is offered on, or none: the last turn of a live chat whose session is idle, with no
 * prompt of the person's after it (`ChatPane` works it out). Any other turn has no such button.
 */
export const UndoableTurn = createContext<string | undefined>(undefined)

/** How long "Undo" waits for main to take it before the button is the person's again. */
const UNDO_WAIT_MS = 10_000

/**
 * "Undo": asks the agent, in a prompt torno writes, to put the model files back as they were before this turn. Torno
 * writes nothing of the model; the agent edits through its usual permission cards, and a note in the chat says so. It
 * asks first, once, naming what it will ask for and what it does not cover.
 */
function Undo({ item }: { item: TurnItem }) {
  const sessionId = useContext(AskSession)
  const [asking, setAsking] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!sending) return
    const timer = setTimeout(() => setSending(false), UNDO_WAIT_MS)
    return () => clearTimeout(timer)
  }, [sending])
  if (!sessionId) return null
  const send = (): void => {
    setSending(true)
    setProblem(null)
    window.torno.chat.undo(sessionId, item.id).then(
      () => setAsking(false),
      (e: unknown) => {
        setSending(false)
        setProblem(e instanceof Error ? e.message : String(e))
      }
    )
  }
  if (!asking) {
    return (
      <>
        <button type="button" className="button button-quiet" onClick={() => setAsking(true)}>
          Undo
        </button>
        {problem && (
          <span className="chat-turn-problem" role="alert">
            {problem}
          </span>
        )}
      </>
    )
  }
  return (
    <span className="chat-turn-undo" role="group" aria-label="Undo this turn">
      <span>Ask Claude Code to put the model files back as they were before this turn? It edits them itself, and you answer each edit. Only the .py files in this project's folder are covered.</span>
      <button type="button" className="button" disabled={sending} onClick={send} autoFocus>
        {sending ? 'Asking…' : 'Ask to undo'}
      </button>
      <button type="button" className="button button-quiet" disabled={sending} onClick={() => setAsking(false)}>
        Keep it
      </button>
      {problem && (
        <span className="chat-turn-problem" role="alert">
          {problem}
        </span>
      )}
    </span>
  )
}

/**
 * The end of a turn: how long it took, what it did to the project (`account`, from the turn's own items), and what it
 * pulled from torno, each on a quiet line of its own, then the buttons for the turn.
 */
export const TurnEnd = memo(function TurnEnd({ item, account }: { item: TurnItem; account?: TurnAccount }) {
  const row = useRef<HTMLDivElement>(null)
  const undoable = useContext(UndoableTurn)
  const pulled = pulledFromTorno(item.pulled)
  const head = item.stopped ? 'Stopped' : item.ok ? `Done in ${item.seconds < 10 ? item.seconds.toFixed(1) : Math.round(item.seconds)} s` : `Failed${item.error ? `: ${item.error}` : ''}`
  const parts = account && !isEmpty(account.summary) ? summaryParts(account.summary) : []
  return (
    <div ref={row} className="chat-item chat-turn" data-kind="turn" data-ok={item.ok && !item.stopped ? '' : undefined}>
      <p className="chat-turn-line">{numbered([head, ...parts].join(' · '))}</p>
      {pulled && <p className="chat-turn-line chat-turn-pulled">{numbered(pulled)}</p>}
      <TurnActions>
        {account && editedModel(account) ? <SeeChanges item={item} account={account} row={row} /> : null}
        {account && editedModel(account) && undoable === item.id ? <Undo item={item} /> : null}
      </TurnActions>
    </div>
  )
})

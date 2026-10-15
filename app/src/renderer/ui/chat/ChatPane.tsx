import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { chatActions, useChat } from '../../state/chat'
import { ChatItems } from './Items'
import { Composer } from './Composer'

/** Within this many pixels of its end, a transcript is at its end. */
const AT_END_PX = 24

/** A beat once a second while something is under way, to toggle the still dots by: no animation runs on. */
function useBeat(active: boolean): boolean {
  const [beat, setBeat] = useState(true)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setBeat((b) => !b), 1000)
    return () => clearInterval(timer)
  }, [active])
  return beat
}

/**
 * The conversation of a chat session, in the session pane: the transcript, which reads as a document, and the
 * box a prompt is written in. It follows the end of the transcript while it is at its end; a person who has
 * scrolled up is left where they are, and a button brings them down.
 *
 * Later (Task 4): the cards of what the agent asks, "Attach view", the commands offered while a `/` is typed, the
 * model menu, the rate line. They go in `chat-foot` (above and in the row of the box) and in `Items`' `Ask`.
 */
export function ChatPane({ sessionId, live, working }: { sessionId: string; live: boolean; working: boolean }) {
  const chat = useChat(sessionId)
  useEffect(() => {
    void chatActions.load(sessionId)
  }, [sessionId])

  const box = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const [behind, setBehind] = useState(false)
  const items = chat?.items
  const earlier = chat?.earlier
  const underWay = (items ?? []).some((item) => (item.kind === 'text' || item.kind === 'thinking' ? item.streaming : item.kind === 'tool' && item.state === 'running'))
  const beat = useBeat(underWay)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (atEnd.current) el.scrollTop = el.scrollHeight
    else setBehind(true)
  }, [items, earlier])

  const toEnd = (): void => {
    atEnd.current = true
    setBehind(false)
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="chat" data-session={sessionId}>
      <div className="chat-scroll">
        <div
          className="chat-transcript"
          ref={box}
          role="log"
          aria-label="Conversation"
          onScroll={(e) => {
            const el = e.currentTarget
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX
            if (atEnd.current) setBehind(false)
          }}
        >
          {chat?.loading && <p className="chat-note chat-quiet">Loading the conversation…</p>}
          {chat?.failed !== undefined && (
            <p className="chat-note chat-quiet" role="alert">
              {chat.failed}
            </p>
          )}
          {earlier && earlier.length > 0 && (
            <section className="chat-earlier" aria-label="Earlier in this conversation">
              <h3 className="chat-earlier-head">Earlier in this conversation</h3>
              <ChatItems items={earlier} beat={false} />
            </section>
          )}
          {items && <ChatItems items={items} beat={beat} />}
          {chat && !chat.loading && items!.length === 0 && (!earlier || earlier.length === 0) && (
            <p className="chat-empty">Say what to change, or ask about the part. The marks you leave go with your prompt.</p>
          )}
        </div>
        {behind && (
          <button type="button" className="button chat-behind" onClick={toEnd}>
            New messages below
          </button>
        )}
      </div>
      <Composer sessionId={sessionId} live={live} working={working} onSent={toEnd} />
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { chatActions, useChat } from '../../state/chat'
import { ChatItems } from './Items'
import { AskSession } from './AskCard'
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
 * What the agent asks is a card in the transcript (`AskCard`, which answers to this session); "Attach view", the
 * commands offered while a `/` is typed and the rate line are in the foot, with the box (`Composer`).
 */
export function ChatPane({ sessionId, live, working }: { sessionId: string; live: boolean; working: boolean }) {
  const chat = useChat(sessionId)
  useEffect(() => {
    void chatActions.load(sessionId)
    // Once no pane shows it, a session lets go of its pictures: they are asked for again when it is shown.
    return () => chatActions.release(sessionId)
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

  // What grows without the items changing (a picture, a card opened) keeps the end in view while it was at the end.
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return
    const watching = new ResizeObserver(() => {
      const el = box.current
      if (el && atEnd.current) el.scrollTop = el.scrollHeight
    })
    watching.observe(content.current)
    return () => watching.disconnect()
  }, [])

  const toEnd = (): void => {
    atEnd.current = true
    setBehind(false)
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <AskSession.Provider value={sessionId}>
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
          <div className="chat-content" ref={content}>
          {chat?.loading && <p className="chat-note chat-quiet">Loading the conversation…</p>}
          {chat?.failed !== undefined && (
            <p className="chat-note chat-quiet" role="alert">
              {chat.failed}
            </p>
          )}
          {chat?.trimmed && <p className="chat-note chat-quiet">Earlier items are not shown</p>}
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
        </div>
        {behind && (
          <button type="button" className="button chat-behind" onClick={toEnd}>
            New messages below
          </button>
        )}
      </div>
      <Composer sessionId={sessionId} live={live} working={working} onSent={toEnd} />
    </div>
    </AskSession.Provider>
  )
}

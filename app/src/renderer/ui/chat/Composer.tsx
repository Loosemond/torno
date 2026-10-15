import { useEffect, useRef, useState } from 'react'
import { hint, pressed } from '../../../shared/keys'
import { unmetDimensions } from '../../../shared/dimension'
import { useStore } from '../../state/store'
import { numbered } from '../numbered'
import { giveKeysBack } from '../typing'
import { RefChip } from './RefChip'

/** What an IPC call failed with, without Electron's wrapping. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

/** A prompt not yet sent, kept for a session while its pane is not shown (another object's, say). */
const drafts = new Map<string, string>()

/** The drafts of the prompts not sent are let go when the workspace they were written in is closed. */
export function clearDrafts(): void {
  drafts.clear()
}

/** The composer in the pane now, for what is inserted from outside (the selection's "Insert"). */
let current: { insert(text: string): void } | null = null

/** Puts text at the cursor of the composer of the chat shown, and gives it the keys. False when there is none. */
export function insertIntoComposer(text: string): boolean {
  if (!current) return false
  current.insert(text)
  return true
}

/** The most marks named in the line above the box; the rest are counted. */
const MOST_CHIPS = 8

/** What goes with the next prompt, as chips of the marks themselves: the drafts, and the dimensions that fail or have no value. */
function Next() {
  const marks = useStore((s) => s.marks)
  const revision = useStore((s) => s.revision)
  const { failing, unmeasured } = unmetDimensions(
    marks.filter((m) => m.status === 'sent'),
    revision > 0 ? revision : undefined
  )
  const things = [
    ...marks.filter((m) => m.status === 'draft').map((m) => ({ id: m.id, word: '' })),
    ...failing.map((m) => ({ id: m.id, word: 'fails' })),
    ...unmeasured.map((m) => ({ id: m.id, word: 'no value' }))
  ]
  if (things.length === 0) return null
  return (
    <p className="chat-next" role="status">
      <span>Goes with your next prompt:</span>
      {things.slice(0, MOST_CHIPS).map((one) => (
        <span key={`${one.id}${one.word}`} className="chat-next-one">
          <RefChip value={one.id} />
          {one.word !== '' && <span className="chat-next-word">{one.word}</span>}
        </span>
      ))}
      {things.length > MOST_CHIPS && <span>{numbered(`and ${things.length - MOST_CHIPS} more`)}</span>}
    </p>
  )
}

/**
 * The foot of the chat: what goes with the next prompt, and the box to write it in. Enter sends and Shift+Enter
 * breaks the line; Escape gives the keys back to the view, as a field does. While the agent works, the prompt is
 * queued by the CLI, and "Stop" interrupts it.
 */
export function Composer({ sessionId, live, working, onSent }: { sessionId: string; live: boolean; working: boolean; onSent: () => void }) {
  const [text, setText] = useState(() => drafts.get(sessionId) ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const cursor = useRef<number | null>(null)
  const latest = useRef(text)
  latest.current = text

  useEffect(() => {
    current = {
      insert(inserted) {
        const box = field.current
        const value = latest.current
        const at = box?.selectionStart ?? value.length
        const end = box?.selectionEnd ?? at
        const before = value.slice(0, at)
        const after = value.slice(end)
        // Set off from the words round it by a space, as a ref in a sentence is.
        const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
        const tail = after === '' || !/^\s/.test(after) ? ' ' : ''
        cursor.current = (before + lead + inserted + tail).length
        setText(before + lead + inserted + tail + after)
        box?.focus()
      }
    }
    return () => {
      current = null
    }
  }, [])
  // The cursor goes after what was inserted, once the box has it.
  useEffect(() => {
    if (cursor.current === null) return
    field.current?.setSelectionRange(cursor.current, cursor.current)
    cursor.current = null
  }, [text])
  useEffect(() => () => void drafts.set(sessionId, latest.current), [sessionId])

  async function send(): Promise<void> {
    const prompt = text.trim()
    if (prompt === '' || !live) return
    setText('')
    setProblem(null)
    onSent()
    try {
      await window.torno.chat.send(sessionId, { text: prompt })
    } catch (e) {
      // Nothing was sent: what was written is given back, unless more has been written since.
      setText((now) => (now === '' ? prompt : now))
      setProblem(reason(e))
    }
  }

  return (
    <div className="chat-foot">
      <Next />
      <div className="chat-composer">
        <textarea
          ref={field}
          className="chat-input"
          data-chat-composer=""
          rows={2}
          value={text}
          disabled={!live}
          aria-label="Message to Claude Code"
          placeholder={live ? (working ? 'Claude Code is working: this goes next' : 'Message Claude Code') : 'The session has ended'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            // A new line is the browser's own.
            if (pressed(e, 'chat.newline')) return
            if (pressed(e, 'chat.send')) {
              e.preventDefault()
              void send()
            } else if (pressed(e, 'field.leave')) {
              e.preventDefault()
              giveKeysBack(e.currentTarget)
            }
          }}
        />
        <div className="chat-actions">
          {working && live && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setProblem(null)
                window.torno.chat.interrupt(sessionId).catch((e: unknown) => setProblem(reason(e)))
              }}
            >
              Stop
            </button>
          )}
          <button type="button" className="button button-primary" disabled={!live || text.trim() === ''} title={`Send (${hint('chat.send')})`} onClick={() => void send()}>
            {working ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      {problem !== null && (
        <p className="chat-problem selectable" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

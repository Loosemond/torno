import { useEffect, useRef, useState } from 'react'
import { hint, pressed, which } from '../../../shared/keys'
import { unmetDimensions } from '../../../shared/dimension'
import { useChat } from '../../state/chat'
import { drawingActions, drawingWaits, useDrawing } from '../../state/drawing'
import { onboarding } from '../../state/onboard'
import { store, useStore } from '../../state/store'
import { numbered } from '../numbered'
import { giveKeysBack } from '../typing'
import { openDrawing } from '../drawing/make'
import { commandsFor, rateLine } from './foot'
import { RefChip } from './RefChip'

/** What an IPC call failed with, without Electron's wrapping. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

/** A prompt not yet sent, kept for a session while its pane is not shown (another object's, say). */
const drafts = new Map<string, string>()

/** How many of these sessions have a prompt written in their box, or a drawing on the view waiting for it, and not sent: closing the window would lose it. */
export function unsentPrompts(sessionIds: Iterable<string>): number {
  let n = 0
  for (const id of sessionIds) if ((drafts.get(id) ?? '').trim() !== '' || drawingWaits(id)) n += 1
  return n
}

/** The drafts of the prompts not sent, and the drawings waiting for them, are let go when the workspace they were made in is closed. */
export function clearDrafts(): void {
  drafts.clear()
  drawingActions.clear()
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

/** The `/` commands the CLI named, offered while a single `/word` is typed: the arrows choose, Tab or a click completes. */
function Commands({ offered, at, onChoose }: { offered: ReturnType<typeof commandsFor>; at: number; onChoose: (name: string) => void }) {
  return (
    <ul className="chat-commands" id="chat-commands" role="listbox" aria-label="Commands">
      {offered.map((c, n) => (
        <li
          key={c.name}
          id={`chat-command-${c.name}`}
          role="option"
          aria-selected={n === at}
          // The box keeps the focus: a click chooses without taking it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChoose(c.name)}
        >
          <span className="chat-command-name num">/{c.name}</span>
          {c.argumentHint !== '' && <span className="chat-command-hint num">{c.argumentHint}</span>}
          {c.description !== '' && <span className="chat-command-desc">{c.description}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The foot of the chat: what goes with the next prompt, and the box to write it in. Enter sends and Shift+Enter
 * breaks the line; Escape closes the list of commands while one is offered, and else gives the keys back to the view, as a field does. While the agent works, the prompt is
 * queued by the CLI, and "Stop" interrupts it. "Attach view" adds a picture of the viewport to the next prompt only;
 * "Draw on view" opens a board over a picture of the view, and the drawing waits above the box until it goes with the
 * next prompt.
 * While a `/command` is typed the commands of the CLI are offered; and when a window of the rate limit is half
 * used, one quiet line says so.
 */
export function Composer({ sessionId, live, working, onSent }: { sessionId: string; live: boolean; working: boolean; onSent: () => void }) {
  // A first prompt of a new object that could not be sent (`state/onboard.ts`) is in the box of its first chat.
  const [text, setText] = useState(() => drafts.get(sessionId) ?? onboarding.take(store.getState().objectId))
  const [problem, setProblem] = useState<string | null>(null)
  const [attach, setAttach] = useState(false)
  const drawn = useDrawing((s) => s.drawn[sessionId])
  const opening = useDrawing((s) => s.opening === sessionId)
  const drawingHere = useDrawing((s) => s.board?.sessionId === sessionId)
  const [choice, setChoice] = useState(0)
  const chat = useChat(sessionId)
  /** The text for which Escape closed the list of commands: the list stays shut until the text changes. */
  const [shut, setShut] = useState<string | null>(null)
  const offered = shut === text ? [] : commandsFor(text, chat?.commands ?? [])
  const at = Math.min(choice, Math.max(0, offered.length - 1))
  const rate = rateLine(chat?.meta.rate)
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
  // The board over the view put away, by Done or by Cancel: the keys are the box's again, for the prompt the drawing
  // goes with. After the board's own giving back, which finds "Draw on view" disabled once a drawing waits.
  const boardWasHere = useRef(false)
  useEffect(() => {
    if (boardWasHere.current && !drawingHere) field.current?.focus()
    boardWasHere.current = drawingHere
  }, [drawingHere])
  // Kept as it is written, so that what closing the window would lose can be asked of it, and kept when the pane goes.
  useEffect(() => void drafts.set(sessionId, text), [sessionId, text])

  async function send(): Promise<void> {
    const prompt = text.trim()
    if (prompt === '' || !live) return
    const withView = attach
    // The drawing goes with this prompt and with no other; given back if the prompt is not sent.
    const drawing = drawingActions.taken(sessionId)
    setText('')
    setAttach(false)
    setProblem(null)
    onSent()
    try {
      await window.torno.chat.send(sessionId, { text: prompt, attachView: withView, ...(drawing ? { drawing: drawing.drawing } : {}) })
      if (drawing) drawingActions.spent(drawing)
    } catch (e) {
      // Nothing was sent: what was written is given back, unless more has been written since.
      setText((now) => (now === '' ? prompt : now))
      setAttach(withView)
      if (drawing) drawingActions.giveBack(sessionId, drawing)
      setProblem(reason(e))
    }
  }

  /** The command chosen, written in the box with a space after it, for its argument. */
  function complete(name: string): void {
    const done = `/${name} `
    cursor.current = done.length
    setText(done)
    field.current?.focus()
  }

  return (
    <div className="chat-foot">
      <Next />
      {offered.length > 0 && <Commands offered={offered} at={at} onChoose={complete} />}
      {drawn && (
        <div className="chat-drawing" role="group" aria-label="Drawing on the view">
          <img src={drawn.thumb} alt="" draggable={false} />
          <span className="chat-drawing-what">Your drawing on the view goes with your next prompt</span>
          <button type="button" className="button button-quiet" onClick={() => drawingActions.edit(sessionId)}>
            Edit
          </button>
          <button type="button" className="button button-quiet" onClick={() => drawingActions.remove(sessionId)}>
            Remove
          </button>
        </div>
      )}
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
          aria-controls={offered.length > 0 ? 'chat-commands' : undefined}
          aria-activedescendant={offered.length > 0 ? `chat-command-${offered[at].name}` : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setChoice(0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            // A new line is the browser's own.
            if (pressed(e, 'chat.newline')) return
            if (offered.length > 0 && which(e, 'chat.command') >= 0) {
              e.preventDefault()
              setChoice((at + (which(e, 'chat.command') === 0 ? offered.length - 1 : 1)) % offered.length)
              return
            }
            if (offered.length > 0 && pressed(e, 'chat.complete')) {
              e.preventDefault()
              complete(offered[at].name)
              return
            }
            if (pressed(e, 'chat.send')) {
              e.preventDefault()
              void send()
            } else if (pressed(e, 'field.leave')) {
              e.preventDefault()
              // With the list of commands open, Escape closes it; the keys go back to the view with the next one.
              if (offered.length > 0) setShut(text)
              else giveKeysBack(e.currentTarget)
            }
          }}
        />
        <div className="chat-actions">
          <button
            type="button"
            className="button"
            aria-pressed={attach}
            disabled={!live}
            title="Add a picture of the view as it is now to the next prompt"
            onClick={() => setAttach(!attach)}
          >
            Attach view
          </button>
          <button
            type="button"
            className="button"
            disabled={!live || opening || drawn !== undefined}
            title={drawn ? 'A drawing goes with your next prompt: edit it or remove it above' : 'Draw over a picture of the view as it is now; the picture goes with the next prompt'}
            onClick={() => {
              setProblem(null)
              openDrawing(sessionId).catch((e: unknown) => setProblem(reason(e)))
            }}
          >
            Draw on view
          </button>
          <span className="spacer" />
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
      {rate !== null && (
        <p className="chat-rate" role="status">
          {numbered(rate)}
        </p>
      )}
      {problem !== null && (
        <p className="chat-problem selectable" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

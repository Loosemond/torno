import { useEffect, useRef } from 'react'
import { pressed } from '../../shared/keys'
import type { Reason } from '../closing'
import { useStore } from '../state/store'

/** What can take the focus in the question, in order. */
const FOCUSABLE = 'button:not(:disabled)'

/** The questions standing, the last on top: while one does, every key is its own. */
const standing: Array<{ sheet: HTMLElement; cancel: () => void; focus: () => void }> = []

/**
 * Heard before any other listener of a key (it is added when this module is first read, before the window's own
 * keys, the tools and the view add theirs): while a question stands, no key reaches anything behind it, wherever
 * the focus is (a click on the backdrop can leave it on the page). Escape presses the button that changes nothing,
 * Tab goes round within the question (into it, from outside), and a button of the question in focus takes Enter and
 * the space bar as ever.
 */
function keyGate(e: KeyboardEvent): void {
  const question = standing.at(-1)
  if (!question) return
  e.stopImmediatePropagation()
  if (pressed(e, 'sheet.close')) {
    e.preventDefault()
    question.cancel()
    return
  }
  const within = e.target instanceof Node && question.sheet.contains(e.target)
  if (pressed(e, 'sheet.round')) {
    e.preventDefault()
    const stops = [...question.sheet.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const at = within ? stops.indexOf(document.activeElement as HTMLElement) : -1
    if (at < 0 || stops.length === 0) return question.focus()
    stops[(at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus()
    return
  }
  if (!within) e.preventDefault()
}
if (typeof window !== 'undefined') window.addEventListener('keydown', keyGate, true)

/**
 * A question about the window as a whole, asked before torno is closed or another folder is opened: a dialog over
 * the whole window, as the export's is, and not a strip in a panel (`Confirm` is for a question about one panel).
 * It names each thing that would be cut short and the object it is of; the name is a link that goes there and puts
 * the question away. Modal: nothing behind it takes a click or a key, Tab goes round within it, the button that
 * changes nothing has the focus, and Escape presses it.
 */
export function WorkspaceQuestion(props: {
  label: string
  /** Said above the list: what the answer would do to it. */
  lead: string
  reasons: readonly Reason[]
  accept: string
  cancel: string
  onAccept: () => void
  onCancel: () => void
  /** A name was followed: the question is put away first, then the object (or the page) is shown. */
  onGo: (reason: Reason) => void
}) {
  const names = useStore((s) => s.workspace?.objects)
  const sheet = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const answer = useRef(props.onCancel)
  answer.current = props.onCancel

  // The keys are the question's while it is up (`keyGate`), and the focus comes back to where it was when it goes.
  useEffect(() => {
    const before = document.activeElement
    cancel.current?.focus()
    const question = { sheet: sheet.current!, cancel: () => answer.current(), focus: () => cancel.current?.focus() }
    standing.push(question)
    return () => {
      standing.splice(standing.indexOf(question), 1)
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  const nameOf = (id: string): string => names?.find((object) => object.id === id)?.name ?? id

  return (
    // Over the whole window while it is up, and over the sheet of what torno needs. A press on the backdrop leaves the
    // focus in the question: it would go to the page behind.
    <div className="workspace-layer" data-question="" onPointerDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <section
        ref={sheet}
        className="workspace-question"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
      >
        <h2>{props.label}</h2>
        <p className="workspace-lead">{props.lead}</p>
        <ul className="workspace-reasons">
          {props.reasons.map((reason, at) => (
            <li key={at}>
              {reason.objectId !== null || reason.page !== undefined ? (
                <button type="button" className="link-button num" onClick={() => props.onGo(reason)}>
                  {reason.objectId !== null ? nameOf(reason.objectId) : reason.label}
                </button>
              ) : (
                <span className="num">{reason.label}</span>
              )}
              : {reason.what}
            </li>
          ))}
        </ul>
        <div className="confirm-actions">
          <button type="button" className="button" ref={cancel} onClick={props.onCancel}>
            {props.cancel}
          </button>
          <button type="button" className="button confirm-accept" onClick={props.onAccept}>
            {props.accept}
          </button>
        </div>
      </section>
    </div>
  )
}

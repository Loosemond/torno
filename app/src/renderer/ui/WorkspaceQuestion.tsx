import { useEffect, useRef } from 'react'
import { pressed } from '../../shared/keys'
import type { Reason } from '../closing'
import { useStore } from '../state/store'

/** What can take the focus in the question, in order. */
const FOCUSABLE = 'button:not(:disabled)'

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

  // The keys are the question's while it is up, and the focus comes back to where it was when it goes.
  useEffect(() => {
    const before = document.activeElement
    cancel.current?.focus()
    // Escape from wherever the focus is: from within, the question hears it first.
    const onKey = (e: KeyboardEvent): void => {
      if (pressed(e, 'sheet.close') && !e.defaultPrevented) answer.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  const nameOf = (id: string): string => names?.find((object) => object.id === id)?.name ?? id

  return (
    // Over the whole window while it is up.
    <div className="workspace-layer">
      <section
        ref={sheet}
        className="workspace-question"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onKeyDown={(e) => {
          // No tool of the view under it is handed a key.
          e.stopPropagation()
          if (pressed(e, 'sheet.close')) {
            e.preventDefault()
            props.onCancel()
            return
          }
          if (!pressed(e, 'sheet.round')) return
          // Tab goes round within the question.
          const stops = [...sheet.current!.querySelectorAll<HTMLElement>(FOCUSABLE)]
          const at = stops.indexOf(document.activeElement as HTMLElement)
          if (e.shiftKey ? at <= 0 : at === stops.length - 1) {
            e.preventDefault()
            stops[e.shiftKey ? stops.length - 1 : 0].focus()
          }
        }}
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

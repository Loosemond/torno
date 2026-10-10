import { pressed } from '../../shared/keys'
import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A question asked in place, before something that cannot be undone: a strip in
 * the panel the question is about, not a window over the app. The button that
 * changes nothing has the focus, and Escape presses it.
 */
export function Confirm(props: { label: string; children: ReactNode; accept: string; cancel: string; onAccept: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])

  return (
    <div
      className="confirm"
      role="alertdialog"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (!pressed(e, 'sheet.close')) return
        e.stopPropagation()
        props.onCancel()
      }}
    >
      <p>{props.children}</p>
      <div className="confirm-actions">
        <button type="button" className="button" ref={cancel} onClick={props.onCancel}>
          {props.cancel}
        </button>
        <button type="button" className="button confirm-accept" onClick={props.onAccept}>
          {props.accept}
        </button>
      </div>
    </div>
  )
}

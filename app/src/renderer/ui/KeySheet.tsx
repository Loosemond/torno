import { useEffect, useRef, useState } from 'react'
import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { capsOf, cheatSheet, hint, pressed, type KeyRow } from '../../shared/keys'
import { numbered } from './numbered'
import { TYPING } from './typing'

/** Whether the sheet of keys is up. It is asked for by `?`, and by the button at the foot of the tools. */
const sheetStore = createStore<{ open: boolean }>(() => ({ open: false }))

/** Show the sheet of keys, put it away, or the other of the two. */
export function showKeys(open: boolean = !sheetStore.getState().open): void {
  sheetStore.setState({ open })
}

/**
 * `?` outside any field and the terminal brings the sheet up, from the first screen as from an object or the
 * page of objects. Put away, it is the sheet's own doing: while it is up the focus is in its field.
 */
export function useKeysKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || !pressed(e, 'keys')) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      showKeys()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** The rows of the table that say all of what was typed, in any order: in what they do, in their keys, or in where they are listened to. */
export function matchingKeys(typed: string): ReturnType<typeof cheatSheet> {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
  const says = (row: KeyRow, context: string): boolean => {
    const text = `${row.does} ${row.keys.join(' ')} ${context}`.toLowerCase()
    return words.every((word) => text.includes(word))
  }
  return cheatSheet()
    .map((group) => ({ ...group, rows: group.rows.filter((row) => says(row, group.context)) }))
    .filter((group) => group.rows.length > 0)
}

/** The sheet of keys, over the window while it is asked for. */
export function KeySheet() {
  const open = useZustand(sheetStore, (s) => s.open)
  return open ? <Sheet /> : null
}

/**
 * Every key of the one table, by where it is listened to. What is typed searches it; Escape, `?` again or a
 * press beside it puts it away, and the focus goes back to where it was. A dialog: while it is up Tab stays
 * within it and a click inside keeps the focus in it (it can take the focus itself), so no tool behind it is
 * handed a key; when the focus does leave it for something else in the window, it is put away.
 */
function Sheet() {
  const [typed, setTyped] = useState('')
  const sheet = useRef<HTMLElement>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const before = document.activeElement
    field.current?.focus()
    return () => {
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  const groups = matchingKeys(typed)
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0)

  return (
    <div
      className="keys-layer"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) showKeys(false)
      }}
    >
      <section
        ref={sheet}
        className="keys-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keys"
        tabIndex={-1}
        onBlur={(e) => {
          // The focus went to something outside it (a key heard everywhere took it to the session, a sheet came up): it gives way.
          // Not when the window itself lost the focus: it is still what is up when the person comes back.
          const to = e.relatedTarget
          if (to instanceof Node ? !e.currentTarget.contains(to) : document.hasFocus() && document.activeElement !== null && !e.currentTarget.contains(document.activeElement)) showKeys(false)
        }}
        onKeyDown={(e) => {
          // The sheet's own, all of them: Escape here puts no tool down and leaves no page.
          e.stopPropagation()
          if (pressed(e, 'sheet.close') || pressed(e, 'keys')) {
            e.preventDefault()
            showKeys(false)
            return
          }
          if (!pressed(e, 'sheet.round')) return
          const stops = [...sheet.current!.querySelectorAll<HTMLElement>('input, button')]
          const at = stops.indexOf(document.activeElement as HTMLElement)
          if (e.shiftKey ? at <= 0 : at === stops.length - 1) {
            e.preventDefault()
            stops[e.shiftKey ? stops.length - 1 : 0].focus()
          }
        }}
      >
        <header className="keys-head">
          <h2>Keys</h2>
          <label className="keys-search">
            <input ref={field} type="text" value={typed} placeholder="Type to search" aria-label="Search the keys" spellCheck={false} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button type="button" className="icon-button" aria-label="Close" title={`Close (${hint('sheet.close')})`} onClick={() => showKeys(false)}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        {/* What changes as the search is typed, said once: not fifty rows read out again at every letter. */}
        <p className="keys-count" aria-live="polite">
          <span className="num">{count}</span> {count === 1 ? 'key' : 'keys'}
          {typed.trim() !== '' && ' found'}
        </p>
        <div className="keys-body">
          {groups.length === 0 && (
            <p className="keys-none">
              No key says <span className="keys-typed">{typed.trim()}</span>.
            </p>
          )}
          {groups.map((group) => (
            <section key={group.context} className="keys-group" aria-label={group.context}>
              <h3>{group.context}</h3>
              <p className="keys-when">{group.when}</p>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <span className="keys-caps">
                      {capsOf(row.keys).map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </span>
                    <span>{numbered(row.does)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </div>
  )
}

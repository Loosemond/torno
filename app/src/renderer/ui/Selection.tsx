import { useEffect, useState } from 'react'
import { describe, descriptorOf } from '../state/descriptors'
import { actions, runningSession, store, useStore } from '../state/store'
import { useTool } from '../state/tools'
import { noteSelection } from '../tools/pickMarks'
import { staleMessage } from '../tools/Tool'
import type { Viewport } from '../viewport/Viewport'
import { TYPING } from './ViewBar'

/** Put the selected refs at the cursor of the open object's session, for the person to write around. */
function insert(refs: string[]): void {
  const session = runningSession(store.getState())
  if (!session) return
  window.torno.session.insert(session.sessionId, refs.join(' '))
  // The next thing typed belongs with them.
  document.querySelector<HTMLElement>('[data-region="session"] .session-term textarea')?.focus()
}

/**
 * What is selected, floating at the bottom of the viewport: each ref with what
 * the kernel says of it, and what can be done with them.
 */
export function Selection({ viewport }: { viewport: Viewport }) {
  const selection = useStore((s) => s.selection)
  const objectId = useStore((s) => s.objectId)
  const revision = useStore((s) => s.revision)
  const layout = useStore((s) => s.layout)
  const canInsert = useStore((s) => runningSession(s) !== undefined)
  const selecting = useTool() === 'select'
  // Why no note can be left: the parts on screen are older than the model, and the refs would name other geometry.
  const stale = useStore((s) => (s.build?.stale ? staleMessage(s.build.status) : null))
  // While the marks of a selection are being made, so that they are made once.
  const [noting, setNoting] = useState(false)
  // The descriptors live in a cache outside React; this counts the ones that arrived, to draw them.
  const [, setArrived] = useState(0)

  useEffect(() => {
    if (!objectId) return
    let live = true
    for (const ref of selection) {
      if (descriptorOf(objectId, revision, layout, ref) !== undefined) continue
      void describe(objectId, revision, layout, ref).then((text) => {
        if (live && text !== null) setArrived((n) => n + 1)
      })
    }
    return () => {
      live = false
    }
  }, [selection, objectId, revision, layout])

  useEffect(() => {
    if (!selecting || selection.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      actions.setSelection([])
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, selection.length])

  if (!objectId || selection.length === 0) return null

  return (
    <div className="selection" role="group" aria-label="Selection">
      <ul className="selection-chips">
        {selection.map((ref) => (
          <li key={ref} className="selection-chip" data-ref={ref}>
            <span className="selection-ref num">{ref}</span>
            <span className="selection-descriptor num">{descriptorOf(objectId, revision, layout, ref) ?? ''}</span>
          </li>
        ))}
      </ul>
      <span className="viewbar-rule" aria-hidden="true" />
      <button
        type="button"
        className="bar-button"
        // Not on a stale build either: the refs would name other geometry in the build the agent then asks about.
        disabled={!canInsert || stale !== null}
        title={stale ?? (canInsert ? "Put the selection in the session's prompt" : 'Start a session to put the selection in its prompt')}
        onClick={() => insert(selection)}
      >
        Insert
      </button>
      <button
        type="button"
        className="bar-button"
        disabled={noting || stale !== null}
        title={stale ?? (selection.length === 1 ? 'Leave a note on it for the agent' : 'Leave a note on each for the agent')}
        onClick={() => {
          setNoting(true)
          void noteSelection(viewport.getCamera()).finally(() => setNoting(false))
        }}
      >
        Note
      </button>
    </div>
  )
}

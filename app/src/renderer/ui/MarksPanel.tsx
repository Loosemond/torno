import { useEffect, useState } from 'react'
import type { MarkPatch } from '../../shared/marks'
import { actions, useStore } from '../state/store'
import { TOOLS } from '../state/tools'
import { MarkRow } from './MarkRow'

/**
 * The marks of the open object, below the layers: those still to be dealt
 * with, then, folded away, the resolved ones. Marks of every layout are
 * listed; one of a layout that is not shown says which, and going to it
 * switches there.
 */
export function MarksPanel() {
  const objectId = useStore((s) => s.objectId)
  const marks = useStore((s) => s.marks)
  const layout = useStore((s) => s.layout)
  const active = useStore((s) => s.activeMark)
  const problem = useStore((s) => s.marksProblem)
  const [showResolved, setShowResolved] = useState(false)
  // What main said when it refused a change, until the next one goes through.
  const [refused, setRefused] = useState<string | null>(null)

  useEffect(() => {
    setRefused(null)
    setShowResolved(false)
  }, [objectId])

  if (!objectId) return null

  const done = (call: Promise<unknown>): void => {
    call.then(
      () => setRefused(null),
      (e: unknown) => setRefused(e instanceof Error ? e.message : String(e))
    )
  }
  const row = (mark: (typeof marks)[number]) => (
    <MarkRow
      key={mark.id}
      mark={mark}
      active={mark.id === active}
      elsewhere={mark.layout !== layout}
      change={(patch: MarkPatch) => done(window.torno.marks.update(objectId, mark.id, patch))}
      remove={() => done(window.torno.marks.remove(objectId, mark.id))}
    />
  )
  const open = marks.filter((m) => m.status !== 'resolved')
  const resolved = marks.filter((m) => m.status === 'resolved')

  return (
    <section className="section marks" aria-label="Marks">
      <h2 className="section-title">Marks</h2>
      {problem !== null && (
        <p className="marks-problem selectable" role="status">
          {problem}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              actions.dismissMarksProblem()
              void window.torno.marks.dismissProblem(objectId).catch(() => {})
            }}
          >
            Dismiss
          </button>
        </p>
      )}
      {refused !== null && (
        <p className="marks-problem selectable" role="alert">
          {refused}
        </p>
      )}
      <div className="marks-body">
        {marks.length === 0 && (
          <div className="marks-empty">
            <p>Point at the part to leave a note for the agent.</p>
            <ul className="marks-keys" aria-label="Tool keys">
              {TOOLS.filter((t) => t.name !== 'select').map((t) => (
                <li key={t.name}>
                  <kbd className="num">{t.key}</kbd>
                  {t.label.toLowerCase()}
                </li>
              ))}
            </ul>
          </div>
        )}
        {marks.length > 0 && open.length === 0 && <p className="section-note">Every mark is resolved.</p>}
        {open.length > 0 && <ul className="mark-rows">{open.map(row)}</ul>}
        {resolved.length > 0 && (
          <>
            <button type="button" className="marks-fold" aria-expanded={showResolved} onClick={() => setShowResolved((shown) => !shown)}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 4 4 4-4 4" />
              </svg>
              Resolved
              <span className="num">{resolved.length}</span>
            </button>
            {showResolved && (
              <ul className="mark-rows" aria-label="Resolved marks">
                {resolved.map(row)}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
}

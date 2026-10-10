import { hint, pressed } from '../../shared/keys'
import { useEffect, useRef, useState } from 'react'
import { type ExportPlan, type ExportRequest, SCAN_WARNING, megabytes } from '../../shared/exportdata'
import { count } from '../../shared/format'
import { actions, sceneFileOf, store, useStore } from '../state/store'

/** `2 parts`, the number in the face of numbers. */
function Count({ n, one, many = `${one}s` }: { n: number; one: string; many?: string }) {
  return (
    <>
      <span className="num">{count(n)}</span> {n === 1 ? one : many}
    </>
  )
}

/** What can take the focus in the sheet, in order. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]'

/**
 * What goes into an export, said before anything is written: the objects, whether their marks and notes go with
 * them, each scan by its own tick, what the file would weigh and what would be cut to keep it small. Marks and
 * scans are off until ticked: a note may be private, and a scan may show the real world. "Export" asks main,
 * which asks where to save; the window never names a path.
 */
export function ExportSheet() {
  const of = useStore((s) => s.exportOf)
  if (of === null) return null
  return <Sheet key={of === 'all' ? 'all' : of.join('\n')} of={of} />
}

function Sheet({ of }: { of: string[] | 'all' }) {
  const names = useStore((s) => s.workspace?.objects ?? NONE)
  const [objects, setObjects] = useState<string[] | null>(of === 'all' ? null : of)
  const [marks, setMarks] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [scans, setScans] = useState<string[]>([])
  const [plan, setPlan] = useState<ExportPlan | null>(null)
  const [busy, setBusy] = useState<'planning' | 'saving' | null>('planning')
  const [said, setSaid] = useState<{ saved?: { path: string; bytes: number }; nothing?: true; error?: string } | null>(null)
  const sheet = useRef<HTMLElement>(null)
  const asked = useRef(0)
  const saving = useRef(false)
  saving.current = busy === 'saving'

  // The export is of what is on screen: what the open object's scene file should hold is given to main now, not when the next save is due.
  useEffect(() => {
    const s = store.getState()
    if (s.objectId !== null) window.torno.object.saveSceneFile(s.objectId, sceneFileOf(s))
  }, [])

  // What the file would hold and weigh, asked again whenever a tick changes. With nothing chosen yet, every object that can be exported is.
  useEffect(() => {
    const mine = ++asked.current
    setBusy((was) => (was === 'saving' ? was : 'planning'))
    window.torno.export.plan({ objects: objects ?? [], marks, scans, hidden, resolved }).then(
      (found) => {
        if (mine !== asked.current) return
        if (objects === null) return setObjects(found.objects.filter((object) => object.exportable).map((object) => object.id))
        setPlan(found)
        setBusy((was) => (was === 'saving' ? was : null))
      },
      (e) => {
        if (mine !== asked.current) return
        setSaid({ error: e instanceof Error ? e.message : String(e) })
        setBusy((was) => (was === 'saving' ? was : null))
      }
    )
  }, [objects, marks, scans, hidden, resolved])

  // The keys are the sheet's while it is up, and the focus comes back to where it was when it goes.
  useEffect(() => {
    const before = document.activeElement
    sheet.current?.focus()
    // Escape puts it away from wherever the focus is; from within, the sheet hears it first.
    const onKey = (e: KeyboardEvent): void => {
      if (pressed(e, 'sheet.close') && !e.defaultPrevented && !saving.current) actions.exportSheet(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      // What main kept ready for this sheet (scans reduced) is let go.
      window.torno.export.done()
      window.removeEventListener('keydown', onKey)
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  const ticked = objects ?? []
  const request = (): ExportRequest => ({ objects: ticked, marks, scans: scans.filter((key) => ticked.some((id) => key.startsWith(`${id}/`))), hidden, resolved })
  const tick = (list: string[], key: string, on: boolean): string[] => (on ? [...new Set([...list, key])] : list.filter((one) => one !== key))
  const changed = (): void => setSaid(null)

  async function save() {
    setBusy('saving')
    setSaid(null)
    // Whatever was changed in the view behind the sheet since it came up is in the file too.
    const s = store.getState()
    if (s.objectId !== null) window.torno.object.saveSceneFile(s.objectId, sceneFileOf(s))
    try {
      const saved = await window.torno.export.save(request())
      setSaid(saved ? { saved } : { nothing: true })
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    }
    setBusy(null)
  }

  const can = (plan?.objects ?? []).filter((object) => object.exportable)
  const cannot = (plan?.objects ?? []).filter((object) => !object.exportable)
  const chosen = can.filter((object) => ticked.includes(object.id))
  const sum = (of: (object: ExportPlan['objects'][number]) => number | undefined): number => chosen.reduce((total, object) => total + (of(object) ?? 0), 0)
  const notes = sum((object) => object.marks)
  const dimensions = sum((object) => object.dimensions)
  const drafts = sum((object) => object.drafts)
  const settled = sum((object) => object.resolved)
  const off = sum((object) => object.off)
  const withScans = chosen.filter((object) => object.scans.length > 0)
  const nameOf = (id: string): string => names.find((object) => object.id === id)?.name ?? id

  return (
    // Over the whole window while it is up: nothing behind it takes a click or the focus until it is answered.
    <div className="export-layer">
      <section
        ref={sheet}
        className="export-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Export"
        tabIndex={-1}
        onKeyDown={(e) => {
          // No tool of the view under it is handed a key: what is exported is what was on screen when the sheet came up.
          e.stopPropagation()
          if (pressed(e, 'sheet.close') && busy !== 'saving') actions.exportSheet(null)
          if (!pressed(e, 'sheet.round')) return
          // Tab goes round within the sheet.
          const stops = [...sheet.current!.querySelectorAll<HTMLElement>(FOCUSABLE)]
          if (stops.length === 0) return e.preventDefault()
          const at = stops.indexOf(document.activeElement as HTMLElement)
          if (e.shiftKey ? at <= 0 : at === stops.length - 1) {
            e.preventDefault()
            stops[e.shiftKey ? stops.length - 1 : 0].focus()
          }
        }}
      >
        <header className="export-head">
          <h2>Export to one HTML file</h2>
          <button type="button" className="icon-button" aria-label="Close" title={`Close (${hint('sheet.close')})`} disabled={busy === 'saving'} onClick={() => actions.exportSheet(null)}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        <div className="export-body">
          <p className="export-lead">A page that opens by itself in a browser, for someone who has no torno: the parts of the last build, to turn, take apart and cut. It asks nothing of the network. What is ticked here is what is in it.</p>

          <h3 className="section-title">Objects</h3>
          <ul className="export-list">
            {can.map((object) => (
              <li key={object.id}>
                <label className="export-row">
                  <input
                    type="checkbox"
                    checked={ticked.includes(object.id)}
                    disabled={busy === 'saving'}
                    onChange={(e) => {
                      changed()
                      setObjects(tick(ticked, object.id, e.target.checked))
                    }}
                  />
                  <span className="export-name">{nameOf(object.id)}</span>
                  <span className="export-what">
                    <span className="num">r{object.revision}</span> · <Count n={object.parts ?? 0} one="part" />
                    {(object.layouts?.length ?? 0) > 1 && (
                      <>
                        {' '}
                        in <Count n={object.layouts!.length} one="layout" /> ({object.layouts!.join(', ')})
                      </>
                    )}
                    {(object.views?.length ?? 0) > 0 && (
                      <>
                        {' '}
                        · <Count n={object.views!.length} one="saved view" />
                      </>
                    )}{' '}
                    · <Count n={object.triangles ?? 0} one="triangle" />
                  </span>
                  {object.failed && (
                    <span className="export-what" data-tone="warn">
                      The model has failed since: this is its last good build
                    </span>
                  )}
                </label>
              </li>
            ))}
            {plan === null && <li className="export-what">Looking at what there is…</li>}
          </ul>
          {/* What cannot be exported, in a line for each reason: an object with no build of this run is not built for an export. */}
          {[...new Set(cannot.map((object) => object.why))].map((why) => (
            <p key={why} className="export-cannot">
              {why}: {cannot.filter((object) => object.why === why).map((object) => nameOf(object.id)).join(', ')}
            </p>
          ))}

          {off > 0 && (
            <>
              <h3 className="section-title">Parts</h3>
              <label className="export-row">
                <input
                  type="checkbox"
                  checked={hidden}
                  disabled={busy === 'saving'}
                  onChange={(e) => {
                    changed()
                    setHidden(e.target.checked)
                  }}
                />
                <span className="export-name">Include parts that are switched off</span>
                <span className="export-what">
                  <Count n={off} one="part is" many="parts are" /> switched off here: {hidden ? 'in the file, switched off, for whoever opens it to switch on' : 'left out of the file, with the marks on ' + (off === 1 ? 'it' : 'them')}
                </span>
              </label>
            </>
          )}

          <h3 className="section-title">Marks</h3>
          <label className="export-row">
            <input
              type="checkbox"
              checked={marks}
              disabled={busy === 'saving'}
              onChange={(e) => {
                changed()
                setMarks(e.target.checked)
              }}
            />
            <span className="export-name">Include marks and their notes</span>
            <span className="export-what">
              {notes + dimensions === 0 ? (
                'None on what is ticked'
              ) : (
                <>
                  <Count n={notes} one="mark" /> and <Count n={dimensions} one="dimension" />
                  {drafts > 0 && (
                    <>
                      , <Count n={drafts} one="of them a draft" many="of them drafts" /> the agent has not been sent
                    </>
                  )}
                  : every note as it is written, each dimension as it was measured on the build exported
                </>
              )}
            </span>
          </label>
          {settled > 0 && (
            <label className="export-row">
              <input
                type="checkbox"
                checked={resolved}
                disabled={!marks || busy === 'saving'}
                onChange={(e) => {
                  changed()
                  setResolved(e.target.checked)
                }}
              />
              <span className="export-name">Include resolved marks</span>
              <span className="export-what">
                <Count n={settled} one="resolved mark" />, with {settled === 1 ? 'its note' : 'their notes'}: {resolved && marks ? 'in the file' : 'left out'}
              </span>
            </label>
          )}

          {withScans.length > 0 && (
            <>
              <h3 className="section-title">Scans</h3>
              <p className="export-warning">{SCAN_WARNING} What was painted on a scan is never in the file.</p>
              <ul className="export-list">
                {withScans.flatMap((object) =>
                  object.scans.map((scan) => {
                    const key = `${object.id}/${scan.id}`
                    return (
                      <li key={key}>
                        <label className="export-row">
                          <input
                            type="checkbox"
                            checked={scans.includes(key)}
                            disabled={busy === 'saving'}
                            onChange={(e) => {
                              changed()
                              setScans(tick(scans, key, e.target.checked))
                            }}
                          />
                          <span className="export-name">
                            <span className="num">{scan.id}</span> {scan.name}
                          </span>
                          <span className="export-what">
                            of {nameOf(object.id)} · <span className="num">{count(scan.triangles)}</span> triangles
                          </span>
                        </label>
                      </li>
                    )
                  })
                )}
              </ul>
            </>
          )}

          <p className="export-never">Never in the file: where anything is on this computer, the session with the agent, what a model printed, a view the agent proposed and you did not keep.</p>
        </div>
        <footer className="export-foot">
          <div className="export-size" aria-live="polite" data-bytes={plan && !plan.refusal ? plan.bytes : undefined}>
            {plan?.refusal ? (
              <p data-tone={plan.bytes > 0 ? 'fail' : undefined}>{plan.refusal}</p>
            ) : plan ? (
              <p>
                {busy === 'planning' ? 'Weighing… ' : ''}about <span className="num">{megabytes(plan.bytes)}</span>
              </p>
            ) : null}
            {plan?.dropped.map((sentence) => (
              <p key={sentence} data-tone="warn">
                To keep it small: {sentence}
              </p>
            ))}
            {plan?.over && !plan.refusal && (
              <p data-tone="warn">
                The parts alone are over the <span className="num">{megabytes(plan.budget)}</span> torno keeps a file to. Export fewer objects, or go ahead.
              </p>
            )}
            {said?.saved && (
              <p className="export-saved">
                Saved to <span className="export-path">{said.saved.path}</span>
              </p>
            )}
            {said?.nothing && <p>Nothing was saved</p>}
            {said?.error && <p data-tone="fail">{said.error}</p>}
          </div>
          <div className="export-actions">
            <button type="button" className="button" disabled={busy === 'saving'} onClick={() => actions.exportSheet(null)}>
              {said?.saved ? 'Done' : 'Cancel'}
            </button>
            <button type="button" className="button button-primary" disabled={busy !== null || plan === null || plan.refusal !== undefined} onClick={() => void save()}>
              {busy === 'saving' ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

const NONE: never[] = []

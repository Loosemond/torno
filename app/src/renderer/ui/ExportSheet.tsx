import { useEffect, useRef, useState } from 'react'
import { type ExportPlan, type ExportRequest, SCAN_WARNING, megabytes } from '../../shared/exportdata'
import { count } from '../../shared/format'
import { actions, sceneFileOf, store, useStore } from '../state/store'

const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`

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
    window.torno.export.plan({ objects: objects ?? [], marks, scans }).then(
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
  }, [objects, marks, scans])

  // The keys are the sheet's while it is up, and the focus comes back to where it was when it goes.
  useEffect(() => {
    const before = document.activeElement
    sheet.current?.focus()
    // Escape puts it away from wherever the focus is; from within, the sheet hears it first.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !saving.current) actions.exportSheet(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const now = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (now === null || now === document.body || !now.isConnected)) before.focus()
    }
  }, [])

  const ticked = objects ?? []
  const request = (): ExportRequest => ({ objects: ticked, marks, scans: scans.filter((key) => ticked.some((id) => key.startsWith(`${id}/`))) })
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
  const notes = chosen.reduce((sum, object) => sum + (object.marks ?? 0), 0)
  const dimensions = chosen.reduce((sum, object) => sum + (object.dimensions ?? 0), 0)
  const withScans = chosen.filter((object) => object.scans.length > 0)
  const nameOf = (id: string): string => names.find((object) => object.id === id)?.name ?? id

  return (
    <div className="export-layer">
      <section
        ref={sheet}
        className="export-sheet"
        role="dialog"
        aria-label="Export"
        tabIndex={-1}
        onKeyDown={(e) => {
          // No tool of the view under it is handed a key: what is exported is what was on screen when the sheet came up.
          e.stopPropagation()
          if (e.key === 'Escape' && busy !== 'saving') actions.exportSheet(null)
        }}
      >
        <header className="export-head">
          <h2>Export to one HTML file</h2>
          <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" disabled={busy === 'saving'} onClick={() => actions.exportSheet(null)}>
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
                    <span className="num">r{object.revision}</span> · {plural(object.parts ?? 0, 'part')}
                    {(object.layouts?.length ?? 0) > 1 && <> · {object.layouts!.join(', ')}</>}
                    {(object.views?.length ?? 0) > 0 && <> · {plural(object.views!.length, 'saved view')}</>} · <span className="num">{count(object.triangles ?? 0)}</span> triangles
                  </span>
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
                  {plural(notes, 'mark')} and {plural(dimensions, 'dimension')}, with every note as it is written and each dimension as it was measured on the build exported
                </>
              )}
            </span>
          </label>

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
          <div className="export-size" aria-live="polite">
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

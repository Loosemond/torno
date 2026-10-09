import { useEffect, useState, type ReactNode } from 'react'
import { type ScanInfo, type ScanUnit, type ScanUp, UNIT_MM, alignmentOf, importText, staleText } from '../../shared/scans'
import { actions, store, useStore } from '../state/store'
import { Confirm } from './Confirm'
import { EyeIcon } from './Layers'
import { importScan } from './scanDrop'

/** What the import process says it is doing, in the panel's words; a stage with no entry is said as it is. */
const STAGE: Record<string, string> = { hashing: 'checking the file' }
const UNITS = Object.keys(UNIT_MM) as ScanUnit[]

/** A sentence with every number of it in the monospace face. */
function numbered(text: string): ReactNode[] {
  return text.split(/(\d[\d.,]*\d|\d)/).map((piece, n) =>
    n % 2 === 1 ? (
      <span key={n} className="num">
        {piece}
      </span>
    ) : (
      piece
    )
  )
}

/** Has main told why something asked of the scans came to nothing, while their object is still the open one. */
function asked(objectId: string, call: Promise<unknown>): Promise<void> {
  actions.setScansRefused(null)
  return call.then(
    () => {},
    (e: unknown) => {
      if (store.getState().objectId === objectId) actions.setScansRefused(e instanceof Error ? e.message : String(e))
    }
  )
}

/**
 * The scans of the open object, below the layers: surroundings the parts are
 * looked at in. A row says what a scan is, how it was read and whether it is
 * aligned in the layout shown, and switches and thins it like a layer. How a
 * scan is looked at is the person's, kept with the view; what a scan is, is
 * main's.
 */
export function ScansPanel() {
  const objectId = useStore((s) => s.objectId)
  const scans = useStore((s) => s.scans)
  const importing = useStore((s) => s.importing)
  const refused = useStore((s) => s.scansRefused)
  const problem = useStore((s) => s.scansProblem)

  if (!objectId) return null

  const pick = async (): Promise<void> => {
    const path = await window.torno.scans.pick().catch(() => null)
    if (path !== null) importScan(objectId, path)
  }

  return (
    <section className="section scans" aria-label="Scans">
      <div className="section-head">
        <h2 className="section-title">Scans</h2>
        <button type="button" className="button button-quiet" title="Import a scan: GLB, glTF, OBJ, PLY or STL" onClick={() => void pick()}>
          Import scan…
        </button>
      </div>
      {/* What main found wrong with the scans file of this object, once main tells it. */}
      {problem !== null && (
        <p className="scans-line selectable" role="status" data-part="problem">
          {problem}{' '}
          <button type="button" className="link-button" onClick={() => actions.dismissScansProblem()}>
            Dismiss
          </button>
        </p>
      )}
      {importing !== null && (
        <p className="scans-line" role="status" data-part="importing">
          Reading <span className="num">{importing.name}</span>
          {importing.stage ? `: ${STAGE[importing.stage] ?? importing.stage}` : ''}
        </p>
      )}
      {refused !== null && (
        <p className="scans-line selectable" role="alert" data-part="refused" title="Click to put this away" onClick={() => actions.setScansRefused(null)}>
          {refused}
        </p>
      )}
      {scans.length === 0 && importing === null && <p className="section-note">Drop a scan on the view, or import one.</p>}
      {scans.length > 0 && (
        <ul className="rows">
          {scans.map((scan) => (
            <ScanRow key={scan.id} objectId={objectId} scan={scan} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The one thing to know first of a scan in the layout shown. */
function stateOf(scan: ScanInfo, layout: string): { state: string; text: string; title: string } {
  if (scan.meshState === 'missing') return { state: 'mesh-missing', text: 'mesh missing', title: 'The mesh torno made of this scan is gone from the disk: it cannot be drawn or checked' }
  const stale = alignmentOf(scan, layout) ? staleText(scan.checks[layout]) : null
  if (stale) return { state: 'stale', text: 'check alignment', title: stale }
  if (!alignmentOf(scan, layout)) return { state: 'unaligned', text: 'not aligned here', title: 'This scan has no alignment in the layout shown: it is drawn where it was imported' }
  return { state: 'aligned', text: 'aligned', title: 'Aligned to the model in the layout shown' }
}

function ScanRow({ objectId, scan }: { objectId: string; scan: ScanInfo }) {
  const { id } = scan
  const layout = useStore((s) => s.layout)
  const view = useStore((s) => s.scanViews[id])
  const [more, setMore] = useState(false)
  const [unit, setUnit] = useState<ScanUnit>(scan.imported.unit)
  const [up, setUp] = useState<ScanUp>(scan.imported.up)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'convert' | 'remove' | null>(null)
  // As the scan is read now: after a change, and when main says otherwise.
  useEffect(() => {
    setUnit(scan.imported.unit)
    setUp(scan.imported.up)
  }, [scan.imported.unit, scan.imported.up])

  const visible = view?.visible !== false
  const opacity = view?.opacity ?? 1
  const coloured = scan.imported.colours !== 'none'
  const plain = !coloured || view?.colour === 'plain'
  const state = stateOf(scan, layout)
  const source = scan.sourceState === 'missing' ? 'source missing' : scan.sourceState === 'changed' ? 'source changed' : null
  const layouts = Object.keys(scan.alignments)

  const convert = (): void => {
    setAsking(null)
    setBusy(true)
    void asked(objectId, window.torno.scans.convert(objectId, id, { unit, up })).finally(() => setBusy(false))
  }

  return (
    <li className="row scan-row" data-scan={id} data-hidden={visible ? undefined : ''}>
      <div className="scan-head">
        <span className="scan-id num">{id}</span>
        <span className="row-name" title={scan.source.path}>
          {scan.name}
        </span>
        <input
          type="range"
          className="layer-opacity"
          data-set={opacity < 1 ? '' : undefined}
          min={0.1}
          max={1}
          step={0.05}
          value={opacity}
          aria-label={`Opacity of ${id}`}
          title={`Opacity ${Math.round(opacity * 100)} %`}
          onChange={(e) => actions.setScanView(id, { opacity: Number(e.target.value) })}
        />
        <button type="button" className="icon-button" aria-pressed={visible} aria-label={`Show ${id}`} title={visible ? 'Hide' : 'Show'} onClick={() => actions.setScanView(id, { visible: !visible })}>
          <EyeIcon open={visible} />
        </button>
      </div>
      <p className="scan-read">{numbered(importText(scan.imported))}</p>
      <div className="scan-state">
        <span className="chip" data-state={state.state} title={state.title}>
          {state.text}
        </span>
        {source && (
          <span className="chip" data-state={source === 'source missing' ? 'source-missing' : 'source-changed'} title={`${scan.source.path}${source === 'source missing' ? ' is no longer there' : ' is not the file that was imported'}. The scan goes on working from what torno made of it`}>
            {source}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="scan-more" aria-expanded={more} onClick={() => setMore((open) => !open)}>
          More
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 4 4 4-4 4" />
          </svg>
        </button>
      </div>
      {more && (
        <div className="scan-fields">
          <div className="scan-field">
            <span className="scan-label">Read as</span>
            <select className="scan-select num" aria-label={`Unit of ${id}`} value={unit} disabled={busy} onChange={(e) => setUnit(e.target.value as ScanUnit)}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <select className="scan-select" aria-label={`Up axis of ${id}`} value={up} disabled={busy} onChange={(e) => setUp(e.target.value as ScanUp)}>
              <option value="y">Y up</option>
              <option value="z">Z up</option>
            </select>
            <button type="button" className="button" disabled={busy || scan.meshState === 'missing'} onClick={() => (layouts.length > 0 ? setAsking('convert') : convert())}>
              Apply
            </button>
          </div>
          <div className="scan-field">
            <span className="scan-label">Colour</span>
            <div className="scan-choice" role="group" aria-label={`Colour of ${id}`}>
              <button type="button" aria-pressed={!plain} disabled={!coloured} title={coloured ? 'As it was scanned' : 'This scan has no colours of its own'} onClick={() => actions.setScanView(id, { colour: 'own' })}>
                Own colours
              </button>
              <button type="button" aria-pressed={plain} onClick={() => actions.setScanView(id, { colour: 'plain' })}>
                Plain
              </button>
            </div>
          </div>
          <div className="scan-field">
            {scan.meshState === 'missing' && scan.sourceState !== 'missing' && (
              <button type="button" className="button" title={`Read ${scan.source.path} again, as a new scan`} onClick={() => importScan(objectId, scan.source.path)}>
                Import again
              </button>
            )}
            <button type="button" className="button" onClick={() => setAsking('remove')}>
              Remove
            </button>
          </div>
        </div>
      )}
      {asking === 'convert' && (
        <Confirm label={`Drop the alignment of ${id}?`} accept="Change" cancel="Keep as it is" onCancel={() => setAsking(null)} onAccept={convert}>
          Changing the unit or the up axis of <span className="num">{id}</span> drops its alignment in {numberedList(layouts)}.
        </Confirm>
      )}
      {asking === 'remove' && (
        <Confirm
          label={`Remove ${id}?`}
          accept="Remove"
          cancel="Keep it"
          onCancel={() => setAsking(null)}
          onAccept={() => {
            setAsking(null)
            void asked(objectId, window.torno.scans.remove(objectId, id))
          }}
        >
          Remove <span className="num">{id}</span> from this object? Its source file is not touched.
        </Confirm>
      )}
    </li>
  )
}

/** Layout names as a sentence has them, each in the monospace face: `print and assembly`. */
function numberedList(names: string[]): ReactNode[] {
  return names.flatMap((name, n) => [
    n === 0 ? '' : n === names.length - 1 ? ' and ' : ', ',
    <span key={name} className="num">
      {name}
    </span>
  ])
}

import { pressed } from '../../shared/keys'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { alignmentOf, alignmentText, standingOf } from '../../shared/scans'
import { useAgentHighlight } from '../state/agent'
import { type AlignMode, alignStore, nextLine, proposed, scanInHand, setAlignMode, setAlignScan, useAlign } from '../state/align'
import { store, useStore } from '../state/store'
import { useTool } from '../state/tools'
import { clearAlignment, declineRough, keepAlignment, undoAlignment } from '../tools/alignTool'
import { FloorBody } from './align/FloorBody'
import { NudgeBody } from './align/NudgeBody'
import { PairsBody } from './align/PairsBody'
import { Confirm } from './Confirm'
import { capital, numbered } from './numbered'

const MODES: { mode: AlignMode; label: string; title: string }[] = [
  { mode: 'floor', label: 'Floor', title: 'Lay a flat patch of the scan on the ground, or on a face of the model' },
  { mode: 'pairs', label: 'Pairs', title: 'Click a point on the scan, then where it belongs on the model: three pairs fix the scan' },
  { mode: 'nudge', label: 'Nudge', title: 'Move and turn the scan by its handles, or by typed values' }
]
const STEP_WORD = { floor: 'floor', pairs: 'pairs', nudge: 'nudge', typed: 'typed values' } as const

/**
 * The alignment of a scan, floating at the bottom of the viewport while the Align tool is in hand. One line
 * always says what to click next. Nothing is kept by a click in the view: what is in hand is drawn as a
 * preview, and "Apply" has main keep it. An alignment that is only rough is asked about before it is kept;
 * the last one kept can be undone.
 *
 * Fields are the DOM's own while they are typed in: a number is taken on Enter or when its field is left.
 */
export function AlignBar() {
  const inHand = useTool() === 'align'
  const state = useAlign((s) => s)
  const scans = useStore((s) => s.scans)
  const layout = useStore((s) => s.layout)
  const scene = useStore((s) => s.scene)
  const revision = useStore((s) => (s.scene ? s.revision : 0))
  const views = useStore((s) => s.scanViews)
  const section = useStore((s) => s.section !== null)
  const selected = useStore((s) => s.selection.length > 0)
  const pointedOut = useAgentHighlight() !== null
  const [clearing, setClearing] = useState(false)
  useEffect(() => setClearing(false), [layout, state.scan, inHand])

  if (!inHand) return null
  const scan = scanInHand(state.scan, scans)
  const current = scan ? alignmentOf(scan, layout) : null
  const proposal = scan ? proposed(state, current) : null
  const hidden = scan ? views[scan.id]?.visible === false : false
  const standing = scan ? standingOf(scan, layout, revision) : null
  // What calls for a look, as against a check that has only not come yet.
  const doubt = standing?.stale && !standing.waiting ? standing.stale : null
  // A check that has failed says why; one that has only not come yet is said by the row's chip, and needs no line here.
  const failed = standing?.waiting && standing.failed ? standing.stale : null
  // The parts of this layout torno set beside the others for display: where they are drawn is not where the model has them.
  const parts = scene?.parts.filter((part) => part.layout === layout) ?? []
  const moved = parts.filter((part) => part.arranged !== undefined).map((part) => part.name)
  const still = parts.filter((part) => part.arranged === undefined).map((part) => part.name)
  const busy = state.sending !== null
  // Above the section's bar, the selection and what the agent points at: each has a row of its own at the bottom edge.
  const raised = (section ? 1 : 0) + (selected ? 1 : 0) + (pointedOut ? 1 : 0)
  const undo = current && current.before !== undefined ? STEP_WORD[current.steps[current.steps.length - 1]] : null

  return (
    <div className="alignbar" role="toolbar" aria-label="Align" data-raised={raised || undefined}>
      <div className="alignbar-head">
        {scans.length > 1 ? (
          <select className="alignbar-scan num" aria-label="Scan to align" value={scan?.id ?? ''} onChange={(e) => setAlignScan(e.target.value || null)}>
            {!scan && <option value="">Choose a scan</option>}
            {scans.map((one) => (
              <option key={one.id} value={one.id}>
                {one.id} {one.name}
              </option>
            ))}
          </select>
        ) : (
          scan && (
            <span className="alignbar-which" title={scan.name}>
              <span className="num">{scan.id}</span> {scan.name}
            </span>
          )
        )}
        <div className="segmented" role="group" aria-label="How to align">
          {MODES.map((m) => (
            <button key={m.mode} type="button" title={m.title} aria-pressed={m.mode === state.mode} disabled={!scan} onClick={() => setAlignMode(m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <p className="alignbar-next" role="status">
        {nextLine(state, scan, scans.length, current, { visible: !hidden })}
      </p>

      {scan && moved.length > 0 && (
        <p className="alignbar-note" data-part="moved">
          torno moved {numberedNames(moved)} for display in <span className="num">{layout}</span>: {still.length > 0 ? <>align to {numberedNames(still)}, which it did not move.</> : 'nothing here is where the model has it. Align in a layout that places the parts as assembled.'}
        </p>
      )}

      {scan && state.mode === 'floor' && <FloorBody state={state} />}
      {scan && state.mode === 'pairs' && <PairsBody state={state} scan={scan} fit={proposal?.fit ?? null} need={proposal?.need ?? null} />}
      {scan && state.mode === 'nudge' && <NudgeBody key={`${scan.id} ${layout}`} state={state} current={current} disabled={busy || state.asking !== null} />}

      {state.asking && <AskRough why={state.asking.why} busy={busy} onKeep={() => void keepAlignment(state.asking!.made, true)} />}
      {state.refused && (
        <p className="alignbar-note selectable" role="alert" data-part="refused">
          {numbered(state.refused)}
        </p>
      )}

      {scan && (
        <div className="alignbar-foot">
          <p className="alignbar-state" data-aligned={current ? '' : undefined}>
            {current ? numbered(`Aligned ${alignmentText(current)}`) : 'Not aligned here'}
            {current?.rough && <span data-part="rough"> · rough: {numbered(current.rough)}</span>}
          </p>
          <button type="button" className="bar-button" disabled={!undo || busy} title={undo ? `Undo the last step (${undo}): puts back the alignment before it` : 'Nothing to undo'} onClick={() => void undoAlignment()}>
            Undo
          </button>
          <button type="button" className="bar-button" disabled={!current || busy} title="The scan is aligned to nothing in this layout any more" onClick={() => setClearing(true)}>
            Clear
          </button>
          {state.mode !== 'nudge' && (
            <button
              type="button"
              className="bar-button alignbar-apply"
              disabled={!proposal || proposal.few === true || busy || state.asking !== null}
              title={state.mode === 'floor' ? 'Lays the patch down' : 'Keeps the scan where the pairs fit it'}
              onClick={() => proposal && void keepAlignment(proposal.made)}
            >
              Apply
            </button>
          )}
        </div>
      )}
      {doubt && scan && (
        <p className="alignbar-note" data-part="stale">
          {numbered(capital(doubt))}.{' '}
          <button type="button" className="link-button" title="You looked, and the scan is where it should be: later builds are held against the model as it is now" onClick={() => void window.torno.scans.alignHolds(store.getState().objectId ?? '', scan.id, layout).catch((e: unknown) => alignStore.setState({ refused: e instanceof Error ? e.message : String(e) }))}>
            Still right
          </button>
        </p>
      )}
      {failed && (
        <p className="alignbar-note" data-part="unchecked">
          {numbered(capital(failed))}. It is tried again every <span className="num">30</span> s.
        </p>
      )}
      {standing?.waiting && !failed && (
        <p className="alignbar-note" data-part="unchecked">
          Not checked against <span className="num">r{revision}</span> yet.
        </p>
      )}
      {standing?.note && (
        <p className="alignbar-note" data-part="note">
          {numbered(capital(standing.note))}.
        </p>
      )}
      {clearing && scan && (
        <Confirm
          label={`Clear the alignment of ${scan.id}?`}
          accept="Clear"
          cancel="Keep it"
          onCancel={() => setClearing(false)}
          onAccept={() => {
            setClearing(false)
            void clearAlignment()
          }}
        >
          <span className="num">{scan.id}</span> will be aligned to nothing in <span className="num">{layout}</span>: drawn where it was imported, and left out of every check.
        </Confirm>
      )}
    </div>
  )
}

/**
 * The question before a doubtful fit is kept, in the bar. A dialog: the button that keeps nothing has the focus
 * while it is asked, Escape presses it, and the focus goes back to where it was once it is answered.
 */
function AskRough({ why, busy, onKeep }: { why: string; busy: boolean; onKeep: () => void }) {
  const decline = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement
    decline.current?.focus()
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [])
  return (
    <div
      className="alignbar-ask"
      role="alertdialog"
      aria-label="Keep a rough alignment?"
      onKeyDown={(e) => {
        if (!pressed(e, 'sheet.close')) return
        e.stopPropagation()
        declineRough()
      }}
    >
      <p>{numbered(`${capital(why)}. Keep it as a rough alignment? It is said to be rough wherever the scan is reported.`)}</p>
      <button type="button" className="button" ref={decline} onClick={declineRough}>
        Not yet
      </button>
      <button type="button" className="button" disabled={busy} onClick={onKeep}>
        Keep as rough
      </button>
    </div>
  )
}

/** Part names as a sentence has them, each in the monospace face: `lid, clip and tray`. */
export function numberedNames(names: string[]): ReactNode[] {
  return names.flatMap((name, n) => [
    n === 0 ? '' : n === names.length - 1 ? ' and ' : ', ',
    <span key={name} className="num">
      {name}
    </span>
  ])
}

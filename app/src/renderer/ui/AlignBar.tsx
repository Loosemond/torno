import { useEffect, useRef, useState, type ReactNode } from 'react'
import { type PairFit, WEAK_SPREAD, unitHint } from '../../shared/align'
import { fitNumber, number } from '../../shared/format'
import type { Vec3 } from '../../shared/marks'
import { type ScanAlignment, type ScanInfo, type ScanUnit, IDENTITY, alignmentOf, alignmentText, standingOf } from '../../shared/scans'
import { useAgentHighlight } from '../state/agent'
import { type AlignMode, type AlignState, type PairDraft, alignStore, floorWarning, movedAlignment, nextLine, proposed, scanInHand, setAlignMode, setAlignScan, sizeNote, useAlign, withTypedEnd } from '../state/align'
import { store, useStore } from '../state/store'
import { useTool } from '../state/tools'
import { clearAlignment, declineRough, keepAlignment, readAs, undoAlignment } from '../tools/alignTool'
import { eulerOf, quatOf } from '../tools/shapeTool'
import { Confirm } from './Confirm'

const MODES: { mode: AlignMode; label: string; title: string }[] = [
  { mode: 'floor', label: 'Floor', title: 'Lay a flat patch of the scan on the ground, or on a face of the model' },
  { mode: 'pairs', label: 'Pairs', title: 'Click a point on the scan, then where it belongs on the model: three pairs fix the scan' },
  { mode: 'nudge', label: 'Nudge', title: 'Move and turn the scan by its handles, or by typed values' }
]
const AXES = ['x', 'y', 'z'] as const
const STEP_WORD = { floor: 'floor', pairs: 'pairs', nudge: 'nudge', typed: 'typed values' } as const

/** A sentence with every number of it in the monospace face. */
function numbered(text: string): ReactNode[] {
  return text.split(/(-?\d[\d.,]*\d|-?\d)/).map((piece, n) =>
    n % 2 === 1 ? (
      <span key={n} className="num">
        {piece}
      </span>
    ) : (
      piece
    )
  )
}

const coords = (p: Vec3): string => `(${p.map(number).join(', ')})`
/** What was typed as a number; NaN for what is none. */
const typed = (text: string): number => {
  const cleaned = text.trim().replace(',', '.').replace('−', '-')
  return cleaned === '' ? Number.NaN : Number(cleaned)
}
/** A number as a field shows it: to the hundredth, without the zeros that say nothing. */
const shown = (value: number): string => String(Math.round(value * 100) / 100 + 0)

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
  const doubt = standing?.stale?.endsWith(': check the alignment') ? standing.stale : null
  const waiting = standing?.stale && !doubt ? standing.stale : null
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
      {waiting && (
        <p className="alignbar-note" data-part="unchecked">
          {numbered(capital(waiting))}: it is asked again.
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

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

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
        if (e.key !== 'Escape') return
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
function numberedNames(names: string[]): ReactNode[] {
  return names.flatMap((name, n) => [
    n === 0 ? '' : n === names.length - 1 ? ' and ' : ', ',
    <span key={name} className="num">
      {name}
    </span>
  ])
}

/** One number to type: the DOM's own while it is typed in; `commit` is given what was typed when it is a number. */
function Field({ label, sign, axis, value, unit, disabled, commit }: { label: string; sign?: string; axis?: 'x' | 'y' | 'z'; value: string; unit?: string; disabled?: boolean; commit: (value: number, input: HTMLInputElement) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = value
  }, [value])
  const done = (input: HTMLInputElement): void => {
    const n = typed(input.value)
    if (Number.isFinite(n) && input.value.trim() !== value) commit(n, input)
    else if (!Number.isFinite(n)) input.value = value
  }
  return (
    <label className="shape-field align-field" data-axis={axis} data-disabled={disabled ? '' : undefined}>
      {sign && (
        <span className="shape-sign num" aria-hidden="true">
          {sign}
        </span>
      )}
      <input
        ref={ref}
        className="num"
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        defaultValue={value}
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => done(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done(e.currentTarget)
          else if (e.key === 'Escape') e.currentTarget.value = value
          else return
          e.preventDefault()
          e.stopPropagation()
          e.currentTarget.select()
        }}
      />
      {unit && (
        <span className="num align-unit" aria-hidden="true">
          {unit}
        </span>
      )}
    </label>
  )
}

function FloorBody({ state }: { state: AlignState }) {
  const { floor, onto, choosingFace, height, flip } = state
  const share = floor?.of ? Math.round((100 * floor.plane.used) / floor.of) : null
  const warning = floor ? floorWarning(floor) : null
  return (
    <div className="alignbar-body" data-mode="floor">
      <div className="alignbar-row">
        <span className="alignbar-label">Lay on</span>
        <div className="segmented" role="group" aria-label="What the floor is laid on">
          <button type="button" aria-pressed={!onto && !choosingFace} title="The plane z = height" onClick={() => alignStore.setState({ onto: null, choosingFace: false })}>
            Ground
          </button>
          <button type="button" aria-pressed={onto !== null || choosingFace} title="A flat face of the model: click it" onClick={() => alignStore.setState({ choosingFace: true, onto: null })}>
            On a face
          </button>
        </div>
        {onto ? (
          <span className="alignbar-onto">
            <span className="num">{onto.part}</span> at <span className="num">{coords(onto.origin)}</span>
          </span>
        ) : (
          <Field label="Height in millimetres" sign="z" axis="z" unit="mm" value={shown(height)} disabled={choosingFace} commit={(value) => alignStore.setState({ height: value })} />
        )}
        <button type="button" className="bar-button" aria-pressed={flip} disabled={!floor} title="Lay the scan the other way up" onClick={() => alignStore.setState({ flip: !flip })}>
          Flip
        </button>
      </div>
      {floor && (
        <p className="alignbar-fit" data-warn={warning ? '' : undefined}>
          plane rms <span className="num">{fitNumber(floor.plane.rms)}</span> mm over <span className="num">{floor.plane.used}</span> triangles
          {share !== null && floor.of !== 3 && (
            <>
              {' '}
              (<span className="num">{share}</span> % of the patch)
            </>
          )}
          {warning && <span data-part="warning"> · {warning}</span>}
        </p>
      )}
    </div>
  )
}

function PairsBody({ state, scan, fit, need }: { state: AlignState; scan: ScanInfo; fit: PairFit | null; need: string | null }) {
  const { pairs, scale } = state
  // The residuals are of the whole pairs, in their order.
  let whole = -1
  const residuals = pairs.map((pair) => (pair.scan && pair.model ? (fit?.residuals[++whole] ?? null) : null))
  const worst = fit && fit.residuals.length > 0 ? fit.residuals.indexOf(Math.max(...fit.residuals)) : -1
  const worstPair = worst < 0 ? -1 : residuals.findIndex((r, n) => r !== null && residuals.slice(0, n + 1).filter((x) => x !== null).length === worst + 1)
  const note = fit ? sizeNote(fit, scan.imported.unit) : null
  const hint = fit ? unitHint(fit.freeScale, scan.imported.unit) : null
  const layouts = Object.keys(scan.alignments)
  const weak = fit && need === null && fit.spread < WEAK_SPREAD
  /** The unit to read the scan in, while it waits for a yes: changing it drops the alignments the scan has. */
  const [unitAsked, setUnitAsked] = useState<{ unit: ScanUnit; layouts: string[] } | null>(null)
  const read = (unit: ScanUnit, yes = false): void => {
    setUnitAsked(null)
    void readAs(unit, yes).then((went) => {
      if (Array.isArray(went)) setUnitAsked({ unit, layouts: went })
    })
  }
  return (
    <div className="alignbar-body" data-mode="pairs">
      {pairs.length > 0 && (
        <ol className="align-pairs">
          {pairs.map((pair, n) => (
            <PairRow key={n} n={n} pair={pair} residual={residuals[n]} worst={n === worstPair && fit !== null && fit.residuals[worst] > 2 * fit.rms && fit.rms > 1e-6} />
          ))}
        </ol>
      )}
      {fit && need === null && (
        <p className="alignbar-fit" data-warn={weak ? '' : undefined}>
          rms <span className="num">{fitNumber(fit.rms)}</span> mm · worst <span className="num">{fitNumber(fit.residuals[worst])}</span> mm (pair <span className="num">{worstPair + 1}</span>)
          {weak && <span data-part="warning"> · these points are nearly in a line: how the scan is turned about it is poorly fixed</span>}
        </p>
      )}
      {need !== null && (
        <p className="alignbar-fit" data-part="need">
          {numbered(capital(need))}.{' '}
          <button type="button" className="link-button" title="Moves the scan as far as these pairs fix it, and keeps that as a rough alignment" disabled={state.asking !== null || state.sending !== null} onClick={() => void keepAlignment(proposed(state, alignmentOf(scan, store.getState().layout))!.made)}>
            Keep it rough…
          </button>
        </p>
      )}
      {(note || scale) && (
        <p className="alignbar-note" data-part="size">
          {note && numbered(note)}{' '}
          {hint && (
            <button type="button" className="link-button" title={layouts.length > 0 ? `Reads ${scan.id} as ${hint.unit}, once you have said yes: its alignments would be dropped` : `Reads ${scan.id} as ${hint.unit}: the pairs stay`} onClick={() => read(hint.unit)}>
              Read it as <span className="num">{hint.unit}</span>
            </button>
          )}
          <label className="align-check">
            <input type="checkbox" checked={scale} onChange={(e) => alignStore.setState({ scale: e.target.checked })} /> Keep this scale
          </label>
        </p>
      )}
      {/* The same question the scan's row asks: a change of unit drops every alignment the scan has. */}
      {unitAsked && (
        <Confirm label={`Drop the alignment of ${scan.id}?`} accept="Change" cancel="Keep as it is" onCancel={() => setUnitAsked(null)} onAccept={() => read(unitAsked.unit, true)}>
          Reading <span className="num">{scan.id}</span> as <span className="num">{unitAsked.unit}</span> drops its alignment in {numberedNames(unitAsked.layouts)}. The pairs in hand stay.
        </Confirm>
      )}
    </div>
  )
}

function PairRow({ n, pair, residual, worst }: { n: number; pair: PairDraft; residual: number | null; worst: boolean }) {
  const row = useRef<HTMLLIElement>(null)
  /** The three fields of the model end, when all three hold a number. */
  const keep = (): void => {
    const inputs = [...(row.current?.querySelectorAll<HTMLInputElement>('input') ?? [])]
    const point = inputs.map((input) => typed(input.value))
    if (point.length !== 3 || !point.every((c) => Number.isFinite(c))) return
    if (pair.model && point.every((c, i) => Math.abs(c - pair.model![i]) < 1e-9)) return
    alignStore.setState({ pairs: withTypedEnd(alignStore.getState().pairs, n, point as Vec3), refused: null })
  }
  return (
    <li
      className="align-pair"
      ref={row}
      onBlur={(e) => {
        // Leaving the three fields keeps what they hold, as Enter does: a number typed is not lost to a click on Apply.
        if (!e.currentTarget.contains(e.relatedTarget)) keep()
      }}
    >
      <span className="align-pair-n num">{n + 1}</span>
      <span className="align-pair-scan" data-missing={pair.scan ? undefined : ''} title={pair.scan ? `The point of the scan, in the scan's own frame: (${pair.scan.join(', ')}) mm` : undefined}>
        {pair.scan ? <span className="num">{coords(pair.scan)}</span> : 'click the scan'}
      </span>
      <span className="align-pair-to" aria-hidden="true">
        →
      </span>
      <span className="align-pair-part num" title={pair.part ?? (pair.model ? 'A typed point, on no part' : undefined)}>
        {pair.part ?? (pair.model ? 'typed' : '')}
      </span>
      {AXES.map((axis, i) => (
        <input
          key={`${axis} ${pair.model ? pair.model[i] : ''}`}
          className="num align-pair-field"
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          aria-label={`Model ${axis} of pair ${n + 1}`}
          placeholder={axis}
          title={pair.model ? `${pair.model[i]} mm` : undefined}
          defaultValue={pair.model ? number(pair.model[i]) : ''}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            e.stopPropagation()
            keep()
          }}
        />
      ))}
      <span className="align-pair-residual num" data-worst={worst ? '' : undefined} title={residual === null ? undefined : `The fit leaves this pair ${fitNumber(residual)} mm apart`}>
        {residual === null ? '' : fitNumber(residual)}
      </span>
      <button type="button" className="icon-button align-pair-remove" aria-label={`Remove pair ${n + 1}`} title="Remove this pair" onClick={() => alignStore.setState({ pairs: alignStore.getState().pairs.filter((_, i) => i !== n) })}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
          <path d="m4.5 4.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </li>
  )
}

/**
 * Where the scan's own origin is, in millimetres, and how the scan is turned, in degrees about X, then Y,
 * then Z, as a shape's are shown. Many triples of angles are one turn: while the angles are typed the three
 * typed are the three shown, and they are worked out again once the scan is turned some other way.
 */
function NudgeBody({ state, current, disabled }: { state: AlignState; current: ScanAlignment | null; disabled: boolean }) {
  const transform = current?.transform ?? IDENTITY
  const [angles, setAngles] = useState<Vec3 | null>(null)
  // A rotation and its negative are the same turn.
  const sameTurn = (a: readonly number[], b: readonly number[]): boolean => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 1 - 1e-9
  // In full: a field shows two decimals, and typing one angle leaves the other two as they are, not as they are shown.
  const degrees = angles && sameTurn(quatOf(angles), transform.q) ? angles : eulerOf(transform.q)
  const withOne = (of: Vec3, index: number, value: number): Vec3 => of.map((c, i) => (i === index ? value : c)) as Vec3
  const keep = (made: ScanAlignment['transform']): void => void keepAlignment(movedAlignment(current, made, 'typed'))
  return (
    <div className="alignbar-body" data-mode="nudge">
      <div className="alignbar-row">
        <span className="alignbar-label">
          Origin <span className="num">mm</span>
        </span>
        {AXES.map((axis, i) => (
          <Field key={axis} label={axis.toUpperCase()} sign={axis} axis={axis} value={shown(transform.t[i])} disabled={disabled} commit={(value) => keep({ ...transform, t: withOne(transform.t, i, value) })} />
        ))}
      </div>
      <div className="alignbar-row">
        <span className="alignbar-label">
          Turned <span className="num">°</span>
        </span>
        {AXES.map((axis, i) => (
          <Field
            key={axis}
            label={`R${axis.toUpperCase()}`}
            sign={axis}
            axis={axis}
            value={shown(degrees[i])}
            disabled={disabled}
            commit={(value) => {
              const next = withOne(degrees, i, value)
              // Kept as typed while the scan is turned so: the same turn has many triples of angles.
              setAngles(next)
              keep({ ...transform, q: quatOf(next) })
            }}
          />
        ))}
        <div className="segmented" role="group" aria-label="What the handles do">
          <button type="button" aria-pressed={state.handle === 'translate'} aria-keyshortcuts="G" title="Move the scan with the handles in the view (G)" onClick={() => alignStore.setState({ handle: 'translate' })}>
            Move
            <kbd className="num" aria-hidden="true">
              G
            </kbd>
          </button>
          <button type="button" aria-pressed={state.handle === 'rotate'} aria-keyshortcuts="R" title="Turn the scan with the handles in the view (R)" onClick={() => alignStore.setState({ handle: 'rotate' })}>
            Turn
            <kbd className="num" aria-hidden="true">
              R
            </kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

import { pressed } from '../../../shared/keys'
import { useRef } from 'react'
import { type PairFit, WEAK_SPREAD, unitHint } from '../../../shared/align'
import { fitNumber, number } from '../../../shared/format'
import type { Vec3 } from '../../../shared/marks'
import { type ScanInfo, type ScanUnit, alignmentOf } from '../../../shared/scans'
import { type AlignState, type PairDraft, alignStore, proposed, sizeNote, withTypedEnd } from '../../state/align'
import { store } from '../../state/store'
import { keepAlignment, readAs } from '../../tools/alignTool'
import { numberedNames } from '../AlignBar'
import { Confirm } from '../Confirm'
import { capital, numbered } from '../numbered'
import { typed } from '../typed'
import { AXES, coords } from './format'

export function PairsBody({ state, scan, fit, need }: { state: AlignState; scan: ScanInfo; fit: PairFit | null; need: string | null }) {
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
  const { unitAsked } = state
  const read = (unit: ScanUnit, yes = false): void => void readAs(unit, yes)
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
          RMS <span className="num">{fitNumber(fit.rms)}</span> mm · worst <span className="num">{fitNumber(fit.residuals[worst])}</span> mm (pair <span className="num">{worstPair + 1}</span>)
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
        <Confirm label={`Drop the alignment of ${scan.id}?`} accept="Change" cancel="Keep as it is" onCancel={() => alignStore.setState({ unitAsked: null })} onAccept={() => read(unitAsked.unit, true)}>
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
    // Nothing was typed: the end is as it was clicked, on its part and in full, whatever its fields show of it.
    if (inputs.every((input) => input.value === input.defaultValue)) return
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
      <span className="align-pair-ends">
        <span className="align-pair-scan num" data-missing={pair.scan ? undefined : ''} title={pair.scan ? `The point of the scan, in the scan's own frame: (${pair.scan.join(', ')}) mm` : undefined}>
          {pair.scan ? coords(pair.scan) : 'click the scan'}
        </span>
        <span className="align-pair-part" title={pair.part ?? (pair.model ? 'A typed point, on no part' : undefined)}>
          → <span className="num">{pair.part ?? (pair.model ? 'typed' : '…')}</span>
        </span>
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
            // Escape gives up what was typed in the three fields: they show the end as it is kept again.
            if (pressed(e, 'field.leave')) {
              const inputs = [...(row.current?.querySelectorAll<HTMLInputElement>('input') ?? [])]
              if (inputs.every((input) => input.value === input.defaultValue)) return
              e.preventDefault()
              e.stopPropagation()
              for (const input of inputs) input.value = input.defaultValue
              e.currentTarget.select()
              return
            }
            if (!pressed(e, 'field.keep')) return
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

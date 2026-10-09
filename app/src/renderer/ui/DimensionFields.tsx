import { useState } from 'react'
import { awaitsMeasurement, defaultTolerance, dimensionText, measuredValue, offBy } from '../../shared/dimension'
import type { DimensionMark, MarkPatch } from '../../shared/marks'

/** What the row says of a dimension the kernel has not answered for yet, and of one it cannot measure. */
export const MEASURING = 'measuring…'
export const NOT_MEASURABLE = 'not measurable'

/** A dimension's value as its row shows it: the value, or why there is none. */
export function shownValue(mark: DimensionMark): string {
  if (measuredValue(mark) !== undefined) return dimensionText(mark)
  return awaitsMeasurement(mark) ? MEASURING : NOT_MEASURABLE
}

const unitOf = (mark: DimensionMark): string => (mark.measure === 'angle' ? '°' : 'mm')

/**
 * The numbers of a dimension, in its row of the marks panel while it is the
 * active mark: the value the kernel measured (in full when pointed at) and
 * how it was taken, what it should be and how far off it may be, both to be
 * typed, and the verdict. A number is sent when its field is left or Enter is
 * pressed; emptied, the expectation is taken away, or the tolerance put back
 * to its default. The value is never typed: it is the kernel's.
 */
export function DimensionFields({ mark, change }: { mark: DimensionMark; change: (patch: MarkPatch) => Promise<unknown> }) {
  const value = measuredValue(mark)
  const unit = unitOf(mark)
  const send = (patch: MarkPatch): void => void change(patch).catch(() => {})
  return (
    <div className="dimension-fields" onClick={(e) => e.stopPropagation()}>
      <p className="dimension-read">
        <span className="dimension-value num" data-none={value === undefined ? '' : undefined} title={value === undefined ? undefined : `${value} ${unit}, as measured`}>
          {shownValue(mark)}
        </span>
        {value !== undefined && mark.how && <span className="dimension-how">{mark.how}</span>}
        {value === undefined && !awaitsMeasurement(mark) && (
          <span className="dimension-how">{mark.anchorState === 'ok' ? 'the kernel could not measure it on this build' : 'an end of it is no longer where it was put'}</span>
        )}
      </p>

      <fieldset className="shape-group dimension-expect">
        <legend>
          Should be <span className="num">{unit}</span>
        </legend>
        <OptionalNumber name="Expected" sign="=" value={mark.expected} placeholder="any" commit={(expected) => send({ expected })} />
        <OptionalNumber name="Tolerance" sign="±" value={mark.tolerance} placeholder={String(defaultTolerance(mark.measure))} least={0} commit={(tolerance) => send({ tolerance })} />
      </fieldset>

      {mark.expected !== undefined && (
        <p className="dimension-verdict" data-verdict={value === undefined ? 'none' : mark.verdict} role="status">
          {value === undefined ? (
            'Not checked: there is no value to compare'
          ) : mark.verdict === 'pass' ? (
            <>
              <VerdictIcon pass />
              Passes
            </>
          ) : (
            <>
              <VerdictIcon />
              Fails: <span className="num">{offBy(value, mark.expected)}</span>
            </>
          )}
        </p>
      )}
    </div>
  )
}

/** A tick for what passes, a cross for what fails. */
export function VerdictIcon({ pass = false }: { pass?: boolean }) {
  return (
    <svg className="verdict-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={pass ? 'm2.25 6.5 2.5 2.5 5-5.75' : 'm3 3 6 6M9 3l-6 6'} />
    </svg>
  )
}

/**
 * One number that may be absent, to be typed over. `commit` is given the
 * number when the field is left or Enter is pressed, or null when the field
 * was emptied; nothing when it holds no number, a number under `least`, or
 * what was there.
 */
function OptionalNumber({ name, sign, value, placeholder, least, commit }: { name: string; sign: string; value: number | undefined; placeholder: string; least?: number; commit: (value: number | null) => void }) {
  // What is being typed; null while the field only shows the number.
  const [draft, setDraft] = useState<string | null>(null)
  const done = (): void => {
    if (draft === null) return
    setDraft(null)
    const text = draft.trim().replace(',', '.')
    if (text === '') {
      if (value !== undefined) commit(null)
      return
    }
    const typed = Number(text)
    if (Number.isFinite(typed) && typed !== value && (least === undefined || typed >= least)) commit(typed)
  }
  return (
    <label className="shape-field">
      <span className="shape-sign num" aria-hidden="true">
        {sign}
      </span>
      <input
        className="num"
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={name}
        placeholder={placeholder}
        value={draft ?? (value === undefined ? '' : String(value))}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done()
          else if (e.key === 'Escape') setDraft(null)
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      />
    </label>
  )
}

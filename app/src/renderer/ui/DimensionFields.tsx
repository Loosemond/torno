import { useState } from 'react'
import { defaultTolerance, isOffEdge, lastValue, measuredValue, offBy, standingOf, unmeasuredText, valueText } from '../../shared/dimension'
import type { DimensionMark, MarkPatch } from '../../shared/marks'

/** What the row says of a dimension the kernel cannot measure on the build on show. */
export const NOT_MEASURABLE = 'not measurable'

/**
 * A dimension's value as its row shows it on the build `revision`: the value
 * measured on that build; the last it had, when it has not been measured on
 * that build (`stale`: shown greyed, and never as the value of this build);
 * or, in words, that it has none.
 */
export function shownValue(mark: DimensionMark, revision: number): { text: string; stale?: true; none?: true } {
  const value = measuredValue(mark, revision)
  if (value !== undefined) return { text: valueText(mark.measure, value) }
  if (standingOf(mark, revision) === 'unmeasurable') return { text: NOT_MEASURABLE, none: true }
  const last = lastValue(mark)
  return last === undefined ? { text: unmeasuredText(revision), none: true } : { text: valueText(mark.measure, last), stale: true }
}

/** `r12`, in the face of numbers. */
const Rev = ({ revision }: { revision: number }) => <span className="num">r{revision}</span>

/**
 * What the person can do about a dimension whose end is no longer on the edge
 * it was put on: said after the reason, in the row only. A dimension is not
 * put somewhere else as a pin is, so it is measured anew; between faces it
 * follows the part when that changes size.
 */
export const OFF_EDGE_ADVICE = ' — measure it again, or between faces'

/** Why a dimension has no value of the build on show, in a few words; of an end off its edge, with what to do. */
export function whyNotMeasurable(mark: DimensionMark): string {
  if (mark.refused === undefined) return 'the kernel could not measure it on this build'
  return `${mark.refused}${isOffEdge(mark.refused) ? OFF_EDGE_ADVICE : ''}`
}

/** Why a dimension has no value of the build on show, in a few words. */
function WhyNone({ mark, revision }: { mark: DimensionMark; revision: number }) {
  if (mark.anchorState === 'orphaned') return <>the part an end of it was on is gone</>
  if (standingOf(mark, revision) !== 'unmeasured') return <>{whyNotMeasurable(mark)}</>
  if (lastValue(mark) === undefined) return <>it is measured after every build</>
  return (
    <>
      not measured{revision > 0 && <> on <Rev revision={revision} /></>}: this is what it was{mark.measuredRevision !== undefined && <> on <Rev revision={mark.measuredRevision} /></>}
    </>
  )
}

const unitOf = (mark: DimensionMark): string => (mark.measure === 'angle' ? '°' : 'mm')

/**
 * The numbers of a dimension, in its row of the marks panel while it is the
 * active mark: the value the kernel measured (in full when pointed at) and
 * how it was taken, what it should be and how far off it may be, both to be
 * typed, and the verdict. A number is sent when its field is left or Enter is
 * pressed; emptied, the expectation is taken away, or the tolerance put back
 * to its default. The value is never typed: it is the kernel's, as measured
 * on the build `revision`; one of another build is greyed and says so, and
 * is not held against what is expected.
 */
export function DimensionFields({ mark, revision, change }: { mark: DimensionMark; revision: number; change: (patch: MarkPatch) => Promise<unknown> }) {
  const value = measuredValue(mark, revision)
  const shown = shownValue(mark, revision)
  const unit = unitOf(mark)
  const send = (patch: MarkPatch): void => void change(patch).catch(() => {})
  return (
    <div className="dimension-fields" onClick={(e) => e.stopPropagation()}>
      <p className="dimension-read">
        <span className="dimension-value num" data-none={shown.none ? '' : undefined} data-stale={shown.stale ? '' : undefined} title={value === undefined ? undefined : `${value} ${unit}, as measured`}>
          {shown.text}
        </span>
        {value !== undefined && (mark.how || mark.anchorState === 'drifted') && (
          <span className="dimension-how">{[mark.how, mark.anchorState === 'drifted' ? 'measured from what is under its ends now' : ''].filter(Boolean).join(', ')}</span>
        )}
        {value === undefined && (
          <span className="dimension-how">
            <WhyNone mark={mark} revision={revision} />
          </span>
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
            'Not checked: there is no value of this build to compare'
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

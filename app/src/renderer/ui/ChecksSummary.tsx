import { Fragment } from 'react'
import { checksOf } from '../../shared/dimension'
import type { DimensionMark, Mark } from '../../shared/marks'
import { goToRow } from './BuildStatus'
import { UNCHECKED_AFTER_MS, useLasting } from './MarkRow'

/**
 * The line that heads the marks when the project has checks (dimensions with something expected of them):
 * `Checks on r12: 3 pass · 1 fails · 1 not measured`. Each count is a button that goes to the first such check, as
 * the status line's does. The colours are the verdict's (`--ok`, `--fail`), never a mark's. Every build leaves
 * every check unmeasured for the moment the measuring takes: that count is said only when it lasts.
 */
export function ChecksSummary({ marks, revision }: { marks: readonly Mark[]; revision: number }) {
  const { failing, unmeasured, passing } = checksOf(marks, revision)
  const waiting = useLasting(unmeasured.length > 0, UNCHECKED_AFTER_MS)
  if (failing.length + unmeasured.length + passing.length === 0) return null
  const counts: Array<{ state: 'pass' | 'fail' | 'unmeasured'; of: DimensionMark[]; text: string; title: string }> = [
    { state: 'pass', of: passing, text: 'pass', title: 'Meet what is expected' },
    { state: 'fail', of: failing, text: failing.length === 1 ? 'fails' : 'fail', title: 'Not what was expected' },
    { state: 'unmeasured', of: waiting ? unmeasured : [], text: 'not measured', title: 'No value of this build' }
  ]
  const shown = counts.filter((c) => c.of.length > 0)
  return (
    <p className="checks-summary" data-part="checks-summary">
      Checks{revision > 0 && <> on <span className="num">r{revision}</span></>}:{' '}
      {shown.length === 0 && <span className="checks-measuring">measuring</span>}
      {shown.map((c, i) => (
        <Fragment key={c.state}>
          {i > 0 && ' · '}
          <button type="button" className="checks-count" data-state={c.state} title={`${c.title}: ${c.of.map((m) => m.id).join(', ')}. Go to the first`} onClick={() => goToRow(c.of[0].id)}>
            <span className="num">{c.of.length}</span> {c.text}
          </button>
        </Fragment>
      ))}
    </p>
  )
}

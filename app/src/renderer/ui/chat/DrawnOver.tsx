import type { ReactNode } from 'react'
import type { DrawnOver } from '../../../shared/drawing'
import { numbered } from '../numbered'
import { RefChip } from './RefChip'

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The pieces of a list, set off by commas. */
function commas(pieces: ReactNode[]): ReactNode[] {
  return pieces.flatMap((piece, i) => (i === 0 ? [piece] : [', ', piece]))
}

/**
 * What the ink of a drawing on the view lies over, as the agent is told it, in refs that are live chips (the pointer
 * on one lights its face in the view): `Over tub/F3, tub/F1, the cut face of lid · stroke 2 over no part`. Above the
 * box before the drawing is sent, under its picture once it is. A drawing the view moved under says it was not worked
 * out (`children`: what the person may do about it, in the box). One drawn on an earlier build says the faces are of that one.
 */
export function DrawnOverLine({ drawn, children }: { drawn: DrawnOver; children?: ReactNode }) {
  const { over } = drawn
  const stale = drawn.latest !== undefined && drawn.latest !== drawn.revision
  const build = stale && (
    <span className="over-note">
      faces are of <RefChip value={`r${drawn.revision}`} />, the model is at <RefChip value={`r${drawn.latest}`} /> now
    </span>
  )
  if (over === null) {
    return (
      <span className="over" data-over="unknown">
        <span className="over-warn">What the ink lies over was not worked out: the view moved while it was drawn.</span>
        {children}
        {build}
      </span>
    )
  }
  const named: ReactNode[] = [
    ...over.faces.map((ref) => <RefChip key={ref} value={ref} />),
    ...(over.moreFaces ? [<span key="more">{numbered(`and ${counted(over.moreFaces, 'more face', 'more faces')}`)}</span>] : []),
    ...over.cuts.map((part) => (
      <span key={`cut ${part}`}>
        the cut face of <span className="num">{part}</span>
      </span>
    )),
    ...over.scans.map((id) => (
      <span key={`scan ${id}`}>
        scan <span className="num">{id}</span>
      </span>
    ))
  ]
  const none = over.strokes === 0 ? 'No ink is left on the picture' : named.length === 0 ? 'Over no part' : null
  const bare = named.length > 0 && over.bare.length > 0 ? numbered(`${over.bare.length === 1 ? 'stroke' : 'strokes'} ${over.bare.join(', ')} over no part`) : null
  return (
    <span className="over" data-over="known">
      {none ?? <>Over {commas(named)}</>}
      {bare && <span className="over-note">{bare}</span>}
      {over.moreStrokes ? <span className="over-note">{numbered(`${counted(over.moreStrokes, 'more stroke', 'more strokes')}, not told`)}</span> : null}
      {build}
    </span>
  )
}

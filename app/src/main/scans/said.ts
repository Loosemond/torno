import { type AlignStep, type ScanAlignment, type ScanInfo, alignmentOf, alignmentText, doubtOf } from '../../shared/scans'

// What is said of a scan's alignment to the agent, in one place: every tool reply, every reading line and the line
// that goes with a prompt take their words from `alignmentSaid`, so that they cannot say different things of one
// alignment. It reads the alignment main keeps (`ScanInfo.alignments`), never where the window draws the scan,
// which may be a preview.

/** To the ninth decimal, and never -0: what a fit leaves past that is arithmetic. */
const tidy = (value: number): number => Math.round(value * 1e9) / 1e9 + 0

/** How a scan's alignment in a layout stands, as data: what a tool's JSON holds under `alignment`. */
export interface AlignmentData {
  state: 'aligned' | 'not aligned'
  by?: string
  steps?: AlignStep[]
  pairs?: number
  rms?: number
  worst?: number
  scaled?: boolean
  /** Why it is only rough, when it is. */
  rough?: string
  /** Why it may no longer hold, when that is so. */
  stale?: string
}

export interface AlignmentSaid {
  /** The alignment main keeps for the layout; null when the scan has none there. */
  alignment: ScanAlignment | null
  /** In a word: aligned, aligned but only roughly, aligned but in doubt, or not aligned in this layout. */
  state: 'aligned' | 'rough' | 'in doubt' | 'not aligned'
  /** What puts it in doubt, most telling first: why it may no longer hold, then why it is only rough. Empty when nothing does. */
  reasons: string[]
  /** Why nothing is checked against the scan in this layout, with what to do; null when it can be. A doubt never refuses. */
  refused: string | null
  data: AlignmentData
  /** In a line: `aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm) but …`, `aligned roughly in print by … (why)`, `not aligned in print`. */
  line: string
  /** What opens a reading that rests on the alignment: its doubts, each a sentence, with a space after; '' when there is none. */
  first: string
  /** What is said beside an answer when the alignment may no longer hold; undefined otherwise. */
  note?: string
  /** What closes a reading: how the scan is aligned, and, of a fit of pairs, that `under` (`a depth`) below its rms says nothing. '' when it is not aligned. */
  last(under?: string): string
}

/**
 * Everything that is said of how a scan is aligned in a layout, as of a build (`revision`: the last one, which a
 * doubt is of). A scan with no alignment there is refused; one that is rough, or that the model may have moved
 * under, is answered with that said first.
 */
export function alignmentSaid(scan: Pick<ScanInfo, 'id' | 'alignments' | 'checks'>, layout: string, _revision?: number): AlignmentSaid {
  const alignment = alignmentOf(scan, layout)
  if (!alignment) {
    const elsewhere = Object.keys(scan.alignments)
    const where = elsewhere.length > 0 ? `it is aligned in: ${elsewhere.join(', ')}` : 'it is aligned in no layout'
    const refused = `${scan.id} is not aligned in layout ${layout} (${where}), so nothing is checked against it there: the user aligns it with the Align tool${elsewhere.length > 0 ? ', or ask in that layout' : ''}`
    return { alignment: null, state: 'not aligned', reasons: [], refused, data: { state: 'not aligned' }, line: `not aligned in ${layout}`, first: '', last: () => '' }
  }
  const doubt = doubtOf(scan, layout)
  const rough = alignment.rough ?? null
  const pairs = alignment.pairs ?? []
  const by = alignmentText(alignment)
  const fitted = pairs.length > 0 && alignment.rms !== undefined
  const data: AlignmentData = {
    state: 'aligned',
    by,
    steps: alignment.steps,
    ...(pairs.length > 0 ? { pairs: pairs.length } : {}),
    ...(alignment.rms === undefined ? {} : { rms: tidy(alignment.rms) }),
    ...(pairs.length > 0 ? { worst: tidy(Math.max(...pairs.map((pair) => pair.residual))) } : {}),
    ...(alignment.scaled ? { scaled: true } : {}),
    ...(rough ? { rough } : {}),
    ...(doubt ? { stale: doubt } : {})
  }
  const holds = doubt ? `${scan.id}'s alignment may no longer hold: ${doubt}` : null
  return {
    alignment,
    state: doubt ? 'in doubt' : rough ? 'rough' : 'aligned',
    reasons: [...(doubt ? [doubt] : []), ...(rough ? [rough] : [])],
    refused: null,
    data,
    line: `aligned ${rough ? 'roughly ' : ''}in ${layout} ${by}${rough ? ` (${rough})` : ''}${doubt ? ` but ${doubt}` : ''}`,
    first: `${holds ? `${holds}. ` : ''}${rough ? `${scan.id} is only roughly aligned: ${rough}. ` : ''}`,
    ...(holds ? { note: holds } : {}),
    last: (under) => `${scan.id} is aligned ${by}${fitted && under ? `: ${under} under that says nothing` : ''}.`
  }
}

/** How a scan is on the person's screen, as it is told in a line: `shown`, `shown at 60 %`, `hidden`, or that its mesh has not come to be drawn. */
export function shownText(view: { visible: boolean; opacity: number; loaded?: boolean }): string {
  if (!view.visible) return 'hidden'
  if (view.loaded === false) return 'not drawn yet'
  return view.opacity < 1 ? `shown at ${Math.round(view.opacity * 100)} %` : 'shown'
}

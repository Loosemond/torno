import { scanNumber } from '../../shared/format'
import { type AlignBasis, type AlignStep, type ScanAlignment, type ScanInfo, alignmentOf, alignmentText, basisOf, standingOf, tiedPoints } from '../../shared/scans'

// What is said of a scan's alignment to the agent, in one place: every tool reply, every reading line and the line
// that goes with a prompt take their words from `alignmentSaid`, so that they cannot say different things of one
// alignment. It reads the alignment main keeps (`ScanInfo.alignments`), never where the window draws the scan,
// which may be a preview.

/** To the ninth decimal, and never -0: what a fit leaves past that is arithmetic. */
const tidy = (value: number): number => Math.round(value * 1e9) / 1e9 + 0

/**
 * A figure of a fit as the agent is told it, less its unit: to a tenth of a millimetre, as everything a reading
 * takes from the scan is (`scanNumber`), and `under 0.1` below half of that. A few clicked points fitted to the
 * micron are no finer than the scan they were clicked on; the data keeps the numbers in full.
 */
const tenth = (mm: number): string => (Math.abs(mm) < 0.05 ? 'under 0.1' : scanNumber(mm))

/** How a scan's alignment in a layout stands, as data: what a tool's JSON holds under `alignment`. */
export interface AlignmentData {
  state: 'aligned' | 'not aligned'
  /** What it rests on: a fit of pairs of points, a floor laid down (where it is on that floor is as imported), or a hand. */
  basis?: AlignBasis
  /** A fit or a floor that was moved by hand afterwards. */
  movedByHand?: boolean
  by?: string
  steps?: AlignStep[]
  pairs?: number
  /** Of a fit of pairs: how far apart they are as the scan stands (mm). Of a floor: of its patch about its plane. */
  rms?: number
  /** How well the pairs were fitted (mm), which a move by hand afterwards does not change: `rms` is then where they are now. */
  fitRms?: number
  worst?: number
  scaled?: boolean
  /** Why it is only rough, when it is. */
  rough?: string
  /** Why it may no longer hold, when that is so: what a build found, a source that changed, or that it was not checked against this build. */
  stale?: string
  /** It was not checked against the build asked about: nothing is known of whether it still holds on it. */
  unchecked?: boolean
  /** How many points of the model it is tied to: with none, no build can say whether it still holds. */
  tied?: number
  /** The user looked and said it still holds, and nothing has put it in doubt since. */
  confirmed?: true
}

export interface AlignmentSaid {
  /** The alignment main keeps for the layout; null when the scan has none there. */
  alignment: ScanAlignment | null
  /** In a word: aligned, aligned but its fit is rough, aligned but in doubt, aligned and not checked against this build, or not aligned in this layout. */
  state: 'aligned' | 'rough' | 'in doubt' | 'not checked' | 'not aligned'
  /** What puts it in doubt, most telling first: why it may no longer hold, then why it is only rough. Empty when nothing does. */
  reasons: string[]
  /** Why nothing is checked against the scan in this layout, with what to do; null when it can be. A doubt never refuses. */
  refused: string | null
  data: AlignmentData
  /** In a line: `aligned in print by 4 pairs (RMS 2.1 mm, worst 3.4 mm) but …`, `aligned roughly in print by … (why)`, `not aligned in print`. */
  line: string
  /** What opens a reading that rests on the alignment: that it rests on a floor alone or on a hand, then its doubts, each a sentence, with a space after; '' when there is nothing to say first. */
  first: string
  /** What is said beside an answer when the alignment may no longer hold; undefined otherwise. */
  note?: string
  /**
   * What closes a reading: how the scan is aligned, with what else is to be known of it (that it is tied to no
   * point of the model, that the user confirmed it), said here once a reply; and, of a fit of pairs, that its
   * rms is of the clicked points: it is no measure of the scan. '' when it is not aligned.
   */
  last(): string
}

/** Said after the rms of a fit of pairs wherever a reading closes with it: a few clicked points fitted to the micron say nothing of a scan true to millimetres. */
export const RMS_OF_CLICKS = 'that RMS is of the clicked points, and says nothing of how true the scan is'

/**
 * Said of a scan that is not aligned in the layout asked: where it is, what the user does, and, when some layout
 * it is aligned in would answer what is asked (`askIn`: all of them unless said otherwise), that one. An
 * alignment is of one layout: none is carried from another.
 */
export function notAligned(scan: Pick<ScanInfo, 'id' | 'alignments'>, layout: string, askIn?: string[]): string {
  const elsewhere = Object.keys(scan.alignments)
  const where = elsewhere.length > 0 ? `it is aligned in: ${elsewhere.join(', ')}` : 'it is aligned in no layout'
  const usable = askIn ?? elsewhere
  return `${scan.id} is not aligned in layout ${layout} (${where}), so nothing is checked against it there: the user aligns it in ${layout} with the Align tool (an alignment is of one layout)${usable.length > 0 ? `, or ask in ${usable.join(', ')}` : ''}`
}

/**
 * Everything that is said of how a scan is aligned in a layout, as of a build (`revision`: the last one, which a
 * doubt is of). A scan with no alignment there is refused; one that is rough, or that the model may have moved
 * under, is answered with that said first.
 */
export function alignmentSaid(scan: Pick<ScanInfo, 'id' | 'alignments' | 'checks'>, layout: string, revision?: number): AlignmentSaid {
  const alignment = alignmentOf(scan, layout)
  if (!alignment) {
    return { alignment: null, state: 'not aligned', reasons: [], refused: notAligned(scan, layout), data: { state: 'not aligned' }, line: `not aligned in ${layout}`, first: '', last: () => '' }
  }
  const standing = standingOf(scan, layout, revision)
  const doubt = standing.stale
  // Not checked and nothing else: there is nothing to look at, only nothing known of this build.
  const onlyUnchecked = standing.waiting
  const rough = alignment.rough ?? null
  const pairs = alignment.pairs ?? []
  const by = alignmentText(alignment, tenth)
  const { basis, movedByHand } = basisOf(alignment)
  const fitted = basis === 'pairs' && alignment.rms !== undefined
  const tied = tiedPoints(alignment)
  const data: AlignmentData = {
    state: 'aligned',
    basis,
    ...(movedByHand ? { movedByHand: true } : {}),
    by,
    steps: alignment.steps,
    ...(pairs.length > 0 ? { pairs: pairs.length } : {}),
    ...(alignment.rms === undefined ? {} : { rms: tidy(alignment.rms) }),
    ...(alignment.fitRms === undefined ? {} : { fitRms: tidy(alignment.fitRms) }),
    ...(pairs.length > 0 ? { worst: tidy(Math.max(...pairs.map((pair) => pair.residual))) } : {}),
    ...(alignment.scaled ? { scaled: true } : {}),
    ...(rough ? { rough } : {}),
    ...(doubt ? { stale: doubt } : {}),
    ...(standing.unchecked ? { unchecked: true } : {}),
    tied,
    ...(alignment.confirmed && standing.note?.includes('confirmed by the user') ? { confirmed: true as const } : {})
  }
  // What is beside the point of how it is aligned, and still to be known: in brackets, after it.
  const aside = [...(onlyUnchecked ? [standing.failed ? doubt!.replace(/^it /, '') : `not checked against r${revision}`] : []), ...(standing.note ? [standing.note] : [])]
  const holds = doubt ? (onlyUnchecked ? (standing.failed ? `${scan.id}'s alignment ${doubt!.replace(/^it /, '')}: whether it still holds on that build is not known` : `${scan.id}'s alignment was not checked against r${revision}: whether it still holds on it is not known`) : `${scan.id}'s alignment may no longer hold: ${doubt}`) : null
  // What it rests on, first, when that is no fit: whoever reads a depth must know there is none behind where the scan stands.
  const rests = basis === 'floor' ? `${scan.id} is aligned by its floor only: where it is on that floor is ${movedByHand ? 'as it was put by hand' : 'as imported'}. ` : basis === 'hand' ? `${scan.id} was placed by hand: no fit says how well. ` : movedByHand ? `${scan.id} was moved by hand after it was fitted. ` : ''
  return {
    alignment,
    state: doubt ? (onlyUnchecked ? 'not checked' : 'in doubt') : rough ? 'rough' : 'aligned',
    reasons: [...(doubt ? [doubt] : []), ...(rough ? [rough] : [])],
    refused: null,
    data,
    line: `aligned ${rough ? 'roughly ' : ''}in ${layout} ${by}${rough ? ` (${rough})` : ''}${doubt && !onlyUnchecked ? ` but ${doubt}` : ''}${aside.length > 0 ? ` (${aside.join('; ')})` : ''}`,
    first: `${rests}${holds ? `${holds}. ` : ''}${rough ? `${scan.id} is only roughly aligned: ${rough}. ` : ''}`,
    ...(holds ? { note: holds } : {}),
    last: () => `${scan.id} is aligned ${by}${fitted && !movedByHand ? `: ${RMS_OF_CLICKS}` : ''}${standing.note ? ` (${standing.note})` : ''}.`
  }
}

/** How a scan is on the person's screen, as it is told in a line: `shown`, `shown at 60 %`, `hidden`, or that its mesh has not come to be drawn. */
export function shownText(view: { visible: boolean; opacity: number; loaded?: boolean }): string {
  if (!view.visible) return 'hidden'
  if (view.loaded === false) return 'not drawn yet'
  return view.opacity < 1 ? `shown at ${Math.round(view.opacity * 100)} %` : 'shown'
}

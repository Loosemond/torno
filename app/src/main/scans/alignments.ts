import { isDeepStrictEqual } from 'node:util'
import { reckoned } from '../../shared/align'
import { number } from '../../shared/format'
import type { Vec3 } from '../../shared/marks'
import { type AlignmentCheck, type Scan, type ScanAlignment, MAX_PAIRS, alignmentOf } from '../../shared/scans'
import type { Scene } from '../../shared/scene'
import { anchoredPoints } from './alignCheck'
import { sanitiseAlignment } from './file'

// What changes a scan's alignments, each as the scan it makes of the scan it is given: nothing here reads or
// writes a file, or keeps anything. `ScanStore` calls these inside the one change of an object's scans, and
// forgets there what was checked of the alignment before.

/** A scan's alignments in every layout but one. */
const others = (scan: Scan, layout: string): Array<[string, ScanAlignment]> => Object.entries(scan.alignments).filter(([name]) => name !== layout)

/**
 * The scan with where it is in a layout kept, or with null aligned to nothing there.
 *
 * What follows from the transform and the pairs is worked out here, never
 * taken: residuals, rms, whether the scan was scaled, why it is rough
 * (`sanitiseAlignment`). An alignment that is rough, or that changes the
 * scan's size, is kept only with the person's yes to that (`accepted`).
 * The alignment it takes the place of is kept with it, for one `undone`;
 * `before` and `sourceChanged` are never a caller's to say.
 */
export function aligned(scan: Scan, layout: string, alignment: ScanAlignment | null, accepted: { rough?: boolean; scaled?: boolean }): Scan {
  if (alignment === null) return { ...scan, alignments: Object.fromEntries(others(scan, layout)) }
  const given = Object(alignment).pairs
  if (Array.isArray(given) && given.length > MAX_PAIRS) throw new Error(`an alignment keeps ${MAX_PAIRS} pairs at most: this one has ${given.length}`)
  const candidate = sanitiseAlignment({ ...Object(alignment), before: undefined, sourceChanged: undefined, confirmed: undefined, fitRms: undefined })
  if (!candidate) throw new Error('that is not an alignment: its transform, its steps, its frame or its time is missing, or a number is not finite')
  const was = alignmentOf(scan, layout)
  const byHand = ['nudge', 'typed'].includes(candidate.steps[candidate.steps.length - 1])
  // How well its pairs were fitted: of this fit when it is one, else what main kept of the fit these very pairs came from. Never a caller's.
  const fitRms = candidate.steps[candidate.steps.length - 1] === 'pairs' ? candidate.rms : was && byHand && samePairs(was, candidate) ? was.fitRms : undefined
  const kept = reckoned({ ...candidate, ...(fitRms === undefined ? {} : { fitRms }) })
  // Moved by hand with the model's points where they were: what the person confirmed of those is still so.
  if (was?.confirmed && byHand && isDeepStrictEqual(anchoredPoints(was), anchoredPoints(kept))) kept.confirmed = structuredClone(was.confirmed)
  // Moved by hand with the pairs it had: it is still the alignment that was made before the scan was read again from a changed source, and still says so.
  if (was?.sourceChanged && byHand && samePairs(was, candidate)) kept.sourceChanged = true
  if (kept.scaled && accepted.scaled !== true) throw new Error(`this alignment changes the size of the scan (× ${number(kept.transform.s)}): it is kept only when that scale was chosen`)
  if (kept.rough !== undefined && accepted.rough !== true) throw new Error(`this alignment is rough (${kept.rough}): it is kept only once that is accepted`)
  kept.before = was ? withoutBefore(was) : null
  return { ...scan, alignments: Object.fromEntries([...others(scan, layout), [layout, kept]]) }
}

/**
 * The scan with the alignment it had in a layout before the last one was
 * kept, as it was: its frame, its time and what it was made of. One step
 * back: what is put back has nothing before it. Throws when there is
 * nothing to go back to.
 */
export function undone(scan: Scan, layout: string): Scan {
  const now = alignmentOf(scan, layout)
  if (!now) throw new Error(`${scan.id} is not aligned in ${layout}: there is nothing to undo`)
  if (now.before === undefined) throw new Error(`${scan.id} has no alignment in ${layout} before this one: there is nothing to undo`)
  return { ...scan, alignments: Object.fromEntries(now.before === null ? others(scan, layout) : [...others(scan, layout), [layout, structuredClone(now.before)]]) }
}

/**
 * The scan with an alignment the person looked at and says still holds, whatever put it in doubt: a scan read
 * again from a changed source, a build that moved the model or spread the layout otherwise. It is no longer said
 * to be in doubt for that: `holds` is the model as it now is (the build, how its parts are spread, how far each
 * point the alignment is tied to is from its part), and later builds are judged from there (`judgeAlignment`).
 * That it was confirmed is kept and said. Nothing of the alignment itself is changed.
 */
export function held(scan: Scan, layout: string, holds: { revision: number; frame: Record<string, Vec3>; held: Array<Vec3 | null> } | null, now: Date): Scan {
  const was = alignmentOf(scan, layout)
  if (!was) throw new Error(`${scan.id} is not aligned in ${String(layout)}`)
  // With nothing of the model to hold it against (null): only that the scan was read again is no longer a doubt.
  if (holds === null) {
    const { sourceChanged: _dropped, ...rest } = was
    return { ...scan, alignments: { ...scan.alignments, [layout]: rest } }
  }
  const kept = sanitiseAlignment({ ...was, frame: holds.frame, confirmed: { revision: holds.revision, at: now.toISOString(), held: holds.held }, sourceChanged: undefined })
  if (!kept) throw new Error('that is not how a model stands: its frame or its points are missing')
  if (was.before !== undefined) kept.before = was.before
  return { ...scan, alignments: { ...scan.alignments, [layout]: kept } }
}

/**
 * What is kept of the checks of a scan's alignments (`checks`, by layout) once a check of one layout said
 * something, or with null nothing: null when nothing is to change. A scan no longer aligned in that layout is
 * passed over, and so is an alignment that is not the one that was judged (`judged`: as it was when the check
 * was asked): made anew or confirmed since, it is another to judge, and has its own check.
 */
export function checked(scan: Scan, checks: Record<string, AlignmentCheck>, layout: string, check: AlignmentCheck | null, judged?: Pick<ScanAlignment, 'at' | 'confirmed'>): Record<string, AlignmentCheck> | null {
  const kept = { ...checks }
  if (check === null) {
    if (!Object.hasOwn(kept, layout)) return null
    delete kept[layout]
    return kept
  }
  if (!Object.hasOwn(scan.alignments, layout)) return null
  const now = scan.alignments[layout]
  if (judged && (now.at !== judged.at || now.confirmed?.at !== judged.confirmed?.at || !isDeepStrictEqual(now.confirmed?.held, judged.confirmed?.held))) return null
  Object.defineProperty(kept, layout, { value: structuredClone(check), enumerable: true, writable: true, configurable: true })
  return kept
}

/**
 * How far each part of a layout was spread for display on a build
 * (`Part.arranged`), zeros for a part that was not moved: what an alignment
 * made on that build records as its `frame`. Null when the build has no part
 * in that layout, or there is no build.
 */
export function frameOf(scene: Scene | undefined, layout: string): Record<string, Vec3> | null {
  const parts = scene?.parts.filter((part) => part.layout === layout) ?? []
  return parts.length > 0 ? Object.fromEntries(parts.map((part): [string, Vec3] => [part.name, part.arranged ? [...part.arranged] : [0, 0, 0]])) : null
}

/** Whether two alignments have the same pairs of points: the same scan ends and model ends, in order. */
function samePairs(a: ScanAlignment, b: ScanAlignment): boolean {
  const ends = (alignment: ScanAlignment): unknown => (alignment.pairs ?? []).map((pair) => [pair.scan, pair.model])
  return (a.pairs?.length ?? 0) > 0 && isDeepStrictEqual(ends(a), ends(b))
}

/** An alignment as it is kept for an undo: without what was before it. */
function withoutBefore(alignment: ScanAlignment): Omit<ScanAlignment, 'before'> {
  const { before: _dropped, ...rest } = structuredClone(alignment)
  return rest
}

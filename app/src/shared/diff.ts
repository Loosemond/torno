import { number } from './format'
import type { DigestPart } from './sanity'
import type { Part, Scene } from './scene'

/**
 * What changed between two builds of a model, worked out from what the kernel said of each part as it built it
 * (no query). Main (the `diff` tool, the digest after a build) and the window (the status line, the ghosts of the
 * parts that changed) say the same thing with the same exactness, from this file: a number that is not exact in
 * either build is told with `≈`.
 */

type Vec3 = [number, number, number]

const sizes = (v: readonly number[]): string => v.map(number).join(' × ')
const vector = (v: readonly number[]): string => `(${v.map(number).join(', ')})`

/** Said in `diff` when a number it compares is not exact in either build. */
export const DIFF_APPROXIMATE = 'A volume, size or min with exact false is approximate in at least one of the two builds (the kernel said so): call measure for a number to rely on.'
/** Said in `diff` when a part's face or edge count changed. */
export const DIFF_REFS = 'Face or edge counts changed: refs such as lid/F12 may name other faces or edges now; describe a ref again before relying on it.'

/** A number as data: in full, but for what arithmetic leaves past the ninth decimal, and never -0. */
export function clean<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 + 0 : value) as T
  if (Array.isArray(value)) return value.map(clean) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v)])) as T
  return value
}

const sizeOf = (p: Part): Vec3 => p.bbox.max.map((max, i) => max - p.bbox.min[i]) as Vec3
const minus = (a: readonly number[], b: readonly number[]): number[] => a.map((v, i) => v - b[i])
const same = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => clean(v) === clean(b[i]))
/** The same, or apart by no more than `slack` in any coordinate. */
const within = (a: readonly number[], b: readonly number[], slack: number): boolean => same(a, b) || a.every((v, i) => Math.abs(v - b[i]) <= slack)
const signed = (v: number): string => (clean(v) > 0 ? `+${number(v)}` : number(v))
/** A change as a part of what it was, in percent, to two significant digits; none of what was nothing. */
const percentOf = (change: number, before: number): number | undefined => (Math.abs(before) < 1e-9 ? undefined : Number(((change / before) * 100).toPrecision(2)))

/** One part in both builds: its numbers before and after, as data in full, and a line of what changed. */
export function partDiff(before: Part, after: Part): { data: Omit<DigestPart, 'layout' | 'text'> & { changed: boolean; line: string; min: object; arranged?: object }; approximate: boolean; refsMoved: boolean } {
  const volumeExact = before.volumeExact === true && after.volumeExact === true
  const boxExact = before.bboxExact === true && after.bboxExact === true
  const [sizeBefore, sizeAfter] = [sizeOf(before), sizeOf(after)]
  // A number that is not exact may differ in its last digits from one build to the next however untouched the part
  // is: it changed only by more than both builds' doubt of it (`volumeDoubt`, `bboxDoubt`). An exact one, by anything.
  const volumeSlack = volumeExact ? 0 : (before.volumeDoubt ?? 0) + (after.volumeDoubt ?? 0)
  const boxSlack = boxExact ? 0 : (before.bboxDoubt ?? 0) + (after.bboxDoubt ?? 0)
  const volumeChanged = clean(before.volume) !== clean(after.volume) && Math.abs(after.volume - before.volume) > volumeSlack
  // A size has two sides, each of them in doubt.
  const sizeChanged = !within(sizeBefore, sizeAfter, 2 * boxSlack)
  const minChanged = !within(before.bbox.min, after.bbox.min, boxSlack)
  const facesChanged = before.faceCount !== after.faceCount
  const edgesChanged = before.edgeCount !== after.edgeCount
  const solidsChanged = before.solids !== undefined && after.solids !== undefined && before.solids !== after.solids
  const change = after.volume - before.volume
  const percent = percentOf(change, before.volume)
  const about = (exact: boolean): string => (exact ? '' : '≈ ')
  const said: string[] = []
  if (volumeChanged) said.push(`volume ${about(volumeExact)}${number(before.volume)} → ${number(after.volume)} mm³ (${signed(change)}${percent === undefined ? '' : `, ${signed(percent)} %`})`)
  if (sizeChanged) said.push(`size ${about(boxExact)}${sizes(sizeBefore)} → ${sizes(sizeAfter)} mm`)
  if (minChanged) said.push(`min corner ${about(boxExact)}${vector(before.bbox.min)} → ${vector(after.bbox.min)}`)
  if (facesChanged) said.push(`faces ${before.faceCount} → ${after.faceCount}`)
  if (edgesChanged) said.push(`edges ${before.edgeCount} → ${after.edgeCount}`)
  if (solidsChanged) said.push(`solids ${before.solids} → ${after.solids}`)
  const changed = said.length > 0
  const arranged = before.arranged || after.arranged ? { arranged: { before: before.arranged ?? [0, 0, 0], after: after.arranged ?? [0, 0, 0] } } : {}
  const line = `${after.name}: ${changed ? said.join(', ') : 'unchanged'}`
  return {
    data: {
      name: after.name,
      changed,
      volume: { before: before.volume, after: after.volume, change, ...(percent === undefined ? {} : { percent }), exact: volumeExact },
      size: { before: sizeBefore, after: sizeAfter, change: minus(sizeAfter, sizeBefore), exact: boxExact } as DigestPart['size'],
      // The box's corner of least x, y and z, in the object frame of the layout: where the part is.
      min: { before: before.bbox.min, after: after.bbox.min, change: minus(after.bbox.min, before.bbox.min), exact: boxExact },
      faces: { before: before.faceCount, after: after.faceCount },
      edges: { before: before.edgeCount, after: after.edgeCount },
      ...(before.solids !== undefined || after.solids !== undefined ? { solids: { ...(before.solids !== undefined ? { before: before.solids } : {}), ...(after.solids !== undefined ? { after: after.solids } : {}) } } : {}),
      ...arranged,
      line
    },
    approximate: changed && (!volumeExact || !boxExact),
    refsMoved: facesChanged || edgesChanged
  }
}


const named = (parts: readonly Part[], name: string): Part | undefined => parts.find((p) => p.name === name)

/**
 * What changed between two scenes, layout by layout: the parts they both have (each with `partDiff`), those only
 * `to` has and those only `from` has. A layout only one of them has says so. `notes` are the warnings that go with
 * the numbers (not exact; refs that may name other faces now).
 */
export function sceneDiff(from: Scene, to: Scene) {
  let approximate = false
  let refsMoved = false
  const layouts = [...new Set([...to.layouts, ...from.layouts])].map((layout) => {
    const before = from.parts.filter((p) => p.layout === layout)
    const after = to.parts.filter((p) => p.layout === layout)
    const parts = after.flatMap((p) => {
      const was = named(before, p.name)
      if (!was) return []
      const told = partDiff(was, p)
      approximate ||= told.approximate
      refsMoved ||= told.refsMoved
      return [told.data]
    })
    const only = !from.layouts.includes(layout) ? { only: 'to' } : !to.layouts.includes(layout) ? { only: 'from' } : {}
    return {
      layout,
      ...only,
      added: after.filter((p) => !named(before, p.name)).map((p) => p.name),
      removed: before.filter((p) => !named(after, p.name)).map((p) => p.name),
      parts
    }
  })
  const notes = [...(approximate ? [DIFF_APPROXIMATE] : []), ...(refsMoved ? [DIFF_REFS] : [])]
  return { layouts, notes }
}

/** Whether a part is drawn other than it was: its mesh is another, or it stands elsewhere or turned (`loc`, which holds an arranged print layout's offset). */
export function partChanged(before: Part, after: Part): boolean {
  if (before.hash !== after.hash) return true
  return before.loc.t.some((v, i) => v !== after.loc.t[i]) || before.loc.q.some((v, i) => v !== after.loc.q[i])
}

/** What a build that landed did to the parts of one layout, against the build on show before it. */
export interface Landing {
  /** In the order of the build. */
  changed: string[]
  same: string[]
  added: string[]
  removed: string[]
  /** A line for each part that changed, came or went, in the words of `diff`: `tub: volume 6280 → 6410 mm³ (+130, +2.1 %)`. */
  lines: string[]
}

/** The parts of `layout` in the build that landed (`to`) held against the build before (`from`), by name. */
export function landing(from: Scene, to: Scene, layout: string): Landing {
  const before = from.parts.filter((p) => p.layout === layout)
  const after = to.parts.filter((p) => p.layout === layout)
  const out: Landing = { changed: [], same: [], added: [], removed: [], lines: [] }
  for (const part of after) {
    const was = named(before, part.name)
    if (!was) {
      out.added.push(part.name)
      out.lines.push(`${part.name}: new`)
    } else if (partChanged(was, part)) {
      out.changed.push(part.name)
      const told = partDiff(was, part).data
      out.lines.push(told.changed ? told.line : `${part.name}: drawn otherwise, no number moved`)
    } else out.same.push(part.name)
  }
  for (const part of before) {
    if (named(after, part.name)) continue
    out.removed.push(part.name)
    out.lines.push(`${part.name}: gone`)
  }
  return out
}

/** The most part names a line of the status holds before it counts instead. */
const NAMED = 3

/** `tub changed, lid same`: what the status line says of a landing; `no part changed` when none did. */
export function landingText(l: Landing): string {
  const some = (names: string[], word: string, most: number): string =>
    names.length <= most ? `${names.join(', ')} ${word}` : word === 'changed' ? `${names.length} parts changed` : `${names.length} ${word}`
  if (l.changed.length + l.added.length + l.removed.length === 0) return 'no part changed'
  return [
    l.changed.length > 0 ? some(l.changed, 'changed', NAMED) : '',
    l.added.length > 0 ? some(l.added, 'new', NAMED) : '',
    l.removed.length > 0 ? some(l.removed, 'gone', NAMED) : '',
    l.same.length > 0 ? some(l.same, 'same', 2) : ''
  ]
    .filter(Boolean)
    .join(', ')
}

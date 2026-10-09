import { number } from '../../shared/format'
import { expectedText, lastValue, measuredValue, notMeasuredText, offBy, onBuild, standingOf, valueText } from '../../shared/dimension'
import { type Anchor, type DimensionMark, type Mark, type ShapeMark, type StrokeMark, isUnchecked } from '../../shared/marks'

/** Marks the note of a mark the last build moved off its surface, or left without its part. */
const ANCHOR_SUFFIX = { ok: '', drifted: ' [moved since it was placed: check it]', orphaned: ' [its part is gone]' } as const

export { number }

/** `(12, 40.5, 20)` */
export function vector(v: readonly number[]): string {
  return `(${v.map(number).join(', ')})`
}

/** `40 × 30 × 5` */
export function sizes(v: readonly number[]): string {
  return v.map(number).join(' × ')
}

/**
 * A mark in one line, for the agent: its number, what kind it is, what it is
 * on and where, in millimetres in the object frame of its layout, and the
 * note. It says so when the mark is the agent's own, and when the last build
 * moved the surface it was on or dropped its part. `tag` is said before it,
 * in brackets: what the line is news of (`changed`). Given the `revision` of
 * the last build that worked, it says so when nothing has checked the mark
 * against that build: what it says of the ref is then of an older one. A
 * dimension gives its value only as that of the build of `revision`
 * (`dimension`): without one it is told as not measured.
 */
export function describeMark(mark: Mark, opts: { tag?: string; revision?: number } = {}): string {
  const tags = [mark.author === 'agent' ? 'yours' : '', opts.tag ?? ''].filter(Boolean).join(', ')
  const note = mark.note.replace(/\s+/g, ' ').trim()
  const unchecked = isUnchecked(mark, opts.revision) ? ` [not checked against r${opts.revision}]` : ''
  // A dimension that lost its part says so in place of its value, not after its note.
  const suffix = mark.kind === 'dimension' && mark.anchorState === 'orphaned' ? '' : ANCHOR_SUFFIX[mark.anchorState]
  return `${tags ? `(${tags}) ` : ''}${mark.id} ${what(mark, opts.revision)}${note ? `: "${note}"` : ''}${suffix}${unchecked}${asMeasured(mark, opts.revision)}`
}

/**
 * Said after a resolved dimension whose value is not of the build of `revision`: it is no longer measured, and what
 * it holds is of the build it was last measured on.
 */
function asMeasured(mark: Mark, revision: number | undefined): string {
  if (mark.kind !== 'dimension' || mark.status !== 'resolved' || lastValue(mark) === undefined) return ''
  if (revision !== undefined && mark.measuredRevision === revision) return ''
  return ` [as measured on ${onBuild(mark.measuredRevision)}]`
}

/**
 * A mark as data for the agent, beside its line. A dimension holds `value`,
 * `how`, `points` and `verdict` only when they are of the build of `revision`
 * (`measuredValue`): data is read before prose, and a value there would be
 * taken for the part's.
 *
 * - What it held on another build of this run is `wasValue`, of
 *   `wasRevision`, as its line says. What its file holds from a run before
 *   is of no build that can be named, and is not given.
 * - A resolved one is no longer measured: what it held when it was last
 *   measured is `resolvedValue` and `resolvedVerdict`, of `resolvedOnRevision`
 *   when that is known, whichever build is the last. Never `value`.
 */
export function markData(mark: Mark, revision: number | undefined): object {
  if (mark.kind !== 'dimension') return mark
  if (mark.status !== 'resolved' && measuredValue(mark, revision) !== undefined) return mark
  const { value: _value, how: _how, points: _points, verdict: _verdict, ...rest } = mark
  const last = lastValue(mark)
  const on = (key: string): object => (mark.measuredRevision === undefined ? {} : { [key]: mark.measuredRevision })
  if (mark.status === 'resolved') {
    // Which build it was measured on is said once, as the build its resolved value is of.
    const { measuredRevision: _on, ...settled } = rest
    return last === undefined ? settled : { ...settled, resolvedValue: last, ...(mark.verdict ? { resolvedVerdict: mark.verdict } : {}), ...on('resolvedOnRevision') }
  }
  if (standingOf(mark, revision) !== 'unmeasured' || last === undefined || mark.measuredRevision === undefined) return rest
  return { ...rest, wasValue: last, ...on('wasRevision') }
}

/**
 * `distance 6 mm between planes, base/F5 to base/F0`: the kind of measurement,
 * the value with how it was taken, and its ends; then what was expected and
 * the verdict, with how far off and which way when it fails. The value is
 * that of the build of `revision`, and is given as nothing else:
 *
 * - measured on another build, it says `not measured on r12 (was 6 mm on
 *   r11)`, and no verdict; on none this run, `not measured yet`;
 * - one the kernel could not measure on that build says `not measurable`,
 *   with the kernel's reason;
 * - one that lost the part of an end says only that.
 *
 * One whose end the build moved is measured between what its ends name now:
 * its line is as any other's, and the mark says after it that it moved.
 */
function dimension(mark: DimensionMark, revision: number | undefined): string {
  if (mark.anchorState === 'orphaned') return `${mark.measure}: not measurable, ${ANCHOR_SUFFIX.orphaned.trim()}`
  const standing = standingOf(mark, revision)
  const end = (anchor: Anchor): string => anchor.ref ?? vector(anchor.point)
  const ends = mark.measure === 'thickness' ? `${end(mark.a)}${mark.a.ref ? ` at ${vector(mark.a.point)}` : ''}` : mark.b ? `${end(mark.a)} to ${end(mark.b)}` : end(mark.a)
  const expected = mark.expected === undefined ? '' : ` (expected ${expectedText(mark)}`
  const shown = (value: number): string => valueText(mark.measure, value).replace(/^(⌀|R) /, '')
  if (standing === 'unmeasured') {
    const last = lastValue(mark)
    // What it held on a build that can be named. What its file holds from another run is of none: it is not measured yet.
    const was = last === undefined || mark.measuredRevision === undefined ? '' : ` (was ${shown(last)} on ${onBuild(mark.measuredRevision)})`
    return `${mark.measure}: ${notMeasuredText(mark, revision)}${was}, ${ends}${expected && `${expected})`}`
  }
  if (mark.value === undefined) return `${mark.measure}: not measurable${mark.refused ? ` (${mark.refused})` : ''}, ${ends}${expected && `${expected})`}`
  // Of a radius or a diameter the way is what the thing is, which its ref says already: said only when it says which radius.
  const round = mark.measure === 'radius' || mark.measure === 'diameter'
  const how = !mark.how ? '' : round ? (/^(cylinder|circle|sphere)$/.test(mark.how) ? '' : ` (${mark.how})`) : ` ${mark.how}`
  const verdict = mark.expected === undefined ? '' : `${expected}: ${mark.verdict === 'pass' ? 'pass' : `FAIL, ${offBy(mark.value, mark.expected)}`})`
  return `${mark.measure} ${shown(mark.value)}${how}, ${ends}${verdict}`
}

function what(mark: Mark, revision: number | undefined): string {
  const settled = mark.anchorState === 'ok'
  switch (mark.kind) {
    case 'pin':
      return `pin ${on(mark.anchor, settled)}at ${vector(mark.anchor.point)}`
    case 'pick':
      // A pick is of the thing itself; where it was clicked says nothing more, unless nothing names the thing.
      if (!mark.anchor.ref) return `pick at ${vector(mark.anchor.point)}`
      return settled ? `pick of ${named(mark.anchor)}` : `pick placed on ${mark.anchor.ref}`
    case 'arrow': {
      const by = mark.to.map((c, i) => c - mark.from.point[i])
      const from = !mark.from.ref ? 'from ' : settled ? `from ${named(mark.from)} at ` : `placed on ${mark.from.ref}, from `
      return `arrow ${from}${vector(mark.from.point)} by ${vector(by)}, ${number(Math.hypot(...by))} mm`
    }
    case 'stroke':
      return stroke(mark)
    case 'shape':
      return shape(mark)
    case 'dimension':
      return dimension(mark, revision)
  }
}

/** `lid/F12 (plane, normal +Z, z = 20, 1180 mm²)`, or the ref alone when the kernel has said nothing of it. */
function named(anchor: Anchor): string {
  return anchor.descriptor ? `${anchor.ref} (${anchor.descriptor})` : `${anchor.ref}`
}

/**
 * What a mark is on, before where it is. Of a mark the last build moved off
 * its surface or left without its part, only what it was placed on: that ref
 * may name other geometry now, and what the kernel says of it is not said.
 */
function on(anchor: Anchor, settled: boolean): string {
  if (!anchor.ref) return ''
  if (!settled) return `placed on ${anchor.ref} `
  if (anchor.edge === undefined) return `on ${named(anchor)} `
  // On an edge: which, the two faces that meet there, and what the edge is.
  const between = anchor.between ? ` between ${anchor.between[0]} and ${anchor.between[1]}` : ''
  return `on the edge ${anchor.edge}${between}${anchor.descriptor ? ` (${anchor.descriptor})` : ''} `
}

function stroke(mark: StrokeMark): string {
  if (mark.space === 'plane' && mark.plane) {
    const points = mark.points2d ?? []
    return `stroke on plane ${mark.plane.label}, ${count(points.length)}, ${sizes(extent(points, 2))} mm`
  }
  const points = mark.points ?? []
  return `stroke ${on(mark.anchor, mark.anchorState === 'ok')}from ${vector(mark.anchor.point)}, ${count(points.length)}, ${sizes(extent(points, 3))} mm`
}

function shape(mark: ShapeMark): string {
  const [x, y, z] = mark.size
  const size =
    mark.shape === 'box'
      ? `box ${sizes([x, y, z])} mm`
      : mark.shape === 'cylinder'
        ? `cylinder diameter ${number(x)}, height ${number(z)} mm`
        : mark.shape === 'sphere'
          ? `sphere diameter ${number(x)} mm`
          : `plane ${sizes([x, y])} mm`
  const angles = eulerDegrees(mark.rotation)
  const turned = angles.every((a) => Math.abs(a) < 1e-4) ? '' : `, rotated ${vector(angles)}°`
  // Its position is where its middle is, not a corner or its base.
  return `${size} centred at ${vector(mark.position)}${turned}, intent ${mark.intent}`
}

/**
 * A rotation as the angles the window shows for it: degrees about the shape's
 * own X, then Y, then Z (three.js's Euler order 'XYZ', as `eulerOf` in
 * src/renderer/tools/shapeTool.ts).
 */
export function eulerDegrees([qx, qy, qz, qw]: readonly number[]): [number, number, number] {
  const length = Math.hypot(qx, qy, qz, qw) || 1
  const [x, y, z, w] = [qx / length, qy / length, qz / length, qw / length]
  // The entries of the rotation's matrix that the angles are read from.
  const m11 = 1 - 2 * (y * y + z * z)
  const m12 = 2 * (x * y - z * w)
  const m13 = 2 * (x * z + y * w)
  const m22 = 1 - 2 * (x * x + z * z)
  const m23 = 2 * (y * z - x * w)
  const m32 = 2 * (y * z + x * w)
  const m33 = 1 - 2 * (x * x + y * y)
  const about = Math.asin(Math.min(Math.max(m13, -1), 1))
  // Turned a quarter about Y, turning about X and about Z are one: all of it is said of X.
  const [first, last] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0]
  const degrees = (radians: number): number => (radians * 180) / Math.PI + 0
  return [degrees(first), degrees(about), degrees(last)]
}

function count(points: number): string {
  return `${points} point${points === 1 ? '' : 's'}`
}

/** How far the points reach along each of their axes. */
function extent(points: ReadonlyArray<readonly number[]>, axes: number): number[] {
  return Array.from({ length: axes }, (_, axis) => {
    if (points.length === 0) return 0
    const along = points.map((p) => p[axis])
    return Math.max(...along) - Math.min(...along)
  })
}


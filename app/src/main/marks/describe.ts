import { number } from '../../shared/format'
import { expectedText, measuredValue, offBy, valueText } from '../../shared/dimension'
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
 * against that build: what it says of the ref is then of an older one; and
 * of a dimension, when its value was measured on another.
 */
export function describeMark(mark: Mark, opts: { tag?: string; revision?: number } = {}): string {
  const tags = [mark.author === 'agent' ? 'yours' : '', opts.tag ?? ''].filter(Boolean).join(', ')
  const note = mark.note.replace(/\s+/g, ' ').trim()
  const unchecked = isUnchecked(mark, opts.revision) ? ` [not checked against r${opts.revision}]` : ''
  // A dimension that lost an end says so in place of its value, not after its note.
  const suffix = mark.kind === 'dimension' && mark.anchorState !== 'ok' ? '' : ANCHOR_SUFFIX[mark.anchorState]
  return `${tags ? `(${tags}) ` : ''}${mark.id} ${what(mark)}${note ? `: "${note}"` : ''}${suffix}${unchecked}${measuredOn(mark, opts.revision)}`
}

/**
 * Said after a dimension whose value is of another build than the last: the
 * value is exact, of the geometry of that build.
 */
function measuredOn(mark: Mark, revision: number | undefined): string {
  if (mark.kind !== 'dimension' || mark.status === 'resolved' || revision === undefined || revision <= 0) return ''
  if (measuredValue(mark) === undefined || mark.measuredRevision === revision) return ''
  return ` [measured on ${mark.measuredRevision === undefined ? 'an earlier build' : `r${mark.measuredRevision}`}, not on r${revision}]`
}

/**
 * `distance 6 mm between planes, base/F5 to base/F0`: the kind of measurement,
 * the value with how it was taken, and its ends; then what was expected and
 * the verdict, with how far off and which way when it fails. Without a value
 * it says `not measurable` in its place, and when an end was moved or lost
 * its part nothing of the ends: only that.
 */
function dimension(mark: DimensionMark): string {
  const value = measuredValue(mark)
  if (mark.anchorState !== 'ok') return `${mark.measure}: not measurable, ${ANCHOR_SUFFIX[mark.anchorState].trim()}`
  const end = (anchor: Anchor): string => anchor.ref ?? vector(anchor.point)
  const ends = mark.measure === 'thickness' ? `${end(mark.a)}${mark.a.ref ? ` at ${vector(mark.a.point)}` : ''}` : mark.b ? `${end(mark.a)} to ${end(mark.b)}` : end(mark.a)
  const expected = mark.expected === undefined ? '' : ` (expected ${expectedText(mark)}`
  if (value === undefined) return `${mark.measure}: not measurable, ${ends}${expected && `${expected})`}`
  // Of a radius or a diameter the way is what the thing is, which its ref says already: said only when it says which radius.
  const round = mark.measure === 'radius' || mark.measure === 'diameter'
  const how = !mark.how ? '' : round ? (/^(cylinder|circle|sphere)$/.test(mark.how) ? '' : ` (${mark.how})`) : ` ${mark.how}`
  const verdict = mark.expected === undefined ? '' : `${expected}: ${mark.verdict === 'pass' ? 'pass' : `FAIL, ${offBy(value, mark.expected)}`})`
  return `${mark.measure} ${valueText(mark.measure, value).replace(/^(⌀|R) /, '')}${how}, ${ends}${verdict}`
}

function what(mark: Mark): string {
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
      return dimension(mark)
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


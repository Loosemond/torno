import type { Anchor, Mark, ShapeMark, StrokeMark } from '../../shared/marks'

/** Marks the note of a mark the last build moved off its surface, or left without its part. */
const ANCHOR_SUFFIX = { ok: '', drifted: ' [moved since it was placed: check it]', orphaned: ' [its part is gone]' } as const

/** A length or a coordinate smaller than this is what modelling leaves where it means nothing. */
const NOISE = 1e-6

/**
 * A number with at most four significant digits and no trailing zeros, as the
 * kernel writes them in descriptors (`number` in kernel/src/torno_kernel/describe.py).
 * Millimetres are meant: a magnitude under a millionth is written `0`.
 */
export function number(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (Math.abs(value) < NOISE) return '0'
  const decimals = 3 - Math.floor(Math.log10(Math.abs(value)))
  if (decimals <= 0) {
    const step = 10 ** -decimals
    return String(Math.round(value / step) * step)
  }
  const text = value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

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
 * moved the surface it was on or dropped its part.
 */
export function describeMark(mark: Mark): string {
  const yours = mark.author === 'agent' ? '(yours) ' : ''
  const note = mark.note.replace(/\s+/g, ' ').trim()
  return `${yours}${mark.id} ${what(mark)}${note ? `: "${note}"` : ''}${ANCHOR_SUFFIX[mark.anchorState]}`
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
  return settled ? `on ${named(anchor)} ` : `placed on ${anchor.ref} `
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
  const [qx, qy, qz, qw] = mark.rotation
  const turned = Math.abs(qx) < NOISE && Math.abs(qy) < NOISE && Math.abs(qz) < NOISE ? '' : `, rotation quaternion xyzw ${vector([qx, qy, qz, qw])}`
  return `${size} at ${vector(mark.position)}${turned}, intent ${mark.intent}`
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


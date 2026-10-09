import type { Described } from '../../shared/geometry'
import { type Anchor, type Mark, type NewMark, type Quat, markAnchors } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { Camera, HighlightResult } from '../../shared/view'
import { describeMark, number, vector } from '../marks/describe'
import { MAX_NOTE } from '../marks/file'
import { EDGE_TOLERANCE_MM, answered, judge, judgePin, tolerance } from '../marks/reanchor'
import {
  type AddMarkArgs,
  type HighlightArgs,
  type ResolveMarkArgs,
  type ToolDeps,
  type ToolResult,
  FOV,
  INTENTS,
  MARK_ID,
  SHAPES,
  behind,
  built,
  failure,
  layoutFor,
  marksOf,
  messageOf,
  noMark,
  notOpen,
  onScreen,
  tidy
} from './tools'

// The tools that work with marks and with what a ref names: `highlight`,
// `add_mark` and `resolve_mark`, and what they need to tie a mark to the
// geometry. What every tool shares (the object, its build, how an answer is
// written) is in ./tools, which registers these beside its own.

type Vec3 = [number, number, number]

export interface CheckedRef {
  part: Part
  target: 'part' | 'face' | 'edge'
}

/**
 * What a ref names in a layout of a build, or why it names nothing there, in
 * words that say what there is: the parts, or how many faces or edges the part has.
 */
export function checkRef(scene: Scene, layout: string, ref: string): CheckedRef | string {
  const parts = scene.parts.filter((p) => p.layout === layout)
  const whole = parts.find((p) => p.name === ref)
  if (whole) return { part: whole, target: 'part' }
  const sub = /^(.*)\/([FE])(\d+)$/.exec(ref)
  const part = sub && parts.find((p) => p.name === sub[1])
  if (!sub || !part) {
    const name = sub ? sub[1] : ref
    const form = sub || !ref.includes('/') ? '' : '; a ref is a part, part/F<n> or part/E<n>'
    return `no part '${name}' in layout ${layout} (parts: ${parts.map((p) => p.name).join(', ') || 'none'})${form}`
  }
  const [letter, plural, count] = sub[2] === 'F' ? ['F', 'faces', part.faceCount] : ['E', 'edges', part.edgeCount]
  if (Number(sub[3]) >= count) return `${part.name} has ${count} ${plural}${count > 0 ? `, ${letter}0 to ${letter}${count - 1}` : ''}: there is no ${letter}${sub[3]}`
  return { part, target: sub[2] === 'F' ? 'face' : 'edge' }
}

export async function highlightTool(deps: ToolDeps, objectId: string, args: HighlightArgs): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout

  const refs: string[] = []
  const wrong: string[] = []
  let marks: Mark[] | undefined
  for (const ref of args.refs) {
    let named = ref
    if (MARK_ID.test(ref)) {
      if (!marks) {
        const read = await marksOf(deps, objectId)
        if ('content' in read) return read
        marks = read
      }
      const mark = marks.find((m) => m.id === ref)
      const on = mark && markAnchors(mark)[0]?.ref
      if (!mark) wrong.push(`no mark ${ref} (marks: ${marks.map((m) => m.id).join(', ') || 'none'})`)
      else if (mark.layout !== layout) wrong.push(`${ref} is in layout ${mark.layout}, not ${layout}`)
      else if (!on) wrong.push(`${ref} is not on a part, a face or an edge`)
      // Its ref is where it was placed, which may name other geometry now: that is not pointed at as the mark.
      else if (mark.anchorState === 'drifted') wrong.push(`${ref} was placed on ${on}, which has moved since: the ref may name something else now`)
      else if (mark.anchorState === 'orphaned') wrong.push(`the part ${ref} was placed on is gone`)
      if (!mark || mark.layout !== layout || !on || mark.anchorState !== 'ok') continue
      named = on
    }
    const checked = checkRef(found.scene, layout, named)
    if (typeof checked === 'string') wrong.push(named === ref ? checked : `${ref} is on ${named}, but ${checked}`)
    else if (!refs.includes(named)) refs.push(named)
  }
  // All or nothing: a question about three faces is not asked of two.
  if (wrong.length > 0) return failure(`nothing was highlighted: ${wrong.join('; ')}`)

  const note = args.note?.trim().slice(0, MAX_NOTE)
  let done: HighlightResult
  try {
    done = await deps.highlight(objectId, layout, refs, note || undefined)
  } catch (e) {
    return failure(messageOf(e))
  }
  if (done.objectId !== objectId) return failure(`${notOpen(found.obj, done.objectId)}. Ask the user to open it.`)
  const newer = done.revision !== found.revision ? ` The window shows r${done.revision}, not r${found.revision}: check the refs with describe.` : ''
  return {
    content: [
      {
        type: 'text',
        text: `highlighted ${done.refs.join(', ')} in layout ${done.layout} for the user${note ? `, with the note "${note}"` : ''}, until they click in the viewport or 60 s pass.${newer}`
      }
    ]
  }
}

/**
 * Where a mark of the agent's is tied to the geometry, as a re-anchored one
 * would be: the ref, the point, the normal there and what the kernel says of
 * it. Given a ref alone, the middle of that edge, or the point of the surface
 * nearest the centre of that face or part; given a point alone, the part
 * whose surface the point is on, or nothing but the point when it is on none
 * (a failure when the kernel could not say of some part, and it is on no other).
 * A `pick` keeps the ref it was given and is refused when its point is not on
 * what that names; anything else is tied to the face under its point. `said`
 * is what the agent should know of how that went, in the words of the `kind`
 * of mark it is for.
 */
async function anchorFor(
  deps: ToolDeps,
  objectId: string,
  scene: Scene,
  layout: string,
  ref: string | undefined,
  point: Vec3 | undefined,
  kind: 'pin' | 'pick' | 'arrow' | 'shape'
): Promise<{ anchor: Anchor; target?: CheckedRef['target']; said?: string } | ToolResult> {
  const parts = scene.parts.filter((p) => p.layout === layout)
  const pick = kind === 'pick'
  // A pin is on an edge when its point is on one (`judgePin`); anything else is on the face there.
  const pin = kind === 'pin'
  try {
    if (ref === undefined) {
      if (!point) return failure('give a ref or a point')
      const found = parts.length > 0 ? await deps.nearest(objectId, layout, parts.map((p) => ({ part: p.name, point }))) : []
      let best: Anchor | undefined
      let least = Infinity
      found.forEach((one, i) => {
        if (!answered(one) || one.distance >= least) return
        const judged = (pin ? judgePin : judge)({ point, part: one.part }, one, tolerance(parts[i].bbox))
        if (judged.state !== 'ok') return
        least = one.distance
        best = judged.anchor
      })
      if (best) return { anchor: best }
      // A part the kernel could say nothing of may be the one the point is on: it is not said to be on none.
      const failed = found.find((one) => one.found && one.error !== undefined)
      if (failed?.found && failed.error !== undefined) {
        return failure(`the kernel could not say whether ${vector(point)} is on ${failed.part}: ${failed.error}. No mark was placed: try again, or give a ref.`)
      }
      return { anchor: { point }, said: 'The point is on no part of this layout, so the mark is tied to none.' }
    }

    const checked = checkRef(scene, layout, ref)
    if (typeof checked === 'string') return failure(checked)
    const { part, target } = checked
    const described = await deps.describe(objectId, layout, ref)
    // A centre the kernel measured carries the noise of measuring: -3.5e-15 is 0.
    const base: Anchor = { point: point ?? tidy(centreOf(described, part)), part: part.name, ref, descriptor: described.descriptor }
    if (described.kind === 'face' && described.normal) base.normal = described.normal
    // The mark is checked against the build the moment it is kept (`followMarks`): what is kept here is
    // what that check would make of it, so that the answer given now still holds afterwards.
    const onEdge = (pick || pin) && target === 'edge'
    // The middle of an edge is on the edge: for a pick there is nothing to ask. A pin also says which faces meet there.
    if (onEdge && !point && pick) return { anchor: base, target }
    const [nearBase] = await deps.nearest(objectId, layout, [{ part: part.name, point: base.point, ...(onEdge ? { edge: ref } : {}) }])
    if (nearBase?.found && nearBase.error !== undefined) return failure(`the kernel could not say where ${vector(base.point)} is on ${part.name}: ${nearBase.error}`)
    if (!answered(nearBase)) return { anchor: base, target }
    let near = nearBase
    if (onEdge) {
      // Off its edge, the mark would be said to have drifted at once. An edge has no one normal.
      if (near.edgeFound !== true) return failure(`the kernel did not say how far the point ${vector(base.point)} is from ${ref}: leave the point out to use the middle of the edge`)
      if (near.edgeDistance > EDGE_TOLERANCE_MM) return failure(`the point ${vector(base.point)} is ${number(near.edgeDistance)} mm from ${ref}: give a point on the edge, or leave the point out to use its middle`)
      return { anchor: pin ? judgePin({ ...base, edge: ref }, near, Infinity).anchor : base, target }
    }
    if (point && near.distance > tolerance(part.bbox)) {
      return failure(`the point ${vector(point)} is ${number(near.distance)} mm from the surface of ${part.name}: give a point on it, or leave the point out to use the centre of ${ref}`)
    }
    // The centre of a face may not be on it (a cylinder's is on its axis, a ring's in its hole), and that
    // of a part is inside it: without a point, the mark goes to the point of the surface nearest to it.
    const at = point ?? tidy(near.point)
    if (!point && at.some((c, i) => c !== near.point[i])) {
      // The point kept is the rounded one, and that is where the check will ask: beside a curved edge it may
      // be under another face than the one it was rounded from. What is kept and said is what the kernel says of it.
      const [there] = await deps.nearest(objectId, layout, [{ part: part.name, point: at }])
      if (answered(there)) near = there
    }
    if (pin && near.support === 'edge') {
      // The point is on an edge, whatever was named to find it: the check would find the pin on that edge.
      const onIt = judgePin({ point: at, part: part.name }, near, tolerance(part.bbox)).anchor
      if (onIt.edge !== undefined) return { anchor: onIt, target, said: `That point is on the edge ${onIt.edge}: the pin is placed on the edge.` }
    }
    const elsewhere = target === 'face' && near.ref !== ref
    if (pick) {
      // A pick is of the thing named. Of a face it follows the face under its point, so it must be on that face.
      if (elsewhere) {
        return failure(
          point
            ? `the point ${vector(point)} is on ${near.ref}, not ${ref}: give a point on ${ref}`
            : `the centre of ${ref} is not on it (a face with a hole, a ring or a short cylinder): give a point on ${ref}`
        )
      }
      const anchor: Anchor = { ...base, point: at }
      if (near.normal) anchor.normal = near.normal
      return { anchor, target }
    }
    // A pin, an arrow or a shape is on the face that is under its point, whatever was named to find the point.
    if (near.ref === ref) {
      const anchor: Anchor = { ...base, point: at }
      if (near.normal) anchor.normal = near.normal
      return { anchor, target }
    }
    const { anchor } = judge({ point: at, part: part.name }, near, Infinity)
    const placed = `the mark is placed on ${near.ref}, the face under that point`
    const [is, does] = kind === 'arrow' ? ['An arrow starts on a face', 'it starts on'] : kind === 'shape' ? ['A shape is tied to a face', 'it is tied to'] : ['A pin is on a face', 'it is placed on']
    const said =
      target === 'part'
        ? undefined
        : target === 'edge'
          ? `${is}: ${does} ${near.ref}, the face under ${point ? 'that point' : `the middle of ${ref}`}. Use a pick to mark the edge itself.`
          : point
            ? `The point is on ${near.ref}, not ${ref}: ${placed}.`
            : `The centre of ${ref} is not on it: ${placed}. Give a point on ${ref} to put it there.`
    return { anchor, target, ...(said ? { said } : {}) }
  } catch (e) {
    return failure(messageOf(e))
  }
}

function centreOf(described: Described, part: Part): Vec3 {
  if (described.kind !== 'part') return described.center
  const { min, max } = described.bbox ?? part.bbox
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

/**
 * A view of a mark the agent placed, for "go to its view" in the window: at
 * the mark from the side its surface faces, far enough back to see the parts.
 */
function markCamera(scene: Scene, layout: string, at: Vec3, normal: Vec3 | undefined): Camera {
  const parts = scene.parts.filter((p) => p.layout === layout)
  let diagonal = 0
  if (parts.length > 0) {
    const min = [0, 1, 2].map((i) => Math.min(...parts.map((p) => p.bbox.min[i])))
    const max = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p.bbox.max[i])))
    diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  }
  const distance = Math.max(50, 1.7 * diagonal)
  // The usual three-quarter view, from the side of each axis that the surface faces.
  const from = [1, -1, 0.8].map((c, i) => (normal && Math.abs(normal[i]) > 0.3 ? Math.abs(c) * Math.sign(normal[i]) : c))
  const length = Math.hypot(from[0], from[1], from[2])
  const position = at.map((c, i) => c + (from[i] / length) * distance) as Vec3
  return { position, target: at, up: [0, 0, 1], ortho: false, fov: FOV, zoom: 1 }
}

export async function addMarkTool(deps: ToolDeps, objectId: string, args: AddMarkArgs): Promise<ToolResult> {
  const found = built(deps, objectId)
  if ('content' in found) return found
  const { scene, revision } = found
  const layout = layoutFor(deps, objectId, scene, args.layout)
  if (typeof layout !== 'string') return layout
  const base = { author: 'agent', note: args.note.slice(0, MAX_NOTE), layout, revision } as const

  let mark: NewMark
  let said: string | undefined
  if (args.kind === 'shape') {
    const missing = (['shape', 'size', 'position', 'intent'] as const).filter((key) => args[key] === undefined)
    if (missing.length > 0) return failure(`a shape needs ${missing.join(', ')}: shape is one of ${SHAPES.join(', ')}; intent one of ${INTENTS.join(', ')}; size and position are [x, y, z] in mm`)
    const [x, y, z] = args.size!
    const flat = args.shape === 'plane'
    if (x <= 0 || (args.shape !== 'cylinder' && args.shape !== 'sphere' && y <= 0) || (!flat && args.shape !== 'sphere' && z <= 0)) return failure(`the size of a ${args.shape} must be positive: ${vector(args.size!)}`)
    const size: Vec3 = args.shape === 'cylinder' ? [x, x, z] : args.shape === 'sphere' ? [x, x, x] : flat ? [x, y, 0] : [x, y, z]
    const rotation = args.rotation ?? [0, 0, 0, 1]
    const length = Math.hypot(...rotation)
    if (length < 1e-9) return failure('rotation is a quaternion [x, y, z, w]: it cannot be all zeros')
    let anchor: Anchor | undefined
    if (args.ref !== undefined) {
      const tied = await anchorFor(deps, objectId, scene, layout, args.ref, args.point, 'shape')
      if ('content' in tied) return tied
      anchor = tied.anchor
      said = tied.said
    }
    mark = {
      ...base,
      kind: 'shape',
      shape: args.shape!,
      intent: args.intent!,
      position: args.position!,
      rotation: rotation.map((c) => c / length) as Quat,
      size,
      camera: markCamera(scene, layout, args.position!, undefined),
      ...(anchor ? { anchor } : {})
    }
  } else {
    if (args.kind === 'pick' && args.ref === undefined) return failure('a pick needs a ref: the part, face or edge it is of. For a point, place a pin')
    if (args.ref === undefined && args.point === undefined) return failure(`${args.kind === 'arrow' ? 'an arrow' : 'a pin'} needs a ref or a point${args.kind === 'arrow' ? ' to start from' : ''}`)
    if (args.kind === 'arrow' && args.to === undefined && args.by === undefined) return failure('an arrow needs to (where it ends) or by (the vector from its start), in mm')
    if (args.kind === 'arrow' && args.to !== undefined && args.by !== undefined) return failure('an arrow takes to (where it ends) or by (the vector from its start), not both')
    const tied = await anchorFor(deps, objectId, scene, layout, args.ref, args.point, args.kind)
    if ('content' in tied) return tied
    const { anchor } = tied
    said = tied.said
    const camera = markCamera(scene, layout, anchor.point, anchor.normal)
    if (args.kind === 'pin') mark = { ...base, kind: 'pin', anchor, camera }
    else if (args.kind === 'pick') mark = { ...base, kind: 'pick', target: tied.target ?? 'part', anchor, camera }
    else {
      const to = args.to ?? (anchor.point.map((c, i) => c + args.by![i]) as Vec3)
      if (to.every((c, i) => Math.abs(c - anchor.point[i]) < 1e-6)) return failure(`the arrow would end where it starts, at ${vector(anchor.point)}`)
      mark = { ...base, kind: 'arrow', from: anchor, to, camera }
    }
  }

  let added: Mark
  try {
    added = await deps.addMark(objectId, mark)
  } catch (e) {
    return failure(messageOf(e))
  }
  // Placed on the last build that worked, which the agent may take for the model as it has just edited it.
  const why = behind(deps, objectId)
  const stale = why ? `, stale: ${why}, so the mark was placed on the parts of r${revision}; it is checked against the next build that works` : ''
  return { content: [{ type: 'text', text: `placed in layout ${layout}: ${describeMark(added)}${said ? `\n${said}` : ''}\nrevision r${revision}${stale}` }] }
}

export async function resolveMarkTool(deps: ToolDeps, objectId: string, args: ResolveMarkArgs): Promise<ToolResult> {
  if (!deps.object(objectId)) return failure(`unknown object: ${objectId}`)
  if (!MARK_ID.test(args.id)) {
    const marks = await marksOf(deps, objectId)
    return 'content' in marks ? marks : noMark(args.id, marks)
  }
  const note = args.note?.trim().slice(0, MAX_NOTE)
  try {
    const mark = await deps.updateMark(objectId, args.id, { status: 'resolved', ...(note ? { resolvedNote: note } : {}) })
    return { content: [{ type: 'text', text: `resolved: ${describeMark(mark)}${mark.resolvedNote ? `\nnote: ${mark.resolvedNote}` : ''}` }] }
  } catch (e) {
    return failure(messageOf(e))
  }
}

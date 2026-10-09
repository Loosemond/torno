import type { Part, Scene } from '../../shared/scene'

// A `print` layout whose parts overlap as the model places them is set side by
// side along X before anything is drawn (`Part.arranged`, kernel/src/torno_kernel/arrange.py),
// and the kernel answers of the parts where they are shown. What is of one
// part is the same wherever the part is put, and so is an angle: parts are
// moved, never turned. What lies between two parts (how far apart, what they
// share) is then of torno's arrangement, and is told to no one as the
// model's: not to the agent, not as a dimension of the person's.

type Vec3 = [number, number, number]

const partOf = (scene: Scene, layout: string, name: string | undefined): Part | undefined => scene.parts.find((p) => p.layout === layout && p.name === name)

/** Whether torno moved a part to set it beside the others: only a part that was moved says how far (the first of a row stays). */
export const isMoved = (part: Part | undefined): boolean => part?.arranged !== undefined

/**
 * Whether two ends, by the names of their parts, are apart by torno's doing
 * in this layout: on two parts of which it moved at least one, or one on a
 * part it moved and the other a bare point (`undefined`: on no part), which
 * is where that part is shown only by the spread. Asked only of what has two
 * ends.
 */
function apart(scene: Scene, layout: string, a: string | undefined, b: string | undefined): boolean {
  if (a === b) return false
  return isMoved(partOf(scene, layout, a)) || isMoved(partOf(scene, layout, b))
}

/** The other layouts that have each of the parts named where the model placed it. */
function asPlaced(scene: Scene, layout: string, names: Array<string | undefined>): string[] {
  const placed = (name: string, of: string): boolean => {
    const part = partOf(scene, of, name)
    return part !== undefined && !isMoved(part)
  }
  return scene.layouts.filter((of) => of !== layout && names.every((name) => name === undefined || placed(name, of)))
}

/**
 * Why a question about two parts, or about a bare point and a part, is not
 * answered in a layout torno spread, in full, or null when they are where the
 * model placed them. `what` is what was asked of them: `the distance
 * between`. It names the layouts that have the parts as placed, if any.
 */
export function spreadApart(scene: Scene, layout: string, a: string | undefined, b: string | undefined, what: string): string | null {
  if (!apart(scene, layout, a, b)) return null
  const assembled = asPlaced(scene, layout, [a, b])
  if (a === undefined || b === undefined) {
    const part = a ?? b
    const where = assembled.length > 0 ? `Ask in a layout that places ${part} as the model does (layouts: ${assembled.join(', ')}), or measure between faces and edges of ${part}.` : `Measure between faces and edges of ${part}.`
    return `In layout ${layout} torno moved ${part} for display (the parts overlapped as the model placed them), so ${what} a point and ${part} there is torno's, not the model's. ${where}`
  }
  const where =
    assembled.length > 0
      ? `Ask in a layout that places the parts as assembled (layouts: ${assembled.join(', ')}), or check each part by itself.`
      : 'This object has no layout that places its parts as assembled: check each part by itself.'
  return `In layout ${layout} torno spread these parts apart for display (they overlapped as the model placed them), so ${what} ${a} and ${b} there is torno's, not the model's. ${where}`
}

/**
 * The same in short, as the reason a dimension that is there already is not
 * measurable, with what can be done about it: null when it is measurable.
 */
export function spreadReason(scene: Scene, layout: string, a: string | undefined, b: string | undefined): string | null {
  if (!apart(scene, layout, a, b)) return null
  const assembled = asPlaced(scene, layout, [a, b])
  const advice = assembled.length > 0 ? `measure it in layout ${assembled.join(' or ')}` : 'no layout places them as assembled'
  if (a === undefined || b === undefined) return `torno moved ${a ?? b} for display in layout ${layout}, so the distance from a point to it there is not the model’s: ${assembled.length > 0 ? advice : 'measure between its faces'}`
  return `torno spread ${a} and ${b} apart for display in layout ${layout}, so the distance between them there is not the model’s: ${advice}`
}

/** The keys under which an answer holds coordinates in the frame of the layout. */
const COORDINATES = ['points', 'point', 'min', 'max', 'center', 'bbox', 'where', 'origin']

/**
 * What is said beside an answer that is of one part torno moved: how far, and,
 * when the answer holds coordinates (`reply`: those are where the part is
 * shown), that they are. Nothing of a part left where the model placed it.
 */
export function movedForDisplay(part: Part | undefined, layout: string, reply: object = { points: true }): { arranged?: Vec3; note?: string } {
  if (!part?.arranged?.some((c) => c !== 0)) return {}
  const held = COORDINATES.some((key) => {
    const value = (reply as Record<string, unknown>)[key]
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
  })
  if (!held) return { arranged: part.arranged }
  return { arranged: part.arranged, note: `${part.name} was moved by torno for display in layout ${layout}: these coordinates are in the displayed frame; subtract arranged for the model’s own.` }
}

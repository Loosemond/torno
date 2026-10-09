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

/** Whether two ends, by the names of their parts, are on two parts of which torno moved at least one in this layout. */
function apart(scene: Scene, layout: string, a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === b) return false
  return isMoved(partOf(scene, layout, a)) || isMoved(partOf(scene, layout, b))
}

/**
 * Why a question about two parts is not answered in a layout torno spread, in
 * full, or null when they are where the model placed them. `what` is what was
 * asked of them: `the distance between`. It names the layouts that have both
 * parts as placed, if any.
 */
export function spreadApart(scene: Scene, layout: string, a: string | undefined, b: string | undefined, what: string): string | null {
  if (!apart(scene, layout, a, b)) return null
  const placed = (name: string | undefined, of: string): boolean => {
    const part = partOf(scene, of, name)
    return part !== undefined && !isMoved(part)
  }
  const assembled = scene.layouts.filter((of) => of !== layout && placed(a, of) && placed(b, of))
  const where =
    assembled.length > 0
      ? `Ask in a layout that places the parts as assembled (layouts: ${assembled.join(', ')}), or check each part by itself.`
      : 'This object has no layout that places its parts as assembled: check each part by itself.'
  return `In layout ${layout} torno spread these parts apart for display (they overlapped as the model placed them), so ${what} ${a} and ${b} there is torno's, not the model's. ${where}`
}

/** The same in short, as the reason a dimension that is there already is not measurable: null when it is. */
export function spreadReason(scene: Scene, layout: string, a: string | undefined, b: string | undefined): string | null {
  return apart(scene, layout, a, b) ? `torno spread ${a} and ${b} apart for display in layout ${layout}, so the distance between them there is not the model’s` : null
}

/**
 * What is said beside coordinates that are of one part torno moved: how far,
 * and that they are where the part is shown. Nothing of a part left where the
 * model placed it.
 */
export function movedForDisplay(part: Part | undefined, layout: string): { arranged?: Vec3; note?: string } {
  if (!part?.arranged?.some((c) => c !== 0)) return {}
  return { arranged: part.arranged, note: `${part.name} was moved by torno for display in layout ${layout}: these coordinates are in the displayed frame; subtract arranged for the model’s own.` }
}

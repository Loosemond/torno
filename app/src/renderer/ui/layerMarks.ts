import { isCheck, standingOf } from '../../shared/dimension'
import { type Mark, markEndParts } from '../../shared/marks'

/** What the layers say of the marks on a part: how many are open, and whether one of them is a check that fails. */
export interface PartMarks {
  open: number
  failing: boolean
}

/**
 * The open marks of the layout shown by the part they are on, for the count beside a part's name. A mark is on the
 * part an end of it is at (`markEndParts`: both for a dimension between two); one tied to none is on none, and a
 * region is of its scan. A resolved mark is not counted, and a mark counts once for a part.
 */
export function marksByPart(marks: readonly Mark[], layout: string, revision: number | undefined): Map<string, PartMarks> {
  const counts = new Map<string, PartMarks>()
  for (const mark of marks) {
    if (mark.status === 'resolved' || mark.kind === 'region' || mark.layout !== layout) continue
    const fails = isCheck(mark) && standingOf(mark, revision) === 'fail'
    for (const part of new Set(markEndParts(mark))) {
      if (part === undefined) continue
      const was = counts.get(part) ?? { open: 0, failing: false }
      counts.set(part, { open: was.open + 1, failing: was.failing || fails })
    }
  }
  return counts
}

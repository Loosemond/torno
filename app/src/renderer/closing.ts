import { busyWith } from '../shared/agents'
import type { SendState, SessionStatus } from '../shared/bridge'
import type { Painting } from './tools/regionPainting'

// Closing the window ends torno and every session in it. When that would cut something short, the window asks
// first, in place (`ui/Confirm.tsx`); with nothing under way it closes at once. What "something" is, is here.

export interface ClosingState {
  sessions: ReadonlyArray<{ status: SessionStatus; hooks: boolean; send?: { state: SendState } }>
  /** How many paintings of a region are not kept yet, in any object. */
  paintings: number
  importing: boolean
  exporting: boolean
}

/** What closing the window now would end, as sentences; null when nothing is under way. */
export function closingWhy(state: ClosingState): string | null {
  const said: string[] = []
  const busy = state.sessions.filter((s) => busyWith(s.status, s.hooks) !== undefined)
  if (busy.length > 1) said.push('Sessions are in the middle of their work.')
  else if (busy.length === 1) said.push(busy[0].hooks ? 'A session is in the middle of its work.' : 'A session may be in the middle of its work: its agent does not say.')
  // Of a session that is still there: one that has ended has no prompt for a line to wait at.
  if (state.sessions.some((s) => s.status !== 'exited' && s.send?.state === 'waiting')) said.push("A line of marks is at an agent's prompt, not sent yet.")
  if (state.paintings > 0) said.push('A region painted on a scan is not kept yet.')
  if (state.importing) said.push('A scan is being imported.')
  if (state.exporting) said.push('An export is being written.')
  return said.length > 0 ? said.join(' ') : null
}

/**
 * How many paintings of a region hold something that is not kept: a new one with a triangle painted, or a kept
 * region taken in hand again ("Edit") and changed. One that holds nothing, or a kept region as it was kept, would
 * lose nothing.
 */
export function unkept(paintings: Iterable<Pick<Painting, 'set' | 'steps' | 'editing'>>): number {
  let n = 0
  for (const p of paintings) if (p.editing === undefined ? p.set.count > 0 : p.steps.length > 0) n += 1
  return n
}

/** Whether an export is being written: said by the export sheet, which alone knows. */
let exporting = false
export function setExporting(on: boolean): void {
  exporting = on
}
export function isExporting(): boolean {
  return exporting
}

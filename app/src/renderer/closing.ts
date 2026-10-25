import { AGENT_LABEL, busyWith } from '../shared/agents'
import type { SessionStatus } from '../shared/bridge'
import type { Painting } from './tools/regionPainting'

// Closing the window ends torno and every session in it, and so does opening another folder. When that would cut
// something short, the window asks first, in a dialog over the whole window (`ui/WorkspaceQuestion.tsx`) that names
// each thing and the object it is of; with nothing under way it goes at once. What "something" is, is here.

/** One thing that would be cut short: the object it is of, and what is under way there. */
export interface Reason {
  /** The object it is of; null for what is of no one object (a new object not made yet, an export). */
  objectId: string | null
  /** Said in place of the object's name when there is no object. */
  label?: string
  /** What would be cut short, as it follows the name: "Claude Code is working". */
  what: string
  /** Where its link goes when it is not to an object. */
  page?: 'new'
}

export interface ClosingState {
  sessions: ReadonlyArray<{ objectId: string; status: SessionStatus }>
  /** The objects that have a painting of a region not kept yet. */
  paintings: readonly string[]
  /** The object a scan is being imported into. */
  importing: string | null
  exporting: boolean
  /** The objects whose chats, not over, hold a prompt that was written and not sent. */
  unsent?: readonly string[]
  /** Whether the page of a new object holds something that is not made yet. */
  draft?: boolean
  /** The objects whose first prompt was not sent and is held, no chat having it yet. */
  heldPrompts?: readonly string[]
}

const NEW_OBJECT: Reason = { objectId: null, label: 'New project', page: 'new', what: 'it is set up and not made yet' }

function busySessions(sessions: ClosingState['sessions']): Reason[] {
  return sessions.flatMap((s) => {
    const busy = busyWith(s.status)
    return busy === undefined ? [] : [{ objectId: s.objectId, what: `${AGENT_LABEL} ${busy}` }]
  })
}

/** What closing the window now would end, a line for each; none when nothing is under way. */
export function closingWhy(state: ClosingState): Reason[] {
  return [
    ...busySessions(state.sessions),
    ...(state.unsent ?? []).map((objectId) => ({ objectId, what: 'a prompt is not sent' })),
    ...(state.draft === true ? [NEW_OBJECT] : []),
    ...(state.heldPrompts ?? []).map((objectId) => ({ objectId, what: 'the first prompt was not sent and is not in a chat yet' })),
    ...state.paintings.map((objectId) => ({ objectId, what: 'a region painted on a scan is not kept' })),
    ...(state.importing !== null ? [{ objectId: state.importing, what: 'a scan is being imported' }] : []),
    ...(state.exporting ? [{ objectId: null, label: 'Export', what: 'a file is being written' }] : [])
  ]
}

/** What opening another folder would end besides the sessions' end itself: a session at work, a new object set up and not made. */
export function leavingWhy(state: { sessions: ClosingState['sessions']; draft: boolean }): Reason[] {
  return [...busySessions(state.sessions), ...(state.draft ? [NEW_OBJECT] : [])]
}

/**
 * The objects with a painting of a region that holds something not kept: a new one with a triangle painted, or a
 * kept region taken in hand again ("Edit") and changed. One that holds nothing, or a kept region as it was kept,
 * would lose nothing.
 */
export function unkept(paintings: Iterable<Pick<Painting, 'objectId' | 'set' | 'steps' | 'editing'>>): string[] {
  const found: string[] = []
  for (const p of paintings) if (p.editing === undefined ? p.set.count > 0 : p.steps.length > 0) found.push(p.objectId)
  return found
}

/** Whether an export is being written: said by the export sheet, which alone knows. */
let exporting = false
export function setExporting(on: boolean): void {
  exporting = on
}
export function isExporting(): boolean {
  return exporting
}

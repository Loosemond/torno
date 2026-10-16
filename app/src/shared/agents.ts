import type { SessionStatus } from './bridge'
import { unmetDimensions } from './dimension'
import type { Mark } from './marks'

/** The agent torno runs, as the person reads it. */
export const AGENT_LABEL = 'Claude Code'

/** What a session is in the middle of, when ending it would lose something; undefined when it would not. */
export function busyWith(status: SessionStatus): string | undefined {
  return status === 'working' ? 'is working' : status === 'needs_input' ? 'is waiting for your answer' : undefined
}

/** What the next prompt carries of the marks: the drafts, and the dimensions it was sent that fail on the last build or have no value of it. */
export function nextCarries(marks: readonly Mark[], revision: number | undefined): { drafts: number; failing: number; unmeasured: number } {
  const { failing, unmeasured } = unmetDimensions(
    marks.filter((m) => m.status === 'sent'),
    revision
  )
  return { drafts: marks.filter((m) => m.status === 'draft').length, failing: failing.length, unmeasured: unmeasured.length }
}

/**
 * The quiet line of the session pane: what goes with the next prompt, so that the loop torno is built round is
 * said on screen. Null when nothing does. With no session (`live` false) it says what to do about the drafts; of
 * pinned dimensions alone it then says nothing.
 */
export function nextPromptLine(carries: { drafts: number; failing: number; unmeasured: number }, live: boolean): string | null {
  const { drafts, failing, unmeasured } = carries
  if (!live) {
    if (drafts === 0) return null
    return `${drafts} ${drafts === 1 ? 'mark is' : 'marks are'} not sent yet: start a session, and ${drafts === 1 ? 'it goes' : 'they go'} with your first prompt`
  }
  const things = [
    ...(drafts > 0 ? [`${drafts} ${drafts === 1 ? 'mark' : 'marks'}`] : []),
    ...(failing > 0 ? [`${failing} failing ${failing === 1 ? 'dimension' : 'dimensions'}`] : []),
    ...(unmeasured > 0 ? [`${unmeasured} ${unmeasured === 1 ? 'dimension' : 'dimensions'} with no value`] : [])
  ]
  if (things.length === 0) return null
  const listed = things.length === 1 ? things[0] : `${things.slice(0, -1).join(', ')} and ${things.at(-1)}`
  return `${listed} ${drafts + failing + unmeasured === 1 ? 'goes' : 'go'} with your next prompt`
}

/**
 * What the pane asks when main refuses to start a chat in a folder that has Claude Code settings of its own: Claude Code
 * run headless loads them without the trust question its terminal asks. Main's refusal is this very sentence.
 */
export function trustQuestion(files: readonly string[]): string {
  return `This folder has Claude Code settings of its own (${files.join(', ')}) that the chat would load without asking. Start the chat anyway?`
}

/** Whether an error is the refusal that asks the trust question (`trustQuestion`). */
export const isTrustQuestion = (message: string): boolean => /^This folder has Claude Code settings of its own \(.*\) that the chat would load without asking\. Start the chat anyway\?$/.test(message)

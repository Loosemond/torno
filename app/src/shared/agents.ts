import type { AgentId, SendState, SessionStatus } from './bridge'
import { unmetDimensions } from './dimension'
import type { Mark } from './marks'

/** The agents as the person reads them. */
export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', copilot: 'Copilot CLI' }

/**
 * What can be said of a session. An agent that posts no hooks says nothing of
 * its work: between its start and its end it is `running`, never idle,
 * working or waiting, which would be a guess.
 */
export type SessionSaid = SessionStatus | 'running'

export function sessionSaid(status: SessionStatus, hooks: boolean): SessionSaid {
  return !hooks && status !== 'starting' && status !== 'exited' ? 'running' : status
}

/**
 * What a session is in the middle of, when ending it would lose something;
 * undefined when it would not. One that only runs may be working: it is asked
 * about like one that is.
 */
export function busyWith(status: SessionStatus, hooks: boolean): string | undefined {
  const said = sessionSaid(status, hooks)
  return said === 'working' ? 'is working' : said === 'needs_input' ? 'is waiting for your answer' : said === 'running' ? 'may be working: torno cannot tell' : undefined
}

/**
 * What an agent without hooks has not been told that a hook would have
 * carried: the drafts, and the dimensions it was given that the last build
 * does not meet or that could not be measured on it (`main/context.ts`).
 */
export function toSend(marks: readonly Mark[], revision: number | undefined): { drafts: number; unmet: number } {
  const { failing, unmeasured } = unmetDimensions(
    marks.filter((m) => m.status === 'sent'),
    revision
  )
  return { drafts: marks.filter((m) => m.status === 'draft').length, unmet: failing.length + unmeasured.length }
}

/** The button that sends them: what it reads and the number beside it. None when there is nothing to send. */
export function sendLabel(has: { drafts: number; unmet: number }): { text: string; count: number } | null {
  if (has.drafts > 0) return { text: 'Send marks', count: has.drafts }
  return has.unmet > 0 ? { text: 'Send dimensions', count: has.unmet } : null
}

/**
 * The line under the header of an agent without hooks: what to do, or what
 * became of the line torno put at its cursor. Only what torno knows: that the
 * line was sent is seen, that the agent read the file it names is not.
 */
export function toldLine(state: SendState | undefined, drafts: number): string {
  if (state === 'waiting') return 'A line is at the cursor: press Enter there to send it. Marks stay drafts until you do.'
  if (state === 'dropped') return 'The line may have been changed before Enter, so the marks are still drafts: use "Send marks" again.'
  if (state === 'sent' && drafts === 0) return 'The line went with your Enter. Whether the agent read the file, torno cannot see.'
  return 'This agent is not told with each prompt: use "Send marks".'
}

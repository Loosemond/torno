import type { AgentId, AgentView, SendDropped, SendState, SessionStatus } from './bridge'
import { unmetDimensions } from './dimension'
import type { Mark } from './marks'

/** The agents as the person reads them. */
export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', copilot: 'Copilot CLI' }

/** The views each agent can be in, the one it starts in first: only Claude Code has a chat. */
export const AGENT_VIEWS: Record<AgentId, readonly AgentView[]> = { claude: ['chat', 'terminal'], copilot: ['terminal'] }

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
 * became of the line torno put at its cursor. Only what torno knows: that
 * Enter was pressed with the line at the prompt, never that the agent has
 * what the file tells.
 */
export function toldLine(send: { state: SendState; why?: SendDropped } | undefined, drafts: number): string {
  if (send?.state === 'waiting') return 'A line is at the cursor: press Enter to send it as it is. Marks stay drafts until you do.'
  if (send?.state === 'dropped') return `${send.why === 'absent' ? 'The line was not at the prompt when Enter was pressed' : 'Something was typed after the line'}, so the marks are still drafts: use "Send marks" again.`
  if (send?.state === 'sent' && drafts === 0) return 'Enter was pressed with the line at the prompt. Whether the agent read the file, torno cannot see.'
  return 'This agent is not told with each prompt: use "Send marks".'
}

/** What the next prompt of an agent with hooks carries of the marks: the drafts, and the dimensions it was sent that fail on the last build or have no value of it. */
export function nextCarries(marks: readonly Mark[], revision: number | undefined): { drafts: number; failing: number; unmeasured: number } {
  const { failing, unmeasured } = unmetDimensions(
    marks.filter((m) => m.status === 'sent'),
    revision
  )
  return { drafts: marks.filter((m) => m.status === 'draft').length, failing: failing.length, unmeasured: unmeasured.length }
}

/**
 * The quiet line of the session pane, for an agent that is told with every prompt: what goes with the next
 * one, so that the loop torno is built round is said on screen. Null when nothing does. With no session
 * (`live` false) it says what to do about the drafts; of pinned dimensions alone it then says nothing.
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

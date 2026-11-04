// `ask`: a question of the agent's to the person whose answers are refs. Main keeps it while it is open and tells the
// window; the window answers it. What the person chose is the answer and nothing else.

/** The most options a question has. */
export const MAX_ASK_OPTIONS = 6
/** The most refs one option names. */
export const MAX_ASK_REFS = 20
/** The longest question and the longest label that are kept: longer ones are refused, not cut. */
export const MAX_ASK_QUESTION = 400
export const MAX_ASK_LABEL = 80
/** An `ask` ends by itself with "not answered" after this long. */
export const ASK_LIMIT_MS = 10 * 60_000
/** How often a waiting `ask` tells its client it is alive: Claude Code ends an MCP call idle for 5 minutes unless it hears. */
export const ASK_PROGRESS_MS = 30_000

export interface AskOption {
  label: string
  refs: string[]
}

/** What the agent asks, with the refs already checked against the build (marks and groups turned into refs). */
export interface AskRequest {
  question: string
  options: AskOption[]
  /** The person may also answer with a face or an edge they point at in the viewport. */
  pick: boolean
  layout: string
  /** The build the refs were checked on. */
  revision: number
}

/** A question that waits for the person, as the window is told of it. */
export interface OpenAsk extends AskRequest {
  id: number
  objectId: string
  /** `Date.now()` when it was put, to say how long it has waited. */
  since: number
}

/** What the person answered: an option by its place in the list, or the one face or edge they pointed at, or none of them. */
export type AskAnswer = { kind: 'option'; index: number } | { kind: 'pick'; ref: string } | { kind: 'declined' }

/** Why a question ended with no answer: the agent gave it up (`aborted`: the turn was stopped, or the time was up), or the window or session went (`closed`). */
export interface AskEnd {
  kind: 'ended'
  why: 'aborted' | 'closed'
}

/** A face or an edge of a part: what a pick can be. */
export const PICK_REF = /^[^\s/]{1,200}\/[FE]\d{1,9}$/

/**
 * An answer as the window sent it, or null for what is none. A pick is a face or an edge of a part
 * (`lid/F12`, `lid/E3`): the tool looks it up in the build.
 */
export function answerOf(value: unknown, options: number): AskAnswer | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as { kind?: unknown; index?: unknown; ref?: unknown }
  if (a.kind === 'declined') return { kind: 'declined' }
  if (a.kind === 'option') return typeof a.index === 'number' && Number.isInteger(a.index) && a.index >= 0 && a.index < options ? { kind: 'option', index: a.index } : null
  if (a.kind === 'pick') return typeof a.ref === 'string' && PICK_REF.test(a.ref) ? { kind: 'pick', ref: a.ref } : null
  return null
}

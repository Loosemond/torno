import { type Mark, awaitsAcknowledgement } from '../../shared/marks'

/**
 * The marks of the panel by what is to be done with them: to send (drafts), from the agent (its own open marks,
 * for the person to read or answer), to review (the agent resolved them and the person has not said they have
 * seen it), with the agent (the person's sent marks), and resolved.
 */
export function groupMarks(marks: readonly Mark[]) {
  return {
    toSend: marks.filter((m) => m.status === 'draft'),
    fromAgent: marks.filter((m) => m.status === 'sent' && m.author === 'agent'),
    withAgent: marks.filter((m) => m.status === 'sent' && m.author !== 'agent'),
    toReview: marks.filter(awaitsAcknowledgement),
    resolved: marks.filter((m) => m.status === 'resolved' && !awaitsAcknowledgement(m))
  }
}

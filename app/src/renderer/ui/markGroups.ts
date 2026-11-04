import { isCheck, standingOf } from '../../shared/dimension'
import { type Mark, awaitsAcknowledgement } from '../../shared/marks'

/** How a check is ordered in its group: what fails first, then what has no value of the build, then what passes. */
const CHECK_ORDER: Record<string, number> = { fail: 0, unmeasurable: 1, unmeasured: 1, pass: 2, measured: 2 }

/**
 * The marks of the panel by what is to be done with them: checks (the dimensions that have something expected of
 * them, unresolved, whether sent or not: failing first, then those not measured on the build `revision`, then
 * those that pass), to send (drafts), from the agent (its own open marks, for the person to read or answer), to
 * review (the agent resolved them and the person has not said they have seen it), with the agent (the person's
 * sent marks), and resolved. A dimension with nothing expected was kept to be read, and stays where its status
 * puts it.
 */
export function groupMarks(marks: readonly Mark[], revision?: number) {
  const rest = marks.filter((m) => !isCheck(m))
  const checks = marks
    .filter(isCheck)
    .map((m, at) => ({ m, at, rank: CHECK_ORDER[standingOf(m, revision)] ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ m }) => m)
  return {
    checks,
    toSend: rest.filter((m) => m.status === 'draft'),
    fromAgent: rest.filter((m) => m.status === 'sent' && m.author === 'agent'),
    withAgent: rest.filter((m) => m.status === 'sent' && m.author !== 'agent'),
    toReview: marks.filter(awaitsAcknowledgement),
    resolved: marks.filter((m) => m.status === 'resolved' && !awaitsAcknowledgement(m))
  }
}

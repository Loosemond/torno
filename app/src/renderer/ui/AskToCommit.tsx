import type { Mark } from '../../shared/marks'
import { runningSession, useStore, actions } from '../state/store'
import { insertIntoSession } from './insertIntoSession'
import { useGit } from './useGit'

/** The most marks the request names. */
const MOST_NAMED = 6

/**
 * The marks the person has seen the agent resolve (`acknowledged`), newest first by number: the ones a commit is
 * about. Not those the person resolved themselves.
 */
export function committable(marks: readonly Mark[]): string[] {
  const number = (id: string): number => Number(id.slice(1))
  return marks
    .filter((m) => m.status === 'resolved' && m.resolvedBy === 'agent' && m.acknowledged === true)
    .map((m) => m.id)
    .sort((a, b) => number(b) - number(a))
    .slice(0, MOST_NAMED)
    .reverse()
}

/** `M4`, `M4 and M6`, `M2, M4 and M6`. */
function named(ids: readonly string[]): string {
  return ids.length <= 1 ? (ids[0] ?? '') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/**
 * What is put in the box when the person asks for a commit. It is the agent that commits, under the person's
 * permission rules: torno runs no git command that writes.
 */
export function commitPrompt(ids: readonly string[]): string {
  const about = ids.length === 0 ? 'the changes' : `the changes for ${named(ids)}`
  return `Commit ${about} of this project with a message saying what changed. Add only this project's files.`
}

/**
 * One line under the marks, once files differ from the last commit (what git says, read by main) and the person has
 * acknowledged marks the agent resolved: "Ask Claude Code to commit" puts a request in the box of the chat and never
 * sends it. Only for a chat; a terminal session is asked at its prompt.
 */
export function AskToCommit() {
  const git = useGit()
  const marks = useStore((s) => s.marks)
  const chat = useStore((s) => runningSession(s)?.view === 'chat')
  const ids = committable(marks)
  if (!git || git.changed === 0 || !chat || ids.length === 0) return null
  return (
    <p className="marks-commit">
      <button
        type="button"
        className="link-button"
        title="Puts a request in the message box and sends nothing; you read it, then send it. torno does not commit itself."
        onClick={() => {
          actions.setDockOpen(true)
          insertIntoSession(commitPrompt(ids), { later: true })
        }}
      >
        Ask Claude Code to commit
      </button>
    </p>
  )
}

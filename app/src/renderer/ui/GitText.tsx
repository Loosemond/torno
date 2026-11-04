import { type GitState, gitSaid } from '../../shared/git'
import { numbered } from './numbered'

/** `3 files changed since a1b2c3d`, the count and the commit in the monospace face (a commit is no number: `numbered` would cut it up). */
export function GitText({ git }: { git: GitState }) {
  const text = gitSaid(git)
  if (git.head === null) return <>{numbered(text)}</>
  const at = text.lastIndexOf(git.head)
  return (
    <>
      {numbered(text.slice(0, at))}
      <span className="num">{git.head}</span>
      {numbered(text.slice(at + git.head.length))}
    </>
  )
}

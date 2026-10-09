import { dirname } from 'node:path'
import type { SessionStatus } from '../../shared/bridge'

/**
 * The hooks torno listens to. `SessionStart` is absent on purpose: Claude Code
 * does not fire it as an http hook. `PreToolUse` and `PostToolUse` are there
 * only to say the agent is at work again after a question was answered:
 * nothing else tells that a permission prompt has gone.
 */
export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SessionEnd']

/**
 * The status of a session after an event: the name of a hook the agent posted,
 * or what the PTY did (`output`, `exit`). An event that says nothing about the
 * status leaves it as it is, and nothing follows `exited`.
 */
export function reduceStatus(prev: SessionStatus, event: string): SessionStatus {
  if (prev === 'exited') return prev
  switch (event) {
    case 'output':
      return prev === 'starting' ? 'idle' : prev
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
      return 'idle'
    case 'Notification':
    case 'PermissionRequest':
      return 'needs_input'
    case 'SessionEnd':
    case 'exit':
      return 'exited'
    default:
      return prev
  }
}

/**
 * Whether a session is one that may be typed into from the window: the manager
 * has it (`of` is what `Sessions.objectOf` says, none for a session that is
 * unknown, ended or hung up on), and its folder is directly under the root of
 * the open workspace. Not "its object is in the list": an object leaves the
 * list when its last `.py` is deleted, and the agent in its folder is still
 * there to be talked to. A session of a workspace that was left may linger
 * for a moment: its folder is under another root.
 */
export function sessionOfWorkspace(of: { id: string; dir: string } | undefined, root: string | undefined): boolean {
  return of !== undefined && root !== undefined && dirname(of.dir) === root
}

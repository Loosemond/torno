import type { SessionStatus } from '../../shared/bridge'

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

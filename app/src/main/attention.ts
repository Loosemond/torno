import type { SessionStatus } from '../shared/bridge'

/**
 * Whether a session's move to a status should draw the eye of a window that is not in use: when it moves to
 * `needs_input` (an ask: a permission, a question, a plan) while the window has no focus. Once per ask: the same
 * status told again is no new ask, and an ask that came while the window was in use was seen. The window flashes
 * its frame (Linux, Windows) or bounces the dock icon (macOS); it never posts a system notification.
 */
export class Attention {
  private readonly last = new Map<string, SessionStatus>()

  moved(sessionId: string, status: SessionStatus, focused: boolean): boolean {
    const before = this.last.get(sessionId)
    this.last.set(sessionId, status)
    return status === 'needs_input' && before !== 'needs_input' && !focused
  }
}

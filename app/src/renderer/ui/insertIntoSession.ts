import { runningSession, store } from '../state/store'
import { insertIntoComposer } from './chat/Composer'

/**
 * Puts text at the cursor of the open object's session, for the person to write around: in the box of a chat
 * (`insertIntoComposer`, which gives it the keys), at the prompt of a terminal (`session.insert`, a paste, never
 * Enter). True when it went in; false with no session running, or a chat whose box is not open. The text is
 * never sent. `later` waits for the next frame before giving the keys to the box or the terminal, for a caller
 * that has just shown the dock: a box in a hidden one takes no focus.
 */
export function insertIntoSession(text: string, { later = false }: { later?: boolean } = {}): boolean {
  const session = runningSession(store.getState())
  if (!session) return false
  const focus = (selector: string): void => {
    const take = (): void => document.querySelector<HTMLElement>(`[data-region="session"] ${selector}`)?.focus()
    if (later) requestAnimationFrame(take)
    else take()
  }
  // A chat has a box of its own to write in, not a terminal.
  if (session.view === 'chat') {
    if (!insertIntoComposer(text)) return false
    if (later) focus('[data-chat-composer]:not([disabled])')
    return true
  }
  window.torno.session.insert(session.sessionId, text)
  // The next thing typed belongs with it.
  focus('.session-term textarea')
  return true
}

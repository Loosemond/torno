import { peek } from '../state/agent'
import { actions, store } from '../state/store'
import { refInfo } from './chat/refs'

/** The mark each way of pointing is on: the pointer (a row or a chip in the view), and the keys' focus in a row. */
const held: Record<'pointer' | 'focus', string | null> = { pointer: null, focus: null }

/**
 * The pointer went on a mark, in its row or on its chip in the view (`pointer`, null when it went off one), or the
 * keys' focus went into a mark's row (`focus`): the mark pointed at is the pointer's while there is one, else the
 * focus's. Its row has its hover background, its chip a fainter ring than the active one's, and the faces it is on
 * are lit as a ref of the chat lights them (`peek`: in the accent, no highlight of the agent's, no agent line).
 * Called as the pointer or the focus goes on or off, never per move.
 */
export function hoverMark(id: string | null, by: 'pointer' | 'focus' = 'pointer'): void {
  held[by] = id
  light()
}

/** What pointed at a mark has left it: nothing else that points at another is put out. */
export function unhoverMark(id: string, by: 'pointer' | 'focus'): void {
  if (held[by] !== id) return
  held[by] = null
  light()
}

function light(): void {
  const id = held.pointer ?? held.focus
  actions.hoverMark(id)
  const shown = store.getState().hoveredMark
  peek(shown === null ? [] : refInfo(store.getState(), shown).lights)
}

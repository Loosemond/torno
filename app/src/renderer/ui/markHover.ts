import { peek } from '../state/agent'
import { actions, store } from '../state/store'
import { refInfo } from './chat/refs'

/**
 * The pointer went on a mark, in its row or on its chip in the view, or off it (null): the row has its hover
 * background, the chip a fainter ring than the active one's, and the faces the mark is on are lit as a ref of the
 * chat lights them (`peek`: no highlight of the agent's, no agent line). Called as the pointer goes on or off, never
 * per move.
 */
export function hoverMark(id: string | null): void {
  actions.hoverMark(id)
  peek(id === null ? [] : refInfo(store.getState(), id).lights)
}

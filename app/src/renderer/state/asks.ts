import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AskAnswer, OpenAsk } from '../../shared/ask'

/**
 * The questions the agent waits on (`ask`), as main last told them: it keeps them, the window shows them and says
 * the answer. Nothing here is kept: a question is as open as main says.
 */
export const askStore = createStore<{ open: OpenAsk[] }>(() => ({ open: [] }))

/** The question of an object that waits for the person, if there is one. */
export function useOpenAsk(objectId: string | null): OpenAsk | undefined {
  return useZustand(askStore, (s) => (objectId === null ? undefined : s.open.find((ask) => ask.objectId === objectId)))
}

/** Follow main's list of the open questions, from the one it has now. Returns what stops following. */
export function connectAsks(): () => void {
  let live = true
  const off = window.torno.asks.onChanged((open) => askStore.setState({ open }))
  void window.torno.asks.list().then((open) => {
    if (live) askStore.setState({ open })
  })
  return () => {
    live = false
    off()
    askStore.setState({ open: [] })
  }
}

export function answerAsk(ask: OpenAsk, answer: AskAnswer): void {
  window.torno.asks.answer(ask.id, answer)
}

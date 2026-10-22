import { createContext, useContext } from 'react'

/**
 * What the buttons of the transcript's notes do (`action` of a note item): `terminal` runs the object's sessions in
 * Claude Code's own terminal. Given only to the items of the session shown, never to those of the conversation it
 * resumed: an offer of an older session is not one any more.
 */
export interface ChatOffers {
  /** `disabled` while the pane asks or switches, as the view switch is. */
  terminal?: { take: () => void; disabled: boolean }
}

export const ChatOffer = createContext<ChatOffers>({})

export const useChatOffers = (): ChatOffers => useContext(ChatOffer)

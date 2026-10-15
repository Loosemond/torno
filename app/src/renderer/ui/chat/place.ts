import { createContext, useContext } from 'react'
import type { ChatWhere } from '../../../shared/chat'

/** Where the chat is (the open object's folder, the person's home): paths in the transcript are shown by it. */
export const ChatPlace = createContext<ChatWhere>({})

export const useChatPlace = (): ChatWhere => useContext(ChatPlace)

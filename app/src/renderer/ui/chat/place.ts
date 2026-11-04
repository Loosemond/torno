import { createContext, useContext } from 'react'
import type { ChatWhere } from '../../../shared/chat'

/** Where the chat is (the open object's folder, the person's home): paths in the transcript are shown by it. */
export const ChatPlace = createContext<ChatWhere>({})

/** The items drawn are from before this session began ("Earlier in this conversation"): a revision in them is of an earlier run, and may name another build now. */
export const ChatEarlier = createContext(false)

export const useChatPlace = (): ChatWhere => useContext(ChatPlace)

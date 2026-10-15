import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/chat'
import { ToolCard } from './ToolCard'

type Tool = Extract<ChatItem, { kind: 'tool' }>
const word = (state: Tool['state']): string => {
  const item: Tool = { kind: 'tool', id: 'i1', toolUseId: 't1', name: 'ExitPlanMode', torno: false, input: {}, state, images: [] }
  const out = renderToStaticMarkup(createElement(ToolCard, { item, beat: false }))
  return /<span class="chat-tool-state">(?:<[^>]*>)*([^<]*)<\/span>/.exec(out)?.[1] ?? ''
}

describe('the word on a tool card', () => {
  it('says denied and cancelled as they are, and failed only for an error', () => {
    expect([word('denied'), word('cancelled'), word('error'), word('stopped'), word('done')]).toEqual(['denied', 'cancelled', 'failed', 'stopped', 'done'])
  })
})

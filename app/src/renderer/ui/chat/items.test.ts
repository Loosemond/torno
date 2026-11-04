import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/chat'
import { ChatItems } from './Items'

const user: ChatItem = { kind: 'user', id: 'i1', text: 'make it thicker', images: [], state: 'sent', at: 1 }
const tool: ChatItem = { kind: 'tool', id: 'i2', toolUseId: 'toolu_1', name: 'Edit', torno: false, input: { file_path: '/ws/part/part.py' }, state: 'done', images: [] }
const forPrompt: ChatItem = { kind: 'context', id: 'i3', forUser: 'i1', text: '[torno] part', marks: ['M1'], revision: 1, buildState: 'ok' }
const forEdit: ChatItem = { kind: 'context', id: 'i4', forUser: 'i2', forTool: true, text: '[torno] part · build ok · r2', marks: [], revision: 2, buildState: 'ok', seconds: 1.2 }
const drawn = (items: ChatItem[]): string => renderToStaticMarkup(createElement(ChatItems, { items, beat: true }))

describe('what is drawn under an item', () => {
  it('is what torno added under a prompt, and the build the edit started under the card of the edit', () => {
    const out = drawn([user, forPrompt, tool, forEdit])
    expect(out.match(/class="chat-item chat-added"/g)).toHaveLength(1)
    expect(out.match(/class="chat-item chat-build"/g)).toHaveLength(1)
    expect(out.indexOf('chat-build')).toBeGreaterThan(out.indexOf('data-kind="tool"'))
    expect(out.replace(/<[^>]*>/g, '')).toContain('torno added')
  })

  it('names a failed build in what torno added to a prompt as the build after the revision on show', () => {
    const out = drawn([user, { ...forPrompt, marks: [], buildState: 'failed' }]).replace(/<[^>]*>/g, '')
    expect(out).toContain('build after r1 failed')
  })

  it('draws a build whose card is gone as a build where it stands', () => {
    const out = drawn([{ ...forEdit, forUser: 'gone' }])
    expect(out).toContain('chat-build')
    expect(out).not.toContain('torno added')
  })

  it('ends a turn with what it did to the project, and what it pulled from torno on a line of its own', () => {
    const turn: ChatItem = { kind: 'turn', id: 'i9', ok: true, stopped: false, seconds: 4.2, pulled: { look: 1 } }
    const out = drawn([user, forPrompt, tool, forEdit, turn])
    const line = out.slice(out.indexOf('data-kind="turn"')).replace(/<[^>]*>/g, '')
    expect(line).toContain('Done in 4.2 s')
    expect(line).toContain('part.py edited')
    expect(line).toContain('r1')
    expect(line).toContain('r2')
    expect(line).toContain('Pulled from torno: look')
  })
})

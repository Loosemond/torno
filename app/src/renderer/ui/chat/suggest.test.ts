import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/chat'
import { type SuggestInput, printChecked, suggest } from './suggest'

const user = (text: string): ChatItem => ({ kind: 'user', id: 'u', text, images: [], state: 'sent', at: 0 })
const check = (kind: string): ChatItem => ({ kind: 'tool', id: 't', toolUseId: 't', name: 'mcp__torno__check', torno: true, input: { kind }, state: 'done', images: [] })

const base: SuggestInput = { buildFailed: false, objectName: 'bracket', openMarks: 0, layouts: ['assembled'], items: [user('hello')], tornoDisconnected: false }
const ids = (input: Partial<SuggestInput>): string[] => suggest({ ...base, ...input }).map((c) => c.id)

describe('suggest', () => {
  it('offers nothing in the middle of a quiet conversation', () => {
    expect(ids({})).toEqual([])
  })
  it('offers to fix a failed build, with the words of the sheet', () => {
    expect(suggest({ ...base, buildFailed: true })).toEqual([{ id: 'fix', label: 'Fix the build', text: 'Fix the build of bracket: see the error.' }])
  })
  it('counts the open marks and puts the review command in the box', () => {
    expect(suggest({ ...base, openMarks: 2 })).toEqual([{ id: 'review', label: 'Review 2 marks', text: '/mcp__torno__review ' }])
    expect(suggest({ ...base, openMarks: 1 })[0].label).toBe('Review 1 mark')
  })
  it('offers the print check for a model with a print layout nobody has checked', () => {
    expect(ids({ layouts: ['assembled', 'print'] })).toEqual(['printable'])
    expect(ids({ layouts: ['assembled', 'print'], items: [user('x'), check('thin')] })).toEqual([])
    expect(ids({ layouts: ['assembled', 'print'], items: [user('/mcp__torno__printable 256x256x256')] })).toEqual([])
    expect(ids({ layouts: ['print'], items: [user('x'), check('clearance')] })).toEqual(['printable'])
  })
  it('offers to explain a conversation not begun', () => {
    expect(ids({ items: [] })).toEqual(['explain'])
  })
  it('offers three at most, the failed build first', () => {
    expect(ids({ buildFailed: true, openMarks: 3, layouts: ['print'], items: [] })).toEqual(['fix', 'review', 'printable'])
  })
  it('does not offer the prompts of torno when its tools are not connected', () => {
    expect(ids({ buildFailed: true, openMarks: 3, layouts: ['print'], items: [], tornoDisconnected: true })).toEqual(['fix'])
  })
  it('knows a print check by the tool or by the prompt', () => {
    expect(printChecked([check('overhang')])).toBe(true)
    expect(printChecked([user('hello')])).toBe(false)
  })
})

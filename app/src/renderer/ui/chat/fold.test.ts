import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/chat'
import { foldLabel, foldRuns } from './fold'

type Tool = Extract<ChatItem, { kind: 'tool' }>
let n = 0
const tool = (name: string, more: Partial<Tool> = {}): Tool => ({ kind: 'tool', id: `i${++n}`, toolUseId: `t${n}`, name, torno: name.startsWith('mcp__torno__'), input: {}, state: 'done', images: [], ...more })
const turn = (): ChatItem => ({ kind: 'turn', id: `i${++n}`, ok: true, stopped: false, seconds: 3, pulled: {} })
const text = (): ChatItem => ({ kind: 'text', id: `i${++n}`, text: 'now', streaming: false })
const thought = (streaming = false): ChatItem => ({ kind: 'thinking', id: `i${++n}`, streaming })
const none = new Set<string>()
const kinds = (items: ChatItem[], under = none) => foldRuns(items, under).map((e) => (e.kind === 'fold' ? `fold(${e.items.length}): ${e.label}` : e.item.kind))

describe('the label of a run', () => {
  it('counts files read, repeats as ×N, and names a tool once', () => {
    expect(foldLabel([tool('Read'), tool('Grep'), tool('Read'), tool('Grep'), tool('Read'), tool('Bash')])).toBe('Read 3 files, Grep ×2, Bash')
    expect(foldLabel([tool('Read'), tool('Glob'), tool('mcp__fs__list')])).toBe('Read 1 file, Glob, fs · list')
  })
})

describe('folding the tool lines of a turn that has ended', () => {
  it('folds three or more finished tools of the agent\'s own, once a turn has ended after them', () => {
    expect(kinds([tool('Read'), tool('Read'), tool('Grep'), text(), turn()])).toEqual(['fold(3): Read 2 files, Grep', 'text', 'turn'])
  })

  it('leaves two alone, and every line of a turn that is still going on', () => {
    expect(kinds([tool('Read'), tool('Grep'), text(), turn()])).toEqual(['tool', 'tool', 'text', 'turn'])
    expect(kinds([text(), turn(), tool('Read'), tool('Read'), tool('Read'), tool('Bash')])).toEqual(['text', 'turn', 'tool', 'tool', 'tool', 'tool'])
  })

  it('never folds torno\'s own, one with a picture or a build under it, or one that did not go well', () => {
    const edit = tool('Edit')
    const items = [tool('Read'), tool('mcp__torno__look'), tool('Read'), tool('Read'), tool('Read', { images: [{ id: 'p', mediaType: 'image/png' }] }), tool('Read'), edit, tool('Read'), tool('Read', { state: 'error' }), tool('Read', { state: 'denied' }), turn()]
    // Each run is cut short by one of those: none reaches three.
    expect(kinds(items, new Set([edit.id])).filter((k) => k.startsWith('fold'))).toEqual([])
    const folds = foldRuns([tool('Read'), tool('Read'), tool('mcp__torno__look'), tool('Read'), tool('Read'), tool('Read'), tool('Bash', { state: 'error' }), turn()], none)
    expect(folds.map((e) => e.kind)).toEqual(['item', 'item', 'item', 'fold', 'item', 'item'])
  })

  it('never folds the agent\'s task list', () => {
    expect(kinds([tool('Read'), tool('TodoWrite'), tool('Read'), tool('Read'), turn()])).toEqual(['tool', 'tool', 'tool', 'tool', 'turn'])
  })

  it('takes the thoughts between its tools in, but not one that is being had, and not the text', () => {
    expect(kinds([tool('Read'), thought(), tool('Grep'), thought(), tool('Bash'), turn()])).toEqual(['fold(5): Read 1 file, Grep, Bash', 'turn'])
    expect(kinds([tool('Read'), thought(true), tool('Grep'), tool('Bash'), turn()])).toEqual(['tool', 'thinking', 'tool', 'tool', 'turn'])
    expect(kinds([tool('Read'), tool('Read'), text(), tool('Read'), tool('Read'), turn()])).toEqual(['tool', 'tool', 'text', 'tool', 'tool', 'turn'])
  })

  it('keeps the items it was given: it draws, it does not change', () => {
    const items = [tool('Read'), tool('Read'), tool('Read'), turn()]
    const before = JSON.stringify(items)
    const out = foldRuns(items, none)
    expect(JSON.stringify(items)).toBe(before)
    expect(out[0].kind === 'fold' && out[0].items).toEqual(items.slice(0, 3))
  })
})

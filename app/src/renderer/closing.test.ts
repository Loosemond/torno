import { describe, expect, it } from 'vitest'
import { closingWhy, leavingWhy, unkept } from './closing'

const NOTHING = { sessions: [], paintings: [], importing: null, exporting: false }

describe('what closing the window would end', () => {
  it('is nothing with no session, with one at rest and with one that has ended: the window closes at once', () => {
    expect(closingWhy(NOTHING)).toEqual([])
    expect(closingWhy({ ...NOTHING, sessions: [{ objectId: 'a', status: 'idle' }, { objectId: 'b', status: 'exited' }, { objectId: 'c', status: 'starting' }] })).toEqual([])
  })

  it('names the object of a session at work, and of one waiting for an answer', () => {
    expect(closingWhy({ ...NOTHING, sessions: [{ objectId: 'bracket', status: 'working' }] })).toEqual([{ objectId: 'bracket', what: 'Claude Code is working' }])
    expect(closingWhy({ ...NOTHING, sessions: [{ objectId: 'hollow', status: 'needs_input' }] })).toEqual([{ objectId: 'hollow', what: 'Claude Code is waiting for your answer' }])
  })

  it('names the object of a prompt not sent, a painting not kept, an import', () => {
    expect(closingWhy({ ...NOTHING, unsent: ['hollow'] })).toEqual([{ objectId: 'hollow', what: 'a prompt is not sent' }])
    expect(closingWhy({ ...NOTHING, unsent: [] })).toEqual([])
    expect(closingWhy({ ...NOTHING, paintings: ['scanned'] })).toEqual([{ objectId: 'scanned', what: 'a region painted on a scan is not kept' }])
    expect(closingWhy({ ...NOTHING, importing: 'scanned' })).toEqual([{ objectId: 'scanned', what: 'a scan is being imported' }])
    expect(closingWhy({ ...NOTHING, heldPrompts: ['clip'] })).toEqual([{ objectId: 'clip', what: 'the first prompt was not sent and is not in a chat yet' }])
  })

  it('says of a new object and of an export, which are of no object, what they are and where the new one is', () => {
    expect(closingWhy({ ...NOTHING, draft: true })).toEqual([{ objectId: null, label: 'New object', page: 'new', what: 'it is set up and not made yet' }])
    expect(closingWhy({ ...NOTHING, draft: false })).toEqual([])
    expect(closingWhy({ ...NOTHING, exporting: true })).toEqual([{ objectId: null, label: 'Export', what: 'a file is being written' }])
  })

  it('counts a painting that holds what is not kept: something painted, or a kept region painted again', () => {
    const painted = (objectId: string, count: number, steps: number, editing?: string) => ({ objectId, set: { count } as never, steps: Array.from({ length: steps }, () => ({ added: [], removed: [] })), editing })
    expect(unkept([])).toEqual([])
    expect(unkept([painted('a', 0, 0), painted('b', 0, 2)])).toEqual([])
    expect(unkept([painted('a', 12, 1)])).toEqual(['a'])
    // "Edit" on a kept region takes its mask in hand: as it was kept, nothing would be lost.
    expect(unkept([painted('a', 40, 0, 'M3')])).toEqual([])
    expect(unkept([painted('a', 40, 1, 'M3'), painted('b', 3, 1)])).toEqual(['a', 'b'])
  })

  it('says each thing under way as a line of its own, the sessions first, one for each object', () => {
    expect(closingWhy({ sessions: [{ objectId: 'a', status: 'working' }, { objectId: 'b', status: 'needs_input' }, { objectId: 'c', status: 'idle' }], paintings: ['b'], importing: 'a', exporting: false, unsent: ['c'] })).toEqual([
      { objectId: 'a', what: 'Claude Code is working' },
      { objectId: 'b', what: 'Claude Code is waiting for your answer' },
      { objectId: 'c', what: 'a prompt is not sent' },
      { objectId: 'b', what: 'a region painted on a scan is not kept' },
      { objectId: 'a', what: 'a scan is being imported' }
    ])
  })
})

describe('what leaving the folder would end', () => {
  it('is nothing with every session at rest and no new object set up', () => {
    expect(leavingWhy({ sessions: [{ objectId: 'a', status: 'idle' }], draft: false })).toEqual([])
  })

  it('names the objects whose sessions are at work, and the new object that would be thrown away', () => {
    expect(leavingWhy({ sessions: [{ objectId: 'bracket', status: 'working' }, { objectId: 'plain', status: 'idle' }], draft: true })).toEqual([
      { objectId: 'bracket', what: 'Claude Code is working' },
      { objectId: null, label: 'New object', page: 'new', what: 'it is set up and not made yet' }
    ])
  })
})

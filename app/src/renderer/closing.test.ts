import { describe, expect, it } from 'vitest'
import { closingWhy, unkept } from './closing'

const NOTHING = { sessions: [], paintings: 0, importing: false, exporting: false }

describe('what closing the window would end', () => {
  it('is nothing with no session, with one at rest and with one that has ended: the window closes at once', () => {
    expect(closingWhy(NOTHING)).toBeNull()
    expect(closingWhy({ ...NOTHING, sessions: [{ status: 'idle' }, { status: 'exited' }, { status: 'starting' }] })).toBeNull()
  })

  it('is a session at work, and one waiting for an answer', () => {
    expect(closingWhy({ ...NOTHING, sessions: [{ status: 'working' }] })).toBe('A session is in the middle of its work.')
    expect(closingWhy({ ...NOTHING, sessions: [{ status: 'needs_input' }] })).toBe('A session is in the middle of its work.')
  })

  it('is a prompt not sent, a painting not kept, an import and an export under way', () => {
    expect(closingWhy({ ...NOTHING, unsent: 1 })).toBe('A prompt written in the chat is not sent yet.')
    expect(closingWhy({ ...NOTHING, unsent: 0 })).toBeNull()
    expect(closingWhy({ ...NOTHING, draft: true })).toBe('A new object is set up and not made yet.')
    expect(closingWhy({ ...NOTHING, draft: false })).toBeNull()
    expect(closingWhy({ ...NOTHING, heldPrompt: true })).toBe('The first prompt of a new object was not sent and is not in a chat yet.')
    expect(closingWhy({ ...NOTHING, paintings: 1 })).toBe('A region painted on a scan is not kept yet.')
    expect(closingWhy({ ...NOTHING, importing: true })).toBe('A scan is being imported.')
    expect(closingWhy({ ...NOTHING, exporting: true })).toBe('An export is being written.')
  })

  it('counts a painting that holds what is not kept: something painted, or a kept region painted again', () => {
    const painted = (count: number, steps: number, editing?: string) => ({ set: { count } as never, steps: Array.from({ length: steps }, () => ({ added: [], removed: [] })), editing })
    expect(unkept([])).toBe(0)
    expect(unkept([painted(0, 0), painted(0, 2)])).toBe(0)
    expect(unkept([painted(12, 1)])).toBe(1)
    // "Edit" on a kept region takes its mask in hand: as it was kept, nothing would be lost.
    expect(unkept([painted(40, 0, 'M3')])).toBe(0)
    expect(unkept([painted(40, 1, 'M3'), painted(3, 1)])).toBe(2)
  })

  it('says how many sessions are at work, without a number', () => {
    expect(closingWhy({ ...NOTHING, sessions: [{ status: 'working' }, { status: 'needs_input' }, { status: 'idle' }] })).toBe('Sessions are in the middle of their work.')
  })

  it('says all there is, in one line', () => {
    expect(closingWhy({ sessions: [{ status: 'working' }], paintings: 2, importing: true, exporting: false })).toBe(
      'A session is in the middle of its work. A region painted on a scan is not kept yet. A scan is being imported.'
    )
  })
})

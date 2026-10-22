import { afterEach, describe, expect, it, vi } from 'vitest'
import { store } from '../state/store'
import { insertIntoSession } from './insertIntoSession'

describe('putting text at the cursor of the open object\'s session', () => {
  afterEach(() => {
    store.setState({ objectId: null, sessions: {} })
    vi.unstubAllGlobals()
  })
  const insert = vi.fn()
  const focus = vi.fn()
  const run = (session: { status: 'idle' | 'exited'; view: 'chat' | 'terminal' } | null) => {
    insert.mockClear()
    focus.mockClear()
    vi.stubGlobal('window', { torno: { session: { insert } } })
    vi.stubGlobal('document', { querySelector: () => ({ focus }) })
    store.setState({ objectId: 'o', sessions: session ? { o: { sessionId: 's1', ...session } } : {} })
    return insertIntoSession('Params.wall')
  }

  it('does nothing, and says so, with no session running or one that has ended', () => {
    expect(run(null)).toBe(false)
    expect(run({ status: 'exited', view: 'terminal' })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('says so when the chat has no box open to write in', () => {
    expect(run({ status: 'idle', view: 'chat' })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('pastes at the prompt of a terminal and gives it the keys', () => {
    expect(run({ status: 'idle', view: 'terminal' })).toBe(true)
    expect(insert).toHaveBeenCalledWith('s1', 'Params.wall')
    expect(focus).toHaveBeenCalledTimes(1)
  })
})

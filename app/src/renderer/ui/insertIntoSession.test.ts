import { afterEach, describe, expect, it, vi } from 'vitest'
import { store } from '../state/store'
import { insertIntoComposer } from './chat/Composer'
import { insertIntoSession } from './insertIntoSession'

// The chat's box is drawn by React: here it is told whether it is open, and what was put in it is read back.
vi.mock('./chat/Composer', () => ({ insertIntoComposer: vi.fn() }))

describe('putting text at the cursor of the open object\'s session', () => {
  afterEach(() => {
    store.setState({ objectId: null, sessions: {} })
    vi.unstubAllGlobals()
  })
  const insert = vi.fn()
  const focus = vi.fn()
  const selectors: string[] = []
  const frames: Array<() => void> = []
  const run = (session: { status: 'idle' | 'exited'; view: 'chat' | 'terminal' } | null, options?: { later?: boolean }, boxOpen = true) => {
    insert.mockClear()
    focus.mockClear()
    selectors.length = 0
    frames.length = 0
    vi.mocked(insertIntoComposer).mockReset().mockReturnValue(boxOpen)
    vi.stubGlobal('window', { torno: { session: { insert } } })
    vi.stubGlobal('document', { querySelector: (selector: string) => (selectors.push(selector), { focus }) })
    vi.stubGlobal('requestAnimationFrame', (frame: () => void) => void frames.push(frame))
    store.setState({ objectId: 'o', sessions: session ? { o: { sessionId: 's1', ...session } } : {} })
    return insertIntoSession('Params.wall', options)
  }

  it('does nothing, and says so, with no session running or one that has ended', () => {
    expect(run(null)).toBe(false)
    expect(run({ status: 'exited', view: 'terminal' })).toBe(false)
    expect(insert).not.toHaveBeenCalled()
    expect(insertIntoComposer).not.toHaveBeenCalled()
  })

  it('says so when the chat has no box open to write in, and focuses nothing', () => {
    expect(run({ status: 'idle', view: 'chat' }, { later: true }, false)).toBe(false)
    expect(insertIntoComposer).toHaveBeenCalledWith('Params.wall')
    expect(insert).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
  })

  it('puts it in the box of a chat, which gives itself the keys, and pastes nothing at a terminal', () => {
    expect(run({ status: 'idle', view: 'chat' })).toBe(true)
    expect(insertIntoComposer).toHaveBeenCalledWith('Params.wall')
    expect(insert).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })

  it('gives the keys to the box of a chat in the next frame when asked to wait', () => {
    expect(run({ status: 'idle', view: 'chat' }, { later: true })).toBe(true)
    expect(focus).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    frames[0]()
    expect(selectors).toEqual(['[data-region="session"] [data-chat-composer]:not([disabled])'])
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('pastes at the prompt of a terminal and gives it the keys, at once or in the next frame', () => {
    expect(run({ status: 'idle', view: 'terminal' })).toBe(true)
    expect(insert).toHaveBeenCalledWith('s1', 'Params.wall')
    expect(insertIntoComposer).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(run({ status: 'idle', view: 'terminal' }, { later: true })).toBe(true)
    expect(focus).not.toHaveBeenCalled()
    frames[0]()
    expect(selectors).toEqual(['[data-region="session"] .session-term textarea'])
    expect(focus).toHaveBeenCalledTimes(1)
  })
})

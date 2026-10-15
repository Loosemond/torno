import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatHistory, ChatItem, ChatMeta } from '../../shared/chat'
import { chatActions, chatStore, connectChat, drawn } from './chat'

type User = Extract<ChatItem, { kind: 'user' }>
const user = (n: number, state: User['state'] = 'sent'): ChatItem => ({ kind: 'user', id: `s-i${n}`, text: `prompt ${n}`, images: [], state, at: n })
const text = (n: number, said = `text ${n}`, streaming = false): ChatItem => ({ kind: 'text', id: `s-i${n}`, text: said, streaming })
const turn = (n: number): ChatItem => ({ kind: 'turn', id: `s-i${n}`, ok: true, stopped: false, seconds: 1, pulled: {} })
const history = (items: ChatItem[], seq: number, meta: ChatMeta = {}): ChatHistory => ({ items, meta, earlier: [], commands: [], models: [], seq })
const ids = (sessionId = 's'): string[] => drawn(chatStore.getState().sessions[sessionId].items).map((i) => i.id)

let onItem: (m: { sessionId: string; item: ChatItem; seq: number }) => void
let onMeta: (m: { sessionId: string; meta: ChatMeta; seq: number }) => void
/** The history calls waiting for an answer, by session. */
let asked: Array<{ sessionId: string; answer: (h: ChatHistory) => void; fail: (e: Error) => void }>
let disconnect: () => void

beforeEach(() => {
  asked = []
  const off = vi.fn()
  vi.stubGlobal('window', {
    torno: {
      chat: {
        history: (sessionId: string) => new Promise<ChatHistory>((answer, fail) => asked.push({ sessionId, answer, fail })),
        onItem: (cb: typeof onItem) => ((onItem = cb), off),
        onMeta: (cb: typeof onMeta) => ((onMeta = cb), off)
      }
    }
  })
  chatActions.dropAll()
  disconnect = connectChat()
})

afterEach(() => {
  disconnect()
  vi.unstubAllGlobals()
})

/** A session whose history is in: `items` at `seq`. */
async function loaded(items: ChatItem[], seq: number, sessionId = 's'): Promise<void> {
  const loading = chatActions.load(sessionId)
  asked.at(-1)!.answer(history(items, seq))
  await loading
}

describe('the items of a chat session in the window', () => {
  it('are what history says, and an item after it is added, or replaces the one of its id in its place', async () => {
    await loaded([user(1), text(2, 'hel', true)], 2)
    onItem({ sessionId: 's', item: text(2, 'hello', true), seq: 3 })
    onItem({ sessionId: 's', item: turn(3), seq: 4 })
    expect(chatStore.getState().sessions.s.items).toEqual([user(1), text(2, 'hello', true), turn(3)])
    expect(chatStore.getState().sessions.s.seq).toBe(4)
  })

  it('ignore what the history held already: an item or a meta whose seq is not above it', async () => {
    await loaded([user(1), text(2, 'whole')], 5)
    onItem({ sessionId: 's', item: text(2, 'wh', true), seq: 5 })
    onItem({ sessionId: 's', item: text(2, 'old'), seq: 3 })
    onMeta({ sessionId: 's', meta: { model: 'old' }, seq: 4 })
    expect(chatStore.getState().sessions.s.items[1]).toEqual(text(2, 'whole'))
    expect(chatStore.getState().sessions.s.meta).toEqual({})
    onMeta({ sessionId: 's', meta: { model: 'haiku' }, seq: 6 })
    expect(chatStore.getState().sessions.s.meta).toEqual({ model: 'haiku' })
  })

  it('lose no item that comes before the history is answered: it is kept, and merged by seq', async () => {
    const loading = chatActions.load('s')
    onItem({ sessionId: 's', item: text(2, 'in the history'), seq: 3 })
    onItem({ sessionId: 's', item: turn(3), seq: 4 })
    onMeta({ sessionId: 's', meta: { model: 'fake' }, seq: 5 })
    asked[0].answer(history([user(1), text(2, 'in the history')], 3))
    await loading
    expect(ids()).toEqual(['s-i1', 's-i2', 's-i3'])
    expect(chatStore.getState().sessions.s).toMatchObject({ seq: 5, meta: { model: 'fake' }, loading: false })
  })

  it('are not asked for twice while the history is on its way', async () => {
    const first = chatActions.load('s')
    void chatActions.load('s')
    expect(asked).toHaveLength(1)
    asked[0].answer(history([], 0))
    await first
    // Nor once they are in.
    await chatActions.load('s')
    expect(asked).toHaveLength(1)
  })

  it('are ignored for a session the window has not asked about', () => {
    onItem({ sessionId: 'other', item: user(1), seq: 1 })
    expect(chatStore.getState().sessions.other).toBeUndefined()
  })

  it('keep the history of the session shown for the commands, the models and the earlier turns', async () => {
    const loading = chatActions.load('s')
    asked[0].answer({ ...history([], 0), earlier: [user(9)], commands: [{ name: 'compact', description: 'd', argumentHint: '' }], models: [{ value: 'haiku', displayName: 'Haiku' }] })
    await loading
    expect(chatStore.getState().sessions.s).toMatchObject({ earlier: [user(9)], commands: [{ name: 'compact' }], models: [{ value: 'haiku' }] })
  })

  it('say why when the history cannot be had, and are asked for again by the next load', async () => {
    const loading = chatActions.load('s')
    asked[0].fail(new Error('There is no such conversation'))
    await loading
    expect(chatStore.getState().sessions.s).toMatchObject({ loading: false, failed: 'There is no such conversation' })
    void chatActions.load('s')
    expect(asked).toHaveLength(2)
  })

  it('are dropped for a session, and for all when the workspace closes', async () => {
    await loaded([user(1)], 1, 'a')
    await loaded([user(1)], 1, 'b')
    chatActions.drop('a')
    expect(Object.keys(chatStore.getState().sessions)).toEqual(['b'])
    chatActions.dropAll()
    expect(chatStore.getState().sessions).toEqual({})
  })
})

describe('the order the items are drawn in', () => {
  it('has a prompt that is queued after everything else, in the order they were made', async () => {
    await loaded([user(1), text(2), user(3, 'queued'), user(4, 'queued')], 4)
    onItem({ sessionId: 's', item: text(5), seq: 5 })
    onItem({ sessionId: 's', item: turn(6), seq: 6 })
    expect(ids()).toEqual(['s-i1', 's-i2', 's-i5', 's-i6', 's-i3', 's-i4'])
  })

  it('moves a prompt to the end when the CLI takes it up, as main orders it', async () => {
    await loaded([user(1), text(2), user(3, 'queued'), user(4, 'queued')], 4)
    onItem({ sessionId: 's', item: turn(5), seq: 5 })
    onItem({ sessionId: 's', item: user(3, 'sent'), seq: 6 })
    onItem({ sessionId: 's', item: text(6), seq: 7 })
    // History at that point, as main has it: the queued one last, the one taken up just before its own turn.
    expect(ids()).toEqual(['s-i1', 's-i2', 's-i5', 's-i3', 's-i6', 's-i4'])
  })

  it('puts a prompt that was not sent back where it was made', async () => {
    await loaded([user(1), text(2), user(3, 'queued')], 3)
    onItem({ sessionId: 's', item: turn(4), seq: 4 })
    onItem({ sessionId: 's', item: user(3, 'not-sent'), seq: 5 })
    expect(ids()).toEqual(['s-i1', 's-i2', 's-i3', 's-i4'])
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../shared/chat'
import type { StreamMessage } from './stream'
import { Transcript } from './transcript'

// The reducer, fed what Claude Code 2.1.300 printed (app/test/fixtures/claude-stream.jsonl) and what torno itself
// records (a prompt sent, a hook answered, a permission asked, a session ended).
const FIXTURE: StreamMessage[] = readFileSync(join(__dirname, '../../../test/fixtures/claude-stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as StreamMessage)

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const text = (t: string) => [{ type: 'text' as const, text: t }]

/** The lines of the fixture, with a prompt sent before each of its three `init`s, as the manager would have. */
function playFixture(t: Transcript, lines: StreamMessage[] = FIXTURE): void {
  const prompts = ['read note.txt', 'write probe.txt', 'count to 200']
  for (const line of lines) {
    if (line.type === 'system' && line.subtype === 'init') {
      const next = prompts.shift()
      if (next !== undefined) t.userSent(text(next), false)
    }
    t.message(line)
  }
}

const stream = (event: object): StreamMessage => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null })
const start = (index: number, block: object): StreamMessage => stream({ type: 'content_block_start', index, content_block: block })
const delta = (index: number, d: object): StreamMessage => stream({ type: 'content_block_delta', index, delta: d })
const stop = (index: number): StreamMessage => stream({ type: 'content_block_stop', index })
const assistant = (content: object[], id = 'msg_1'): StreamMessage => ({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null })
const toolUse = (id: string, name: string, input: unknown = {}): StreamMessage => assistant([{ type: 'tool_use', id, name, input }])
const toolResult = (id: string, content: unknown, extra: object = {}): StreamMessage => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, parent_tool_use_id: null })
const init = (extra: object = {}): StreamMessage => ({ type: 'system', subtype: 'init', model: 'm1', mcp_servers: [{ name: 'torno', status: 'connected' }], ...extra })
const result = (extra: object = {}): StreamMessage => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1500, ...extra })

const of = <K extends ChatItem['kind']>(t: Transcript, kind: K): Array<Extract<ChatItem, { kind: K }>> => t.items().filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind)

afterEach(() => {
  vi.useRealTimers()
})

describe('a recorded conversation', () => {
  it('becomes the prompts, the tools, the replies and the end of each turn', () => {
    const t = new Transcript({ now: () => 1000 })
    playFixture(t)
    const shown = t.items().filter((i) => i.kind !== 'thinking')
    expect(shown.map((i) => i.kind)).toEqual(['user', 'tool', 'text', 'turn', 'user', 'tool', 'text', 'turn', 'user', 'tool', 'turn'])
    const [user1, bash, reply, turn1, , write, , turn2, , seq, turn3] = shown as [ChatItem, ...ChatItem[]]
    expect(user1).toMatchObject({ kind: 'user', text: 'read note.txt', state: 'sent', images: [] })
    expect(bash).toMatchObject({ kind: 'tool', name: 'Bash', torno: false, input: { command: 'cat note.txt' }, state: 'done', result: 'hello', images: [] })
    expect(reply).toMatchObject({ kind: 'text', streaming: false })
    expect((reply as { text: string }).text).toMatch(/^`note.txt` contains only `hello`/)
    expect((reply as { text: string }).text).toMatch(/not from `note.txt`\.$/)
    expect(turn1).toMatchObject({ kind: 'turn', ok: true, stopped: false, seconds: 5.1, pulled: {} })
    expect(write).toMatchObject({ name: 'Write', state: 'done', input: { file_path: '/work/obj/probe.txt', content: 'probe' } })
    expect(turn2).toMatchObject({ ok: true, stopped: false })
    // The recording's command had finished when the person interrupted: its result is in, the turn is what stopped.
    expect(seq).toMatchObject({ name: 'Bash', input: { command: 'seq 1 200' }, state: 'done' })
    expect((seq as { result: string }).result.startsWith('1\n2\n3')).toBe(true)
    expect(turn3).toMatchObject({ kind: 'turn', ok: false, stopped: true })
    expect((turn3 as { error?: string }).error).toBeUndefined()
  })

  it('shows the thoughts as done, without a text, and nothing is left streaming', () => {
    const t = new Transcript({ now: () => 1000 })
    playFixture(t)
    const thoughts = of(t, 'thinking')
    expect(thoughts.length).toBeGreaterThan(0)
    expect(thoughts.every((i) => !i.streaming)).toBe(true)
    expect(t.items().some((i) => (i.kind === 'text' || i.kind === 'thinking') && i.streaming)).toBe(false)
  })

  it('is the same with types and fields it does not know spliced in', () => {
    const spliced: StreamMessage[] = []
    FIXTURE.forEach((line, n) => {
      const clone = JSON.parse(JSON.stringify(line)) as StreamMessage
      clone.from_the_future = { deeper: [1, 2, { x: null }] }
      if (clone.type === 'stream_event') (clone.event as Record<string, unknown>).novelty = true
      spliced.push(clone)
      if (n % 3 === 0) spliced.push({ type: 'from_the_future', n })
      if (n % 5 === 0) spliced.push({ type: 'system', subtype: 'something_new', n })
      if (n % 7 === 0) spliced.push(stream({ type: 'brand_new_event', index: 99 }))
      if (n % 11 === 0) spliced.push(stream({ type: 'content_block_start', index: 50, content_block: { type: 'server_tool_use_v9', id: 'x' } }))
      if (n % 13 === 0) spliced.push({ type: 'assistant', message: { id: 'msg_x', content: [{ type: 'a_block_nobody_knows', foo: 1 }] } })
      if (n % 17 === 0) spliced.push({ type: 'user', message: { content: [{ type: 'a_block_nobody_knows' }] } })
      if (n % 19 === 0) spliced.push({ type: 'user' }, { type: 'assistant' })
    })
    const plain = new Transcript({ now: () => 1000 })
    playFixture(plain)
    const odd = new Transcript({ now: () => 1000 })
    // The same prompts, at the same inits: the spliced lines are not inits.
    const prompts = ['read note.txt', 'write probe.txt', 'count to 200']
    for (const line of spliced) {
      if (line.type === 'system' && line.subtype === 'init') {
        const next = prompts.shift()
        if (next !== undefined) odd.userSent(text(next), false)
      }
      odd.message(line)
    }
    const ids = (items: ChatItem[]): unknown[] => items.map(({ id: _id, ...rest }) => rest)
    expect(ids(odd.items())).toEqual(ids(plain.items()))
  })

  it('does not throw for lines that are not what they should be', () => {
    const t = new Transcript()
    const odd: unknown[] = [{ type: 'assistant', message: null }, { type: 'assistant', message: { content: 'text' } }, { type: 'user', message: { content: null } }, { type: 'user', message: { content: [null, 3, 'x', { type: 'tool_result' }] } }, { type: 'stream_event' }, { type: 'stream_event', event: null }, { type: 'stream_event', event: { type: 'content_block_delta' } }, { type: 'stream_event', event: { type: 'content_block_delta', index: 'a', delta: 4 } }, { type: 'system' }, { type: 'result', usage: 5 }, { type: 'rate_limit_event', rate_limit_info: 4 }, { type: 'system', subtype: 'init', mcp_servers: 'x', model: 4 }]
    for (const line of odd) expect(() => t.message(line as StreamMessage)).not.toThrow()
  })
})

describe('streaming', () => {
  it('has the text as soon as its first word comes, growing, and whole when the block ends', () => {
    const t = new Transcript()
    t.message(init())
    t.message(stream({ type: 'message_start', message: { id: 'msg_1' } }))
    t.message(start(1, { type: 'text', text: '' }))
    expect(of(t, 'text')).toEqual([])
    const [first] = t.message(delta(1, { type: 'text_delta', text: 'Hel' }))
    expect(first).toMatchObject({ kind: 'text', text: 'Hel', streaming: true })
    t.message(delta(1, { type: 'text_delta', text: 'lo' }))
    expect(of(t, 'text')).toMatchObject([{ text: 'Hello', streaming: true }])
    t.message(assistant([{ type: 'text', text: 'Hello there' }]))
    expect(of(t, 'text')).toMatchObject([{ text: 'Hello there', streaming: false }])
    t.message(stop(1))
    expect(of(t, 'text')).toHaveLength(1)
  })

  it('makes one item of the text of a message that was not streamed', () => {
    const t = new Transcript()
    t.message(assistant([{ type: 'text', text: 'all at once' }], 'msg_9'))
    expect(of(t, 'text')).toMatchObject([{ text: 'all at once', streaming: false }])
  })

  it('shows a tool as soon as it starts, running, and fills in its input when the block ends', () => {
    const t = new Transcript()
    t.message(start(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }))
    expect(of(t, 'tool')).toMatchObject([{ toolUseId: 'toolu_1', name: 'Bash', state: 'running', input: {} }])
    t.message(delta(0, { type: 'input_json_delta', partial_json: '{"command": "ls' }))
    t.message(delta(0, { type: 'input_json_delta', partial_json: ' -l"}' }))
    t.message(stop(0))
    expect(of(t, 'tool')).toMatchObject([{ input: { command: 'ls -l' }, state: 'running' }])
    t.message(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -l' } }]))
    expect(of(t, 'tool')).toHaveLength(1)
  })

  it('keeps the blocks of two messages apart even when their indexes are the same', () => {
    const t = new Transcript()
    t.message(stream({ type: 'message_start', message: { id: 'msg_a' } }))
    t.message(start(0, { type: 'text', text: '' }))
    t.message(delta(0, { type: 'text_delta', text: 'first' }))
    t.message(stop(0))
    t.message(stream({ type: 'message_stop' }))
    t.message(stream({ type: 'message_start', message: { id: 'msg_b' } }))
    t.message(start(0, { type: 'text', text: '' }))
    t.message(delta(0, { type: 'text_delta', text: 'second' }))
    expect(of(t, 'text')).toMatchObject([{ text: 'first', streaming: false }, { text: 'second', streaming: true }])
  })

  it('passes over the stream of a subagent: its whole messages are what it shows', () => {
    const t = new Transcript()
    t.message({ ...start(0, { type: 'text', text: '' }), parent_tool_use_id: 'toolu_task' })
    t.message({ ...delta(0, { type: 'text_delta', text: 'inner' }), parent_tool_use_id: 'toolu_task' })
    expect(t.items()).toEqual([])
  })

  it('tells the thought how long it took', () => {
    let now = 1000
    const t = new Transcript({ now: () => now })
    t.message(start(0, { type: 'thinking', thinking: '' }))
    expect(of(t, 'thinking')).toMatchObject([{ streaming: true }])
    now = 3500
    t.message(stop(0))
    expect(of(t, 'thinking')).toMatchObject([{ streaming: false, seconds: 2.5 }])
  })
})

describe('what is sent', () => {
  it('is a user item, sent at once or queued until the CLI takes it up', () => {
    const t = new Transcript({ now: () => 7 })
    const now = t.userSent(text('first'), false)
    const later = t.userSent([...text('second'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }], true)
    expect(now).toMatchObject({ kind: 'user', text: 'first', state: 'sent', at: 7 })
    expect(later).toMatchObject({ text: 'second', state: 'queued', images: [{ mediaType: 'image/png', data: PNG_1X1, width: 1, height: 1 }] })
    // The first init is of the first prompt, which was never queued.
    t.message(init())
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'queued'])
    t.message(init())
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'sent'])
  })

  it('stays queued through an init until its own: one queued prompt becomes sent for each init', () => {
    const t = new Transcript()
    t.userSent(text('a'), true)
    t.userSent(text('b'), true)
    t.message(init())
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'queued'])
    t.message(init())
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'sent'])
  })

  it('drops the prompts the CLI dropped, all but as many as it says are still queued', () => {
    const t = new Transcript()
    t.userSent(text('a'), true)
    const b = t.userSent(text('b'), true)
    const c = t.userSent(text('c'), true)
    const changed = t.dropQueued(1)
    expect(changed.map((i) => i.id)).toEqual([b.id, c.id])
    // Those that will not be sent are no longer queued, so they no longer come last.
    expect(of(t, 'user').map((u) => u.state)).toEqual(['not-sent', 'not-sent', 'queued'])
  })

  it('puts the context of each hook under its own prompt, however quickly the prompts were sent', () => {
    const t = new Transcript()
    const a = t.userSent(text('first'), false)
    const b = t.userSent(text('second'), true)
    t.context({ text: 'build r1, M1', sentMarkIds: ['M1'] })
    t.context({ text: 'build r2, M2 M3', sentMarkIds: ['M2', 'M3'] })
    expect(of(t, 'context')).toMatchObject([
      { forUser: a.id, text: 'build r1, M1', marks: ['M1'] },
      { forUser: b.id, text: 'build r2, M2 M3', marks: ['M2', 'M3'] }
    ])
  })

  it('knows which prompt a hook is for by the prompt it names, when a prompt had no hook', () => {
    const t = new Transcript()
    t.userSent(text('/noop'), false)
    const b = t.userSent(text('real one'), false)
    t.context({ text: 'ctx', sentMarkIds: [], prompt: 'real one' })
    expect(of(t, 'context')).toMatchObject([{ forUser: b.id }])
  })

  it('keeps the build and the selection the context named, as fields of the item', () => {
    const t = new Transcript()
    t.userSent(text('go'), false)
    t.context({ text: 'ctx', sentMarkIds: ['M1'], revision: 4, buildState: 'ok', selection: ['lid/F1', 'tub/E2'] })
    expect(of(t, 'context')[0]).toMatchObject({ marks: ['M1'], revision: 4, buildState: 'ok', selection: ['lid/F1', 'tub/E2'] })
    t.userSent(text('again'), false)
    t.context({ text: 'ctx', sentMarkIds: [] })
    expect(of(t, 'context')[1]).not.toHaveProperty('revision')
    expect(of(t, 'context')[1]).not.toHaveProperty('selection')
  })

  it('shows nothing for a prompt that nothing was added to, and that prompt is not waited for again', () => {
    const t = new Transcript()
    t.userSent(text('first'), false)
    const b = t.userSent(text('second'), false)
    expect(t.context({ text: '', sentMarkIds: [] })).toBeNull()
    expect(t.context({ text: 'ctx', sentMarkIds: ['M1'] })).toMatchObject({ forUser: b.id })
    expect(t.context({ text: 'orphan', sentMarkIds: [] })).toBeNull()
    expect(of(t, 'context')).toHaveLength(1)
  })
})

describe('the tools of torno', () => {
  it('have a picture in the flat form an MCP server answers with, as well as in the CLI\'s own', () => {
    const t = new Transcript()
    t.message(init())
    t.message(toolUse('toolu_look', 'mcp__torno__look', { view: 'iso' }))
    t.message(toolResult('toolu_look', [{ type: 'text', text: 'iso view of r3' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }]))
    t.message(result())
    const [look] = of(t, 'tool')
    expect(look.images).toHaveLength(1)
    expect(look.images[0]).toMatchObject({ mediaType: 'image/png', data: PNG_1X1, width: 1, height: 1 })
    expect(of(t, 'turn')[0].pulled).toEqual({ look: 1, pictures: 1 })
  })

  it('are torno\'s, with their pictures and what the turn pulled', () => {
    const t = new Transcript()
    t.message(init())
    t.message(toolUse('toolu_look', 'mcp__torno__look', { view: 'iso' }))
    t.message(toolResult('toolu_look', [{ type: 'text', text: 'iso view of r3' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }]))
    t.message(toolUse('toolu_scene', 'mcp__torno__scene'))
    t.message(toolResult('toolu_scene', '{"parts":[]}'))
    t.message(toolUse('toolu_bash', 'Bash', { command: 'ls' }))
    t.message(toolResult('toolu_bash', 'a'))
    t.message(result())
    const [look, scene, bash] = of(t, 'tool')
    expect(look).toMatchObject({ torno: true, name: 'mcp__torno__look', state: 'done', result: 'iso view of r3' })
    expect(look.images).toHaveLength(2)
    expect(look.images[0]).toMatchObject({ mediaType: 'image/png', data: PNG_1X1, width: 1, height: 1 })
    expect(look.images[0].id).not.toBe(look.images[1].id)
    expect(scene).toMatchObject({ torno: true, result: '{"parts":[]}', images: [] })
    expect(bash.torno).toBe(false)
    expect(of(t, 'turn')[0].pulled).toEqual({ look: 1, pictures: 2, scene: 1 })
  })

  it('count again for the next turn from nothing', () => {
    const t = new Transcript()
    t.message(toolUse('a', 'mcp__torno__measure'))
    t.message(toolResult('a', 'x'))
    t.message(result())
    t.message(toolUse('b', 'mcp__torno__measure'))
    t.message(toolResult('b', 'x'))
    t.message(toolUse('c', 'mcp__torno__measure'))
    t.message(toolResult('c', 'x'))
    t.message(result())
    expect(of(t, 'turn').map((turn) => turn.pulled)).toEqual([{ measure: 1 }, { measure: 2 }])
  })

  it('say when torno\'s tools are not connected, once', () => {
    const t = new Transcript()
    t.message(init({ mcp_servers: [{ name: 'torno', status: 'failed' }] }))
    t.message(init({ mcp_servers: [{ name: 'torno', status: 'failed' }] }))
    expect(t.meta().tornoConnected).toBe(false)
    expect(of(t, 'note')).toMatchObject([{ tone: 'warn' }])
    t.message(init())
    expect(t.meta().tornoConnected).toBe(true)
  })
})

describe('results', () => {
  it('are text, whether the CLI gives a string or blocks, and an error says so', () => {
    const t = new Transcript()
    t.message(toolUse('a', 'Bash', { command: 'x' }))
    t.message(toolResult('a', [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }], { is_error: true }))
    t.message(toolUse('b', 'Read', { file_path: 'f' }))
    t.message(toolResult('b', 'plain'))
    expect(of(t, 'tool')).toMatchObject([{ state: 'error', result: 'line 1\nline 2' }, { state: 'done', result: 'plain' }])
  })

  it('keep the structured result of the tool when it is small, and not when it is large', () => {
    const t = new Transcript()
    t.message(toolUse('a', 'Bash'))
    t.message({ ...toolResult('a', 'hello'), tool_use_result: { stdout: 'hello', interrupted: false } })
    t.message(toolUse('b', 'Bash'))
    t.message({ ...toolResult('b', 'big'), tool_use_result: { stdout: 'x'.repeat(100_000) } })
    const [a, b] = of(t, 'tool')
    expect(a.detail).toEqual({ stdout: 'hello', interrupted: false })
    expect(b.detail).toBeUndefined()
  })

  it('belong to the tool they name, wherever it is, and a result for none is passed over', () => {
    const t = new Transcript()
    t.message(toolResult('nobody', 'x'))
    expect(t.items()).toEqual([])
  })
})

describe('the end of a turn', () => {
  it('says how long it took, by the CLI\'s own clock', () => {
    const t = new Transcript()
    t.message(result({ duration_ms: 12_340 }))
    expect(of(t, 'turn')[0]).toMatchObject({ ok: true, stopped: false, seconds: 12.3 })
  })

  it('is stopped when the person interrupted it, and stops the tool that was running', () => {
    const t = new Transcript()
    t.message(toolUse('a', 'Bash', { command: 'sleep 99' }))
    t.message(start(0, { type: 'text', text: '' }))
    t.message(delta(0, { type: 'text_delta', text: 'working' }))
    t.message({ type: 'user', message: { role: 'user', content: text('[Request interrupted by user]') } })
    t.message(result({ subtype: 'error_during_execution', is_error: true }))
    expect(of(t, 'tool')[0].state).toBe('stopped')
    expect(of(t, 'text')[0].streaming).toBe(false)
    expect(of(t, 'turn')[0]).toMatchObject({ ok: false, stopped: true })
    expect(of(t, 'user')).toEqual([])
  })

  it('is failed, with the reason, when it was not interrupted', () => {
    const t = new Transcript()
    t.message(result({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }))
    t.message(result({ subtype: 'error_max_turns', is_error: true }))
    expect(of(t, 'turn')).toMatchObject([{ ok: false, stopped: false, error: 'boom' }, { ok: false, stopped: false, error: 'error_max_turns' }])
  })
})

describe('asking the person', () => {
  it('is an item that is open until it is answered', () => {
    const t = new Transcript()
    const open = t.asked({ requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, suggestions: [{ type: 'addRules' }] })
    expect(open).toMatchObject({ kind: 'ask', requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, suggestions: true, state: 'open' })
    expect(t.answered('req_1', 'allowed', 'ls')).toMatchObject({ id: open.id, state: 'allowed', answer: 'ls' })
    expect(t.answered('req_1', 'denied')).toBeNull()
    expect(t.answered('req_unknown', 'denied')).toBeNull()
    expect(t.asked({ requestId: 'req_2', toolName: 'Read', input: {} })).toMatchObject({ suggestions: false })
  })
})

describe('the end of the session', () => {
  it('closes everything that was open in a stated state, and says the session ended', () => {
    const t = new Transcript()
    t.userSent(text('sent'), false)
    t.userSent(text('queued'), true)
    t.message(start(0, { type: 'thinking', thinking: '' }))
    t.message(start(1, { type: 'text', text: '' }))
    t.message(delta(1, { type: 'text_delta', text: 'half a sent' }))
    t.message(toolUse('a', 'Bash', { command: 'sleep 99' }))
    t.asked({ requestId: 'req_1', toolName: 'Bash', input: { command: 'x' } })
    const changed = t.ended()
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'not-sent'])
    expect(of(t, 'thinking')[0].streaming).toBe(false)
    expect(of(t, 'text')[0]).toMatchObject({ text: 'half a sent', streaming: false })
    expect(of(t, 'tool')[0].state).toBe('stopped')
    expect(of(t, 'ask')[0].state).toBe('ended')
    expect(of(t, 'note').at(-1)).toMatchObject({ text: 'The session ended', tone: 'quiet' })
    expect(changed.length).toBe(6)
    expect(t.ended()).toEqual([])
  })

  it('takes in nothing after it', () => {
    const t = new Transcript()
    t.ended()
    const before = t.items().length
    t.message(toolUse('a', 'Bash'))
    t.userSent(text('late'), false)
    t.asked({ requestId: 'r', toolName: 'Bash', input: {} })
    expect(t.items()).toHaveLength(before + 1)
    expect(of(t, 'user')[0].state).toBe('not-sent')
  })
})

describe('what is kept', () => {
  it('drops the oldest item when there are more than it may hold', () => {
    const t = new Transcript({ maxItems: 5 })
    for (let n = 1; n <= 7; n++) t.message(assistant([{ type: 'text', text: `t${n}` }], `m${n}`))
    expect(of(t, 'text').map((i) => i.text)).toEqual(['t3', 't4', 't5', 't6', 't7'])
  })

  it('keeps the data of the newest pictures only, and tells of the item that lost it', () => {
    const changed: ChatItem[] = []
    const t = new Transcript({ maxImages: 3, emit: (item) => changed.push(item) })
    for (let n = 1; n <= 4; n++) {
      t.message(toolUse(`t${n}`, 'mcp__torno__look'))
      t.message(toolResult(`t${n}`, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }]))
    }
    const tools = of(t, 'tool')
    expect(tools.map((tool) => tool.images[0].data !== undefined)).toEqual([false, true, true, true])
    expect(tools[0].images[0]).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
    expect(changed.filter((i) => i.id === tools[0].id).at(-1)).toMatchObject({ images: [{ id: tools[0].images[0].id }] })
    expect((changed.filter((i) => i.id === tools[0].id).at(-1) as { images: Array<{ data?: string }> }).images[0].data).toBeUndefined()
  })

  it('does not change an item it has already handed out', () => {
    const t = new Transcript()
    const [first] = t.message(assistant([{ type: 'text', text: 'one' }]))
    const user = t.userSent(text('x'), true)
    t.ended()
    expect(first).toMatchObject({ kind: 'text', text: 'one' })
    expect((user as { state: string }).state).toBe('queued')
    expect(of(t, 'user')[0].state).toBe('not-sent')
  })
})

describe('the log', () => {
  it('has each item once, when it is final, in the order it was made, and not a thought', () => {
    const t = new Transcript()
    t.userSent(text('go'), false)
    t.message(init())
    t.message(start(0, { type: 'thinking', thinking: '' }))
    t.message(stop(0))
    t.message(start(1, { type: 'text', text: '' }))
    t.message(delta(1, { type: 'text_delta', text: 'hi' }))
    expect(t.toLog().map((i) => i.kind)).toEqual(['user'])
    t.message(stop(1))
    t.message(toolUse('a', 'Bash', { command: 'ls' }))
    expect(t.toLog().map((i) => i.kind)).toEqual(['text'])
    t.message(toolResult('a', 'ok'))
    t.message(result())
    t.asked({ requestId: 'r', toolName: 'Bash', input: {} })
    expect(t.toLog().map((i) => i.kind)).toEqual(['tool', 'turn'])
    t.answered('r', 'allowed')
    expect(t.toLog().map((i) => i.kind)).toEqual(['ask'])
    expect(t.toLog()).toEqual([])
  })

  it('has a prompt that was queued once it is sent, not before', () => {
    const t = new Transcript()
    t.userSent(text('queued'), true)
    expect(t.toLog()).toEqual([])
    t.message(init())
    expect(t.toLog().map((i) => i.kind)).toEqual(['user'])
  })

  it('has the items an end closed', () => {
    const t = new Transcript()
    t.userSent(text('queued'), true)
    t.message(toolUse('a', 'Bash'))
    t.ended()
    expect(t.toLog().map((i) => (i.kind === 'user' ? i.state : i.kind === 'tool' ? i.state : i.kind))).toEqual(['not-sent', 'stopped', 'note'])
  })
})

describe('meta', () => {
  it('is the model, and the most used window of the rate limit', () => {
    const metas: unknown[] = []
    const t = new Transcript({ emitMeta: (m) => metas.push(m) })
    t.message(init({ model: 'claude-haiku-5-5' }))
    t.message({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1792092000 }, seven_day: { utilization: 0.1, resetsAt: 1792652400 } } } })
    expect(t.meta()).toMatchObject({ model: 'claude-haiku-5-5', tornoConnected: true, rate: { window: 'seven_day', used: 10, resetsAt: 1792652400000 } })
    expect(metas.length).toBe(2)
    t.message({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.72 } } } })
    expect(t.meta().rate).toEqual({ window: 'five_hour', used: 72 })
  })

  it('does not say again what has not changed, and says a new model in a note', () => {
    const metas: unknown[] = []
    const t = new Transcript({ emitMeta: (m) => metas.push(m) })
    t.message(init())
    t.message(init())
    expect(metas).toHaveLength(1)
    expect(of(t, 'note')).toEqual([])
    t.message(init({ model: 'm2' }))
    expect(metas).toHaveLength(2)
    expect(of(t, 'note')).toMatchObject([{ text: 'Model: m2', tone: 'quiet' }])
  })
})

describe('what is told to the window', () => {
  it('is each item that changed, and the streaming text no more than once in 50 ms, with the last always going', () => {
    vi.useFakeTimers()
    const told: ChatItem[] = []
    const t = new Transcript({ emit: (item) => told.push(item), now: () => Date.now() })
    t.message(start(0, { type: 'text', text: '' }))
    for (const word of ['a', 'b', 'c', 'd']) {
      t.message(delta(0, { type: 'text_delta', text: word }))
      vi.advanceTimersByTime(10)
    }
    const texts = (): string[] => told.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text)
    expect(texts()).toEqual(['a'])
    vi.advanceTimersByTime(60)
    expect(texts()).toEqual(['a', 'abcd'])
    t.message(delta(0, { type: 'text_delta', text: 'e' }))
    t.message(stop(0))
    // The end of the block goes at once, with all the text, and nothing is sent after it.
    expect(told.at(-1)).toMatchObject({ text: 'abcde', streaming: false })
    vi.advanceTimersByTime(200)
    expect(told.at(-1)).toMatchObject({ text: 'abcde', streaming: false })
    expect(told.filter((i) => i.kind === 'text' && !i.streaming)).toHaveLength(1)
  })

  it('is told at once of anything else', () => {
    const told: ChatItem[] = []
    const t = new Transcript({ emit: (item) => told.push(item) })
    t.userSent(text('x'), false)
    t.message(toolUse('a', 'Bash'))
    t.message(toolResult('a', 'x'))
    expect(told.map((i) => i.kind)).toEqual(['user', 'tool', 'tool'])
  })
})

describe('an address the agent was given', () => {
  it('is taken out of everything the transcript holds', () => {
    const redact = (s: string): string => s.split('SECRET').join('<secret>')
    const t = new Transcript({ redact })
    t.userSent(text('see http://127.0.0.1:1/mcp/SECRET/obj'), false)
    t.message(start(0, { type: 'text', text: '' }))
    t.message(delta(0, { type: 'text_delta', text: 'it is SE' }))
    t.message(delta(0, { type: 'text_delta', text: 'CRET' }))
    t.message(toolUse('a', 'Bash', { command: 'ps | grep SECRET', nested: ['SECRET'] }))
    t.message({ ...toolResult('a', '--mcp-config SECRET'), tool_use_result: { stdout: 'SECRET' } })
    t.asked({ requestId: 'r', toolName: 'Bash', input: { command: 'SECRET' } })
    t.answered('r', 'allowed', 'SECRET')
    t.context({ text: 'SECRET', sentMarkIds: [] })
    t.note('SECRET', 'quiet')
    expect(JSON.stringify(t.items())).not.toContain('SECRET')
    expect(JSON.stringify(t.items())).toContain('<secret>')
  })
})

describe('fix round 1', () => {
  it('lists queued prompts last, and a prompt that is taken up moves to the end, before the items of its own turn', () => {
    const t = new Transcript()
    t.userSent(text('first'), false)
    t.userSent(text('second'), true)
    t.message(init())
    t.message(assistant([{ type: 'text', text: 'reply one' }], 'm1'))
    t.userSent(text('third'), true)
    expect(t.items().map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['first', 'text', 'second', 'third'])
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'queued', 'queued'])
    t.message(result())
    t.message(init())
    t.message(assistant([{ type: 'text', text: 'reply two' }], 'm2'))
    expect(t.items().map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['first', 'text', 'turn', 'second', 'text', 'third'])
    expect(of(t, 'user').map((u) => u.state)).toEqual(['sent', 'sent', 'queued'])
  })

  it('keeps no image data in the structured result, nor any when the result had pictures', () => {
    const t = new Transcript()
    t.message(toolUse('a', 'Read', { file_path: 'x.png' }))
    t.message({ ...toolResult('a', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }]), tool_use_result: { type: 'image', file: { base64: PNG_1X1, type: 'image/png' } } })
    t.message(toolUse('b', 'Read', { file_path: 'y' }))
    t.message({ ...toolResult('b', 'text'), tool_use_result: { file: { base64: PNG_1X1, name: 'y' }, nested: [{ data: PNG_1X1, keep: 'me' }] } })
    const [a, b] = of(t, 'tool')
    expect(a.detail).toBeUndefined()
    expect(b.detail).toEqual({ file: { name: 'y' }, nested: [{ keep: 'me' }] })
  })

  it('does not wait for a prompt the CLI dropped when a hook comes', () => {
    const t = new Transcript()
    t.userSent(text('first'), false)
    const b = t.userSent(text('kept'), true)
    t.userSent(text('dropped'), true)
    t.dropQueued(1)
    t.context({ text: 'x', sentMarkIds: [] })
    expect(t.context({ text: 'ctx', sentMarkIds: ['M1'], prompt: 'unrelated' })).toMatchObject({ forUser: b.id })
    expect(t.context({ text: 'late', sentMarkIds: [] })).toBeNull()
  })

  it('hands the log only what changed, however many items there are', () => {
    const t = new Transcript()
    for (let n = 0; n < 500; n++) t.message(assistant([{ type: 'text', text: `t${n}` }], `m${n}`))
    expect(t.toLog()).toHaveLength(500)
    t.message(assistant([{ type: 'text', text: 'one more' }], 'mx'))
    expect(t.toLog().map((i) => (i as { text: string }).text)).toEqual(['one more'])
    expect(t.toLog()).toEqual([])
  })

  it('sends a prompt still queued when the session goes idle', () => {
    const t = new Transcript()
    t.userSent(text('a'), true)
    expect(t.idle().map((i) => (i as { state: string }).state)).toEqual(['sent'])
    t.message(init())
    expect(of(t, 'user')[0].state).toBe('sent')
    expect(t.idle()).toEqual([])
  })
})

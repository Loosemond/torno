import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeStream, type StreamAsk, type StreamMessage } from './stream'

// The stream as the CLI's side of it: small node scripts stand in for the process, one per case, and say what the
// framing, the requests and the answers have to meet.
const dir = mkdtempSync(join(tmpdir(), 'torno-stream-'))
let files = 0
const made: ClaudeStream[] = []

/** A stream on a node script: `body` is the program of the stand-in CLI. */
function open(body: string, opts: { maxLine?: number } = {}) {
  files += 1
  const file = join(dir, `cli-${files}.mjs`)
  writeFileSync(file, body)
  const stream = new ClaudeStream({ command: process.execPath, args: [file], cwd: dir, env: { PATH: process.env.PATH ?? '' }, ...opts })
  made.push(stream)
  const messages: StreamMessage[] = []
  const asks: StreamAsk[] = []
  const notes: string[] = []
  const exits: Array<[number | null, string | null]> = []
  stream.on('message', (m) => messages.push(m))
  stream.on('ask', (a) => asks.push(a))
  stream.on('note', (n) => notes.push(n))
  stream.on('exit', (code, signal) => exits.push([code, signal]))
  return { stream, messages, asks, notes, exits, types: () => messages.map((m) => m.type) }
}

/** The stand-in CLI that says back every line it is given, as `{ type: 'echo', line }`. */
const ECHO = `
import { createInterface } from 'node:readline'
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => out({ type: 'echo', line })).on('close', () => process.exit(0))
`

afterEach(() => {
  for (const stream of made.splice(0)) stream.end()
})

describe('the framing of what the CLI prints', () => {
  it('reads a line that comes in two chunks, and several that come in one', async () => {
    const cli = open(`
      const w = (s) => process.stdout.write(s)
      w('{"type":"a","n":1}\\n{"ty')
      setTimeout(() => { w('pe":"b"}\\n{"type":"c"}\\n{"type":"d"}\\n'); process.exit(0) }, 50)
    `)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.messages).toEqual([{ type: 'a', n: 1 }, { type: 'b' }, { type: 'c' }, { type: 'd' }])
    expect(cli.notes).toEqual([])
  })

  it('does not break a character of more than one byte that is split between two chunks', async () => {
    const cli = open(`
      const line = Buffer.from(JSON.stringify({ type: 'text', text: 'a café ☕' }) + '\\n')
      const at = line.indexOf(Buffer.from('é')) + 1
      process.stdout.write(line.subarray(0, at))
      setTimeout(() => { process.stdout.write(line.subarray(at)); process.exit(0) }, 50)
    `)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.messages).toEqual([{ type: 'text', text: 'a café ☕' }])
  })

  it('goes on after a line that is no JSON, or no object with a type: a note, never an error', async () => {
    const cli = open(`
      process.stdout.write('warning: something the CLI prints\\n\\n  \\n[1,2]\\n{"no":"type"}\\n{"type":7}\\n{"type":"ok"}\\n')
      process.exit(0)
    `)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.messages).toEqual([{ type: 'ok' }])
    expect(cli.notes).toHaveLength(4)
    expect(cli.notes[0]).toContain('warning: something the CLI prints')
  })

  it('drops a line over the limit with a note, and reads the next one', async () => {
    const cli = open(
      `
      const w = (s) => process.stdout.write(s)
      w('{"type":"big","pad":"' + 'x'.repeat(300))
      setTimeout(() => { w('x'.repeat(300) + '"}\\n{"type":"after"}\\n'); process.exit(0) }, 50)
    `,
      { maxLine: 200 }
    )
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.types()).toEqual(['after'])
    expect(cli.notes).toHaveLength(1)
    expect(cli.notes[0]).toMatch(/too long/)
  })

  it('reads a line of megabytes whole, below the limit', async () => {
    const cli = open(`process.stdout.write(JSON.stringify({ type: 'result', pad: 'y'.repeat(3_000_000) }) + '\\n')`)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.types()).toEqual(['result'])
    expect((cli.messages[0].pad as string).length).toBe(3_000_000)
  })

  it('goes on reading when a listener throws: the throw is a note', async () => {
    const cli = open(`
      const w = (s) => process.stdout.write(s)
      w('{"type":"a"}\\n')
      setTimeout(() => { w('{"type":"b"}\\n{"type":"c"}\\n'); process.exit(0) }, 50)
    `)
    cli.stream.on('message', (m) => {
      if (m.type === 'a') throw new Error('boom')
    })
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.types()).toEqual(['a', 'b', 'c'])
    expect(cli.notes.some((n) => n.includes('boom'))).toBe(true)
  })

  it('reads the last line though it has no line break', async () => {
    const cli = open(`process.stdout.write('{"type":"one"}\\n{"type":"last"}'); process.exit(0)`)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.types()).toEqual(['one', 'last'])
  })

  it('says how it ended', async () => {
    const cli = open(`process.exit(3)`)
    await new Promise<void>((resolve) => cli.stream.on('exit', () => resolve()))
    expect(cli.exits).toEqual([[3, null]])
  })
})

describe('what is written to the CLI', () => {
  it('writes a prompt as one user line, text and images', async () => {
    const cli = open(ECHO)
    cli.stream.prompt([{ type: 'text', text: 'make it 5 mm thicker' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], 'conv-1')
    await expect.poll(() => cli.messages.length).toBe(1)
    expect(cli.messages[0].line).toBe(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"make it 5 mm thicker"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"parent_tool_use_id":null,"session_id":"conv-1"}'
    )
  })

  it('writes the answer to a request of the CLI as the exact control_response', async () => {
    const cli = open(ECHO)
    cli.stream.answer('req_9', { behavior: 'allow', updatedInput: { command: 'ls' } })
    cli.stream.answer('req_10', { behavior: 'allow', updatedInput: {}, updatedPermissions: [{ type: 'addRules' }] })
    cli.stream.answer('req_11', { behavior: 'deny', message: 'not that' })
    await expect.poll(() => cli.messages.length).toBe(3)
    expect(cli.messages.map((m) => m.line)).toEqual([
      '{"type":"control_response","response":{"subtype":"success","request_id":"req_9","response":{"behavior":"allow","updatedInput":{"command":"ls"}}}}',
      '{"type":"control_response","response":{"subtype":"success","request_id":"req_10","response":{"behavior":"allow","updatedInput":{},"updatedPermissions":[{"type":"addRules"}]}}}',
      '{"type":"control_response","response":{"subtype":"success","request_id":"req_11","response":{"behavior":"deny","message":"not that"}}}'
    ])
  })

  it('ends when its stdin does: end() closes it, and the CLI leaves by itself', async () => {
    const cli = open(ECHO)
    cli.stream.end()
    await expect.poll(() => cli.exits.length).toBe(1)
    expect(cli.exits[0]).toEqual([0, null])
    // Writing to what has ended is not an error.
    expect(() => cli.stream.prompt([{ type: 'text', text: 'late' }], 'c')).not.toThrow()
    expect(() => cli.stream.end()).not.toThrow()
  })
})

describe('requests', () => {
  /** A CLI that answers a control request by the text of its subtype, after a decoy answer to another id. */
  const ANSWERS = `
    import { createInterface } from 'node:readline'
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
    createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line)
      if (m.type !== 'control_request') return
      const id = m.request_id
      const kind = m.request.subtype
      if (kind === 'silent') return
      out({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: { wrong: true } } })
      if (kind === 'fail') out({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'no such model' } })
      else out({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { sent: m.request } } })
    })
  `

  it('resolves a control request with the response of its own request_id, and no other', async () => {
    const cli = open(ANSWERS)
    expect(await cli.stream.control({ subtype: 'set_model', model: 'haiku' })).toEqual({ sent: { subtype: 'set_model', model: 'haiku' } })
    // An answer that was nobody's request is a message, not a resolution.
    expect(cli.messages.map((m) => (m.response as { request_id: string }).request_id)).toEqual(['someone-else'])
    const both = await Promise.all([cli.stream.control({ subtype: 'a' }), cli.stream.control({ subtype: 'b' })])
    expect(both).toEqual([{ sent: { subtype: 'a' } }, { sent: { subtype: 'b' } }])
  })

  it('rejects with the CLI\'s error', async () => {
    const cli = open(ANSWERS)
    await expect(cli.stream.control({ subtype: 'fail' })).rejects.toThrow('no such model')
  })

  it('rejects at the time limit, and a late answer is harmless', async () => {
    const cli = open(ANSWERS)
    await expect(cli.stream.control({ subtype: 'silent' }, 50)).rejects.toThrow(/did not answer/)
    expect(await cli.stream.control({ subtype: 'x' })).toEqual({ sent: { subtype: 'x' } })
  })

  it('rejects what is waiting when the CLI exits, and what is asked after it', async () => {
    const cli = open(ANSWERS)
    const waiting = cli.stream.control({ subtype: 'silent' }, 5_000)
    cli.stream.end()
    await expect(waiting).rejects.toThrow(/exited|ended/)
    await expect(cli.stream.control({ subtype: 'late' })).rejects.toThrow(/exited|ended/)
  })

  it('hands a can_use_tool request over as an ask, not as a message, and refuses the other requests of the CLI', async () => {
    const cli = open(`
      import { createInterface } from 'node:readline'
      const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
      out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1', permission_suggestions: [{ type: 'addRules' }], description: 'List it', blocked_path: '/work/x' } })
      out({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } })
      out({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} } })
      createInterface({ input: process.stdin }).on('line', (line) => out({ type: 'echo', line }))
    `)
    await expect.poll(() => cli.asks.length).toBe(2)
    expect(cli.asks).toEqual([
      { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', suggestions: [{ type: 'addRules' }], description: 'List it', blockedPath: '/work/x' },
      { requestId: 'r3', toolName: 'Read', input: {} }
    ])
    await expect.poll(() => cli.messages.length).toBe(1)
    expect(cli.messages[0].line).toBe('{"type":"control_response","response":{"subtype":"error","request_id":"r2","error":"not supported"}}')
  })

  it('writes a request with its id and its fields, as the CLI expects it', async () => {
    const cli = open(ECHO)
    void cli.stream.control({ subtype: 'interrupt' }, 50).catch(() => undefined)
    await expect.poll(() => cli.messages.length).toBe(1)
    expect(JSON.parse(cli.messages[0].line as string)).toEqual({ type: 'control_request', request_id: expect.stringMatching(/^req_/), request: { subtype: 'interrupt' } })
  })
})

it('has the pid of the process', () => {
  const cli = open(ECHO)
  expect(cli.stream.pid).toBeGreaterThan(1)
})

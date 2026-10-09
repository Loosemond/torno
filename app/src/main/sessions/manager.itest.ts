import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { type HttpRouter, startHttp } from '../http'
import { claudeAdapter } from './claude'
import { killGroup, Sessions } from './manager'

// The session manager with a real PTY and a real HTTP server; only the agent is
// a stand-in (test/fake-agent.mjs), launched with Claude Code's arguments.
const FAKE = resolve(__dirname, '../../../test/fake-agent.mjs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let root: string
let http: HttpRouter
let sessions: Sessions
let context = (id: string) => `context for ${id}`
/** By object: the marks its next prompt would tell of. What was delivered is taken out, as the store would. */
let drafts = new Map<string, string[]>()
let delivered: Array<{ objectId: string; sentMarkIds: string[] }> = []
/** Each time the context of a prompt was asked for: of which object, and whether in a conversation that had not been given one. */
let asked: Array<{ objectId: string; fresh: boolean }> = []
/** What the context waits for before it is given, and what is told when it is asked for. */
let gate: Promise<void> = Promise.resolve()
let asking: (() => void) | null = null
let output = new Map<string, string>()
let statuses = new Map<string, SessionStatus[]>()

function object(id: string): ObjectInfo {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  return { id, name: id, dir, model: null }
}

function make(command = `node ${FAKE}`): Sessions {
  const made = new Sessions({
    http,
    adapter: claudeAdapter(command),
    contextFor: async (id, opts) => {
      asking?.()
      asked.push({ objectId: id, fresh: opts.fresh })
      await gate
      return { text: context(id), sentMarkIds: drafts.get(id) ?? [] }
    },
    onDelivered: (objectId, sentMarkIds) => {
      delivered.push({ objectId, sentMarkIds })
      drafts.delete(objectId)
    },
    systemPrompt: '',
    mcpUrlFor: (id) => http.url(`/mcp/${id}`)
  })
  made.on('data', (m) => output.set(m.sessionId, (output.get(m.sessionId) ?? '') + m.data))
  made.on('status', (m) => statuses.set(m.sessionId, [...(statuses.get(m.sessionId) ?? []), m.status]))
  return made
}

const said = (id: string) => output.get(id) ?? ''
const sessionFile = (id: string) => JSON.parse(readFileSync(join(root, id, '.torno', 'session.json'), 'utf8'))
/** The arguments the agent was started with, from its READY line. */
const argv = (id: string): string[] => JSON.parse(/READY (\[.*\])/.exec(said(id))![1])

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-sessions-'))
  http = await startHttp()
  sessions = make()
})

afterEach(async () => {
  await sessions.stopAll()
  output = new Map()
  statuses = new Map()
  context = (id) => `context for ${id}`
  drafts = new Map()
  delivered = []
  gate = Promise.resolve()
  asking = null
})

afterAll(async () => {
  await http.close()
  rmSync(root, { recursive: true, force: true })
})

describe('a session', () => {
  it('runs the agent in the object folder with the launch arguments', async () => {
    const { sessionId } = sessions.start(object('bracket'), { cols: 100, rows: 30 })
    await expect.poll(() => said(sessionId)).toContain('READY')
    const args = argv(sessionId)
    expect(args[args.indexOf('--session-id') + 1]).toMatch(UUID)
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.torno.url).toBe(http.url('/mcp/bracket'))
    expect(args).not.toContain('--append-system-prompt')
    expect(sessions.current('bracket')).toMatchObject({ sessionId, status: 'idle', cols: 100, rows: 30 })
  })

  it('echoes what is written to it', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hello\r')
    await expect.poll(() => said(sessionId)).toContain('> hello')
  })

  it('inserts text at the input as a paste, without sending it', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.insert(sessionId, 'base/F5 post/E2')
    // The terminal shows what was put in; the agent has been given no line yet.
    await expect.poll(() => said(sessionId)).toContain('base/F5 post/E2')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(said(sessionId)).not.toContain('> ')
    sessions.write(sessionId, '\r')
    await expect.poll(() => said(sessionId)).toContain('> \\e[200~base/F5 post/E2\\e[201~')
  })

  it('takes escapes and control characters out of what it inserts', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    // A newline would send the prompt, and an end-of-paste would let what follows be typed as keys.
    sessions.insert(sessionId, 'a\x1b[201~b\r\nc\x07\x03d\x7f\u009be\tf')
    sessions.write(sessionId, '\r')
    await expect.poll(() => said(sessionId)).toContain('> \\e[200~a[201~bcdef\\e[201~')
    // Nothing left to insert: nothing is written, not even an empty paste.
    sessions.insert(sessionId, '\x1b\n')
    sessions.write(sessionId, 'x\r')
    await expect.poll(() => said(sessionId)).toContain('> x')
  })

  it('inserts nothing into a session that has ended', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    await sessions.stop(sessionId)
    const before = said(sessionId)
    expect(() => sessions.insert(sessionId, 'base/F5')).not.toThrow()
    expect(() => sessions.insert('no-such-session', 'base/F5')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(said(sessionId)).toBe(before)
  })

  it('goes from starting to idle to working, and gives the prompt its context', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    expect(existsSync(join(root, 'bracket', '.torno', 'session.json'))).toBe(false)
    await expect.poll(() => said(sessionId)).toContain('READY')
    expect(statuses.get(sessionId)).toEqual(['starting', 'idle'])
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: context for bracket')
    expect(statuses.get(sessionId)).toEqual(['starting', 'idle', 'working'])

    // The conversation is on file from the first hook: it can be resumed from then on.
    const args = argv(sessionId)
    const file = sessionFile('bracket')
    expect(file.conversationId).toBe(args[args.indexOf('--session-id') + 1])
    expect(Date.parse(file.updatedAt)).not.toBeNaN()

    sessions.write(sessionId, 'hook PermissionRequest\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('needs_input')
    // The question was answered and the tool runs: it is working again.
    sessions.write(sessionId, 'hook PostToolUse\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('working')
    sessions.write(sessionId, 'hook PermissionRequest\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('needs_input')
    sessions.write(sessionId, 'hook PreToolUse\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('working')
    sessions.write(sessionId, 'hook Stop\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('idle')
  })

  it("consumes the drafts of the prompt's own object, once, and of no other", async () => {
    drafts = new Map([
      ['bracket', ['M1', 'M2']],
      ['cover', ['M1']]
    ])
    const a = sessions.start(object('bracket'), {})
    const b = sessions.start(object('cover'), {})
    await expect.poll(() => said(a.sessionId)).toContain('READY')
    await expect.poll(() => said(b.sessionId)).toContain('READY')

    sessions.write(a.sessionId, 'hook\r')
    await expect.poll(() => said(a.sessionId)).toContain('context: context for bracket')
    await expect.poll(() => delivered).toEqual([{ objectId: 'bracket', sentMarkIds: ['M1', 'M2'] }])
    // The drafts of the other object are still its own to send.
    expect(drafts.get('cover')).toEqual(['M1'])

    // A second prompt in a row has nothing left to send.
    sessions.write(a.sessionId, 'hook\r')
    await expect.poll(() => said(a.sessionId).match(/context: context for bracket/g)?.length).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(delivered).toHaveLength(1)

    sessions.write(b.sessionId, 'hook\r')
    await expect.poll(() => delivered.at(-1)).toEqual({ objectId: 'cover', sentMarkIds: ['M1'] })
    expect(delivered).toHaveLength(2)
  })

  it('consumes nothing when the agent hung up before the answer was written', async () => {
    drafts = new Map([['bracket', ['M1']]])
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    let open!: () => void
    gate = new Promise<void>((resolve) => (open = resolve))
    const asked = new Promise<void>((resolve) => (asking = resolve))
    // The hook as the agent posts it, given up on while torno is still putting the answer together.
    const gone = new AbortController()
    const post = fetch(http.url(`/hooks/${sessionId}/UserPromptSubmit`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
      signal: gone.signal
    })
    await asked
    gone.abort()
    await expect(post).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    open()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(delivered).toEqual([])
    expect(drafts.get('bracket')).toEqual(['M1'])

    // The next prompt, which is answered, takes them.
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => delivered).toEqual([{ objectId: 'bracket', sentMarkIds: ['M1'] }])
  })

  it('consumes nothing on any hook but that of a prompt', async () => {
    drafts = new Map([['bracket', ['M1']]])
    let asked = 0
    context = (id) => {
      asked += 1
      return `context for ${id}`
    }
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    for (const event of ['Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
      sessions.write(sessionId, `hook ${event}\r`)
      await expect.poll(() => said(sessionId)).toContain(`${event}: ok`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Not even asked for: there is no prompt to go with.
    expect(asked).toBe(0)
    expect(delivered).toEqual([])
    expect(drafts.get('bracket')).toEqual(['M1'])
  })

  it('consumes nothing when there is no text to carry the marks, or the context cannot be had', async () => {
    drafts = new Map([['bracket', ['M1']]])
    context = () => ''
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: (none)')
    context = () => {
      throw new Error('the marks file cannot be read')
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId).match(/context: \(none\)/g)?.length).toBe(2)
    expect(logged).toHaveBeenCalledWith('no context for the prompt in bracket: the marks file cannot be read')
    logged.mockRestore()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(delivered).toEqual([])
  })

  it('answers a prompt with nothing when there is no context', async () => {
    context = () => ''
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: (none)')
  })

  it('offers nothing to resume when the agent left without a prompt', async () => {
    // Claude Code posts SessionEnd, with the id it was started with, even when nothing was asked:
    // it keeps no such conversation, and `--resume` of it fails.
    const { sessionId } = sessions.start(object('lid'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    for (const event of ['Notification', 'SessionEnd']) {
      sessions.write(sessionId, `hook ${event}\r`)
      await expect.poll(() => said(sessionId)).toContain(`${event}: ok`)
    }
    expect(existsSync(join(root, 'lid', '.torno'))).toBe(false)
    expect(sessions.resumable(object('lid'))).toBe(false)
  })

  it('follows the conversation when the agent starts another, and resumes that one', async () => {
    const other = '7c1f0c0e-3a54-4f0b-8a3e-5d2b9f6a1c11'
    const first = sessions.start(object('lid'), {})
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    expect(sessions.resumable(object('lid'))).toBe(false)
    sessions.write(first.sessionId, `hook Stop ${other}\r`)
    await expect.poll(() => said(first.sessionId)).toContain('Stop: ok')
    expect(sessionFile('lid').conversationId).toBe(other)
    // Not a conversation id: the file keeps what it has.
    sessions.write(first.sessionId, 'hook Notification ../../x\r')
    await expect.poll(() => said(first.sessionId)).toContain('Notification: ok')
    expect(sessionFile('lid').conversationId).toBe(other)
    // The end of a conversation (/clear) is not the end of the session: that is when the process goes.
    sessions.write(first.sessionId, `hook SessionEnd ${other}\r`)
    await expect.poll(() => said(first.sessionId)).toContain('SessionEnd: ok')
    expect(statuses.get(first.sessionId)).toEqual(['starting', 'idle', 'needs_input'])
    expect(sessions.current('lid')?.sessionId).toBe(first.sessionId)
    await sessions.stop(first.sessionId)

    expect(sessions.resumable(object('lid'))).toBe(true)
    const second = sessions.start(object('lid'), { resume: true })
    await expect.poll(() => said(second.sessionId)).toContain('READY')
    const args = argv(second.sessionId)
    expect(args[args.indexOf('--resume') + 1]).toBe(other)
    expect(args).not.toContain('--session-id')
  })

  it('is the one session of its object: starting again returns it', async () => {
    const first = sessions.start(object('bracket'), {})
    expect(sessions.start(object('bracket'), {}).sessionId).toBe(first.sessionId)
    expect(sessions.start(object('other'), {}).sessionId).not.toBe(first.sessionId)
  })

  it('says where it stands when it is started: starting when new, as it is when it was already running', async () => {
    const first = sessions.start(object('bracket'), {})
    expect(first.status).toBe('starting')
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    expect(sessions.start(object('bracket'), {})).toMatchObject({ sessionId: first.sessionId, status: 'idle' })
    sessions.write(first.sessionId, 'hook\r')
    await expect.poll(() => statuses.get(first.sessionId)?.at(-1)).toBe('working')
    expect(sessions.start(object('bracket'), {}).status).toBe('working')
  })

  it('names the object a session is of, until it has been hung up on', async () => {
    const obj = object('bracket')
    const { sessionId } = sessions.start(obj, {})
    expect(sessions.objectOf(sessionId)).toEqual({ id: 'bracket', dir: obj.dir })
    expect(sessions.objectOf('no-such-session')).toBeUndefined()
    void sessions.stop(sessionId)
    expect(sessions.objectOf(sessionId)).toBeUndefined()
  })

  it('gives way to a new session as soon as it is told to stop', async () => {
    const first = sessions.start(object('bracket'), {})
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    const gone = sessions.stop(first.sessionId)
    const second = sessions.start(object('bracket'), {})
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(sessions.current('bracket')?.sessionId).toBe(second.sessionId)
    await gone
    await expect.poll(() => said(second.sessionId)).toContain('READY')
    expect(statuses.get(first.sessionId)?.at(-1)).toBe('exited')
    expect(sessions.current('bracket')).toMatchObject({ sessionId: second.sessionId, status: 'idle' })
  })

  it('stops: the process ends, the status is exited, its hooks are gone', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    const pid = sessions.current('bracket')!.pid
    expect(alive(pid)).toBe(true)
    await sessions.stop(sessionId)
    expect(alive(pid)).toBe(false)
    expect(statuses.get(sessionId)).toEqual(['starting', 'idle', 'exited'])
    expect(sessions.current('bracket')).toBeNull()
    const reply = await fetch(http.url(`/hooks/${sessionId}/Stop`), { method: 'POST', body: '{}' })
    expect(reply.status).toBe(404)
    // Writes to a session that is gone are dropped.
    sessions.write(sessionId, 'x')
    sessions.resize(sessionId, 10, 10)
    await sessions.stop(sessionId)
  })

  it('is exited when the agent exits by itself', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'exit\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('exited')
  })

  it('kills an agent that ignores the hangup, two seconds later', async () => {
    process.env.FAKE_AGENT_STUBBORN = '1'
    try {
      const { sessionId } = sessions.start(object('bracket'), {})
      await expect.poll(() => said(sessionId)).toContain('READY')
      const pid = sessions.current('bracket')!.pid
      const began = Date.now()
      await sessions.stopAll()
      expect(Date.now() - began).toBeGreaterThanOrEqual(1900)
      expect(Date.now() - began).toBeLessThan(4000)
      expect(alive(pid)).toBe(false)
    } finally {
      delete process.env.FAKE_AGENT_STUBBORN
    }
  })

  it('kills what the agent started along with it', async () => {
    process.env.FAKE_AGENT_STUBBORN = '1'
    try {
      const { sessionId } = sessions.start(object('bracket'), {})
      await expect.poll(() => said(sessionId)).toContain('READY')
      sessions.write(sessionId, 'child\r')
      await expect.poll(() => said(sessionId)).toMatch(/child: \d+/)
      const child = Number(/child: (\d+)/.exec(said(sessionId))![1])
      const pid = sessions.current('bracket')!.pid
      expect(alive(child)).toBe(true)
      await sessions.stopAll()
      expect(alive(pid)).toBe(false)
      // Its exit is not waited for: it is in the same process group, and goes with it.
      await expect.poll(() => alive(child)).toBe(false)
    } finally {
      delete process.env.FAKE_AGENT_STUBBORN
    }
  })

  it('no longer puts a conversation on file once it has been hung up on', async () => {
    process.env.FAKE_AGENT_STUBBORN = '1'
    try {
      const { sessionId } = sessions.start(object('hungup'), {})
      await expect.poll(() => said(sessionId)).toContain('READY')
      const gone = sessions.stop(sessionId)
      // The agent has two seconds left, and posts a hook in them.
      sessions.write(sessionId, 'hook\r')
      await expect.poll(() => said(sessionId)).toContain('context: ')
      await gone
      expect(existsSync(join(root, 'hungup', '.torno', 'session.json'))).toBe(false)
      expect(sessions.resumable(object('hungup'))).toBe(false)
    } finally {
      delete process.env.FAKE_AGENT_STUBBORN
    }
  })

  it('gives the agent torno\'s environment without what is torno\'s own or another Claude Code\'s', async () => {
    const mine: Record<string, string> = {
      TORNO_TEST: '1',
      TORNO_AGENT_CMD: 'x',
      TORNO_CONFIG: '/x',
      TORNO_WORKSPACE: '/x',
      TORNO_DEBUG: '1',
      TORNO_SHOTS: '/x',
      TORNO_BUILD_TIMEOUT: '900',
      // The suites' own switch for the kernel: an agent's kernel, were it to start one, lets builds go as ever.
      TORNO_KEEP_BUILDS: '1',
      // What a Claude Code session exports to what it starts.
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/x',
      CLAUDE_CODE_MESSAGING_SOCKET: '/x',
      CLAUDE_CODE_MESSAGING_TOKEN: 'x',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_EFFORT: 'high',
      CLAUDE_PID: '1',
      // What a person sets on purpose.
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'kept',
      CLAUDE_CONFIG_DIR: '/kept',
      ANTHROPIC_KEPT_FOR_TEST: 'kept'
    }
    const before = Object.fromEntries(Object.keys(mine).map((name) => [name, process.env[name]]))
    Object.assign(process.env, mine)
    try {
      const { sessionId } = sessions.start(object('bracket'), {})
      sessions.write(sessionId, 'env\r')
      await expect.poll(() => said(sessionId)).toMatch(/env: (\[.*?\])\r?\n/)
      const names: string[] = JSON.parse(/env: (\[.*?\])\r?\n/.exec(said(sessionId))![1])
      expect(names.filter((name) => name.startsWith('TORNO'))).toEqual(['TORNO_OBJECT', 'TORNO_SESSION_ID'])
      // Of Claude Code's, only the marks of a parent session are withheld: the person's own settings pass.
      expect(names.filter((name) => name.startsWith('CLAUDE')).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR'])
      // Everything else is passed on.
      for (const name of ['ANTHROPIC_KEPT_FOR_TEST', 'HOME', 'PATH']) expect(names).toContain(name)
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('says so when the agent command is not installed', () => {
    const none = make('torno-no-such-agent')
    expect(() => none.start(object('bracket'), {})).toThrow(/torno-no-such-agent.*not found/)
    expect(none.current('bracket')).toBeNull()
  })
})

describe('the hook endpoint', () => {
  it('knows only live sessions, only POST, and only bodies it can read', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    const url = http.url(`/hooks/${sessionId}/Stop`)
    expect((await fetch(http.url('/hooks/nobody/Stop'), { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(http.url(`/hooks/${sessionId}`), { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(url)).status).toBe(405)
    expect((await fetch(url, { method: 'POST', body: 'not json' })).status).toBe(400)
    const fine = await fetch(url, { method: 'POST', body: '{}' })
    expect(fine.status).toBe(200)
    expect(fine.headers.get('content-type')).toBe('application/json')
    expect(await fine.json()).toEqual({})
    expect((await fetch(http.url('/elsewhere'), { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('knows only the hooks of the agent: no other name moves the status', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    // `exit` and `output` are what the PTY tells the session, not hooks.
    for (const name of ['exit', 'output', 'SessionStart', 'stop']) {
      const reply = await fetch(http.url(`/hooks/${sessionId}/${name}`), { method: 'POST', body: '{}' })
      expect(reply.status).toBe(404)
    }
    expect(statuses.get(sessionId)).toEqual(['starting', 'idle'])
    expect(sessions.current('bracket')?.status).toBe('idle')
    for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
      expect((await fetch(http.url(`/hooks/${sessionId}/${name}`), { method: 'POST', body: '{}' })).status).toBe(200)
    }
  })

  it('does not read what a tool hook carries: a tool result of megabytes moves the status and is answered', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    const body = JSON.stringify({ tool_response: 'x'.repeat(2 * 1024 * 1024) })
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const reply = await fetch(http.url(`/hooks/${sessionId}/${event}`), { method: 'POST', body })
      expect(reply.status).toBe(200)
      expect(await reply.json()).toEqual({})
    }
    expect(statuses.get(sessionId)?.at(-1)).toBe('working')
    // Nor is it parsed: what is not JSON is as good.
    expect((await fetch(http.url(`/hooks/${sessionId}/PostToolUse`), { method: 'POST', body: 'not json' })).status).toBe(200)
  })

  it('says a prompt is in a conversation that has not seen the marks when the agent names another than before, once', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    asked = []
    const prompt = async (conversation = ''): Promise<void> => {
      const before = asked.length
      sessions.write(sessionId, `hook UserPromptSubmit ${conversation}\r`)
      await expect.poll(() => asked.length).toBe(before + 1)
    }
    // The conversation it was started with, twice: nothing new.
    await prompt()
    await prompt()
    // After /clear the agent names another.
    await prompt('11111111-2222-4333-8444-555555555555')
    await prompt('11111111-2222-4333-8444-555555555555')
    await prompt('99999999-2222-4333-8444-555555555555')
    expect(asked.map((a) => a.fresh)).toEqual([false, false, true, false, true])
  })

  it('refuses a body over 1 MB', async () => {
    const { sessionId } = sessions.start(object('bracket'), {})
    const url = http.url(`/hooks/${sessionId}/UserPromptSubmit`)
    const body = JSON.stringify({ prompt: 'x'.repeat(1024 * 1024) })
    expect((await fetch(url, { method: 'POST', body })).status).toBe(413)
    expect(statuses.get(sessionId)).not.toContain('working')
    const under = JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 - 100) })
    expect((await fetch(url, { method: 'POST', body: under })).status).toBe(200)
  })

  it('listens on the loopback address only', () => {
    expect(http.url('/a')).toBe(`http://127.0.0.1:${http.port}/a`)
    expect(http.port).toBeGreaterThan(0)
  })
})

describe('killGroup', () => {
  it('kills the group of a process, and the process alone when the group is gone', () => {
    const killed: number[] = []
    killGroup(4242, (target) => void killed.push(target))
    expect(killed).toEqual([-4242])
    const gone: number[] = []
    killGroup(4242, (target) => {
      gone.push(target)
      if (target < 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    expect(gone).toEqual([-4242, 4242])
  })

  it('kills nothing unless the pid is above 1: -0 is the caller\'s own group, -1 every process it may signal', () => {
    const killed: number[] = []
    for (const pid of [0, 1, -1, -4242, NaN, 1.5, Infinity]) killGroup(pid, (target) => void killed.push(target))
    expect(killed).toEqual([])
  })
})

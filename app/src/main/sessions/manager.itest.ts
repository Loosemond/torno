import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentView, SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { type HttpRouter, startHttp } from '../http'
import { onNotOwn } from '../own'
import { Trust } from '../trust'
import type { AgentId } from '../../shared/bridge'
import { adapters } from './adapter'
import { killGroup, Sessions } from './manager'
import type { ChatItem, ChatMeta } from '../../shared/chat'
import type { PromptBlock, StreamMessage } from './stream'

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

/** The agent each object is started with: Claude Code's arguments unless a test names another. */
let chosen = new Map<string, AgentId>()
/** The view each object is started in: the terminal unless a test names the chat. */
let views = new Map<string, AgentView>()

function make(command = `node ${FAKE}`): Sessions {
  const made = new Sessions({
    http,
    adapterFor: (obj) => adapters(command)[chosen.get(obj.id) ?? 'claude'],
    viewFor: (obj) => views.get(obj.id) ?? 'terminal',
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
    systemPromptFor: () => '',
    mcpUrlFor: (id) => http.url(`/mcp/${id}`)
  })
  made.on('data', (m) => output.set(m.sessionId, (output.get(m.sessionId) ?? '') + m.data))
  made.on('status', (m) => statuses.set(m.sessionId, [...(statuses.get(m.sessionId) ?? []), m.status]))
  return made
}

/** Sessions made by a test for itself, to be ended after it. */
let others: Sessions[] = []
let folders = 0

/**
 * A session of the stand-in started with the arguments of the agent named, in a folder of its own, by a manager
 * of its own: what it is told on "Send marks" (`context`), and who hears that marks were delivered.
 */
async function started(agent: AgentId, opts: { context?: { text: string; sentMarkIds: string[] }; onDelivered?: (objectId: string, marks: string[]) => void } = {}) {
  const made = new Sessions({
    http,
    adapterFor: () => adapters(`node ${FAKE}`)[agent],
    viewFor: () => 'terminal',
    contextFor: () => opts.context ?? { text: 'Build ok.', sentMarkIds: [] },
    onDelivered: opts.onDelivered,
    systemPromptFor: () => '',
    mcpUrlFor: (id) => http.url(`/mcp/${id}`)
  })
  others.push(made)
  let all = ''
  made.on('data', (m) => (all += m.data))
  const sent: Array<{ state: string; marks: number; why?: string }> = []
  made.on('send', (m) => sent.push({ state: m.state, marks: m.marks, ...(m.why ? { why: m.why } : {}) }))
  folders += 1
  const obj = object(`${agent}-${folders}`)
  const { sessionId } = await made.start(obj, {})
  return {
    sessions: made,
    obj,
    sessionId,
    sent,
    typed: (data: string) => made.write(sessionId, data),
    output: {
      all: () => all,
      async until(text: string): Promise<string> {
        await expect.poll(() => all).toContain(text)
        return all
      }
    }
  }
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
  await Promise.all(others.map((made) => made.stopAll()))
  others = []
  output = new Map()
  statuses = new Map()
  context = (id) => `context for ${id}`
  drafts = new Map()
  chosen = new Map()
  views = new Map()
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
    const { sessionId } = await sessions.start(object('bracket'), { cols: 100, rows: 30 })
    await expect.poll(() => said(sessionId)).toContain('READY')
    const args = argv(sessionId)
    expect(args[args.indexOf('--session-id') + 1]).toMatch(UUID)
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.torno.url).toBe(http.url('/mcp/bracket'))
    expect(args).not.toContain('--append-system-prompt')
    expect(sessions.current('bracket')).toMatchObject({ sessionId, status: 'idle', cols: 100, rows: 30 })
  })

  it('echoes what is written to it', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hello\r')
    await expect.poll(() => said(sessionId)).toContain('> hello')
  })

  it('inserts text at the input as a paste, without sending it', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    await sessions.stop(sessionId)
    const before = said(sessionId)
    expect(() => sessions.insert(sessionId, 'base/F5')).not.toThrow()
    expect(() => sessions.insert('no-such-session', 'base/F5')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(said(sessionId)).toBe(before)
  })

  it('goes from starting to idle to working, and gives the prompt its context', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const a = await sessions.start(object('bracket'), {})
    const b = await sessions.start(object('cover'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: (none)')
  })

  it('offers nothing to resume when the agent left without a prompt', async () => {
    // Claude Code posts SessionEnd, with the id it was started with, even when nothing was asked:
    // it keeps no such conversation, and `--resume` of it fails.
    const { sessionId } = await sessions.start(object('lid'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    for (const event of ['Notification', 'SessionEnd']) {
      sessions.write(sessionId, `hook ${event}\r`)
      await expect.poll(() => said(sessionId)).toContain(`${event}: ok`)
    }
    expect(existsSync(join(root, 'lid', '.torno'))).toBe(false)
    expect(sessions.resumable(object('lid'), 'claude')).toBe(false)
  })

  it('follows the conversation when the agent starts another, and resumes that one', async () => {
    const other = '7c1f0c0e-3a54-4f0b-8a3e-5d2b9f6a1c11'
    const first = await sessions.start(object('lid'), {})
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    expect(sessions.resumable(object('lid'), 'claude')).toBe(false)
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

    expect(sessions.resumable(object('lid'), 'claude')).toBe(true)
    const second = await sessions.start(object('lid'), { resume: true })
    await expect.poll(() => said(second.sessionId)).toContain('READY')
    const args = argv(second.sessionId)
    expect(args[args.indexOf('--resume') + 1]).toBe(other)
    expect(args).not.toContain('--session-id')
  })

  it('is the one session of its object: starting again returns it', async () => {
    const first = await sessions.start(object('bracket'), {})
    expect((await sessions.start(object('bracket'), {})).sessionId).toBe(first.sessionId)
    expect((await sessions.start(object('other'), {})).sessionId).not.toBe(first.sessionId)
  })

  it('says where it stands when it is started: starting when new, as it is when it was already running', async () => {
    const first = await sessions.start(object('bracket'), {})
    expect(first.status).toBe('starting')
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    expect(await sessions.start(object('bracket'), {})).toMatchObject({ sessionId: first.sessionId, status: 'idle' })
    sessions.write(first.sessionId, 'hook\r')
    await expect.poll(() => statuses.get(first.sessionId)?.at(-1)).toBe('working')
    expect((await sessions.start(object('bracket'), {})).status).toBe('working')
  })

  it('names the object a session is of, until it has been hung up on', async () => {
    const obj = object('bracket')
    const { sessionId } = await sessions.start(obj, {})
    expect(sessions.objectOf(sessionId)).toEqual({ id: 'bracket', dir: obj.dir })
    expect(sessions.objectOf('no-such-session')).toBeUndefined()
    void sessions.stop(sessionId)
    expect(sessions.objectOf(sessionId)).toBeUndefined()
  })

  it('gives way to a new session as soon as it is told to stop', async () => {
    const first = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    const gone = sessions.stop(first.sessionId)
    const second = await sessions.start(object('bracket'), {})
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(sessions.current('bracket')?.sessionId).toBe(second.sessionId)
    await gone
    await expect.poll(() => said(second.sessionId)).toContain('READY')
    expect(statuses.get(first.sessionId)?.at(-1)).toBe('exited')
    expect(sessions.current('bracket')).toMatchObject({ sessionId: second.sessionId, status: 'idle' })
  })

  it('stops: the process ends, the status is exited, its hooks are gone', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'exit\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('exited')
  })

  it('kills an agent that ignores the hangup, two seconds later', async () => {
    process.env.FAKE_AGENT_STUBBORN = '1'
    try {
      const { sessionId } = await sessions.start(object('bracket'), {})
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
      const { sessionId } = await sessions.start(object('bracket'), {})
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
      const { sessionId } = await sessions.start(object('hungup'), {})
      await expect.poll(() => said(sessionId)).toContain('READY')
      const gone = sessions.stop(sessionId)
      // The agent has two seconds left, and posts a hook in them.
      sessions.write(sessionId, 'hook\r')
      await expect.poll(() => said(sessionId)).toContain('context: ')
      await gone
      expect(existsSync(join(root, 'hungup', '.torno', 'session.json'))).toBe(false)
      expect(sessions.resumable(object('hungup'), 'claude')).toBe(false)
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
      const { sessionId } = await sessions.start(object('bracket'), {})
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

  it('says so when the agent command is not installed', async () => {
    const none = make('torno-no-such-agent')
    await expect(none.start(object('bracket'), {})).rejects.toThrow(/torno-no-such-agent.*not found/)
    expect(none.current('bracket')).toBeNull()
  })
})

describe('an agent without hooks', () => {
  it('starts an agent without hooks with its own arguments, files and variables, and never resumes another agent\'s conversation', async () => {
    const { sessions, obj, output, typed } = await started('copilot')
    const argv = JSON.parse(/READY (.*)/.exec(await output.until('READY\u0020['))![1]) as string[]
    expect(argv[0]).toBe('--session-id')
    expect(argv).toContain('--allow-tool=torno')
    expect(argv.join(' ')).not.toContain('--settings')
    expect(JSON.parse(argv[argv.indexOf('--additional-mcp-config') + 1])).toEqual({ mcpServers: { torno: { type: 'http', url: http.url(`/mcp/${obj.id}`), tools: ['*'] } } })
    expect(readFileSync(join(obj.dir, '.torno', 'agent', 'AGENTS.md'), 'utf8')).toContain('the torno tool scene')
    // Nothing is on file before it was sent a line: it was opened, and there is nothing to resume.
    expect(existsSync(join(obj.dir, '.torno', 'session.json'))).toBe(false)
    typed('env\r')
    expect(await output.until('env:')).toContain('COPILOT_CUSTOM_INSTRUCTIONS_DIRS')
    // It sent a line: its conversation can be resumed, by Copilot and by no other.
    await expect.poll(() => existsSync(join(obj.dir, '.torno', 'session.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(obj.dir, '.torno', 'session.json'), 'utf8'))).toMatchObject({ agent: 'copilot', conversationId: argv[1] })
    expect(sessions.resumable(obj, 'copilot')).toBe(true)
    expect(sessions.resumable(obj, 'claude')).toBe(false)
    expect(sessions.current(obj.id)!.status).toBe('idle')
    expect(sessions.current(obj.id)).toMatchObject({ agent: 'copilot', hooks: false })
    expect(sessions.agentOf(sessions.current(obj.id)!.sessionId)).toBe('copilot')
  })

  it('sends marks through a file and a line, and counts them sent only once the line has gone', async () => {
    const delivered: string[][] = []
    const { sessions, obj, output, typed, sessionId, sent: states } = await started('copilot', { context: { text: 'Build ok, r3.\nMarks from the user:\nM4 pin on lid/F2', sentMarkIds: ['M4'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    const sent = await sessions.sendMarks(sessionId)
    expect(sent).toEqual({ marks: ['M4'], line: 'torno: 1 new mark (M4) and the build status are in .torno/prompt.md. Read it first.' })
    expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toContain('M4 pin on lid/F2')
    // Pasted, not sent: the terminal echoes what was pasted, but the stand-in has been given no line (it answers each with `> `), and the mark is still a draft.
    await output.until('torno: 1 new mark')
    await new Promise((r) => setTimeout(r, 200))
    expect(output.all()).not.toContain('> ')
    expect(delivered).toEqual([])
    expect(states).toEqual([{ state: 'waiting', marks: 1 }])
    // The click into the terminal and what the terminal answers the agent are not the person's keys.
    typed('\x1b[I')
    typed('\x1b[12;40R')
    typed('\r')
    // The line it was given, between the marks of a paste.
    expect(await output.until('> ')).toMatch(/> .*torno: 1 new mark \(M4\)/)
    expect(delivered).toEqual([['M4']])
    expect(states.at(-1)).toEqual({ state: 'sent', marks: 1 })
    // The file is the agent's to read now: it is as it was sent.
    expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toContain('M4 pin on lid/F2')
    // Nothing is pending now: another Enter delivers nothing more.
    typed('\r')
    await new Promise((r) => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(states).toHaveLength(2)
  })

  it('leaves marks drafts when the session ends before the line is sent, and refuses for an agent that has hooks', async () => {
    const delivered: string[][] = []
    const { sessions, obj, sessionId } = await started('copilot', { context: { text: 'Build ok.\nM1 pin', sentMarkIds: ['M1'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await sessions.sendMarks(sessionId)
    expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toContain('M1 pin')
    await sessions.stop(sessionId)
    expect(delivered).toEqual([])
    // What the file told of went nowhere: a later session's agent must not read it as news.
    expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toMatch(/^Nothing new from torno as of [^\n]*\n$/)
    await expect(sessions.sendMarks(sessionId)).rejects.toThrow('This session has ended')
    const claude = await started('claude')
    await expect(claude.sessions.sendMarks(claude.sessionId)).rejects.toThrow('This agent is told with every prompt')
    // Nor is a folder or a file made for an agent that is given none.
    expect(existsSync(join(claude.obj.dir, '.torno'))).toBe(false)
  })

  it('leaves marks drafts when something was typed after the line, says why, and puts the line there again when asked again', async () => {
    const delivered: string[][] = []
    const { sessions, obj, output, typed, sessionId, sent: states } = await started('copilot', { context: { text: 'Build ok.\nM2 pin', sentMarkIds: ['M2'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    const file = () => readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')
    // It was started with nothing to read there.
    expect(file()).toMatch(/^Nothing new from torno/)
    await sessions.sendMarks(sessionId)
    await output.until('torno: 1 new mark')
    // Moving along the line changes nothing.
    typed('\x1b[D')
    typed('\x1b[H')
    expect(states.map((s) => s.state)).toEqual(['waiting'])
    // A letter: what Enter then does is not known to be sending the line (an answer to a question, a menu).
    typed('y')
    expect(states).toEqual([{ state: 'waiting', marks: 1 }, { state: 'dropped', marks: 1, why: 'typed' }])
    typed('\r')
    await output.until('> ')
    expect(delivered).toEqual([])
    // The line went all the same, with what was typed after it, and it names the file: the file is as it was written, for the agent that reads it.
    await new Promise((r) => setTimeout(r, 150))
    expect(file()).toContain('M2 pin')
    // Asked again, the line is put in again, and its Enter delivers.
    await sessions.sendMarks(sessionId)
    expect(file()).toContain('M2 pin')
    await expect.poll(() => (output.all().match(/\[200~torno: 1 new mark \(M2\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
    typed('\r')
    await expect.poll(() => (output.all().match(/> /g) ?? []).length).toBe(2)
    expect(delivered).toEqual([['M2']])
    expect(states.map((s) => s.state)).toEqual(['waiting', 'dropped', 'waiting', 'sent'])
  })

  it('leaves marks drafts when the person pastes lines after it: a line break in a paste is not an Enter', async () => {
    const delivered: string[][] = []
    const { sessions, obj, output, typed, sessionId, sent: states } = await started('copilot', { context: { text: 'Build ok.', sentMarkIds: ['M2'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    await sessions.sendMarks(sessionId)
    await output.until('torno: 1 new mark')
    // As xterm.js writes two pasted lines while the agent has bracketed paste on.
    typed('\x1b[200~Traceback (most recent call last):\r  File "lid.py", line 3\x1b[201~')
    expect(delivered).toEqual([])
    expect(states.at(-1)).toEqual({ state: 'dropped', marks: 1, why: 'typed' })
    // Nor did the person send anything: there is no conversation to resume.
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(obj.dir, '.torno', 'session.json'))).toBe(false)
    expect(sessions.resumable(obj, 'copilot')).toBe(false)
  })

  it('leaves marks drafts when something of torno\'s own is put in after the line: "Insert" from the selection, a paste from the app', async () => {
    const delivered: string[][] = []
    const { sessions, obj, output, typed, sessionId, sent: states } = await started('copilot', { context: { text: 'Build ok.\nM2 pin', sentMarkIds: ['M2'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    await sessions.sendMarks(sessionId)
    await output.until('torno: 1 new mark')
    expect(states).toEqual([{ state: 'waiting', marks: 1 }])
    // The refs of what is selected, pasted after torno's line: what an Enter then sends is not that line as it was.
    sessions.insert(sessionId, 'lid/F3 (plane, normal +Z)')
    expect(states).toEqual([{ state: 'waiting', marks: 1 }, { state: 'dropped', marks: 1, why: 'typed' }])
    await output.until('lid/F3')
    typed('\r')
    await output.until('> ')
    expect(delivered).toEqual([])
    // What the line names is still what was written for it.
    expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toContain('M2 pin')
    // An insert with no line waiting drops nothing, and one into an agent with hooks is only a paste.
    sessions.insert(sessionId, 'again')
    expect(states).toHaveLength(2)
  })

  it('leaves marks drafts when Enter is pressed while the agent has a question up in place of its prompt, and says so', async () => {
    const delivered: string[][] = []
    const { sessions, output, typed, sessionId, sent: states } = await started('copilot', { context: { text: 'Build ok.', sentMarkIds: ['M2'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    // "Do you trust the files in this folder?": what is typed is not shown at a prompt.
    typed('dialog\r')
    await output.until('dialog: up')
    await sessions.sendMarks(sessionId)
    await new Promise((r) => setTimeout(r, 200))
    expect(output.all()).not.toContain('torno: 1 new mark')
    typed('\r')
    await output.until('dialog: answered')
    expect(delivered).toEqual([])
    expect(states).toEqual([{ state: 'waiting', marks: 1 }, { state: 'dropped', marks: 1, why: 'absent' }])
    // At the prompt again, it goes.
    await sessions.sendMarks(sessionId)
    await output.until('torno: 1 new mark')
    typed('\r')
    await output.until('> ')
    expect(delivered).toEqual([['M2']])
  })

  it('pastes one line however often it is asked while that line waits, and keeps the file it names as things are', async () => {
    const delivered: string[][] = []
    const context = { text: 'Build ok.\nM2 pin', sentMarkIds: ['M2'] }
    const { sessions, obj, output, typed, sessionId } = await started('copilot', { context, onDelivered: (_id, marks) => void delivered.push(marks) })
    await output.until('READY')
    await sessions.sendMarks(sessionId)
    await output.until('torno: 1 new mark')
    const file = () => readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')
    // The person made another mark and pressed the button again: the same line, another file.
    context.text = 'Build ok.\nM2 pin\nM3 arrow'
    context.sentMarkIds = ['M2', 'M3']
    expect((await sessions.sendMarks(sessionId)).marks).toEqual(['M2', 'M3'])
    expect(file()).toContain('M3 arrow')
    // A mark changed while the line waits: the file follows by itself, and nothing is pasted.
    context.text = 'Build ok.\nM2 pin, moved\nM3 arrow\nM4 pick'
    context.sentMarkIds = ['M2', 'M3', 'M4']
    sessions.changed(obj.id)
    await expect.poll(file).toContain('M4 pick')
    typed('\r')
    await output.until('> ')
    // The line the stand-in was given holds one paste, not three.
    expect(/> (.*)/.exec(output.all())![1].match(/\[200~/g)).toHaveLength(1)
    expect(delivered).toEqual([['M2', 'M3', 'M4']])
    // With no line waiting, a change writes nothing: the file is of the prompt that went.
    context.text = 'Build failed.'
    sessions.changed(obj.id)
    await new Promise((r) => setTimeout(r, 150))
    expect(file()).toContain('M4 pick')
  })

  it('tells a conversation that has seen nothing so, until a line of torno\'s has been sent in it, also when it is resumed', async () => {
    const asked: boolean[] = []
    const made = await started('copilot')
    // Its own manager, to hear what the context is asked with.
    const sessions = new Sessions({ http, adapterFor: () => adapters(`node ${FAKE}`).copilot, contextFor: (_id, opts) => (asked.push(opts.fresh), { text: opts.toolName('marks'), sentMarkIds: [] }), systemPromptFor: () => '', mcpUrlFor: (id) => http.url(`/mcp/${id}`) })
    others.push(sessions)
    let shown = ''
    sessions.on('data', (m) => (shown += m.data))
    const file = () => JSON.parse(readFileSync(join(made.obj.dir, '.torno', 'session.json'), 'utf8'))
    const first = await sessions.start(made.obj, {})
    // A line of the person's own: there is a conversation, and torno has told it nothing.
    sessions.write(first.sessionId, 'hello\r')
    await expect.poll(() => shown).toContain('> hello')
    await expect.poll(() => existsSync(join(made.obj.dir, '.torno', 'session.json'))).toBe(true)
    expect(file().told).toBeUndefined()
    await sessions.stop(first.sessionId)
    shown = ''
    const { sessionId } = await sessions.start(made.obj, { resume: true })
    await sessions.sendMarks(sessionId)
    expect(readFileSync(join(made.obj.dir, '.torno', 'prompt.md'), 'utf8')).toMatch(/^Written \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC by torno, for the prompt that follows it\.\n\nthe torno tool marks\n$/)
    await expect.poll(() => shown).toContain('torno: the build status')
    sessions.write(sessionId, '\r')
    await sessions.sendMarks(sessionId)
    expect(asked).toEqual([true, false])
    await expect.poll(() => file().told).toBe(true)
    // Resumed, it has seen what it was told before.
    await sessions.stop(sessionId)
    const again = await sessions.start(made.obj, { resume: true })
    await sessions.sendMarks(again.sessionId)
    expect(asked).toEqual([true, false, false])
  })

  it('writes its instructions only into a folder of torno\'s own, has git pass over what changes with every send, and starts nothing otherwise', async () => {
    const { sessions, obj, sessionId } = await started('copilot')
    // What is of this machine or changes with every send is not for git; the choice of agent and the conversation are not among it.
    expect(readFileSync(join(obj.dir, '.torno', '.gitignore'), 'utf8').split('\n').filter(Boolean)).toEqual(['prompt.md', 'agent/'])
    await sessions.stop(sessionId)

    // A workspace from elsewhere, whose folder for the agent leads out of it.
    const outside = mkdtempSync(join(root, 'outside-'))
    rmSync(join(obj.dir, '.torno', 'agent'), { recursive: true })
    symlinkSync(outside, join(obj.dir, '.torno', 'agent'))
    const told: Array<string | null> = []
    onNotOwn((_dir, _message, inside) => told.push(inside))
    await expect(sessions.start(obj, {})).rejects.toThrow(`cannot start the agent: ${join(obj.dir, '.torno', 'agent')} is a link, not a folder`)
    await expect(sessions.start(obj, {})).rejects.toThrow('is a link')
    expect(readdirSync(outside)).toEqual([])
    // By the one rule of torno's folders: whoever listens is told, once.
    expect(told).toEqual(['agent'])
    onNotOwn(null)
    expect(sessions.current(obj.id)).toBeNull()
    expect(sessions.size).toBe(0)

    // And one whose .torno itself does.
    const linked = object('linked')
    symlinkSync(outside, join(linked.dir, '.torno'))
    await expect(sessions.start(linked, {})).rejects.toThrow(`cannot start the agent: ${join(linked.dir, '.torno')} is a link, not a folder`)
    expect(readdirSync(outside)).toEqual([])

    // A comma in the path would split the list of folders the agent reads its instructions from.
    const comma = object('parts, v2')
    await expect(sessions.start(comma, {})).rejects.toThrow(`Copilot CLI cannot be given torno's instructions in a folder whose path has a comma: ${join(comma.dir, '.torno', 'agent')}`)
    expect(readdirSync(comma.dir)).toEqual([])
    expect(sessions.size).toBe(0)
  })

  it('has no hook endpoint: whatever posts there is not it', async () => {
    const { sessions, obj, output, typed, sessionId } = await started('copilot')
    await output.until('READY')
    const reply = await fetch(http.url(`/hooks/${sessionId}/Stop`), { method: 'POST', body: '{}' })
    expect(reply.status).toBe(404)
    expect(sessions.current(obj.id)!.status).toBe('idle')
    // And the stand-in was given none to post to, as the agent is not.
    typed('hook\r')
    await output.until('no UserPromptSubmit hook')
  })

  it('keeps the last conversation of each agent: going to another and back resumes its own', async () => {
    const obj = object('both')
    const first = await sessions.start(obj, {})
    await expect.poll(() => said(first.sessionId)).toContain('READY')
    sessions.write(first.sessionId, 'hook\r')
    await expect.poll(() => said(first.sessionId)).toContain('context:')
    const claudes = sessionFile('both').conversationId
    expect(sessionFile('both').agent).toBe('claude')
    await sessions.stop(first.sessionId)

    chosen.set('both', 'copilot')
    // Asked to resume, it starts anew: the conversation on file is not its own.
    const second = await sessions.start(obj, { resume: true })
    await expect.poll(() => said(second.sessionId)).toContain('READY')
    const copilots = argv(second.sessionId)[1]
    expect(copilots).not.toBe(claudes)
    sessions.write(second.sessionId, 'hello\r')
    await expect.poll(() => said(second.sessionId)).toContain('> hello')
    await expect.poll(() => sessionFile('both')).toMatchObject({ agent: 'copilot', conversationId: copilots, kept: { claude: { conversationId: claudes } } })
    expect([sessions.resumable(obj, 'copilot'), sessions.resumable(obj, 'claude')]).toEqual([true, true])
    await sessions.stop(second.sessionId)

    chosen.set('both', 'claude')
    const third = await sessions.start(obj, { resume: true })
    await expect.poll(() => said(third.sessionId)).toContain('READY')
    const args = argv(third.sessionId)
    expect(args[args.indexOf('--resume') + 1]).toBe(claudes)
    await sessions.stop(third.sessionId)
    chosen.set('both', 'copilot')
    const fourth = await sessions.start(obj, { resume: true })
    await expect.poll(() => said(fourth.sessionId)).toContain('READY')
    expect(argv(fourth.sessionId).slice(0, 2)).toEqual(['--session-id', copilots])
  })

  it('starts one session when asked twice at once, and ends one that was still starting when all are stopped', async () => {
    const obj = object('twice')
    const [a, b] = await Promise.all([sessions.start(obj, {}), sessions.start(obj, {})])
    expect(a.sessionId).toBe(b.sessionId)
    expect(sessions.size).toBe(1)
    await sessions.stop(a.sessionId)
    const late = sessions.start(obj, {})
    expect(sessions.isStarting('twice')).toBe(true)
    await sessions.stopAll()
    expect(sessions.current('twice')).toBeNull()
    expect(sessions.size).toBe(0)
    await late
  })
})

describe('stopAll', () => {
  it('ends the sessions there were and those that were starting, and none started while it waited', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const made = new Sessions({
      http,
      adapterFor: async (obj) => {
        if (obj.id === 'slow-start') await held
        return adapters(`node ${FAKE}`).claude
      },
      contextFor: () => ({ text: '', sentMarkIds: [] }),
      systemPromptFor: () => '',
      mcpUrlFor: (id) => http.url(`/mcp/${id}`)
    })
    others.push(made)
    const slow = made.start(object('slow-start'), {})
    expect(made.busy).toBe(true)
    expect(made.size).toBe(0)
    const stopping = made.stopAll()
    // Of the workspace opened meanwhile: not what was asked to end.
    const next = await made.start(object('next-workspace'), {})
    release()
    await stopping
    await slow
    expect(made.current('slow-start')).toBeNull()
    expect(made.current('next-workspace')).toMatchObject({ sessionId: next.sessionId })
    await made.stopAll()
    expect(made.busy).toBe(false)
  })
})

describe('the hook endpoint', () => {
  it('knows only live sessions, only POST, and only bodies it can read', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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

  it('reads what a Notification says: one that the agent has only been idle a while is no question', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    const notify = (body: object) => fetch(http.url(`/hooks/${sessionId}/Notification`), { method: 'POST', body: JSON.stringify(body) })
    // Seen on a visible screen: the header said "Needs input" with Claude Code at its empty prompt.
    expect((await notify({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).status).toBe(200)
    expect(sessions.current('bracket')?.status).toBe('idle')
    expect((await notify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).status).toBe(200)
    await expect.poll(() => sessions.current('bracket')?.status).toBe('needs_input')
  })

  it('does not read what a tool hook carries: a tool result of megabytes moves the status and is answered', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
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
    const { sessionId } = await sessions.start(object('bracket'), {})
    const url = http.url(`/hooks/${sessionId}/UserPromptSubmit`)
    const body = JSON.stringify({ prompt: 'x'.repeat(1024 * 1024) })
    expect((await fetch(url, { method: 'POST', body })).status).toBe(413)
    expect(statuses.get(sessionId)).not.toContain('working')
    const under = JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 - 100) })
    expect((await fetch(url, { method: 'POST', body: under })).status).toBe(200)
  })

  it('listens on the loopback address only', () => {
    expect(http.url('/a')).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${http.port}/a/[A-Za-z0-9_-]{43}$`))
    expect(http.port).toBeGreaterThan(0)
  })

  // Final review M15: another process of this machine can find the port, and not the secret of the run.
  it('is nothing to whoever has not the secret of the run: 404, and the session is where it was', async () => {
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    const secret = new URL(http.url('/hooks/x')).pathname.split('/')[2]
    for (const path of [`/hooks/${sessionId}/UserPromptSubmit`, `/hooks/${'A'.repeat(43)}/${sessionId}/UserPromptSubmit`, `/hooks/${sessionId}/${secret}/UserPromptSubmit`]) {
      const reply = await fetch(`http://127.0.0.1:${http.port}${path}`, { method: 'POST', body: '{"prompt":"hello"}' })
      expect([path, reply.status, await reply.json()]).toEqual([path, 404, { error: 'not found' }])
    }
    expect(statuses.get(sessionId)).toEqual(['starting', 'idle'])
    expect((await fetch(http.url(`/hooks/${sessionId}/UserPromptSubmit`), { method: 'POST', body: '{"prompt":"hello"}' })).status).toBe(200)
    expect(statuses.get(sessionId)?.at(-1)).toBe('working')
  })

  it('gives the secret to the agent in what it is started with, and to nothing else: no file of the object, no log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = new URL(http.url('/hooks/x')).pathname.split('/')[2]
    const filesOf = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
    try {
      for (const agent of ['claude', 'copilot'] as const) {
        const made = new Sessions({ http, debug: true, adapterFor: () => adapters(`node ${FAKE}`)[agent], contextFor: () => ({ text: 'Build ok.', sentMarkIds: [] }), systemPromptFor: () => 'You are in torno.', mcpUrlFor: (id) => http.url(`/mcp/${id}`) })
        others.push(made)
        let all = ''
        made.on('data', (m) => (all += m.data))
        const obj = object(`secret-${agent}`)
        const { sessionId } = await made.start(obj, {})
        await expect.poll(() => all).toContain('READY')
        // The agent has it: in the address of the MCP server, and in that of every hook it is given.
        const args: string[] = JSON.parse(/READY (\[.*\])/s.exec(all.replace(/\r?\n/g, ''))![1])
        const mcp = JSON.parse(args[args.indexOf(agent === 'claude' ? '--mcp-config' : '--additional-mcp-config') + 1]).mcpServers.torno.url
        expect(mcp).toBe(`http://127.0.0.1:${http.port}/mcp/${secret}/${obj.id}`)
        if (agent === 'claude') expect(JSON.parse(args[args.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0].url).toBe(`http://127.0.0.1:${http.port}/hooks/${secret}/${sessionId}/Stop`)
        if (agent === 'copilot') await made.sendMarks(sessionId)
        // Nothing torno wrote in the object holds it: not the instructions, not what is pasted, not the conversation on file.
        const files = filesOf(obj.dir)
        if (agent === 'copilot') expect(files.map((file) => file.slice(obj.dir.length + 1)).sort()).toEqual(expect.arrayContaining(['.torno/agent/AGENTS.md', '.torno/prompt.md']))
        for (const file of files) expect([file, readFileSync(file, 'utf8').includes(secret)]).toEqual([file, false])
        // What is logged of the start names the arguments, with the secret taken out.
        const lines = logged.mock.calls.map((call) => call.join(' '))
        expect(lines.some((line) => line.includes(`session ${sessionId}`) && line.includes('/mcp/<secret>/'))).toBe(true)
        for (const line of lines) expect(line).not.toContain(secret)
      }
    } finally {
      logged.mockRestore()
    }
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

// Claude Code started headless (view `chat`): the stand-in speaks the stream protocol (test/fake-agent.mjs), the
// hooks are posted to the real router as they are for a terminal.
describe('a chat session', () => {
  let count = 0
  // The hook endpoint answers for the first manager that mounts it on a router: this one has its own router and
  // manager, and each test says through `contextOf` what the prompts are answered with.
  let chatHttp: HttpRouter
  let chatSessions: Sessions
  let contextOf: (id: string, call: number) => { text: string; sentMarkIds: string[] }
  let calls = 0
  type Seen = {
    messages: StreamMessage[]
    data: string[]
    asks: Array<{ requestId: string; toolName: string; input: unknown; suggestions?: unknown[] }>
    asked: Array<{ requestId: string; answered: boolean }>
    contexts: Array<{ text: string; sentMarkIds: string[]; prompt?: string }>
    statuses: SessionStatus[]
  }
  const records = new Map<string, Seen>()
  const record = (sessionId: string): Seen => {
    let r = records.get(sessionId)
    if (!r) records.set(sessionId, (r = { messages: [], data: [], asks: [], asked: [], contexts: [], statuses: [] }))
    return r
  }
  const chatDelivered: Array<{ objectId: string; sentMarkIds: string[] }> = []

  beforeAll(async () => {
    chatHttp = await startHttp()
    chatSessions = new Sessions({
      http: chatHttp,
      adapterFor: () => adapters(`node ${FAKE}`).claude,
      viewFor: () => 'chat',
      contextFor: async (id) => contextOf(id, (calls += 1)),
      onDelivered: (objectId, sentMarkIds) => chatDelivered.push({ objectId, sentMarkIds }),
      systemPromptFor: () => '',
      mcpUrlFor: (id) => chatHttp.url(`/mcp/${id}`)
    })
    chatSessions.on('data', (m) => record(m.sessionId).data.push(m.data))
    chatSessions.on('stream', (m) => record(m.sessionId).messages.push(m.message))
    chatSessions.on('ask', (m) => record(m.sessionId).asks.push(m))
    chatSessions.on('asked', (m) => record(m.sessionId).asked.push(m))
    chatSessions.on('context', (m) => record(m.sessionId).contexts.push(m))
    chatSessions.on('status', (m) => record(m.sessionId).statuses.push(m.status))
  })

  afterEach(async () => {
    await chatSessions.stopAll()
    contextOf = (id, call) => ({ text: `context ${call} for ${id}`, sentMarkIds: [] })
    calls = 0
    chatDelivered.length = 0
  })

  afterAll(async () => {
    await chatHttp.close()
  })

  /** A chat session of the stand-in, in a folder of its own, with everything it says and is asked recorded. */
  async function chat(opts: { resume?: boolean; folder?: string; context?: typeof contextOf } = {}) {
    count += 1
    contextOf = opts.context ?? ((id, call) => ({ text: `context ${call} for ${id}`, sentMarkIds: [] }))
    const obj = object(opts.folder ?? `chat-${count}`)
    const started = await chatSessions.start(obj, { resume: opts.resume })
    const r = record(started.sessionId)
    return {
      ...r,
      sessions: chatSessions,
      obj,
      started,
      sessionId: started.sessionId,
      send: (content: string) => chatSessions.prompt(started.sessionId, [{ type: 'text', text: content } satisfies PromptBlock]),
      types: () => r.messages.map((m) => m.type),
      results: () => r.messages.filter((m) => m.type === 'result'),
      /** The text of the tool results the agent was given. */
      toolResults: () =>
        r.messages
          .filter((m) => m.type === 'user')
          .flatMap((m) => ((m.message as { content: Array<{ type: string; content?: unknown }> }).content ?? []).filter((b) => b.type === 'tool_result').map((b) => b.content))
    }
  }

  it('starts headless: the stream, not a terminal, with the chat flags and the arguments of the terminal', async () => {
    const c = await chat()
    expect(c.started.view).toBe('chat')
    expect(c.sessions.current(c.obj.id)).toMatchObject({ view: 'chat', agent: 'claude', hooks: true })
    c.send('say hello')
    await expect.poll(() => c.results().length).toBe(1)
    const init = c.messages.find((m) => m.type === 'system' && m.subtype === 'init')!
    const args = init.fake_argv as string[]
    expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 9)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'])
    expect(args).toContain('--session-id')
    expect(args).toContain('--mcp-config')
    // What the CLI prints is the stream's, never the terminal's.
    expect(c.data).toEqual([])
    expect(c.sessions.current(c.obj.id)!.pid).toBeGreaterThan(1)
  })

  it('streams what the agent says, and ends a turn with a result', async () => {
    const c = await chat()
    c.send('say one two three')
    await expect.poll(() => c.results().length).toBe(1)
    const deltas = c.messages.filter((m) => m.type === 'stream_event').map((m) => (m.event as { delta?: { text?: string } }).delta?.text).filter(Boolean)
    expect(deltas).toEqual(['one ', 'two ', 'three'])
    const assistant = c.messages.find((m) => m.type === 'assistant')!
    expect((assistant.message as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'one two three' }])
    expect(c.results()[0]).toMatchObject({ subtype: 'success', is_error: false })
  })

  it('keeps going past what it does not know: a line that is no JSON, an object of a type from the future', async () => {
    const c = await chat()
    c.send('garbage\nsay still here')
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.types()).toContain('from_the_future')
    expect(c.messages.some((m) => m.type === 'assistant')).toBe(true)
  })

  it('answers the prompt\'s hook with its context, says so with the prompt, and delivers the marks as for a terminal', async () => {
    const c = await chat({ context: () => ({ text: 'Marks: M4 at lid/F2.', sentMarkIds: ['M4'] }) })
    c.send('what is M4?')
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.contexts).toMatchObject([{ text: 'Marks: M4 at lid/F2.', sentMarkIds: ['M4'], prompt: 'what is M4?' }])
    // The context reached the agent: the stand-in says what its hook was answered with.
    expect(c.messages.find((m) => m.type === 'system' && m.subtype === 'hook_response')).toMatchObject({ output: 'Marks: M4 at lid/F2.' })
    expect(chatDelivered).toEqual([{ objectId: c.obj.id, sentMarkIds: ['M4'] }])
  })

  it('tells of the context of a terminal session too', async () => {
    const heard: Array<{ text: string; prompt?: string }> = []
    sessions.on('context', (m) => heard.push(m))
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: context for bracket')
    expect(heard).toMatchObject([{ objectId: 'bracket', text: 'context for bracket', sentMarkIds: [], prompt: 'hello' }])
  })

  it('gives each of two prompts sent at once its own context, in order', async () => {
    const c = await chat({ context: (_id, call) => ({ text: `context ${call}`, sentMarkIds: [`M${call}`] }) })
    c.send('say first')
    c.send('say second')
    await expect.poll(() => c.results().length).toBe(2)
    expect(c.contexts.map((x) => [x.prompt, x.text, x.sentMarkIds])).toEqual([
      ['say first', 'context 1', ['M1']],
      ['say second', 'context 2', ['M2']]
    ])
  })

  it('goes from starting to idle (ready) to working to idle, by the hooks', async () => {
    const c = await chat()
    await expect.poll(() => c.sessions.history(c.sessionId)!.commands.length).toBeGreaterThan(0)
    expect(c.statuses).toEqual(['starting', 'idle'])
    c.send('say hi')
    await expect.poll(() => c.statuses.at(-1)).toBe('idle')
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.statuses).toEqual(['starting', 'idle', 'working', 'idle'])
  })

  it('says what the agent can do, from its initialize', async () => {
    const c = await chat()
    await expect.poll(() => c.sessions.history(c.sessionId)!.commands.length).toBeGreaterThan(0)
    const { commands, models } = c.sessions.history(c.sessionId)!
    expect(commands.map((x) => x.name)).toEqual(['compact', 'clear'])
    expect(commands[0]).toEqual({ name: 'compact', description: 'Compact the conversation', argumentHint: '' })
    expect(models).toEqual([{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }])
    expect(c.sessions.history('no-such-session')).toBeUndefined()
  })

  it('needs input while a request of the agent waits, works once it is answered, and tells the agent the answer', async () => {
    const c = await chat()
    c.send('ask Bash {"command":"ls"}')
    await expect.poll(() => c.asks.length).toBe(1)
    expect(c.asks[0]).toMatchObject({ toolName: 'Bash', input: { command: 'ls' } })
    expect(c.asks[0].suggestions).toHaveLength(3)
    await expect.poll(() => c.statuses.at(-1)).toBe('needs_input')
    c.sessions.answer(c.sessionId, c.asks[0].requestId, { behavior: 'allow', updatedInput: { command: 'ls -la' } })
    expect(c.asked).toMatchObject([{ requestId: c.asks[0].requestId, answered: true }])
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.toolResults()).toEqual(['allowed: {"command":"ls -la"}'])
    expect(c.statuses).toContain('working')
    expect(c.statuses.at(-1)).toBe('idle')
    // Answered once: the same request again writes nothing and moves nothing.
    c.sessions.answer(c.sessionId, c.asks[0].requestId, { behavior: 'deny', message: 'late' })
    expect(c.asked).toHaveLength(1)
  })

  it('denies with the reason it is given', async () => {
    const c = await chat()
    c.send('ask Write {"file_path":"x"}')
    await expect.poll(() => c.asks.length).toBe(1)
    c.sessions.answer(c.sessionId, c.asks[0].requestId, { behavior: 'deny', message: 'not there' })
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.toolResults()).toEqual(['denied: not there'])
  })

  it('stays waiting until every open request is answered', async () => {
    const c = await chat()
    c.send('ask Bash {"a":1}\nask Read {"b":2}')
    await expect.poll(() => c.asks.length).toBe(1)
    c.sessions.answer(c.sessionId, c.asks[0].requestId, { behavior: 'allow', updatedInput: {} })
    await expect.poll(() => c.asks.length).toBe(2)
    await expect.poll(() => c.statuses.at(-1)).toBe('needs_input')
    c.sessions.answer(c.sessionId, c.asks[1].requestId, { behavior: 'allow', updatedInput: {} })
    await expect.poll(() => c.results().length).toBe(1)
  })

  it('interrupts a turn at once, and is idle after it, though the CLI posts no Stop for it', async () => {
    const c = await chat()
    c.send('slow 5')
    await expect.poll(() => c.statuses.at(-1)).toBe('working')
    await expect.poll(() => c.messages.some((m) => m.type === 'stream_event')).toBe(true)
    expect(await c.sessions.control(c.sessionId, { subtype: 'interrupt' })).toEqual({ still_queued: [] })
    // No clock: the turn was 5 s long, and the result is there because the interrupt cut it (poll's own 5 s bound is the limit).
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.results()[0]).toMatchObject({ subtype: 'error_during_execution', is_error: true })
    await expect.poll(() => c.statuses.at(-1)).toBe('idle')
  })

  it('is idle after an interrupt though prompts were queued behind the turn: the CLI drops them', async () => {
    const c = await chat()
    c.send('slow 5')
    c.send('say never run')
    c.send('say nor this')
    await expect.poll(() => c.statuses.at(-1)).toBe('working')
    await expect.poll(() => c.messages.some((m) => m.type === 'stream_event')).toBe(true)
    await c.sessions.control(c.sessionId, { subtype: 'interrupt' })
    await expect.poll(() => c.results().length).toBe(1)
    await expect.poll(() => c.statuses.at(-1)).toBe('idle')
    // Nothing ran after it.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(c.results()).toHaveLength(1)
    expect(c.statuses.at(-1)).toBe('idle')
  })

  it('is idle after a prompt that is no turn, followed by one that is: no result is waited for', async () => {
    const c = await chat()
    c.send('/noop')
    await expect.poll(() => c.messages.filter((m) => m.type === 'system').length).toBe(1)
    c.send('say real')
    await expect.poll(() => c.results().length).toBe(1)
    await expect.poll(() => c.statuses.at(-1)).toBe('idle')
    // And a third turn still ends in idle.
    c.send('say again')
    await expect.poll(() => c.results().length).toBe(2)
    await expect.poll(() => c.statuses.at(-1)).toBe('idle')
  })

  it('interrupts a busy session before it ends it: the turn it was in ends with its own result, which a SIGTERM would have cut off', async () => {
    const c = await chat()
    c.send('slow 10')
    await expect.poll(() => c.messages.some((m) => m.type === 'stream_event')).toBe(true)
    await c.sessions.stop(c.sessionId)
    // No clock: the stand-in prints a result for the turn only when it was interrupted; killed it prints none.
    expect(c.results()).toMatchObject([{ subtype: 'error_during_execution' }])
    expect(c.statuses.at(-1)).toBe('exited')
  })

  it('sets the model of the session through a control request', async () => {
    const c = await chat()
    expect(await c.sessions.control(c.sessionId, { subtype: 'set_model', model: 'haiku' })).toEqual({})
    c.send('say hi')
    await expect.poll(() => c.results().length).toBe(1)
    expect(c.messages.find((m) => m.type === 'system' && m.subtype === 'init')).toMatchObject({ model: 'haiku' })
  })

  it('writes nothing to a chat session by the terminal calls, and a chat call to a terminal session does nothing', async () => {
    const c = await chat()
    c.sessions.write(c.sessionId, 'say typed\r')
    c.sessions.insert(c.sessionId, 'say pasted')
    c.sessions.resize(c.sessionId, 100, 40)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(c.messages).toEqual([])
    expect(c.data).toEqual([])
    // A terminal session takes none of the chat calls.
    const { sessionId } = await sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    const before = said(sessionId)
    sessions.prompt(sessionId, [{ type: 'text', text: 'hello' }])
    sessions.answer(sessionId, 'r1', { behavior: 'allow', updatedInput: {} })
    await expect(sessions.control(sessionId, { subtype: 'interrupt' })).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(said(sessionId)).toBe(before)
  })

  it('stops: its stdin ends, it leaves, and the status is exited', async () => {
    const c = await chat()
    const pid = c.sessions.current(c.obj.id)!.pid
    expect(alive(pid)).toBe(true)
    await c.sessions.stop(c.sessionId)
    expect(alive(pid)).toBe(false)
    expect(c.statuses.at(-1)).toBe('exited')
    expect(c.sessions.current(c.obj.id)).toBeNull()
    // Nothing is sent to it any more.
    c.send('say late')
    expect(c.messages.filter((m) => m.type === 'result')).toEqual([])
    await c.sessions.stop(c.sessionId)
  })

  it('gives up what was waiting when it ends: the request is not answered, and says so', async () => {
    const c = await chat()
    c.send('ask Bash {"command":"ls"}')
    await expect.poll(() => c.asks.length).toBe(1)
    await c.sessions.stop(c.sessionId)
    // The stand-in leaves when its stdin ends, whatever it waits for.
    expect(c.asked).toMatchObject([{ requestId: c.asks[0].requestId, answered: false }])
    expect(c.statuses.at(-1)).toBe('exited')
  })

  it('kills an agent that will not leave: SIGTERM to its group after two seconds, SIGKILL after four', async () => {
    process.env.FAKE_AGENT_STUBBORN = '1'
    try {
      const c = await chat()
      await expect.poll(() => c.sessions.history(c.sessionId)!.commands.length).toBeGreaterThan(0)
      const pid = c.sessions.current(c.obj.id)!.pid
      const began = Date.now()
      await c.sessions.stop(c.sessionId)
      expect(Date.now() - began).toBeGreaterThanOrEqual(3900)
      expect(alive(pid)).toBe(false)
    } finally {
      delete process.env.FAKE_AGENT_STUBBORN
    }
  }, 20_000)

  it('has its conversation on file from the hooks, and resumes it with --resume', async () => {
    const first = await chat({ folder: 'chat-resume' })
    first.send('say hi')
    await expect.poll(() => first.results().length).toBe(1)
    const file = sessionFile('chat-resume')
    expect(file.conversationId).toMatch(UUID)
    await first.sessions.stop(first.sessionId)
    expect(first.sessions.resumable(first.obj, 'claude')).toBe(true)

    const second = await chat({ folder: 'chat-resume', resume: true })
    second.send('say again')
    await expect.poll(() => second.results().length).toBe(1)
    const args = second.messages.find((m) => m.type === 'system' && m.subtype === 'init')!.fake_argv as string[]
    expect(args[args.indexOf('--resume') + 1]).toBe(file.conversationId)
    expect(args).not.toContain('--session-id')
  })

  it('is exited when the agent goes by itself, and stays one session of its object', async () => {
    const c = await chat()
    expect(await c.sessions.start(c.obj, {})).toMatchObject({ sessionId: c.sessionId, view: 'chat' })
    await c.sessions.stop(c.sessionId)
    expect(c.statuses.at(-1)).toBe('exited')
  })

  it('starts in the view chosen for the object, and in the first view of an agent that cannot be in it', async () => {
    views.set('chosen-terminal', 'terminal')
    views.set('chosen-chat', 'chat')
    chosen.set('copilot-chat', 'copilot')
    views.set('copilot-chat', 'chat')
    expect((await sessions.start(object('chosen-terminal'), {})).view).toBe('terminal')
    expect((await sessions.start(object('chosen-chat'), {})).view).toBe('chat')
    // Copilot CLI has no chat: whatever is asked, a terminal.
    expect((await sessions.start(object('copilot-chat'), {})).view).toBe('terminal')
  })
})

// A 4 x 4 PNG, red: what the window is stubbed to answer the picture of the viewport with.
const PNG_4X4 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC', 'base64')

describe('the transcript of a chat session', () => {
  let count = 0
  let tHttp: HttpRouter
  let tSessions: Sessions
  let marks: string[] = []
  /** The marks the hook is answered with for the 1st, 2nd, … prompt; `marks` for any after them. */
  let marksPerCall: string[][] = []
  let hooks = 0
  let picture: ((obj: ObjectInfo) => Promise<Uint8Array>) | undefined
  const told: Array<{ sessionId: string; item: ChatItem; seq: number }> = []
  const metas: Array<{ sessionId: string; meta: ChatMeta; seq: number }> = []
  const abilities: Array<{ sessionId: string; objectId: string; commands: Array<{ name: string }>; models: unknown[]; seq: number }> = []
  const delivered2: string[][] = []
  const givenUp: string[] = []

  beforeAll(async () => {
    tHttp = await startHttp()
    tSessions = new Sessions({
      http: tHttp,
      adapterFor: () => adapters(`node ${FAKE}`).claude,
      viewFor: () => 'chat',
      contextFor: async () => {
        const ids = marksPerCall[hooks++] ?? marks
        return { text: ids.length > 0 ? `Marks: ${ids.join(' ')}` : '', sentMarkIds: ids }
      },
      onDelivered: (_id, ids) => delivered2.push(ids),
      systemPromptFor: () => '',
      mcpUrlFor: (id) => tHttp.url(`/mcp/${id}`),
      picture: (obj) => (picture ? picture(obj) : Promise.reject(new Error('no window')))
    })
    tSessions.on('item', (m) => told.push({ sessionId: m.sessionId, item: m.item, seq: m.seq }))
    tSessions.on('meta', (m) => metas.push({ sessionId: m.sessionId, meta: m.meta, seq: m.seq }))
    tSessions.on('capabilities', (m) => abilities.push(m))
    tSessions.on('asked', (m) => !m.answered && givenUp.push(m.requestId))
  })
  afterEach(async () => {
    await tSessions.stopAll()
    marks = []
    marksPerCall = []
    hooks = 0
    picture = undefined
    told.length = 0
    metas.length = 0
    abilities.length = 0
    givenUp.length = 0
    delivered2.length = 0
  })
  afterAll(async () => {
    await tHttp.close()
  })

  async function start(opts: { folder?: string; resume?: boolean } = {}) {
    count += 1
    const obj = object(opts.folder ?? `transcript-${count}`)
    const started = await tSessions.start(obj, { resume: opts.resume })
    const id = started.sessionId
    const items = (): ChatItem[] => tSessions.history(id)!.items
    return {
      obj,
      id,
      items,
      kinds: () => items().map((i) => i.kind),
      send: (text: string, extra: { attachView?: boolean } = {}) => tSessions.send(id, { text, ...extra }),
      turns: () => items().filter((i) => i.kind === 'turn').length,
      logFile: () => {
        const folder = join(obj.dir, '.torno', 'chat')
        return existsSync(folder) ? readdirSync(folder).map((f) => join(folder, f)) : []
      }
    }
  }
  const lines = (file: string): ChatItem[] => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ChatItem)

  it('is the prompt, what torno added to it, the tool, the reply and the end of the turn', async () => {
    marks = ['M4', 'M5']
    const c = await start()
    await c.send('tool Bash {"command":"ls"}\nsay all done')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.kinds()).toEqual(['user', 'context', 'tool', 'text', 'turn'])
    const [user, context, tool, text, turn] = c.items()
    expect(user).toMatchObject({ kind: 'user', text: 'tool Bash {"command":"ls"}\nsay all done', state: 'sent' })
    // The marks the hook was answered with, under the prompt they went with, and the marks `onDelivered` was given.
    expect(context).toMatchObject({ kind: 'context', forUser: user.id, text: 'Marks: M4 M5', marks: ['M4', 'M5'] })
    expect(delivered2).toEqual([['M4', 'M5']])
    expect(tool).toMatchObject({ kind: 'tool', name: 'Bash', state: 'done', result: 'ran Bash', input: { command: 'ls' } })
    expect(text).toMatchObject({ kind: 'text', text: 'all done', streaming: false })
    expect(turn).toMatchObject({ kind: 'turn', ok: true, stopped: false })
    expect(tSessions.history(c.id)!.meta).toMatchObject({ model: 'fake-model', tornoConnected: true })
    expect(tSessions.history(c.id)!.earlier).toEqual([])
  })

  it('does not leave a queued command that is no turn queued, and puts a prompt that begins after the one at work', async () => {
    const c = await start()
    await c.send('slow 0.5')
    await c.send('/noop')
    await c.send('say after')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(2)
    await expect.poll(() => tSessions.history(c.id)!.items.filter((i) => i.kind === 'user').every((i) => (i as { state: string }).state === 'sent')).toBe(true)
    const kinds = c.items().map((i) => (i.kind === 'user' ? (i as { text: string }).text : i.kind))
    expect(kinds.indexOf('say after')).toBeGreaterThan(kinds.indexOf('turn'))
  })

  it('shows no context under a prompt that nothing was added to', async () => {
    const c = await start()
    await c.send('say plain')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.kinds()).toEqual(['user', 'text', 'turn'])
  })

  it('puts the context of two prompts sent at once under their own, and the second is queued until the CLI takes it up', async () => {
    const c = await start()
    marksPerCall = [['M1'], ['M2']]
    await c.send('slow 1')
    await c.send('say second')
    expect(c.items().filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state)).toEqual(['sent', 'queued'])
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(2)
    const users = c.items().filter((i) => i.kind === 'user')
    expect(users.map((i) => (i as { state: string }).state)).toEqual(['sent', 'sent'])
    expect(c.items().filter((i) => i.kind === 'context')).toMatchObject([
      { forUser: users[0].id, marks: ['M1'] },
      { forUser: users[1].id, marks: ['M2'] }
    ])
  })

  it('shows every item once if it is asked for mid-stream, and what is told after it carries on from there', async () => {
    const c = await start()
    await c.send('slow 1.5\nsay the end')
    await expect.poll(() => c.items().some((i) => i.kind === 'text' && i.streaming)).toBe(true)
    const history = tSessions.history(c.id)!
    const shown = new Map(history.items.map((i) => [i.id, i]))
    expect(shown.size).toBe(history.items.length)
    // The window keeps what came after the snapshot, and only that.
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    const after = told.filter((m) => m.sessionId === c.id && m.seq > history.seq)
    expect(after.length).toBeGreaterThan(0)
    for (const m of after) shown.set(m.item.id, m.item)
    const final = c.items()
    expect([...shown.keys()]).toEqual(final.map((i) => i.id))
    expect([...shown.values()]).toEqual(final)
    // Sequence numbers only grow.
    const seqs = told.filter((m) => m.sessionId === c.id).map((m) => m.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('writes each item to the conversation\'s file when it is final, with no picture data and no address', async () => {
    const c = await start()
    const secret = new URL(tHttp.url('/x')).pathname.split('/')[2]
    await c.send(`tool Bash {"command":"echo ${tHttp.url('/mcp/obj')}"}\nsay logged`)
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    await tSessions.stop(c.id)
    const [file] = c.logFile()
    expect(file).toMatch(new RegExp(`${UUID.source.slice(1, -1)}\\.jsonl$`))
    const logged = lines(file)
    expect(logged.map((i) => i.kind)).toEqual(['user', 'tool', 'text', 'turn', 'note'])
    expect(logged.every((i) => i.kind !== 'thinking')).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain(secret)
    expect(JSON.stringify(tSessions.history(c.id)!.items)).not.toContain(secret)
    expect(readFileSync(join(c.obj.dir, '.torno', '.gitignore'), 'utf8')).toContain('chat/')
  })

  it('does not write the item that is still going on', async () => {
    const c = await start()
    await c.send('slow 2')
    await expect.poll(() => c.items().some((i) => i.kind === 'text' && i.streaming)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const [file] = c.logFile()
    expect(lines(file).map((i) => i.kind)).toEqual(['user'])
  })

  it('gives a resumed conversation what was logged of it as the earlier part, and a fresh one nothing', async () => {
    const first = await start({ folder: 'transcript-resume' })
    await first.send('say before')
    await expect.poll(() => first.turns(), { timeout: 5000 }).toBe(1)
    await tSessions.stop(first.id)

    const second = await start({ folder: 'transcript-resume', resume: true })
    const { earlier, items } = tSessions.history(second.id)!
    expect(items).toEqual([])
    expect(earlier.map((i) => i.kind)).toEqual(['user', 'text', 'turn', 'note', 'note'])
    expect(earlier[0]).toMatchObject({ text: 'say before' })
    expect(earlier.at(-1)).toMatchObject({ kind: 'note', tone: 'quiet' })
    expect((earlier.at(-1) as { text: string }).text).toMatch(/terminal/)
    // What this session says is logged in the same file, and read as earlier by the next.
    await second.send('say after')
    await expect.poll(() => second.turns(), { timeout: 5000 }).toBe(1)
    await tSessions.stop(second.id)
    expect(second.logFile()).toHaveLength(1)
    const third = await start({ folder: 'transcript-resume', resume: true })
    expect(tSessions.history(third.id)!.earlier.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['say before', 'say after'])
  })

  it('stays readable when the session has ended, until another starts in that object', async () => {
    const c = await start({ folder: 'transcript-ended' })
    await c.send('say hi')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    await tSessions.stop(c.id)
    const ended = tSessions.history(c.id)!
    expect(ended.items.at(-1)).toMatchObject({ kind: 'note', text: 'The session ended' })
    expect(tSessions.chatOf(c.id)).toMatchObject({ id: 'transcript-ended' })
    const next = await start({ folder: 'transcript-ended' })
    expect(tSessions.history(c.id)).toBeUndefined()
    expect(tSessions.chatOf(c.id)).toBeUndefined()
    expect(tSessions.history(next.id)!.items).toEqual([])
  })

  it('adds a picture of the viewport to the prompt when asked, and shows it with the prompt', async () => {
    const c = await start()
    const seen: string[] = []
    picture = async (obj) => {
      seen.push(obj.id)
      return PNG_4X4
    }
    await c.send('say with a view', { attachView: true })
    expect(seen).toEqual([c.obj.id])
    const user = c.items()[0]
    expect(user).toMatchObject({ kind: 'user', text: 'say with a view' })
    const image = (user as { images: Array<{ mediaType: string; data?: string; width?: number; height?: number }> }).images[0]
    expect(image).toMatchObject({ mediaType: 'image/png', width: 4, height: 4 })
    expect(Buffer.from(image.data!, 'base64').equals(PNG_4X4)).toBe(true)
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
  })

  it('sends nothing, and says why, when the picture cannot be made', async () => {
    const c = await start()
    picture = () => Promise.reject(new Error('the window shows another object'))
    await expect(c.send('say nothing', { attachView: true })).rejects.toThrow('the window shows another object')
    expect(c.items()).toEqual([])
    await expect(tSessions.send('nope', { text: 'x' })).rejects.toThrow()
  })

  it('keeps the data of the newest pictures only, and never writes it', async () => {
    const c = await start()
    picture = async () => PNG_4X4
    await c.send('say one', { attachView: true })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    await tSessions.stop(c.id)
    const [file] = c.logFile()
    expect(readFileSync(file, 'utf8')).not.toContain('iVBOR')
    expect((lines(file)[0] as { images: unknown[] }).images).toEqual([expect.objectContaining({ mediaType: 'image/png', width: 4, height: 4 })])
  })

  it('shows a request of the agent\'s as open until it is answered, and as allowed with the answer it was given', async () => {
    const c = await start()
    await c.send('ask Bash {"command":"ls"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    const open = c.items().find((i) => i.kind === 'ask')!
    expect(open).toMatchObject({ toolName: 'Bash', input: { command: 'ls' }, suggestions: true, state: 'open' })
    // The window may not change what a tool is run with: the request's own input goes back.
    tSessions.respond(c.id, (open as { requestId: string }).requestId, { allow: true, updatedInput: { command: 'rm -rf /' } })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ state: 'allowed' })
    expect(c.items().find((i) => i.kind === 'tool')).toMatchObject({ result: 'allowed: {"command":"ls"}' })
  })

  it('takes the answers of a question from the window and nothing else of its input', async () => {
    const c = await start()
    const input = { questions: [{ question: 'Which wall?', header: 'Wall', multiSelect: false, options: [{ label: '2 mm', description: 'thin' }] }] }
    await c.send(`ask AskUserQuestion ${JSON.stringify(input)}`)
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    const ask = c.items().find((i) => i.kind === 'ask') as { requestId: string }
    tSessions.respond(c.id, ask.requestId, { allow: true, updatedInput: { answers: { 'Which wall?': '3 mm' }, questions: [], sneaky: true } })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'tool')).toMatchObject({ result: `allowed: ${JSON.stringify({ ...input, answers: { 'Which wall?': '3 mm' } })}` })
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ state: 'allowed', answer: 'Which wall?: 3 mm' })
  })

  it('denies with the reason, and answers a request that is not open with nothing', async () => {
    const c = await start()
    await c.send('ask Write {"file_path":"x"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    const ask = c.items().find((i) => i.kind === 'ask') as { requestId: string }
    tSessions.respond(c.id, ask.requestId, { allow: false, message: 'not there' })
    tSessions.respond(c.id, ask.requestId, { allow: false, message: 'again' })
    tSessions.respond(c.id, 'req_unknown', { allow: true })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ state: 'denied', answer: 'not there' })
    expect(c.items().find((i) => i.kind === 'tool')).toMatchObject({ result: 'denied: not there' })
  })

  it('denies with a sentence of its own when no reason was typed, and passes the suggestions back only for "always"', async () => {
    const c = await start()
    await c.send('ask Write {"file_path":"x"}\nask Bash {"command":"ls"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    const first = c.items().find((i) => i.kind === 'ask') as { requestId: string }
    tSessions.respond(c.id, first.requestId, { allow: false, message: '' })
    await expect.poll(() => c.items().filter((i) => i.kind === 'ask').length).toBe(2)
    const second = c.items().filter((i) => i.kind === 'ask')[1] as { requestId: string }
    tSessions.respond(c.id, second.requestId, { allow: true, always: true })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    const tools = c.items().filter((i) => i.kind === 'tool') as Array<{ result?: string }>
    expect(tools[0].result).toBe('denied: The person denied this.')
    // Of the three kinds the CLI suggests, only the rule goes back, and as a rule of the session.
    expect(tools[1].result).toContain('permissions: [{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"session"}]')
  })

  it('keeps of the answers to a question only those of the questions that were asked', async () => {
    const c = await start()
    const input = { questions: [{ question: 'Which wall?', header: 'Wall', multiSelect: false, options: [{ label: '2 mm', description: 'thin' }] }] }
    await c.send(`ask AskUserQuestion ${JSON.stringify(input)}`)
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    const ask = c.items().find((i) => i.kind === 'ask') as { requestId: string }
    tSessions.respond(c.id, ask.requestId, { allow: true, updatedInput: { answers: { 'Which wall?': '3 mm', 'Anything else?': 'rm' } } })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'tool')).toMatchObject({ result: `allowed: ${JSON.stringify({ ...input, answers: { 'Which wall?': '3 mm' } })}` })
  })

  it('shows what the request says in words and the path it is blocked on, and offers "for this session" only when there is a rule', async () => {
    const c = await start()
    await c.send('ask Bash {"command":"touch made.txt","description":"Create made.txt","blocked_path":"/work/obj/made.txt"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ description: 'Create made.txt', blockedPath: '/work/obj/made.txt', suggestions: true })
  })

  it('takes a /compact for a turn of no turns: the boundary is told, the prompt is sent, and the session is idle after it', async () => {
    const c = await start()
    await c.send('/compact')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().map((i) => i.kind)).toEqual(['user', 'note', 'turn'])
    expect(c.items()[0]).toMatchObject({ state: 'sent', text: '/compact' })
    expect(c.items()[1]).toMatchObject({ text: 'Conversation compacted: 29,569 → 3,637 tokens', tone: 'quiet' })
    expect(c.items()[2]).toMatchObject({ ok: true, stopped: false })
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
    // Nothing waits behind it: the next prompt is not queued.
    await c.send('say after')
    expect(c.items().find((i) => i.kind === 'user' && i.text === 'say after')).toMatchObject({ state: 'sent' })
  })

  it('closes what is open when the session ends: the request is not answered, the queued prompt not sent', async () => {
    const c = await start()
    await c.send('ask Bash {"command":"ls"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    await c.send('say never')
    await tSessions.stop(c.id)
    const items = c.items()
    expect(items.find((i) => i.kind === 'ask')).toMatchObject({ state: 'ended' })
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state)).toEqual(['sent', 'not-sent'])
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ state: 'stopped' })
    expect(items.at(-1)).toMatchObject({ kind: 'note', text: 'The session ended' })
  })

  it('stops the tool and the text an interrupt cut short, and does not send the prompts the CLI dropped', async () => {
    const c = await start()
    await c.send('slow 5')
    await c.send('say dropped')
    await expect.poll(() => c.items().some((i) => i.kind === 'text' && i.streaming)).toBe(true)
    await tSessions.control(c.id, { subtype: 'interrupt' })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'turn')).toMatchObject({ ok: false, stopped: true })
    expect(c.items().filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state)).toEqual(['sent', 'not-sent'])
    expect(c.items().some((i) => i.kind === 'text' && i.streaming)).toBe(false)
  })

  it('tells the model and the connection of torno\'s tools as meta', async () => {
    const c = await start()
    await c.send('say hi')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(metas.filter((m) => m.sessionId === c.id).at(-1)?.meta).toMatchObject({ model: 'fake-model', tornoConnected: true })
    await tSessions.control(c.id, { subtype: 'set_model', model: 'haiku' })
    await c.send('say again')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(2)
    expect(tSessions.history(c.id)!.meta.model).toBe('haiku')
    expect(c.items().some((i) => i.kind === 'note' && i.text === 'Model: haiku')).toBe(true)
  })

  it('tells the window the commands and models when the agent has said them, after the history may have been had without', async () => {
    const c = await start()
    await expect.poll(() => abilities.length).toBe(1)
    const [told1] = abilities
    expect(told1).toMatchObject({ sessionId: c.id, objectId: c.obj.id })
    expect(told1.commands.map((x) => x.name)).toEqual(['compact', 'clear'])
    expect(told1.models).toEqual([{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }])
    // It counts among the things told, so that a history asked for before it can be told from one after it.
    expect(told1.seq).toBe(tSessions.history(c.id)!.seq)
  })

  it('has the commands and models of the agent in its history, and the rate limit in its meta', async () => {
    const c = await start()
    await expect.poll(() => tSessions.history(c.id)!.commands.length).toBe(2)
    expect(tSessions.history(c.id)!.models).toEqual([{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }])
    await c.send('rate 72')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(tSessions.history(c.id)!.meta.rate).toMatchObject({ window: 'five_hour', used: 72 })
  })

  it('goes on past a line that is not JSON and a message from the future', async () => {
    const c = await start()
    await c.send('garbage\nsay still here')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'text')).toMatchObject({ text: 'still here' })
  })


  // --- the final fix wave ------------------------------------------------------------------------------------

  it('closes the card of a request the CLI cancels when the person presses Stop: no buttons, an idle session, and the next ask works', async () => {
    const c = await start()
    await c.send('ask Bash {"command":"ls"}')
    await expect.poll(() => c.items().some((i) => i.kind === 'ask')).toBe(true)
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('needs_input')
    const first = c.items().find((i) => i.kind === 'ask') as { requestId: string }
    await tSessions.control(c.id, { subtype: 'interrupt' })
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ state: 'ended', why: 'the turn was stopped' })
    // Main let go of the request: nothing stale is left to hold the status of the next one.
    expect(givenUp).toEqual([first.requestId])
    expect(c.items().find((i) => i.kind === 'turn')).toMatchObject({ ok: false, stopped: true })
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
    // An answer to it does nothing (and does not say "Allowed").
    tSessions.respond(c.id, first.requestId, { allow: true })
    expect(c.items().find((i) => i.kind === 'ask')).toMatchObject({ state: 'ended' })
    // The stale request does not hold a later one: answered, the session works again and ends idle.
    await c.send('ask Bash {"command":"pwd"}')
    await expect.poll(() => c.items().filter((i) => i.kind === 'ask').length).toBe(2)
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('needs_input')
    const second = c.items().filter((i) => i.kind === 'ask')[1] as { requestId: string }
    tSessions.respond(c.id, second.requestId, { allow: true })
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('working')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(2)
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
  })

  it('takes a prompt sent while a tool runs as part of the turn: one result, its context under it, nothing queued after', async () => {
    marksPerCall = [[], ['M7']]
    const c = await start()
    await c.send('work 1\nsay first answer')
    await expect.poll(() => c.items().some((i) => i.kind === 'tool' && i.state === 'running')).toBe(true)
    await c.send('say folded answer')
    expect(c.items().filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state)).toEqual(['sent', 'queued'])
    await expect.poll(() => c.turns(), { timeout: 8000 }).toBe(1)
    const users = c.items().filter((i) => i.kind === 'user') as Array<{ id: string; text: string; state: string }>
    expect(users.map((u) => u.state)).toEqual(['sent', 'sent'])
    expect(c.items().map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['work 1\nsay first answer', 'tool', 'say folded answer', 'context', 'text', 'text', 'turn'].filter((k) => k !== 'context' || marksPerCall[1].length > 0))
    expect(c.items().find((i) => i.kind === 'context')).toMatchObject({ forUser: users[1].id, marks: ['M7'] })
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
    // The next prompt is not off by one: sent at once, and answered.
    await c.send('say third')
    expect(c.items().filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state)).toEqual(['sent', 'sent', 'sent'])
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(2)
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
  })

  it('tells the person what Claude Code said when it stops without a line of output, and that it did not start', async () => {
    process.env.FAKE_AGENT_FAIL = 'error: unknown option --permission-prompt-tool'
    try {
      const c = await start()
      await expect.poll(() => tSessions.current(c.obj.id), { timeout: 8000 }).toBeNull()
      const notes = c.items().filter((i) => i.kind === 'note') as Array<{ text: string; tone: string }>
      expect(notes.map((n) => n.text)).toEqual([
        'Claude Code stopped (exit code 1): error: unknown option --permission-prompt-tool',
        'It did not start: is `claude` up to date and signed in? Try the terminal view to see why.',
        'The session ended'
      ])
      expect(notes.map((n) => n.tone)).toEqual(['warn', 'warn', 'quiet'])
    } finally {
      delete process.env.FAKE_AGENT_FAIL
    }
  })

  it('says a stop it did not ask for, though the exit code was 0, and does not say one it asked for', async () => {
    const asked = await start()
    await tSessions.stop(asked.id)
    expect(asked.items().filter((i) => i.kind === 'note').map((n) => (n as { text: string }).text)).toEqual(['The session ended'])
    const c = await start()
    await c.send('say hi')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    process.kill(tSessions.current(c.obj.id)!.pid, 'SIGKILL')
    await expect.poll(() => tSessions.current(c.obj.id), { timeout: 8000 }).toBeNull()
    const notes = c.items().filter((i) => i.kind === 'note') as Array<{ text: string; tone: string }>
    expect(notes[0]).toMatchObject({ text: 'Claude Code stopped (signal SIGKILL)', tone: 'warn' })
    // It had spoken: it is not said not to have started.
    expect(notes.map((n) => n.text).join('\n')).not.toContain('did not start')
  })

  it('notes, quietly, that Claude Code did not answer initialize', async () => {
    process.env.FAKE_AGENT_INIT_ERROR = 'unknown request initialize'
    try {
      const c = await start()
      await expect.poll(() => c.items().some((i) => i.kind === 'note'), { timeout: 5000 }).toBe(true)
      expect(c.items().find((i) => i.kind === 'note')).toMatchObject({ tone: 'quiet', text: expect.stringContaining('Claude Code did not say what it can do (unknown request initialize)') })
    } finally {
      delete process.env.FAKE_AGENT_INIT_ERROR
    }
  })

  it('sends a prompt with a picture before the prompt sent after it', async () => {
    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    picture = () => new Promise((resolve) => setTimeout(() => resolve(png), 400))
    const c = await start()
    const first = c.send('say with a picture', { attachView: true })
    const second = c.send('say plain')
    await Promise.all([first, second])
    expect(c.items().filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['say with a picture', 'say plain'])
    await expect.poll(() => c.turns(), { timeout: 8000 }).toBe(2)
  })

  it('still takes a prompt up that had no hook and no init, when other lines came inside the moment it was waited for', async () => {
    const c = await start()
    await c.send('slow 0.3')
    await c.send('/silent')
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    // The silent command's own line came just after the result: the wait begins again, and ends.
    await expect.poll(() => c.items().filter((i) => i.kind === 'user').map((i) => (i as { state: string }).state), { timeout: 6000 }).toEqual(['sent', 'sent'])
    await expect.poll(() => tSessions.current(c.obj.id)?.status).toBe('idle')
  })

  it('names the chat of an object that has ended, for a window loaded since, and none while one runs', async () => {
    const c = await start()
    expect(tSessions.endedChat(c.obj.id)).toBeUndefined()
    await tSessions.stop(c.id)
    expect(tSessions.endedChat(c.obj.id)).toBe(c.id)
    const again = await start({ folder: c.obj.id.replace('transcript-', 'transcript-') })
    expect(again.obj.id).toBe(c.obj.id)
    expect(tSessions.endedChat(c.obj.id)).toBeUndefined()
  })

  it('lets go of the transcripts of sessions that have ended when asked, and keeps one that runs', async () => {
    const gone = await start()
    await tSessions.stop(gone.id)
    const live = await start()
    expect(tSessions.history(gone.id)).toBeDefined()
    tSessions.forgetEnded()
    expect(tSessions.history(gone.id)).toBeUndefined()
    expect(tSessions.history(live.id)).toBeDefined()
  })

})

describe('the question before a chat in a folder with settings of its own', () => {
  let tHttp: HttpRouter
  let trustSessions: Sessions
  const trust = () => new Trust(null, root)

  beforeAll(async () => {
    tHttp = await startHttp()
    trustSessions = new Sessions({
      http: tHttp,
      adapterFor: () => adapters(`node ${FAKE}`).claude,
      viewFor: () => 'chat',
      contextFor: async () => ({ text: '', sentMarkIds: [] }),
      systemPromptFor: () => '',
      mcpUrlFor: (id) => tHttp.url(`/mcp/${id}`),
      trust: trust()
    })
  })
  afterEach(async () => {
    await trustSessions.stopAll()
  })
  afterAll(async () => {
    await tHttp.close()
  })

  it('refuses the chat with the question, starts nothing, and starts it once the person has said yes', async () => {
    const obj = object('trust-1')
    writeFileSync(join(obj.dir, '.mcp.json'), '{}')
    const refused = await trustSessions.start(obj, {}).catch((e: Error) => e)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe('This folder has Claude Code settings of its own (.mcp.json) that the chat would load without asking. Start the chat anyway?')
    expect(trustSessions.current(obj.id)).toBeNull()
    expect(trustSessions.size).toBe(0)
    // Nothing was written in the folder for it.
    expect(existsSync(join(obj.dir, '.torno'))).toBe(false)
    await trustSessions.trust(obj)
    const started = await trustSessions.start(obj, {})
    expect(started.view).toBe('chat')
    expect(trustSessions.current(obj.id)).not.toBeNull()
  })

  it('asks nothing of a folder without settings', async () => {
    const started = await trustSessions.start(object('trust-2'), {})
    expect(started.view).toBe('chat')
  })

  it('asks nothing for the terminal, which has Claude Code\'s own question', async () => {
    const terminal = new Sessions({
      http: tHttp,
      adapterFor: () => adapters(`node ${FAKE}`).claude,
      viewFor: () => 'terminal',
      contextFor: async () => ({ text: '', sentMarkIds: [] }),
      systemPromptFor: () => '',
      mcpUrlFor: (id) => tHttp.url(`/mcp/${id}`),
      trust: trust()
    })
    const obj = object('trust-3')
    writeFileSync(join(obj.dir, '.mcp.json'), '{}')
    const started = await terminal.start(obj, {})
    expect(started.view).toBe('terminal')
    await terminal.stopAll()
  })
})

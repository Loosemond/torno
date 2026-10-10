import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { type HttpRouter, startHttp } from '../http'
import { onNotOwn } from '../own'
import type { AgentId } from '../../shared/bridge'
import { adapters } from './adapter'
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

/** The agent each object is started with: Claude Code's arguments unless a test names another. */
let chosen = new Map<string, AgentId>()

function make(command = `node ${FAKE}`): Sessions {
  const made = new Sessions({
    http,
    adapterFor: (obj) => adapters(command)[chosen.get(obj.id) ?? 'claude'],
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

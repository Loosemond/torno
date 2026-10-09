import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { type HttpRouter, startHttp } from '../http'
import { claudeAdapter } from './claude'
import { Sessions } from './manager'

// The session manager with a real PTY and a real HTTP server; only the agent is
// a stand-in (test/fake-agent.mjs), launched with Claude Code's arguments.
const FAKE = resolve(__dirname, '../../../test/fake-agent.mjs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let root: string
let http: HttpRouter
let sessions: Sessions
let context = (id: string) => `context for ${id}`
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
    contextFor: (id) => context(id),
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
    sessions.write(sessionId, 'hook Stop\r')
    await expect.poll(() => statuses.get(sessionId)?.at(-1)).toBe('idle')
  })

  it('answers a prompt with nothing when there is no context', async () => {
    context = () => ''
    const { sessionId } = sessions.start(object('bracket'), {})
    await expect.poll(() => said(sessionId)).toContain('READY')
    sessions.write(sessionId, 'hook\r')
    await expect.poll(() => said(sessionId)).toContain('context: (none)')
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

  it('gives the agent torno\'s environment without what is torno\'s own or another Claude Code\'s', async () => {
    const mine: Record<string, string> = {
      TORNO_TEST: '1',
      TORNO_AGENT_CMD: 'x',
      TORNO_CONFIG: '/x',
      TORNO_WORKSPACE: '/x',
      TORNO_DEBUG: '1',
      TORNO_SHOTS: '/x',
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
    for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'SessionEnd']) {
      expect((await fetch(http.url(`/hooks/${sessionId}/${name}`), { method: 'POST', body: '{}' })).status).toBe(200)
    }
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

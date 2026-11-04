import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ObjectInfo } from '../../shared/workspace'
import { type HttpRouter, startHttp } from '../http'
import type { AgentAdapter } from './adapter'
import { claudeAdapter } from './claude'
import { Sessions } from './manager'
import type { AgentEvents, AgentMessage, AgentTransport, AskAnswer, PromptBlock } from './transport'

/**
 * `Sessions` driven by a transport that is no process: it holds the seam of `transport.ts` to its word. Sessions
 * knows the agent only by `AgentTransport`, so ending it and the escalation after that are the transport's calls.
 */
class InMemory implements AgentTransport {
  private readonly listeners: { [E in keyof AgentEvents]: AgentEvents[E][] } = { message: [], ask: [], note: [], stderr: [], exit: [] }
  readonly prompts: PromptBlock[][] = []
  readonly answers: Array<{ requestId: string; response: AskAnswer }> = []
  readonly calls: string[] = []

  on<E extends keyof AgentEvents>(event: E, cb: AgentEvents[E]): void {
    this.listeners[event].push(cb)
  }
  emit<E extends keyof AgentEvents>(event: E, ...args: Parameters<AgentEvents[E]>): void {
    for (const cb of this.listeners[event]) (cb as (...a: unknown[]) => void)(...args)
  }
  prompt(content: PromptBlock[]): void {
    this.prompts.push(content)
  }
  async control(request: { subtype: string }): Promise<unknown> {
    this.calls.push(`control:${request.subtype}`)
    return { commands: [], models: [] }
  }
  async interrupt(): Promise<unknown> {
    this.calls.push('interrupt')
    return {}
  }
  answer(requestId: string, response: AskAnswer): void {
    this.answers.push({ requestId, response })
  }
  end(): void {
    this.calls.push('end')
  }
  terminate(): void {
    this.calls.push('terminate')
  }
  kill(): void {
    this.calls.push('kill')
  }
}

let root: string
let configDir: string
let http: HttpRouter

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-memory-'))
  configDir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-memory-config-'))
  http = await startHttp()
})

afterAll(async () => {
  await http.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

function start() {
  const transports: InMemory[] = []
  const adapter: AgentAdapter = {
    ...claudeAdapter('true'),
    chat: () => {
      const t = new InMemory()
      transports.push(t)
      return t
    }
  }
  const sessions = new Sessions({
    configDir,
    http,
    adapter,
    viewFor: () => 'chat',
    contextFor: async () => ({ text: '', sentMarkIds: [] }),
    systemPromptFor: () => '',
    mcpUrlFor: (id) => http.url(`/mcp/${id}`)
  })
  const dir = join(root, `p${transports.length}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const obj: ObjectInfo = { id: 'bracket', name: 'bracket', dir, model: null }
  return { sessions, obj, transports }
}

describe('Sessions with a transport in memory', () => {
  it('hands a prompt to the transport and tells what it says', async () => {
    const { sessions, obj, transports } = start()
    const said: AgentMessage[] = []
    sessions.on('stream', (m) => said.push(m.message))
    const { sessionId } = await sessions.start(obj, {})
    const t = transports[0]
    await expect.poll(() => t.calls).toContain('control:initialize')
    sessions.prompt(sessionId, [{ type: 'text', text: 'make it longer' }])
    await expect.poll(() => t.prompts.length).toBe(1)
    t.emit('message', { type: 'result', subtype: 'success', is_error: false, result: 'done' })
    await expect.poll(() => said.some((m) => m.type === 'result')).toBe(true)
    expect(sessions.current(obj.id)).toMatchObject({ view: 'chat', pid: 0 })
    t.emit('exit', 0, null)
    await expect.poll(() => sessions.current(obj.id)).toBeNull()
  })

  it('ends the agent, then terminates it, then kills it, as the transport is asked', async () => {
    const { sessions, obj, transports } = start()
    const { sessionId } = await sessions.start(obj, {})
    const t = transports[0]
    await expect.poll(() => t.calls).toContain('control:initialize')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stopped = sessions.stop(sessionId)
      expect(t.calls).toContain('end')
      expect(t.calls).not.toContain('terminate')
      vi.advanceTimersByTime(2000)
      expect(t.calls).toContain('terminate')
      expect(t.calls).not.toContain('kill')
      vi.advanceTimersByTime(2000)
      expect(t.calls).toContain('kill')
      t.emit('exit', null, 'SIGKILL')
      await stopped
    } finally {
      vi.useRealTimers()
    }
    expect(sessions.current(obj.id)).toBeNull()
  })

  it('does not escalate for an agent that leaves after being ended', async () => {
    const { sessions, obj, transports } = start()
    const { sessionId } = await sessions.start(obj, {})
    const t = transports[0]
    await expect.poll(() => t.calls).toContain('control:initialize')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stopped = sessions.stop(sessionId)
      t.emit('exit', 0, null)
      await stopped
      vi.advanceTimersByTime(10_000)
    } finally {
      vi.useRealTimers()
    }
    expect(t.calls).not.toContain('terminate')
    expect(t.calls).not.toContain('kill')
  })
})

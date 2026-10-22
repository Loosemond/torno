import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStatus } from '../../shared/bridge'
import type { ChatItem } from '../../shared/chat'
import { type HttpRouter, startHttp } from '../http'
import { claudeAdapter } from './claude'
import { Sessions } from './manager'
import { LOGIN_FAILED } from './transcript'
import type { AgentMessage } from './transport'

// A chat whose first turn could not authenticate (#117), as Claude Code's headless mode does under `--bare` or with a
// login that ran out: the stand-in (FAKE_AGENT_AUTH_ERROR) answers its first prompt with an assistant message marked
// `error: "authentication_failed"` and a result marked as an error. The chat says so once, with the offer of the
// terminal, and the status is the hooks' and the result's as for any turn.
const FAKE = resolve(__dirname, '../../../test/fake-agent.mjs')

let root: string
let configDir: string
let http: HttpRouter
let sessions: Sessions
const messages: AgentMessage[] = []
const items: ChatItem[] = []
const statuses: SessionStatus[] = []

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-login-'))
  configDir = join(root, 'config')
  http = await startHttp()
  sessions = new Sessions({
    configDir,
    http,
    adapter: claudeAdapter(`node ${FAKE}`),
    viewFor: () => 'chat',
    contextFor: async () => ({ text: '', sentMarkIds: [] }),
    systemPromptFor: () => '',
    mcpUrlFor: (id) => http.url(`/mcp/${id}`)
  })
  sessions.on('stream', (m) => messages.push(m.message))
  sessions.on('item', (m) => items.push(m.item))
  sessions.on('status', (m) => statuses.push(m.status))
})

afterEach(async () => {
  await sessions.stopAll()
  delete process.env.FAKE_AGENT_AUTH_ERROR
})

afterAll(async () => {
  await http.close()
  rmSync(root, { recursive: true, force: true })
})

const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${messages.map((m) => m.type).join(' ')} ${statuses.join(' ')}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('a first turn that could not authenticate', () => {
  it('is said once in the chat, after what the CLI said, with the offer of the terminal; the next turn runs', async () => {
    process.env.FAKE_AGENT_AUTH_ERROR = 'Not logged in · Please run /login'
    const dir = join(root, 'bracket')
    mkdirSync(dir, { recursive: true })
    const started = await sessions.start({ id: 'bracket', name: 'bracket', dir, model: null }, {})
    sessions.prompt(started.sessionId, [{ type: 'text', text: 'say hello' }])
    await until(() => messages.some((m) => m.type === 'result'))

    // What the stand-in said, as the CLI says it: the typed error on the assistant message, its words, a result in error.
    const failed = messages.find((m) => m.type === 'assistant')!
    expect(failed.error).toBe('authentication_failed')
    expect(failed.message).toMatchObject({ model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] })
    expect(messages.find((m) => m.type === 'result')).toMatchObject({ is_error: true, result: 'Not logged in · Please run /login' })

    const chat = sessions.history(started.sessionId)!.items
    expect(chat.filter((i) => i.kind !== 'user').map((i) => i.kind)).toEqual(['text', 'note', 'turn'])
    expect(chat.find((i) => i.kind === 'note')).toMatchObject({ text: LOGIN_FAILED, tone: 'warn', action: 'terminal' })
    await until(() => statuses.at(-1) === 'idle')

    // The second turn is not the first: it runs its script, and nothing more is said of the login.
    sessions.prompt(started.sessionId, [{ type: 'text', text: 'say hello' }])
    await until(() => messages.filter((m) => m.type === 'result').length === 2)
    const after = sessions.history(started.sessionId)!.items
    expect(after.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text)).toEqual(['Not logged in · Please run /login', 'hello'])
    expect(after.filter((i) => i.kind === 'note')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'note' && i.action === 'terminal').length).toBeGreaterThan(0)
  })
})

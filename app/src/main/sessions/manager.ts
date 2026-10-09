import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { delimiter, join } from 'node:path'
import * as pty from 'node-pty'
import type { SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import type { PromptContext } from '../context'
import { BodyTooLarge, type HttpRouter, readBody, sendJson } from '../http'
import type { AgentAdapter } from './adapter'
import { HOOK_EVENTS, reduceStatus } from './status'

const FOLDER = '.torno'
const FILE = 'session.json'
const HOOK_BODY_LIMIT = 1024 * 1024
const KILL_AFTER_MS = 2000
/** The hooks that say a conversation has a prompt in it: it exists for the agent, and can be resumed. */
const CONVERSATION_EVENTS = new Set(['UserPromptSubmit', 'Stop'])
/** C0 and C1 controls and DEL: among them ESC, the newlines and the one-byte CSI. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Session {
  id: string
  object: ObjectInfo
  /** The agent's id of the conversation, as its last hook named it. */
  conversationId: string
  status: SessionStatus
  cols: number
  rows: number
  pty: pty.IPty
  exited: Promise<void>
  killTimer?: NodeJS.Timeout
}

export interface SessionInfo {
  sessionId: string
  status: SessionStatus
  cols: number
  rows: number
  pid: number
}

interface Events {
  data: { sessionId: string; data: string }
  status: { sessionId: string; objectId: string; status: SessionStatus }
}

/**
 * The agent sessions: each the real CLI in a PTY, in the folder of one object,
 * and at most one per object. The status of a session follows the hooks the
 * agent posts to `/hooks/<sessionId>/<event>` on the local HTTP server.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners: { [E in keyof Events]: ((m: Events[E]) => void)[] } = { data: [], status: [] }

  constructor(
    private readonly deps: {
      http: HttpRouter
      adapter: AgentAdapter
      /**
       * What the agent should know with the next prompt in that object ('' for
       * nothing), and the marks that text tells of for the first time. Asking
       * changes nothing: `onDelivered` says when the agent has been given it.
       */
      contextFor: (objectId: string) => PromptContext | Promise<PromptContext>
      /**
       * The answer to a prompt's hook has left for the agent of that object,
       * and these marks were in it. Only ever for a UserPromptSubmit of a
       * session that is still the one of its object.
       */
      onDelivered?: (objectId: string, sentMarkIds: string[]) => void
      systemPrompt: string
      mcpUrlFor: (objectId: string) => string
      /** Print the command line of every session started, and every hook it posts. */
      debug?: boolean
    }
  ) {
    deps.http.route('/hooks', (req, res, rest) => this.hook(req, res, rest))
  }

  on<E extends keyof Events>(event: E, cb: (m: Events[E]) => void): void {
    this.listeners[event].push(cb)
  }

  /**
   * Start the agent in an object's folder, or return the session already
   * running there. `resume` continues the conversation on file, if there is one.
   * Throws when the agent's command cannot be found.
   */
  start(obj: ObjectInfo, opts: { resume?: boolean; cols?: number; rows?: number }): { sessionId: string; cols: number; rows: number } {
    const running = this.of(obj.id)
    if (running) return { sessionId: running.id, cols: running.cols, rows: running.rows }

    const { adapter, http } = this.deps
    const id = randomUUID()
    const stored = opts.resume ? storedConversation(obj.dir) : null
    const conversationId = stored ?? randomUUID()
    const launch = adapter.launch({
      sessionId: id,
      conversationId,
      resume: stored !== null,
      cwd: obj.dir,
      mcpUrl: this.deps.mcpUrlFor(obj.id),
      hookUrl: (event) => http.url(`/hooks/${id}/${encodeURIComponent(event)}`),
      systemPrompt: this.deps.systemPrompt
    })
    if (this.deps.debug) console.error(`[torno] session ${id} in ${obj.dir}: ${JSON.stringify([launch.command, ...launch.args])}`)
    const env: Record<string, string> = { ...agentEnv(process.env), ...launch.env, COLORTERM: 'truecolor', TORNO_OBJECT: obj.id, TORNO_SESSION_ID: id }
    // node-pty reports a command that does not exist only as a process that exits at once.
    if (!findCommand(launch.command, env.PATH)) throw new Error(`cannot start the agent: '${launch.command}' was not found on PATH`)

    const cols = size(opts.cols, 80)
    const rows = size(opts.rows, 24)
    const child = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cols, rows, cwd: obj.dir, env })
    let ended!: () => void
    const session: Session = {
      id,
      object: obj,
      conversationId,
      status: 'starting',
      cols,
      rows,
      pty: child,
      exited: new Promise<void>((resolve) => (ended = resolve))
    }
    this.sessions.set(id, session)
    this.emit('status', { sessionId: id, objectId: obj.id, status: 'starting' })

    child.onData((data) => {
      this.emit('data', { sessionId: id, data })
      this.advance(session, 'output')
    })
    child.onExit(() => {
      clearTimeout(session.killTimer)
      this.sessions.delete(id)
      this.advance(session, 'exit')
      ended()
    })
    return { sessionId: id, cols, rows }
  }

  /** How many agents have not gone yet, counting those hung up on. */
  get size(): number {
    return this.sessions.size
  }

  /** The session running in an object's folder. */
  current(objectId: string): SessionInfo | null {
    const s = this.of(objectId)
    return s ? { sessionId: s.id, status: s.status, cols: s.cols, rows: s.rows, pid: s.pty.pid } : null
  }

  /** Whether the object has a conversation on file to resume. */
  resumable(obj: ObjectInfo): boolean {
    return storedConversation(obj.dir) !== null
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data)
  }

  /**
   * Put text at the agent's cursor as a paste, without sending it: the person
   * reads it, adds to it and presses Enter themselves. Control characters are
   * taken out first, so the text can neither end the paste nor send the prompt.
   * Nothing is written to a session that has ended or been hung up on.
   */
  insert(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.killTimer) return
    const plain = text.replace(CONTROL_CHARACTERS, '')
    if (plain) s.pty.write(`\x1b[200~${plain}\x1b[201~`)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    cols = size(cols, s.cols)
    rows = size(rows, s.rows)
    if (cols === s.cols && rows === s.rows) return
    s.cols = cols
    s.rows = rows
    try {
      s.pty.resize(cols, rows)
    } catch {
      // The process went a moment ago; its exit follows.
    }
  }

  /** Hang up on the agent, and kill it if it is still there two seconds later. Resolves once it has gone. */
  stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.resolve()
    if (!s.killTimer) {
      signal(s.pty, 'SIGHUP')
      s.killTimer = setTimeout(() => killGroup(s.pty.pid), KILL_AFTER_MS)
    }
    return s.exited
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  /** The session of an object. One that has been hung up on is no longer it, though its process may linger. */
  private of(objectId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.object.id === objectId && !s.killTimer) return s
    return undefined
  }

  private emit<E extends keyof Events>(event: E, message: Events[E]): void {
    for (const cb of this.listeners[event]) cb(message)
  }

  private advance(session: Session, event: string): void {
    const next = reduceStatus(session.status, event)
    if (next === session.status) return
    session.status = next
    this.emit('status', { sessionId: session.id, objectId: session.object.id, status: next })
  }

  /** `POST /hooks/<sessionId>/<event>`, with the hook's JSON as the body. */
  private async hook(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
    const [sessionId, event] = rest
    const session = rest.length === 2 ? this.sessions.get(sessionId) : undefined
    if (!session) return sendJson(res, 404, { error: 'no such session' })
    // Only what the agent posts: `exit` and `output` are the PTY's to say, and would end a live session.
    if (!HOOK_EVENTS.includes(event)) return sendJson(res, 404, { error: 'no such hook' })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })

    let body: unknown
    try {
      body = JSON.parse(await readBody(req, HOOK_BODY_LIMIT))
    } catch (e) {
      if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: e.message })
      return sendJson(res, 400, { error: 'the body is not JSON' })
    }
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

    // The agent starts another conversation on /clear; the one to resume is the latest
    // that was asked something. Claude Code names a conversation in every hook, also in
    // the SessionEnd of one nothing was asked in, and that one it cannot resume.
    const conversation = fields.session_id
    // Not for a session that has been hung up on: its object may have a new
    // session by now, whose conversation is the one to resume.
    if (!session.killTimer && CONVERSATION_EVENTS.has(event) && typeof conversation === 'string' && UUID.test(conversation)) {
      session.conversationId = conversation
      try {
        storeConversation(session.object.dir, conversation)
      } catch (e) {
        console.error(`cannot write ${join(session.object.dir, FOLDER, FILE)}: ${(e as Error).message}`)
      }
    }

    // A SessionEnd is not the end of the session: on /clear the agent carries on
    // in another conversation, and when it does leave, the exit of its process
    // says so. Until then the session is still the one of its object.
    if (event !== 'SessionEnd') this.advance(session, event)

    if (event !== 'UserPromptSubmit') {
      if (this.deps.debug) console.error(`[torno] session ${session.id} hook ${event}`)
      return sendJson(res, 200, {})
    }
    const objectId = session.object.id
    let context: PromptContext
    try {
      context = await this.deps.contextFor(objectId)
    } catch (e) {
      // The prompt goes ahead without it rather than wait for the hook to time out.
      console.error(`no context for the prompt in ${objectId}: ${e instanceof Error ? e.message : String(e)}`)
      context = { text: '', sentMarkIds: [] }
    }
    const { text, sentMarkIds } = context
    if (this.deps.debug) console.error(`[torno] session ${session.id} hook ${event}${text ? `, answered with: ${text}` : ''}`)
    // Marks are sent once the answer that names them has been handed over whole: not when the agent hung
    // up first, and not to a session that has been hung up on, whose prompt nobody will answer.
    if (text && sentMarkIds.length > 0 && !session.killTimer) res.once('finish', () => this.deps.onDelivered?.(objectId, sentMarkIds))
    sendJson(res, 200, text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : {})
  }
}

function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 2), 1000) : fallback
}

function signal(child: pty.IPty, name: string): void {
  try {
    child.kill(name)
  } catch {
    // Already gone.
  }
}

/**
 * Kill an agent that ignored the hangup, and with it whatever it started: a
 * PTY's child leads a process group of its own. The process alone, if the
 * group is no longer there.
 */
function killGroup(pid: number): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return
    }
  }
}

/** torno's own switches (src/main/index.ts, e2e/): they mean nothing to the agent, or mislead what it starts. */
const OWN_VARIABLES = new Set(['TORNO_TEST', 'TORNO_AGENT_CMD', 'TORNO_CONFIG', 'TORNO_WORKSPACE', 'TORNO_DEBUG', 'TORNO_SHOTS', 'TORNO_BUILD_TIMEOUT'])

/**
 * What a Claude Code session exports to the processes it starts. Only these:
 * other CLAUDE_CODE_* variables (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_OAUTH_TOKEN, ...)
 * are settings a person makes on purpose, and the agent must get them.
 */
const PARENT_SESSION_VARIABLES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID'
])

/**
 * The environment an agent inherits: torno's, without torno's own switches and
 * without the marks of a Claude Code session. torno may have been started from
 * inside one, and the agent would then take itself for a child of that session.
 */
function agentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept = (name: string): boolean => !OWN_VARIABLES.has(name) && !PARENT_SESSION_VARIABLES.has(name)
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && kept(entry[0])))
}

/** The file a command names: itself when it is a path, else the first match on PATH. */
function findCommand(command: string, path = ''): string | null {
  const candidates = command.includes('/') ? [command] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {
      // Not here.
    }
  }
  return null
}

/**
 * `<object>/.torno/session.json` holds the conversation to resume. It is
 * written when the agent first names the conversation in the hook of a prompt,
 * so one that was opened and never used is not offered again.
 */
function storedConversation(dir: string): string | null {
  try {
    const file: unknown = JSON.parse(readFileSync(join(dir, FOLDER, FILE), 'utf8'))
    const id = (file as { conversationId?: unknown } | null)?.conversationId
    return typeof id === 'string' && UUID.test(id) ? id : null
  } catch {
    return null
  }
}

function storeConversation(dir: string, conversationId: string): void {
  const folder = join(dir, FOLDER)
  const path = join(folder, FILE)
  mkdirSync(folder, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ conversationId, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  renameSync(temp, path)
}

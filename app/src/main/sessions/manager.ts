import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import * as pty from 'node-pty'
import type { AgentId, SendState, SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { writeFileAtomic } from '../atomic'
import type { PromptContext } from '../context'
import { BodyTooLarge, type HttpRouter, readBody, sendJson } from '../http'
import type { AgentAdapter } from './adapter'
import { findCommand } from './choice'
import { followTyped, hasEnter, PROMPT_FILE, promptFile, sendLine } from './sendMarks'
import { HOOK_EVENTS, reduceStatus } from './status'

const FOLDER = '.torno'
const FILE = 'session.json'
/** `<object>/.torno/agent`: where an adapter's own files are written, for its agent to be pointed at. */
const AGENT_FOLDER = 'agent'
const AGENT_IDS: readonly AgentId[] = ['claude', 'copilot']
const HOOK_BODY_LIMIT = 1024 * 1024
const KILL_AFTER_MS = 2000
/** The hooks that say a conversation has a prompt in it: it exists for the agent, and can be resumed. */
const CONVERSATION_EVENTS = new Set(['UserPromptSubmit', 'Stop'])
/** The hooks that only say the agent is at work again. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])
/** C0 and C1 controls and DEL: among them ESC, the newlines and the one-byte CSI. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Session {
  id: string
  object: ObjectInfo
  /** The agent's id of the conversation, as its last hook named it. */
  conversationId: string
  /** The conversation the last prompt was in: the one it was started with, until a prompt names another. */
  promptedIn: string
  status: SessionStatus
  cols: number
  rows: number
  pty: pty.IPty
  exited: Promise<void>
  killTimer?: NodeJS.Timeout
  adapter: AgentAdapter
  /**
   * Of an agent without hooks: the marks told of by the file its line at the
   * cursor names, while that line is there and not sent; null when none is.
   */
  pending: string[] | null
  /** Of an agent without hooks: its conversation has been told nothing by torno yet, so no mark is known there by its number. */
  fresh: boolean
  /** Of an agent without hooks: its conversation is on file, to be resumed. */
  onFile: boolean
  /** The last writing of `.torno/prompt.md` for this session: one at a time, in the order asked. */
  telling: Promise<unknown>
}

export interface SessionInfo {
  sessionId: string
  status: SessionStatus
  cols: number
  rows: number
  pid: number
  agent: AgentId
  /** Whether its agent posts hooks: without, its status says only that it runs. */
  hooks: boolean
}

/** What `start` answers with: the session, at its size, as it stands, and whose it is. */
export interface Started {
  sessionId: string
  cols: number
  rows: number
  status: SessionStatus
  agent: AgentId
  hooks: boolean
}

interface Events {
  data: { sessionId: string; data: string }
  status: { sessionId: string; objectId: string; status: SessionStatus }
  /** What became of the line "Send marks" put at the cursor of an agent without hooks, and how many marks its file tells of. */
  send: { sessionId: string; objectId: string; state: SendState; marks: number }
}

/**
 * The agent sessions: each the real CLI in a PTY, in the folder of one object,
 * and at most one per object. The status of a session follows the hooks the
 * agent posts to `/hooks/<sessionId>/<event>` on the local HTTP server.
 *
 * An agent that posts none (`AgentAdapter.hooks` false) is `idle` from its
 * first output until it leaves, which says only that it runs. Nothing goes
 * with its prompts: `sendMarks` writes what a hook would have carried to
 * `<object>/.torno/prompt.md` and puts a line that names the file at its
 * cursor, and the marks that file tells of are delivered when the Enter that
 * sends the line is written to its terminal (`followTyped`), and not
 * otherwise.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>()
  /** By object: a session that is being started there. */
  private readonly starting = new Map<string, Promise<Started>>()
  private readonly listeners: { [E in keyof Events]: ((m: Events[E]) => void)[] } = { data: [], status: [], send: [] }

  constructor(
    private readonly deps: {
      http: HttpRouter
      /** The agent to run in an object: the one chosen for it. */
      adapterFor: (obj: ObjectInfo) => AgentAdapter | Promise<AgentAdapter>
      /**
       * What the agent should know with the next prompt in that object ('' for
       * nothing), and the marks that text tells of for the first time. Asking
       * changes nothing: `onDelivered` says when the agent has been given it.
       * `fresh` says the prompt is the first in a conversation other than the
       * last one: the agent started another (/clear), which has seen nothing.
       */
      contextFor: (objectId: string, opts: { fresh: boolean; toolName: (tool: string) => string }) => PromptContext | Promise<PromptContext>
      /**
       * The answer to a prompt's hook has left for the agent of that object,
       * and these marks were in it. Only ever for a UserPromptSubmit of a
       * session that is still the one of its object; or, of an agent without
       * hooks, for the Enter that sent the line naming the file they are in.
       */
      onDelivered?: (objectId: string, sentMarkIds: string[]) => void
      /** What an adapter that has a flag for it adds to its agent's system prompt. */
      systemPromptFor: (adapter: AgentAdapter) => string
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
   * Rejects when the agent's command cannot be found. The agent is the one
   * chosen for the object, which is read from the disk: a second call for an
   * object while the first is still starting there is answered with the first.
   */
  start(obj: ObjectInfo, opts: { resume?: boolean; cols?: number; rows?: number }): Promise<Started> {
    const running = this.of(obj.id)
    // With where it stands: nothing more may be said of a session that is waiting, and the caller would take it for starting.
    if (running) return Promise.resolve(started(running))
    const under = this.starting.get(obj.id)
    if (under) return under
    const begun = this.begin(obj, opts).finally(() => this.starting.delete(obj.id))
    this.starting.set(obj.id, begun)
    return begun
  }

  private async begin(obj: ObjectInfo, opts: { resume?: boolean; cols?: number; rows?: number }): Promise<Started> {
    const { http } = this.deps
    const adapter = await this.deps.adapterFor(obj)
    const id = randomUUID()
    // Only a conversation of this agent's own: another agent's id means nothing to it.
    const stored = opts.resume ? storedConversation(obj.dir, adapter.id) : null
    const conversationId = stored ?? randomUUID()
    const agentDir = join(obj.dir, FOLDER, AGENT_FOLDER)
    const person = agentEnv(process.env)
    const launch = adapter.launch({
      sessionId: id,
      conversationId,
      resume: stored !== null,
      cwd: obj.dir,
      mcpUrl: this.deps.mcpUrlFor(obj.id),
      hookUrl: (event) => http.url(`/hooks/${id}/${encodeURIComponent(event)}`),
      agentDir,
      systemPrompt: this.deps.systemPromptFor(adapter),
      env: person
    })
    if (this.deps.debug) console.error(`[torno] session ${id} in ${obj.dir}: ${JSON.stringify([launch.command, ...launch.args])}`)
    const env: Record<string, string> = { ...person, ...launch.env, COLORTERM: 'truecolor', TORNO_OBJECT: obj.id, TORNO_SESSION_ID: id }
    // node-pty reports a command that does not exist only as a process that exits at once.
    if (!findCommand(launch.command, env.PATH)) throw new Error(`cannot start the agent: '${launch.command}' was not found on PATH`)
    // What the agent is pointed at is whole before it starts. Nothing is made for an adapter that has no file.
    for (const [name, text] of Object.entries(launch.files ?? {})) await writeFileAtomic(join(agentDir, basename(name)), text)

    const cols = size(opts.cols, 80)
    const rows = size(opts.rows, 24)
    const child = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cols, rows, cwd: obj.dir, env })
    let ended!: () => void
    const session: Session = {
      id,
      object: obj,
      conversationId,
      promptedIn: conversationId,
      status: 'starting',
      cols,
      rows,
      pty: child,
      exited: new Promise<void>((resolve) => (ended = resolve)),
      adapter,
      pending: null,
      fresh: stored === null,
      onFile: stored !== null,
      telling: Promise.resolve()
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
      // A line that was never sent went with it: the marks it would have told of are drafts still.
      session.pending = null
      this.advance(session, 'exit')
      ended()
    })
    return started(session)
  }

  /** How many agents have not gone yet, counting those hung up on. */
  get size(): number {
    return this.sessions.size
  }

  /** The session running in an object's folder. */
  current(objectId: string): SessionInfo | null {
    const s = this.of(objectId)
    return s ? { sessionId: s.id, status: s.status, cols: s.cols, rows: s.rows, pid: s.pty.pid, agent: s.adapter.id, hooks: s.adapter.hooks } : null
  }

  /** Whether a session is being started in an object's folder and is not there yet. */
  isStarting(objectId: string): boolean {
    return this.starting.has(objectId)
  }

  /** The agent a session runs. None for a session that has ended. */
  agentOf(sessionId: string): AgentId | undefined {
    return this.sessions.get(sessionId)?.adapter.id
  }

  /**
   * The object a session is of: its id and its folder. None for a session
   * that has ended or been hung up on. Whoever passes on what a window typed
   * checks here that the session is one of the workspace that is open.
   */
  objectOf(sessionId: string): { id: string; dir: string } | undefined {
    const s = this.sessions.get(sessionId)
    return s && !s.killTimer ? { id: s.object.id, dir: s.object.dir } : undefined
  }

  /** Whether a conversation of that agent's is on file for the object, to resume. */
  resumable(obj: ObjectInfo, agent: AgentId): boolean {
    return storedConversation(obj.dir, agent) !== null
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.pty.write(data)
    if (!s.adapter.hooks && !s.killTimer) this.typed(s, data)
  }

  /**
   * What was written to the terminal of an agent without hooks is all torno
   * knows of what it was asked. An Enter says the person sent something: the
   * conversation is one to resume. And of a line torno put at its cursor it
   * says what became of it: sent by an Enter while it was still as put there,
   * and then the marks its file tells of are delivered; or possibly changed
   * first, and then they are not.
   */
  private typed(s: Session, data: string): void {
    if (!s.onFile && hasEnter(data)) {
      s.onFile = true
      try {
        storeConversation(s.object.dir, s.adapter.id, s.conversationId)
      } catch (e) {
        console.error(`cannot write ${join(s.object.dir, FOLDER, FILE)}: ${(e as Error).message}`)
      }
    }
    if (s.pending === null) return
    const became = followTyped(data)
    if (became === 'kept') return
    const marks = s.pending
    s.pending = null
    if (became === 'sent') {
      s.fresh = false
      if (marks.length > 0) this.deps.onDelivered?.(s.object.id, marks)
    }
    this.emit('send', { sessionId: s.id, objectId: s.object.id, state: became === 'sent' ? 'sent' : 'dropped', marks: marks.length })
  }

  /**
   * For an agent without hooks: writes what a hook would have carried with
   * its next prompt to `<object>/.torno/prompt.md` and puts one line that
   * names the file at its cursor, not sent. The marks the file tells of for
   * the first time are answered, and are delivered (`onDelivered`) by the
   * Enter that sends the line. While a line is already there, nothing more is
   * put in: the file and the marks it stands for are replaced.
   */
  sendMarks(sessionId: string): Promise<{ marks: string[]; line: string }> {
    const s = this.sessions.get(sessionId)
    if (!s || s.killTimer) return Promise.reject(new Error('This session has ended'))
    if (s.adapter.hooks) return Promise.reject(new Error('This agent is told with every prompt'))
    return this.tell(s, true).then((told) => told!)
  }

  /**
   * What is told of an object changed: its marks, or its build. While a line
   * waits at the cursor of its agent, the file that line names is written
   * again, so that what an Enter then sends for is what is so.
   */
  changed(objectId: string): void {
    const s = this.of(objectId)
    if (s && s.pending !== null) this.tell(s, false).catch((e) => console.error(`cannot write ${join(s.object.dir, FOLDER, PROMPT_FILE)} again: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Write the file of a session and, when `asked`, put its line at the cursor. Null when there was nothing to do. */
  private tell(s: Session, asked: boolean): Promise<{ marks: string[]; line: string } | null> {
    const told = s.telling
      .catch(() => {})
      .then(async () => {
        // Sent or lost while this waited its turn: the file is of a prompt that has gone.
        if (!asked && s.pending === null) return null
        const { text, sentMarkIds } = await this.deps.contextFor(s.object.id, { fresh: s.fresh, toolName: s.adapter.toolName })
        if (!text) {
          if (asked) throw new Error('Nothing to send: nothing has been built here yet')
          return null
        }
        await writeFileAtomic(join(s.object.dir, FOLDER, PROMPT_FILE), promptFile(text, new Date()))
        if (this.sessions.get(s.id) !== s || s.killTimer) {
          if (asked) throw new Error('This session has ended')
          return null
        }
        if (!asked && s.pending === null) return null
        const line = sendLine(sentMarkIds)
        // The line that is there names the file, whatever it holds by now.
        if (s.pending === null) this.insert(s.id, line)
        s.pending = sentMarkIds
        this.emit('send', { sessionId: s.id, objectId: s.object.id, state: 'waiting', marks: sentMarkIds.length })
        return { marks: sentMarkIds, line }
      })
    s.telling = told
    return told
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
    // One that is still starting is ended as well, once it is there.
    await Promise.allSettled([...this.starting.values()])
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
    // Nor of an agent that was given no hook to post: whatever posts there is not it.
    if (!session || !session.adapter.hooks) return sendJson(res, 404, { error: 'no such session' })
    // Only what the agent posts: `exit` and `output` are the PTY's to say, and would end a live session.
    if (!HOOK_EVENTS.includes(event)) return sendJson(res, 404, { error: 'no such hook' })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })

    // A tool hook says only that the agent is at work. Its body is the tool's input or result, which may
    // be megabytes: it is neither read nor parsed, and never a reason to refuse the hook.
    if (TOOL_EVENTS.has(event)) {
      req.resume()
      this.advance(session, event)
      if (this.deps.debug) console.error(`[torno] session ${session.id} hook ${event}`)
      return sendJson(res, 200, {})
    }

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
        storeConversation(session.object.dir, session.adapter.id, conversation)
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
    // Another conversation than the last prompt was in: the agent began anew, and knows no mark by its number.
    const named = typeof conversation === 'string' && UUID.test(conversation) ? conversation : undefined
    const fresh = named !== undefined && named !== session.promptedIn
    if (named !== undefined) session.promptedIn = named
    let context: PromptContext
    try {
      context = await this.deps.contextFor(objectId, { fresh, toolName: session.adapter.toolName })
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

function started(s: Session): Started {
  return { sessionId: s.id, cols: s.cols, rows: s.rows, status: s.status, agent: s.adapter.id, hooks: s.adapter.hooks }
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
 * group is no longer there. Nothing for a pid that is not above 1.
 */
export function killGroup(pid: number, kill: (target: number, signal: string) => void = process.kill): void {
  // Never 0 or 1 negated: -0 is this process's own group, and -1 every process it may signal.
  if (!Number.isInteger(pid) || pid <= 1) return
  for (const target of [-pid, pid]) {
    try {
      kill(target, 'SIGKILL')
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return
    }
  }
}

/** torno's own switches (src/main/index.ts, e2e/): they mean nothing to the agent, or mislead what it starts. */
const OWN_VARIABLES = new Set(['TORNO_TEST', 'TORNO_AGENT_CMD', 'TORNO_CONFIG', 'TORNO_WORKSPACE', 'TORNO_DEBUG', 'TORNO_SHOTS', 'TORNO_BUILD_TIMEOUT', 'TORNO_KEEP_BUILDS'])

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

interface Kept {
  conversationId: string
  updatedAt?: string
}

/** What `session.json` holds, read with nothing taken on trust: the last conversation and whose it is, and those kept of the other agents. */
function readStored(dir: string): { last: (Kept & { agent: AgentId }) | null; kept: Partial<Record<AgentId, Kept>> } {
  let file: Record<string, unknown>
  try {
    const read: unknown = JSON.parse(readFileSync(join(dir, FOLDER, FILE), 'utf8'))
    if (typeof read !== 'object' || read === null) return { last: null, kept: {} }
    file = read as Record<string, unknown>
  } catch {
    return { last: null, kept: {} }
  }
  const one = (value: unknown): Kept | null => {
    const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    if (typeof entry.conversationId !== 'string' || !UUID.test(entry.conversationId)) return null
    return { conversationId: entry.conversationId, ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}) }
  }
  // A file from before agents were chosen names none: it is Claude Code's. One that names an agent torno does not know is nobody's.
  const agent = file.agent === undefined ? 'claude' : AGENT_IDS.find((id) => id === file.agent)
  const top = one(file)
  const others = (typeof file.kept === 'object' && file.kept !== null ? file.kept : {}) as Record<string, unknown>
  const kept: Partial<Record<AgentId, Kept>> = {}
  for (const id of AGENT_IDS) {
    const entry = one(others[id])
    if (entry && id !== agent) kept[id] = entry
  }
  return { last: top && agent ? { ...top, agent } : null, kept }
}

/**
 * `<object>/.torno/session.json` holds the conversation to resume, and the
 * agent it is of: `{ "conversationId", "agent", "updatedAt" }`, and under
 * `kept` the last conversation of each other agent that has had one here, so
 * that going to another agent and back loses neither. It is written when the
 * agent first names the conversation in the hook of a prompt (for an agent
 * without hooks: when the person first sends it a line), so one that was
 * opened and never used is not offered again. A conversation is only ever
 * resumed by the agent it is of.
 */
function storedConversation(dir: string, agent: AgentId): string | null {
  const { last, kept } = readStored(dir)
  return (last?.agent === agent ? last.conversationId : kept[agent]?.conversationId) ?? null
}

function storeConversation(dir: string, agent: AgentId, conversationId: string): void {
  const folder = join(dir, FOLDER)
  const path = join(folder, FILE)
  const { last, kept } = readStored(dir)
  if (last && last.agent !== agent) kept[last.agent] = { conversationId: last.conversationId, ...(last.updatedAt ? { updatedAt: last.updatedAt } : {}) }
  delete kept[agent]
  mkdirSync(folder, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const file = { conversationId, agent, updatedAt: new Date().toISOString(), ...(Object.keys(kept).length > 0 ? { kept } : {}) }
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`)
  renameSync(temp, path)
}

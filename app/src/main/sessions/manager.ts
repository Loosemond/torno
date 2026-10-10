import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import * as pty from 'node-pty'
import type { AgentId, SendDropped, SendState, SessionStatus } from '../../shared/bridge'
import type { ObjectInfo } from '../../shared/workspace'
import { writeFileAtomic } from '../atomic'
import { ensureIgnored } from '../ignored'
import type { PromptContext } from '../context'
import { BodyTooLarge, type HttpRouter, readBody, sendJson } from '../http'
import type { AgentAdapter } from './adapter'
import { findCommand } from './choice'
import { type Told, blankPrompt, Delivery, untold } from './delivery'
import { PROMPT_FILE } from './sendMarks'
import { conversationTold, SESSION_FILE, storeConversation, storedConversation, UUID } from './resume'
import { HOOK_EVENTS, reduceStatus } from './status'

const FOLDER = '.torno'
/** `<object>/.torno/agent`: where an adapter's own files are written, for its agent to be pointed at. */
const AGENT_FOLDER = 'agent'
const HOOK_BODY_LIMIT = 1024 * 1024
const KILL_AFTER_MS = 2000
/** The hooks that say a conversation has a prompt in it: it exists for the agent, and can be resumed. */
const CONVERSATION_EVENTS = new Set(['UserPromptSubmit', 'Stop'])
/** The hooks that only say the agent is at work again. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])
/** C0 and C1 controls and DEL: among them ESC, the newlines and the one-byte CSI. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

interface Session extends Told {
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
  send: { sessionId: string; objectId: string; state: SendState; marks: number; why?: SendDropped }
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
  /** How an agent without hooks is told, and when what it was told counts as sent. */
  private readonly delivery: Delivery<Session>
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
    this.delivery = new Delivery<Session>({
      contextFor: deps.contextFor,
      onDelivered: deps.onDelivered,
      live: (s) => this.sessions.get(s.id) === s && !s.killTimer,
      insert: (s, text) => this.insert(s.id, text),
      said: (s, state, marks, why) => this.emit('send', { sessionId: s.id, objectId: s.object.id, state, marks, ...(why ? { why } : {}) })
    })
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
    // What the agent is pointed at is whole before it starts, in a folder that is torno's own and inside the
    // object: a link there (a workspace from elsewhere) would have torno write, and the agent read, wherever it
    // leads. Nothing is made for an adapter that has no file.
    const files = Object.entries(launch.files ?? {})
    if (files.length > 0) {
      await ownFolder(join(obj.dir, FOLDER))
      await ownFolder(agentDir)
      for (const [name, text] of files) await writeFileAtomic(join(agentDir, basename(name)), text)
    }
    if (!adapter.hooks) {
      // What changes with every send, and what is written anew at every start, is not for git. The choice of
      // agent (`agent.json`) is the object's and travels with it, as `scene.json` does.
      await ensureIgnored(obj.dir, [PROMPT_FILE, ...(files.length > 0 ? [`${AGENT_FOLDER}/`] : [])])
      // Whatever the file told an earlier session of is not news to this one.
      await blankPrompt(obj.dir)
    }

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
      // A conversation that is resumed has seen the marks only if a line of torno's was sent in it.
      ...untold(stored === null || !conversationTold(obj.dir, adapter.id, stored), stored !== null)
    }
    this.sessions.set(id, session)
    this.emit('status', { sessionId: id, objectId: obj.id, status: 'starting' })

    child.onData((data) => {
      this.emit('data', { sessionId: id, data })
      if (!adapter.hooks) this.delivery.output(session, data)
      this.advance(session, 'output')
    })
    child.onExit(() => {
      clearTimeout(session.killTimer)
      this.sessions.delete(id)
      this.advance(session, 'exit')
      // A line that was never sent went with it: the marks it would have told of are drafts still, and the
      // file is made to say so before the session counts as gone.
      if (adapter.hooks) ended()
      else void this.delivery.ended(session).then(ended)
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
    if (!s.adapter.hooks && !s.killTimer) this.delivery.typed(s, data)
  }

  /**
   * For an agent without hooks: writes what a hook would have carried with its next prompt to
   * `<object>/.torno/prompt.md` and puts one line that names the file at its cursor, not sent (`Delivery`).
   */
  sendMarks(sessionId: string): Promise<{ marks: string[]; line: string }> {
    const s = this.sessions.get(sessionId)
    if (!s || s.killTimer) return Promise.reject(new Error('This session has ended'))
    if (s.adapter.hooks) return Promise.reject(new Error('This agent is told with every prompt'))
    return this.delivery.send(s)
  }

  /** What is told of an object changed: its marks, or its build. A file that a waiting line names follows it. */
  changed(objectId: string): void {
    const s = this.of(objectId)
    if (s) this.delivery.changed(s)
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
      // On file before the hook is answered: whoever sees the answer can resume.
      await storeConversation(session.object.dir, session.adapter.id, conversation).catch((e) => console.error(`cannot write ${join(session.object.dir, FOLDER, SESSION_FILE)}: ${(e as Error).message}`))
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

/**
 * Makes a folder torno writes an agent's instructions into, or rejects when what is there under its name is
 * not a folder of its own: a link, which would lead the writing out of the object, or a file.
 */
async function ownFolder(path: string): Promise<void> {
  const what = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (what === null) return void (await mkdir(path))
  if (what.isSymbolicLink()) throw new Error(`cannot start the agent: ${path} is a link, not a folder of torno's own inside the object. Remove the link and start again.`)
  if (!what.isDirectory()) throw new Error(`cannot start the agent: ${path} is not a folder. Remove it and start again.`)
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

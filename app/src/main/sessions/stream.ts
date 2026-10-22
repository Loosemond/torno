import { type ChildProcess, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AgentAsk, AgentEvents, AgentMessage, AgentTransport, AskAnswer, PromptBlock } from './transport'

/** The stream's own names of the messages and asks of `transport.ts`, which the tests of the stream know them by. */
export type { AgentMessage as StreamMessage, AgentAsk as StreamAsk, AskAnswer, PromptBlock } from './transport'

/** A line over this many characters is dropped: a tool result of megabytes is welcome, a runaway is not. */
const MAX_LINE = 16 * 1024 * 1024
const CONTROL_TIMEOUT_MS = 10_000
/** How much of a line that is not JSON, or of the CLI's stderr, is kept in a note. */
const NOTE_CHARS = 300

interface Waiting {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Claude Code in its headless mode, through pipes (`claude.ts` in view `chat`): a prompt is a line of JSON on its
 * stdin and everything it does is a line of JSON on its stdout (app/test/fixtures/claude-stream.jsonl is a
 * recording). This frames those lines and speaks the requests both ways, and knows nothing of what the messages
 * mean: that is the transcript's. The one `AgentTransport` there is (`claudeAdapter`'s `chat`).
 *
 * What the CLI prints that torno does not know is never an error. A line that is not JSON, or an object without
 * a `type`, is a `note`; a line over `maxLine` is dropped, with a `note`, and the next one is read. The process
 * leads a group of its own (`detached`), which `killGroup` can end.
 */
export class ClaudeStream implements AgentTransport {
  readonly pid: number
  private readonly child: ChildProcess
  private readonly listeners: { [E in keyof AgentEvents]: AgentEvents[E][] } = { message: [], ask: [], note: [], stderr: [], exit: [] }
  private readonly waiting = new Map<string, Waiting>()
  private readonly maxLine: number
  private requests = 0
  /** The part of a line read so far, and whether the line is being dropped for its length. */
  private partial = ''
  private dropping = false
  private over = false

  constructor(opts: { command: string; args: string[]; cwd: string; env: Record<string, string>; maxLine?: number }) {
    this.maxLine = opts.maxLine ?? MAX_LINE
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    this.pid = this.child.pid ?? 0
    const decoder = new StringDecoder('utf8')
    this.child.stdout!.on('data', (chunk: Buffer) => this.read(decoder.write(chunk)))
    this.child.stdout!.on('end', () => {
      this.read(decoder.end())
      this.line(this.partial)
      this.partial = ''
    })
    // Said by the CLI on its own account: kept for a debug log, not for the transcript.
    this.child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.emit('stderr', text)
      this.emit('note', `stderr: ${text.trim().slice(0, NOTE_CHARS)}`)
    })
    // The pipe of a process that has gone is not an error of ours.
    this.child.stdin!.on('error', () => undefined)
    this.child.on('error', (e) => this.emit('note', `cannot run the CLI: ${e.message}`))
    this.child.on('close', (code, signal) => {
      this.over = true
      for (const [id, wait] of this.waiting) {
        clearTimeout(wait.timer)
        wait.reject(new Error('The agent has exited'))
        this.waiting.delete(id)
      }
      this.emit('exit', code, signal)
    })
  }

  on<E extends keyof AgentEvents>(event: E, cb: AgentEvents[E]): void {
    this.listeners[event].push(cb)
  }

  /** A prompt for the conversation, as the CLI takes it: text, and pictures, with an id of its own. The CLI queues it if it is at work. */
  prompt(content: PromptBlock[], conversationId: string, uuid?: string): void {
    // The `uuid` is what the CLI's `command_lifecycle` names the prompt by.
    this.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: conversationId, ...(uuid !== undefined ? { uuid } : {}) })
  }

  /**
   * A request of ours (`initialize`, `interrupt`, `set_model`), resolved with what the CLI answers it. Rejected
   * by the CLI's error, by the time limit, and by the CLI leaving (or having left) before it answered.
   */
  control(request: { subtype: string; [key: string]: unknown }, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.over || !this.child.stdin!.writable) return reject(new Error('The agent has exited'))
      this.requests += 1
      const id = `req_${this.requests}`
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`The agent did not answer ${request.subtype} in ${Math.round(timeoutMs / 100) / 10} s`))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.send({ type: 'control_request', request_id: id, request })
    })
  }

  /** An `interrupt` request: the CLI stops the turn at work and answers with the prompts it keeps (`still_queued`). */
  interrupt(timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    return this.control({ subtype: 'interrupt' }, timeoutMs)
  }

  /** The answer to a `can_use_tool` request the CLI made. */
  answer(requestId: string, response: AskAnswer): void {
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }

  /** Closes the CLI's stdin: it finishes what it is doing and exits by itself. */
  end(): void {
    if (this.child.stdin!.writable) this.child.stdin!.end()
  }

  private send(message: object): void {
    const stdin = this.child.stdin!
    if (!stdin.writable) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private emit<E extends keyof AgentEvents>(event: E, ...args: Parameters<AgentEvents[E]>): void {
    // A listener that throws must not stop the reading: it is a note (and a note's own listener is let be).
    for (const cb of this.listeners[event]) {
      try {
        ;(cb as (...a: Parameters<AgentEvents[E]>) => void)(...args)
      } catch (e) {
        if (event !== 'note') this.emit('note', `a listener of ${event} threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** Text as it comes: whole lines are handled, the rest waits for its end. */
  private read(text: string): void {
    let from = 0
    for (;;) {
      const end = text.indexOf('\n', from)
      if (end < 0) break
      const rest = text.slice(from, end)
      from = end + 1
      if (this.dropping) {
        this.dropping = false
        this.partial = ''
        continue
      }
      const whole = this.partial + rest
      this.partial = ''
      if (whole.length > this.maxLine) this.emit('note', `a line of ${whole.length} characters was too long and was dropped`)
      else this.line(whole)
    }
    const tail = text.slice(from)
    if (this.dropping) return
    this.partial += tail
    if (this.partial.length > this.maxLine) {
      this.emit('note', `a line of more than ${this.maxLine} characters was too long and was dropped`)
      this.partial = ''
      this.dropping = true
    }
  }

  private line(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return this.emit('note', `not JSON: ${trimmed.slice(0, NOTE_CHARS)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== 'string') {
      return this.emit('note', `not a message: ${trimmed.slice(0, NOTE_CHARS)}`)
    }
    const message = parsed as AgentMessage
    if (message.type === 'control_response' && this.answered(message)) return
    if (message.type === 'control_request' && this.asked(message)) return
    this.emit('message', message)
  }

  /** Whether a control_response was the answer to a request of ours, which it then settles. */
  private answered(message: AgentMessage): boolean {
    const response = message.response as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } | undefined
    const id = response?.request_id
    const wait = typeof id === 'string' ? this.waiting.get(id) : undefined
    if (!wait || typeof id !== 'string') return false
    clearTimeout(wait.timer)
    this.waiting.delete(id)
    if (response?.subtype === 'error') wait.reject(new Error(typeof response.error === 'string' ? response.error : 'The agent refused the request'))
    else wait.resolve(response?.response)
    return true
  }

  /** A request of the CLI's: a `can_use_tool` is an ask, anything else is refused. Whether it was one of those. */
  private asked(message: AgentMessage): boolean {
    const id = message.request_id
    const request = message.request as { subtype?: unknown; tool_name?: unknown; input?: unknown; tool_use_id?: unknown; permission_suggestions?: unknown; description?: unknown; blocked_path?: unknown } | undefined
    if (typeof id !== 'string') return false
    if (request?.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string') {
      this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'not supported' } })
      return true
    }
    const ask: AgentAsk = {
      requestId: id,
      toolName: request.tool_name,
      input: request.input,
      ...(typeof request.tool_use_id === 'string' ? { toolUseId: request.tool_use_id } : {}),
      ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions } : {}),
      ...(typeof request.description === 'string' && request.description !== '' ? { description: request.description } : {}),
      ...(typeof request.blocked_path === 'string' && request.blocked_path !== '' ? { blockedPath: request.blocked_path } : {})
    }
    this.emit('ask', ask)
    return true
  }
}

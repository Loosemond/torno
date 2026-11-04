/** One message of the agent's, typed loosely: what torno does not know of it is carried along, never refused. */
export interface AgentMessage {
  type: string
  [key: string]: unknown
}

/** A request of the agent's that waits for the person: it may use a tool (`can_use_tool`). Answered by `answer`. */
export interface AgentAsk {
  requestId: string
  toolName: string
  input: unknown
  toolUseId?: string
  suggestions?: unknown[]
  /** What the agent says in words of what it asks (`description`), and the path it is blocked on (`blocked_path`). */
  description?: string
  blockedPath?: string
}

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } }

/** What to answer a `can_use_tool` request with. */
export type AskAnswer =
  | { behavior: 'allow'; updatedInput: unknown; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string }

/** What a running chat tells its session. Nothing is told after `exit`. */
export interface AgentEvents {
  /** Whatever the agent says of the conversation and of itself (Claude Code's `stream-json` messages): the transcript's to read. */
  message: (m: AgentMessage) => void
  /** The agent waits for the person (`AgentAsk`), until `answer` or until it gives the request up (`control_cancel_request`). */
  ask: (req: AgentAsk) => void
  /** Something of the transport's own (a line that was no message, a listener that threw): for a debug log, never the person. */
  note: (text: string) => void
  /** What the agent wrote of itself outside the conversation (Claude Code's stderr), as it came: what the person is told should it stop. */
  stderr: (text: string) => void
  /** The agent has gone, with its exit code or the signal that ended it. */
  exit: (code: number | null, signal: string | null) => void
}

/**
 * A chat as `Sessions` (`manager.ts`) drives it: what it asks of a running agent and what it hears from it, and
 * nothing of how the two are joined. `ClaudeStream` (`stream.ts`, Claude Code's headless mode on pipes) is the one
 * there is; the adapter makes it (`AgentAdapter.chat`) and says how the agent is launched. The messages are Claude
 * Code's, whatever carries them: the transcript reads them as they are.
 */
export interface AgentTransport {
  on<E extends keyof AgentEvents>(event: E, cb: AgentEvents[E]): void
  /** A prompt for the conversation (text, and pictures), with an id of its own that the agent names it by when it takes it up. The agent queues it if it is at work. */
  prompt(content: PromptBlock[], conversationId: string, uuid?: string): void
  /**
   * A request of torno's (`initialize`, `set_model`), resolved with what the agent answers. Rejected by the agent's
   * error, by the time limit, and by the agent leaving (or having left) before it answered.
   */
  control(request: { subtype: string; [key: string]: unknown }, timeoutMs?: number): Promise<unknown>
  /** The turn at work is stopped; the prompts queued behind it are kept (the answer's `still_queued`). Rejected as `control` is. */
  interrupt(timeoutMs?: number): Promise<unknown>
  /** The person's answer to an `ask`. */
  answer(requestId: string, response: AskAnswer): void
  /** The session is over: the agent finishes what it is doing and leaves by itself. */
  end(): void
  /** The agent did not leave once `end` was called: ask it to, and stop whatever it started. */
  terminate(): void
  /** It still did not: end it, and whatever it started, at once. */
  kill(): void
}

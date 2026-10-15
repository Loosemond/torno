// The transcript of a chat session: what Claude Code said and did, what the person said to it, and what torno
// added or was asked for on the way. Main reduces the CLI's stream to these items (`main/sessions/transcript.ts`),
// keeps them, and tells the window of each as it changes; the window draws them. An item is upserted by its `id`:
// a change sends the whole item again.

/** A picture in the conversation. `data` (base64) is absent once it is not kept, and is never written to the log. */
export interface ChatImage {
  id: string
  mediaType: string
  data?: string
  width?: number
  height?: number
}

export type ChatItem =
  /** What the person sent. `queued` until the CLI takes the prompt up (a prompt sent while it works waits). */
  | { kind: 'user'; id: string; text: string; images: ChatImage[]; state: 'queued' | 'sent' | 'not-sent'; at: number }
  /** What torno added to that prompt (the context a `UserPromptSubmit` was answered with), shown under it. */
  | { kind: 'context'; id: string; forUser: string; text: string; marks: string[] }
  /** The agent's words, as markdown. */
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  /** The agent thought. This CLI leaves the text of a thought empty. */
  | { kind: 'thinking'; id: string; seconds?: number; streaming: boolean }
  /** A tool the agent used; `torno` when it is one of torno's own (`mcp__torno__<tool>`). */
  | { kind: 'tool'; id: string; toolUseId: string; name: string; torno: boolean; input: unknown; state: 'running' | 'done' | 'error' | 'stopped'; result?: string; images: ChatImage[]; detail?: unknown }
  /** The agent asks the person: to use a tool, or a question. */
  | { kind: 'ask'; id: string; requestId: string; toolName: string; input: unknown; suggestions: boolean; state: 'open' | 'allowed' | 'denied' | 'ended'; answer?: string }
  /** The end of a turn, with what was pulled from torno in it (`pulledFromTorno`). */
  | { kind: 'turn'; id: string; ok: boolean; stopped: boolean; seconds: number; pulled: Record<string, number>; error?: string }
  /** Something torno says about the conversation: the model changed, torno's tools are not connected, the session ended. */
  | { kind: 'note'; id: string; text: string; tone: 'quiet' | 'warn' }

/** What is known of the session as a whole, apart from the items. */
export interface ChatMeta {
  model?: string
  /** Whether the CLI says the MCP server of torno is connected; absent until it has said. */
  tornoConnected?: boolean
  /** The window of the CLI's rate limit that is the most used: its name (`five_hour`), the percent used, and when it resets (ms). */
  rate?: { window: string; used: number; resetsAt?: number }
}

/** The slash commands and models a chat session's CLI offers. */
export interface ChatCommand {
  name: string
  description: string
  argumentHint: string
}
export interface ChatModel {
  value: string
  displayName: string
}

/** What the window asks for to draw a session's transcript, whenever it starts or is reloaded. */
export interface ChatHistory {
  items: ChatItem[]
  meta: ChatMeta
  /** The items of the conversation this session resumed, from `.torno/chat/`, and a note on what they leave out. Empty for a fresh one. */
  earlier: ChatItem[]
  commands: ChatCommand[]
  models: ChatModel[]
  /**
   * How many things main has told of this session so far. Every item and meta it tells afterwards carries a larger
   * `seq`: one with a `seq` up to this holds nothing the history does not, and is dropped.
   */
  seq: number
}

/** What the person answers a request of the agent's with. `updatedInput` is taken only for `AskUserQuestion`. */
export type ChatAnswer = { allow: true; always?: boolean; updatedInput?: unknown } | { allow: false; message: string }

/** The name of the tools torno gives the agent, as the CLI names them. */
export const TORNO_TOOL_PREFIX = 'mcp__torno__'

export const isTornoTool = (name: string): boolean => name.startsWith(TORNO_TOOL_PREFIX)

/**
 * A mark (`M4`), a build (`r12`), a face or an edge of a part (`lid/F12`, `tub_2/E10`). A letter alone, a face
 * number alone and a decimal are none, nor is the name of a part standing alone.
 */
const REF = /(\bM\d+\b|\br\d+\b|[\w.-]+\/[FE]\d+\b)/

/** A text in pieces: plain text and refs, in order. A piece with a `ref` is one. */
export function refsIn(text: string): Array<{ text: string; ref?: string }> {
  if (text === '') return []
  const pieces: Array<{ text: string; ref?: string }> = []
  text.split(REF).forEach((piece, n) => {
    if (piece === '') return
    pieces.push(n % 2 === 1 ? { text: piece, ref: piece } : { text: piece })
  })
  return pieces
}

const LABEL_CHARS = 80

const field = (input: unknown, key: string): string | undefined => {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

const cut = (text: string): string => {
  const line = text.split('\n')[0]
  return line.length > LABEL_CHARS ? line.slice(0, LABEL_CHARS) : line
}

/** One line for a tool the agent used: what a person would read to know what it did. */
export function toolLabel(name: string, input: unknown): string {
  if (isTornoTool(name)) {
    const tool = name.slice(TORNO_TOOL_PREFIX.length)
    const refs = typeof input === 'object' && input !== null && Array.isArray((input as { refs?: unknown }).refs) ? (input as { refs: unknown[] }).refs.filter((r): r is string => typeof r === 'string') : []
    const hint = field(input, 'view') ?? field(input, 'ref') ?? field(input, 'id') ?? field(input, 'kind') ?? (refs.length > 0 ? refs.slice(0, 3).join(', ') : undefined)
    return `torno · ${tool}${hint ? ` (${cut(hint)})` : ''}`
  }
  let detail: string | undefined
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const file = field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
    return file ? `${name} ${file}` : name
  }
  if (name === 'Bash') detail = field(input, 'command')
  else if (name === 'Grep' || name === 'Glob') detail = field(input, 'pattern')
  else if (name === 'Task') detail = field(input, 'description')
  return detail ? `${name}: ${cut(detail)}` : name
}

/** "Pulled from torno: scene, 2 pictures, measure ×3": what a turn took from torno's tools, or null when nothing. */
export function pulledFromTorno(pulled: Record<string, number>): string | null {
  const parts = Object.entries(pulled)
    .filter(([, count]) => count > 0)
    .map(([what, count]) => (what === 'pictures' ? `${count} ${count === 1 ? 'picture' : 'pictures'}` : count === 1 ? what : `${what} ×${count}`))
  return parts.length > 0 ? `Pulled from torno: ${parts.join(', ')}` : null
}

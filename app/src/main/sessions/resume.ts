import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '../../shared/bridge'
import { writeFileAtomic } from '../atomic'

const FOLDER = '.torno'
export const SESSION_FILE = 'session.json'
const AGENT_IDS: readonly AgentId[] = ['claude', 'copilot']
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Kept {
  conversationId: string
  updatedAt?: string
  /** Of an agent without hooks: a line of torno's was sent in it, so it knows the marks it was told of by their numbers. */
  told?: true
}

/** What `session.json` holds, read with nothing taken on trust: the last conversation and whose it is, and those kept of the other agents. */
function readStored(dir: string): { last: (Kept & { agent: AgentId }) | null; kept: Partial<Record<AgentId, Kept>> } {
  let file: Record<string, unknown>
  try {
    const read: unknown = JSON.parse(readFileSync(join(dir, FOLDER, SESSION_FILE), 'utf8'))
    if (typeof read !== 'object' || read === null) return { last: null, kept: {} }
    file = read as Record<string, unknown>
  } catch {
    return { last: null, kept: {} }
  }
  const one = (value: unknown): Kept | null => {
    const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    if (typeof entry.conversationId !== 'string' || !UUID.test(entry.conversationId)) return null
    return { conversationId: entry.conversationId, ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}), ...(entry.told === true ? { told: true as const } : {}) }
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

/** What is on file of an agent's last conversation in an object. */
function entryOf(dir: string, agent: AgentId): Kept | null {
  const { last, kept } = readStored(dir)
  return (last?.agent === agent ? last : kept[agent]) ?? null
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
export function storedConversation(dir: string, agent: AgentId): string | null {
  return entryOf(dir, agent)?.conversationId ?? null
}

/** Whether a line of torno's was sent in that conversation of an agent without hooks (`told`). */
export function conversationTold(dir: string, agent: AgentId, conversationId: string): boolean {
  const entry = entryOf(dir, agent)
  return entry?.conversationId === conversationId && entry.told === true
}

/** One change at a time per file: what is kept of the other agents is read before it is written. */
const turns = new Map<string, Promise<void>>()

/**
 * Puts a conversation on file as its agent's last, whole or not at all
 * (`writeFileAtomic`). `told` says a line of torno's was sent in it; once
 * said of a conversation it stays said.
 */
export function storeConversation(dir: string, agent: AgentId, conversationId: string, opts: { told?: boolean } = {}): Promise<void> {
  const path = join(dir, FOLDER, SESSION_FILE)
  const turn = (turns.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const { last, kept } = readStored(dir)
      const before = last?.agent === agent ? last : kept[agent]
      const told = opts.told === true || (before?.conversationId === conversationId && before.told === true)
      if (last && last.agent !== agent) kept[last.agent] = { conversationId: last.conversationId, ...(last.updatedAt ? { updatedAt: last.updatedAt } : {}), ...(last.told ? { told: true as const } : {}) }
      delete kept[agent]
      const file = { conversationId, agent, updatedAt: new Date().toISOString(), ...(told ? { told: true } : {}), ...(Object.keys(kept).length > 0 ? { kept } : {}) }
      await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`)
    })
    .finally(() => {
      if (turns.get(path) === turn) turns.delete(path)
    })
  turns.set(path, turn)
  return turn
}

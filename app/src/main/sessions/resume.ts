import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '../../shared/bridge'

const FOLDER = '.torno'
export const SESSION_FILE = 'session.json'
const AGENT_IDS: readonly AgentId[] = ['claude', 'copilot']
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Kept {
  conversationId: string
  updatedAt?: string
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
export function storedConversation(dir: string, agent: AgentId): string | null {
  const { last, kept } = readStored(dir)
  return (last?.agent === agent ? last.conversationId : kept[agent]?.conversationId) ?? null
}

export function storeConversation(dir: string, agent: AgentId, conversationId: string): void {
  const folder = join(dir, FOLDER)
  const path = join(folder, SESSION_FILE)
  const { last, kept } = readStored(dir)
  if (last && last.agent !== agent) kept[last.agent] = { conversationId: last.conversationId, ...(last.updatedAt ? { updatedAt: last.updatedAt } : {}) }
  delete kept[agent]
  mkdirSync(folder, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const file = { conversationId, agent, updatedAt: new Date().toISOString(), ...(Object.keys(kept).length > 0 ? { kept } : {}) }
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`)
  renameSync(temp, path)
}

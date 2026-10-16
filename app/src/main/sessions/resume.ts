import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureIgnored } from '../ignored'
import { FOLDER, writeOwn } from '../own'

export const SESSION_FILE = 'session.json'
/** The agent a conversation on file is of: Claude Code's, the one torno runs. */
const AGENT = 'claude'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A conversation as the file holds it, read with nothing taken on trust: its id, or null. */
function conversationOf(value: unknown): string | null {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return typeof entry.conversationId === 'string' && UUID.test(entry.conversationId) ? entry.conversationId : null
}

/**
 * `<object>/.torno/session.json` holds the conversation to resume: `{ "conversationId", "agent", "updatedAt" }`.
 * It is written when Claude Code first names the conversation in the hook of a prompt, so one that was opened and
 * never used is not offered again. A file from before agents were chosen names none, and is Claude Code's; one
 * that names another agent (written by a torno that also ran Copilot CLI) holds Claude Code's last conversation,
 * if it had one, under `kept`. Only a conversation of Claude Code's is ever resumed.
 */
export function storedConversation(dir: string): string | null {
  let file: Record<string, unknown>
  try {
    const read: unknown = JSON.parse(readFileSync(join(dir, FOLDER, SESSION_FILE), 'utf8'))
    if (typeof read !== 'object' || read === null) return null
    file = read as Record<string, unknown>
  } catch {
    return null
  }
  if (file.agent === undefined || file.agent === AGENT) return conversationOf(file)
  return conversationOf((file.kept as Record<string, unknown> | undefined)?.[AGENT])
}

/** One change at a time per file. */
const turns = new Map<string, Promise<void>>()

/** Puts a conversation on file as the last, whole or not at all (`writeFileAtomic`). */
export function storeConversation(dir: string, conversationId: string): Promise<void> {
  const path = join(dir, FOLDER, SESSION_FILE)
  const turn = (turns.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const file = { conversationId, agent: AGENT, updatedAt: new Date().toISOString() }
      await writeOwn(dir, SESSION_FILE, `${JSON.stringify(file, null, 2)}\n`)
      // Which conversation was last is of this machine and changes with every session: not for git.
      await ensureIgnored(dir, [SESSION_FILE])
    })
    .finally(() => {
      if (turns.get(path) === turn) turns.delete(path)
    })
  turns.set(path, turn)
  return turn
}

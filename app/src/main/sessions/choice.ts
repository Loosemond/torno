import { accessSync, constants, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { AgentView } from '../../shared/bridge'
import { FOLDER, writeOwn } from '../own'

const FILE = 'agent.json'
/** The agent the file names: the one torno runs. Written still, so that the file stays one an older torno reads. */
const AGENT = 'claude'
/** Agents an older torno could run, and that the file may name: said by name when it does. */
const RETIRED: Readonly<Record<string, string>> = { copilot: 'Copilot CLI' }
/** The most that is repeated of a name the file gives that is no agent's. */
const NAMED_LIMIT = 40
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

const isView = (value: unknown): value is AgentView => value === 'chat' || value === 'terminal'

const UNREADABLE = 'agent.json could not be read: Claude Code is used.'

function short(named: string): string {
  const plain = named.replace(CONTROL_CHARACTERS, '')
  return plain.length > NAMED_LIMIT ? `${plain.slice(0, NAMED_LIMIT - 1)}…` : plain
}

/** What the file says, as it says it: the view it names, and why it cannot be followed, if it cannot. */
async function readRaw(dir: string): Promise<{ view?: AgentView; note?: string }> {
  let text: string
  try {
    text = await readFile(join(dir, FOLDER, FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { note: UNREADABLE }
  }
  let file: { agent?: unknown; view?: unknown } | null
  try {
    file = JSON.parse(text) as { agent?: unknown; view?: unknown } | null
  } catch {
    return { note: UNREADABLE }
  }
  const named = file?.agent
  if (named !== AGENT) {
    if (typeof named !== 'string' || named === '') return { note: UNREADABLE }
    if (Object.hasOwn(RETIRED, named)) return { note: `agent.json names ${RETIRED[named]}, which torno no longer supports: Claude Code is used.` }
    return { note: `agent.json names "${short(named)}", which torno does not know: Claude Code is used.` }
  }
  const view = file?.view
  if (view === undefined || isView(view)) return { view }
  return { note: `agent.json names the view "${short(typeof view === 'string' ? view : JSON.stringify(view) ?? '')}", which torno does not know: chat is used.` }
}

/**
 * The view an object's sessions are in, from `<object>/.torno/agent.json` (`{ "agent": "claude", "view":
 * "terminal" }`): `chat` unless the file says `terminal`. A file that is not one, or names another agent than
 * Claude Code (one an older torno ran, Copilot CLI, or one torno does not know), or a view torno does not know, is
 * read as `chat`, with a `note` for the person: their choice is not being followed, and they are told.
 */
export async function readChoice(dir: string): Promise<{ view: AgentView; note?: string }> {
  const raw = await readRaw(dir)
  // The view of a file that names another agent was that agent's: it is not taken for Claude Code's.
  return { view: raw.note === undefined ? (raw.view ?? 'chat') : 'chat', ...(raw.note ? { note: raw.note } : {}) }
}

/** Keeps the view, whole or not at all, with the agent it is of (`"agent": "claude"`). Only main writes this file. */
export async function writeChoice(dir: string, view: AgentView): Promise<void> {
  if (!isView(view)) throw new Error(`no view named ${String(view)}`)
  await writeOwn(dir, FILE, `${JSON.stringify({ agent: AGENT, view }, null, 2)}\n`)
}

/** The file a command names: itself when it is a path, else the first match on PATH. */
export function findCommand(command: string, path = ''): string | null {
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

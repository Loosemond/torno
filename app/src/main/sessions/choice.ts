import { accessSync, constants, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { AGENT_VIEWS } from '../../shared/agents'
import type { AgentId, AgentView } from '../../shared/bridge'
import { FOLDER, writeOwn } from '../own'
import type { AgentAdapter } from './adapter'

const FILE = 'agent.json'
const AGENTS: readonly AgentId[] = ['claude', 'copilot']
/** The agent of an object that has chosen none, or whose choice cannot be read. */
const DEFAULT: AgentId = 'claude'
/** The most that is repeated of a name the file gives that is no agent's. */
const NAMED_LIMIT = 40
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

const isAgent = (value: unknown): value is AgentId => AGENTS.includes(value as AgentId)
const isView = (value: unknown): value is AgentView => value === 'chat' || value === 'terminal'

/** What the file says, as it says it: the agent, and the view it names (kept for the agent that has none). */
interface Raw {
  agent: AgentId
  view?: AgentView
  /** The agent or view the file names that torno does not know, or why it could not be read. */
  note?: string
}

async function readRaw(dir: string): Promise<Raw> {
  let text: string
  try {
    text = await readFile(join(dir, FOLDER, FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { agent: DEFAULT }
    return { agent: DEFAULT, note: UNREADABLE }
  }
  let file: { agent?: unknown; view?: unknown } | null
  try {
    file = JSON.parse(text) as { agent?: unknown; view?: unknown } | null
  } catch {
    return { agent: DEFAULT, note: UNREADABLE }
  }
  const named = file?.agent
  if (!isAgent(named)) {
    if (typeof named !== 'string' || named === '') return { agent: DEFAULT, note: UNREADABLE }
    return { agent: DEFAULT, note: `agent.json names "${short(named)}", which torno does not know: Claude Code is used.` }
  }
  const view = file?.view
  if (view === undefined) return { agent: named }
  if (isView(view)) return { agent: named, view }
  return { agent: named, note: `agent.json names the view "${short(typeof view === 'string' ? view : JSON.stringify(view) ?? '')}", which torno does not know: chat is used.` }
}

const UNREADABLE = 'agent.json could not be read: Claude Code is used.'

function short(named: string): string {
  const plain = named.replace(CONTROL_CHARACTERS, '')
  return plain.length > NAMED_LIMIT ? `${plain.slice(0, NAMED_LIMIT - 1)}…` : plain
}

/**
 * The agent an object's sessions run and the view they are in, from `<object>/.torno/agent.json`
 * (`{ "agent": "claude", "view": "terminal" }`). Claude Code for no file. Also for a file that
 * is not one or names an agent torno does not know, and then with a `note`
 * for the person: their choice is not being followed, and they are told. The view is `chat` unless
 * the file says `terminal` (an unknown one is `chat`, with a `note` too); an agent without a chat
 * (Copilot CLI) is always in its terminal, whatever the file says.
 */
export async function readChoice(dir: string): Promise<{ agent: AgentId; view: AgentView; note?: string }> {
  const raw = await readRaw(dir)
  const view: AgentView = raw.view !== undefined && viewsOf(raw.agent).includes(raw.view) ? raw.view : viewsOf(raw.agent)[0]
  return { agent: raw.agent, view, ...(raw.note ? { note: raw.note } : {}) }
}

/**
 * Keeps the choice, whole or not at all. Only main writes this file. Without a `view` the file's own stays (or
 * `chat` if it has none): choosing an agent that has no chat does not forget the view of the one before it.
 */
export async function writeChoice(dir: string, choice: { agent: AgentId; view?: AgentView }): Promise<void> {
  const { agent } = choice
  if (!isAgent(agent)) throw new Error(`no agent named ${String(agent)}`)
  if (choice.view !== undefined && !isView(choice.view)) throw new Error(`no view named ${String(choice.view)}`)
  const view = choice.view ?? (await readRaw(dir)).view ?? 'chat'
  await writeOwn(dir, FILE, `${JSON.stringify({ agent, view }, null, 2)}\n`)
}

/** The views an agent can be in, the one it starts in first. */
const viewsOf = (agent: AgentId): readonly AgentView[] => AGENT_VIEWS[agent]

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

/**
 * The agents there are to choose from, and of each whether its command is on
 * `path` now. `agentCmd` (TORNO_AGENT_CMD) is run in place of every one, so
 * each is there when its first word is.
 */
export function installedAgents(all: Record<AgentId, AgentAdapter>, path: string | undefined, agentCmd?: string): Array<{ id: AgentId; label: string; installed: boolean; hooks: boolean }> {
  const instead = (agentCmd ?? '').split(' ').filter(Boolean)[0]
  return AGENTS.map((id) => ({ id, label: all[id].label, installed: findCommand(instead ?? all[id].command, path) !== null, hooks: all[id].hooks }))
}

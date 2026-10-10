import { accessSync, constants, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { AgentId } from '../../shared/bridge'
import { writeFileAtomic } from '../atomic'
import type { AgentAdapter } from './adapter'

const FOLDER = '.torno'
const FILE = 'agent.json'
const AGENTS: readonly AgentId[] = ['claude', 'copilot']
/** The agent of an object that has chosen none, or whose choice cannot be read. */
const DEFAULT: AgentId = 'claude'
/** The most that is repeated of a name the file gives that is no agent's. */
const NAMED_LIMIT = 40
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

const isAgent = (value: unknown): value is AgentId => AGENTS.includes(value as AgentId)

/**
 * The agent an object's sessions run, from `<object>/.torno/agent.json`
 * (`{ "agent": "copilot" }`). Claude Code for no file. Also for a file that
 * is not one or names an agent torno does not know, and then with a `note`
 * for the person: their choice is not being followed, and they are told.
 */
export async function readAgentChoice(dir: string): Promise<{ agent: AgentId; note?: string }> {
  let text: string
  try {
    text = await readFile(join(dir, FOLDER, FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { agent: DEFAULT }
    return { agent: DEFAULT, note: 'agent.json could not be read: Claude Code is used.' }
  }
  let named: unknown
  try {
    named = (JSON.parse(text) as { agent?: unknown } | null)?.agent
  } catch {
    return { agent: DEFAULT, note: 'agent.json could not be read: Claude Code is used.' }
  }
  if (isAgent(named)) return { agent: named }
  if (typeof named !== 'string' || named === '') return { agent: DEFAULT, note: 'agent.json could not be read: Claude Code is used.' }
  const plain = named.replace(CONTROL_CHARACTERS, '')
  const said = plain.length > NAMED_LIMIT ? `${plain.slice(0, NAMED_LIMIT - 1)}…` : plain
  return { agent: DEFAULT, note: `agent.json names "${said}", which torno does not know: Claude Code is used.` }
}

/** The agent an object's sessions run: 'claude' for no file, a file that is not one, or an agent that is not known. */
export async function loadAgentChoice(dir: string): Promise<AgentId> {
  return (await readAgentChoice(dir)).agent
}

/** Keeps the choice, whole or not at all. Only main writes this file. */
export async function saveAgentChoice(dir: string, agent: AgentId): Promise<void> {
  if (!isAgent(agent)) throw new Error(`no agent named ${String(agent)}`)
  await writeFileAtomic(join(dir, FOLDER, FILE), `${JSON.stringify({ agent }, null, 2)}\n`)
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

/**
 * The agents there are to choose from, and of each whether its command is on
 * `path` now. `agentCmd` (TORNO_AGENT_CMD) is run in place of every one, so
 * each is there when its first word is.
 */
export function installedAgents(all: Record<AgentId, AgentAdapter>, path: string | undefined, agentCmd?: string): Array<{ id: AgentId; label: string; installed: boolean; hooks: boolean }> {
  const instead = (agentCmd ?? '').split(' ').filter(Boolean)[0]
  return AGENTS.map((id) => ({ id, label: all[id].label, installed: findCommand(instead ?? all[id].command, path) !== null, hooks: all[id].hooks }))
}

import type { AgentId, AgentView } from '../../shared/bridge'
import { claudeAdapter } from './claude'
import { copilotAdapter } from './copilot'

export type { AgentId }

/** What to run for a session: the command, its arguments, and variables to add to its environment. */
export interface AgentLaunch {
  command: string
  /** One string each, as the process gets them: never a line for a shell to split. */
  args: string[]
  env: Record<string, string>
  /** Written under `agentDir` before the start: file name → text. */
  files?: Record<string, string>
}

export interface LaunchContext {
  sessionId: string
  /** The agent's own id of the conversation: started with it, or resumed by it. */
  conversationId: string
  resume: boolean
  /** `chat`: run headless, its conversation as JSON lines on pipes; `terminal`: as the person would run it. */
  view: AgentView
  cwd: string
  /** torno's MCP server, for this object alone. */
  mcpUrl: string
  hookUrl: (event: string) => string
  /** `<cwd>/.torno/agent`: a folder of torno's own that an adapter may point its agent at. */
  agentDir: string
  /** What to add to the agent's system prompt, for an adapter that has a flag for it; '' or absent for nothing. */
  systemPrompt?: string
  /** What the agent inherits of the person's environment: for an adapter that adds to a variable of theirs. */
  env?: Readonly<Record<string, string>>
}

/**
 * How one agent CLI is started so that it knows torno: where torno's MCP
 * server is, where to post its hooks if it posts any, and what it is told of
 * torno. Everything goes on its command line, in its environment or in a
 * folder of torno's own: nothing of the person's configuration of that agent
 * is read or changed. Claude Code is the first (./claude.ts), Copilot CLI the
 * second (./copilot.ts).
 */
export interface AgentAdapter {
  id: AgentId
  /** As the person reads it: "Claude Code", "Copilot CLI". */
  label: string
  /** The command looked for on PATH. */
  command: string
  /** It posts hooks: context goes with every prompt and the status follows its work. Without, it is told through `.torno/prompt.md` and "Send marks". */
  hooks: boolean
  /** It is given torno's skills (Claude Code's `--plugin-dir`): its system prompt leaves to them what they say. */
  skills: boolean
  /** How this agent's client names a tool of torno's to the model: `mcp__torno__scene`. */
  toolName(tool: string): string
  /** The views it can be in, the first its default: only an agent with a headless mode has `chat`. */
  views: readonly AgentView[]
  launch(ctx: LaunchContext): AgentLaunch
}

/**
 * Every agent torno can start. `agentCmd` (TORNO_AGENT_CMD) is run in place of each one's command; `pluginDir`
 * is torno's plugin of skills, for an agent that takes one.
 */
export function adapters(agentCmd?: string, pluginDir?: string): Record<AgentId, AgentAdapter> {
  return { claude: claudeAdapter(agentCmd, pluginDir), copilot: copilotAdapter(agentCmd) }
}

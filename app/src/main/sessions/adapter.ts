import type { AgentView } from '../../shared/bridge'

/** What to run for a session: the command, its arguments, and variables to add to its environment. */
export interface AgentLaunch {
  command: string
  /** One string each, as the process gets them: never a line for a shell to split. */
  args: string[]
  env: Record<string, string>
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
  /** What to add to the agent's system prompt; '' or absent for nothing. */
  systemPrompt?: string
  /** False: leave out the skills the adapter would give (a session started on the full prompt, since they did not load). Absent: as the adapter is. */
  skills?: boolean
}

/**
 * How the agent CLI is started so that it knows torno: where torno's MCP
 * server is, where to post its hooks, and what it is told of torno.
 * Everything goes on its command line or in its environment: nothing of the
 * person's configuration of that agent is read or changed. Claude Code
 * (./claude.ts) is the one there is.
 */
export interface AgentAdapter {
  /** The command looked for on PATH. */
  command: string
  /** It is given torno's skills (Claude Code's `--plugin-dir`): its system prompt leaves to them what they say. */
  skills: boolean
  /** The plugin of skills it passes (when `skills`): the CLI's `init` is read for whether it loaded. */
  plugin?: { name: string; skills: readonly string[] }
  /** The versions of the agent torno was checked against, inclusive (`2.1.300`): one outside is said once. */
  tested?: { min: string; max: string }
  /** How this agent's client names a tool of torno's to the model: `mcp__torno__scene`. */
  toolName(tool: string): string
  launch(ctx: LaunchContext): AgentLaunch
}

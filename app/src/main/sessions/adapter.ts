/** What to run for a session: the command, its arguments, and variables to add to its environment. */
export interface AgentLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * How one agent CLI is started so that it knows torno: where torno's MCP
 * server is, where to post its hooks, and what to append to its system prompt.
 * Claude Code is the first (./claude.ts).
 */
export interface AgentAdapter {
  id: string
  launch(ctx: {
    sessionId: string
    /** The agent's own id of the conversation: started with it, or resumed by it. */
    conversationId: string
    resume: boolean
    cwd: string
    mcpUrl: string
    hookUrl: (event: string) => string
    systemPrompt: string
  }): AgentLaunch
}

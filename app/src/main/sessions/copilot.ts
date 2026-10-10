import { AGENT_LABEL } from '../../shared/agents'
import { NO_HOOKS_PROMPT, systemPrompt } from '../prompt'
import type { AgentAdapter } from './adapter'

const INSTRUCTIONS_DIRS = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS'

/**
 * GitHub Copilot CLI, as `copilot --help` of 1.0.69 describes it. torno's MCP
 * server is named for this session alone (`--additional-mcp-config` adds to
 * the person's own for the session and writes nothing), and its tools alone
 * are allowed without asking. There is no flag for a system prompt: what
 * torno tells the agent is the `AGENTS.md` of a folder of torno's own, which
 * a variable names. It posts no hooks: nothing goes with a prompt and nothing
 * says whether it is at work (`hooks: false`).
 *
 * `agentCmd` replaces the command `copilot`, as for Claude Code.
 */
export function copilotAdapter(agentCmd?: string): AgentAdapter {
  const [command = 'copilot', ...before] = (agentCmd ?? '').split(' ').filter(Boolean)
  // What Copilot shows its model as a tool's name is not in its help: the server and the tool, in words.
  const toolName = (tool: string): string => `the torno tool ${tool}`
  return {
    id: 'copilot',
    label: AGENT_LABEL.copilot,
    command: 'copilot',
    hooks: false,
    toolName,
    launch(ctx) {
      // The variable is a list separated by commas: a path with one would be two folders, neither of them
      // there, and the agent would run knowing nothing of torno. Nothing is started.
      if (ctx.agentDir.includes(',')) throw new Error(`Copilot CLI cannot be given torno's instructions in a folder whose path has a comma: ${ctx.agentDir}`)
      const mcp = { mcpServers: { torno: { type: 'http', url: ctx.mcpUrl, tools: ['*'] } } }
      return {
        command,
        // The same flag starts a conversation under an id and resumes the one of that id.
        args: [...before, '--session-id', ctx.conversationId, '--additional-mcp-config', JSON.stringify(mcp), '--allow-tool=torno', '--no-auto-update'],
        // Beside the folders the person names there themselves, not in their place: the list is separated by commas.
        env: { [INSTRUCTIONS_DIRS]: [ctx.env?.[INSTRUCTIONS_DIRS], ctx.agentDir].filter(Boolean).join(',') },
        files: { 'AGENTS.md': `${systemPrompt(toolName, false)}\n\n${NO_HOOKS_PROMPT}` }
      }
    }
  }
}

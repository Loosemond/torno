import { AGENT_LABEL, AGENT_VIEWS } from '../../shared/agents'
import type { AgentAdapter } from './adapter'
import { HOOK_EVENTS } from './status'

export { HOOK_EVENTS }

const HOOK_TIMEOUT_S = 5
/**
 * What makes Claude Code speak JSON lines on its pipes instead of drawing a terminal: a prompt is a line of
 * stdin, everything it does a line of stdout, and what it would ask the person (a permission, a question) a
 * request on stdout that is answered on stdin.
 */
const HEADLESS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio']

/**
 * Claude Code. Everything torno adds is passed on the command line, so the
 * person's own settings and MCP servers are neither read nor changed
 * (no --strict-mcp-config: their servers keep working beside torno's).
 *
 * `agentCmd` replaces the command `claude`: TORNO_AGENT_CMD, split on spaces,
 * so a path with a space in it cannot be named this way.
 *
 * `pluginDir` is torno's plugin of skills (`resources/agent-plugin`, `agentPluginDir()`), loaded with
 * `--plugin-dir` for that session only: nothing is installed in the person's Claude Code.
 */
export function claudeAdapter(agentCmd?: string, pluginDir?: string): AgentAdapter {
  const [command = 'claude', ...before] = (agentCmd ?? '').split(' ').filter(Boolean)
  return {
    id: 'claude',
    label: AGENT_LABEL.claude,
    command: 'claude',
    hooks: true,
    skills: Boolean(pluginDir),
    views: AGENT_VIEWS.claude,
    toolName: (tool) => `mcp__torno__${tool}`,
    launch(ctx) {
      const hook = (event: string) => [{ hooks: [{ type: 'http', url: ctx.hookUrl(event), timeout: HOOK_TIMEOUT_S }] }]
      const settings = { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, hook(event)])) }
      const mcp = { mcpServers: { torno: { type: 'http', url: ctx.mcpUrl } } }
      const args = [
        ...before,
        ...(ctx.view === 'chat' ? HEADLESS : []),
        ctx.resume ? '--resume' : '--session-id',
        ctx.conversationId,
        '--mcp-config',
        JSON.stringify(mcp),
        '--allowedTools',
        'mcp__torno__*',
        '--settings',
        JSON.stringify(settings)
      ]
      if (pluginDir) args.push('--plugin-dir', pluginDir)
      if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt)
      return { command, args, env: {} }
    }
  }
}

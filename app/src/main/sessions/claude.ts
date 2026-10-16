import { AGENT_LABEL, AGENT_VIEWS } from '../../shared/agents'
import type { AgentAdapter } from './adapter'
import { HOOK_EVENTS } from './status'

export { HOOK_EVENTS }

const HOOK_TIMEOUT_S = 5
/**
 * The `PostToolUse` of an edit of the model is answered once the build the save started has ended (`Sessions.afterEdit`,
 * which answers by 55 s that a build is running): builds of seconds are usual. Every other tool's is answered at once,
 * so the one hook of the event has this longer limit (a second entry matched to the edit tools would post them twice).
 */
const EDIT_HOOK_TIMEOUT_S = 60
/**
 * What makes Claude Code speak JSON lines on its pipes instead of drawing a terminal: a prompt is a line of
 * stdin, everything it does a line of stdout, and what it would ask the person (a permission, a question) a
 * request on stdout that is answered on stdin.
 */
const HEADLESS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio']

/** The tools of torno's the reviewer may call: those that read the part. Not `show`, `resolve_mark`, `add_mark`. */
const REVIEWER_TOOLS = ['scene', 'look', 'marks', 'measure', 'check', 'section', 'describe']

/**
 * `torno-reviewer`, a subagent passed with `--agents` (nothing is written to `.claude/agents/`): a second look at a
 * change with a fresh context and only the tools that read, so it can change nothing.
 */
export function reviewerAgents(toolName: (tool: string) => string) {
  return {
    'torno-reviewer': {
      description: 'Reviews the current build of the torno object against what the user asked, read-only. Use it after a change of several steps, before saying it is done.',
      prompt: [
        'You review a CAD part in torno and change nothing. You are given what the user asked for.',
        `Check the current build against it: ${toolName('scene')} for the build status (a failed build is the first finding), ${toolName('look')} at the views that show the change, every open mark with ${toolName('marks')} (was each acted on as its note asks?), and every dimension (does it pass on the latest build?).`,
        `Every number you state comes from ${toolName('measure')}, ${toolName('check')} or ${toolName('section')}, never from the mesh, a picture or the model's source; say so when a value is approximate.`,
        'Report, in short lines, what holds and what does not, each with its numbers and refs, and what you could not check.',
        'Change nothing: do not edit files, do not resolve or add marks, do not change what the user sees.'
      ].join(' '),
      tools: [...REVIEWER_TOOLS.map(toolName), 'Read']
    }
  }
}

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
const toolName = (tool: string): string => `mcp__torno__${tool}`

export function claudeAdapter(agentCmd?: string, pluginDir?: string): AgentAdapter {
  const [command = 'claude', ...before] = (agentCmd ?? '').split(' ').filter(Boolean)
  return {
    id: 'claude',
    label: AGENT_LABEL.claude,
    command: 'claude',
    hooks: true,
    skills: Boolean(pluginDir),
    views: AGENT_VIEWS.claude,
    toolName,
    launch(ctx) {
      const hook = (event: string) => [{ hooks: [{ type: 'http', url: ctx.hookUrl(event), timeout: event === 'PostToolUse' ? EDIT_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S }] }]
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
      args.push('--agents', JSON.stringify(reviewerAgents(toolName)))
      if (pluginDir) args.push('--plugin-dir', pluginDir)
      if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt)
      return { command, args, env: {} }
    }
  }
}

import { describe, expect, it } from 'vitest'
import { claudeAdapter, HOOK_EVENTS } from './claude'

const ctx = {
  sessionId: 's1',
  conversationId: '0b1e5a52-6d0c-4f6e-9a55-2f4a3c1d9e10',
  resume: false,
  cwd: '/ws/bracket',
  mcpUrl: 'http://127.0.0.1:4100/mcp/bracket',
  hookUrl: (event: string) => `http://127.0.0.1:4100/hooks/s1/${event}`,
  agentDir: '/ws/bracket/.torno/agent',
  systemPrompt: 'You are in torno.'
}

/** The value that follows a flag in an argument list. */
function after(args: string[], flag: string): string {
  const at = args.indexOf(flag)
  expect(at, flag).toBeGreaterThanOrEqual(0)
  return args[at + 1]
}

describe('the Claude Code adapter', () => {
  it('launches a new conversation by its id', () => {
    const launch = claudeAdapter().launch(ctx)
    expect(launch.command).toBe('claude')
    expect(after(launch.args, '--session-id')).toBe(ctx.conversationId)
    expect(launch.args).not.toContain('--resume')
    expect(after(launch.args, '--allowedTools')).toBe('mcp__torno__*')
    expect(after(launch.args, '--append-system-prompt')).toBe('You are in torno.')
    expect(launch.args).not.toContain('--strict-mcp-config')
  })

  it('resumes a conversation by its id', () => {
    const launch = claudeAdapter().launch({ ...ctx, resume: true })
    expect(after(launch.args, '--resume')).toBe(ctx.conversationId)
    expect(launch.args).not.toContain('--session-id')
    expect(launch.args).not.toContain('--strict-mcp-config')
  })

  it("names torno's MCP server by its URL", () => {
    const config = JSON.parse(after(claudeAdapter().launch(ctx).args, '--mcp-config'))
    expect(config).toEqual({ mcpServers: { torno: { type: 'http', url: ctx.mcpUrl } } })
  })

  it('registers an http hook for each event it follows, and no other', () => {
    const settings = JSON.parse(after(claudeAdapter().launch(ctx).args, '--settings'))
    expect(HOOK_EVENTS).toEqual(['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'SessionEnd'])
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks)).toEqual(HOOK_EVENTS)
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'http', url: `http://127.0.0.1:4100/hooks/s1/${event}`, timeout: 5 }] }
      ])
    }
  })

  it('leaves the system prompt out when there is none', () => {
    expect(claudeAdapter().launch({ ...ctx, systemPrompt: '' }).args).not.toContain('--append-system-prompt')
  })

  it('runs another command when one is named, split on spaces, with the same arguments', () => {
    const usual = claudeAdapter().launch(ctx)
    const launch = claudeAdapter('node  /abs/fake-agent.mjs ').launch(ctx)
    expect(launch.command).toBe('node')
    expect(launch.args).toEqual(['/abs/fake-agent.mjs', ...usual.args])
    expect(claudeAdapter('   ').launch(ctx).command).toBe('claude')
  })

  it('passes its arguments as a list, each one string, to the letter as before there was another agent', () => {
    const spaced = { ...ctx, cwd: '/ws/my parts/lid 2', mcpUrl: 'http://127.0.0.1:4100/mcp/lid%202', agentDir: '/ws/my parts/lid 2/.torno/agent', systemPrompt: 'You are in torno. Mind the "quotes" and $HOME.' }
    const launch = claudeAdapter().launch(spaced)
    expect(launch.args).toEqual([
      '--session-id',
      ctx.conversationId,
      '--mcp-config',
      '{"mcpServers":{"torno":{"type":"http","url":"http://127.0.0.1:4100/mcp/lid%202"}}}',
      '--allowedTools',
      'mcp__torno__*',
      '--settings',
      JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'http', url: `http://127.0.0.1:4100/hooks/s1/${event}`, timeout: 5 }] }]])) }),
      '--append-system-prompt',
      'You are in torno. Mind the "quotes" and $HOME.'
    ])
    // It adds nothing to the environment and is given no file: everything is on its command line.
    expect(launch.env).toEqual({})
    expect(launch.files).toBeUndefined()
  })

  it('says of itself that it posts hooks, and how it names a tool', () => {
    const adapter = claudeAdapter('node /abs/fake-agent.mjs')
    expect([adapter.id, adapter.label, adapter.command, adapter.hooks, adapter.toolName('scene')]).toEqual(['claude', 'Claude Code', 'claude', true, 'mcp__torno__scene'])
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAdapter, HOOK_EVENTS, reviewerAgents } from './claude'

const ctx = {
  sessionId: 's1',
  conversationId: '0b1e5a52-6d0c-4f6e-9a55-2f4a3c1d9e10',
  resume: false,
  view: 'terminal' as const,
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
      // Added since (#6): the reviewer subagent.
      '--agents',
      JSON.stringify(reviewerAgents((tool) => `mcp__torno__${tool}`)),
      '--append-system-prompt',
      'You are in torno. Mind the "quotes" and $HOME.'
    ])
    // It adds nothing to the environment and is given no file: everything is on its command line.
    expect(launch.env).toEqual({})
    expect(launch.files).toBeUndefined()
  })

  it('is the terminal one plus the flags of the headless mode in chat, `-p` first after what the command brings', () => {
    const terminal = claudeAdapter().launch(ctx).args
    const chat = claudeAdapter().launch({ ...ctx, view: 'chat' }).args
    const flags = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio']
    expect(chat).toEqual([...flags, ...terminal])
    expect(chat.indexOf('-p')).toBe(0)
    // The same with a command that brings arguments of its own: they stay in front.
    const fake = claudeAdapter('node /abs/fake-agent.mjs').launch({ ...ctx, view: 'chat' }).args
    expect(fake.slice(0, 3)).toEqual(['/abs/fake-agent.mjs', '-p', '--input-format'])
    // Resumed, it is the same conversation by the same flag.
    expect(after(claudeAdapter().launch({ ...ctx, view: 'chat', resume: true }).args, '--resume')).toBe(ctx.conversationId)
  })

  it('says which views it can be in', () => {
    expect(claudeAdapter().views).toEqual(['chat', 'terminal'])
  })

  it('says of itself that it posts hooks, and how it names a tool', () => {
    const adapter = claudeAdapter('node /abs/fake-agent.mjs')
    expect([adapter.id, adapter.label, adapter.command, adapter.hooks, adapter.toolName('scene')]).toEqual(['claude', 'Claude Code', 'claude', true, 'mcp__torno__scene'])
  })

  // #4: torno's skills, a plugin that ships with the app, loaded for this session only.
  it("loads torno's plugin of skills by its folder, for this session only, when it is given one", () => {
    const launch = claudeAdapter(undefined, '/opt/torno/resources/agent-plugin').launch(ctx)
    expect(after(launch.args, '--plugin-dir')).toBe('/opt/torno/resources/agent-plugin')
    expect(claudeAdapter(undefined, '/opt/torno/resources/agent-plugin').skills).toBe(true)
    // In chat too: the same arguments after the headless ones.
    expect(after(claudeAdapter(undefined, '/p').launch({ ...ctx, view: 'chat' }).args, '--plugin-dir')).toBe('/p')
    expect(claudeAdapter().launch(ctx).args).not.toContain('--plugin-dir')
    expect(claudeAdapter().skills).toBe(false)
  })

  // #6: a second look with a fresh context and only the tools that read.
  it('defines the read-only torno-reviewer subagent with --agents, whose tools read and change nothing', () => {
    for (const view of ['terminal', 'chat'] as const) {
      const agents = JSON.parse(after(claudeAdapter().launch({ ...ctx, view }).args, '--agents'))
      expect(Object.keys(agents)).toEqual(['torno-reviewer'])
      const reviewer = agents['torno-reviewer']
      expect(Object.keys(reviewer).sort()).toEqual(['description', 'prompt', 'tools'])
      expect(reviewer.tools).toEqual(['mcp__torno__scene', 'mcp__torno__look', 'mcp__torno__marks', 'mcp__torno__measure', 'mcp__torno__check', 'mcp__torno__section', 'mcp__torno__describe', 'Read'])
      for (const never of ['Edit', 'Write', 'Bash', 'mcp__torno__resolve_mark', 'mcp__torno__show', 'mcp__torno__add_mark']) expect(reviewer.tools).not.toContain(never)
      expect(reviewer.description).toMatch(/after a change of several steps/i)
      for (const said of ['what the user asked', 'every open mark', 'every dimension', 'mcp__torno__measure', 'never from the mesh', 'Change nothing']) expect(reviewer.prompt).toContain(said)
    }
  })

  it('is given the plugin that is in the app: a manifest and the four skills, each named in its frontmatter', () => {
    const dir = join(__dirname, '../../../resources/agent-plugin')
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('torno')
    for (const name of ['torno-model', 'build123d', 'scans', 'dimensions']) {
      const text = readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8')
      const front = text.match(/^---\n([\s\S]*?)\n---\n/)![1]
      expect(front).toMatch(new RegExp(`^name: ${name}$`, 'm'))
      expect(front).toMatch(/^description: .{40,}$/m)
    }
  })
})

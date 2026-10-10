import { describe, expect, it } from 'vitest'
import { NO_HOOKS_PROMPT, SYSTEM_PROMPT, systemPrompt } from '../prompt'
import { adapters } from './adapter'
import { copilotAdapter } from './copilot'

const ctx = { sessionId: 's1', conversationId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2', resume: false, cwd: '/ws/hollow', mcpUrl: 'http://127.0.0.1:4100/mcp/hollow', hookUrl: (event: string) => `http://127.0.0.1:4100/hooks/s1/${event}`, agentDir: '/ws/hollow/.torno/agent' }

describe('copilotAdapter', () => {
  it('starts Copilot CLI with torno\'s server for this session only, allowed, and its instructions in a folder of torno\'s', () => {
    const launch = copilotAdapter().launch(ctx)
    expect(launch.command).toBe('copilot')
    expect(launch.args).toEqual([
      '--session-id', '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
      '--additional-mcp-config', '{"mcpServers":{"torno":{"type":"http","url":"http://127.0.0.1:4100/mcp/hollow","tools":["*"]}}}',
      '--allow-tool=torno',
      '--no-auto-update'
    ])
    expect(launch.env).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/ws/hollow/.torno/agent' })
    expect(Object.keys(launch.files!)).toEqual(['AGENTS.md'])
    expect(launch.files!['AGENTS.md']).toContain('the torno tool scene')
    expect(launch.files!['AGENTS.md']).not.toContain('mcp__torno__')
    expect(launch.files!['AGENTS.md'].endsWith(NO_HOOKS_PROMPT)).toBe(true)
    // No hook is passed: it has none to pass.
    expect(launch.args.join(' ')).not.toContain('/hooks/')
  })

  it('resumes with the same flag, and runs the command it is given in its place', () => {
    expect(copilotAdapter().launch({ ...ctx, resume: true }).args.slice(0, 2)).toEqual(['--session-id', ctx.conversationId])
    const fake = copilotAdapter('node /repo/app/test/fake-agent.mjs').launch(ctx)
    expect([fake.command, fake.args[0], fake.args[1]]).toEqual(['node', '/repo/app/test/fake-agent.mjs', '--session-id'])
  })

  it('passes every argument as one string of a list: a folder with spaces in its name is one variable, and the address one JSON', () => {
    const spaced = { ...ctx, cwd: '/ws/my parts/lid 2', mcpUrl: 'http://127.0.0.1:4100/mcp/lid%202', agentDir: '/ws/my parts/lid 2/.torno/agent' }
    const launch = copilotAdapter().launch(spaced)
    expect(launch.args).toHaveLength(6)
    for (const arg of launch.args) expect(typeof arg).toBe('string')
    expect(JSON.parse(launch.args[3])).toEqual({ mcpServers: { torno: { type: 'http', url: 'http://127.0.0.1:4100/mcp/lid%202', tools: ['*'] } } })
    expect(launch.env).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/ws/my parts/lid 2/.torno/agent' })
    // Nothing of the person's is named: no token, no file of their home.
    expect(Object.keys(launch.env)).toEqual(['COPILOT_CUSTOM_INSTRUCTIONS_DIRS'])
    expect(launch.args.join(' ')).not.toMatch(/~|\.copilot|\.config/)
  })

  it('adds its folder to those the person names for instructions, and takes none away', () => {
    const launch = copilotAdapter().launch({ ...ctx, env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/home/me/rules,/home/me/more', GH_TOKEN: 'theirs' } })
    expect(launch.env).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/home/me/rules,/home/me/more,/ws/hollow/.torno/agent' })
  })

  it('refuses a folder whose path has a comma, which the list of folders for instructions would split', () => {
    const comma = { ...ctx, cwd: '/home/me/parts, v2/lid', agentDir: '/home/me/parts, v2/lid/.torno/agent' }
    expect(() => copilotAdapter().launch(comma)).toThrow("Copilot CLI cannot be given torno's instructions in a folder whose path has a comma: /home/me/parts, v2/lid/.torno/agent")
  })

  it('never tells an agent without hooks that anything arrives with its prompts', () => {
    const told = copilotAdapter().launch(ctx).files!['AGENTS.md']
    expect(told).not.toMatch(/arrive with the prompt|with every prompt|with each prompt/)
    expect(told).toContain('New marks are in .torno/prompt.md when the user sends a line that begins with "torno:", a line each;')
    expect(told).toContain('are listed under "Dimensions (measured on rN):" in .torno/prompt.md whenever it is written, until they pass')
    // Claude Code is told as before.
    expect(SYSTEM_PROMPT).toContain('New marks arrive with the prompt, a line each;')
    expect(SYSTEM_PROMPT).toContain('with every prompt until they pass')
    expect(systemPrompt((tool) => `mcp__torno__${tool}`, true)).toBe(SYSTEM_PROMPT)
  })

  it('says of itself what the window needs to know', () => {
    const all = adapters()
    expect(Object.keys(all)).toEqual(['claude', 'copilot'])
    expect([all.claude.label, all.claude.hooks, all.claude.command]).toEqual(['Claude Code', true, 'claude'])
    expect([all.copilot.label, all.copilot.hooks, all.copilot.command]).toEqual(['Copilot CLI', false, 'copilot'])
  })
})

it('names the tools as each client does, and is the same text for Claude Code as before', () => {
  expect(systemPrompt((tool) => `mcp__torno__${tool}`)).toBe(SYSTEM_PROMPT)
  expect(SYSTEM_PROMPT).toContain('mcp__torno__scene reports the build status')
  expect(systemPrompt((tool) => `the torno tool ${tool}`)).toContain('the torno tool scene reports the build status')
  expect(NO_HOOKS_PROMPT).toContain('.torno/prompt.md')
  // Nothing is pushed to such an agent: it is told to read the state file itself, each time.
  expect(NO_HOOKS_PROMPT).toContain('At the start of each task read .torno/state.md')
})

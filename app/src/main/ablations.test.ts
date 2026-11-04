import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ABLATIONS, ablations } from './ablations'
import { claudeAdapter } from './sessions/claude'
import { agentEnv } from './sessions/agentEnv'

// What an eval run may take away from the agent: nothing at all unless both TORNO_TEST=1 and TORNO_EVAL=1 are set.

const all = ABLATIONS.join(',')

describe('the ablations of an eval run', () => {
  it('are inert without both TORNO_TEST=1 and TORNO_EVAL=1', () => {
    for (const env of [{}, { TORNO_EVAL_ABLATE: all }, { TORNO_TEST: '1', TORNO_EVAL_ABLATE: all }, { TORNO_EVAL: '1', TORNO_EVAL_ABLATE: all }, { TORNO_TEST: '1', TORNO_EVAL: 'yes', TORNO_EVAL_ABLATE: all }, { TORNO_TEST: 'true', TORNO_EVAL: '1', TORNO_EVAL_ABLATE: 'nonsense' }]) {
      expect(ablations(env).size).toBe(0)
    }
  })

  it('take what is named under both, and refuse a name that is none', () => {
    expect([...ablations({ TORNO_TEST: '1', TORNO_EVAL: '1', TORNO_EVAL_ABLATE: ' skills, look ' })]).toEqual(['skills', 'look'])
    expect([...ablations({ TORNO_TEST: '1', TORNO_EVAL: '1', TORNO_EVAL_ABLATE: all })]).toEqual([...ABLATIONS])
    expect(ablations({ TORNO_TEST: '1', TORNO_EVAL: '1' }).size).toBe(0)
    expect(() => ablations({ TORNO_TEST: '1', TORNO_EVAL: '1', TORNO_EVAL_ABLATE: 'skils' })).toThrow(/no ablation skils/)
  })

  it('reach the agent only through what main does: the reviewer left out, the variables never passed on', () => {
    const ctx = { sessionId: 's1', conversationId: '0b1e5a52-6d0c-4f6e-9a55-2f4a3c1d9e10', resume: false, view: 'terminal' as const, cwd: '/ws/b', mcpUrl: 'http://127.0.0.1:1/mcp/b', hookUrl: (e: string) => `http://127.0.0.1:1/hooks/s1/${e}`, token: 't'.repeat(43), configDir: '/tmp/agent', systemPrompt: 'p' }
    expect(claudeAdapter(undefined, '/plugin').launch(ctx).args).toContain('--agents')
    expect(claudeAdapter(undefined, '/plugin', { reviewer: false }).launch(ctx).args).not.toContain('--agents')
    const env = agentEnv({ PATH: '/bin', TORNO_EVAL: '1', TORNO_EVAL_ABLATE: 'look' })
    expect(env.TORNO_EVAL).toBeUndefined()
    expect(env.TORNO_EVAL_ABLATE).toBeUndefined()
  })

  it('are wired in main from ablations() alone, each to its own switch', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(index).toMatch(/const off = ablations\(\)/)
    expect(index).not.toMatch(/TORNO_EVAL_ABLATE/)
    for (const name of ABLATIONS) expect(index).toContain(`off.has('${name}')`)
  })
})

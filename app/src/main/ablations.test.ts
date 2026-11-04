import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ABLATIONS, ablations, evalTuning } from './ablations'
import { clampSize } from './mcp/tools'
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

  it('give a look size and a count of holds only under both, in range or refused', () => {
    const tuned = { TORNO_EVAL_LOOK_SIZE: '768', TORNO_EVAL_HOLDS: '1' }
    for (const env of [tuned, { ...tuned, TORNO_TEST: '1' }, { ...tuned, TORNO_EVAL: '1' }]) expect(evalTuning(env)).toEqual({})
    const both = { TORNO_TEST: '1', TORNO_EVAL: '1' }
    expect(evalTuning(both)).toEqual({})
    expect(evalTuning({ ...both, ...tuned })).toEqual({ lookSize: 768, holds: 1 })
    expect(evalTuning({ ...both, TORNO_EVAL_HOLDS: '2' })).toEqual({ holds: 2 })
    for (const size of ['2001', '255', '800.5', 'big']) expect(() => evalTuning({ ...both, TORNO_EVAL_LOOK_SIZE: size })).toThrow(/TORNO_EVAL_LOOK_SIZE/)
    for (const holds of ['0', '3', 'x']) expect(() => evalTuning({ ...both, TORNO_EVAL_HOLDS: holds })).toThrow(/TORNO_EVAL_HOLDS/)
  })

  it('set what a look is drawn at when it names no size, and nothing else', () => {
    expect(clampSize(undefined)).toBe(1280)
    expect(clampSize(undefined, 768)).toBe(768)
    expect(clampSize(1000, 768)).toBe(1000)
    expect(clampSize(5000, 768)).toBe(2000)
  })

  it('are wired in main from evalTuning() alone', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(index).toMatch(/const tuning = evalTuning\(\)/)
    expect(index).toMatch(/lookSize: tuning\.lookSize/)
    expect(index).toMatch(/mostHolds: tuning\.holds/)
    expect(index).not.toMatch(/TORNO_EVAL_(LOOK_SIZE|HOLDS)/)
    const manager = readFileSync(join(__dirname, 'sessions/manager.ts'), 'utf8')
    expect(manager).toMatch(/turn\.holds >= \(this\.deps\.mostHolds \?\? MOST_HOLDS\)/)
  })
})

import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain module of the evals, outside the typed sources
import * as run from '../evals/run.mjs'

// The pure parts of the evals' runner (`app/evals/run.mjs`): nothing here starts an agent, a window or a kernel.

describe('the runner of the evals, without running anything', () => {
  it('answers a question from the case by the first topic it names, or the default', () => {
    const answers = { leg: 'Both legs 120 mm.', hole: '4.5 mm.', default: 'choose' }
    expect(run.answerFor('How long should each LEG be?', answers)).toBe('Both legs 120 mm.')
    expect(run.answerFor('What colour?', answers)).toBe('choose')
    expect(run.answerFor('What colour?', {})).toMatch(/choose, and say what you chose/)
  })

  it('judges a tool check by its number within tol, or a range, and keeps what the tool said of exactness', () => {
    expect(run.judge({ path: 'value', expect: 52, tol: 0.1 }, { value: 52.05, exact: true })).toEqual({ pass: true, value: 52.05, expect: 52, exact: true })
    expect(run.judge({ path: 'value', expect: 52, tol: 0.01 }, { value: 52.05, exact: false }).pass).toBe(false)
    expect(run.judge({ path: 'a.b', min: 1, max: 2 }, { a: { b: 1.5 } }).pass).toBe(true)
    expect(run.judge({ path: 'value', expect: 1 }, { value: 'x' }).pass).toBe(false)
  })

  it('every case is whole: an object, prompts, and checks of known kinds; the smoke case only by name', () => {
    const kinds = ['valid', 'parts', 'solids', 'size', 'ratio', 'volume', 'clearance', 'overlap', 'hole', 'mcp']
    const cases = run.loadCases([])
    expect(cases.length).toBeGreaterThanOrEqual(12)
    expect(cases.map((c: { id: string }) => c.id)).not.toContain('_smoke')
    for (const c of [...cases, ...run.loadCases(['_smoke'])]) {
      expect(c.object, c.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(c.prompts.length, c.id).toBeGreaterThan(0)
      expect(c.checks.length, c.id).toBeGreaterThan(1)
      for (const k of c.checks) expect(kinds, `${c.id} ${k.id}`).toContain(k.kind)
    }
  })

  it('puts the check pass rate first, the build apart, then cost and time', () => {
    const runs = [
      { case: 'a', passed: 3, total: 4, buildOk: true, costUsd: 0.5, wallMs: 60_000, saidDoneWhileFailing: true },
      { case: 'a', passed: 4, total: 4, buildOk: true, costUsd: 1.5, wallMs: 120_000 }
    ]
    expect(run.summarize(runs)).toEqual([{ case: 'a', runs: 2, checks: '88 %', allPassed: '50 %', build: '100 %', doneWhileFailing: 1, cost: '$1.00', minutes: '1.5', errors: 0 }])
    expect(run.markdown('t', runs)).toMatch(/\| a \| 2 \| 88 % \| 50 % \| 100 % \| 1 \| \$1\.00 \| 1\.5 \| 0 \|/)
  })
})

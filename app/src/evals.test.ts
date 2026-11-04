import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain module of the evals, outside the typed sources
import { PHRASE, confirmed, guard, refusal } from '../evals/guard.mjs'

// The evals (`app/evals`) run the real Claude Code and spend the person's subscription: they refuse without
// TORNO_EVAL=1, under CI, and without the phrase typed. And no suite ever picks them up.

const yes = async () => PHRASE
const info = { agent: 'claude', model: 'sonnet', budgetUsd: 2, cases: ['t1-box'], repeats: 5 }

describe('the safeguard of the evals', () => {
  it('refuses without TORNO_EVAL=1', () => {
    expect(refusal({})).toMatch(/TORNO_EVAL=1/)
    expect(refusal({ TORNO_EVAL: '0' })).toMatch(/TORNO_EVAL=1/)
    expect(refusal({ TORNO_EVAL: 'yes' })).toMatch(/TORNO_EVAL=1/)
    expect(refusal({ TORNO_EVAL: '1' })).toBeNull()
  })

  it('refuses under CI, even with TORNO_EVAL=1', () => {
    for (const CI of ['true', '1', 'TRUE', 'yes']) expect(refusal({ TORNO_EVAL: '1', CI })).toMatch(/CI/)
    for (const CI of ['', '0', 'false']) expect(refusal({ TORNO_EVAL: '1', CI })).toBeNull()
  })

  it('takes only the phrase typed exactly', () => {
    expect(confirmed(PHRASE)).toBe(true)
    expect(confirmed(`  ${PHRASE}\n`)).toBe(true)
    for (const typed of ['', 'y', 'yes', PHRASE.toUpperCase(), null, undefined]) expect(confirmed(typed)).toBe(false)
  })

  it('says the model, the budget and the cost before it asks, and never asks when it refuses', async () => {
    const said: string[] = []
    let asked = 0
    const ask = async () => ((asked += 1), PHRASE)
    expect(await guard({ TORNO_EVAL: '1', CI: 'true' }, info, ask, (l: string) => said.push(l))).toMatch(/CI/)
    expect(await guard({}, info, ask, (l: string) => said.push(l))).toMatch(/TORNO_EVAL/)
    expect(asked).toBe(0)
    expect(said).toEqual([])
    expect(await guard({ TORNO_EVAL: '1' }, info, yes, (l: string) => said.push(l))).toBeNull()
    expect(said.join('\n')).toMatch(/Model: sonnet/)
    expect(said.join('\n')).toMatch(/\$2 a run at most, \$10\.00 in all/)
    expect(await guard({ TORNO_EVAL: '1' }, info, async () => null, () => {})).toMatch(/Not confirmed/)
  })

  it('is outside every suite: vitest takes src/ only and Playwright e2e/ only', () => {
    const app = resolve(__dirname, '..')
    expect(readFileSync(resolve(app, 'vitest.config.ts'), 'utf8')).toMatch(/exclude: \[[^\]]*'evals\/\*\*'/)
    expect(readFileSync(resolve(app, 'playwright.config.ts'), 'utf8')).toMatch(/testIgnore: \[[^\]]*'\*\*\/evals\/\*\*'/)
  })

  it('checks the safeguard first, before it builds or starts anything', () => {
    const run = readFileSync(resolve(__dirname, '../evals/run.mjs'), 'utf8')
    const main = run.slice(run.indexOf('async function main'))
    expect(main.indexOf('guard(')).toBeGreaterThan(0)
    for (const later of ['electron.launch', 'spawnSync(', 'mkdtempSync(']) {
      const at = main.indexOf(later)
      if (at >= 0) expect(at).toBeGreaterThan(main.indexOf('guard('))
    }
  })
})

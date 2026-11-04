// What an eval run may take away from the agent, to measure what each part of torno is worth (`app/evals`, issue
// #121). Read from `TORNO_EVAL_ABLATE` (a comma list) only when both `TORNO_TEST=1` and `TORNO_EVAL=1` are set: in any
// other run, the person's, a test's or a packaged app's, it is empty and nothing is taken away.
//
// - `skills`: no `--plugin-dir`: the session runs on the whole system prompt (`FULL_PROMPT`), as when they did not load.
// - `reviewer`: no `--agents`: the `torno-reviewer` subagent is not offered.
// - `stop`: a `Stop` is never held back.
// - `look`: the `look` tool answers that it is off, and gives no picture.
// - `digest`: the answer to an edit leaves out the digest of what its build did (`buildContextFor`); `state.md` keeps it.
//
// And two settings, read under the same rule (`evalTuning`):
// - `TORNO_EVAL_LOOK_SIZE`: the long edge a `look` is drawn at when the agent names none, in place of 1280
//   (`MIN_SIZE` to `MAX_SIZE`, 256 to 2000).
// - `TORNO_EVAL_HOLDS`: how many times a turn's `Stop` may be held back, 1 or 2 (2 is torno's own; none is `stop`).

import { MAX_SIZE, MIN_SIZE } from './mcp/schemas'

export const ABLATIONS = ['skills', 'reviewer', 'stop', 'look', 'digest'] as const
export type Ablation = (typeof ABLATIONS)[number]

/** What is taken away in this run. Names that are none of `ABLATIONS` are an error: a typo would measure nothing. */
export function ablations(env: NodeJS.ProcessEnv = process.env): ReadonlySet<Ablation> {
  if (env.TORNO_TEST !== '1' || env.TORNO_EVAL !== '1') return new Set()
  const named = (env.TORNO_EVAL_ABLATE ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = named.filter((n) => !(ABLATIONS as readonly string[]).includes(n))
  if (unknown.length > 0) throw new Error(`TORNO_EVAL_ABLATE: no ablation ${unknown.join(', ')} (there are ${ABLATIONS.join(', ')})`)
  return new Set(named as Ablation[])
}

/** The settings an eval run gives (none in any other run). A value out of range is an error, never clamped. */
export function evalTuning(env: NodeJS.ProcessEnv = process.env): { lookSize?: number; holds?: number } {
  if (env.TORNO_TEST !== '1' || env.TORNO_EVAL !== '1') return {}
  const tuning: { lookSize?: number; holds?: number } = {}
  const size = env.TORNO_EVAL_LOOK_SIZE
  if (size) {
    const n = Number(size)
    if (!Number.isInteger(n) || n < MIN_SIZE || n > MAX_SIZE) throw new Error(`TORNO_EVAL_LOOK_SIZE: ${size} is not a whole number of pixels from ${MIN_SIZE} to ${MAX_SIZE}`)
    tuning.lookSize = n
  }
  const holds = env.TORNO_EVAL_HOLDS
  if (holds) {
    if (holds !== '1' && holds !== '2') throw new Error(`TORNO_EVAL_HOLDS: ${holds} is not 1 or 2 (no holds at all is TORNO_EVAL_ABLATE=stop)`)
    tuning.holds = Number(holds)
  }
  return tuning
}

/** What the `look` tool answers when it is taken away. */
export const LOOK_OFF = 'look is turned off in this eval run: judge the part by numbers (scene, measure, check, diff).'

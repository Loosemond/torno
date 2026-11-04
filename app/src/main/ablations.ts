// What an eval run may take away from the agent, to measure what each part of torno is worth (`app/evals`, issue
// #121). Read from `TORNO_EVAL_ABLATE` (a comma list) only when both `TORNO_TEST=1` and `TORNO_EVAL=1` are set: in any
// other run, the person's, a test's or a packaged app's, it is empty and nothing is taken away.
//
// - `skills`: no `--plugin-dir`: the session runs on the whole system prompt (`FULL_PROMPT`), as when they did not load.
// - `reviewer`: no `--agents`: the `torno-reviewer` subagent is not offered.
// - `stop`: a `Stop` is never held back.
// - `look`: the `look` tool answers that it is off, and gives no picture.

export const ABLATIONS = ['skills', 'reviewer', 'stop', 'look'] as const
export type Ablation = (typeof ABLATIONS)[number]

/** What is taken away in this run. Names that are none of `ABLATIONS` are an error: a typo would measure nothing. */
export function ablations(env: NodeJS.ProcessEnv = process.env): ReadonlySet<Ablation> {
  if (env.TORNO_TEST !== '1' || env.TORNO_EVAL !== '1') return new Set()
  const named = (env.TORNO_EVAL_ABLATE ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = named.filter((n) => !(ABLATIONS as readonly string[]).includes(n))
  if (unknown.length > 0) throw new Error(`TORNO_EVAL_ABLATE: no ablation ${unknown.join(', ')} (there are ${ABLATIONS.join(', ')})`)
  return new Set(named as Ablation[])
}

/** What the `look` tool answers when it is taken away. */
export const LOOK_OFF = 'look is turned off in this eval run: judge the part by numbers (scene, measure, check, diff).'

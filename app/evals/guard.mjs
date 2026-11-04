// What stands between `pnpm eval` and the person's subscription. A run of the evals starts the real Claude Code, which
// spends the person's own plan, so nothing runs unless the person asked for it in three ways: TORNO_EVAL=1 in the
// environment, no CI, and the phrase typed at the prompt once the cost has been said. Held by `src/evals.test.ts`.

/** What must be typed, exactly, before a run starts. */
export const PHRASE = 'spend my subscription'

/** Whether CI is set to anything that means yes: GitHub sets `CI=true`, others `CI=1`. */
const underCi = (env) => env.CI !== undefined && !['', '0', 'false'].includes(String(env.CI).toLowerCase())

/** Why a run must not start, or null when it may: refused under CI first, then without TORNO_EVAL=1. */
export function refusal(env) {
  if (underCi(env)) return 'The evals never run under CI: a run spends the subscription of whoever is logged in.'
  if (env.TORNO_EVAL !== '1') return 'The evals run the real Claude Code and spend your subscription. Set TORNO_EVAL=1 to run them.'
  return null
}

/** The lines said before the question: what will run and what it may cost. */
export function plan({ agent, model, budgetUsd, cases, repeats }) {
  const runs = cases.length * repeats
  return [
    `Agent: ${agent}`,
    `Model: ${model}`,
    `Cases: ${cases.join(', ')} (${repeats} each, ${runs} runs)`,
    `Budget: $${budgetUsd} a run at most, $${(budgetUsd * runs).toFixed(2)} in all at most, from your own subscription.`
  ]
}

/** Whether what the person typed is the phrase. Anything else, an empty line or the end of input is a no. */
export const confirmed = (typed) => typeof typed === 'string' && typed.trim() === PHRASE

/**
 * The whole safeguard: refuse, or say the plan and ask. `ask` puts the question and resolves with the line typed (or
 * null at the end of input). Resolves with null when the run may start, or with the reason it may not.
 */
export async function guard(env, info, ask, say = console.log) {
  const no = refusal(env)
  if (no) return no
  for (const line of plan(info)) say(line)
  const typed = await ask(`Type "${PHRASE}" to start: `)
  return confirmed(typed) ? null : 'Not confirmed: nothing was run.'
}

import { ASK_PROGRESS_MS } from '../../shared/ask'
import type { WaitBuildArgs } from './schemas'
import { type ToolDeps, type ToolExtra, type ToolResult, failure } from './tools'

// `wait_build`: the tool that waits for the build of the project, so that an agent never sleeps or polls for one. It
// answers with what an edit is told of its build (`buildAnswer`: `buildContextFor` of `context.ts`). Like `ask`, it
// tells its client every ASK_PROGRESS_MS that it is alive, since Claude Code ends an MCP call quiet for 5 minutes.

/** The seconds it waits when not told, and the most it waits: under `ask`'s 10 minutes, and a build's own limit. */
export const WAIT_DEFAULT_S = 300
export const WAIT_MOST_S = 600
/** How long it waits for a build to begin, with neither one running nor `after`: the watcher waits 300 ms for a save to settle, as an edit's answer does. */
const WAIT_GRACE_MS = 3000

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`
const said = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })

export async function waitBuildTool(deps: ToolDeps, objectId: string, args: WaitBuildArgs, extra: ToolExtra = {}): Promise<ToolResult> {
  const waits = deps.buildWaits
  if (!waits || !deps.buildAnswer) return failure('wait_build is not available here: call scene for the build status')
  if (!deps.object(objectId)) return failure(`no project ${objectId} in this workspace`)
  if (args.after !== undefined && (!Number.isInteger(args.after) || args.after < 0)) return failure('after is a revision: a whole number, 0 or more (scene gives the last one)')
  if (args.timeout !== undefined && !(typeof args.timeout === 'number' && args.timeout >= 1 && args.timeout <= WAIT_MOST_S)) return failure(`timeout is seconds, 1 to ${WAIT_MOST_S}`)
  const timing = deps.waitTiming ?? { progressMs: ASK_PROGRESS_MS, graceMs: WAIT_GRACE_MS }
  const called = Date.now()
  const until = called + (args.timeout ?? WAIT_DEFAULT_S) * 1000
  const after = args.after

  const first = deps.build(objectId)
  if (!first) return failure(`${objectId} is not open in the torno window: nothing builds it`)
  // The build waited for has been seen running (or is the one running now); one that ends after that is the answer.
  let seen = first.status === 'building'
  // With after, a build that already ended after that revision is the answer at once: a failure has the last good
  // revision as its own, so one that failed after rN is answered when it is no older than rN.
  const endedAfter = (s: typeof first): boolean => after !== undefined && ((s.status === 'ok' && s.revision > after) || (s.status === 'failed' && s.revision >= after))

  let beats = 0
  const beat = setInterval(() => {
    beats += 1
    void extra.progress?.(beats, 'waiting for the build').catch(() => undefined)
  }, timing.progressMs)
  try {
    for (;;) {
      const now = Date.now()
      const state = deps.build(objectId)
      if (!state) return failure(`${objectId} was closed in the torno window while this waited`)
      if (state.status === 'building') seen = true
      else if ((state.status === 'ok' || state.status === 'failed') && (seen || endedAfter(state) || (waits.endedAt(objectId) ?? 0) > called)) {
        const told = await deps.buildAnswer(objectId, Math.min(until, now + 10_000))
        return said(told.text || `The build is ${state.status === 'ok' ? `r${state.revision}, ok` : 'failed'}.`)
      }
      if (extra.signal?.aborted) return failure('the wait was given up')
      if (!seen && after === undefined && now - called >= timing.graceMs) {
        const told = await deps.buildAnswer(objectId, now)
        return said(`No build is running, and none began within ${seconds(timing.graceMs)}: a save of the project's sources starts one. The last build, as an edit is told of it:\n${told.text}`)
      }
      if (now >= until) {
        const times = waits.lastTimes(objectId)
        const took = times.length > 0 ? `; the last builds took ${times.map((s) => `${Math.round(s)} s`).join(', ')}` : ''
        const began = waits.beganAt(objectId)
        const running = seen && state.status === 'building'
        const where = running ? `still running (r${state.revision + 1}, for ${began !== undefined ? seconds(now - began) : 'a while'}${took})` : `not begun after ${seconds(now - called)}`
        return said(`The build is ${where}. Call wait_build again with after: ${after ?? state.revision} to keep waiting.`)
      }
      await waits.next(seen || after !== undefined ? until : Math.min(until, called + timing.graceMs), extra.signal)
    }
  } finally {
    clearInterval(beat)
  }
}

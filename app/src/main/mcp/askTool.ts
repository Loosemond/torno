import { ASK_LIMIT_MS, ASK_PROGRESS_MS, MAX_ASK_LABEL, MAX_ASK_OPTIONS, MAX_ASK_QUESTION, MAX_ASK_REFS, type AskOption } from '../../shared/ask'
import { checkRef, checkedRefs } from './markTools'
import type { AskArgs } from './schemas'
import { type ToolDeps, type ToolExtra, type ToolResult, failure, layoutFor, onScreen, tidy } from './tools'

// `ask`: the tool that waits for the person. The question is shown by the window (main/asks.ts keeps it open);
// what comes back is what they chose, as data. It ends by itself at ASK_LIMIT_MS, and meanwhile tells its client
// every ASK_PROGRESS_MS that it is alive, since Claude Code ends an MCP call that has been quiet for 5 minutes.

/** A time as it is told: "10 minutes", "90 s". */
const spent = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)

const answered = (value: object): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(tidy({ answered: true, ...value })) }] })
const notAnswered = (why: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ answered: false, reason: `not answered: ${why}` }) }] })

export async function askTool(deps: ToolDeps, objectId: string, args: AskArgs, extra: ToolExtra = {}): Promise<ToolResult> {
  const found = onScreen(deps, objectId)
  if ('content' in found) return found
  const layout = layoutFor(deps, objectId, found.scene, args.layout)
  if (typeof layout !== 'string') return layout

  const question = typeof args.question === 'string' ? args.question.trim() : ''
  if (question === '') return failure('nothing was asked: give the question')
  if (question.length > MAX_ASK_QUESTION) return failure(`nothing was asked: the question is ${question.length} characters, at most ${MAX_ASK_QUESTION}`)
  if (!Array.isArray(args.options)) return failure('nothing was asked: options is a list of {label, refs}')
  if (args.options.length > MAX_ASK_OPTIONS) return failure(`nothing was asked: ${args.options.length} options, at most ${MAX_ASK_OPTIONS}`)
  const pick = args.pick === true
  if (args.options.length === 0 && !pick) return failure('nothing was asked: give at least one option, or pick: true')

  const options: AskOption[] = []
  for (const [n, option] of args.options.entries()) {
    const label = typeof option?.label === 'string' ? option.label.trim() : ''
    if (label === '') return failure(`nothing was asked: option ${n + 1} has no label`)
    if (label.length > MAX_ASK_LABEL) return failure(`nothing was asked: the label of option ${n + 1} is ${label.length} characters, at most ${MAX_ASK_LABEL}`)
    const given = option.refs ?? []
    if (!Array.isArray(given) || given.length > MAX_ASK_REFS) return failure(`nothing was asked: option ${n + 1} names ${Array.isArray(given) ? given.length : 'no list of'} refs, at most ${MAX_ASK_REFS}`)
    const refs = await checkedRefs(deps, objectId, found, layout, given, 'asked')
    if (!Array.isArray(refs)) return refs
    options.push({ label, refs })
  }
  if (!deps.ask) return failure('questions are not available here')
  if (deps.asking?.(objectId)) return failure('a question is already waiting for the user to answer: wait for it to end before asking another')

  // The time is up, or the client gave the call up (the turn was stopped): the question ends either way.
  const ending = new AbortController()
  let late = false
  const limit = deps.askLimits?.limitMs ?? ASK_LIMIT_MS
  const timer = setTimeout(() => {
    late = true
    ending.abort()
  }, limit)
  let count = 0
  const every = setInterval(() => {
    count += 1
    void extra.progress?.(count, 'waiting for the user to answer').catch(() => undefined)
  }, deps.askLimits?.progressMs ?? ASK_PROGRESS_MS)
  const given = (): void => ending.abort()
  extra.signal?.addEventListener('abort', given, { once: true })
  if (extra.signal?.aborted) ending.abort()

  let result
  try {
    result = await deps.ask(objectId, { question, options, pick, layout, revision: found.revision }, ending.signal)
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
    clearInterval(every)
    extra.signal?.removeEventListener('abort', given)
  }

  if (result.kind === 'ended') {
    if (late) return notAnswered(`the user did not answer within ${spent(limit)}`)
    return notAnswered(result.why === 'aborted' ? 'the turn was stopped' : 'the torno window was closed or the session ended')
  }
  if (result.kind === 'declined') return notAnswered('the user chose none of the options')

  const now = deps.scene(objectId)?.revision
  const newer = now !== undefined && now !== found.revision ? { note: `The model was built again while the question waited (r${found.revision} to r${now}): describe the refs again before relying on them.` } : {}
  if (result.kind === 'option') {
    const chosen = options[result.index]
    return answered({ kind: 'option', index: result.index, label: chosen.label, refs: chosen.refs, layout, revision: found.revision, ...newer })
  }
  // A pick is a face or an edge of the build the person has on screen: it is looked up in the last one.
  const scene = deps.scene(objectId)?.scene
  const checked = scene ? checkRef(scene, layout, result.ref) : 'no build'
  if (typeof checked === 'string') return answered({ kind: 'pick', ref: result.ref, layout, note: `The user picked ${result.ref}, but the last build has no such ref (${checked}).` })
  return answered({ kind: 'pick', ref: result.ref, layout, revision: now ?? found.revision, ...newer })
}

import { landing, landingText } from './diff'
import { partDefects } from './sanity'
import type { Scene } from './scene'

/**
 * The history of an object's builds (`main/history.ts`, #56): what is kept of each build that landed, under
 * `<object>/.torno/history/`, and what the window and the tools say of it. A build there has its own id, `h41`,
 * which counts on across runs of torno; a revision (`r3`) counts from 1 in every run and is told beside it.
 */

/** The history ids of an object: `h` and a whole number from 1, never given again. */
export const HISTORY_ID = /^h[1-9][0-9]{0,8}$/

/** How many builds are kept besides the ones the person stars. */
export const HISTORY_KEPT = 100

/** The dimensions the person has marked, counted by what they said of this build when it was last checked. */
export interface HistoryDimensions {
  pass: number
  fail: number
  none: number
}

/** One kept build, as `index.json` of the history holds it. */
export interface HistoryEntry {
  id: string
  /** When the build landed, ISO 8601. */
  at: string
  /** The run of torno it was made in; the revision is of that run alone. */
  run: string
  revision: number
  /** The hash of the sources it was made from (`sourcesHash`). */
  sources: string
  head?: string
  dirty?: true
  /** The model file, from the project's folder. */
  model: string
  /** The copies of the sources held, from the workspace, with `/`; none when they were too large or changed while they were read. */
  files: string[]
  starred?: true
  /** Whether a picture of it is on file. */
  thumb?: true
  parts: number
  seconds: number
  /** The model's `Params` and their defaults in that build. */
  params?: Record<string, unknown>
  /** The checks the model declares that did not pass in that build: kept all the same, and marked. */
  failing?: string[]
  /** Parts with a defect the shape says (`not valid`, `inside out`...), as `tub: not valid`. */
  defects?: string[]
  /** What the person's dimensions said of it, as of the check that followed it. */
  dimensions?: HistoryDimensions
  /** What changed since the entry before, as the status line says it. */
  line: string
}

/** Said of a build kept with no build before it. */
export const FIRST_BUILD = 'first build kept'

/** What a build changed, against the scene of the build kept before it, in one line (`tub changed, lid same`). */
export function changeLine(before: Scene | undefined, now: Scene): string {
  if (!before) return FIRST_BUILD
  const said = now.layouts.map((layout) => ({ layout, text: landingText(landing(before, now, layout)) })).filter(({ text }) => text !== 'no part changed')
  const gone = before.layouts.filter((layout) => !now.layouts.includes(layout))
  if (said.length === 0 && gone.length === 0) return 'no part changed'
  const lines = said.map(({ layout, text }) => (now.layouts.length > 1 ? `${layout}: ${text}` : text))
  return [...lines, ...gone.map((layout) => `${layout} gone`)].join('; ')
}

/** The entry's facts that come from the scene alone. */
export function sceneFacts(scene: Scene): Pick<HistoryEntry, 'parts' | 'seconds' | 'params' | 'failing' | 'defects'> {
  const params = Object.fromEntries((scene.params ?? []).map((p) => [p.name, p.default]))
  const failing = (scene.checks ?? []).filter((c) => c.status === 'fail' || c.status === 'error').map((c) => c.name)
  const defects = scene.parts.flatMap((p) => partDefects(p).map((d) => `${p.name}: ${d}`))
  return {
    parts: scene.parts.length,
    seconds: scene.seconds,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(failing.length > 0 ? { failing } : {}),
    ...(defects.length > 0 ? { defects } : {})
  }
}

import { number } from '../../shared/format'
import type { Part, Scene } from '../../shared/scene'
import type { PromptContext } from '../context'
import { unknownKeys } from './keys'
import type { EndArg } from './markTools'
import { type MeasureToolArgs, measureTool } from './readTools'
import { type ToolDeps, type ToolResult, failure, layoutFor, messageOf } from './tools'

// `expect`: the agent says what its next edit should change, and main holds the next successful build against it.
// It is the agent's own note for one edit: held in memory, never written to a file, never a mark, and told once in the
// answer to the edit. A guess that missed is no failed build, so nothing here holds a Stop back.

type Vec3 = [number, number, number]

/** What a number should be: a value, or a change from the build the expectation was made on; within a tolerance. */
export interface Target {
  value?: number
  change?: number
  tolerance?: number
}
export interface SizeTarget {
  value?: Vec3
  change?: Vec3
  tolerance?: number
}
export type Check =
  | { part: string; volume?: Target; faces?: Target; edges?: Target; size?: SizeTarget; layout?: string }
  | { measure: { kind: MeasureToolArgs['kind']; a: EndArg; b?: EndArg; density?: number }; expected: number; tolerance?: number; layout?: string }
  | { unchanged: string[]; layout?: string }
export interface ExpectArgs {
  checks: Check[]
  note?: string
}

/** What was settled of one expectation: how many checks were met and which were not, in a line each. */
export interface Verdict {
  /** The build it was checked on. */
  revision: number
  note?: string
  met: number
  missed: string[]
  /** The line the answer to the edit carries. */
  line: string
}

/** The numbers of a part, as the build the expectation was made on had them. */
interface Before {
  volume: number
  volumeExact: boolean
  volumeDoubt: number
  size: Vec3
  sizeExact: boolean
  sizeDoubt: number
  faces: number
  edges: number
  hash: string
}
interface Pending {
  args: ExpectArgs
  revision: number
  layout: string
  before: Map<string, Before>
}

const MOST_CHECKS = 20
const MOST_PARTS = 40
/** The tolerances when none is given: exact numbers are held close. */
const VOLUME_TOLERANCE = 0.5
const SIZE_TOLERANCE = 0.05
const MEASURE_TOLERANCE = 0.05

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const signed = (n: number): string => (n < 0 ? '−' : '+') + number(Math.abs(n))
const kept = (part: Part): Before => ({
  volume: part.volume,
  volumeExact: part.volumeExact === true,
  volumeDoubt: part.volumeDoubt ?? 0,
  size: part.bbox.max.map((m, i) => m - part.bbox.min[i]) as Vec3,
  sizeExact: part.bboxExact === true,
  sizeDoubt: part.bboxDoubt ?? 0,
  faces: part.faceCount,
  edges: part.edgeCount,
  hash: part.hash
})

/** What the agent must be told of a check that is malformed, or null. */
function malformed(check: unknown, parts: ReadonlySet<string>): string | null {
  if (!isObject(check)) return 'a check is an object: {"part": "plate", "volume": {"change": -1200, "tolerance": 50}}, {"measure": {"kind": "diameter", "a": "plate/F9"}, "expected": 6.4} or {"unchanged": ["lid"]}'
  const named = (name: unknown): string | null => (typeof name === 'string' && parts.has(name) ? null : `no part '${String(name)}'; parts: ${[...parts].join(', ') || 'none'}`)
  const target = (key: string, what: unknown, size: boolean): string | null => {
    const wrong = unknownKeys(what, ['value', 'change', 'tolerance'], key)
    if (wrong !== null) return wrong
    const t = what as Record<string, unknown>
    if ((t.value === undefined) === (t.change === undefined)) return `${key} takes either value or change, one of them`
    const given = t.value ?? t.change
    if (size ? !vec(given) : !finite(given)) return `${key}: ${t.value === undefined ? 'change' : 'value'} is ${size ? 'three numbers [x, y, z] in mm' : 'a number'}`
    if (t.tolerance !== undefined && !(finite(t.tolerance) && t.tolerance >= 0)) return `${key}: tolerance is zero or more`
    return null
  }
  if ('unchanged' in check) {
    const wrong = unknownKeys(check, ['unchanged', 'layout'], 'a check of unchanged')
    if (wrong !== null) return wrong
    if (!Array.isArray(check.unchanged) || check.unchanged.length === 0 || check.unchanged.length > MOST_PARTS) return `unchanged is a list of 1 to ${MOST_PARTS} part names`
    for (const name of check.unchanged) {
      const no = named(name)
      if (no !== null) return no
    }
    return null
  }
  if ('measure' in check) {
    const wrong = unknownKeys(check, ['measure', 'expected', 'tolerance', 'layout'], 'a check of a measurement')
    if (wrong !== null) return wrong
    const m = check.measure
    if (!isObject(m) || typeof m.kind !== 'string' || m.a === undefined) return 'measure is what the measure tool takes: {"kind": "diameter", "a": "plate/F9"}'
    const keys = unknownKeys(m, ['kind', 'a', 'b', 'density'], 'measure')
    if (keys !== null) return keys
    if (!finite(check.expected)) return 'a check of a measurement has expected: the number it should measure, in mm, degrees, mm², mm³ or grams'
    if (check.tolerance !== undefined && !(finite(check.tolerance) && check.tolerance >= 0)) return 'tolerance is zero or more'
    return null
  }
  const wrong = unknownKeys(check, ['part', 'volume', 'faces', 'edges', 'size', 'layout'], 'a check of a part')
  if (wrong !== null) return wrong
  const no = named(check.part)
  if (no !== null) return no
  const keys = ['volume', 'faces', 'edges', 'size'].filter((k) => check[k] !== undefined)
  if (keys.length === 0) return `a check of ${String(check.part)} says what should change: volume, faces, edges or size`
  for (const key of keys) {
    const bad = target(key, check[key], key === 'size')
    if (bad !== null) return bad
  }
  return null
}

/** The expectations of the agents, one at a time per project, for the next successful build. */
export class Expectations {
  private pending = new Map<string, Pending>()
  private verdicts = new Map<string, Verdict>()

  /** Keeps (replacing the one before) what the agent expects of the next build, taken against the last one. */
  hold(objectId: string, revision: number, scene: Scene, layout: string, args: ExpectArgs): void {
    const before = new Map(scene.parts.filter((p) => p.layout === layout).map((p) => [p.name, kept(p)] as const))
    this.pending.set(objectId, { args, revision, layout, before })
  }

  /** What was last settled for a project, told by `scene`. */
  last(objectId: string): Verdict | undefined {
    return this.verdicts.get(objectId)
  }

  /**
   * Settles the expectation of a project against the last successful build, once, if that build is newer than the one
   * it was made on: the line to tell, or undefined when there is nothing pending or no new build yet.
   */
  async settle(deps: ToolDeps, objectId: string): Promise<string | undefined> {
    const held = this.pending.get(objectId)
    const last = deps.scene(objectId)
    if (!held || !last || last.revision <= held.revision) return undefined
    this.pending.delete(objectId)
    const verdict = await judge(deps, objectId, held, last.revision, last.scene)
    this.verdicts.set(objectId, verdict)
    return verdict.line
  }
}

/** The ref an end of a measurement names, if it names one. */
function refOf(end: EndArg | undefined): string | undefined {
  if (typeof end === 'string') return end
  const ref = (end as { ref?: unknown } | undefined)?.ref
  return typeof ref === 'string' ? ref : undefined
}

const FEATURE = /^(.+)\/([FE])(\d+)$/

/**
 * Whether a ref of a face or an edge may name something else now: when its part's face (or edge) count changed the
 * numbers shift. Said in words when it is not confirmed; undefined when it holds, or is no such ref.
 */
function moved(ref: string | undefined, before: Map<string, Before>, parts: ReadonlyMap<string, Part>): string | undefined {
  const m = ref === undefined ? null : FEATURE.exec(ref)
  if (!m) return undefined
  const [, name, kind] = m
  const was = before.get(name)
  const now = parts.get(name)
  if (!was || !now) return undefined
  const [a, b] = kind === 'F' ? [was.faces, now.faceCount] : [was.edges, now.edgeCount]
  const words = kind === 'F' ? 'face' : 'edge'
  return a === b ? undefined : `${ref} moved: it may name another ${words} now (${name} had ${a} ${words}s, has ${b}), so it was not measured`
}

/** Within a tolerance, widened by how much the kernel says its numbers are in doubt. */
const within = (got: number, wanted: number, tolerance: number, doubt: number): boolean => Math.abs(got - wanted) <= tolerance + doubt + 1e-9

async function judge(deps: ToolDeps, objectId: string, held: Pending, revision: number, scene: Scene): Promise<Verdict> {
  const parts = new Map(scene.parts.filter((p) => p.layout === held.layout).map((p) => [p.name, p] as const))
  const met: string[] = []
  const missed: string[] = []
  const report = (ok: boolean, text: string): void => void (ok ? met : missed).push(text)
  if (!scene.layouts.includes(held.layout)) {
    missed.push(`layout ${held.layout} is not in the build`)
    return verdictOf(revision, held.args.note, met, missed)
  }
  for (const check of held.args.checks) {
    if ('unchanged' in check) {
      for (const name of check.unchanged) {
        const was = held.before.get(name)
        const now = parts.get(name)
        if (!was || !now) {
          report(false, `${name} ${now ? 'was not there before' : 'is gone'}`)
          continue
        }
        const n = kept(now)
        if (n.hash === was.hash) {
          report(true, `${name} unchanged`)
          continue
        }
        const doubt = was.volumeDoubt + n.volumeDoubt
        const same = within(n.volume, was.volume, VOLUME_TOLERANCE, doubt) && n.faces === was.faces && n.edges === was.edges && n.size.every((s, i) => within(s, was.size[i], SIZE_TOLERANCE, was.sizeDoubt + n.sizeDoubt))
        const exact = was.volumeExact && n.volumeExact
        report(same, same ? `${name} unchanged` : `${name} changed: volume ${exact ? '' : '≈ '}${signed(n.volume - was.volume)} mm³, faces ${was.faces} to ${n.faces}`)
      }
    } else if ('measure' in check) {
      const ends = [refOf(check.measure.a), refOf(check.measure.b)] as Array<string | undefined>
      const gone = ends.map((ref) => moved(ref, held.before, parts)).find((text) => text !== undefined)
      const tolerance = check.tolerance ?? MEASURE_TOLERANCE
      const what = `${check.measure.kind} of ${ends.filter(Boolean).join(' to ') || 'the part'}`
      if (gone) {
        report(false, `${what}: ${gone}`)
        continue
      }
      const asked = await measureTool(deps, objectId, { ...check.measure, layout: check.layout ?? held.layout })
      const text = asked.content[0]?.type === 'text' ? asked.content[0].text : ''
      if (asked.isError) {
        report(false, `${what} could not be measured: ${text}`)
        continue
      }
      let measured: { value?: number; exact?: boolean }
      try {
        measured = JSON.parse(text)
      } catch {
        report(false, `${what} could not be read`)
        continue
      }
      if (!finite(measured.value)) {
        report(false, `${what} is not a single number`)
        continue
      }
      const ok = within(measured.value, check.expected, tolerance, 0)
      const about = measured.exact === true ? '' : '≈ '
      report(ok, `${what} ${about}${number(measured.value)}${ok ? '' : `, expected ${number(check.expected)} ± ${number(tolerance)}`}`)
    } else {
      const was = held.before.get(check.part)
      const now = parts.get(check.part)
      if (!now) {
        report(false, `${check.part} is gone`)
        continue
      }
      if (!was) {
        report(false, `${check.part} was not in the build the expectation was made on`)
        continue
      }
      const n = kept(now)
      if (check.volume) {
        const t = check.volume
        const got = t.change !== undefined ? n.volume - was.volume : n.volume
        const wanted = t.change ?? t.value!
        const tolerance = t.tolerance ?? VOLUME_TOLERANCE
        const exact = was.volumeExact && n.volumeExact
        const ok = within(got, wanted, tolerance, t.change !== undefined ? was.volumeDoubt + n.volumeDoubt : n.volumeDoubt)
        const shown = t.change !== undefined ? signed(got) : number(got)
        report(ok, `${check.part} volume ${exact ? '' : '≈ '}${shown} mm³${ok ? '' : `, expected ${t.change !== undefined ? signed(wanted) : number(wanted)} ± ${number(tolerance)}`}`)
      }
      for (const [key, got, before] of [['faces', n.faces, was.faces], ['edges', n.edges, was.edges]] as const) {
        const t = check[key]
        if (!t) continue
        const seen = t.change !== undefined ? got - before : got
        const wanted = t.change ?? t.value!
        const ok = within(seen, wanted, t.tolerance ?? 0, 0)
        const say = (v: number): string => (t.change !== undefined ? signed(v) : String(v))
        report(ok, `${check.part} ${key} ${say(seen)}${ok ? '' : `, expected ${say(wanted)}`}`)
      }
      if (check.size) {
        const t = check.size
        const tolerance = t.tolerance ?? SIZE_TOLERANCE
        const exact = was.sizeExact && n.sizeExact
        const got = n.size.map((s, i) => (t.change ? s - was.size[i] : s))
        const wanted = (t.change ?? t.value!) as Vec3
        const ok = got.every((g, i) => within(g, wanted[i], tolerance, t.change ? was.sizeDoubt + n.sizeDoubt : n.sizeDoubt))
        const list = (v: number[]): string => v.map((x) => (t.change ? signed(x) : number(x))).join(', ')
        report(ok, `${check.part} size ${exact ? '' : '≈ '}${list(got)} mm${ok ? '' : `, expected ${list(wanted)} ± ${number(tolerance)}`}`)
      }
    }
  }
  return verdictOf(revision, held.args.note, met, missed)
}

function verdictOf(revision: number, note: string | undefined, held: string[], missed: string[]): Verdict {
  const total = held.length + missed.length
  const result = missed.length === 0 ? `all ${total} met` : `${held.length} met, ${missed.length} not: ${missed.join('; ')}`
  const line = `expected (r${revision})${note ? ` "${note}"` : ''}: ${result}. Told once; call expect again before the next edit.`
  return { revision, ...(note ? { note } : {}), met: held.length, missed, line }
}

/** The tool: keeps what the next successful build is held against. */
export function expectTool(deps: ToolDeps, objectId: string, args: ExpectArgs): ToolResult {
  const store = deps.expectations
  if (!store) return failure('expect is not available')
  if (!isObject(args) || !Array.isArray(args.checks) || args.checks.length === 0 || args.checks.length > MOST_CHECKS) return failure(`expect takes checks: a list of 1 to ${MOST_CHECKS} (a part's volume, faces, edges or size; a measurement with expected; or unchanged parts), and an optional note`)
  if (args.note !== undefined && typeof args.note !== 'string') return failure('note is text')
  const last = deps.scene(objectId)
  if (!last) return failure('no build yet: there is nothing to hold an edit against')
  const asked = args.checks.find((c) => isObject(c) && typeof c.layout === 'string')
  const layout = layoutFor(deps, objectId, last.scene, asked && isObject(asked) ? (asked.layout as string) : undefined)
  if (typeof layout !== 'string') return layout
  const names = new Set(last.scene.parts.filter((p) => p.layout === layout).map((p) => p.name))
  for (const check of args.checks) {
    const wrong = malformed(check, names)
    if (wrong !== null) return failure(wrong)
  }
  try {
    store.hold(objectId, last.revision, last.scene, layout, { checks: args.checks, ...(args.note ? { note: args.note } : {}) })
  } catch (e) {
    return failure(messageOf(e))
  }
  return { content: [{ type: 'text', text: JSON.stringify({ held: args.checks.length, against: `r${last.revision}`, layout, note: 'Held for the next successful build only, and told once in the answer to your edit. It changes nothing and is no mark.' }) }] }
}

/**
 * The context of an edit's build with the verdict of what the agent expected of it as its last line, told once: the
 * expectation is settled by the first successful build newer than the one it was made on. Nothing is added to an
 * answer with no text, and a verdict that cannot be worked out is left unsaid.
 */
export async function withExpectation(store: Expectations, deps: ToolDeps, objectId: string, told: PromptContext): Promise<PromptContext> {
  const line = told.text ? await store.settle(deps, objectId).catch(() => undefined) : undefined
  return line ? { ...told, text: `${told.text}\n${line}` } : told
}

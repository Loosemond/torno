import { number } from '../marks/describe'
import { clean } from '../sanity'
import { movedForDisplay } from '../marks/spread'
import { checkRef } from './markTools'
import { ofOneBuild, refusal } from './readTools'
import { type ToolDeps, type ToolResult, failure, layoutFor, ofBuild } from './tools'

// The `features` tool: what a part is made of, as a person names it (holes, bosses), found by the kernel on the
// B-rep of the last build that worked (`features.py`). Every number is the kernel's and says whether it is exact;
// the reading is worded from the data, nothing is worked out here.

type Vec3 = [number, number, number]

export const FEATURE_KINDS = ['hole', 'boss', 'fillet', 'chamfer'] as const
type FeatureKind = (typeof FEATURE_KINDS)[number]

export interface FeaturesToolArgs {
  part?: unknown
  kinds?: unknown
  layout?: string
}

interface Step {
  from: number
  to: number
  type: 'cylinder' | 'cone' | 'round'
  diameter?: number
  diameters?: [number, number]
  angle?: number
  radius?: number
  tip?: boolean
}

interface FeatureBase {
  diameter: number
  axis: Vec3
  steps: Step[]
  faces: string[]
  exact: boolean
  how?: string
}

export interface Hole extends FeatureBase {
  entry: Vec3
  entryRef?: string
  exitRef?: string
  end: 'through' | 'blind' | 'enclosed' | 'unknown'
  depth: number
  bottom?: 'flat' | 'cone' | 'round' | 'other'
  shape: 'plain' | 'counterbore' | 'countersink' | 'rounded' | 'stepped' | 'tapered'
  counterbore?: { diameter: number; depth: number }
  countersink?: { diameter: number; angle: number; depth: number }
  rounded?: { radius: number }
  crosses?: string[]
}

export interface Boss extends FeatureBase {
  base: Vec3
  baseRef: string
  top: Vec3
  topRef?: string
  height: number
}

export interface Fillet {
  radius: number
  side: 'outside' | 'inside'
  sweep: number
  length: number
  between: string[]
  edges: string[]
  edgeCount: number
  faces: string[]
  exact: boolean
}

export interface Chamfer {
  side: 'outside' | 'inside'
  size?: number
  sizes?: [number, number]
  length: number
  round: boolean
  between: string[]
  edges: string[]
  edgeCount: number
  faces: string[]
  exact: boolean
}

export interface Featured {
  part: string
  kinds: FeatureKind[]
  holes?: Hole[]
  holeCount?: number
  bosses?: Boss[]
  bossCount?: number
  fillets?: Fillet[]
  filletCount?: number
  chamfers?: Chamfer[]
  chamferCount?: number
  left: Record<string, number>
  notFeatures: { arcs: number; freeCylinders: number; freeformFaces: number }
  exact: boolean
  how: string
  complete: boolean
}

const NEEDS_PART = 'features needs part, the name of a part as scene lists it: {"part": "lid"}'
const NEEDS_KINDS = `kinds is a list of ${FEATURE_KINDS.join(', ')}: {"part": "lid", "kinds": ["hole"]}`

/**
 * The holes and bosses of one part of the last build that worked. The part is checked against the scene before
 * the kernel is asked; what the kernel finds is told as it is, with a `reading` in a line.
 */
export async function featuresTool(deps: ToolDeps, objectId: string, args: FeaturesToolArgs): Promise<ToolResult> {
  if (typeof args.part !== 'string' || args.part === '') return failure(NEEDS_PART)
  const kinds = args.kinds
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => (FEATURE_KINDS as readonly unknown[]).includes(k)))) return failure(NEEDS_KINDS)
  const asked = await ofOneBuild(deps, objectId, async (found) => {
    const layout = layoutFor(deps, objectId, found.scene, args.layout)
    if (typeof layout !== 'string') return layout
    const named = checkRef(found.scene, layout, args.part as string)
    if (typeof named === 'string') return failure(named)
    if (named.target !== 'part') return failure(`part is a part, not ${named.target === 'face' ? 'a face' : 'an edge'}: give ${named.part.name}`)
    try {
      const featured = await deps.query<Featured>(objectId, 'features', { layout, part: named.part.name, ...(kinds === undefined ? {} : { kinds }) })
      return { got: { layout, part: named.part, featured } }
    } catch (e) {
      return refusal(e, layout, 'query')
    }
  })
  if ('content' in asked) return asked
  const { layout, part, featured } = asked.got
  const reading = featuresReading(featured)
  if (reading === null) return failure('the kernel did not answer with features')
  const points = [...(featured.holes ?? []).map((h) => h.entry), ...(featured.bosses ?? []).map((b) => b.base)]
  const reply = { layout, ...ofBuild(deps, objectId), ...clean(featured), ...movedForDisplay(part, layout, { points }), reading }
  return { content: [{ type: 'text', text: JSON.stringify(reply) }] }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const AXES = ['X', 'Y', 'Z']

/** The way an axis points, as a word when it lies along an axis of the layout: `Z`, `−X`; else its three components. */
export function alongText(axis: readonly number[]): string {
  const i = axis.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6)
  if (i >= 0) return `${axis[i] < 0 ? '−' : ''}${AXES[i]}`
  return `(${axis.map((c) => number(c)).join(', ')})`
}

/** The axis of a feature said without its sign, for features that are the same whichever way they are turned. */
const lineText = (axis: readonly number[]): string => {
  const i = axis.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6)
  return i >= 0 ? AXES[i] : alongText(axis)
}

const dia = (d: number): string => `⌀${number(d)}`

function holeWords(h: Hole): string {
  const rough = h.exact ? '' : '≈ '
  const end = h.end === 'through' ? 'through' : h.end === 'blind' ? `blind, ${rough}${number(h.depth)} deep${h.bottom === 'cone' ? ' to a drill point' : h.bottom === 'round' ? ' with a round bottom' : ''}` : h.end === 'enclosed' ? `enclosed, ${number(h.depth)} long` : 'one end not known'
  const bore = h.counterbore ? `, counterbore ${dia(h.counterbore.diameter)} × ${number(h.counterbore.depth)}` : ''
  const sink = h.countersink ? `, countersink ${dia(h.countersink.diameter)} at ${number(h.countersink.angle)}°` : ''
  const round = h.rounded ? `, mouth rounded r${number(h.rounded.radius)}` : ''
  const stepped = h.shape === 'stepped' ? ', wider further in' : h.shape === 'tapered' ? ', tapered' : ''
  const through = h.end === 'through' ? `, ${rough}${number(h.depth)} long` : ''
  return `${dia(h.diameter)} ${end}${through}${bore}${sink}${round}${stepped}`
}

/** The holes and bosses of a part, in a line each kind; null for a reply that is none. */
export function featuresReading(f: Featured): string | null {
  if (!Array.isArray(f.kinds) || typeof f.part !== 'string') return null
  const said: string[] = []
  const of = f.part
  if (f.kinds.includes('hole')) {
    if (!Array.isArray(f.holes) || !finite(f.holeCount)) return null
    if (f.holes.length === 0) said.push(`no holes in ${of}`)
    else {
      const groups = new Map<string, Hole[]>()
      for (const h of f.holes) {
        const key = JSON.stringify([holeWords(h), h.end === 'through' ? lineText(h.axis) : alongText(h.axis), h.shape])
        groups.set(key, [...(groups.get(key) ?? []), h])
      }
      const parts = [...groups.values()].map((hs) => `${hs.length} × ${holeWords(hs[0])}, along ${hs[0].end === 'through' ? lineText(hs[0].axis) : alongText(hs[0].axis)}`)
      const more = f.holeCount > f.holes.length ? `; ${f.holeCount - f.holes.length} more not listed` : ''
      said.push(`${plural(f.holeCount, 'hole')} in ${of}: ${parts.join('; ')}${more}`)
    }
  }
  if (f.kinds.includes('boss')) {
    if (!Array.isArray(f.bosses) || !finite(f.bossCount)) return null
    if (f.bosses.length === 0) said.push(`no bosses on ${of}`)
    else {
      const groups = new Map<string, Boss[]>()
      for (const b of f.bosses) {
        const key = `${dia(b.diameter)} × ${f.exact || b.exact ? '' : '≈ '}${number(b.height)} high, along ${alongText(b.axis)}`
        groups.set(key, [...(groups.get(key) ?? []), b])
      }
      const parts = [...groups.entries()].map(([text, bs]) => `${bs.length} × ${text}`)
      const more = f.bossCount > f.bosses.length ? `; ${f.bossCount - f.bosses.length} more not listed` : ''
      said.push(`${plural(f.bossCount, 'boss', 'bosses')} on ${of}: ${parts.join('; ')}${more}`)
    }
  }
  if (f.kinds.includes('fillet')) {
    if (!Array.isArray(f.fillets) || !finite(f.filletCount)) return null
    if (f.fillets.length === 0) said.push(`no fillets on ${of}`)
    else {
      const groups = new Map<string, Fillet[]>()
      for (const b of f.fillets) {
        const key = `R${number(b.radius)} on ${b.side === 'outside' ? 'an outside edge' : 'an inside corner'}, ${number(b.sweep)}° round, ${number(b.length)} long${b.faces.length > 1 ? ` in ${b.faces.length} faces` : ''}`
        groups.set(key, [...(groups.get(key) ?? []), b])
      }
      const parts = [...groups.entries()].map(([text, bs]) => `${bs.length} × ${text}`)
      const more = f.filletCount > f.fillets.length ? `; ${f.filletCount - f.fillets.length} more not listed` : ''
      said.push(`${plural(f.filletCount, 'fillet')} on ${of}: ${parts.join('; ')}${more}`)
    }
  }
  if (f.kinds.includes('chamfer')) {
    if (!Array.isArray(f.chamfers) || !finite(f.chamferCount)) return null
    if (f.chamfers.length === 0) said.push(`no chamfers on ${of}`)
    else {
      const groups = new Map<string, Chamfer[]>()
      for (const c of f.chamfers) {
        const size = c.size !== undefined ? number(c.size) : (c.sizes ?? []).map((x) => number(x)).join(' and ')
        const key = `${size} mm on ${c.side === 'outside' ? 'an outside edge' : 'an inside corner'}${c.round ? ', round a cylinder' : ''}, ${number(c.length)} long${c.faces.length > 1 ? ` in ${c.faces.length} faces` : ''}`
        groups.set(key, [...(groups.get(key) ?? []), c])
      }
      const parts = [...groups.entries()].map(([text, cs]) => `${cs.length} × ${text}`)
      const more = f.chamferCount > f.chamfers.length ? `; ${f.chamferCount - f.chamfers.length} more not listed` : ''
      said.push(`${plural(f.chamferCount, 'chamfer')} on ${of}: ${parts.join('; ')}${more}`)
    }
  }
  const rest: string[] = []
  const n = f.notFeatures
  if (n?.arcs > 0) rest.push(`${plural(n.arcs, 'round face')} that do not go all the way round (slot ends) are told as neither`)
  if (n?.freeformFaces > 0) rest.push(`${plural(n.freeformFaces, 'freeform face')} cannot be told as part of a hole or a boss`)
  const tail = [f.exact ? null : 'approximate where it says ≈ (a depth or height taken between faces that are not planes or round)', f.complete === false ? 'the time ran out before every face was looked at' : null, ...rest].filter((x) => x !== null)
  return `${said.join('; ')}${tail.length > 0 ? `. ${tail.join('; ')}` : ''}`
}

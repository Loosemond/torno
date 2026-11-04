import { number, thousandth } from './format'

/** One edge of a failed fillet or chamfer, as the kernel describes it (`diagnose.py`). */
export interface DiagnosedEdge {
  /** Its place in the call, from 0: of the shape filleted in a failed build (`frame: 'local'`). */
  index?: number
  /** Its ref (`plate/E4`): of a trial on the last good build (`frame: 'object'`). */
  ref?: string
  type: string
  length?: number
  lengthExact?: boolean
  /** Its two ends, in the frame the diagnosis names. */
  start?: [number, number, number]
  end?: [number, number, number]
  /** Of a line: the axis it runs along, else its direction. */
  along?: 'X' | 'Y' | 'Z'
  direction?: [number, number, number]
  /** Of a circle. */
  radius?: number
  /** Points along it at each eighth of its length: what tells it from another edge with the same ends and length (`match_edges`). */
  samples?: Array<[number, number, number]>
  /** The kinds of the faces that meet at it. */
  between: string[]
  /** Of an edge that fails alone: the largest size that works for it alone (null: none down to the step), the least seen to fail. */
  worksUpTo?: number | null
  failsAt?: number
  complete?: false
  /** Of an edge that fails alone: the length of the shortest other edge that meets it at a corner, mm. */
  shortestNeighbour?: number
  /** Set by main, never by the kernel: the edge of the last good build that is this one, exactly (`match_edges`). */
  sameAs?: { ref: string; layout: string; revision: number }
}

/** A pair of edges that fails where each works alone. */
export interface FailingPair {
  edges: [number | string, number | string]
  /** Whether the two share a face. */
  adjacent: boolean
  /** How far apart they are, mm; exact between two lines. */
  apart?: number
  apartExact?: boolean
}

/** The largest size that works for some edges, bisected: null when none down to the step; `complete: false` when time ran out. */
export interface Bisected {
  worksUpTo: number | null
  failsAt: number
  complete?: false
}

/**
 * Why a fillet or a chamfer failed, found by trying (the kernel's `diagnose.py`): in the worker of the build that
 * failed (`BuildError.diagnosis`, `frame: 'local'`, edges by their place in the call) or of a trial on the last
 * good build (`try_fillet`, `frame: 'object'`, edges by ref). Every number is the kernel's.
 */
export interface FilletDiagnosis {
  operation: 'fillet' | 'chamfer'
  /** The radius, or the chamfer's length, mm. */
  size: number
  /** The chamfer's other length, when it has one. */
  size2?: number
  frame: 'local' | 'object'
  edgeCount: number
  /** How finely sizes were bisected, mm. */
  step: number
  /** The seconds it was given. */
  budget: number
  alone: { tried: number; failing: Array<number | string> }
  /** Only when every edge works alone. */
  pairs?: { tried: number; planned: number; failing: FailingPair[] }
  together?: Bisected
  /** The edges of the failures, at most 24. */
  edges: DiagnosedEdge[]
  complete: boolean
  seconds: number
}

/** One operand of a failed boolean, as the kernel describes it (`booleans.py`). */
export interface BooleanOperand {
  /** `base`, `base2`, … (what is operated on) and `tool`, `tool2`, … (what is brought in). */
  name: string
  /** `solid`, `2 solids`, `shell`, `face`, `wire`, `edge`, `vertex` or `empty`. */
  type: string
  /** OCC's check; absent of an empty operand and of one there was no time to check. */
  valid?: boolean
  /** What the argument analyzer found in it, as phrases (`crosses itself`). */
  faults?: string[]
  solids?: number
  faces?: number
  /** In the frame of the operand (`local`). */
  box?: { min: [number, number, number]; max: [number, number, number] }
}

/** Faces of a base and a tool that are one surface and share area. Their numbers are their places in their operands, from 0 (`F3`). */
export interface CoincidentFaces {
  base: string
  tool: string
  kind: 'plane' | 'cylinder' | 'sphere'
  /** Of planes: whether the two face the same way (a tool that ends flush with the face it cuts) or opposite ways. */
  facing?: 'same' | 'opposite'
  /** How far off the plane the other is, mm (0 of a cylinder or a sphere that lies on the other). */
  gap: number
  normal?: [number, number, number]
  center?: [number, number, number]
  /** What they share, mm². */
  area?: number
  areaExact?: boolean
}

/** How one base and one tool meet. Only of operands that are valid solids. */
export interface BooleanPair {
  base: string
  tool: string
  /** The distance between the two, mm (OCC's, never told as exact). */
  apart?: number
  apartExact?: false
  touching?: boolean
  /** How many of the points sampled on each (its vertices and the middles of its edges) lie inside the other solid. */
  inside?: { tool: number; base: number; sampledOnTool: number; sampledOnBase: number }
  coincident?: CoincidentFaces[]
  /** When there are more than are told. */
  coincidentCount?: number
}

export type BooleanCause = 'empty-operand' | 'not-solid' | 'invalid-operand' | 'flush' | 'coincident' | 'apart' | 'touching'

/**
 * Why a boolean (a cut, a fuse, an intersect or a split) failed, found by looking at its operands in the worker that
 * failed (`booleans.py`): `frame: 'local'`, the operands have no place in the scene and their faces are numbered by
 * their place in them.
 */
export interface BooleanDiagnosis {
  operation: 'cut' | 'fuse' | 'intersect' | 'split' | 'boolean'
  frame: 'local'
  budget: number
  operands: BooleanOperand[]
  pairs: BooleanPair[]
  /** What the findings come to, the likeliest first; none: nothing was found. */
  causes: BooleanCause[]
  /** When there were more operands than were looked at. */
  operandCount?: { base: number; tools: number }
  complete: boolean
  seconds: number
}

/** What a failed build can say of why: a fillet or a chamfer (found by trying it again in parts), or a boolean. */
export type BuildDiagnosis = FilletDiagnosis | BooleanDiagnosis

export const isBoolean = (d: BuildDiagnosis): d is BooleanDiagnosis => d.operation !== 'fillet' && d.operation !== 'chamfer'

/** A size as it is said: a fillet's radius `R6`, a chamfer's lengths `4 × 1 mm`. */
export function sizeText(operation: FilletDiagnosis['operation'], size: number, size2?: number): string {
  return operation === 'fillet' ? `R${number(size)}` : `${number(size)}${size2 === undefined ? '' : ` × ${number(size2)}`} mm`
}

/** A size found by bisection, to its step: `R5.999`, never rounded up to the size that failed. */
function bisectedText(operation: FilletDiagnosis['operation'], size: number): string {
  return operation === 'fillet' ? `R${thousandth(size)}` : `${thousandth(size)} mm`
}

/** How the text of a diagnosis begins; the error sheet, which heads it "Why", leaves it out. */
export const WHY = 'Why: '

/** What an edge is called in the text: its number in the call, or its ref. */
const nameOf = (edge: number | string): string => String(edge)

/**
 * The diagnosis in words: a first line (`Why: fillet R6 of 8 edges: …`) and, under a head that says their frame,
 * a line for each edge of the failures; within `limit` characters, the edges cut first and counted.
 */
export function diagnosisText(diagnosis: BuildDiagnosis, limit = Number.POSITIVE_INFINITY): string {
  if (isBoolean(diagnosis)) return booleanText(diagnosis, limit)
  const d = diagnosis
  const first = firstLine(d)
  const head = d.frame === 'local' ? `Edges (local: numbered by their place in the ${d.operation} call, from 0; ends in the frame of the shape filleted):` : 'Edges (in the frame of the project):'
  if (d.edges.length === 0 || first.length + 1 + head.length > limit) return cutEnd(first, limit)
  const lines = [first, head]
  let used = first.length + 1 + head.length
  for (const [i, edge] of d.edges.entries()) {
    const line = edgeLine(d, edge)
    const left = d.edges.length - i
    const more = `and ${left - 1} more edge${left - 1 === 1 ? '' : 's'}`
    if (used + 1 + line.length + (left > 1 ? 1 + more.length : 0) > limit) {
      const cut = `and ${left} more edge${left === 1 ? '' : 's'}`
      if (used + 1 + cut.length <= limit) lines.push(cut)
      break
    }
    lines.push(line)
    used += 1 + line.length
  }
  return lines.join('\n')
}

function firstLine(d: FilletDiagnosis): string {
  const n = d.edgeCount
  const said: string[] = []
  const numbered = d.frame === 'local'
  const list = (edges: Array<number | string>): string => `${numbered ? 'edges ' : ''}${edges.map(nameOf).join(', ')}`
  const failingAlone = d.alone.failing
  if (failingAlone.length > 0) said.push(`${failingAlone.length} fail${failingAlone.length === 1 ? 's' : ''} alone (${list(failingAlone)})`)
  else if (n > 1 && d.alone.tried >= n) said.push('each works alone')
  else if (n > 1 && d.alone.tried > 0) said.push(`no edge of the ${d.alone.tried} tried fails alone`)
  else if (n > 1) said.push('no edge was tried alone')
  if (d.pairs) said.push(pairsText(d, d.pairs, numbered))
  if (d.together) said.push(togetherText(d, d.together))
  const undone = cutShort(d)
  return `${WHY}${d.operation} ${sizeText(d.operation, d.size, d.size2)} of ${n} edge${n === 1 ? '' : 's'}: ${said.join('; ')}.${undone ? ` ${undone}` : ''}`
}

function pairsText(d: FilletDiagnosis, pairs: NonNullable<FilletDiagnosis['pairs']>, numbered: boolean): string {
  const failing = pairs.failing
  if (failing.length === 0) {
    return pairs.tried >= pairs.planned ? `no pair fails (${pairs.tried} tried): only all ${d.edgeCount} together` : `no pair of the ${pairs.tried} tried fails`
  }
  const adjacent = failing.every((p) => p.adjacent) ? 'adjacent ' : ''
  // Those as far apart as each other are said together, with what that distance means for two of the size asked.
  const groups = new Map<string, FailingPair[]>()
  for (const pair of failing) {
    const key = pair.apart === undefined ? '' : `${pair.apartExact === false ? '≈ ' : ''}${number(pair.apart)}`
    groups.set(key, [...(groups.get(key) ?? []), pair])
  }
  const told = [...groups.entries()].map(([apart, group]) => {
    const names = `${numbered ? 'edges ' : ''}${group.map((p) => p.edges.map(nameOf).join('-')).join(', ')}`
    if (apart === '') return names
    const need = group[0]!.apart! <= 2 * d.size ? `, two ${d.operation === 'fillet' ? sizeText('fillet', d.size) : `chamfers of ${sizeText('chamfer', d.size, d.size2)}`} need more` : ''
    return `${names}: ${apart} mm apart${need}`
  })
  return `${failing.length} pair${failing.length === 1 ? '' : 's'} of ${adjacent}edges fail${failing.length === 1 ? 's' : ''} (${told.join('; ')})`
}

function togetherText(d: FilletDiagnosis, together: Bisected): string {
  const who = d.edgeCount === 1 ? 'the edge works' : `the ${d.edgeCount} together work`
  const fails = bisectedText(d.operation, together.failsAt)
  if (together.complete === false) {
    return together.worksUpTo === null ? `no size tried works for ${d.edgeCount === 1 ? 'it' : 'them'} (fail at ${fails})` : `${who} at ${bisectedText(d.operation, together.worksUpTo)} at least (fail at ${fails})`
  }
  if (together.worksUpTo === null) return `${who} at no size down to ${thousandth(d.step)} mm`
  return `${who} up to ${bisectedText(d.operation, together.worksUpTo)} (fail at ${fails}, bisected to ${thousandth(d.step)} mm)`
}

/** What a diagnosis that ran out of time had no time for, as a sentence; '' of one that did everything. */
function cutShort(d: FilletDiagnosis): string {
  if (d.complete) return ''
  const undone: string[] = []
  const n = d.edgeCount
  if (n > 1 && d.alone.tried < n) undone.push(`${n - d.alone.tried} edge${n - d.alone.tried === 1 ? ' was' : 's were'} not tried alone`)
  if (d.pairs && d.pairs.tried < d.pairs.planned) undone.push(`${d.pairs.planned - d.pairs.tried} pair${d.pairs.planned - d.pairs.tried === 1 ? ' was' : 's were'} not tried`)
  const what = d.operation === 'fillet' ? 'radius' : 'size'
  if (!d.together) undone.push(`the largest ${what} that works was not looked for`)
  else if (d.together.complete === false) undone.push('the bisection did not end')
  const unlooked = d.edges.filter((e) => d.alone.failing.includes(e.index ?? e.ref ?? -1) && (e.worksUpTo === undefined || e.complete === false)).length
  if (unlooked > 0) undone.push(`the largest ${what} of ${unlooked} edge${unlooked === 1 ? '' : 's'} alone was not found`)
  const listed = undone.length <= 1 ? undone.join('') : `${undone.slice(0, -1).join(', ')}, and ${undone.at(-1)}`
  return `Cut short at ${number(d.budget)} s${listed ? `: ${listed}` : ''}.`
}

function edgeLine(d: FilletDiagnosis, edge: DiagnosedEdge): string {
  const parts = [edge.type]
  if (edge.radius !== undefined) parts.push(`radius ${number(edge.radius)}`)
  if (edge.length !== undefined) parts.push(`${edge.lengthExact === false ? '≈ ' : ''}${number(edge.length)} mm`)
  if (edge.along) parts.push(`along ${edge.along}`)
  else if (edge.direction) parts.push(`along ${point(edge.direction, (c) => c.toFixed(2).replace(/\.?0+$/, '').replace(/^-0$/, '0'))}`)
  if (edge.between.length > 0) parts.push(`between ${faces(edge.between)}`)
  if (edge.start && edge.end) parts.push(`${point(edge.start)} to ${point(edge.end)}`)
  let line = `${edge.ref ?? edge.index ?? '?'}: ${parts.join(', ')}`
  if (edge.sameAs) line += `, which is ${edge.sameAs.ref} of r${edge.sameAs.revision} (layout ${edge.sameAs.layout})`
  const failsAlone = d.alone.failing.includes(edge.index ?? edge.ref ?? -1)
  if (failsAlone && edge.worksUpTo !== undefined) {
    if (edge.worksUpTo === null) line += edge.complete === false ? `; alone, no size tried works` : `; alone, none down to ${bisectedText(d.operation, d.step)}`
    else line += `; alone ${edge.complete === false ? 'at' : 'up to'} ${bisectedText(d.operation, edge.worksUpTo)}${edge.complete === false ? ' at least' : ''}`
  }
  if (failsAlone && edge.shortestNeighbour !== undefined) line += `; its shortest neighbour is ${number(edge.shortestNeighbour)} mm`
  return line
}

/** The kinds of the faces that meet at an edge: `2 planes`, `a plane and a cylinder`. */
function faces(kinds: string[]): string {
  const article = (kind: string): string => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`
  if (kinds.length === 2 && kinds[0] === kinds[1]) return `2 ${kinds[0]}s`
  if (kinds.length === 1) return `${article(kinds[0]!)} and itself`
  return kinds.length === 2 ? `${article(kinds[0]!)} and ${article(kinds[1]!)}` : kinds.map(article).join(', ')
}

function point(p: readonly number[], say: (c: number) => string = number): string {
  return `(${p.map(say).join(', ')})`
}

/**
 * A boolean's diagnosis in words: a first line (`Why: cut failed: tool is a face, not a solid.`) and, under a head
 * that says their frame, a line for each operand and for each pair of faces that lie on each other; within `limit`
 * characters, the lines cut from the end and counted.
 */
function booleanText(d: BooleanDiagnosis, limit: number): string {
  const first = booleanFirstLine(d)
  const head = 'Operands (local: faces numbered by their place in the operand, from 0; in the frame of the operand):'
  const all = [...d.operands.map(operandLine), ...d.pairs.flatMap((pair) => (pair.coincident ?? []).map((c) => coincidentLine(pair, c)))]
  if (all.length === 0 || first.length + 1 + head.length > limit) return cutEnd(first, limit)
  const lines = [first, head]
  let used = first.length + 1 + head.length
  for (const [i, line] of all.entries()) {
    const left = all.length - i
    const more = `and ${left - 1} more line${left - 1 === 1 ? '' : 's'}`
    if (used + 1 + line.length + (left > 1 ? 1 + more.length : 0) > limit) {
      const cut = `and ${left} more line${left === 1 ? '' : 's'}`
      if (used + 1 + cut.length <= limit) lines.push(cut)
      break
    }
    lines.push(line)
    used += 1 + line.length
  }
  return lines.join('\n')
}

const article = (kind: string): string => (/^\d/.test(kind) ? kind : `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`)

function booleanFirstLine(d: BooleanDiagnosis): string {
  const said: string[] = []
  const pairs = d.pairs
  const coincident = pairs.flatMap((pair) => (pair.coincident ?? []).map((c) => ({ pair, c })))
  const flush = coincident.filter(({ c }) => c.kind === 'plane' && c.facing === 'same')
  const lying = coincident.filter(({ c }) => !(c.kind === 'plane' && c.facing === 'same'))
  const andMore = (n: number): string => (n > 1 ? ` (and ${n - 1} more)` : '')
  const area = (c: CoincidentFaces): string => (c.area === undefined ? '' : `, over ${number(c.area)} mm²`)
  for (const cause of d.causes) {
    if (cause === 'empty-operand') {
      const empty = d.operands.filter((o) => o.type === 'empty').map((o) => o.name)
      said.push(`${empty.join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty`)
    } else if (cause === 'not-solid') {
      for (const o of d.operands.filter((o) => o.solids === 0)) said.push(`${o.name} is ${article(o.type)}, not a solid (a boolean needs solids)`)
    } else if (cause === 'invalid-operand') {
      for (const o of d.operands.filter((o) => o.solids && (o.valid === false || o.faults?.length))) {
        said.push(`${o.name} is not a valid solid${o.faults?.length ? ` (it ${o.faults.join(' and ')})` : ''}`)
      }
    } else if (cause === 'flush' && flush[0]) {
      const { pair, c } = flush[0]
      said.push(`face ${c.tool} of ${pair.tool} lies on face ${c.base} of ${pair.base}, facing the same way${area(c)}${andMore(flush.length)}: a tool that ends flush with the face it cuts, not past it`)
    } else if (cause === 'coincident' && lying[0]) {
      const { pair, c } = lying[0]
      const how = c.kind === 'plane' ? 'on each other, facing opposite ways' : `on one ${c.kind}`
      said.push(`face ${c.base} of ${pair.base} and face ${c.tool} of ${pair.tool} lie ${how}${area(c)}${andMore(lying.length)}`)
    } else if (cause === 'apart') {
      const pair = pairs.find((p) => p.apart !== undefined && p.apart > 0 && p.touching === false)
      if (pair) said.push(`${pair.tool} is ≈ ${number(pair.apart!)} mm from ${pair.base}: they do not meet`)
    } else if (cause === 'touching') {
      const pair = pairs.find((p) => p.touching)
      if (pair) said.push(`${pair.tool} and ${pair.base} touch, and no point sampled on either lies inside the other: they may meet only along a face, an edge or a point`)
    }
  }
  const left = d.operandCount ? ` Only the first ${MOST_OPERANDS} of ${d.operandCount.base} base and ${d.operandCount.tools} tool operands were looked at.` : ''
  const undone = d.complete ? '' : ` Cut short at ${number(d.budget)} s: only what was found in time is told.${left}`
  return `${WHY}${d.operation} failed: ${said.length > 0 ? said.join('; ') : 'no cause was found in its operands'}.${undone}`
}

/** The most operands of each side the kernel looks at (`MOST_OPERANDS` in `booleans.py`). */
const MOST_OPERANDS = 4

function operandLine(o: BooleanOperand): string {
  const parts = [o.type]
  if (o.valid !== undefined) parts.push(o.valid ? 'valid' : 'not valid')
  if (o.faults?.length) parts.push(`it ${o.faults.join(' and ')}`)
  if (o.faces !== undefined) parts.push(`${o.faces} face${o.faces === 1 ? '' : 's'}`)
  if (o.box) parts.push(`box ${point(o.box.min)} to ${point(o.box.max)}`)
  return `${o.name}: ${parts.join(', ')}`
}

function coincidentLine(pair: BooleanPair, c: CoincidentFaces): string {
  const parts: string[] = []
  if (c.kind === 'plane') {
    parts.push(`plane, facing ${c.facing === 'same' ? 'the same way' : 'opposite ways'}`)
    const axis = c.normal ? c.normal.findIndex((v) => Math.abs(v) >= Math.cos((0.5 * Math.PI) / 180)) : -1
    if (c.center) parts.push(axis >= 0 ? `at ${'xyz'[axis]} = ${number(c.center[axis]!)}` : `through ${point(c.center)}`)
    if (c.gap > 0) parts.push(`${number(c.gap)} mm off`)
  } else parts.push(c.kind)
  if (c.area !== undefined) parts.push(`${c.areaExact === false ? '≈ ' : ''}${number(c.area)} mm² shared`)
  return `${pair.base} ${c.base} and ${pair.tool} ${c.tool}: ${parts.join(', ')}`
}

function cutEnd(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

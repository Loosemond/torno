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
export function diagnosisText(d: FilletDiagnosis, limit = Number.POSITIVE_INFINITY): string {
  const first = firstLine(d)
  const head = d.frame === 'local' ? `Edges (local: numbered by their place in the ${d.operation} call, from 0; ends in the frame of the shape filleted):` : 'Edges (in the frame of the object):'
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

function cutEnd(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

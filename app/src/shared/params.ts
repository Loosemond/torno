import type { Param } from './scene'

/**
 * Where a size of the model's `Params` says it comes from: the first word of the field's comment, before a `:`
 * (`# assumed: 5 perimeters at 0.4 mm`). `M<n>` and `S<n>` stand for a mark and a scan, whatever the number; `ref`
 * and `datasheet` may be followed by a name. It is the model's own claim, never checked by torno; a missing or
 * unknown word is `unsaid`, never `assumed`.
 */
export const SOURCES = ['brief', 'mark', 'scan', 'ref', 'object', 'datasheet', 'person', 'derived', 'assumed'] as const
export type Source = (typeof SOURCES)[number] | 'unsaid'

/** The source a comment begins with; `unsaid` for none, or for a word that is not one of the convention's. */
export function sourceOf(doc: string | null | undefined): Source {
  const word = /^\s*([A-Za-z][^:\n]*?)\s*(?:≈\s*)?:/.exec(doc ?? '')?.[1]?.toLowerCase()
  if (!word) return 'unsaid'
  if (/^m\d+$/.test(word)) return 'mark'
  if (/^s\d+$/.test(word)) return 'scan'
  if (word === 'ref' || word.startsWith('ref ')) return 'ref'
  if (word === 'datasheet' || word.startsWith('datasheet ')) return 'datasheet'
  return (SOURCES as readonly string[]).includes(word) ? (word as Source) : 'unsaid'
}

/** A field is a size when its default is a number (a count, a clearance); text, flags and lists have no source to tell. */
export const isSize = (param: Param): boolean => typeof param.default === 'number'

export interface SourceCount {
  /** The sizes of the model. */
  sizes: number
  /** Those whose comment says `assumed`, in the model's order. */
  assumed: Param[]
  /** Those with no source, or one that is not of the convention. */
  unsaid: Param[]
}

export function sourceCount(params: readonly Param[] | undefined): SourceCount {
  const sizes = (params ?? []).filter(isSize)
  return {
    sizes: sizes.length,
    assumed: sizes.filter((p) => sourceOf(p.doc) === 'assumed'),
    unsaid: sizes.filter((p) => sourceOf(p.doc) === 'unsaid')
  }
}

const value = (p: Param): string => String(typeof p.default === 'number' ? Math.round(p.default * 1000) / 1000 : p.default)

/** `Assumed: wall 2, lip 3 (2 of 14 sizes); no source: 4`; '' when there is nothing to say. */
export function assumedLine(params: readonly Param[] | undefined): string {
  const { sizes, assumed, unsaid } = sourceCount(params)
  if (assumed.length === 0 && unsaid.length === 0) return ''
  if (assumed.length === 0) return `No source: ${unsaid.length} of ${sizes} sizes`
  return `Assumed: ${assumed.map((p) => `${p.name} ${value(p)}`).join(', ')} (${assumed.length} of ${sizes} sizes)${unsaid.length > 0 ? `; no source: ${unsaid.length}` : ''}`
}

/** The set of assumed and unsaid sizes as one string, to tell whether it changed between two builds. */
export const assumedKey = (params: readonly Param[] | undefined): string => {
  const { assumed, unsaid } = sourceCount(params)
  return `${assumed.map((p) => `${p.name}=${value(p)}`).join(',')}|${unsaid.map((p) => p.name).join(',')}`
}

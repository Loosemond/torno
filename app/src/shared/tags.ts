import type { Part } from './scene'

/**
 * A tag is a name the model gives a face or an edge (`tags(p, parts)`): its ref is `<part>/@<tag>`. The `@` keeps it
 * apart from a part, `F<i>`, `E<i>` and `M<n>`. A tag names one face or edge, or several (`lid/@screw_holes`).
 */
export const TAG_REF = /^(.+)\/@([A-Za-z_][A-Za-z0-9_.-]*)$/
/** What a tag's name may be: as the kernel's loader reads it. */
export const TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** A ref that is a tag's, split: the part's name and the tag's. */
export function splitTagRef(ref: string): { part: string; tag: string } | null {
  const match = TAG_REF.exec(ref)
  return match ? { part: match[1], tag: match[2] } : null
}

/** `lid/F12`, `lid/E3` of a part's tag, faces first, as the kernel numbers them; undefined when the part has no such tag. */
export function tagRefs(part: Pick<Part, 'name' | 'tags'>, tag: string): string[] | undefined {
  const named = part.tags?.[tag]
  if (!named) return undefined
  return [...(named.faces ?? []).map((i) => `${part.name}/F${i}`), ...(named.edges ?? []).map((i) => `${part.name}/E${i}`)]
}

/** The words that say what tags a part has, after one it does not: `its tags: @top, @bottom`. */
export function tagsText(part: Pick<Part, 'tags'>): string {
  const names = Object.keys(part.tags ?? {})
  return names.length > 0 ? `its tags: ${names.map((t) => `@${t}`).join(', ')}` : 'it has no tags'
}

/**
 * The tag that names exactly this face or edge and nothing else (`lid/F12` → `top`), or undefined. A tag of
 * several is not one face's name; of two tags on one face, the first in the model's order.
 */
export function tagOfRef(part: Pick<Part, 'name' | 'tags'> | undefined, ref: string): string | undefined {
  if (!part?.tags) return undefined
  return Object.keys(part.tags).find((tag) => {
    const refs = tagRefs(part, tag)
    return refs?.length === 1 && refs[0] === ref
  })
}

/**
 * What a tag ref names in a layout's parts: the refs (`lid/F12`, ...), or why it names nothing, in words that say
 * what there is. Null for a ref that is no tag's.
 */
export function expandTag(parts: readonly Pick<Part, 'name' | 'tags'>[], ref: string): { refs: string[] } | { error: string } | null {
  const split = splitTagRef(ref)
  if (!split) return null
  const part = parts.find((p) => p.name === split.part)
  if (!part) return { error: `no part '${split.part}' (parts: ${parts.map((p) => p.name).join(', ') || 'none'})` }
  const refs = tagRefs(part, split.tag)
  if (!refs) return { error: `${part.name} has no tag @${split.tag}; ${tagsText(part)}` }
  return { refs }
}

/**
 * The tag to show beside a face's or an edge's ref, as `@top` (`lid/F12 · @top`): the one the model gives exactly
 * that face or edge, found among a layout's parts by the part the ref starts with; undefined when it has none.
 */
export function tagLabel(parts: readonly Pick<Part, 'name' | 'tags'>[], ref: string): string | undefined {
  const slash = ref.lastIndexOf('/')
  const tag = slash < 0 ? undefined : tagOfRef(parts.find((p) => p.name === ref.slice(0, slash)), ref)
  return tag === undefined ? undefined : `@${tag}`
}

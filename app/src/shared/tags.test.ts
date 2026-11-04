import { describe, expect, it } from 'vitest'
import { expandTag, splitTagRef, tagLabel, tagOfRef, tagRefs, tagsText } from './tags'

const lid = { name: 'lid', tags: { top: { faces: [12] }, screws: { faces: [3, 4] }, rim: { edges: [7] }, mixed: { faces: [1], edges: [2] } } }
const base = { name: 'base' }

describe('tag refs', () => {
  it('splits a ref of a tag and nothing else', () => {
    expect(splitTagRef('lid/@top')).toEqual({ part: 'lid', tag: 'top' })
    expect(splitTagRef('lid/F12')).toBeNull()
    expect(splitTagRef('lid')).toBeNull()
    expect(splitTagRef('lid/@two words')).toBeNull()
  })
  it('lists the refs of a tag, faces first', () => {
    expect(tagRefs(lid, 'top')).toEqual(['lid/F12'])
    expect(tagRefs(lid, 'screws')).toEqual(['lid/F3', 'lid/F4'])
    expect(tagRefs(lid, 'mixed')).toEqual(['lid/F1', 'lid/E2'])
    expect(tagRefs(lid, 'nope')).toBeUndefined()
  })
  it('finds the tag that names exactly a face or an edge', () => {
    expect(tagOfRef(lid, 'lid/F12')).toBe('top')
    expect(tagOfRef(lid, 'lid/E7')).toBe('rim')
    expect(tagOfRef(lid, 'lid/F3')).toBeUndefined()
    expect(tagOfRef(base, 'base/F0')).toBeUndefined()
    expect(tagOfRef(undefined, 'x/F0')).toBeUndefined()
  })
  it('labels a face or an edge with its tag', () => {
    expect(tagLabel([lid, base], 'lid/F12')).toBe('@top')
    expect(tagLabel([lid, base], 'lid/F3')).toBeUndefined()
    expect(tagLabel([lid, base], 'lid')).toBeUndefined()
  })
  it('expands a ref of a tag, or says what there is', () => {
    expect(expandTag([lid, base], 'lid/@screws')).toEqual({ refs: ['lid/F3', 'lid/F4'] })
    expect(expandTag([lid, base], 'lid/F3')).toBeNull()
    expect(expandTag([lid, base], 'lid/@nope')).toEqual({ error: 'lid has no tag @nope; its tags: @top, @screws, @rim, @mixed' })
    expect(expandTag([lid, base], 'base/@top')).toEqual({ error: 'base has no tag @top; it has no tags' })
    expect(expandTag([lid, base], 'x/@top')).toEqual({ error: "no part 'x' (parts: lid, base)" })
    expect(tagsText({})).toBe('it has no tags')
  })
})

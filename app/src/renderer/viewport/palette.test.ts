import { describe, expect, it } from 'vitest'
import { PALETTE, colorFor, colorsByName, edgeTint, mix } from './palette'

const HEX = /^#[0-9A-F]{6}$/i

describe('colorFor', () => {
  it('is stable for the same name and index', () => {
    expect(colorFor('lid', 2)).toBe(colorFor('lid', 2))
    expect(colorFor('lid', 2)).toBe(PALETTE[2])
  })

  it('wraps after eight', () => {
    expect(PALETTE).toHaveLength(8)
    expect(colorFor('a', 8)).toBe(colorFor('a', 0))
    expect(colorFor('a', 19)).toBe(PALETTE[3])
  })

  it('returns valid hex', () => {
    for (let i = 0; i < 20; i++) expect(colorFor(`p${i}`, i)).toMatch(HEX)
  })

  it('falls back to the name when there is no index', () => {
    expect(colorFor('lid', -1)).toMatch(HEX)
    expect(colorFor('lid', -1)).toBe(colorFor('lid', -1))
    expect(PALETTE).toContain(colorFor('lid', Number.NaN))
  })
})

describe('colorsByName', () => {
  it('assigns by position among the sorted unique names', () => {
    const colors = colorsByName(['post', 'base', 'lid', 'base', 'lid'])
    expect([...colors.keys()]).toEqual(['base', 'lid', 'post'])
    expect(colors.get('base')).toBe(PALETTE[0])
    expect(colors.get('lid')).toBe(PALETTE[1])
    expect(colors.get('post')).toBe(PALETTE[2])
  })

  it('does not depend on the order parts arrive in', () => {
    expect(colorsByName(['lid', 'base']).get('lid')).toBe(colorsByName(['base', 'lid', 'base']).get('lid'))
  })
})

describe('tints', () => {
  it('edgeTint is a darker valid hex of the same hue', () => {
    const tint = edgeTint('#7B93B4')
    expect(tint).toMatch(HEX)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16))
    expect(r).toBeLessThan(0x7b)
    expect(g).toBeLessThan(0x93)
    expect(b).toBeLessThan(0xb4)
    expect(b).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(r)
  })

  it('mix blends two colours', () => {
    expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000')
    expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF')
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080')
  })
})

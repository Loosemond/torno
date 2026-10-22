import { describe, expect, it } from 'vitest'
import { layersSaid, scansSaid } from './sectionSaid'

describe('what a folded section says in its title', () => {
  it('counts the parts of the layout, and those switched off', () => {
    expect(layersSaid(12, 3)).toBe('12 · 3 hidden')
    expect(layersSaid(2, 0)).toBe('2')
    expect(layersSaid(0, 0)).toBe('0')
  })

  it('counts the scans, and says what is to be done about those that are not aligned', () => {
    expect(scansSaid([])).toBe('0')
    expect(scansSaid(['unaligned'])).toBe('1 · unaligned')
    expect(scansSaid(['aligned', 'placed'])).toBe('2')
    expect(scansSaid(['unaligned', 'aligned', 'unaligned', 'check'])).toBe('4 · 2 unaligned · 1 check')
    expect(scansSaid(['missing', 'missing'])).toBe('2 · 2 missing')
  })
})

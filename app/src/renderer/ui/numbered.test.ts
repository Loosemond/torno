import { describe, expect, it } from 'vitest'
import { capital, numberedPieces } from './numbered'

const set = (text: string): string[] => numberedPieces(text).filter((_, n) => n % 2 === 1)

// Final fix wave (R6): every number and every ref is set in the monospace face, a ref as the one thing it is.
describe('what a sentence has set in the face of numbers', () => {
  it('takes a ref whole: a scan, a mark, a build, a face or an edge of a part', () => {
    expect(set('S1 is back: M4 on tub/F25 was checked on r12, 0.5 mm off lid-2/E7')).toEqual(['S1', 'M4', 'tub/F25', 'r12', '0.5', 'lid-2/E7'])
    expect(numberedPieces('S1 is gone')).toEqual(['', 'S1', ' is gone'])
  })

  it('takes numbers as before, with their sign and their separators, and no letter of a word', () => {
    expect(set('1,607,144 triangles, 2518 × 2351 × 1494 mm, rms 0.003 mm, at -95.6')).toEqual(['1,607,144', '2518', '2351', '1494', '0.003', '-95.6'])
    expect(set('Scans are read as mm; Micra.glb has none')).toEqual([])
  })

  it('starts a sentence with a capital', () => {
    expect(capital('plane RMS 0.8 mm')).toBe('Plane RMS 0.8 mm')
  })
})

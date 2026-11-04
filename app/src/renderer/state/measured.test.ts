import { describe, expect, it } from 'vitest'
import { componentsOf } from './measured'

describe('the components of a held distance', () => {
  it('are the kernel’s second point less its first, per axis', () => {
    expect(componentsOf({ measure: 'distance', points: [[5, 3, 3], [5, 15.5, 3]] })).toEqual([['x', '0'], ['y', '12.5'], ['z', '0']])
  })
  it('are none for another measurement, or when the kernel gave no points', () => {
    expect(componentsOf({ measure: 'diameter', points: [[0, 0, 0], [8, 0, 0]] })).toBeNull()
    expect(componentsOf({ measure: 'distance' })).toBeNull()
  })
})

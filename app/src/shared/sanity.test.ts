import { describe, expect, it } from 'vitest'
import { DEFECT_MEANS, partDefects } from './sanity'

describe('the defects of a part', () => {
  it('are what its build says of its shape, in order, and none of a sound part or of a kernel that said nothing', () => {
    expect(partDefects({ valid: true })).toEqual([])
    expect(partDefects({ valid: true, reversed: [], openShells: 0 })).toEqual([])
    expect(partDefects({ valid: false, reversed: [1], openShells: 2, meshDisagrees: true })).toEqual(['not valid', 'inside out', 'not closed', 'mesh disagrees'])
    for (const defect of partDefects({ valid: false, reversed: [1], openShells: 2, meshDisagrees: true })) expect(DEFECT_MEANS[defect]).toMatch(/^[a-zO']/)
  })
})

import { describe, expect, it } from 'vitest'
import { REFUSED, unrefused } from './refusal'

describe('unrefused', () => {
  it('throws the message of a refusal main resolved with', () => {
    expect(() => unrefused({ [REFUSED]: 'angle is measured between two planar faces' })).toThrow(/^angle is measured between two planar faces$/)
  })
  it('passes anything else through', () => {
    const mark = { id: 'M1', refused: 'a dimension may say why it has no value' }
    expect(unrefused(mark)).toBe(mark)
    expect(unrefused(null)).toBe(null)
    expect(unrefused([1])).toEqual([1])
  })
})

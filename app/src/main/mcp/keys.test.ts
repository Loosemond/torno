import { describe, expect, it } from 'vitest'
import { nearestKey, onlyKeysWrong, unknownKeys } from './keys'

describe('a key a tool does not take', () => {
  it('is refused by name, with the nearest key it does take and all of them', () => {
    expect(unknownKeys({ part: 'tub', ignored: ['M7'] }, ['part', 'scan', 'ignore', 'margin', 'layout'], 'scan_clash')).toBe(
      'scan_clash takes no "ignored": did you mean ignore? An unknown key is not ignored: nothing was done. It takes: part, scan, ignore, margin, layout.'
    )
    expect(unknownKeys({ scans: 'S1', planes: 1 }, ['plane', 'parts', 'layout', 'size', 'deflection', 'scan'], 'section')).toBe(
      'section takes no "scans" (did you mean scan?), "planes" (did you mean plane?). An unknown key is not ignored: nothing was done. It takes: plane, parts, layout, size, deflection, scan.'
    )
    expect(unknownKeys({ colour: 'red' }, ['ref', 'layout'], 'describe')).toBe('describe takes no "colour". An unknown key is not ignored: nothing was done. It takes: ref, layout.')
    expect(unknownKeys({ anything: 1 }, [], 'scene')).toBe('scene takes no "anything". An unknown key is not ignored: nothing was done. It takes no arguments.')
  })

  it('is none when every key is one it takes, and for what is no object: that is for whoever reads the value to say', () => {
    expect(unknownKeys({ part: 'tub' }, ['part', 'scan'], 'scan_clash')).toBeNull()
    expect(unknownKeys({}, [], 'scene')).toBeNull()
    for (const value of [undefined, null, 'S1', 4, [1, 2, 3]]) expect(unknownKeys(value, ['part'], 'scan_clash')).toBeNull()
  })

  it('finds the nearest key by its letters: a slip, a plural, another case; none when nothing is near', () => {
    const keys = ['part', 'faces', 'scan', 'region', 'from', 'within', 'samples', 'layout']
    expect(nearestKey('face', keys)).toBe('faces')
    expect(nearestKey('Region', keys)).toBe('region')
    expect(nearestKey('sample', keys)).toBe('samples')
    expect(nearestKey('scann', keys)).toBe('scan')
    expect(nearestKey('withn', keys)).toBe('within')
    expect(nearestKey('colour', keys)).toBeNull()
    expect(nearestKey('x', keys)).toBeNull()
  })

  it('is what is wrong with a value only when the value would be one without it, or the key is a slip of one that is taken', () => {
    const keys = ['axis', 'at', 'origin', 'normal']
    const isPlane = (value: unknown): boolean => typeof (value as { at?: unknown }).at === 'number'
    expect(onlyKeysWrong({ axis: 'z', at: 3, offset: 1 }, keys, isPlane)).toBe(true)
    expect(onlyKeysWrong({ axis: 'z', att: 3 }, keys, isPlane)).toBe(true)
    // Something else altogether: whoever reads it says what a plane looks like.
    expect(onlyKeysWrong({ z: 3 }, keys, isPlane)).toBe(false)
    expect(onlyKeysWrong({ axis: 'z' }, keys, isPlane)).toBe(false)
    expect(onlyKeysWrong('z=3', keys, isPlane)).toBe(false)
  })
})

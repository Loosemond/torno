import { describe, expect, it } from 'vitest'
import { EXPLODED_NOTE, NO_EXPLODE, explodeArg, explodeOf, explodeOffsets, explodeShown, explodeText, isExploded, nothingApart, nothingApartText } from './explode'

const tray = { name: 'tray', bbox: { min: [-20, -15, 0] as [number, number, number], max: [20, 15, 10] as [number, number, number] } }
const lid = { name: 'lid', bbox: { min: [-20, -15, 10] as [number, number, number], max: [20, 15, 12] as [number, number, number] } }
const R = Math.hypot(20, 15, 6)

describe('explodeOffsets', () => {
  it('moves nothing when nothing is exploded, or there is one part', () => {
    expect(explodeOffsets([tray, lid], null)).toEqual({})
    expect(explodeOffsets([tray, lid], NO_EXPLODE)).toEqual({})
    expect(explodeOffsets([tray], { amount: 1, scale: 1, axis: 'centre' })).toEqual({})
  })

  it('moves each part away from the centre of the layout, by the layout\'s reach and its own distance', () => {
    const moved = explodeOffsets([tray, lid], { amount: 0.5, scale: 1, axis: 'centre' })
    expect(moved.tray[0]).toBe(0)
    expect(moved.tray[1]).toBe(0)
    expect(moved.tray[2]).toBeCloseTo(-(R + 1) * 0.5, 9)
    expect(moved.lid[2]).toBeCloseTo((R + 5) * 0.5, 9)
    // Twice as far at twice the scale.
    expect(explodeOffsets([tray, lid], { amount: 0.5, scale: 2, axis: 'centre' }).lid[2]).toBeCloseTo(R + 5, 9)
  })

  it('leaves a part whose centre is the layout\'s where it is', () => {
    const core = { name: 'core', bbox: { min: [-1, -1, 5] as [number, number, number], max: [1, 1, 7] as [number, number, number] } }
    expect(explodeOffsets([tray, lid, core], { amount: 1, scale: 1, axis: 'centre' }).core).toEqual([0, 0, 0])
  })

  it('sets parts apart along an axis in the order of their centres, also when their centres coincide on it', () => {
    const z = explodeOffsets([tray, lid], { amount: 0.5, scale: 1, axis: 'z' })
    expect(z.tray).toEqual([0, 0, expect.closeTo(-0.5 * R, 9)])
    expect(z.lid).toEqual([0, 0, expect.closeTo(0.5 * R, 9)])
    // Along x both centres are at 0: the scene's order decides, and they still part.
    const x = explodeOffsets([tray, lid], { amount: 1, scale: 1, axis: 'x' })
    expect(x.tray[0]).toBeCloseTo(-R, 9)
    expect(x.lid[0]).toBeCloseTo(R, 9)
    expect(x.lid[2]).toBe(0)
  })

  it('never answers with a number that is none', () => {
    const flat = { name: 'a', bbox: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] } }
    for (const moved of Object.values(explodeOffsets([flat, { ...flat, name: 'b' }], { amount: 1, scale: 4, axis: 'centre' }))) expect(moved.every(Number.isFinite)).toBe(true)
  })
})

describe('explodeOf', () => {
  it('keeps what is an explode, within its ranges', () => {
    expect(explodeOf({ amount: 0.4, scale: 2, axis: 'z' })).toEqual({ amount: 0.4, scale: 2, axis: 'z' })
    expect(explodeOf({ amount: 7 })).toEqual({ amount: 1, scale: 1, axis: 'centre' })
    expect(explodeOf({ amount: 0.5, scale: 99, axis: 'w' })).toEqual({ amount: 0.5, scale: 4, axis: 'centre' })
    expect(explodeOf({ amount: -1, scale: 0 })).toEqual({ amount: 0, scale: 0.25, axis: 'centre' })
  })
  it('is none for what is not one', () => {
    for (const value of [null, 3, 'half', [], {}, { amount: '0.5' }, { amount: NaN }, { amount: Infinity }]) expect(explodeOf(value)).toBeNull()
  })
  it('takes a bare number from the agent as the amount', () => {
    expect(explodeArg(0.5)).toEqual({ amount: 0.5, scale: 1, axis: 'centre' })
    expect(explodeArg({ amount: 0.5, axis: 'x' })).toEqual({ amount: 0.5, scale: 1, axis: 'x' })
    expect(explodeArg('0.5')).toBeNull()
  })
})

it('says it in words, and whether anything is apart', () => {
  expect(explodeText({ amount: 0.4, scale: 1, axis: 'centre' })).toBe('exploded 40 % from the centre')
  expect(explodeText({ amount: 1, scale: 2, axis: 'z' })).toBe('exploded 100 % along z, ×2')
  expect(isExploded({ amount: 0, scale: 2, axis: 'z' })).toBe(false)
  expect(isExploded(null)).toBe(false)
  expect(isExploded({ amount: 0.01, scale: 1, axis: 'centre' })).toBe(true)
  expect(EXPLODED_NOTE).toContain('as assembled')
})

describe('what is drawn apart: one rule, for the screen, a picture, the file and the exported page', () => {
  const ring = { name: 'ring', bbox: { min: [-20, -20, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] } }
  const shaft = { name: 'shaft', bbox: { min: [-3, -3, -15] as [number, number, number], max: [3, 3, 25] as [number, number, number] } }
  const HALF = { amount: 0.5, scale: 1, axis: 'centre' } as const
  const CUT = { origin: [0, 0, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }

  it('parts that share a centre do not move from it: nothing is apart, and nothing says it is', () => {
    expect(explodeOffsets([ring, shaft], { amount: 1, scale: 1, axis: 'centre' })).toEqual({})
    expect(explodeShown(HALF, null, [ring, shaft])).toBeNull()
    expect(nothingApart(HALF, [ring, shaft])).toBe('shared centre')
    // Along an axis they part, ranked.
    expect(explodeShown({ ...HALF, axis: 'z' }, null, [ring, shaft])).toEqual({ ...HALF, axis: 'z' })
    expect(nothingApart({ ...HALF, axis: 'z' }, [ring, shaft])).toBeNull()
  })

  it('a centre within a hundredth of a millimetre of the layout\'s is the layout\'s: no part jumps along what modelling left', () => {
    const off = (by: number) => ({ name: 'shaft', bbox: { min: [-3, -3, -15 + by] as [number, number, number], max: [3, 3, 25 + by] as [number, number, number] } })
    expect(explodeOffsets([ring, off(0.0001)], { amount: 1, scale: 1, axis: 'centre' })).toEqual({})
    expect(explodeOffsets([ring, off(0.009)], { amount: 1, scale: 1, axis: 'centre' })).toEqual({})
    // Further, it goes: the ring's centre is then 0.05 mm from the layout's, which is the shaft's.
    const moved = explodeOffsets([ring, off(0.05)], { amount: 1, scale: 1, axis: 'centre' })
    expect(Math.abs(moved.ring[2])).toBeGreaterThan(10)
    expect(moved.shaft).toEqual([0, 0, 0])
  })

  it('is nothing with a section, with fewer than two parts, and of an explode of nothing', () => {
    expect(explodeShown(HALF, null, [tray, lid])).toEqual(HALF)
    expect(explodeShown(HALF, CUT, [tray, lid])).toBeNull()
    expect(explodeShown(HALF, null, [tray])).toBeNull()
    expect(explodeShown(HALF, null, [])).toBeNull()
    expect(explodeShown({ ...HALF, amount: 0 }, null, [tray, lid])).toBeNull()
    expect(explodeShown(null, null, [tray, lid])).toBeNull()
    expect(explodeShown(undefined, null, [tray, lid])).toBeNull()
    expect([nothingApart(HALF, [tray]), nothingApart(HALF, []), nothingApart(HALF, [tray, lid])]).toEqual(['one part', 'one part', null])
  })

  it('says to the agent why nothing can be drawn apart in a layout, and what would be', () => {
    expect(nothingApartText('one part', 'print')).toBe('nothing can be drawn apart in layout print: it has fewer than two parts (explode: null draws it as it is)')
    expect(nothingApartText('shared centre', 'assembly')).toBe('nothing is drawn apart from the centre in layout assembly: its parts share a centre; give an axis, {"amount": 0.5, "axis": "z"}')
  })
})

describe('neverBoth', () => {
  const apart = { amount: 0.4, scale: 2, axis: 'z' as const }
  const plane = { origin: [0, 0, 1], normal: [0, 0, 1] }
  it('puts the parts together when a section is set, and keeps how they would go apart', async () => {
    const { neverBoth } = await import('./explode')
    expect(neverBoth(apart, plane, 'section')).toEqual({ explode: { amount: 0, scale: 2, axis: 'z' }, section: plane })
  })
  it('takes the section away when the parts are drawn apart', async () => {
    const { neverBoth } = await import('./explode')
    expect(neverBoth(apart, plane, 'explode')).toEqual({ explode: apart, section: null })
  })
  it('leaves alone what is not both', async () => {
    const { neverBoth } = await import('./explode')
    expect(neverBoth(apart, null, 'section')).toEqual({ explode: apart, section: null })
    expect(neverBoth({ ...apart, amount: 0 }, plane, 'explode')).toEqual({ explode: { ...apart, amount: 0 }, section: plane })
    expect(neverBoth(undefined, plane, 'section')).toEqual({ explode: null, section: plane })
  })
})

describe('explodeOffsets of parts named like what every object has', () => {
  it('moves each, and answers for no name it was not given', async () => {
    const { explodeOffsets } = await import('./explode')
    const box = (z: number) => ({ min: [0, 0, z] as [number, number, number], max: [10, 10, z + 2] as [number, number, number] })
    const offsets = explodeOffsets([{ name: '__proto__', bbox: box(0) }, { name: 'constructor', bbox: box(10) }, { name: 'toString', bbox: box(20) }], { amount: 1, scale: 1, axis: 'z' })
    expect(Object.keys(offsets).sort()).toEqual(['__proto__', 'constructor', 'toString'])
    expect(offsets.constructor).toEqual([0, 0, 0])
    expect(offsets['__proto__'][2]).toBeLessThan(0)
    expect(offsets.hasOwnProperty).toBeUndefined()
    expect(offsets.valueOf).toBeUndefined()
    // Nor when nothing is apart: there is then no part it answers for, whatever the part is called.
    expect(explodeOffsets([{ name: 'constructor', bbox: box(0) }, { name: 'lid', bbox: box(10) }], null).constructor).toBeUndefined()
    expect(explodeOffsets([{ name: 'constructor', bbox: box(0) }, { name: 'toString', bbox: box(0) }], { amount: 1, scale: 1, axis: 'centre' }).toString).toBeUndefined()
  })
})

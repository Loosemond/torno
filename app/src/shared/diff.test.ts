import { describe, expect, it } from 'vitest'
import { landing, landingText, partChanged, partDiff, sceneDiff } from './diff'
import type { Part, Scene } from './scene'

/** A sound, exact part of one solid: 40 × 30 × 6 mm, 6000 mm³, 12 faces. */
const part = (name: string, more: Partial<Part> = {}, layout = 'assembly'): Part =>
  ({ key: `${layout}:${name}`, name, layout, loc: { t: [0, 0, 0], q: [0, 0, 0, 1] }, hash: `h-${name}`, bbox: { min: [-20, -15, -3], max: [20, 15, 3] }, bboxExact: true, volume: 6000, volumeExact: true, faceCount: 12, edgeCount: 30, valid: true, solids: 1, ...more }) as Part
const scene = (parts: Part[], layouts = ['assembly']): Scene => ({ model: 'box.py', layouts, parts, seconds: 1, output: '' })

describe('partDiff', () => {
  it('says a changed volume and size in the words of diff, and calls a number that is not exact approximate', () => {
    const told = partDiff(part('tub'), part('tub', { volume: 6130, bbox: { min: [-20, -15, -3], max: [20, 15, 5] } }))
    expect(told.data.line).toBe('tub: volume 6000 → 6130 mm³ (+130, +2.2 %), size 40 × 30 × 6 → 40 × 30 × 8 mm')
    expect(told.approximate).toBe(false)
    const rough = partDiff(part('tub', { volumeExact: false }), part('tub', { volume: 6130, volumeExact: false }))
    expect(rough.data.line).toBe('tub: volume ≈ 6000 → 6130 mm³ (+130, +2.2 %)')
    expect(rough.approximate).toBe(true)
  })

  it('says nothing changed of two parts alike', () => {
    expect(partDiff(part('tub'), part('tub')).data).toMatchObject({ changed: false, line: 'tub: unchanged' })
  })
})

describe('whether a part is drawn other than it was', () => {
  it('is so for another mesh, and for a part that stands elsewhere or turned', () => {
    expect(partChanged(part('tub'), part('tub'))).toBe(false)
    expect(partChanged(part('tub'), part('tub', { hash: 'other' }))).toBe(true)
    expect(partChanged(part('tub'), part('tub', { loc: { t: [0, 0, 2], q: [0, 0, 0, 1] } }))).toBe(true)
    expect(partChanged(part('tub'), part('tub', { loc: { t: [0, 0, 0], q: [0, 0, 1, 0] } }))).toBe(true)
  })
})

describe('what a landing build did to the parts', () => {
  const before = scene([part('tub'), part('lid'), part('cap')])

  it('names the parts that changed and those that did not, and tells the changed one in the words of diff', () => {
    const after = scene([part('tub', { hash: 'h2', volume: 6130 }), part('lid'), part('cap')])
    const told = landing(before, after, 'assembly')
    expect(told).toMatchObject({ changed: ['tub'], same: ['lid', 'cap'], added: [], removed: [] })
    expect(told.lines).toEqual(['tub: volume 6000 → 6130 mm³ (+130, +2.2 %)'])
    expect(landingText(told)).toBe('tub changed, lid, cap same')
  })

  it('counts the parts that did not change once there are more than two, and the ones that changed past three', () => {
    const many = scene(['a', 'b', 'c', 'd', 'e'].map((n) => part(n)))
    const after = scene(['a', 'b', 'c', 'd', 'e'].map((n) => part(n, n === 'e' ? {} : { hash: `${n}2` })))
    expect(landingText(landing(many, after, 'assembly'))).toBe('4 parts changed, e same')
    const one = scene(['a', 'b', 'c', 'd', 'e'].map((n) => part(n, n === 'a' ? { hash: 'a2' } : {})))
    expect(landingText(landing(many, one, 'assembly'))).toBe('a changed, 4 same')
  })

  it('says when a part came or went, and when no part changed', () => {
    const after = scene([part('tub'), part('lid'), part('plate')])
    const told = landing(before, after, 'assembly')
    expect(told).toMatchObject({ changed: [], added: ['plate'], removed: ['cap'] })
    expect(told.lines).toEqual(['plate: new', 'cap: gone'])
    expect(landingText(told)).toBe('plate new, cap gone, tub, lid same')
    expect(landingText(landing(before, before, 'assembly'))).toBe('no part changed')
  })

  it('tells a part drawn otherwise whose numbers did not move so, rather than "unchanged"', () => {
    const after = scene([part('tub', { hash: 'h2' }), part('lid'), part('cap')])
    expect(landing(before, after, 'assembly').lines).toEqual(['tub: drawn otherwise, no number moved'])
  })

  it('looks at the layout it is given only', () => {
    const two = scene([part('tub'), part('tub', {}, 'print')], ['assembly', 'print'])
    const moved = scene([part('tub'), part('tub', { hash: 'x' }, 'print')], ['assembly', 'print'])
    expect(landing(two, moved, 'assembly').changed).toEqual([])
    expect(landing(two, moved, 'print').changed).toEqual(['tub'])
  })
})

describe('sceneDiff', () => {
  it('walks each layout, with the parts only one of the scenes has, and the notes that go with the numbers', () => {
    const from = scene([part('tub'), part('cap')])
    const to = scene([part('tub', { volume: 6100, volumeExact: false }), part('lid')])
    const told = sceneDiff(from, to)
    expect(told.layouts).toHaveLength(1)
    expect(told.layouts[0]).toMatchObject({ layout: 'assembly', added: ['lid'], removed: ['cap'] })
    expect(told.layouts[0].parts.map((p) => p.name)).toEqual(['tub'])
    expect(told.notes).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import { assumedKey, assumedLine, sourceCount, sourceOf } from './params'
import type { Param } from './scene'

const p = (name: string, def: unknown, doc: string | null): Param => ({ name, type: 'float', default: def, literal: true, doc })

describe('sourceOf', () => {
  it.each([
    ['brief: the box is 60 wide', 'brief'],
    ['M3: the pin on the rim', 'mark'],
    ['S2 ≈: the scan, to a few mm', 'scan'],
    ['ref photo.jpg: the note says 12', 'ref'],
    ['datasheet ESP32-S3 DevKitC-1 v1.1: board width', 'datasheet'],
    ['person: "0.2 per side"', 'person'],
    ['derived: half the width', 'derived'],
    ['assumed: 5 perimeters at 0.4 mm', 'assumed'],
    ['Assumed: capital', 'assumed'],
    ['object: the base', 'object']
  ])('%s is %s', (doc, source) => expect(sourceOf(doc)).toBe(source))
  it('is unsaid for no comment, no colon, or an unknown word', () => {
    expect(sourceOf(null)).toBe('unsaid')
    expect(sourceOf('')).toBe('unsaid')
    expect(sourceOf('wall of the tub')).toBe('unsaid')
    expect(sourceOf('guess: maybe')).toBe('unsaid')
  })
})

describe('assumedLine', () => {
  const params = [p('wall', 2, 'assumed: x'), p('lip', 3, 'assumed: y'), p('w', 60, 'brief: z'), p('a', 1, null), p('name', 'x', null), p('flag', true, null)]
  it('counts only sizes', () => {
    expect(sourceCount(params).sizes).toBe(4)
    expect(assumedLine(params)).toBe('Assumed: wall 2, lip 3 (2 of 4 sizes); no source: 1')
  })
  it('says nothing when all have a source', () => expect(assumedLine([p('w', 60, 'brief: z')])).toBe(''))
  it('says only the unsaid when none is assumed', () => expect(assumedLine([p('w', 60, 'brief: z'), p('a', 1, null)])).toBe('No source: 1 of 2 sizes'))
  it('keys change with the set', () => {
    expect(assumedKey(params)).toBe(assumedKey([...params]))
    expect(assumedKey(params)).not.toBe(assumedKey(params.slice(1)))
  })
})

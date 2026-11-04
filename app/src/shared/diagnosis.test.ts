import { describe, expect, it } from 'vitest'
import { flushCut, probe } from '../test/diagnosisFixtures'
import { type BooleanDiagnosis, type FilletDiagnosis, diagnosisText, sizeText } from './diagnosis'

describe('diagnosisText', () => {
  it('says the probe as the issue does: each alone works, the pairs, the radius bisected', () => {
    const text = diagnosisText(probe())
    expect(text.split('\n')[0]).toBe(
      'Why: fillet R6 of 8 edges: each works alone; 4 pairs of adjacent edges fail (edges 4-5, 4-6, 5-7, 6-7: 12 mm apart, two R6 need more); the 8 together work up to R5.999 (fail at R6, bisected to 0.001 mm).'
    )
    expect(text).toContain('Edges (local: numbered by their place in the fillet call, from 0; ends in the frame of the shape filleted):')
    expect(text).toContain('4: line, 5 mm, along Z, between 2 planes, (-6, -6, -2.5) to (-6, -6, 2.5)')
  })

  it('names an edge by a ref of the last good build only where main found it there exactly, as of that build', () => {
    const told = probe()
    told.edges[0] = { ...told.edges[0]!, sameAs: { ref: 'plate/E12', layout: 'main', revision: 3 } }
    const text = diagnosisText(told)
    expect(text).toContain('4: line, 5 mm, along Z, between 2 planes, (-6, -6, -2.5) to (-6, -6, 2.5), which is plate/E12 of r3 (layout main)')
    expect(text).not.toContain('5: line, 5 mm, along Z, between 2 planes, (-6, 6, -2.5) to (-6, 6, 2.5), which')
  })

  it('says the edges that fail alone, with their own largest radius and their shortest neighbour', () => {
    const told: FilletDiagnosis = {
      ...probe(),
      size: 3,
      edgeCount: 4,
      alone: { tried: 4, failing: [0, 1] },
      pairs: undefined,
      together: { worksUpTo: 1.999, failsAt: 2 },
      edges: [
        { index: 0, type: 'line', length: 20, lengthExact: true, start: [-10, -10, 1], end: [-10, 10, 1], along: 'Y', between: ['plane', 'plane'], worksUpTo: 1.999, failsAt: 2, shortestNeighbour: 2 },
        { index: 1, type: 'circle', radius: 4, length: 25.13, lengthExact: true, between: ['plane', 'cylinder'], worksUpTo: null, failsAt: 0.001 }
      ]
    }
    const text = diagnosisText(told)
    expect(text.split('\n')[0]).toBe('Why: fillet R3 of 4 edges: 2 fail alone (edges 0, 1); the 4 together work up to R1.999 (fail at R2, bisected to 0.001 mm).')
    expect(text).toContain('0: line, 20 mm, along Y, between 2 planes, (-10, -10, 1) to (-10, 10, 1); alone up to R1.999; its shortest neighbour is 2 mm')
    expect(text).toContain('1: circle, radius 4, 25.13 mm, between a plane and a cylinder; alone, none down to R0.001')
  })

  it('says a chamfer by its lengths, and what none of the pairs explains', () => {
    const told: FilletDiagnosis = { ...probe(), operation: 'chamfer', size: 4, size2: 1, pairs: { tried: 28, planned: 28, failing: [] }, together: { worksUpTo: null, failsAt: 0.001 }, edges: [] }
    expect(diagnosisText(told)).toBe(
      'Why: chamfer 4 × 1 mm of 8 edges: each works alone; no pair fails (28 tried): only all 8 together; the 8 together work at no size down to 0.001 mm.'
    )
    expect(sizeText('chamfer', 2)).toBe('2 mm')
  })

  it('says when it was cut short, and what it had no time for', () => {
    const told: FilletDiagnosis = { ...probe(), alone: { tried: 3, failing: [] }, pairs: undefined, together: undefined, edges: [], complete: false }
    expect(diagnosisText(told)).toBe(
      'Why: fillet R6 of 8 edges: no edge of the 3 tried fails alone. Cut short at 5 s: 5 edges were not tried alone, and the largest radius that works was not looked for.'
    )
    const unfinished: FilletDiagnosis = { ...probe(), together: { worksUpTo: 4.5, failsAt: 6, complete: false }, complete: false }
    expect(diagnosisText(unfinished).split('\n')[0]).toContain('the 8 together work at R4.5 at least (fail at R6). Cut short at 5 s: the bisection did not end.')
  })

  it('keeps to its limit, the edges cut first and counted', () => {
    const text = diagnosisText(probe(), 400)
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text).toMatch(/and \d+ more edges/)
    expect(text.startsWith('Why: fillet R6 of 8 edges')).toBe(true)
  })

  it('names edges by their refs in a trial, in the frame of the object', () => {
    const told: FilletDiagnosis = {
      ...probe(),
      frame: 'object',
      pairs: { tried: 8, planned: 8, failing: [{ edges: ['plate/E4', 'plate/E9'], adjacent: true, apart: 4, apartExact: true }] },
      edges: [{ ref: 'plate/E4', type: 'line', length: 20, lengthExact: true, start: [0, 0, 5], end: [20, 0, 5], along: 'X', between: ['plane', 'plane'] }]
    }
    const text = diagnosisText(told)
    expect(text).toContain('1 pair of adjacent edges fails (plate/E4-plate/E9: 4 mm apart, two R6 need more)')
    expect(text).toContain('Edges (in the frame of the project):\nplate/E4: line, 20 mm, along X')
  })
})

describe('diagnosisText of a boolean', () => {
  it('says a tool that ends flush with the face it cuts, and the faces', () => {
    const text = diagnosisText(flushCut())
    expect(text.split('\n')[0]).toBe(
      'Why: cut failed: face F5 of tool lies on face F5 of base, facing the same way, over 16 mm²: a tool that ends flush with the face it cuts, not past it.'
    )
    expect(text).toContain('Operands (local: faces numbered by their place in the operand, from 0; in the frame of the operand):')
    expect(text).toContain('tool: solid, valid, 6 faces, box (-2, -2, 0) to (2, 2, 5)')
    expect(text).toContain('base F5 and tool F5: plane, facing the same way, at z = 5, 16 mm² shared')
  })

  it('says an operand that is not a solid, is empty or is not valid', () => {
    const operand = (name: string, type: string, extra: object = {}) => ({ name, type, ...extra })
    const told = (operands: BooleanDiagnosis['operands'], causes: BooleanDiagnosis['causes']): BooleanDiagnosis => ({ ...flushCut(), operands, pairs: [], causes })
    expect(diagnosisText(told([operand('base', 'solid', { solids: 1, valid: true }), operand('tool', 'face', { solids: 0, valid: true })], ['not-solid'])).split('\n')[0]).toBe(
      'Why: cut failed: tool is a face, not a solid (a boolean needs solids).'
    )
    expect(diagnosisText(told([operand('tool', 'empty')], ['empty-operand'])).split('\n')[0]).toBe('Why: cut failed: tool is empty.')
    expect(diagnosisText(told([operand('tool', 'solid', { solids: 1, valid: false, faults: ['crosses itself'] })], ['invalid-operand'])).split('\n')[0]).toBe(
      'Why: cut failed: tool is not a valid solid (it crosses itself).'
    )
  })

  it('says shapes that do not meet, and ones that only touch', () => {
    const apart: BooleanDiagnosis = { ...flushCut(), pairs: [{ base: 'base', tool: 'tool', apart: 20, apartExact: false, touching: false }], causes: ['apart'] }
    expect(diagnosisText(apart).split('\n')[0]).toBe('Why: cut failed: tool is ≈ 20 mm from base: they do not meet.')
    const touch: BooleanDiagnosis = { ...flushCut(), pairs: [{ ...flushCut().pairs[0]!, coincident: [], inside: { tool: 0, base: 0, sampledOnTool: 20, sampledOnBase: 20 } }], causes: ['touching'] }
    expect(diagnosisText(touch).split('\n')[0]).toContain('tool and base touch, and no point sampled on either lies inside the other')
  })

  it('says when it found no cause, and when it was cut short', () => {
    const none: BooleanDiagnosis = { ...flushCut(), pairs: [], causes: [], complete: false }
    expect(diagnosisText(none)).toMatch(/^Why: cut failed: no cause was found in its operands\. Cut short at 5 s: only what was found in time is told\./)
  })

  it('keeps to its limit, the lines cut from the end and counted', () => {
    const text = diagnosisText(flushCut(), 330)
    expect(text.length).toBeLessThanOrEqual(330)
    expect(text).toMatch(/and \d+ more lines?$/)
  })
})

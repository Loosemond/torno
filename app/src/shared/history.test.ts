import { describe, expect, it } from 'vitest'
import { FIRST_BUILD, HISTORY_ID, changeLine, sceneFacts } from './history'
import type { Part, Scene } from './scene'

const part = (name: string, volume: number, layout = 'assembly'): Part => ({ key: `${layout}:${name}`, name, layout, loc: { t: [0, 0, 0], q: [0, 0, 0, 1] }, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, volume, faceCount: 6, edgeCount: 12, triangleCount: 12, valid: true, hash: `${name}${volume}`, mesh: {} as Part['mesh'] }) as Part
const scene = (parts: Part[], extra: Partial<Scene> = {}): Scene => ({ model: 'm.py', layouts: [...new Set(parts.map((p) => p.layout))], parts, seconds: 1, output: '', ...extra })

describe('history ids', () => {
  it('are h and a number from 1', () => {
    expect(['h1', 'h41', 'h123456789'].every((id) => HISTORY_ID.test(id))).toBe(true)
    expect(['h0', 'h', 'r3', 'h01', '../h1', 'h1/x', 'h1234567890'].some((id) => HISTORY_ID.test(id))).toBe(false)
  })
})

describe('changeLine', () => {
  it('says the first build, no change, and which parts changed, as the status line does', () => {
    const a = scene([part('tub', 10), part('lid', 5)])
    expect(changeLine(undefined, a)).toBe(FIRST_BUILD)
    expect(changeLine(a, scene([part('tub', 10), part('lid', 5)]))).toBe('no part changed')
    expect(changeLine(a, scene([part('tub', 12), part('lid', 5)]))).toBe('tub changed, lid same')
  })

  it('names the layout when there are several, and one that is gone', () => {
    const a = scene([part('tub', 10), part('tub', 10, 'print')])
    const b = scene([part('tub', 12), part('tub', 10, 'print')])
    expect(changeLine(a, b)).toBe('assembly: tub changed')
    expect(changeLine(scene([part('tub', 10), part('x', 1, 'print')]), scene([part('tub', 10)]))).toBe('print gone')
  })
})

describe('sceneFacts', () => {
  it('takes the params, the failing checks and the defects of the shape', () => {
    const bad = part('tub', 10)
    bad.valid = false
    const facts = sceneFacts(scene([bad, part('lid', 5)], { seconds: 2, params: [{ name: 'wall', type: 'float', default: 2, literal: true, doc: null }], checks: [{ name: 'a', kind: 'thin', status: 'pass' }, { name: 'b', kind: 'bed', status: 'error' }] }))
    expect(facts).toEqual({ parts: 2, seconds: 2, params: { wall: 2 }, failing: ['b'], defects: ['tub: not valid'] })
    expect(sceneFacts(scene([part('lid', 5)]))).toEqual({ parts: 1, seconds: 1 })
  })
})

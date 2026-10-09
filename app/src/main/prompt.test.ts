import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from './prompt'

describe('the system prompt', () => {
  it('says what each thing means that a prompt may say of a mark, and what its other lines are', () => {
    // As `contextFor` and `describeMark` write them.
    for (const said of ['(changed)', 'reopened by the user', '[not checked against rN]', '"Selected:"', '"Marks still open"']) expect(SYSTEM_PROMPT).toContain(said)
  })

  it('says of a mark told as changed that it may have been moved: one put somewhere else is told so too', () => {
    expect(SYSTEM_PROMPT).toContain('(changed) is of a mark you were given before that the user has since changed or moved')
  })

  it('tells it to resolve the marks it acted on, but never a dimension of the user’s with an expected value', () => {
    expect(SYSTEM_PROMPT).toContain('When you have acted on a mark and checked the result, call mcp__torno__resolve_mark with a line on what you did, except for a dimension of the user’s that has an expected value: that is their check, it passes by itself and keeps being measured, and only they resolve it (a resolved dimension is no longer measured).')
  })

  it('names dimensions among the marks, and gives one example call each of the tools that read the part, as JSON that parses', () => {
    expect(SYSTEM_PROMPT).toContain('placed shapes and dimensions, numbered')
    const calls = [...SYSTEM_PROMPT.matchAll(/mcp__torno__(measure|check|section|add_mark) (\{.*?\})(?= is | returns | leaves | the wall|,? and )/g)].map((m) => [m[1], JSON.parse(m[2])])
    expect(calls).toEqual([
      ['measure', { kind: 'distance', a: 'plate/F2', b: 'plate/F4' }],
      ['check', { kind: 'clearance', a: 'lid', b: 'tub' }],
      ['section', { plane: { axis: 'x', at: 12 } }],
      ['add_mark', { kind: 'dimension', note: 'wall', measure: 'distance', a: 'plate/F2', b: 'plate/F4', expected: 8, tolerance: 0.1 }]
    ])
    expect(JSON.parse(SYSTEM_PROMPT.match(/and (\{"kind": "thickness".*?\}\}) the wall/)![1])).toEqual({ kind: 'thickness', a: { ref: 'plate/F2', point: [10, 5, 6] } })
  })

  it('says what approximate looks like, what is refused between parts torno spread and what to do, which build the dimensions listed are of, and how to read them again', () => {
    for (const said of ['≈, "approximate" or "exact": false marks one that is not', 'are refused: ask in a layout that places them as assembled, and if the model has none, add one (def assembly(p))', '"Dimensions (measured on rN):"', 'once scene says the build is ok, read them again with mcp__torno__marks']) expect(SYSTEM_PROMPT).toContain(said)
  })

  it('says what a scan is, gives one example call each of the tools that ask about one, as JSON that parses, and what fit against one needs', () => {
    for (const named of ['mcp__torno__scans', 'mcp__torno__scan_clash', 'mcp__torno__scan_deviation']) expect(SYSTEM_PROMPT).toContain(named)
    for (const said of ['a mesh of the real thing', 'nothing taken from it is exact', 'in the frame of the layout once the user has aligned it there', 'def assembly(p)', 'no script that loads the scan', 'is said first in the reading']) expect(SYSTEM_PROMPT).toContain(said)
    const calls = [...SYSTEM_PROMPT.matchAll(/mcp__torno__(scan_clash|scan_deviation) (\{[^}]*\})(?= says | how far )/g)].map((m) => [m[1], JSON.parse(m[2])])
    expect(calls).toEqual([
      ['scan_clash', { part: 'tub' }],
      ['scan_deviation', { part: 'plate', faces: ['plate/F5'] }]
    ])
    expect(JSON.parse(SYSTEM_PROMPT.match(/measure takes (\{"scan".*?\}) as an end of a distance/)![1])).toEqual({ scan: 'S1', point: [10, 5, 6] })
    expect(SYSTEM_PROMPT).toContain('fit against the surroundings needs a layout that places the parts as mounted')
  })

  it('stays short', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThan(6500)
  })
})

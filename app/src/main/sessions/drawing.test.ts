import { describe, expect, it } from 'vitest'
import { MOST_CUTS_TOLD, MOST_REFS_TOLD, MOST_STROKES_TOLD, type ViewDrawing } from '../../shared/drawing'
import { png } from '../../test/pngFixtures'
import { drawingOf, drawingText } from './drawing'

const camera = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const given = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  objectId: 'bracket', revision: 3, layout: 'assembly', caption: 'view current · layout assembly · parts base · perspective · 64×48',
  camera, png: new Uint8Array(png(64, 48)), width: 64, height: 48, ink: '#B5127A',
  under: [{ box: [10, 12, 40, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], cuts: [], scans: [], bare: true }],
  ...over
})
const ok = (over: Record<string, unknown> = {}): ViewDrawing => {
  const d = drawingOf(given(over))
  if (typeof d === 'string') throw new Error(d)
  return d
}

describe('drawingOf', () => {
  it('takes a whole drawing, and only what a drawing has', () => {
    const d = ok({ extra: 'dropped' })
    expect(d).toMatchObject({ objectId: 'bracket', revision: 3, layout: 'assembly', width: 64, height: 48, ink: '#B5127A' })
    expect(Object.keys(d).sort()).toEqual(['camera', 'caption', 'height', 'ink', 'layout', 'objectId', 'png', 'revision', 'under', 'width'])
    expect(d.under).toEqual([{ box: [10, 12, 40, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], cuts: [], scans: [], bare: true }])
  })
  it('folds the caption and a descriptor to one line, and cuts a long descriptor', () => {
    const d = ok({ caption: 'view current\n· layout assembly', under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/F1', descriptor: `plane\n${'x'.repeat(300)}` }], cuts: [], scans: [], bare: false }] })
    expect(d.caption).toBe('view current · layout assembly')
    expect(d.under![0].refs[0].descriptor).toHaveLength(200)
    expect(d.under![0].refs[0].descriptor).not.toContain('\n')
  })
  it('takes a face as the window names it: from F0, of a part of any name on one line', () => {
    const d = ok({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/F0' }, { ref: 'lid part/F7' }], cuts: [], scans: [], bare: false }] })
    expect(d.under![0].refs).toEqual([{ ref: 'base/F0' }, { ref: 'lid part/F7' }])
  })
  it('takes the parts whose cut face a stroke lies over', () => {
    expect(ok({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: ['lid', 'base part'], scans: [], bare: false }] }).under![0].cuts).toEqual(['lid', 'base part'])
  })
  it('takes a drawing whose ink could not be looked under, and the count of strokes not told', () => {
    expect(ok({ under: null }).under).toBeNull()
    expect(ok({ moreStrokes: 3 }).moreStrokes).toBe(3)
  })
  it.each([
    ['not an object', null],
    ['no object', given({ objectId: '' })],
    ['no build', given({ revision: 0 })],
    ['a build that is no count', given({ revision: 1.5 })],
    ['a camera that looks nowhere', given({ camera: { ...camera, target: camera.position } })],
    ['a camera with no projection', given({ camera: { ...camera, ortho: 'no' } })],
    ['a camera beyond reach', given({ camera: { ...camera, position: [1e10, 0, 0] } })],
    ['a picture that is no PNG', given({ png: new Uint8Array([1, 2, 3]) })],
    ['a picture of another size than it says', given({ width: 65 })],
    ['an ink that is no colour', given({ ink: 'red' })],
    ['strokes that are no list', given({ under: 'all of it' })],
    ['too many strokes', given({ under: Array.from({ length: MOST_STROKES_TOLD + 1 }, () => ({ box: [0, 0, 1, 1], refs: [], cuts: [], scans: [], bare: true })) })],
    ['a stroke outside the picture', given({ under: [{ box: [0, 0, 65, 1], refs: [], cuts: [], scans: [], bare: true }] })],
    ['an edge where a face is said', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/E3' }], cuts: [], scans: [], bare: false }] })],
    ['a mark where a face is said', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'M3' }], cuts: [], scans: [], bare: false }] })],
    ['a face of a part named on two lines', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base\nlid/F1' }], cuts: [], scans: [], bare: false }] })],
    ['a face of a part named across a line separator', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base\u2028lid/F1' }], cuts: [], scans: [], bare: false }] })],
    ['a face numbered from a nought', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/F01' }], cuts: [], scans: [], bare: false }] })],
    ['too many faces', given({ under: [{ box: [0, 0, 1, 1], refs: Array.from({ length: MOST_REFS_TOLD + 1 }, (_, i) => ({ ref: `base/F${i + 1}` })), cuts: [], scans: [], bare: false }] })],
    ['a scan that is no scan', given({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: [], scans: ['scan one'], bare: false }] })],
    ['a stroke over something it does not name', given({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: [], scans: [], bare: false }] })],
    ['cut faces that are no list', given({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: 'lid', scans: [], bare: true }] })],
    ['a cut face of a part named on two lines', given({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: ['lid\nbase'], scans: [], bare: false }] })],
    ['too many cut faces', given({ under: [{ box: [0, 0, 1, 1], refs: [], cuts: Array.from({ length: MOST_CUTS_TOLD + 1 }, (_, i) => `p${i}`), scans: [], bare: false }] })],
    ['a count of strokes that is no count', given({ moreStrokes: -1 })]
  ])('refuses %s, saying it could not be sent', (_what, value) => {
    const d = drawingOf(value)
    expect(typeof d).toBe('string')
    expect(d).toMatch(/^The drawing on the view could not be sent: /)
  })
})

describe('drawingText', () => {
  const toolName = (tool: string): string => `mcp__torno__${tool}`
  it('says what the picture is, whose the ink is and its colour, where it was seen from and how to see it again', () => {
    const text = drawingText(ok(), { revision: 3, toolName })
    expect(text).toMatch(/^Picture: the view as the person saw it when they drew on it, on r3 \(view current · layout assembly/)
    expect(text).toContain('The strokes in magenta (#B5127A)')
    expect(text).toContain('not the model, and not marks')
    expect(text).toContain(`It was seen from ${JSON.stringify(camera)}: mcp__torno__look with that as its view draws it again.`)
    expect(text).not.toContain('built again')
  })
  it('says stroke by stroke what the ink lies over: faces with their lines, scans, and what is over no part', () => {
    const text = drawingText(ok({ under: [
      { box: [10.4, 12, 40.6, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], moreRefs: 2, cuts: [], scans: ['S1'], bare: true },
      { box: [0, 0, 5, 5], refs: [], cuts: [], scans: ['S1', 'S2'], bare: false },
      { box: [1, 2, 3, 4], refs: [], cuts: [], scans: [], bare: true }
    ], moreStrokes: 1 }), { revision: 3, toolName })
    expect(text).toContain('Under the ink, stroke by stroke (x and y are pixels of the 64×48 picture; faces are of r3):')
    expect(text).toContain('- stroke 1, x 10–41, y 12–30: base/F12 (plane, normal +Z, z = 20), base/F3, and 2 more faces; scan S1 where no part is; partly over no part')
    expect(text).toContain('- stroke 2, x 0–5, y 0–5: over no part: scan S1, S2')
    expect(text).toContain('- stroke 3, x 1–3, y 2–4: over no part')
    expect(text).toContain('(1 more stroke, not told)')
  })
  it('says a cut face as the cut face of its part, beside the faces', () => {
    const text = drawingText(ok({ under: [
      { box: [0, 0, 5, 5], refs: [{ ref: 'base/F2' }], cuts: ['lid'], scans: [], bare: false },
      { box: [0, 0, 5, 5], refs: [], cuts: ['lid', 'base'], scans: ['S1'], bare: true }
    ] }), { revision: 3, toolName })
    expect(text).toContain('- stroke 1, x 0–5, y 0–5: base/F2, the cut face of lid')
    expect(text).toContain('- stroke 2, x 0–5, y 0–5: the cut face of lid, the cut face of base; scan S1 where no part is; partly over no part')
  })
  it('says when the model was built again since it was drawn: the refs are of the build it was drawn on', () => {
    expect(drawingText(ok(), { revision: 5, toolName })).toContain('The model has been built again since: r5 is the latest, and the faces below are of r3: they may name other faces now.')
  })
  it('says when what the ink lies over was not worked out, and when no ink is left', () => {
    expect(drawingText(ok({ under: null }), { revision: 3, toolName })).toContain('What the ink lies over was not worked out: the view on screen changed while it was drawn.')
    expect(drawingText(ok({ under: [] }), { revision: 3, toolName })).toContain('No ink is left on the picture.')
  })
  it('starts no line with a word the stand-in agent would take for a command', () => {
    for (const line of drawingText(ok({ under: null }), { revision: 5, toolName }).split('\n')) expect(line).not.toMatch(/^(say|tool|ask|slow|work|rate|images|garbage)\b/)
  })
})

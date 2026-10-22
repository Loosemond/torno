import { describe, expect, it } from 'vitest'
import type { Part, Scene } from '../shared/scene'
import { DIGEST_LIMIT, type Kept, digestText, hardDefects, partsUnchanged, sanity } from './sanity'

/** A sound, exact part of one solid: 40 × 30 × 6 mm, 6000 mm³, 12 faces. */
const part = (layout: string, name: string, more: Partial<Part> = {}): Part =>
  ({ key: `${layout}:${name}`, name, layout, bbox: { min: [-20, -15, -3], max: [20, 15, 3] }, bboxExact: true, volume: 6000, volumeExact: true, faceCount: 12, edgeCount: 30, valid: true, solids: 1, openShells: 0, meshVolume: 6000, ...more }) as Part
const scene = (parts: Part[], layouts = ['assembly']): Scene => ({ model: 'box.py', layouts, parts, seconds: 1, output: '' })
const kept = (revision: number, parts: Part[], layouts?: string[]): Kept => ({ revision, scene: scene(parts, layouts) })

const BEFORE = kept(7, [part('assembly', 'tub'), part('assembly', 'lid'), part('assembly', 'cap')])

describe('the digest of a build', () => {
  it('names a changed part in the words of diff, with the volume change in percent, and counts those unchanged', () => {
    const after = kept(8, [part('assembly', 'tub', { volume: 5520, bbox: { min: [-20, -15, -3], max: [20, 15, 5] }, faceCount: 14, edgeCount: 36 }), part('assembly', 'lid'), part('assembly', 'cap')])
    const digest = sanity(BEFORE, after)
    expect(digest).toMatchObject({ revision: 8, since: 7, changed: true, unchanged: 2 })
    expect(digest.parts.map((p) => p.text)).toEqual(['tub: volume 6000 → 5520 mm³ (-480, -8 %), size 40 × 30 × 6 → 40 × 30 × 8 mm, faces 12 → 14, edges 30 → 36'])
    expect(digest.parts[0]).toMatchObject({ name: 'tub', layout: 'assembly', volume: { before: 6000, after: 5520, change: -480, percent: -8, exact: true }, faces: { before: 12, after: 14 } })
    expect(digestText(digest)).toBe(
      [
        'Changed since r7: tub: volume 6000 → 5520 mm³ (-480, -8 %), size 40 × 30 × 6 → 40 × 30 × 8 mm, faces 12 → 14, edges 30 → 36; 2 parts unchanged.',
        'Check: the face or edge numbers of tub may name others now (describe refs again).'
      ].join('\n')
    )
  })

  it('says a sound build that changed nothing as that', () => {
    const digest = sanity(BEFORE, kept(8, BEFORE.scene.parts))
    expect(digest).toMatchObject({ changed: false, parts: [], unchanged: 3, flags: [] })
    expect(digestText(digest)).toBe(
      ["Changed since r7: no part's volume, size or faces (3 as they were).", 'Check: nothing found (every part valid, closed, not inside out, its mesh agreeing with its volume).'].join('\n')
    )
  })

  it('names a part added and one removed, in every layout or in some', () => {
    const before = kept(7, [part('assembly', 'tub'), part('assembly', 'cap'), part('print', 'tub'), part('print', 'cap')], ['assembly', 'print'])
    const after = kept(8, [part('assembly', 'tub'), part('assembly', 'clip'), part('print', 'tub'), part('print', 'clip'), part('print', 'cap')], ['assembly', 'print'])
    const digest = sanity(before, after)
    expect(digest.changed).toBe(true)
    expect(digest.flags.map((f) => [f.kind, f.text])).toEqual([
      ['added', 'clip is new'],
      ['removed', 'cap is gone from assembly']
    ])
    expect(digestText(digest)).toBe("Changed since r7: no part's volume, size or faces (2 as they were).\nCheck: clip is new; cap is gone from assembly.")
  })

  it('tells a part that is not valid, and holds it as a defect only when it is new', () => {
    const after = kept(8, [part('assembly', 'tub'), part('assembly', 'lid', { valid: false }), part('assembly', 'cap')])
    const digest = sanity(BEFORE, after)
    expect(digest.flags).toEqual([{ kind: 'invalid', part: 'lid', new: true, hard: true, text: "lid is not valid (OCC's check finds a defect)" }])
    expect(hardDefects(digest)).toHaveLength(1)
    const again = sanity({ revision: 8, scene: after.scene }, kept(9, after.scene.parts))
    expect(again.flags).toEqual([{ kind: 'invalid', part: 'lid', new: false, hard: false, text: "lid is not valid (OCC's check finds a defect), as on r8" }])
    expect(hardDefects(again)).toEqual([])
  })

  it('tells a part of two solids, and that it came apart when it was one', () => {
    const after = kept(8, [part('assembly', 'tub', { solids: 2 }), part('assembly', 'lid'), part('assembly', 'cap')])
    const digest = sanity(BEFORE, after)
    expect(digest.parts.map((p) => p.text)).toEqual(['tub: solids 1 → 2'])
    expect(digest.flags).toEqual([{ kind: 'solids', part: 'tub', new: true, hard: true, text: 'tub is 2 solids (was 1)' }])
    expect(digestText(digest)).toBe('Changed since r7: tub: solids 1 → 2; 2 parts unchanged.\nCheck: tub is 2 solids (was 1).')
    // Two as before, and one again: told, and held against nothing.
    expect(sanity({ revision: 8, scene: after.scene }, kept(9, after.scene.parts)).flags).toEqual([{ kind: 'solids', part: 'tub', new: false, hard: false, text: 'tub is 2 solids, as on r8' }])
    expect(hardDefects(sanity({ revision: 8, scene: after.scene }, BEFORE))).toEqual([])
    expect(sanity({ revision: 8, scene: after.scene }, BEFORE).flags.map((f) => f.text)).toEqual(['tub is 1 solid (was 2)'])
  })

  it('tells a part inside out by its solids', () => {
    const digest = sanity(BEFORE, kept(8, [part('assembly', 'tub', { reversed: [1], solids: 2 }), part('assembly', 'lid'), part('assembly', 'cap')]))
    expect(digest.flags.map((f) => [f.text, f.hard])).toEqual([
      ['tub has solid 1 inside out (its volume is a size only)', true],
      ['tub is 2 solids (was 1)', true]
    ])
  })

  it('tells an open shell, and a part with no solid, as no hard defect', () => {
    const digest = sanity(BEFORE, kept(8, [part('assembly', 'tub', { openShells: 1, solids: 0, volume: 0 }), part('assembly', 'lid'), part('assembly', 'cap')]))
    expect(digest.flags.filter((f) => f.kind !== 'solids').map((f) => [f.kind, f.text, f.hard])).toEqual([
      ['empty', 'tub has no solid', false],
      ['open', 'tub has an open shell (an edge only one face has)', false]
    ])
    expect(digest.flags.find((f) => f.kind === 'solids')).toMatchObject({ text: 'tub is 0 solids (was 1)', hard: false })
  })

  it('tells a mesh that disagrees with its volume, ≈ always, as a hard defect', () => {
    const digest = sanity(BEFORE, kept(8, [part('assembly', 'tub', { volume: 7065, meshVolume: 10323, meshDisagrees: true, volumeExact: false }), part('assembly', 'lid'), part('assembly', 'cap')]))
    expect(digest.flags.map((f) => [f.text, f.hard])).toEqual([['tub: its mesh encloses ≈ 10320 mm³ where its volume is ≈ 7065 mm³, so one of them is wrong', true]])
  })

  it('says ≈ of a volume either build does not say is exact', () => {
    const digest = sanity(BEFORE, kept(8, [part('assembly', 'tub', { volume: 5900, volumeExact: false }), part('assembly', 'lid'), part('assembly', 'cap')]))
    expect(digest.parts[0].text).toBe('tub: volume ≈ 6000 → 5900 mm³ (-100, -1.7 %)')
    expect(digest.parts[0].volume.exact).toBe(false)
  })

  it('holds a number that is not exact to the doubt the kernel says it has: an untouched freeform part is unchanged', () => {
    const horn = (more: Partial<Part>): Part => part('assembly', 'horn', { volumeExact: false, bboxExact: false, volumeDoubt: 0.4, bboxDoubt: 0.02, volume: 12345.6, meshVolume: 12345.6, ...more })
    const before = kept(7, [horn({}), part('assembly', 'lid')])
    // The last digits of the integral, and a box drawn at another moment: within what both builds say of them.
    const again = kept(8, [horn({ volume: 12345.9, volumeDoubt: 0.3, bbox: { min: [-20.01, -15, -3], max: [20, 15.015, 3] } }), part('assembly', 'lid')])
    const digest = sanity(before, again)
    expect(digest).toMatchObject({ changed: false, parts: [], unchanged: 2 })
    // Beyond them it changed, and says so with ≈.
    const cut = sanity(before, kept(8, [horn({ volume: 12340, bbox: { min: [-20, -15, -3], max: [20, 15, 2] } }), part('assembly', 'lid')]))
    expect(cut.changed).toBe(true)
    expect(cut.parts[0].text).toBe('horn: volume ≈ 12350 → 12340 mm³ (-5.6, -0.045 %), size ≈ 40 × 30 × 6 → 40 × 30 × 5 mm')
    // An exact number has no doubt: any change is one.
    expect(sanity(BEFORE, kept(8, [part('assembly', 'tub', { volume: 6000.001 }), part('assembly', 'lid'), part('assembly', 'cap')])).changed).toBe(true)
  })

  it('tells a change of volume alone as a change, never as a defect', () => {
    const digest = sanity(BEFORE, kept(8, [part('assembly', 'tub', { volume: 2000, meshVolume: 2000 }), part('assembly', 'lid'), part('assembly', 'cap')]))
    expect(digest.changed).toBe(true)
    expect(digest.flags).toEqual([])
    expect(hardDefects(digest)).toEqual([])
  })

  it('of a first build, checks the shape and compares nothing', () => {
    const digest = sanity(undefined, kept(1, [part('assembly', 'tub', { valid: false, solids: 2 })]))
    expect(digest).toMatchObject({ revision: 1, changed: false, parts: [], unchanged: 0 })
    expect(digest.since).toBeUndefined()
    expect(digestText(digest)).toBe("Check: tub is not valid (OCC's check finds a defect); tub is 2 solids.")
    // Not valid is a defect of the first build too; more solids than before needs a before.
    expect(hardDefects(digest).map((f) => f.kind)).toEqual(['invalid'])
  })

  it('compares a part in the first layout that has it, and flags it from every layout', () => {
    const before = kept(7, [part('assembly', 'tub'), part('print', 'tub', { bbox: { min: [50, -15, -3], max: [90, 15, 3] } })], ['assembly', 'print'])
    const after = kept(8, [part('assembly', 'tub'), part('print', 'tub', { bbox: { min: [60, -15, -3], max: [100, 15, 3] }, valid: false })], ['assembly', 'print'])
    const digest = sanity(before, after)
    expect(digest.parts).toEqual([])
    expect(digest.flags.map((f) => f.text)).toEqual(["tub is not valid (OCC's check finds a defect)"])
  })

  it('flags a dimension that passed on the build before and fails now, and keeps every change of verdict as data', () => {
    const changes = [
      { id: 'M4', was: 'pass' as const, now: 'fail' as const },
      { id: 'M5', was: 'fail' as const, now: 'pass' as const }
    ]
    const digest = sanity(BEFORE, kept(8, BEFORE.scene.parts), changes)
    expect(digest.dimensions).toEqual(changes)
    expect(digest.flags).toEqual([{ kind: 'dimension', mark: 'M4', new: true, hard: false, text: 'M4 FAIL, passed on r7' }])
  })

  it('takes at most 1,200 characters, cut by whole parts and flags with what is cut counted, the hard defects kept', () => {
    const many = (n: number, more: (i: number) => Partial<Part>): Part[] => Array.from({ length: n }, (_, i) => part('assembly', `part-with-a-long-name-${i}`, more(i)))
    const before = kept(7, many(40, () => ({})))
    const after = kept(8, many(40, (i) => ({ volume: 5000 + i, faceCount: 13, solids: i === 39 ? 2 : 1 })))
    const text = digestText(sanity(before, after))
    expect(text.length).toBeLessThanOrEqual(DIGEST_LIMIT)
    const [changed, check] = text.split('\n')
    expect(changed).toMatch(/^Changed since r7: part-with-a-long-name-0: volume 6000 → 5000 mm³ \(-1000, -17 %\), faces 12 → 13; .*; \d+ more changed: call mcp__torno__diff\.$/)
    // Never mid-line: each piece is a part's whole line.
    for (const piece of changed.replace(/^Changed since r7: /, '').replace(/\.$/, '').split('; ').slice(0, -1)) expect(piece).toMatch(/^part-with-a-long-name-\d+: volume .*, faces 12 → 13(, solids 1 → 2)?$/)
    // The part that came apart is the first thing checked, whatever else is left out.
    expect(check).toMatch(/^Check: part-with-a-long-name-39 is 2 solids \(was 1\); /)
    // And within less room, less of it: never more than it is given.
    for (const room of [100, 300, 600]) expect(digestText(sanity(before, after), room).length).toBeLessThanOrEqual(room)
    expect(digestText(sanity(before, after), 10)).toBe('')
  })
})

describe('whether nothing in the parts changed', () => {
  const a = scene([part('assembly', 'tub', { hash: 'h1', loc: { t: [0, 0, 0], q: [0, 0, 0, 1] } }), part('assembly', 'lid', { hash: 'h2', loc: { t: [0, 0, 5], q: [0, 0, 0, 1] } })])
  const same = (): Part[] => a.parts.map((p) => ({ ...p, loc: { t: [...p.loc.t], q: [...p.loc.q] } as Part['loc'] }))

  it('is so for the same shapes in the same places, and the same counts and box say nothing else', () => {
    expect(partsUnchanged(a, scene(same()))).toBe(true)
  })

  it('is not so when a shape changed with the same volume, box and counts: a hole moved', () => {
    const moved = same()
    moved[0] = { ...moved[0], hash: 'h1 moved' }
    expect(sanity({ revision: 1, scene: a }, { revision: 2, scene: scene(moved) }).changed).toBe(false)
    expect(partsUnchanged(a, scene(moved))).toBe(false)
  })

  it('is not so when a part moved, came or went', () => {
    const shifted = same()
    shifted[1] = { ...shifted[1], loc: { t: [0, 0, 6], q: [0, 0, 0, 1] } }
    expect(partsUnchanged(a, scene(shifted))).toBe(false)
    expect(partsUnchanged(a, scene(same().slice(0, 1)))).toBe(false)
    expect(partsUnchanged(a, scene([...same(), part('assembly', 'cap')]))).toBe(false)
    expect(partsUnchanged(a, scene(same().map((p) => ({ ...p, arranged: [1, 0, 0] as [number, number, number] }))))).toBe(false)
  })
})

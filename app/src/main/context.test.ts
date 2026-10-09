import { describe, expect, it } from 'vitest'
import type { BuildState } from '../shared/build'
import type { Part, Scene } from '../shared/scene'
import type { ViewState } from '../shared/view'
import type { ObjectInfo } from '../shared/workspace'
import type { Mark } from '../shared/marks'
import { CONTEXT_LIMIT, contextFor, type ContextDeps } from './context'

const BRACKET: ObjectInfo = { id: 'bracket', name: 'bracket', dir: '/ws/bracket', model: 'bracket.py' }

function part(layout: string, name: string): Part {
  return { key: `${layout}:${name}`, name, layout } as Part
}

const SCENE: Scene = {
  model: 'bracket.py',
  layouts: ['assembly', 'print'],
  parts: [part('assembly', 'base'), part('assembly', 'post'), part('print', 'base'), part('print', 'post')],
  seconds: 0.8,
  output: ''
}

const CAMERA = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 } as ViewState['camera']

function deps(over: { build?: BuildState; scene?: Scene; revision?: number; view?: ViewState; now?: number; open?: string | null; name?: string }): ContextDeps {
  return {
    object: (id) => (id === 'bracket' ? { ...BRACKET, name: over.name ?? BRACKET.name } : undefined),
    openObjectId: () => (over.open === undefined ? 'bracket' : over.open),
    build: () => over.build,
    scene: () => (over.scene ? { revision: over.revision ?? over.build?.revision ?? 1, scene: over.scene } : undefined),
    view: () => over.view,
    now: () => over.now ?? 0
  }
}

/** What the agent is told when the object has no marks. */
const textFor = (d: ContextDeps, objectId: string): string => contextFor(d, objectId).text

describe('contextFor', () => {
  it('names the revision, the layout shown and its parts after a build that worked', () => {
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 12, seconds: 0.8, stale: false }
    expect(textFor(deps({ build, scene: SCENE }), 'bracket')).toBe(
      '[torno] bracket · build ok · r12 (0.8 s) · layout assembly · parts: base, post.'
    )
  })

  it('uses the layout on screen, and says which of its parts are hidden', () => {
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 3, seconds: 12.34, stale: false }
    const view: ViewState = { objectId: 'bracket', layout: 'print', camera: CAMERA, visible: ['print:base'] }
    expect(textFor(deps({ build, scene: SCENE, view }), 'bracket')).toBe(
      '[torno] bracket · build ok · r3 (12.3 s) · layout print · parts: base, post (hidden: post).'
    )
  })

  it('says how long a build has been running and what is on screen meanwhile', () => {
    const build: BuildState = { objectId: 'bracket', status: 'building', revision: 11, startedAt: 10_000, stale: true }
    expect(textFor(deps({ build, scene: SCENE, now: 14_200 }), 'bracket')).toBe('[torno] bracket · building (4 s so far) · showing r11.')
  })

  it('says so when a first build is still running', () => {
    const build: BuildState = { objectId: 'bracket', status: 'building', revision: 0, startedAt: 10_000, stale: false }
    expect(textFor(deps({ build, now: 10_400 }), 'bracket')).toBe('[torno] bracket · building (0 s so far) · nothing built yet.')
  })

  it('gives the error and the end of the traceback when the build failed', () => {
    const traceback = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const build: BuildState = {
      objectId: 'bracket',
      status: 'failed',
      revision: 11,
      seconds: 0.2,
      stale: true,
      error: { kind: 'exception', message: "NameError: name 'Boxx' is not defined", traceback: `${traceback}\n` }
    }
    const text = textFor(deps({ build, scene: SCENE }), 'bracket')
    const lines = text.split('\n')
    expect(lines[0]).toBe('[torno] bracket · BUILD FAILED · showing r11 (stale).')
    expect(lines[1]).toBe("NameError: name 'Boxx' is not defined")
    expect(lines.slice(2)).toEqual(Array.from({ length: 12 }, (_, i) => `line ${i + 9}`))
  })

  it('says nothing is on screen when the first build failed', () => {
    const build: BuildState = { objectId: 'bracket', status: 'failed', revision: 0, stale: false, error: { kind: 'no_model', message: 'no model file in /ws/bracket' } }
    expect(textFor(deps({ build }), 'bracket')).toBe('[torno] bracket · BUILD FAILED · nothing built yet.\nno model file in /ws/bracket')
  })

  it('cuts a long failure to the limit, keeping the last lines of the traceback', () => {
    const traceback = Array.from({ length: 12 }, (_, i) => `frame ${i + 1} ${'x'.repeat(900)}`).join('\n')
    const build: BuildState = {
      objectId: 'bracket',
      status: 'failed',
      revision: 2,
      stale: true,
      error: { kind: 'exception', message: `ValueError: ${'m'.repeat(900)}`, traceback: `${traceback}\nValueError: the last line` }
    }
    const text = textFor(deps({ build, scene: SCENE }), 'bracket')
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
    expect(CONTEXT_LIMIT).toBe(6000)
    expect(text.startsWith('[torno] bracket · BUILD FAILED · showing r2 (stale).\nValueError: mmm')).toBe(true)
    expect(text.endsWith('\nValueError: the last line')).toBe(true)
    expect(text).toContain('…')
  })

  it('cuts a long list of parts to the limit', () => {
    const parts = Array.from({ length: 1000 }, (_, i) => part('main', `part_number_${i}`))
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 1, seconds: 2, stale: false }
    const text = textFor(deps({ build, scene: { ...SCENE, layouts: ['main'], parts } }), 'bracket')
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
    expect(text).toMatch(/part_number_0, .* and \d+ more\.$/)
  })

  it('leaves the duration out when it is not known when the build started', () => {
    const build: BuildState = { objectId: 'bracket', status: 'building', revision: 11, stale: true }
    expect(textFor(deps({ build, scene: SCENE, now: 1_760_000_000_000 }), 'bracket')).toBe('[torno] bracket · building · showing r11.')
  })

  describe('for an object that is not the one open in the window', () => {
    it('says so, and names its parts without a layout: none is on screen', () => {
      const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 12, seconds: 0.8, stale: false }
      for (const open of ['gear', null]) {
        expect(textFor(deps({ build, scene: SCENE, open }), 'bracket')).toBe(
          '[torno] bracket · not open in the torno window · build ok · r12 (0.8 s) · parts: base, post.'
        )
      }
    })

    it('does not say that its parts are showing', () => {
      const building: BuildState = { objectId: 'bracket', status: 'building', revision: 11, startedAt: 10_000, stale: true }
      expect(textFor(deps({ build: building, now: 14_200, open: 'gear' }), 'bracket')).toBe(
        '[torno] bracket · not open in the torno window · building (4 s so far) · last built r11.'
      )
      const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 11, stale: true, error: { kind: 'exception', message: 'no' } }
      expect(textFor(deps({ build: failed, open: 'gear' }), 'bracket')).toBe('[torno] bracket · not open in the torno window · BUILD FAILED · last built r11.\nno')
      expect(textFor(deps({ open: 'gear' }), 'bracket')).toBe('[torno] bracket · not open in the torno window · not built yet.')
    })
  })

  it('never exceeds the limit, whatever the object is called', () => {
    const name = 'n'.repeat(7000)
    const traceback = Array.from({ length: 12 }, (_, i) => `frame ${i + 1} ${'x'.repeat(300)}`).join('\n')
    const states: BuildState[] = [
      { objectId: 'bracket', status: 'idle', revision: 0, stale: false },
      { objectId: 'bracket', status: 'building', revision: 1, startedAt: 0, stale: true },
      { objectId: 'bracket', status: 'failed', revision: 1, stale: true, error: { kind: 'exception', message: 'm'.repeat(900), traceback } },
      { objectId: 'bracket', status: 'failed', revision: 1, stale: true, error: { kind: 'exception', message: 'no' } },
      { objectId: 'bracket', status: 'ok', revision: 1, seconds: 1, stale: false }
    ]
    for (const build of states) {
      for (const scene of [SCENE, undefined]) {
        const text = textFor(deps({ build, scene, name }), 'bracket')
        expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        expect(text.startsWith('[torno] nnn')).toBe(true)
        expect(text.endsWith('…')).toBe(true)
      }
    }
  })

  it('says an object has not been built, and nothing about one it does not know', () => {
    expect(textFor(deps({}), 'bracket')).toBe('[torno] bracket · not built yet.')
    expect(textFor(deps({ build: { objectId: 'bracket', status: 'idle', revision: 0, stale: false } }), 'bracket')).toBe('[torno] bracket · not built yet.')
    expect(textFor(deps({}), 'nothing')).toBe('')
  })

  describe('with marks', () => {
    const OK: BuildState = { objectId: 'bracket', status: 'ok', revision: 3, seconds: 0.8, stale: false }
    const STATUS = '[torno] bracket · build ok · r3 (0.8 s) · layout assembly · parts: base, post.'
    const HEAD = 'Marks from the user (drawn in look pictures with these numbers):'
    const pin = (n: number, over: Partial<Mark> = {}): Mark =>
      ({
        id: `M${n}`,
        kind: 'pin',
        author: 'user',
        note: `note ${n}`,
        status: 'draft',
        anchorState: 'ok',
        layout: 'assembly',
        revision: 3,
        camera: CAMERA,
        createdAt: '2026-10-09T12:00:00.000Z',
        anchor: { point: [n, 0, 5], part: 'base', ref: 'base/F1', descriptor: 'plane, normal +Z, z = 5, 1200 mm²' },
        ...over
      }) as Mark
    const line = (n: number): string => `M${n} pin on base/F1 (plane, normal +Z, z = 5, 1200 mm²) at (${n}, 0, 5): "note ${n}"`

    it('lists every draft after the build line, oldest first, and says which they are', () => {
      const marks = [pin(1), pin(2, { anchorState: 'drifted' }), pin(3)]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, HEAD, line(1), 'M2 pin placed on base/F1 at (2, 0, 5): "note 2" [moved since it was placed: check it]', line(3)].join('\n'))
      expect(context.sentMarkIds).toEqual(['M1', 'M2', 'M3'])
    })

    it('sums up the marks already sent in one line, and lists none of them again', () => {
      const marks = [pin(1, { status: 'sent' }), pin(2, { status: 'resolved' }), pin(3), pin(4, { status: 'sent' })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, HEAD, line(3), 'Open marks: M1, M4'].join('\n'))
      expect(context.sentMarkIds).toEqual(['M3'])

      // The same marks once M3 was delivered: nothing is listed, nothing is to be sent.
      const again = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks.map((m) => (m.id === 'M3' ? { ...m, status: 'sent' } : m)))
      expect(again.text).toBe([STATUS, 'Open marks: M1, M3, M4'].join('\n'))
      expect(again.sentMarkIds).toEqual([])
    })

    it("does not tell the agent of its own marks as the user's, whatever their status", () => {
      const marks = [pin(1, { author: 'agent' }), pin(2, { author: 'agent', status: 'sent' })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, 'Open marks: M1, M2'].join('\n'))
      expect(context.sentMarkIds).toEqual([])
    })

    it('says nothing of marks when all are resolved', () => {
      expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [pin(1, { status: 'resolved' })])).toEqual({ text: STATUS, sentMarkIds: [] })
    })

    it('lists the oldest drafts that fit, counts the rest and says how to get them: the limit holds for 200 marks', () => {
      const marks = Array.from({ length: 200 }, (_, i) => pin(i + 1, { note: `note ${i + 1} ${'n'.repeat(60)}` }))
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
      const lines = context.text.split('\n')
      const listed = lines.slice(2, -1)
      expect(lines.slice(0, 2)).toEqual([STATUS, HEAD])
      // Not a few: what fits is used.
      expect(listed.length).toBeGreaterThan(30)
      expect(CONTEXT_LIMIT - context.text.length).toBeLessThan(200)
      expect(listed.map((l) => l.split(' ')[0])).toEqual(marks.slice(0, listed.length).map((m) => m.id))
      expect(lines.at(-1)).toBe(`… and ${200 - listed.length} more: call mcp__torno__marks`)
      // Only what the agent was given becomes sent; the rest wait for the next prompt.
      expect(context.sentMarkIds).toEqual(marks.slice(0, listed.length).map((m) => m.id))
    })

    it('holds the limit with 200 marks open and a build that failed at length', () => {
      const traceback = Array.from({ length: 12 }, (_, i) => `frame ${i + 1} ${'x'.repeat(900)}`).join('\n')
      const build: BuildState = { objectId: 'bracket', status: 'failed', revision: 2, stale: true, error: { kind: 'exception', message: 'm'.repeat(900), traceback } }
      const marks = [...Array.from({ length: 200 }, (_, i) => pin(i + 1, { status: 'sent' })), pin(201, { note: 'n'.repeat(2000) }), pin(202)]
      const context = contextFor(deps({ build, scene: SCENE }), 'bracket', marks)
      expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
      // The build keeps a third of the room; the marks are told all the same.
      expect(context.text.startsWith('[torno] bracket · BUILD FAILED · showing r2 (stale).\n')).toBe(true)
      expect(context.sentMarkIds).toEqual(['M201', 'M202'])
      expect(context.text.split('\n').at(-1)).toMatch(/^Open marks: M1, M2, .* and \d+ more$/)
    })

    it('lists none of the drafts when even the first does not fit, and sends none', () => {
      const long = pin(1, { anchor: { point: [0, 0, 0], ref: 'base/F1', descriptor: 'd'.repeat(7000) } } as Partial<Mark>)
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [long, pin(2)])
      expect(context.text).toBe([STATUS, HEAD, '… and 2 more: call mcp__torno__marks'].join('\n'))
      expect(context.sentMarkIds).toEqual([])
    })

    it('says which layout a draft is in when it is not the one the first line names: its coordinates are in that frame', () => {
      const marks = [pin(1), pin(2, { layout: 'print' }), pin(3, { layout: 'print', anchorState: 'drifted' })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe(
        [STATUS, HEAD, line(1), `${line(2)} [in layout print]`, 'M3 pin placed on base/F1 at (3, 0, 5): "note 3" [moved since it was placed: check it] [in layout print]'].join('\n')
      )
      // With print on screen it is the marks of the assembly that say so.
      const view: ViewState = { objectId: 'bracket', layout: 'print', camera: CAMERA, visible: ['print:base', 'print:post'] }
      const onPrint = contextFor(deps({ build: OK, scene: SCENE, view }), 'bracket', marks).text.split('\n')
      expect(onPrint.slice(2)).toEqual([`${line(1)} [in layout assembly]`, line(2), 'M3 pin placed on base/F1 at (3, 0, 5): "note 3" [moved since it was placed: check it]'])
    })

    it('says the layout of every draft when the first line names none', () => {
      const marks = [pin(1), pin(2, { layout: 'print' })]
      const both = [`${line(1)} [in layout assembly]`, `${line(2)} [in layout print]`]
      // Not open in the window, building, failed: no layout is named.
      expect(contextFor(deps({ build: OK, scene: SCENE, open: 'gear' }), 'bracket', marks).text.split('\n').slice(2)).toEqual(both)
      const building: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true }
      expect(contextFor(deps({ build: building, scene: SCENE }), 'bracket', marks).text.split('\n').slice(2)).toEqual(both)
      const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }
      expect(contextFor(deps({ build: failed, scene: SCENE }), 'bracket', marks).text.split('\n').slice(3)).toEqual(both)
      // An object with one layout, open in the window, has no other frame a mark could be in.
      const one = { ...SCENE, layouts: ['assembly'], parts: SCENE.parts.slice(0, 2) }
      expect(contextFor(deps({ build: building, scene: one }), 'bracket', [pin(1)]).text.split('\n').slice(2)).toEqual([line(1)])
      expect(contextFor(deps({ build: building, scene: one, open: 'gear' }), 'bracket', [pin(1)]).text.split('\n').slice(2)).toEqual([`${line(1)} [in layout assembly]`])
    })

    it('counts the layout in what fits', () => {
      const marks = Array.from({ length: 200 }, (_, i) => pin(i + 1, { layout: 'print', note: `note ${i + 1} ${'n'.repeat(60)}` }))
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
      expect(CONTEXT_LIMIT - context.text.length).toBeLessThan(200)
      const listed = context.text.split('\n').slice(2, -1)
      expect(listed.every((l) => l.endsWith(' [in layout print]'))).toBe(true)
      expect(context.sentMarkIds).toHaveLength(listed.length)
    })

    it('tells of the marks of an object that is not built, or not open', () => {
      expect(contextFor(deps({}), 'bracket', [pin(1)]).text).toBe(['[torno] bracket · not built yet.', HEAD, `${line(1)} [in layout assembly]`].join('\n'))
      expect(contextFor(deps({ open: 'gear' }), 'bracket', [pin(1)]).sentMarkIds).toEqual(['M1'])
      expect(contextFor(deps({}), 'nothing', [pin(1)])).toEqual({ text: '', sentMarkIds: [] })
    })
  })
})

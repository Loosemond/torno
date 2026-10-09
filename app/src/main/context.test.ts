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
    const DIMS = 'Dimensions (measured on r3):'
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
        checkedRevision: 3,
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

    it('says of a draft the agent was sent before that it has changed', () => {
      const marks = [pin(1, { sentBefore: true }), pin(2)]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, HEAD, `(changed) ${line(1)}`, line(2)].join('\n'))
      expect(context.sentMarkIds).toEqual(['M1', 'M2'])
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

    it("does not tell the agent of its own marks as news: they are among the open ones", () => {
      const marks = [pin(1, { author: 'agent', status: 'sent' }), pin(2, { author: 'agent', status: 'sent' })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, 'Open marks: M1, M2'].join('\n'))
      expect(context.sentMarkIds).toEqual([])
    })

    it('says of each open mark that moved, lost its part or was not checked, and then where to get their data', () => {
      const marks = [
        pin(1, { status: 'sent', anchorState: 'drifted' }),
        pin(2, { status: 'sent' }),
        pin(4, { status: 'sent', anchorState: 'orphaned' }),
        pin(6, { status: 'sent', checkedRevision: 2 }),
        pin(7, { status: 'sent', anchorState: 'drifted', checkedRevision: 2 })
      ]
      expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks).text).toBe(
        [STATUS, 'Open marks: M1 (moved), M2, M4 (part gone), M6 (unchecked), M7 (moved); call mcp__torno__marks for their data'].join('\n')
      )
      // Nothing to get when nothing is flagged.
      expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [marks[1]]).text).toBe([STATUS, 'Open marks: M2'].join('\n'))
    })

    it('still says where to get their data when the flagged marks do not all fit', () => {
      const marks = Array.from({ length: 200 }, (_, i) => pin(i + 1, { status: 'sent', anchorState: 'drifted' }))
      const last = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks).text.split('\n').at(-1)!
      expect(last).toMatch(/^Open marks: M1 \(moved\), M2 \(moved\), .* and \d+ more; call mcp__torno__marks for their data$/)
      expect(last.length).toBeLessThanOrEqual('Open marks: '.length + 300)
    })

    it('says in a draft line that the mark was not checked against the build named above', () => {
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [pin(1, { checkedRevision: 2 })])
      expect(context.text).toBe([STATUS, HEAD, `${line(1)} [not checked against r3]`].join('\n'))
    })

    it('says of a mark of the user\'s that they reopened that they did, rather than that it changed: a resolution was not accepted', () => {
      const marks = [pin(1, { sentBefore: true, reopened: true }), pin(2, { reopened: true })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, HEAD, `(reopened by the user) ${line(1)}`, `(reopened by the user) ${line(2)}`].join('\n'))
      // Also in a conversation that never had it: the mark was resolved once, and that did not do.
      expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks, { fresh: true }).text).toBe(context.text)
    })

    it("lists a mark of the agent's that the user reopened, once, as its own and reopened", () => {
      const marks = [pin(1, { author: 'agent', status: 'draft' }), pin(2, { author: 'agent', status: 'sent' })]
      const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
      expect(context.text).toBe([STATUS, HEAD, `(yours, reopened by the user) ${line(1)}`, 'Open marks: M2'].join('\n'))
      // Sent with the prompt, like a draft of the user's: then it is one of the open marks.
      expect(context.sentMarkIds).toEqual(['M1'])
    })

    describe('in a conversation that has not seen them', () => {
      const STILL = 'Marks still open (this conversation has not seen them):'

      it("lists every open mark of the user's once more, after the drafts, and sends only the drafts", () => {
        const marks = [pin(1, { status: 'sent', sentBefore: true }), pin(2, { status: 'resolved' }), pin(3, { sentBefore: true }), pin(4, { author: 'agent', status: 'sent' }), pin(5, { status: 'sent', anchorState: 'drifted' })]
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks, { fresh: true })
        expect(context.text).toBe(
          [
            STATUS,
            HEAD,
            // Not "(changed)": this conversation never had it.
            line(3),
            STILL,
            line(1),
            'M5 pin placed on base/F1 at (5, 0, 5): "note 5" [moved since it was placed: check it]',
            'Open marks: M1, M4, M5 (moved); call mcp__torno__marks for their data'
          ].join('\n')
        )
        expect(context.sentMarkIds).toEqual(['M3'])
      })

      it('says nothing more than usual when there is none', () => {
        const marks = [pin(1), pin(4, { author: 'agent', status: 'sent' })]
        expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks, { fresh: true }).text).toBe([STATUS, HEAD, line(1), 'Open marks: M4'].join('\n'))
      })

      it('keeps to the limit: those that do not fit are counted', () => {
        const marks = Array.from({ length: 200 }, (_, i) => pin(i + 1, { status: 'sent', note: `note ${i + 1} ${'n'.repeat(60)}` }))
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks, { fresh: true })
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const lines = context.text.split('\n')
        expect(lines[1]).toBe(STILL)
        expect(lines.at(-2)).toMatch(/^… and \d+ more: call mcp__torno__marks$/)
        expect(lines.length).toBeGreaterThan(30)
        expect(context.sentMarkIds).toEqual([])
      })

      it('keeps to the limit when the drafts have left no room for the marks listed again: nothing is said of those but their numbers', () => {
        const drafts = Array.from({ length: 40 }, (_, i) => pin(i + 1, { note: 'n'.repeat(359) }))
        const sent = Array.from({ length: 30 }, (_, i) => pin(i + 41, { status: 'sent', sentBefore: true }))
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [...drafts, ...sent], { fresh: true })
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const lines = context.text.split('\n')
        // The drafts that fit, and how many did not; then no head with nothing under it.
        expect(lines).not.toContain(STILL)
        expect(lines.at(-2)).toBe(`… and ${40 - context.sentMarkIds.length} more: call mcp__torno__marks`)
        expect(lines.at(-1)).toMatch(/^Open marks: M41, M42, /)
        expect(context.sentMarkIds.length).toBeGreaterThan(5)
        // Every mark said to be sent has its whole line.
        for (const id of context.sentMarkIds) expect(lines.some((l) => l.startsWith(`${id} pin on `) && l.endsWith('"'))).toBe(true)
      })

      it('lists as many of them as there is room for after the drafts, and counts the rest', () => {
        const drafts = Array.from({ length: 12 }, (_, i) => pin(i + 1, { note: 'n'.repeat(359) }))
        const sent = Array.from({ length: 30 }, (_, i) => pin(i + 41, { status: 'sent', sentBefore: true }))
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [...drafts, ...sent], { fresh: true })
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const lines = context.text.split('\n')
        const at = lines.indexOf(STILL)
        expect(context.sentMarkIds).toHaveLength(12)
        expect(at).toBe(2 + 12)
        const again = lines.slice(at + 1, -2)
        expect(again.length).toBeGreaterThan(0)
        expect(lines.at(-2)).toBe(`… and ${30 - again.length} more: call mcp__torno__marks`)
      })
    })

    describe('with a selection', () => {
      const selected = (over: Partial<ViewState> = {}): ViewState => ({
        objectId: 'bracket',
        layout: 'assembly',
        camera: CAMERA,
        visible: ['assembly:base', 'assembly:post'],
        selection: { revision: 3, total: 3, refs: [{ ref: 'base/F5', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }, { ref: 'base/E5', descriptor: 'line, 30 mm' }, { ref: 'post' }] },
        ...over
      })
      const SELECTED = 'Selected: base/F5 (plane, normal +Z, z = 2.5, 1200 mm²), base/E5 (line, 30 mm), post'

      it('says what the user has selected, after the build line and before the marks', () => {
        expect(contextFor(deps({ build: OK, scene: SCENE, view: selected() }), 'bracket', [pin(1)]).text).toBe([STATUS, SELECTED, HEAD, line(1)].join('\n'))
        expect(textFor(deps({ build: OK, scene: SCENE, view: selected() }), 'bracket')).toBe([STATUS, SELECTED].join('\n'))
      })

      it('says nothing of it when the refs may not name what was selected: another build, a stale one, another layout, another object', () => {
        const none = (d: ContextDeps): void => expect(textFor(d, 'bracket')).not.toContain('Selected')
        none(deps({ build: OK, scene: SCENE, view: selected({ selection: { revision: 2, total: 1, refs: [{ ref: 'base/F5' }] } }) }))
        none(deps({ build: { ...OK, stale: true }, scene: SCENE, view: selected() }))
        none(deps({ build: { objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true }, scene: SCENE, view: selected() }))
        none(deps({ build: { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } }, scene: SCENE, view: selected() }))
        none(deps({ build: OK, scene: SCENE, view: selected(), open: 'gear' }))
        none(deps({ build: OK, scene: SCENE, view: selected({ layout: 'exploded' }) }))
        none(deps({ build: OK, scene: SCENE, view: selected({ selection: { revision: 3, total: 0, refs: [] } }) }))
      })

      it('names at most eight, and stays within the limit with the marks', () => {
        const refs = Array.from({ length: 12 }, (_, i) => ({ ref: `base/F${i}`, descriptor: 'd'.repeat(300) }))
        const marks = Array.from({ length: 200 }, (_, i) => pin(i + 1, { note: `note ${i + 1} ${'n'.repeat(60)}` }))
        const context = contextFor(deps({ build: OK, scene: SCENE, view: selected({ selection: { revision: 3, total: 12, refs } }) }), 'bracket', marks)
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const selectedLine = context.text.split('\n')[1]
        expect(selectedLine.match(/base\/F\d+/g)).toHaveLength(8)
        expect(selectedLine).toMatch(/ and 4 more$/)
      })

      it('says how many more are selected than it was given the refs of', () => {
        // The window reports eight refs at most, and how many are selected in all.
        const refs = Array.from({ length: 8 }, (_, i) => ({ ref: `base/F${i}` }))
        const view = selected({ selection: { revision: 3, total: 23, refs } })
        expect(textFor(deps({ build: OK, scene: SCENE, view }), 'bracket').split('\n')[1]).toBe(`Selected: ${refs.map((r) => r.ref).join(', ')} and 15 more`)
        // The count is still said when what is said of the refs has to be cut.
        const long = Array.from({ length: 8 }, (_, i) => ({ ref: `${'p'.repeat(190)}/F${i}`, descriptor: 'd'.repeat(300) }))
        const cut = textFor(deps({ build: OK, scene: SCENE, view: selected({ selection: { revision: 3, total: 23, refs: long } }) }), 'bracket').split('\n')[1]
        expect(cut.length).toBeLessThanOrEqual(1000)
        expect(cut).toMatch(/… and 15 more$/)
      })
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
      // Checked against r2, the build still on show.
      const marks = [...Array.from({ length: 200 }, (_, i) => pin(i + 1, { status: 'sent', checkedRevision: 2 })), pin(201, { note: 'n'.repeat(2000), checkedRevision: 2 }), pin(202, { checkedRevision: 2 })]
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

    describe('the dimensions the agent has been given', () => {
      // Pinned: sent, not resolved. Measured on r3, the build there is.
      const dim = (n: number, over: object = {}): Mark =>
        ({
          ...pin(n, { status: 'sent', sentBefore: true, note: '' }),
          kind: 'dimension',
          measure: 'diameter',
          a: { point: [n, 0, 5], part: 'base', ref: 'base/F9' },
          value: 8,
          how: 'cylinder',
          measuredRevision: 3,
          ...over
        }) as Mark
      const failing = (n: number, over: object = {}): Mark => dim(n, { expected: 8.5, verdict: 'fail', ...over })
      const passing = (n: number, over: object = {}): Mark => dim(n, { expected: 8, verdict: 'pass', ...over })
      const FAIL = (n: number): string => `M${n} diameter 8 mm, base/F9 (expected 8.5 ± 0.05: FAIL, 0.5 under)`
      const text = (marks: Mark[], opts: { fresh?: boolean } = {}): string => contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks, opts).text

      it('lists each one that fails, after the marks, and then how many pass', () => {
        const marks = [pin(1), failing(8), passing(9), passing(10), pin(11, { status: 'sent' })]
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
        expect(context.text).toBe([STATUS, HEAD, line(1), DIMS, FAIL(8), '2 pinned dimensions pass', 'Open marks: M9, M10, M11'].join('\n'))
        // They are not news: only the draft is turned sent.
        expect(context.sentMarkIds).toEqual(['M1'])
      })

      it('lists them with every prompt until they pass: nothing consumes them', () => {
        const marks = [failing(8)]
        const first = text(marks)
        expect(first).toBe([STATUS, DIMS, FAIL(8)].join('\n'))
        expect(text(marks)).toBe(first)
        // Passing, there is only the count; and it is among the open marks again.
        expect(text([passing(8)])).toBe([STATUS, DIMS, '1 pinned dimension passes', 'Open marks: M8'].join('\n'))
      })

      it('lists one that cannot be measured, with why, and one not measured on this build, without a value of it', () => {
        const marks = [
          dim(2, { value: undefined, how: undefined, refused: 'base/F9 is a plane face: it has no diameter', expected: 8 }),
          dim(3, { anchorState: 'orphaned', expected: 8, verdict: 'pass' }),
          passing(4, { measuredRevision: 2 }),
          dim(5, { measuredRevision: undefined })
        ]
        expect(text(marks)).toBe(
          [
            STATUS,
            DIMS,
            'M2 diameter: not measurable (base/F9 is a plane face: it has no diameter), base/F9 (expected 8 ± 0.05)',
            'M3 diameter: not measurable, [its part is gone]',
            'M4 diameter: not measured on r3 (was 8 mm on r2), base/F9 (expected 8 ± 0.05)',
            'M5 diameter: not measured yet, base/F9'
          ].join('\n')
        )
      })

      it('one whose end the build moved is measured, judged, and says that it moved', () => {
        expect(text([failing(8, { anchorState: 'drifted' }), passing(9, { anchorState: 'drifted' })])).toBe(
          [STATUS, DIMS, `${FAIL(8)} [moved since it was placed: check it]`, '1 pinned dimension passes (1 measured from what is under its ends now: M9)', 'Open marks: M9 (moved); call mcp__torno__marks for their data'].join('\n')
        )
        // Only counted, one that passes would pass unseen for what it was placed on: each such is named.
        expect(text([passing(9, { anchorState: 'drifted' }), passing(10), passing(12, { anchorState: 'drifted' })]).split('\n')[2]).toBe(
          '3 pinned dimensions pass (2 measured from what is under their ends now: M9, M12)'
        )
      })

      it('says nothing when there is none pinned, nor of one with nothing expected that is measured', () => {
        expect(text([pin(1, { status: 'sent' })])).toBe([STATUS, 'Open marks: M1'].join('\n'))
        expect(text([dim(2)])).toBe([STATUS, 'Open marks: M2'].join('\n'))
        // Resolved: no longer a check of the part.
        expect(text([failing(2, { status: 'resolved' })])).toBe(STATUS)
      })

      it('a draft dimension is told with the drafts, as a mark: not under the dimensions until it has been given', () => {
        const draft = failing(8, { status: 'draft', sentBefore: false })
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [draft])
        expect(context.text).toBe([STATUS, HEAD, FAIL(8)].join('\n'))
        expect(context.sentMarkIds).toEqual(['M8'])
        // Changed after it was given, it is news again, and listed once.
        expect(text([failing(8, { status: 'draft' })])).toBe([STATUS, HEAD, `(changed) ${FAIL(8)}`].join('\n'))
      })

      it('the agent’s own whose expectation the person changed is told as changed, not as reopened', () => {
        expect(text([failing(8, { author: 'agent', status: 'draft', sentBefore: true })])).toBe([STATUS, HEAD, `(yours, changed) ${FAIL(8)}`].join('\n'))
        expect(text([failing(8, { author: 'agent', status: 'draft', sentBefore: true, reopened: true })])).toBe([STATUS, HEAD, `(yours, reopened by the user) ${FAIL(8)}`].join('\n'))
        expect(text([failing(8, { author: 'agent', status: 'draft', sentBefore: false })])).toBe([STATUS, HEAD, `(yours, reopened by the user) ${FAIL(8)}`].join('\n'))
      })

      it('the agent’s own is listed as its own, and one of another layout says which', () => {
        expect(text([failing(8, { author: 'agent', layout: 'print' })])).toBe([STATUS, DIMS, `(yours) ${FAIL(8)} [in layout print]`].join('\n'))
      })

      it('in a conversation that has not seen the marks, is listed once: under the dimensions', () => {
        const marks = [pin(1, { status: 'sent', sentBefore: true }), failing(8), passing(9)]
        const STILL = 'Marks still open (this conversation has not seen them):'
        expect(text(marks, { fresh: true })).toBe(
          [STATUS, STILL, line(1), 'M9 diameter 8 mm, base/F9 (expected 8 ± 0.05: pass)', DIMS, FAIL(8), '1 pinned dimension passes', 'Open marks: M1, M9'].join('\n')
        )
      })

      it('keeps to the limit: what fits is listed, the rest counted, and the count of those that pass is still said', () => {
        const marks = [...Array.from({ length: 150 }, (_, i) => failing(i + 1, { note: 'n'.repeat(40) })), passing(200), passing(201)]
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', marks)
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const lines = context.text.split('\n')
        expect(lines[1]).toBe(DIMS)
        expect(lines[2]).toBe(`${FAIL(1)}: "${'n'.repeat(40)}"`)
        const listed = lines.filter((l) => l.includes('FAIL')).length
        expect(listed).toBeGreaterThan(30)
        expect(lines.at(-3)).toBe(`… and ${150 - listed} more unmet or unmeasured: call mcp__torno__marks`)
        expect(lines.at(-2)).toBe('2 pinned dimensions pass')
        // Those with a line above are not named again; those left out still are.
        expect(lines.at(-1)).toMatch(new RegExp(`^Open marks: M${listed + 1}, M${listed + 2}, `))
      })

      it('keeps room for them before the drafts are listed: a prompt full of drafts still says which dimensions fail', () => {
        const drafts = Array.from({ length: 60 }, (_, i) => pin(i + 1, { note: 'n'.repeat(300) }))
        const context = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [...drafts, failing(100), failing(101), passing(102)])
        expect(context.text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
        const lines = context.text.split('\n')
        const at = lines.indexOf(DIMS)
        expect(at).toBeGreaterThan(5)
        // The head, then either a line or the count of those left out; and the count of those that pass.
        expect(lines.slice(at + 1).join('\n')).toMatch(/^(M100 .*\n(M101 .*|… and 1 more unmet or unmeasured: call mcp__torno__marks)|… and 2 more unmet or unmeasured: call mcp__torno__marks)\n1 pinned dimension passes\nOpen marks: /)
        // Only the drafts that were listed are turned sent.
        expect(context.sentMarkIds.length).toBeGreaterThan(5)
        expect(context.sentMarkIds.length).toBeLessThan(60)
        expect(context.sentMarkIds.every((id) => lines.some((l) => l.startsWith(`${id} pin`)))).toBe(true)
      })

      it('says which build they were measured on, and that it is not of the model as it now is while a build runs or after one failed', () => {
        const marks = [failing(8), passing(9)]
        const of = (build: BuildState): string[] => contextFor(deps({ build, scene: SCENE, revision: 3 }), 'bracket', marks).text.split('\n')
        expect(of(OK)[1]).toBe('Dimensions (measured on r3):')
        const building = of({ objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true })
        expect(building[0]).toBe('[torno] bracket · building (0 s so far) · showing r3.')
        expect(building[1]).toBe('Dimensions (measured on r3; a build is running, so these are not of your last edit):')
        expect(building[3]).toBe('1 pinned dimension passes')
        const failed = of({ objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: 'no' } })
        expect(failed[2]).toBe('Dimensions (measured on r3; the latest build failed, so these are still of r3):')
        // The head is counted in what fits.
        const many = Array.from({ length: 150 }, (_, i) => failing(i + 1, { note: 'n'.repeat(40) }))
        expect(contextFor(deps({ build: { objectId: 'bracket', status: 'building', revision: 3, startedAt: 0, stale: true }, scene: SCENE, revision: 3 }), 'bracket', many).text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
      })

      it('before any build of the run has none measured: each is told as not measured, never with the value its file holds', () => {
        const none = contextFor(deps({}), 'bracket', [passing(8, { measuredRevision: undefined })]).text
        expect(none).toBe(['[torno] bracket · not built yet.', 'Dimensions (nothing is built yet):', 'M8 diameter: not measured yet, base/F9 (expected 8 ± 0.05) [in layout assembly]'].join('\n'))
      })
    })

    it('tells of the marks of an object that is not built, or not open', () => {
      expect(contextFor(deps({}), 'bracket', [pin(1)]).text).toBe(['[torno] bracket · not built yet.', HEAD, `${line(1)} [in layout assembly]`].join('\n'))
      expect(contextFor(deps({ open: 'gear' }), 'bracket', [pin(1)]).sentMarkIds).toEqual(['M1'])
      expect(contextFor(deps({}), 'nothing', [pin(1)])).toEqual({ text: '', sentMarkIds: [] })
    })
  })
})

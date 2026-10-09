import { describe, expect, it } from 'vitest'
import type { BuildState } from '../shared/build'
import type { Part, Scene } from '../shared/scene'
import type { ViewState } from '../shared/view'
import type { ObjectInfo } from '../shared/workspace'
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

function deps(over: { build?: BuildState; scene?: Scene; revision?: number; view?: ViewState; now?: number }): ContextDeps {
  return {
    object: (id) => (id === 'bracket' ? BRACKET : undefined),
    build: () => over.build,
    scene: () => (over.scene ? { revision: over.revision ?? over.build?.revision ?? 1, scene: over.scene } : undefined),
    view: () => over.view,
    now: () => over.now ?? 0
  }
}

describe('contextFor', () => {
  it('names the revision, the layout shown and its parts after a build that worked', () => {
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 12, seconds: 0.8, stale: false }
    expect(contextFor(deps({ build, scene: SCENE }), 'bracket')).toBe(
      '[torno] bracket · build ok · r12 (0.8 s) · layout assembly · parts: base, post. Tools: mcp__torno__scene, mcp__torno__look.'
    )
  })

  it('uses the layout on screen, and says which of its parts are hidden', () => {
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 3, seconds: 12.34, stale: false }
    const view: ViewState = { objectId: 'bracket', layout: 'print', camera: CAMERA, visible: ['print:base'] }
    expect(contextFor(deps({ build, scene: SCENE, view }), 'bracket')).toBe(
      '[torno] bracket · build ok · r3 (12.3 s) · layout print · parts: base, post (hidden: post). Tools: mcp__torno__scene, mcp__torno__look.'
    )
  })

  it('says how long a build has been running and what is on screen meanwhile', () => {
    const build: BuildState = { objectId: 'bracket', status: 'building', revision: 11, startedAt: 10_000, stale: true }
    expect(contextFor(deps({ build, scene: SCENE, now: 14_200 }), 'bracket')).toBe('[torno] bracket · building (4 s so far) · showing r11.')
  })

  it('says so when a first build is still running', () => {
    const build: BuildState = { objectId: 'bracket', status: 'building', revision: 0, startedAt: 10_000, stale: false }
    expect(contextFor(deps({ build, now: 10_400 }), 'bracket')).toBe('[torno] bracket · building (0 s so far) · nothing built yet.')
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
    const text = contextFor(deps({ build, scene: SCENE }), 'bracket')
    const lines = text.split('\n')
    expect(lines[0]).toBe('[torno] bracket · BUILD FAILED · showing r11 (stale).')
    expect(lines[1]).toBe("NameError: name 'Boxx' is not defined")
    expect(lines.slice(2)).toEqual(Array.from({ length: 12 }, (_, i) => `line ${i + 9}`))
  })

  it('says nothing is on screen when the first build failed', () => {
    const build: BuildState = { objectId: 'bracket', status: 'failed', revision: 0, stale: false, error: { kind: 'no_model', message: 'no model file in /ws/bracket' } }
    expect(contextFor(deps({ build }), 'bracket')).toBe('[torno] bracket · BUILD FAILED · nothing built yet.\nno model file in /ws/bracket')
  })

  it('cuts a long failure to the limit, keeping the last lines of the traceback', () => {
    const traceback = Array.from({ length: 12 }, (_, i) => `frame ${i + 1} ${'x'.repeat(300)}`).join('\n')
    const build: BuildState = {
      objectId: 'bracket',
      status: 'failed',
      revision: 2,
      stale: true,
      error: { kind: 'exception', message: `ValueError: ${'m'.repeat(900)}`, traceback: `${traceback}\nValueError: the last line` }
    }
    const text = contextFor(deps({ build, scene: SCENE }), 'bracket')
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
    expect(CONTEXT_LIMIT).toBe(1500)
    expect(text.startsWith('[torno] bracket · BUILD FAILED · showing r2 (stale).\nValueError: mmm')).toBe(true)
    expect(text.endsWith('\nValueError: the last line')).toBe(true)
    expect(text).toContain('…')
  })

  it('cuts a long list of parts to the limit', () => {
    const parts = Array.from({ length: 400 }, (_, i) => part('main', `part_number_${i}`))
    const build: BuildState = { objectId: 'bracket', status: 'ok', revision: 1, seconds: 2, stale: false }
    const text = contextFor(deps({ build, scene: { ...SCENE, layouts: ['main'], parts } }), 'bracket')
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT)
    expect(text).toMatch(/part_number_0, .* and \d+ more\. Tools: mcp__torno__scene, mcp__torno__look\.$/)
  })

  it('says an object has not been built, and nothing about one it does not know', () => {
    expect(contextFor(deps({}), 'bracket')).toBe('[torno] bracket · not built yet.')
    expect(contextFor(deps({ build: { objectId: 'bracket', status: 'idle', revision: 0, stale: false } }), 'bracket')).toBe('[torno] bracket · not built yet.')
    expect(contextFor(deps({}), 'nothing')).toBe('')
  })
})

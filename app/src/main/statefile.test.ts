import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildState } from '../shared/build'
import type { Mark } from '../shared/marks'
import type { Part, Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { StateFiles, stateText, writtenLine } from './statefile'

const part = (layout: string, name: string, min: number[], max: number[]): Part => ({ key: `${layout}:${name}`, name, layout, bbox: { min, max } }) as Part
const SCENE: Scene = {
  model: 'bracket.py',
  layouts: ['assembly', 'print'],
  parts: [part('assembly', 'base', [-20, -15, -2.5], [20, 15, 2.5]), part('assembly', 'post', [-3.9975, -3.999, 2.5], [3.9975, 3.999, 22.5]), part('print', 'base', [-20, -15, 0], [20, 15, 5.00004])],
  seconds: 0.8,
  output: ''
}
const OK: BuildState = { objectId: 'bracket', status: 'ok', revision: 3, seconds: 0.8123, stale: false }
const CAMERA = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const pin = (n: number, over: object = {}): Mark =>
  ({ id: `M${n}`, kind: 'pin', author: 'user', note: `note ${n}`, status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 3, camera: CAMERA, createdAt: 't', anchor: { point: [n, 0, 5], part: 'base', ref: 'base/F1' }, ...over }) as Mark

let root: string
let obj: ObjectInfo

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-state-'))
  obj = { id: 'bracket', name: 'bracket', dir: root, model: 'bracket.py' }
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('stateText', () => {
  it('says how the build stands, what each layout holds and every mark that is not resolved', () => {
    const marks = [pin(1), pin(2, { status: 'resolved' }), pin(3, { author: 'agent', status: 'sent', layout: 'print' }), pin(4, { status: 'sent', anchorState: 'orphaned' })]
    expect(stateText(obj, OK, { revision: 3, scene: SCENE }, marks)).toBe(
      [
        '# bracket',
        '',
        'torno keeps this file: it is rewritten after every build and every change of the marks. Do not edit it.',
        'Lengths are millimetres, Z up, in the frame of the layout named.',
        '',
        '## Build',
        '',
        'Build ok, r3.',
        '',
        '## Layouts and parts',
        '',
        'Model: bracket.py, r3.',
        '',
        '- assembly: base 40 × 30 × 5 mm, post 8 × 8 × 20 mm',
        '- print: base 40 × 30 × 5 mm',
        '',
        '## Marks',
        '',
        'What the user and the agent have pointed at and not resolved. `lid/F12` is face 12 of the part lid, `lid/E3` its edge 3, in the layout the mark is in.',
        '',
        'In layout assembly:',
        '',
        '- M1 pin on base/F1 at (1, 0, 5): "note 1"',
        '- M4 pin placed on base/F1 at (4, 0, 5): "note 4" [its part is gone]',
        '',
        'In layout print:',
        '',
        '- (yours) M3 pin on base/F1 at (3, 0, 5): "note 3"',
        ''
      ].join('\n')
    )
  })

  it('gives the error of a build that failed, and says which build the parts are of', () => {
    const traceback = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const failed: BuildState = { objectId: 'bracket', status: 'failed', revision: 3, stale: true, error: { kind: 'exception', message: "NameError: name 'Boxx' is not defined", traceback } }
    const text = stateText(obj, failed, { revision: 3, scene: SCENE }, [])
    expect(text).toContain("## Build\n\nBUILD FAILED. The parts below are those of r3, the last build that worked.\n\n```\nNameError: name 'Boxx' is not defined\nline 9\n")
    expect(text).toContain('line 20\n```\n')
    expect(text).not.toContain('line 8\n')
    expect(text).toContain('## Marks\n\nNone.\n')
  })

  it('says so while a build runs and before anything was built, with nothing that changes by itself', () => {
    const building: BuildState = { objectId: 'bracket', status: 'building', revision: 3, startedAt: 1000, stale: true }
    expect(stateText(obj, building, { revision: 3, scene: SCENE }, [])).toContain('A build is running. The parts below are those of r3, the last build that worked.')
    const first = stateText(obj, { ...building, revision: 0 }, undefined, [])
    expect(first).toContain('A build is running. Nothing has been built yet.')
    expect(first).toContain('## Layouts and parts\n\nNothing has been built yet.\n')
    expect(stateText(obj, { objectId: 'bracket', status: 'idle', revision: 0, stale: false }, undefined, [])).toContain('## Build\n\nNot built yet.\n')
  })
})

describe('StateFiles', () => {
  const path = () => join(root, '.torno', 'state.md')
  let build: BuildState | undefined
  let marks: Mark[]
  let writes: number
  let files: StateFiles

  beforeEach(() => {
    build = OK
    marks = [pin(1)]
    writes = 0
    files = new StateFiles({
      object: (id) => (id === 'bracket' ? obj : undefined),
      build: (id) => (id === 'bracket' ? build : undefined),
      scene: () => ({ revision: 3, scene: SCENE }),
      marks: async () => marks,
      delayMs: 20,
      now: () => new Date(Date.UTC(2026, 9, 9, 4, 30, writes)),
      write: async (file, text) => {
        writes += 1
        const { writeFileAtomic } = await import('./atomic')
        return writeFileAtomic(file, text)
      }
    })
  })

  it('writes the file whole, through a temp file that is gone afterwards', async () => {
    await files.write('bracket')
    const first = 'Written by torno at 2026-10-09T04:30:00.000Z; it is only current while torno is running.'
    expect(readFileSync(path(), 'utf8')).toBe(`${first}\n\n${stateText(obj, OK, { revision: 3, scene: SCENE }, marks)}`)
    expect(readdirSync(join(root, '.torno'))).toEqual(['state.md'])
  })

  it('says in its first line when it was written, and that it is only current while torno runs', () => {
    expect(writtenLine(new Date('2026-10-09T04:30:00Z'))).toBe('Written by torno at 2026-10-09T04:30:00.000Z; it is only current while torno is running.')
  })

  it('writes once for a burst of changes, a moment after the last', async () => {
    for (let i = 0; i < 5; i += 1) files.changed('bracket')
    expect(writes).toBe(0)
    await vi.waitFor(() => expect(writes).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(writes).toBe(1)
  })

  it('waits a second by default', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const slow = new StateFiles({ object: () => obj, build: () => OK, scene: () => undefined, marks: async () => (asked.push('marks'), []), write: async () => {} })
    slow.changed('bracket')
    await vi.advanceTimersByTimeAsync(900)
    slow.changed('bracket') // a change within the second starts the wait again
    await vi.advanceTimersByTimeAsync(900)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(asked).toEqual(['marks'])
  })

  it('forgotten with the workspace, writes nothing that was still waiting', async () => {
    files.changed('bracket')
    files.forget()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(writes).toBe(0)
  })

  it('does not write what the file already says', async () => {
    await files.write('bracket')
    const before = statSync(path()).mtimeMs
    await files.write('bracket')
    expect(writes).toBe(1)
    marks = [pin(1), pin(2)]
    await files.write('bracket')
    expect(writes).toBe(2)
    expect(readFileSync(path(), 'utf8')).toContain('- M2 pin')
    // The time is that of the write that changed it.
    expect(readFileSync(path(), 'utf8').split('\n')[0]).toContain('2026-10-09T04:30:01.000Z')
    expect(statSync(path()).mtimeMs).toBeGreaterThanOrEqual(before)
  })

  it('writes the file of an earlier run again, though it says the same: its time was of that run', async () => {
    await files.write('bracket')
    files.forget() // as a new run: nothing is remembered of what was written
    await files.write('bracket')
    expect(writes).toBe(2)
    expect(readFileSync(path(), 'utf8').split('\n')[0]).toContain('2026-10-09T04:30:01.000Z')
    await files.write('bracket')
    expect(writes).toBe(2)
  })

  it('writes nothing for an object that is not open, or not known', async () => {
    build = undefined
    await files.write('bracket')
    await files.write('nothing')
    expect(writes).toBe(0)
  })

  it('logs a write that fails, and writes the next time', async () => {
    const logged: string[] = []
    let fail = true
    const failing = new StateFiles({
      object: () => obj,
      build: () => OK,
      scene: () => undefined,
      marks: async () => [],
      delayMs: 5,
      log: (message) => logged.push(message),
      write: async () => {
        if (fail) throw new Error('disk full')
        writes += 1
      }
    })
    failing.changed('bracket')
    await vi.waitFor(() => expect(logged).toEqual(['cannot write the state file of bracket: disk full']))
    fail = false
    failing.changed('bracket')
    await vi.waitFor(() => expect(writes).toBe(1))
  })
})

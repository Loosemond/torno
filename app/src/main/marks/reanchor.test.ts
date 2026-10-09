import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, Mark, MarksFile, NewMark } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { KernelError } from '../kernel/client'
import * as file from './file'
import { type NearestAnchor, coalesced, judge, reanchorAll, tolerance } from './reanchor'
import { MarkStore } from './store'

// The real store on a real folder, with its writes counted.
vi.mock('./file', async (importActual) => {
  const actual = await importActual<typeof import('./file')>()
  return { ...actual, saveMarksFile: vi.fn(actual.saveMarksFile) }
})
const saves = vi.mocked(file.saveMarksFile)

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const BASE = { author: 'user', note: '', layout: 'assembly', revision: 1, camera: CAMERA } as const
const ON_TOP: Anchor = { point: [5, 3, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F4', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }
const ON_POST: Anchor = { point: [4, 0, 12], normal: [1, 0, 0], part: 'post', ref: 'post/F0', descriptor: 'cylinder, radius 4, axis Z, 502.7 mm²' }

const pin = (anchor: Anchor, more: object = {}): NewMark => ({ ...BASE, kind: 'pin', anchor, ...more }) as NewMark
const arrow = (from: Anchor): NewMark => ({ ...BASE, kind: 'arrow', from, to: [0, 0, 40] }) as NewMark
const pick = (target: 'face' | 'edge' | 'part', anchor: Anchor): NewMark => ({ ...BASE, kind: 'pick', target, anchor }) as NewMark
const shape = (anchor?: Anchor): NewMark =>
  ({ ...BASE, kind: 'shape', shape: 'box', intent: 'add', position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [10, 10, 10], ...(anchor ? { anchor } : {}) }) as NewMark

/** A scene with the parts named, each `layout:name`, in a box of the size given (40 × 30 × 5 unless said). */
function sceneOf(keys: string[], sizes: Record<string, [number, number, number]> = {}): Scene {
  const parts = keys.map((key) => {
    const [layout, name] = key.split(':')
    const [x, y, z] = sizes[key] ?? [40, 30, 5]
    return { key, name, layout, bbox: { min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] } }
  })
  return { model: 'm.py', layouts: [...new Set(parts.map((p) => p.layout))], parts, seconds: 0, output: '' } as unknown as Scene
}

const found = (part: string, ref: string, distance: number, more: Partial<Extract<NearestAnchor, { found: true }>> = {}): NearestAnchor => ({
  part,
  found: true,
  point: [0, 0, 0],
  normal: [0, 0, 1],
  ref,
  distance,
  descriptor: `face ${ref}`,
  ...more
})

describe('tolerance', () => {
  it('is half a millimetre, or half a percent of the diagonal of the part when that is more', () => {
    expect(tolerance({ min: [-20, -15, -2.5], max: [20, 15, 2.5] })).toBe(0.5)
    // A box 300 × 400 × 0 has a diagonal of 500.
    expect(tolerance({ min: [0, 0, 0], max: [300, 400, 0] })).toBeCloseTo(2.5, 12)
    expect(tolerance({ min: [0, 0, 0], max: [60, 80, 0] })).toBe(0.5)
    expect(tolerance(undefined)).toBe(0.5)
  })
})

describe('judge', () => {
  it('a part that is gone orphans the anchor, which is kept as it was', () => {
    expect(judge(ON_TOP, { part: 'base', found: false }, 0.5)).toEqual({ anchor: ON_TOP, state: 'orphaned' })
  })

  it('a surface still there is ok: the ref, the normal and the descriptor are those of the face now there, the point the person’s', () => {
    const now = found('base', 'base/F9', 0.2, { point: [5, 3, 2.3], normal: [0, 0.6, 0.8], descriptor: 'plane, 1100 mm²' })
    expect(judge(ON_TOP, now, 0.5)).toEqual({
      anchor: { point: [5, 3, 2.5], normal: [0, 0.6, 0.8], part: 'base', ref: 'base/F9', descriptor: 'plane, 1100 mm²' },
      state: 'ok'
    })
  })

  it('at the tolerance is ok, beyond it drifted, with the same refresh', () => {
    expect(judge(ON_TOP, found('base', 'base/F9', 0.5), 0.5).state).toBe('ok')
    expect(judge(ON_TOP, found('base', 'base/F9', 0.51), 0.5)).toEqual({
      anchor: { point: [5, 3, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F9', descriptor: 'face base/F9' },
      state: 'drifted'
    })
    expect(judge(ON_TOP, found('base', 'base/F9', 0.51), 2).state).toBe('ok')
  })

  it('says nothing of a normal or a descriptor the kernel could not give: the old ones were of another face', () => {
    const { anchor } = judge(ON_TOP, found('base', 'base/F9', 0, { normal: null, descriptor: null }), 0.5)
    expect(anchor).toEqual({ point: [5, 3, 2.5], part: 'base', ref: 'base/F9' })
  })
})

describe('reanchorAll', () => {
  let root: string
  let dirs: Record<string, string>
  let store: MarkStore
  let changes: Array<{ objectId: string; marks: Mark[] }>
  let scene: Scene | undefined
  let asked: Array<{ objectId: string; name: string; args: Record<string, unknown> }>
  let logged: string[]
  /** What the kernel answers: by default every anchor is where it was, on face F1 of its part. */
  let answer: (name: string, args: Record<string, unknown>) => unknown

  const query = async <T>(objectId: string, name: string, args: object): Promise<T> => {
    asked.push({ objectId, name, args: structuredClone(args) as Record<string, unknown> })
    return answer(name, args as Record<string, unknown>) as T
  }
  const run = (): Promise<void> => reanchorAll({ marks: store, query, scene: () => scene, log: (message) => logged.push(message) }, 'bracket')
  const anchorsOf = (args: Record<string, unknown>) => args.anchors as Array<{ part: string; point: number[] }>
  const still = (args: Record<string, unknown>) => ({ anchors: anchorsOf(args).map(({ part }) => found(part, `${part}/F1`, 0)) })
  const onDisk = (): MarksFile => JSON.parse(readFileSync(join(dirs.bracket, '.torno', 'marks.json'), 'utf8'))
  const byId = async (): Promise<Record<string, Mark>> => Object.fromEntries((await store.list('bracket')).map((m) => [m.id, m]))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'torno-reanchor-'))
    dirs = { bracket: join(root, 'bracket') }
    mkdirSync(dirs.bracket)
    store = new MarkStore({ dirOf: (id) => dirs[id] })
    changes = []
    store.on('changed', (m) => changes.push(m))
    scene = sceneOf(['assembly:base', 'assembly:post', 'print:base'])
    asked = []
    logged = []
    answer = (_name, args) => still(args)
    saves.mockClear()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('asks once per layout, for the anchors of the unresolved marks that are on a part, and writes once', async () => {
    await store.add('bracket', pin(ON_TOP)) // M1
    await store.add('bracket', arrow(ON_POST)) // M2
    await store.add('bracket', pin({ point: [0, 0, 1], part: 'base' }, { layout: 'print' })) // M3
    await store.add('bracket', pin(ON_TOP)) // M4, resolved below
    await store.add('bracket', pin({ point: [90, 0, 0] })) // M5, a point in space
    await store.add('bracket', shape()) // M6, placed in space
    await store.add('bracket', shape({ point: [1, 1, 2.5], part: 'gone' })) // M7
    await store.update('bracket', 'M4', { status: 'resolved' })
    saves.mockClear()
    changes = []
    answer = (_name, args) => ({
      anchors: anchorsOf(args).map(({ part, point }) => {
        if (part === 'gone') return { part, found: false }
        // The top of the base has moved 3 mm up; everything else is where it was.
        return part === 'base' && args.layout === 'assembly' ? found(part, 'base/F7', 3, { point: [point[0], point[1], 5.5] }) : found(part, `${part}/F1`, 0)
      })
    })

    await run()

    expect(asked).toEqual([
      {
        objectId: 'bracket',
        name: 'nearest',
        args: { layout: 'assembly', anchors: [{ part: 'base', point: [5, 3, 2.5] }, { part: 'post', point: [4, 0, 12] }, { part: 'gone', point: [1, 1, 2.5] }] }
      },
      { objectId: 'bracket', name: 'nearest', args: { layout: 'print', anchors: [{ part: 'base', point: [0, 0, 1] }] } }
    ])
    const marks = await byId()
    expect(marks.M1).toMatchObject({ anchorState: 'drifted', anchor: { point: [5, 3, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F7', descriptor: 'face base/F7' } })
    expect(marks.M2).toMatchObject({ anchorState: 'ok', from: { point: [4, 0, 12], part: 'post', ref: 'post/F1', descriptor: 'face post/F1' } })
    expect(marks.M3).toMatchObject({ anchorState: 'ok', anchor: { point: [0, 0, 1], part: 'base', ref: 'base/F1' } })
    // Resolved: not asked about, and left as it was.
    expect(marks.M4).toMatchObject({ status: 'resolved', anchorState: 'ok', anchor: ON_TOP })
    expect(marks.M5).toMatchObject({ anchorState: 'ok', anchor: { point: [90, 0, 0] } })
    expect(marks.M6.anchorState).toBe('ok')
    expect(marks.M7).toMatchObject({ anchorState: 'orphaned', anchor: { point: [1, 1, 2.5], part: 'gone' } })
    expect(saves).toHaveBeenCalledTimes(1)
    expect(changes).toHaveLength(1)
    expect(onDisk().marks).toEqual(Object.values(marks))
    expect(logged).toEqual([])
  })

  it('writes nothing when every mark is as the build has it, and asks nothing when no mark is on a part', async () => {
    await store.add('bracket', pin(ON_TOP))
    await run()
    expect(saves).toHaveBeenCalledTimes(2) // the mark, then its ref: F4 is F1 now
    await run()
    expect(saves).toHaveBeenCalledTimes(2)
    expect(asked).toHaveLength(2)

    await store.update('bracket', 'M1', { status: 'resolved' })
    await store.add('bracket', pin({ point: [90, 0, 0] }))
    asked = []
    saves.mockClear()
    await run()
    expect(asked).toEqual([])
    expect(saves).not.toHaveBeenCalled()
  })

  it('a mark that comes back to its surface, or whose part comes back, is ok again', async () => {
    await store.add('bracket', pin(ON_TOP))
    await store.add('bracket', pin(ON_POST))
    answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => (part === 'post' ? { part, found: false } : found(part, 'base/F7', 3))) })
    scene = sceneOf(['assembly:base'])
    await run()
    expect((await store.list('bracket')).map((m) => m.anchorState)).toEqual(['drifted', 'orphaned'])
    // The lost part's anchor still names it, so that it is found again.
    expect((await byId()).M2).toMatchObject({ anchor: ON_POST })

    answer = (_name, args) => still(args)
    scene = sceneOf(['assembly:base', 'assembly:post'])
    await run()
    const marks = await byId()
    expect(marks.M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/F1' } })
    expect(marks.M2).toMatchObject({ anchorState: 'ok', anchor: { ref: 'post/F1' } })
  })

  it('the tolerance is that of the part the anchor is on, in the layout of the mark', async () => {
    scene = sceneOf(['assembly:base', 'assembly:post'], { 'assembly:base': [300, 400, 0] }) // tolerance 2.5
    await store.add('bracket', pin(ON_TOP))
    await store.add('bracket', pin(ON_POST))
    answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => found(part, `${part}/F1`, 2)) })
    await run()
    expect((await store.list('bracket')).map((m) => m.anchorState)).toEqual(['ok', 'drifted'])
  })

  it('marks of a layout the build no longer has are orphaned, without asking', async () => {
    await store.add('bracket', pin(ON_TOP, { layout: 'exploded' }))
    await store.add('bracket', pin({ point: [1, 1, 1] }, { layout: 'exploded' }))
    await run()
    expect(asked).toEqual([])
    const marks = await byId()
    expect(marks.M1).toMatchObject({ anchorState: 'orphaned', anchor: ON_TOP })
    expect(marks.M2.anchorState).toBe('ok')
  })

  it('a query that fails leaves the marks untouched, and is said once', async () => {
    await store.add('bracket', pin(ON_TOP))
    await store.add('bracket', pin(ON_POST))
    await store.add('bracket', pin({ point: [0, 0, 1], part: 'base' }, { layout: 'print' }))
    const before = await store.list('bracket')
    saves.mockClear()
    answer = () => {
      throw new KernelError('timeout', 'the query was not answered within 30 s')
    }
    await expect(run()).resolves.toBeUndefined()
    expect(await store.list('bracket')).toEqual(before)
    expect(saves).not.toHaveBeenCalled()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('bracket')
    expect(logged[0]).toContain('the query was not answered within 30 s')
  })

  it('a layout whose query fails does not keep the marks of another from being checked', async () => {
    await store.add('bracket', pin(ON_TOP))
    await store.add('bracket', pin({ point: [0, 0, 1], part: 'base', ref: 'base/F0' }, { layout: 'print' }))
    saves.mockClear()
    answer = (_name, args) => {
      if (args.layout === 'assembly') throw new KernelError('exception', 'no nearest point on assembly:base could be computed')
      return still(args)
    }
    await run()
    const marks = await byId()
    expect(marks.M1).toMatchObject({ anchorState: 'ok', anchor: ON_TOP })
    expect(marks.M2).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/F1' } })
    expect(saves).toHaveBeenCalledTimes(1)
    expect(logged).toHaveLength(1)
  })

  it('an answer that is not one per anchor is a failure: nothing is guessed from it', async () => {
    await store.add('bracket', pin(ON_TOP))
    await store.add('bracket', pin(ON_POST))
    saves.mockClear()
    for (const reply of [{ anchors: [found('base', 'base/F1', 0)] }, { anchors: [found('post', 'post/F1', 0), found('base', 'base/F1', 0)] }, {}, null]) {
      answer = () => reply
      await run()
    }
    expect(saves).not.toHaveBeenCalled()
    expect(logged).toHaveLength(4)
  })

  it('drops what it found when a newer build arrived meanwhile, and does nothing for an object with no build', async () => {
    await store.add('bracket', pin(ON_TOP))
    saves.mockClear()
    answer = (_name, args) => {
      scene = sceneOf(['assembly:base']) // the next build succeeded while the kernel was asked
      return still(args)
    }
    await run()
    expect(saves).not.toHaveBeenCalled()
    expect((await store.list('bracket'))[0]).toMatchObject({ anchor: ON_TOP })

    // The same when the query failed because of it: there is nothing to say.
    answer = () => {
      scene = sceneOf(['assembly:base'])
      throw new KernelError('cancelled', 'a newer build replaced the one this query was sent to')
    }
    await run()
    expect(logged).toEqual([])

    scene = undefined
    asked = []
    await run()
    expect(asked).toEqual([])
  })

  describe('a pick', () => {
    const EDGE: Anchor = { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', descriptor: 'line, 30 mm' }
    const edgeAt = (center: [number, number, number], length = 30) => ({ kind: 'edge', ref: 'assembly:base/E5', type: 'line', length, center, descriptor: `line, ${length} mm` })

    it('of a face is refreshed as a pin is', async () => {
      await store.add('bracket', pick('face', ON_TOP))
      await run()
      expect(asked.map((q) => q.name)).toEqual(['nearest'])
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/F1', descriptor: 'face base/F1' } })
    })

    it('of a whole part stays a pick of the part, described as it now is', async () => {
      await store.add('bracket', pick('part', { point: [5, 3, 2.5], part: 'base', ref: 'base', descriptor: 'part, 40 × 30 × 5 mm, 6000 mm³, 6 faces' }))
      answer = (name, args) => (name === 'describe' ? { kind: 'part', key: 'assembly:base', descriptor: 'part, 40 × 30 × 8 mm, 9600 mm³, 10 faces' } : still(args))
      await run()
      expect(asked[1]).toEqual({ objectId: 'bracket', name: 'describe', args: { ref: 'assembly:base' } })
      expect((await byId()).M1).toMatchObject({
        anchorState: 'ok',
        anchor: { point: [5, 3, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base', descriptor: 'part, 40 × 30 × 8 mm, 9600 mm³, 10 faces' }
      })
    })

    it('of an edge keeps its ref while that edge is still there, where the mark is', async () => {
      await store.add('bracket', pick('edge', EDGE))
      answer = (name, args) => (name === 'describe' ? edgeAt([20, 0, 2.5]) : still(args))
      await run()
      expect(asked[1]).toEqual({ objectId: 'bracket', name: 'describe', args: { ref: 'assembly:base/E5' } })
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', descriptor: 'line, 30 mm' } })
    })

    it('of an edge the build no longer has falls back to the face now nearest, and is drifted', async () => {
      await store.add('bracket', pick('edge', EDGE))
      answer = (name, args) => {
        if (name === 'describe') throw new KernelError('bad_ref', 'assembly:base has 4 edges, E0 to E3; there is no E5')
        return still(args)
      }
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { point: [20, 3, 2.5], part: 'base', ref: 'base/F1', descriptor: 'face base/F1' } })
      expect(logged).toEqual([])
    })

    it('of an edge whose number is now that of an edge somewhere else falls back as well', async () => {
      await store.add('bracket', pick('edge', EDGE))
      // E5 is now a 30 mm edge on the other side of the plate: the mark cannot be on it.
      answer = (name, args) => (name === 'describe' ? edgeAt([-20, 0, 2.5]) : still(args))
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { ref: 'base/F1' } })

      // And when the ref now names something that is no edge at all.
      await store.add('bracket', pick('edge', EDGE))
      answer = (name, args) => (name === 'describe' ? { kind: 'face', ref: 'assembly:base/E5', descriptor: 'plane' } : still(args))
      await run()
      expect((await byId()).M2).toMatchObject({ anchorState: 'drifted', anchor: { ref: 'base/F1' } })
    })

    it('whose edge could not be asked about is left untouched, and that is said', async () => {
      await store.add('bracket', pick('edge', EDGE))
      await store.add('bracket', pin(ON_TOP))
      answer = (name, args) => {
        if (name === 'describe') throw new KernelError('timeout', 'the query was not answered within 30 s')
        return still(args)
      }
      await run()
      const marks = await byId()
      expect(marks.M1).toMatchObject({ anchorState: 'ok', anchor: EDGE })
      expect(marks.M2).toMatchObject({ anchor: { ref: 'base/F1' } })
      expect(logged).toHaveLength(1)
    })

    it('whose part is gone is orphaned, and nothing more is asked about it', async () => {
      await store.add('bracket', pick('edge', EDGE))
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => ({ part, found: false })) })
      await run()
      expect(asked.map((q) => q.name)).toEqual(['nearest'])
      expect((await byId()).M1).toMatchObject({ anchorState: 'orphaned', anchor: EDGE })
    })
  })
})

describe('coalesced', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('runs one at a time per object, and once more for whatever was asked meanwhile', async () => {
    const started: string[] = []
    const release: Array<() => void> = []
    const again = coalesced(
      (id) =>
        new Promise<void>((resolve) => {
          started.push(id)
          release.push(resolve)
        }),
      () => {}
    )
    again('a')
    again('a')
    again('a')
    again('b')
    await settle()
    expect(started).toEqual(['a', 'b']) // the second and third of a wait for the first, as one
    release[0]()
    await settle()
    expect(started).toEqual(['a', 'b', 'a'])
    release[2]()
    await settle()
    expect(started).toEqual(['a', 'b', 'a'])
    again('a')
    await settle()
    expect(started).toEqual(['a', 'b', 'a', 'a'])
  })

  it('a run that fails is said, rejects nothing, and does not stop the next', async () => {
    const said: string[] = []
    let runs = 0
    const again = coalesced(
      async (id) => {
        runs += 1
        if (runs === 1) throw new Error(`cannot write the marks of ${id}`)
      },
      (message) => said.push(message)
    )
    again('a')
    await settle()
    expect(said).toEqual(['cannot re-anchor the marks of a: cannot write the marks of a'])
    again('a')
    await settle()
    expect(runs).toBe(2)
    expect(said).toHaveLength(1)
  })
})

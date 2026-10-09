import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, ArrowMark, Mark, MarksFile, NewMark, PinMark, ShapeMark, StrokeMark } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { KernelError } from '../kernel/client'
import * as file from './file'
import { type FoundAnchor, RETRY_AFTER_MS, asPlaced, coalesced, followMarks, judge, judgePin, reanchorAll, retrying, tolerance } from './reanchor'
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

const found = (part: string, ref: string, distance: number, more: { point?: [number, number, number]; normal?: [number, number, number] | null; descriptor?: string | null } = {}): FoundAnchor => ({
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
  /** The revision of the build `scene` is of. */
  let revision: number
  const last = (): { revision: number; scene: Scene } | undefined => (scene ? { revision, scene } : undefined)
  let asked: Array<{ objectId: string; name: string; args: Record<string, unknown> }>
  let logged: string[]
  /** What the kernel answers: by default every anchor is where it was, on face F1 of its part. */
  let answer: (name: string, args: Record<string, unknown>) => unknown

  const query = async <T>(objectId: string, name: string, args: object): Promise<T> => {
    asked.push({ objectId, name, args: structuredClone(args) as Record<string, unknown> })
    return answer(name, args as Record<string, unknown>) as T
  }
  const run = (): Promise<boolean> => reanchorAll({ marks: store, query, scene: last, log: (message) => logged.push(message) }, 'bracket')
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
    revision = 1
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

  describe('a stroke on the surface', () => {
    const stroke = (points: Array<[number, number, number]>, more: object = {}): NewMark =>
      ({ ...BASE, kind: 'stroke', space: 'surface', anchor: { ...ON_TOP, point: points[0] }, points, ...more }) as NewMark
    const line = (count: number): Array<[number, number, number]> => Array.from({ length: count }, (_, i) => [i, 0, 2.5])

    it('is asked about at its first point and at eight more along it, against every part of its layout', async () => {
      await store.add('bracket', stroke(line(17)))
      await run()
      const anchors = anchorsOf(asked[0].args)
      expect(anchors[0]).toEqual({ part: 'base', point: [0, 0, 2.5] })
      expect(anchors.slice(1).map((a) => `${a.part}@${a.point[0]}`)).toEqual([2, 4, 6, 8, 10, 12, 14, 16].flatMap((x) => [`base@${x}`, `post@${x}`]))
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/F1' } })
    })

    it('has drifted when a point along it is on no surface any more, though its first point is', async () => {
      await store.add('bracket', stroke(line(5)))
      // A pocket was cut under the far half of it.
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part, point }) => found(part, `${part}/F1`, point[0] >= 3 ? 4 : 0)) })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { point: [0, 0, 2.5], ref: 'base/F1' } })
      // And is ok again when the surface is back under all of it.
      answer = (_name, args) => still(args)
      await run()
      expect((await byId()).M1.anchorState).toBe('ok')
    })

    it('is ok where it runs from the part it began on onto another', async () => {
      await store.add('bracket', stroke(line(5)))
      // Its far half is on the post, well away from the base.
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part, point }) => found(part, `${part}/F1`, (part === 'post') === point[0] >= 3 ? 0 : 9)) })
      await run()
      expect((await byId()).M1.anchorState).toBe('ok')
    })

    it('is orphaned with its part, whatever its other points are on', async () => {
      await store.add('bracket', stroke(line(5), { anchor: { point: [0, 0, 2.5], part: 'gone' } }))
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => (part === 'gone' ? { part, found: false } : found(part, `${part}/F1`, 0))) })
      await run()
      expect((await byId()).M1.anchorState).toBe('orphaned')
    })

    it('on a plane is asked about at its anchor only', async () => {
      await store.add('bracket', { ...BASE, kind: 'stroke', space: 'plane', anchor: ON_TOP, plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 0.0' }, points2d: [[0, 0], [5, 5], [9, 0]] } as NewMark)
      await run()
      expect(anchorsOf(asked[0].args)).toEqual([{ part: 'base', point: ON_TOP.point }])
    })
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
    // Nothing to ask of a point in space: one write says it was checked against this build, and then none.
    expect(saves).toHaveBeenCalledTimes(1)
    await run()
    expect(saves).toHaveBeenCalledTimes(1)
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
    await expect(run()).resolves.toBe(false)
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

  describe('while the kernel is answering', () => {
    const THERE: Anchor = { point: [-10, 8, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F4', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' }

    it('a pin put somewhere else stays where it was put, and is checked there by the run that follows', async () => {
      await store.add('bracket', pin(ON_TOP))
      let first = true
      answer = async (_name, args) => {
        // The answer is of where the pin was when the kernel was asked.
        const reply = { anchors: anchorsOf(args).map(({ part }) => found(part, 'base/F9', 3)) }
        if (first) {
          first = false
          await store.replace('bracket', 'M1', { anchor: THERE, revision: 1, camera: CAMERA } as never)
        }
        return reply
      }
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: THERE })
      expect((await byId()).M1).not.toHaveProperty('checkedRevision')

      answer = (_name, args) => still(args)
      await run()
      expect(anchorsOf(asked.at(-1)!.args)).toEqual([{ part: 'base', point: [-10, 8, 2.5] }])
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', checkedRevision: 1, anchor: { point: [-10, 8, 2.5], ref: 'base/F1' } })
    })

    it('an arrow put somewhere else keeps its start and its end together', async () => {
      await store.add('bracket', arrow(ON_POST)) // to [0, 0, 40]: by (-4, 0, 28)
      answer = async (_name, args) => {
        const reply = still(args)
        await store.replace('bracket', 'M1', { anchor: THERE, revision: 1, camera: CAMERA } as never)
        return reply
      }
      await run()
      const moved = (await byId()).M1 as ArrowMark
      expect(moved.from).toEqual(THERE)
      expect(moved.to).toEqual([-14, 8, 30.5])
    })

    it('a mark that was not touched is still written, beside one that was', async () => {
      await store.add('bracket', pin(ON_TOP))
      await store.add('bracket', pin(ON_POST))
      answer = async (_name, args) => {
        const reply = still(args)
        await store.replace('bracket', 'M1', { anchor: THERE, revision: 1, camera: CAMERA } as never)
        return reply
      }
      await run()
      const marks = await byId()
      expect(marks.M1).toMatchObject({ anchor: THERE })
      expect(marks.M2).toMatchObject({ checkedRevision: 1, anchor: { ref: 'post/F1' } })
    })
  })

  describe('in a layout whose parts are spread', () => {
    /** The scene of a print layout: the base where the model put it, the post moved along X by `dx`. */
    const spreadBy = (dx: number): Scene => {
      const made = sceneOf(['print:base', 'print:post'])
      made.parts[1].arranged = [dx, 0, 0]
      return made
    }
    const PRINT = { layout: 'print' }
    /** On the post, as placed on a build that had it moved 50 mm: main says so in the anchor. */
    const ON_SPREAD: Anchor = { point: [54, 0, 12], normal: [1, 0, 0], part: 'post', ref: 'post/F0', arranged: [50, 0, 0] }

    beforeEach(() => {
      scene = spreadBy(50)
    })

    /** The next build: the base is 5 mm wider, so the post is set 5 mm further along. */
    const widen = async (): Promise<void> => {
      await run()
      scene = spreadBy(55)
      revision = 2
      asked = []
      await run()
    }

    it('a pin stays where it was put on its part when an earlier part grows: it moves with the part, and is asked about there', async () => {
      await store.add('bracket', pin(ON_SPREAD, PRINT))
      await widen()
      expect(anchorsOf(asked[0].args)).toEqual([{ part: 'post', point: [59, 0, 12] }])
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', checkedRevision: 2, anchor: { point: [59, 0, 12], part: 'post', ref: 'post/F1', arranged: [55, 0, 0] } })
      // And not again for the same build.
      saves.mockClear()
      await run()
      expect(saves).not.toHaveBeenCalled()
    })

    it('an arrow moves whole: its start and its end', async () => {
      await store.add('bracket', { ...arrow(ON_SPREAD), ...PRINT } as NewMark)
      await widen()
      const moved = (await byId()).M1 as ArrowMark
      expect(moved.from.point).toEqual([59, 0, 12])
      expect(moved.to).toEqual([5, 0, 40])
    })

    it('a stroke on the surface moves with every point, and is asked about where they now are', async () => {
      const points = [ON_SPREAD.point, [54, 1, 13], [54, 2, 14]]
      await store.add('bracket', { ...BASE, ...PRINT, kind: 'stroke', space: 'surface', anchor: ON_SPREAD, points } as NewMark)
      await widen()
      const moved = (await byId()).M1 as StrokeMark
      expect(moved.points).toEqual([[59, 0, 12], [59, 1, 13], [59, 2, 14]])
      expect(moved.anchor.point).toEqual([59, 0, 12])
      expect(anchorsOf(asked[0].args).map((a) => a.point)).toContainEqual([59, 2, 14])
    })

    it('a stroke on a plane that began on a part moves its plane, and keeps its points on it', async () => {
      const plane = { origin: [54, 0, 12], x: [0, 1, 0], y: [0, 0, 1], label: 'YZ at x = 54.0' }
      await store.add('bracket', { ...BASE, ...PRINT, kind: 'stroke', space: 'plane', anchor: ON_SPREAD, plane, points2d: [[0, 0], [3, 4]] } as NewMark)
      await widen()
      const moved = (await byId()).M1 as StrokeMark
      expect(moved.plane?.origin).toEqual([59, 0, 12])
      expect(moved.points2d).toEqual([[0, 0], [3, 4]])
    })

    it('a shape tied to a part moves with it; one placed in space, and a profile begun in space, stay', async () => {
      await store.add('bracket', { ...shape(ON_SPREAD), ...PRINT, position: [60, 0, 20] } as NewMark)
      await store.add('bracket', { ...shape(), ...PRINT, position: [60, 0, 20] } as NewMark)
      const plane = { origin: [90, 0, 0], x: [0, 1, 0], y: [0, 0, 1], label: 'YZ at x = 90.0' }
      await store.add('bracket', { ...BASE, ...PRINT, kind: 'stroke', space: 'plane', anchor: { point: [90, 0, 0] }, plane, points2d: [[0, 0]] } as NewMark)
      await widen()
      const marks = await byId()
      expect(marks.M1).toMatchObject({ position: [65, 0, 20], anchor: { point: [59, 0, 12], arranged: [55, 0, 0] } })
      expect((marks.M2 as ShapeMark).position).toEqual([60, 0, 20])
      expect((marks.M3 as StrokeMark).plane?.origin).toEqual([90, 0, 0])
      expect(marks.M3).toMatchObject({ checkedRevision: 2 })
    })

    it('a shape dragged while the kernel was answering is moved from where it was dragged to', async () => {
      await store.add('bracket', { ...shape(ON_SPREAD), ...PRINT, position: [60, 0, 20] } as NewMark)
      await run()
      scene = spreadBy(55)
      revision = 2
      answer = async (_name, args) => {
        const reply = still(args)
        await store.update('bracket', 'M1', { position: [60, 7, 20] })
        return reply
      }
      await run()
      expect((await byId()).M1).toMatchObject({ position: [65, 7, 20], anchor: { point: [59, 0, 12] } })
    })

    it('a part no longer spread takes its marks back with it, and says it is not spread', async () => {
      await store.add('bracket', pin(ON_SPREAD, PRINT))
      await run()
      scene = sceneOf(['print:base', 'print:post'])
      revision = 2
      await run()
      const back = (await byId()).M1 as PinMark
      expect(back.anchor.point).toEqual([4, 0, 12])
      expect(back.anchor.arranged).toEqual([0, 0, 0])
      // And out again by all of it, though the part had been where the model put it.
      scene = spreadBy(20)
      revision = 3
      await run()
      expect(((await byId()).M1 as PinMark).anchor).toMatchObject({ point: [24, 0, 12], arranged: [20, 0, 0] })
    })

    it('a mark whose part is gone stays where it is, and moves by all that changed when the part is back', async () => {
      await store.add('bracket', pin(ON_SPREAD, PRINT))
      await run()
      scene = sceneOf(['print:base'])
      revision = 2
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => ({ part, found: false })) })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'orphaned', anchor: { point: [54, 0, 12], arranged: [50, 0, 0] } })
      scene = spreadBy(62)
      revision = 3
      answer = (_name, args) => still(args)
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { point: [66, 0, 12], arranged: [62, 0, 0] } })
    })

    it('a mark from before spreads were recorded is taken to be where it is: it is not moved by the whole spread', async () => {
      const { arranged: _none, ...legacy } = ON_SPREAD
      await store.add('bracket', pin(legacy, PRINT))
      await run()
      expect((await byId()).M1).toMatchObject({ checkedRevision: 1, anchor: { point: [54, 0, 12], arranged: [50, 0, 0] } })
      // From then on it moves with its part like any other.
      scene = spreadBy(55)
      revision = 2
      await run()
      expect((await byId()).M1).toMatchObject({ anchor: { point: [59, 0, 12], arranged: [55, 0, 0] } })
    })

    it('a mark checked in an earlier run moves by what changed since, though this run has not checked it yet', async () => {
      await store.add('bracket', pin(ON_SPREAD, PRINT))
      await run()
      // torno is started again: what the file says of the check is of another run, and the model changed meanwhile.
      store = new MarkStore({ dirOf: (id) => dirs[id] })
      expect((await store.list('bracket'))[0]).not.toHaveProperty('checkedRevision')
      scene = spreadBy(58)
      await run()
      expect((await byId()).M1).toMatchObject({ checkedRevision: 1, anchor: { point: [62, 0, 12], arranged: [58, 0, 0] } })
    })

    it('a query that fails moves nothing: the mark is moved when it can be judged where it would be', async () => {
      await store.add('bracket', pin(ON_SPREAD, PRINT))
      await run()
      scene = spreadBy(55)
      revision = 2
      answer = () => {
        throw new KernelError('timeout', 'the query was not answered within 30 s')
      }
      await run()
      expect((await byId()).M1).toMatchObject({ checkedRevision: 1, anchor: { point: [54, 0, 12], arranged: [50, 0, 0] } })
    })
  })

  describe('what was checked', () => {
    it('every open mark says which build it was checked against, also one that is on no part', async () => {
      await store.add('bracket', pin(ON_TOP))
      await store.add('bracket', pin({ point: [90, 0, 0] }))
      await store.add('bracket', pin(ON_TOP, { layout: 'exploded' }))
      revision = 12
      expect(await run()).toBe(true)
      expect((await store.list('bracket')).map((m) => m.checkedRevision)).toEqual([12, 12, 12])
      // The next build, in which nothing moved: one write says they were checked against it.
      revision = 13
      scene = sceneOf(['assembly:base', 'assembly:post', 'print:base'])
      saves.mockClear()
      await run()
      expect(saves).toHaveBeenCalledTimes(1)
      expect((await store.list('bracket')).map((m) => m.checkedRevision)).toEqual([13, 13, 13])
    })

    it('marks of a layout whose query failed stay as checked against the build before', async () => {
      await store.add('bracket', pin(ON_TOP))
      await store.add('bracket', pin({ point: [0, 0, 1], part: 'base' }, { layout: 'print' }))
      await run()
      revision = 2
      answer = (_name, args) => {
        if (args.layout === 'assembly') throw new KernelError('timeout', 'the query was not answered within 30 s')
        return still(args)
      }
      expect(await run()).toBe(false)
      expect((await store.list('bracket')).map((m) => m.checkedRevision)).toEqual([1, 2])
    })

    it('an anchor the kernel could not answer for leaves its mark unchecked, and the others are checked', async () => {
      await store.add('bracket', pin(ON_TOP))
      await store.add('bracket', pin(ON_POST))
      answer = (_name, args) => ({
        anchors: anchorsOf(args).map(({ part }) => (part === 'post' ? { part, found: true, error: 'the point of assembly:post nearest to the anchor is on none of its faces' } : found(part, 'base/F1', 0)))
      })
      expect(await run()).toBe(false)
      const marks = await byId()
      expect(marks.M1).toMatchObject({ checkedRevision: 1, anchor: { ref: 'base/F1' } })
      expect(marks.M2).toMatchObject({ anchorState: 'ok', anchor: ON_POST })
      expect(marks.M2).not.toHaveProperty('checkedRevision')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('M2: the point of assembly:post nearest to the anchor is on none of its faces')
    })

    it('a stroke with a point the kernel could not answer for is left unchecked, not said to have drifted', async () => {
      const points = [ON_TOP.point, [6, 3, 2.5], [7, 3, 2.5]]
      scene = sceneOf(['assembly:base'])
      await store.add('bracket', { ...BASE, kind: 'stroke', space: 'surface', anchor: ON_TOP, points } as NewMark)
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part, point }) => (point[0] === 7 ? { part, found: true, error: 'no nearest point' } : found(part, 'base/F1', 0))) })
      expect(await run()).toBe(false)
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok' })
      expect((await byId()).M1).not.toHaveProperty('checkedRevision')
    })
  })

  describe('a pin on an edge', () => {
    const ON_EDGE: Anchor = { point: [20, 3, 2.5], part: 'base', ref: 'base/E5' }
    const edge = (more: object): ((name: string, args: Record<string, unknown>) => unknown) => (_name, args) => ({
      anchors: anchorsOf(args).map(({ part }) => ({ ...found(part, 'base/F1', 0), ...more }))
    })

    it('placed on an edge names it to the kernel, and keeps it with the faces it is between', async () => {
      await store.add('bracket', pin(ON_EDGE))
      answer = edge({ support: 'face', edgeFound: true, edgeDistance: 0.02, edgeDescriptor: 'line, 30 mm', edgeBetween: ['base/F1', 'base/F4'] })
      await run()
      expect(anchorsOf(asked[0].args)).toEqual([{ part: 'base', point: [20, 3, 2.5], edge: 'base/E5' }])
      const kept = (await byId()).M1 as PinMark
      expect(kept.anchorState).toBe('ok')
      expect(kept.anchor).toEqual({ point: [20, 3, 2.5], part: 'base', ref: 'base/E5', edge: 'base/E5', between: ['base/F1', 'base/F4'], descriptor: 'line, 30 mm', arranged: [0, 0, 0] })
    })

    it('follows the edge to its new number when the kernel finds the point on another', async () => {
      await store.add('bracket', pin({ ...ON_EDGE, edge: 'base/E5', between: ['base/F1', 'base/F4'] }))
      answer = edge({ edgeFound: true, edgeDistance: 12, edgeDescriptor: 'line, 30 mm', edgeBetween: ['base/F0', 'base/F2'], support: 'edge', edgeUnder: 'base/E9', edgeUnderDescriptor: 'line, 31 mm', between: ['base/F1', 'base/F6'] })
      await run()
      expect(((await byId()).M1 as PinMark).anchor).toEqual({ point: [20, 3, 2.5], part: 'base', ref: 'base/E9', edge: 'base/E9', between: ['base/F1', 'base/F6'], descriptor: 'line, 31 mm', arranged: [0, 0, 0] })
    })

    it('is on the edge the kernel found its point on, when that is another than the one it names and both are close', async () => {
      // The two edges of a 0.4 mm chamfer: the one it names is within the tolerance, and the point is on the other.
      await store.add('bracket', pin({ ...ON_EDGE, edge: 'base/E5', between: ['base/F1', 'base/F4'] }))
      answer = edge({ edgeFound: true, edgeDistance: 0.4, edgeDescriptor: 'line, 30 mm', edgeBetween: ['base/F1', 'base/F4'], support: 'edge', edgeUnder: 'base/E9', edgeUnderDescriptor: 'line, 29.2 mm', between: ['base/F4', 'base/F6'] })
      await run()
      const kept = (await byId()).M1 as PinMark
      expect(kept.anchorState).toBe('ok')
      expect(kept.anchor).toEqual({ point: [20, 3, 2.5], part: 'base', ref: 'base/E9', edge: 'base/E9', between: ['base/F4', 'base/F6'], descriptor: 'line, 29.2 mm', arranged: [0, 0, 0] })
    })

    it('stays on the edge it names when the kernel found its point on that one, or on a face beside it', () => {
      const named: Anchor = { ...ON_EDGE, edge: 'base/E5' }
      const near = { ...found('base', 'base/F1', 0), edgeFound: true as const, edgeDistance: 0.4, edgeDescriptor: 'line, 30 mm', edgeBetween: ['base/F1', 'base/F4'] }
      const onIt = { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', edge: 'base/E5', between: ['base/F1', 'base/F4'], descriptor: 'line, 30 mm' }
      expect(judgePin(named, { ...near, support: 'edge', edgeUnder: 'base/E5', edgeUnderDescriptor: 'line, 30 mm', between: ['base/F1', 'base/F4'] }, 0.5)).toEqual({ anchor: onIt, state: 'ok' })
      expect(judgePin(named, { ...near, support: 'face' }, 0.5)).toEqual({ anchor: onIt, state: 'ok' })
    })

    it('has drifted when no edge is under it any more, and keeps the edge it was put on', async () => {
      await store.add('bracket', pin(ON_EDGE))
      answer = edge({ support: 'face', edgeFound: false })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: ON_EDGE })
    })

    it('a pin whose point the kernel finds on an edge is on that edge, though it named none', async () => {
      await store.add('bracket', pin(ON_TOP))
      answer = edge({ support: 'edge', edgeUnder: 'base/E2', edgeUnderDescriptor: 'circle, radius 4, 25.13 mm', between: ['base/F4'] })
      await run()
      // A seam, or the rim of a hole in one face: there are not two faces to name.
      expect(((await byId()).M1 as PinMark).anchor).toEqual({ point: [5, 3, 2.5], part: 'base', ref: 'base/E2', edge: 'base/E2', descriptor: 'circle, radius 4, 25.13 mm', arranged: [0, 0, 0] })
    })

    it('judgePin leaves a pin on a face as judge does', () => {
      expect(judgePin(ON_TOP, found('base', 'base/F9', 0.2), 0.5)).toEqual(judge(ON_TOP, found('base', 'base/F9', 0.2), 0.5))
    })
  })

  describe('a pick', () => {
    const EDGE: Anchor = { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', descriptor: 'line, 30 mm' }

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

    /** `nearest` with every anchor on face F1 of its part, and those that name an edge told this of it. */
    const withEdge = (edge: object) => (_name: string, args: Record<string, unknown>) => ({
      anchors: (args.anchors as Array<{ part: string; edge?: string }>).map(({ part, edge: named }) => ({ ...found(part, `${part}/F1`, 0), ...(named ? edge : {}) }))
    })

    it('of an edge asks how far its point is from that edge, and keeps the ref while it is on it', async () => {
      await store.add('bracket', pick('edge', EDGE))
      await store.add('bracket', pin(ON_TOP))
      asked = []
      answer = withEdge({ edgeFound: true, edgeDistance: 0.2, edgeDescriptor: 'line, 28 mm' })
      await run()
      // One query: the edge goes with the anchor, and only with the anchor of a pick of an edge.
      expect(asked).toEqual([
        { objectId: 'bracket', name: 'nearest', args: { layout: 'assembly', anchors: [{ part: 'base', point: [20, 3, 2.5], edge: 'base/E5' }, { part: 'base', point: [5, 3, 2.5] }] } }
      ])
      // Nothing but the descriptor is touched: an edge has no one normal to be given.
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ...EDGE, descriptor: 'line, 28 mm' } })
      expect((await byId()).M1).not.toHaveProperty('anchor.normal')
    })

    it('of an edge whose number now belongs to a like edge a few millimetres away is drifted, though the point is on the surface', async () => {
      await store.add('bracket', pick('edge', EDGE))
      // The same "line, 30 mm", parallel and 2 mm off: nothing but the distance tells them apart.
      answer = withEdge({ edgeFound: true, edgeDistance: 2, edgeDescriptor: 'line, 30 mm' })
      await run()
      const mark = (await byId()).M1
      expect(mark.anchorState).toBe('drifted')
      // The ref is kept, to be found again; the descriptor says what is under the point now.
      expect(mark).toMatchObject({ anchor: { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', descriptor: 'face base/F1' } })
      expect(mark).not.toHaveProperty('anchor.normal')
      expect(logged).toEqual([])

      // Just within the tolerance, and just beyond it.
      answer = withEdge({ edgeFound: true, edgeDistance: 0.5, edgeDescriptor: 'line, 30 mm' })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/E5', descriptor: 'line, 30 mm' } })
      answer = withEdge({ edgeFound: true, edgeDistance: 0.51, edgeDescriptor: 'line, 30 mm' })
      await run()
      expect((await byId()).M1.anchorState).toBe('drifted')
    })

    it('is on its edge within half a millimetre whatever the size of the part: a chamfer on a 400 mm plate is 1 mm wide', async () => {
      scene = sceneOf(['assembly:base', 'assembly:post'], { 'assembly:base': [300, 400, 0] }) // the surface may be 2.5 mm away
      await store.add('bracket', pick('edge', EDGE))
      // The other edge of a small chamfer: parallel, alike, and well within what the surface is allowed.
      answer = withEdge({ edgeFound: true, edgeDistance: 1.5, edgeDescriptor: 'line, 400 mm' })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { ref: 'base/E5', descriptor: 'face base/F1' } })
      answer = withEdge({ edgeFound: true, edgeDistance: 0.5, edgeDescriptor: 'line, 400 mm' })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/E5', descriptor: 'line, 400 mm' } })
      // The surface keeps the tolerance of the part: 2 mm off it, on the edge, is not drifted.
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => ({ ...found(part, `${part}/F1`, 2), edgeFound: true, edgeDistance: 0.3, edgeDescriptor: 'line, 400 mm' })) })
      await run()
      expect((await byId()).M1.anchorState).toBe('ok')
    })

    it('of an edge the build no longer has is drifted, and is ok again when a build has it back', async () => {
      await store.add('bracket', pick('edge', EDGE))
      answer = withEdge({ edgeFound: false })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { point: [20, 3, 2.5], part: 'base', ref: 'base/E5', descriptor: 'face base/F1' } })

      answer = withEdge({ edgeFound: true, edgeDistance: 0, edgeDescriptor: 'line, 30 mm' })
      await run()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/E5', descriptor: 'line, 30 mm' } })
      expect(asked.every((q) => q.name === 'nearest')).toBe(true)
    })

    it('of an edge that the kernel says nothing of is not taken to be on it', async () => {
      await store.add('bracket', pick('edge', EDGE))
      saves.mockClear()
      for (const edge of [{}, { edgeFound: true }, { edgeFound: true, edgeDistance: 'near' }, { edgeFound: 'yes', edgeDistance: 0 }]) {
        answer = withEdge(edge)
        await run()
      }
      expect(saves).not.toHaveBeenCalled()
      expect((await byId()).M1).toMatchObject({ anchorState: 'ok', anchor: EDGE })
      expect(logged).toHaveLength(4)
    })

    it('of an edge that never had an edge ref gets the face now nearest, and is drifted', async () => {
      await store.add('bracket', pick('edge', { point: [20, 3, 2.5], part: 'base', ref: 'base/F2' }))
      await run()
      expect(anchorsOf(asked[0].args)).toEqual([{ part: 'base', point: [20, 3, 2.5] }])
      expect((await byId()).M1).toMatchObject({ anchorState: 'drifted', anchor: { ref: 'base/F1' } })
    })

    it('of a part that could not be asked about is left untouched, and that is said', async () => {
      const whole: Anchor = { point: [5, 3, 2.5], part: 'base', ref: 'base', descriptor: 'part, 40 × 30 × 5 mm, 6000 mm³, 6 faces' }
      await store.add('bracket', pick('part', whole))
      await store.add('bracket', pin(ON_TOP))
      answer = (name, args) => {
        if (name === 'describe') throw new KernelError('timeout', 'the query was not answered within 30 s')
        return still(args)
      }
      await run()
      const marks = await byId()
      expect(marks.M1).toMatchObject({ anchorState: 'ok', anchor: whole })
      expect(marks.M2).toMatchObject({ anchor: { ref: 'base/F1' } })
      expect(logged).toHaveLength(1)
    })

    it('whose part is gone is orphaned, and nothing more is asked about it', async () => {
      await store.add('bracket', pick('edge', EDGE))
      await store.add('bracket', pick('part', { point: [5, 3, 2.5], part: 'base', ref: 'base' }))
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => ({ part, found: false })) })
      await run()
      expect(asked.map((q) => q.name)).toEqual(['nearest'])
      expect((await byId()).M1).toMatchObject({ anchorState: 'orphaned', anchor: EDGE })
    })
  })

  describe('followed', () => {
    /** The check as main wires it: one at a time, and again for a mark that is added or reopened. */
    const follow = (): void => followMarks(store, coalesced((id) => reanchorAll({ marks: store, query, scene: last, log: (message) => logged.push(message) }, id).then(() => {})))
    const quiet = async (): Promise<void> => {
      // Until a few turns of the loop pass with nothing more asked or written.
      let seen = -1
      while (seen !== asked.length + saves.mock.calls.length) {
        seen = asked.length + saves.mock.calls.length
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    it('a resolved mark that is reopened is checked against the build there is, without another', async () => {
      await store.add('bracket', pin(ON_TOP))
      await store.add('bracket', pin(ON_POST))
      await store.update('bracket', 'M1', { status: 'resolved' })
      await store.update('bracket', 'M2', { status: 'resolved' })
      // Meanwhile the model was rebuilt: the top moved 3 mm, and the post is gone. Nothing asked: both are resolved.
      await run()
      expect(asked).toEqual([])
      answer = (_name, args) => ({ anchors: anchorsOf(args).map(({ part }) => (part === 'post' ? { part, found: false } : found(part, 'base/F7', 3))) })
      follow()

      await store.update('bracket', 'M1', { status: 'draft' })
      await quiet()
      expect((await byId()).M1).toMatchObject({ status: 'draft', anchorState: 'drifted', anchor: { ref: 'base/F7' } })
      await store.update('bracket', 'M2', { status: 'draft' })
      await quiet()
      expect((await byId()).M2).toMatchObject({ status: 'draft', anchorState: 'orphaned', anchor: ON_POST })
      // Once for each reopening, and not again for what the check itself wrote.
      expect(asked).toHaveLength(2)
    })

    it('a mark added while a check is under way is checked by one that follows, and then it stops', async () => {
      follow()
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let first = true
      answer = async (_name, args) => {
        if (first) {
          first = false
          await held
        }
        return still(args)
      }
      await store.add('bracket', pin(ON_TOP))
      await vi.waitFor(() => expect(asked).toHaveLength(1))
      // The check has listed the marks, and is waiting for the kernel.
      await store.add('bracket', pin(ON_POST))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(asked).toHaveLength(1)
      release()
      await quiet()

      expect(asked.map((q) => anchorsOf(q.args).map((a) => a.part))).toEqual([['base'], ['base', 'post']])
      const marks = await byId()
      expect(marks.M1).toMatchObject({ anchorState: 'ok', anchor: { ref: 'base/F1' } })
      expect(marks.M2).toMatchObject({ anchorState: 'ok', anchor: { ref: 'post/F1' } })
      await quiet()
      expect(asked).toHaveLength(2)
    })

    it('nothing else that is done to a mark asks the kernel anything', async () => {
      await store.add('bracket', pin(ON_TOP))
      await run()
      follow()
      asked = []
      await store.update('bracket', 'M1', { note: 'thicker' })
      await store.update('bracket', 'M1', { status: 'sent' })
      await store.markSent('bracket')
      await store.update('bracket', 'M1', { status: 'resolved' })
      await store.reanchor('bracket', [{ id: 'M1', judged: [(await byId()).M1 as PinMark].map((m) => m.anchor), anchors: [ON_POST], anchorState: 'drifted' }])
      await store.remove('bracket', 'M1')
      await quiet()
      expect(asked).toEqual([])
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

describe('asPlaced', () => {
  const scene = sceneOf(['print:base', 'print:post'])
  scene.parts[1].arranged = [50, 0, 0]
  const ON: Anchor = { point: [54, 0, 12], part: 'post', ref: 'post/F0' }

  it('says in the anchor how far its part is spread on the build the mark was placed on, whatever the window said', () => {
    const placed = asPlaced({ ...pin({ ...ON, arranged: [1, 2, 3] }), layout: 'print', revision: 4 } as NewMark, { revision: 4, scene }) as PinMark
    expect(placed.anchor.arranged).toEqual([50, 0, 0])
    // A part that was not moved: said, as zeros.
    const onBase = asPlaced({ ...pin({ point: [0, 0, 1], part: 'base', arranged: [1, 2, 3] }), layout: 'print', revision: 4 } as NewMark, { revision: 4, scene }) as PinMark
    expect(onBase.anchor.arranged).toEqual([0, 0, 0])
    // On no part, or on none the layout has: nothing to say.
    const inSpace = asPlaced({ ...pin({ point: [90, 0, 1], arranged: [1, 2, 3] }), layout: 'print', revision: 4 } as NewMark, { revision: 4, scene }) as PinMark
    expect(inSpace.anchor).toEqual({ point: [90, 0, 1] })
    const onNone = asPlaced({ ...pin({ point: [0, 0, 1], part: 'gone', arranged: [1, 2, 3] }), layout: 'print', revision: 4 } as NewMark, { revision: 4, scene }) as PinMark
    expect(onNone.anchor).not.toHaveProperty('arranged')
    const start = asPlaced({ ...arrow(ON), layout: 'print', revision: 4 } as NewMark, { revision: 4, scene }) as ArrowMark
    expect(start.from.arranged).toEqual([50, 0, 0])
  })

  it('says nothing of it for a mark placed on another build than the last: the first check takes it as it is', () => {
    const placed = asPlaced({ ...pin({ ...ON, arranged: [1, 2, 3] }), layout: 'print', revision: 3 } as NewMark, { revision: 4, scene }) as PinMark
    expect(placed.anchor).not.toHaveProperty('arranged')
    expect((asPlaced({ ...pin(ON), layout: 'print', revision: 3 } as NewMark, undefined) as PinMark).anchor).toEqual(ON)
  })
})

describe('retrying', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A check that fails while `failing`, and the times it ran, in ms since the start. */
  const checker = () => {
    const state = { failing: true, runs: [] as number[] }
    const started = Date.now()
    const check = retrying(async () => {
      state.runs.push(Date.now() - started)
      return !state.failing
    })
    return { state, check }
  }

  it('checks again 2 s, 10 s and 30 s after a check that failed, and then leaves it', async () => {
    expect(RETRY_AFTER_MS).toEqual([2000, 10_000, 30_000])
    const { state, check } = checker()
    check('a')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.runs).toEqual([0, 2000, 12_000, 42_000])
  })

  it('stops once a check has worked', async () => {
    const { state, check } = checker()
    check('a')
    await vi.advanceTimersByTimeAsync(2000)
    state.failing = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.runs).toEqual([0, 2000, 12_000])
  })

  it('a newer build cancels what was waiting, and starts the count again', async () => {
    const { state, check } = checker()
    check('a')
    await vi.advanceTimersByTimeAsync(5000) // ran at 0 and 2000; the next is due at 12000
    check('a')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.runs).toEqual([0, 2000, 5000, 7000, 17_000, 47_000])
  })

  it('counts each object by itself', async () => {
    const runs: string[] = []
    const check = retrying(async (id) => {
      runs.push(id)
      return id === 'b'
    })
    check('a')
    check('b')
    await vi.advanceTimersByTimeAsync(2000)
    expect(runs).toEqual(['a', 'b', 'a'])
  })

  it('cancelled, as when the workspace closes, checks nothing again: not what was waiting, not after a check that was running, not when asked', async () => {
    const { state, check } = checker()
    check('a')
    check('b')
    await vi.advanceTimersByTimeAsync(5000) // each ran at 0 and 2000; the next is due at 12000
    check.cancel()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.runs).toEqual([0, 0, 2000, 2000])
    check('a')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.runs).toHaveLength(4)

    // One that is running when it is cancelled, and fails, is not tried again either.
    let fail = (): void => {}
    const runs: number[] = []
    const slow = retrying(() => {
      runs.push(Date.now())
      return new Promise<boolean>((resolve) => (fail = () => resolve(false)))
    })
    slow('a')
    await vi.advanceTimersByTimeAsync(0)
    slow.cancel()
    fail()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a check that throws is taken as one that failed', async () => {
    const said: string[] = []
    let runs = 0
    const check = retrying(
      async () => {
        runs += 1
        throw new Error('cannot write')
      },
      (message) => said.push(message)
    )
    check('a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(runs).toBe(2)
    expect(said[0]).toBe('cannot re-anchor the marks of a: cannot write')
  })
})

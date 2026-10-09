import { describe, expect, it, vi } from 'vitest'
import type { Anchor, DimensionMark, Mark, Measurement, NewMark } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { KernelError } from '../kernel/client'
import { sanitiseMark } from './file'
import { addDimension, dueAfterEdit, measure, measureDimension, measureRequest, remeasure } from './measure'

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const BASE = { author: 'user', note: '', layout: 'assembly', revision: 3, camera: CAMERA } as const
const TOP: Anchor = { point: [5, 3, 3], normal: [0, 0, 1], part: 'plate', ref: 'plate/F5', descriptor: 'plane, normal +Z, z = 3, 1100 mm²' }
const BOTTOM: Anchor = { point: [5, 3, -3], normal: [0, 0, -1], part: 'plate', ref: 'plate/F0' }
const HOLE: Anchor = { point: [-6, 5, 0], part: 'plate', ref: 'plate/F9' }
const SCENE = { model: 'm.py', layouts: ['assembly'], parts: [], seconds: 0, output: '' } as unknown as Scene

const distance = (more: object = {}): NewMark => ({ ...BASE, kind: 'dimension', measure: 'distance', a: TOP, b: BOTTOM, ...more }) as NewMark
const hole = (more: object = {}): NewMark => ({ ...BASE, kind: 'dimension', measure: 'diameter', a: HOLE, ...more }) as NewMark
const SIX = { kind: 'distance', value: 6.000000000000001, unit: 'mm', how: 'between planes', points: [[5, 3, 3], [5, 3, -3]], exact: true }
const EIGHT = { kind: 'diameter', value: 8, unit: 'mm', how: 'cylinder', points: [[-14, 5, 0], [-6, 5, 0]], exact: true }

/** A kernel that answers `measure` as told, and the build there is. */
function kernel(answer: (args: Record<string, unknown>) => unknown, nearest: (args: Record<string, unknown>) => unknown = () => ({ anchors: [] })) {
  const asked: Array<{ objectId: string; name: string; args: Record<string, unknown> }> = []
  const world = { revision: 3 as number | undefined }
  return {
    asked,
    world,
    query: async <T>(objectId: string, name: string, args: object): Promise<T> => {
      asked.push({ objectId, name, args: structuredClone(args) as Record<string, unknown> })
      return (await (name === 'nearest' ? nearest : answer)(args as Record<string, unknown>)) as T
    },
    scene: () => (world.revision === undefined ? undefined : { revision: world.revision, scene: SCENE })
  }
}

/** The store, as far as a dimension is added to it: what was done to it, in order. */
function marks() {
  const did: string[] = []
  const kept: Mark[] = []
  return {
    did,
    kept,
    list: async (): Promise<Mark[]> => structuredClone(kept),
    add: async (_objectId: string, mark: NewMark, _status?: 'draft' | 'sent', measured?: Measurement): Promise<Mark> => {
      const given = Object.fromEntries(Object.entries(mark).filter(([key]) => !['value', 'how', 'points', 'measuredRevision', 'refused', 'verdict'].includes(key)))
      const added = sanitiseMark({ ...given, ...measured, id: `M${kept.length + 1}`, status: 'draft', anchorState: 'ok', createdAt: '2026-10-09T12:00:00.000Z' })
      if (!added) throw new Error('that is not a mark: its kind is unknown, or a field is missing or not a finite number')
      did.push(`add ${added.id}${measured?.value === undefined ? '' : ` = ${measured.value}`}`)
      kept.push(added)
      return added
    },
    measured: async (_objectId: string, id: string, _of: object, result: Measurement): Promise<Mark | null> => {
      did.push(`measured ${id}${result.value === undefined ? ': nothing' : ` = ${result.value}`}`)
      const at = kept.findIndex((m) => m.id === id)
      if (at < 0) return null
      kept[at] = sanitiseMark({ ...kept[at], ...result })!
      return kept[at]
    },
    remove: async (_objectId: string, id: string): Promise<void> => {
      did.push(`remove ${id}`)
      kept.splice(kept.findIndex((m) => m.id === id), 1)
    }
  }
}

describe('what the kernel is asked of a dimension', () => {
  it('names each end by its ref, with the layout in front, and the point it was put at', () => {
    expect(measureRequest(distance() as DimensionMark)).toEqual({ kind: 'distance', a: { ref: 'assembly:plate/F5', point: [5, 3, 3] }, b: { ref: 'assembly:plate/F0', point: [5, 3, -3] } })
    expect(measureRequest(hole({ layout: 'print' }) as DimensionMark)).toEqual({ kind: 'diameter', a: { ref: 'print:plate/F9', point: [-6, 5, 0] } })
    expect((measureRequest(distance({ a: { point: [1, 2, 3], part: 'plate', ref: 'plate/E4', edge: 'plate/E4' } }) as DimensionMark) as { a: object }).a).toEqual({ ref: 'assembly:plate/E4', point: [1, 2, 3] })
  })

  it('gives an end with no ref as a point of the layout', () => {
    expect(measureRequest(distance({ a: { point: [1, 2, 9.5] } }) as DimensionMark)).toEqual({ kind: 'distance', a: { layout: 'assembly', point: [1, 2, 9.5] }, b: { ref: 'assembly:plate/F0', point: [5, 3, -3] } })
  })

  it('leaves out a second end where the measurement has one', () => {
    expect(measureRequest({ ...(hole() as DimensionMark), b: BOTTOM })).not.toHaveProperty('b')
    expect(measureRequest(distance({ measure: 'thickness' }) as DimensionMark)).toEqual({ kind: 'thickness', a: { ref: 'assembly:plate/F5', point: [5, 3, 3] } })
  })
})

describe('measureDimension', () => {
  it('asks the kernel about the object, and keeps the value in full, how it was taken, between which points, on which build', async () => {
    const k = kernel(() => SIX)
    expect(await measureDimension(k, 'measures', distance() as DimensionMark)).toEqual({ value: 6.000000000000001, how: 'between planes', points: [[5, 3, 3], [5, 3, -3]], measuredRevision: 3 })
    expect(k.asked).toEqual([{ objectId: 'measures', name: 'measure', args: { kind: 'distance', a: { ref: 'assembly:plate/F5', point: [5, 3, 3] }, b: { ref: 'assembly:plate/F0', point: [5, 3, -3] } } }])
  })

  it('says pass or fail against what was expected', async () => {
    const k = kernel(() => EIGHT)
    expect(await measureDimension(k, 'measures', hole({ expected: 8.5 }) as DimensionMark)).toMatchObject({ value: 8, verdict: 'fail' })
    expect(await measureDimension(k, 'measures', hole({ expected: 8.5, tolerance: 0.5 }) as DimensionMark)).toMatchObject({ value: 8, verdict: 'pass' })
    expect(await measureDimension(k, 'measures', hole({ expected: 8.05 }) as DimensionMark)).toMatchObject({ verdict: 'pass' })
    expect(await measureDimension(k, 'measures', hole() as DimensionMark)).not.toHaveProperty('verdict')
  })

  it('is not measurable when the kernel no longer has what an end names: no value, and why, without the layout in front of the refs', async () => {
    const k = kernel(() => {
      throw new KernelError('bad_ref', "assembly:plate has no face 9; assembly:plate has 8 faces")
    })
    const measured = await measureDimension(k, 'measures', hole({ expected: 8 }) as DimensionMark)
    expect(measured).toEqual({ measuredRevision: 3, refused: 'plate has no face 9; plate has 8 faces' })
  })

  it('is not measurable either when the kernel refuses what was asked, and says why', async () => {
    const k = kernel(() => {
      throw new KernelError('bad_request', 'angle is measured between two planar faces, two straight edges, or a planar face and a straight edge; assembly:plate/F9 is a cylinder face')
    })
    expect(await measureDimension(k, 'measures', distance({ measure: 'angle', b: HOLE }) as DimensionMark)).toEqual({
      measuredRevision: 3,
      refused: 'angle is measured between two planar faces, two straight edges, or a planar face and a straight edge; plate/F9 is a cylinder face'
    })
  })

  it('fails, with a plain message, when the kernel could not answer at all, or answered what is no measurement', async () => {
    const timeout = kernel(() => {
      throw new KernelError('timeout', 'the query took longer than 30 s')
    })
    const failed = await measureDimension(timeout, 'measures', hole() as DimensionMark).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toBeInstanceOf(KernelError)
    expect((failed as Error).message).toBe('the query took longer than 30 s')
    await expect(measureDimension(kernel(() => ({ kind: 'diameter', value: 'eight' })), 'measures', hole() as DimensionMark)).rejects.toThrow('the kernel did not answer with a measurement')
    await expect(measureDimension(kernel(() => ({ ...EIGHT, value: NaN })), 'measures', hole() as DimensionMark)).rejects.toThrow('the kernel did not answer with a measurement')
  })

  it('needs a build, and says the value is of the build the kernel answered about', async () => {
    const none = kernel(() => EIGHT)
    none.world.revision = undefined
    await expect(measureDimension(none, 'measures', hole() as DimensionMark)).rejects.toThrow('there is no build of measures to measure on')
    expect(none.asked).toEqual([])
    // A build lands while the kernel is asked: the answer may be of either, and it is asked again.
    const k = kernel(() => {
      if (k.asked.length === 1) k.world.revision = 4
      return { ...EIGHT, value: k.asked.length === 1 ? 8 : 9 }
    })
    expect(await measureDimension(k, 'measures', hole() as DimensionMark)).toMatchObject({ value: 9, measuredRevision: 4 })
    expect(k.asked).toHaveLength(2)
  })

  it('keeps points only when they are two points', async () => {
    expect(await measureDimension(kernel(() => ({ ...EIGHT, points: [[0, 0, 0]] })), 'measures', hole() as DimensionMark)).toEqual({ value: 8, how: 'cylinder', measuredRevision: 3 })
    expect(await measureDimension(kernel(() => ({ ...EIGHT, points: undefined })), 'measures', hole() as DimensionMark)).toEqual({ value: 8, how: 'cylinder', measuredRevision: 3 })
  })
})

describe('a thickness', () => {
  // The point clicked is on the mesh drawn, which on a curved face is a hair off the surface itself:
  // the kernel measures a wall only from a point on the face, so the point is brought onto it first.
  const WALL = { kind: 'thickness', value: 2, unit: 'mm', how: 'wall, along the normal', points: [[4, 0, 0], [6, 0, 0]], exact: true }
  const curved: Anchor = { point: [3.998, 0.01, 0], normal: [-1, 0, 0], part: 'plate', ref: 'plate/F9' }
  const wall = (): DimensionMark => ({ ...BASE, kind: 'dimension', measure: 'thickness', a: curved }) as DimensionMark

  it('is asked at the point of the face nearest to where it was put', async () => {
    const k = kernel(() => WALL, () => ({ anchors: [{ part: 'plate', found: true, point: [4, 0.01, 0], normal: [-1, 0, 0], ref: 'plate/F9', distance: 0.002, descriptor: 'cylinder' }] }))
    expect(await measureDimension(k, 'measures', wall())).toMatchObject({ value: 2, how: 'wall, along the normal' })
    expect(k.asked).toEqual([
      { objectId: 'measures', name: 'nearest', args: { layout: 'assembly', anchors: [{ part: 'plate', point: [3.998, 0.01, 0] }] } },
      { objectId: 'measures', name: 'measure', args: { kind: 'thickness', a: { ref: 'assembly:plate/F9', point: [4, 0.01, 0] } } }
    ])
  })

  it('is asked where it was put when the nearest point is on another face, or the kernel does not say', async () => {
    const elsewhere = kernel(() => WALL, () => ({ anchors: [{ part: 'plate', found: true, point: [4, 0, 3], normal: [0, 0, 1], ref: 'plate/F5', distance: 0.001, descriptor: 'plane' }] }))
    await measureDimension(elsewhere, 'measures', wall())
    expect(elsewhere.asked[1].args).toEqual({ kind: 'thickness', a: { ref: 'assembly:plate/F9', point: [3.998, 0.01, 0] } })
    const failing = kernel(() => WALL, () => {
      throw new KernelError('timeout', 'too long')
    })
    await measureDimension(failing, 'measures', wall())
    expect(failing.asked[1].args).toEqual({ kind: 'thickness', a: { ref: 'assembly:plate/F9', point: [3.998, 0.01, 0] } })
  })

  it('that the kernel refuses is not measurable, with its reason: a point off the face, a part that is no solid', async () => {
    const off = kernel(() => {
      throw new KernelError('bad_request', 'the point is 0.3 mm from assembly:plate/F9: give a point on the face')
    })
    expect(await measureDimension(off, 'measures', wall())).toEqual({ measuredRevision: 3, refused: 'the point is 0.3 mm from plate/F9: give a point on the face' })
    const shell = kernel(() => {
      throw new KernelError('bad_request', 'assembly:plate is not a solid: it has no volume to measure a wall of')
    })
    expect(await measureDimension(shell, 'measures', wall())).toMatchObject({ refused: 'plate is not a solid: it has no volume to measure a wall of' })
  })

  it('no other measurement asks where its ends are first', async () => {
    const k = kernel(() => EIGHT)
    await measureDimension(k, 'measures', hole() as DimensionMark)
    expect(k.asked.map((a) => a.name)).toEqual(['measure'])
  })
})

describe('adding a dimension', () => {
  it('is kept with its value at once when the kernel is quick: one change', async () => {
    const k = kernel(() => SIX)
    const store = marks()
    const added = await addDimension({ ...k, marks: store }, 'measures', distance())
    expect(added).toMatchObject({ id: 'M1', kind: 'dimension', value: 6.000000000000001, how: 'between planes', measuredRevision: 3 })
    expect(store.did).toEqual(['add M1 = 6.000000000000001'])
  })

  it('appears without one when the kernel takes longer, and is given it when it comes', async () => {
    vi.useFakeTimers()
    let answer!: (reply: unknown) => void
    const k = kernel(() => new Promise((resolve) => (answer = resolve)))
    const store = marks()
    const adding = addDimension({ ...k, marks: store }, 'measures', hole({ expected: 8.5 }))
    await vi.advanceTimersByTimeAsync(299)
    expect(store.did).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(store.did).toEqual(['add M1'])
    expect(store.kept[0]).not.toHaveProperty('value')
    answer(EIGHT)
    expect(await adding).toMatchObject({ id: 'M1', value: 8, verdict: 'fail' })
    expect(store.did).toEqual(['add M1', 'measured M1 = 8'])
    vi.useRealTimers()
  })

  it('is not kept when the kernel refuses it: the reason is what is said', async () => {
    const refusal = () => {
      throw new KernelError('bad_request', 'radius is measured of a cylindrical, spherical or toroidal face or a circular edge; assembly:plate/F5 is a plane face')
    }
    const store = marks()
    await expect(addDimension({ ...kernel(refusal), marks: store }, 'measures', hole({ a: TOP, measure: 'radius' }))).rejects.toThrow(
      'radius is measured of a cylindrical, spherical or toroidal face or a circular edge; plate/F5 is a plane face'
    )
    expect(store.did).toEqual([])
  })

  it('is taken away again when the kernel refuses it only after it appeared', async () => {
    vi.useFakeTimers()
    let refuse!: (e: unknown) => void
    const k = kernel(() => new Promise((_resolve, reject) => (refuse = reject)))
    const store = marks()
    const adding = addDimension({ ...k, marks: store }, 'measures', hole({ measure: 'radius', a: TOP }))
    const failed = adding.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(300)
    expect(store.did).toEqual(['add M1'])
    refuse(new KernelError('bad_request', 'radius is measured of a cylindrical, spherical or toroidal face or a circular edge; assembly:plate/F5 is a plane face'))
    expect(((await failed) as Error).message).toBe('radius is measured of a cylindrical, spherical or toroidal face or a circular edge; plate/F5 is a plane face')
    expect(store.did).toEqual(['add M1', 'remove M1'])
    vi.useRealTimers()
  })

  it('is kept, without a value, when the kernel could not be asked: a query that timed out takes no mark of the person’s away', async () => {
    vi.useFakeTimers()
    const logged: string[] = []
    let fail!: (e: unknown) => void
    const k = kernel(() => new Promise((_resolve, reject) => (fail = reject)))
    const store = marks()
    const adding = addDimension({ ...k, marks: store, log: (m) => logged.push(m) }, 'measures', hole({ expected: 8 }))
    await vi.advanceTimersByTimeAsync(300)
    fail(new KernelError('timeout', 'the query took longer than 30 s'))
    const added = (await adding) as DimensionMark
    expect(added).toMatchObject({ id: 'M1', expected: 8 })
    for (const key of ['value', 'measuredRevision', 'verdict']) expect(added).not.toHaveProperty(key)
    expect(store.did).toEqual(['add M1'])
    expect(logged).toEqual(['cannot measure a new dimension of measures yet: the query took longer than 30 s'])
    vi.useRealTimers()
    // So too when it fails at once: it is added as it is.
    const quick = marks()
    const atOnce = await addDimension({ ...kernel(() => { throw new KernelError('crash', 'the worker died') }), marks: quick, log: () => {} }, 'measures', hole())
    expect(atOnce).not.toHaveProperty('value')
    expect(quick.did).toEqual(['add M1'])
  })

  it('is refused when it was placed on another build than the last: its refs are of that build, and the kernel is not asked', async () => {
    const k = kernel(() => EIGHT)
    const store = marks()
    await expect(addDimension({ ...k, marks: store }, 'measures', hole({ revision: 2 }))).rejects.toThrow('it was placed on r2, and the part has been built again since (r3): measure it again')
    k.world.revision = undefined
    await expect(addDimension({ ...k, marks: store }, 'measures', hole())).rejects.toThrow('there is no build of measures to measure on')
    expect(k.asked).toEqual([])
    expect(store.did).toEqual([])
  })

  it('answers with the mark as it is when its value was not written: the check of the marks got there first', async () => {
    vi.useFakeTimers()
    let answer!: (reply: unknown) => void
    const k = kernel(() => new Promise((resolve) => (answer = resolve)))
    const store = marks()
    // The store passes the write over, as it does when the check has refreshed the ends meanwhile, and has measured it itself.
    store.measured = async (_objectId, id) => {
      store.did.push(`measured ${id}: passed over`)
      store.kept[0] = sanitiseMark({ ...store.kept[0], value: 8.1, how: 'cylinder', measuredRevision: 3 })!
      return null
    }
    const adding = addDimension({ ...k, marks: store }, 'measures', hole())
    await vi.advanceTimersByTimeAsync(300)
    answer(EIGHT)
    expect(await adding).toMatchObject({ id: 'M1', value: 8.1 })
    vi.useRealTimers()
  })

  it('leaves what is no dimension to the store to refuse, and asks the kernel nothing of it', async () => {
    const k = kernel(() => SIX)
    const store = marks()
    await expect(addDimension({ ...k, marks: store }, 'measures', distance({ b: undefined }))).rejects.toThrow('that is not a mark')
    await expect(addDimension({ ...k, marks: store }, 'measures', distance({ measure: 'clearance' }))).rejects.toThrow('that is not a mark')
    expect(k.asked).toEqual([])
  })

  it('never takes a value from whoever adds it', async () => {
    const store = marks()
    const added = await addDimension({ ...kernel(() => EIGHT), marks: store }, 'measures', hole({ value: 8.5, expected: 8.5, verdict: 'pass' }))
    expect(added).toMatchObject({ value: 8, verdict: 'fail' })
  })
})

describe('measuring a dimension again', () => {
  it('writes what the kernel says now, and nothing when it could not be asked', async () => {
    const store = marks()
    const k = kernel(() => EIGHT)
    const mark = (await addDimension({ ...k, marks: store }, 'measures', hole())) as DimensionMark
    k.world.revision = 4
    const logged: string[] = []
    await remeasure({ ...kernel(() => ({ ...EIGHT, value: 9 })), marks: store, log: (m) => logged.push(m) }, 'measures', mark)
    expect(store.did.at(-1)).toBe('measured M1 = 9')
    await remeasure({ ...kernel(() => { throw new KernelError('bad_ref', 'assembly:plate has no face 9') }), marks: store, log: (m) => logged.push(m) }, 'measures', mark)
    expect(store.did.at(-1)).toBe('measured M1: nothing')
    const before = store.did.length
    await remeasure({ ...kernel(() => { throw new KernelError('timeout', 'too long') }), marks: store, log: (m) => logged.push(m) }, 'measures', mark)
    expect(store.did).toHaveLength(before)
    expect(logged).toEqual(['cannot measure M1 of measures: too long'])
  })
})

describe('after a change of what a dimension should be', () => {
  const kept = (more: object = {}): Mark => ({ ...hole(), id: 'M1', status: 'sent', anchorState: 'ok', createdAt: '', value: 8, measuredRevision: 3, checkedRevision: 4, ...more }) as Mark

  it('is measured at once when its value is of an older build and the last build’s check has judged its ends', () => {
    expect(dueAfterEdit({ expected: 8 }, kept(), 4)).toBe(true)
    expect(dueAfterEdit({ tolerance: null }, kept({ measuredRevision: undefined }), 4)).toBe(true)
  })

  it('is left to the check of the marks while that has not judged its ends on the last build: its refs are of an older one', () => {
    // The build renumbered the faces, and the check is still running or being tried again.
    expect(dueAfterEdit({ expected: 8 }, kept({ checkedRevision: 3 }), 4)).toBe(false)
    expect(dueAfterEdit({ expected: 8 }, kept({ checkedRevision: undefined }), 4)).toBe(false)
    expect(dueAfterEdit({ expected: 8 }, kept({ anchorState: 'orphaned' }), 4)).toBe(false)
  })

  it('is not measured again when it has a value of the last build, is resolved, is no dimension, or something else was changed', () => {
    expect(dueAfterEdit({ expected: 8 }, kept({ measuredRevision: 4 }), 4)).toBe(false)
    expect(dueAfterEdit({ expected: 8 }, kept({ status: 'resolved' }), 4)).toBe(false)
    expect(dueAfterEdit({ expected: 8 }, { ...kept(), kind: 'pin' } as Mark, 4)).toBe(false)
    expect(dueAfterEdit({ note: 'the hole' }, kept(), 4)).toBe(false)
    expect(dueAfterEdit(null, kept(), 4)).toBe(false)
    expect(dueAfterEdit({ expected: 8 }, kept(), undefined)).toBe(false)
  })
})

describe('measure, as the window asks it', () => {
  it('puts the layout in front of the refs, names the layout for a bare point, and hands on what the kernel says', async () => {
    const k = kernel(() => SIX)
    const reply = await measure(k.query, 'measures', { kind: 'distance', layout: 'assembly', a: { ref: 'plate/F5', point: [5, 3, 3] }, b: { point: [0, 0, 9] } })
    expect(reply).toEqual(SIX)
    expect(k.asked[0]).toEqual({ objectId: 'measures', name: 'measure', args: { kind: 'distance', a: { ref: 'assembly:plate/F5', point: [5, 3, 3] }, b: { layout: 'assembly', point: [0, 0, 9] } } })
    await measure(k.query, 'measures', { kind: 'mass', layout: 'assembly', a: { ref: 'plate' }, density: 1.05 })
    expect(k.asked[1].args).toEqual({ kind: 'mass', a: { ref: 'assembly:plate' }, density: 1.05 })
  })

  it('refuses what names no layout or no end, and turns a kernel error into a plain one', async () => {
    const k = kernel(() => {
      throw new KernelError('bad_request', 'volume is measured of a part; assembly:plate/F5 is a plane face')
    })
    await expect(measure(k.query, 'measures', { kind: 'volume', layout: '', a: { ref: 'plate' } })).rejects.toThrow('measure needs a kind, a layout and an end a')
    await expect(measure(k.query, 'measures', null as never)).rejects.toThrow('measure needs a kind, a layout and an end a')
    expect(k.asked).toEqual([])
    const failed = await measure(k.query, 'measures', { kind: 'volume', layout: 'assembly', a: { ref: 'plate/F5' } }).catch((e: unknown) => e)
    expect(failed).not.toBeInstanceOf(KernelError)
    expect((failed as Error).message).toBe('volume is measured of a part; plate/F5 is a plane face')
  })
})

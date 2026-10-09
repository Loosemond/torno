import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, Mark, MarksFile, NewMark, PinMark, ShapeMark } from '../../shared/marks'
import * as file from './file'
import { MarkStore } from './store'

// The real file module, with its writes counted.
vi.mock('./file', async (importActual) => {
  const actual = await importActual<typeof import('./file')>()
  return { ...actual, saveMarksFile: vi.fn(actual.saveMarksFile) }
})
const saves = vi.mocked(file.saveMarksFile)

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const BASE = { author: 'user', note: '', layout: 'assembly', revision: 1, camera: CAMERA } as const
const ANCHOR: Anchor = { point: [1, 2, 20], part: 'base', ref: 'base/F4' }

const pin = (note = 'here', anchor: Anchor = ANCHOR): NewMark => ({ ...BASE, kind: 'pin', note, anchor }) as NewMark
const arrow = (): NewMark => ({ ...BASE, kind: 'arrow', from: ANCHOR, to: [1, 2, 30] }) as NewMark
const shape = (anchor?: Anchor): NewMark =>
  ({ ...BASE, kind: 'shape', shape: 'box', intent: 'add', position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [10, 10, 10], ...(anchor ? { anchor } : {}) }) as NewMark

let root: string
let dirs: Record<string, string>
let store: MarkStore
let changes: Array<{ objectId: string; marks: Mark[] }>
let problems: Array<{ objectId: string; message: string }>

const onDisk = (objectId: string): MarksFile => JSON.parse(readFileSync(join(dirs[objectId], '.torno', 'marks.json'), 'utf8'))
const ids = (marks: Mark[]): string[] => marks.map((m) => m.id)

function newStore(): MarkStore {
  const s = new MarkStore({ dirOf: (id) => dirs[id], now: () => new Date('2026-10-09T12:00:00.000Z') })
  s.on('changed', (m) => changes.push(m))
  s.on('problem', (m) => problems.push(m))
  return s
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-marks-store-'))
  dirs = { bracket: join(root, 'bracket'), two: join(root, 'two') }
  for (const dir of Object.values(dirs)) mkdirSync(dir)
  changes = []
  problems = []
  saves.mockClear()
  store = newStore()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('adding marks', () => {
  it('numbers them M1, M2, and fills in what main decides', async () => {
    const first = await store.add('bracket', pin('first'))
    const second = await store.add('bracket', arrow())
    expect(first).toMatchObject({ id: 'M1', kind: 'pin', note: 'first', status: 'draft', anchorState: 'ok', createdAt: '2026-10-09T12:00:00.000Z' })
    expect(second).toMatchObject({ id: 'M2', kind: 'arrow', status: 'draft' })
    expect(await store.list('bracket')).toEqual([first, second])
    expect(onDisk('bracket')).toEqual({ next: 3, marks: [first, second] })
  })

  it('tells of each change with the whole list', async () => {
    const first = await store.add('bracket', pin())
    expect(changes).toEqual([{ objectId: 'bracket', marks: [first] }])
  })

  it('never reuses an id after a remove, in this run or the next', async () => {
    await store.add('bracket', pin())
    await store.add('bracket', pin())
    await store.remove('bracket', 'M2')
    expect((await store.add('bracket', pin())).id).toBe('M3')
    await store.remove('bracket', 'M3')
    await store.remove('bracket', 'M1')
    expect(onDisk('bracket')).toEqual({ next: 4, marks: [] })
    expect((await newStore().add('bracket', pin())).id).toBe('M4')
  })

  it('gives concurrent adds distinct ids, and keeps them all', async () => {
    const added = await Promise.all(Array.from({ length: 12 }, (_, i) => store.add('bracket', pin(`n${i}`))))
    expect(ids(added)).toEqual(Array.from({ length: 12 }, (_, i) => `M${i + 1}`))
    expect(added.map((m) => m.note)).toEqual(Array.from({ length: 12 }, (_, i) => `n${i}`))
    expect(ids(onDisk('bracket').marks)).toEqual(ids(added))
    expect(onDisk('bracket').next).toBe(13)
  })

  it('ignores what a caller says of the id and the status, and refuses what is not a mark', async () => {
    const forged = { ...pin(), id: 'M40', status: 'resolved', anchorState: 'orphaned', createdAt: 'then' } as unknown as NewMark
    expect(await store.add('bracket', forged)).toMatchObject({ id: 'M1', status: 'draft', anchorState: 'ok', createdAt: '2026-10-09T12:00:00.000Z' })
    await expect(store.add('bracket', { ...pin(), kind: 'dimension' } as unknown as NewMark)).rejects.toThrow('not a mark')
    await expect(store.add('bracket', pin('x', { point: [0, NaN, 0] }))).rejects.toThrow('not a mark')
    // A refused mark uses no id and writes nothing.
    expect((await store.add('bracket', pin())).id).toBe('M2')
    expect(saves).toHaveBeenCalledTimes(2)
  })

  it('keeps two objects apart', async () => {
    const a = await store.add('bracket', pin('on the bracket'))
    const b = await store.add('two', pin('on two'))
    expect([a.id, b.id]).toEqual(['M1', 'M1'])
    expect(await store.list('bracket')).toEqual([a])
    expect(await store.list('two')).toEqual([b])
    expect(onDisk('two').marks).toEqual([b])
    await store.remove('two', 'M1')
    expect(await store.list('bracket')).toEqual([a])
    expect(changes.map((c) => c.objectId)).toEqual(['bracket', 'two', 'two'])
  })

  it('rejects an object whose folder is not known, with a plain message', async () => {
    await expect(store.list('ghost')).rejects.toThrow('no object named ghost in the open workspace')
    await expect(store.add('ghost', pin())).rejects.toThrow('no object named ghost in the open workspace')
    expect(saves).not.toHaveBeenCalled()
  })

  it('hands out copies: changing what it returned changes nothing', async () => {
    const mark = (await store.add('bracket', pin())) as PinMark
    mark.note = 'scribbled over'
    mark.anchor.point[0] = 99
    const listed = (await store.list('bracket'))[0] as PinMark
    expect(listed.note).toBe('here')
    expect(listed.anchor.point).toEqual([1, 2, 20])
  })
})

describe('updating a mark', () => {
  it('names the marks there are when the id is unknown', async () => {
    await store.add('bracket', pin())
    await store.add('bracket', pin())
    await expect(store.update('bracket', 'M9', { note: 'x' })).rejects.toThrow('no mark M9; marks: M1, M2')
    await expect(store.remove('bracket', 'M9')).rejects.toThrow('no mark M9; marks: M1, M2')
    await expect(store.update('two', 'M1', { note: 'x' })).rejects.toThrow('no mark M1; marks: none')
  })

  it('changes the note and writes it', async () => {
    await store.add('bracket', pin())
    const updated = await store.update('bracket', 'M1', { note: 'thicker, 4 mm' })
    expect(updated).toMatchObject({ id: 'M1', note: 'thicker, 4 mm', status: 'draft' })
    expect(onDisk('bracket').marks).toEqual([updated])
    expect(changes.at(-1)).toEqual({ objectId: 'bracket', marks: [updated] })
  })

  it('moves status forward, to resolved from anywhere, and back to draft when asked', async () => {
    await store.add('bracket', pin())
    expect((await store.update('bracket', 'M1', { status: 'sent' })).status).toBe('sent')
    expect((await store.update('bracket', 'M1', { status: 'resolved', resolvedNote: 'done' })).status).toBe('resolved')
    await expect(store.update('bracket', 'M1', { status: 'sent' })).rejects.toThrow('M1 is resolved')
    expect((await store.list('bracket'))[0]).toMatchObject({ status: 'resolved', resolvedNote: 'done' })
    expect((await store.update('bracket', 'M1', { status: 'draft' })).status).toBe('draft')
    expect((await store.update('bracket', 'M1', { status: 'resolved' })).status).toBe('resolved')
    await store.add('bracket', pin())
    await store.update('bracket', 'M2', { status: 'sent' })
    expect((await store.update('bracket', 'M2', { status: 'draft' })).status).toBe('draft')
  })

  it('moves and resizes a shape, and refuses to do so to anything else', async () => {
    await store.add('bracket', shape())
    await store.add('bracket', pin())
    const moved = (await store.update('bracket', 'M1', { position: [5, 0, 0], size: [2, 3, 4], shape: 'cylinder', intent: 'remove', rotation: [0, 0, 1, 0] })) as ShapeMark
    expect(moved).toMatchObject({ position: [5, 0, 0], size: [2, 3, 4], shape: 'cylinder', intent: 'remove', rotation: [0, 0, 1, 0] })
    await expect(store.update('bracket', 'M2', { position: [5, 0, 0] })).rejects.toThrow('M2 is a pin, not a shape')
  })

  it('refuses a patch that would leave something that is not a mark, and changes nothing', async () => {
    await store.add('bracket', shape())
    saves.mockClear()
    changes = []
    await expect(store.update('bracket', 'M1', { size: [1, NaN, 1] })).rejects.toThrow('not a valid change to M1')
    await expect(store.update('bracket', 'M1', { status: 'done' as never })).rejects.toThrow('not a valid change to M1')
    expect((await store.list('bracket'))[0]).toMatchObject({ size: [10, 10, 10], status: 'draft' })
    expect(saves).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  })

  it('takes nothing from a patch but what a patch may hold', async () => {
    await store.add('bracket', pin())
    const patched = await store.update('bracket', 'M1', { note: 'n', id: 'M7', author: 'agent', anchorState: 'orphaned' } as never)
    expect(patched).toMatchObject({ id: 'M1', author: 'user', anchorState: 'ok', note: 'n' })
    expect(await store.update('bracket', 'M1', null as never)).toEqual(patched)
  })
})

describe('sending marks', () => {
  it('turns every draft into sent, returns those, and tells of it once', async () => {
    await store.add('bracket', pin('one'))
    await store.add('bracket', pin('two'))
    await store.add('bracket', pin('three'))
    await store.update('bracket', 'M2', { status: 'resolved' })
    await store.add('two', pin('elsewhere'))
    saves.mockClear()
    changes = []

    const sent = await store.markSent('bracket')
    expect(ids(sent)).toEqual(['M1', 'M3'])
    expect(sent.every((m) => m.status === 'sent')).toBe(true)
    expect((await store.list('bracket')).map((m) => m.status)).toEqual(['sent', 'resolved', 'sent'])
    expect(onDisk('bracket').marks.map((m) => m.status)).toEqual(['sent', 'resolved', 'sent'])
    expect(changes).toHaveLength(1)
    expect(saves).toHaveBeenCalledTimes(1)
    // The drafts of another object are not its to send.
    expect((await store.list('two'))[0].status).toBe('draft')
  })

  it('a second time finds nothing to send, writes nothing and says nothing', async () => {
    await store.add('bracket', pin())
    await store.markSent('bracket')
    saves.mockClear()
    changes = []
    expect(await store.markSent('bracket')).toEqual([])
    expect(saves).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  })
})

describe('re-anchoring after a build', () => {
  it('replaces anchors and their states in one write, leaving the marks not listed', async () => {
    await store.add('bracket', pin('pin'))
    await store.add('bracket', arrow())
    await store.add('bracket', shape(ANCHOR))
    await store.add('bracket', pin('untouched'))
    await store.add('bracket', shape())
    saves.mockClear()
    changes = []

    const moved: Anchor = { point: [1, 2, 21], normal: [0, 0, 1], part: 'base', ref: 'base/F7', descriptor: 'plane, normal +Z, z = 21' }
    await store.reanchor('bracket', [
      { id: 'M1', anchors: [moved], anchorState: 'drifted' },
      { id: 'M2', anchors: [{ point: [1, 2, 20] }], anchorState: 'orphaned' },
      { id: 'M3', anchors: [moved], anchorState: 'ok' },
      { id: 'M5', anchors: [], anchorState: 'ok' },
      { id: 'M9', anchors: [moved], anchorState: 'ok' } // removed while the build ran: passed over
    ])
    const marks = await store.list('bracket')
    expect(marks[0]).toMatchObject({ id: 'M1', anchor: moved, anchorState: 'drifted' })
    expect(marks[1]).toMatchObject({ id: 'M2', from: { point: [1, 2, 20] }, to: [1, 2, 30], anchorState: 'orphaned' })
    expect(marks[1]).not.toHaveProperty('from.ref')
    expect(marks[2]).toMatchObject({ id: 'M3', anchor: moved, anchorState: 'ok' })
    expect(marks[3]).toMatchObject({ id: 'M4', anchor: ANCHOR, anchorState: 'ok' })
    expect(marks[4]).not.toHaveProperty('anchor')
    expect(saves).toHaveBeenCalledTimes(1)
    expect(changes).toEqual([{ objectId: 'bracket', marks }])
    expect(onDisk('bracket').marks).toEqual(marks)
  })

  it('writes nothing when no mark it names is there', async () => {
    await store.add('bracket', pin())
    saves.mockClear()
    await store.reanchor('bracket', [{ id: 'M4', anchors: [ANCHOR], anchorState: 'ok' }])
    await store.reanchor('bracket', [])
    expect(saves).not.toHaveBeenCalled()
  })

  it('leaves a mark as it was when it is given no anchor to put in place of the one it must have', async () => {
    await store.add('bracket', pin())
    await store.reanchor('bracket', [{ id: 'M1', anchors: [], anchorState: 'orphaned' }])
    expect((await store.list('bracket'))[0]).toMatchObject({ anchor: ANCHOR, anchorState: 'orphaned' })
  })
})

describe('what is on disk', () => {
  it('is read once, then kept in memory', async () => {
    const first = await store.add('bracket', pin())
    writeFileSync(join(dirs.bracket, '.torno', 'marks.json'), JSON.stringify({ next: 1, marks: [] }))
    expect(await store.list('bracket')).toEqual([first])
    // Until the store is told to forget, as when the workspace is left.
    store.forget()
    expect(await store.list('bracket')).toEqual([])
  })

  it('a corrupt file is kept aside, said once, and a fresh list started', async () => {
    mkdirSync(join(dirs.bracket, '.torno'))
    writeFileSync(join(dirs.bracket, '.torno', 'marks.json'), '{"next": 2, "marks": [')
    expect(await store.list('bracket')).toEqual([])
    expect(await store.list('bracket')).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0].objectId).toBe('bracket')
    expect(problems[0].message).toContain('marks.json.corrupt-2026-10-09T12-00-00-000Z')
    // M1 was given out by the file that was lost: it is not given out again.
    expect((await store.add('bracket', pin())).id).toBe('M2')
    expect(readdirSync(join(dirs.bracket, '.torno')).sort()).toEqual(['marks.json', 'marks.json.corrupt-2026-10-09T12-00-00-000Z'])
    expect(problems).toHaveLength(1)
  })

  it('marks it cannot read are left out, kept in a copy and said once; their ids are not given out again', async () => {
    const first = await store.add('bracket', pin())
    const raw = JSON.stringify({ next: 2, marks: [first, { ...first, id: 'M5', kind: 'dimension' }] })
    writeFileSync(join(dirs.bracket, '.torno', 'marks.json'), raw)
    store.forget()
    expect(await store.list('bracket')).toEqual([first])
    expect(problems).toEqual([{ objectId: 'bracket', message: expect.stringContaining('marks.json.dropped-2026-10-09T12-00-00-000Z') }])
    expect((await store.add('bracket', pin())).id).toBe('M6')
    expect(readFileSync(join(dirs.bracket, '.torno', 'marks.json.dropped-2026-10-09T12-00-00-000Z'), 'utf8')).toBe(raw)
    store.forget()
    await store.list('bracket')
    expect(problems).toHaveLength(1)
  })

  it('says nothing of an object once the workspace it was asked in has been left', async () => {
    await store.add('bracket', pin())
    changes = []
    // Asked, then the workspace is left before the write lands.
    const pending = store.add('bracket', pin('late'))
    store.forget()
    expect((await pending).id).toBe('M2')
    expect(changes).toEqual([])
    // The write itself went through: the file is the truth the next read starts from.
    expect(ids(onDisk('bracket').marks)).toEqual(['M1', 'M2'])
    expect(ids(await store.list('bracket'))).toEqual(['M1', 'M2'])

    mkdirSync(join(dirs.two, '.torno'))
    writeFileSync(join(dirs.two, '.torno', 'marks.json'), 'not json')
    const listing = store.list('two')
    store.forget()
    await listing
    expect(problems).toEqual([])
  })

  it('keeps what was wrong with a folder to be asked for, until it is dismissed', async () => {
    mkdirSync(join(dirs.bracket, '.torno'))
    writeFileSync(join(dirs.bracket, '.torno', 'marks.json'), 'not json')
    // Asking is what reads the file, when nothing has yet.
    const said = await store.problem('bracket')
    expect(said).toContain('marks.json.corrupt-2026-10-09T12-00-00-000Z')
    expect(problems).toEqual([{ objectId: 'bracket', message: said }])
    // Whoever was not listening can still ask, any number of times, and of this folder only.
    expect(await store.problem('bracket')).toBe(said)
    expect(await store.problem('two')).toBeNull()
    await store.dismissProblem('bracket')
    expect(await store.problem('bracket')).toBeNull()
    await expect(store.problem('ghost')).rejects.toThrow('no object named ghost')
  })

  it('a problem found while the workspace was being left is not told, and is still there to be asked for', async () => {
    mkdirSync(join(dirs.two, '.torno'))
    writeFileSync(join(dirs.two, '.torno', 'marks.json'), 'not json')
    const listing = store.list('two')
    store.forget()
    await listing
    expect(problems).toEqual([])
    expect(await store.problem('two')).toContain('marks.json.corrupt-')
    expect(problems).toEqual([])
  })

  it('a write that fails changes nothing in memory, and the next one goes through', async () => {
    await store.add('bracket', pin())
    changes = []
    saves.mockRejectedValueOnce(new Error('disk full'))
    await expect(store.add('bracket', pin('lost'))).rejects.toThrow('disk full')
    expect(ids(await store.list('bracket'))).toEqual(['M1'])
    expect(changes).toEqual([])
    expect((await store.add('bracket', pin('kept'))).id).toBe('M2')
  })
})

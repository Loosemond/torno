import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { type CardDeps, THUMB_MAX_BYTES, cardsOf, peekMarks, saveThumbnail, thumbOf, thumbnailRefusal } from './cards'

const pin = (id: string, status: Mark['status']): Mark => ({ id, kind: 'pin', author: 'user', note: '', status, anchorState: 'ok', layout: 'assembly', revision: 1, camera: { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }, createdAt: '', anchor: { point: [0, 0, 0] } })
// As the store hands a dimension on: with the verdict its sanitiser worked out of the value.
const dimension = (id: string, value: number, measuredRevision?: number): Mark => ({ ...pin(id, 'sent'), kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0] }, b: { point: [0, 0, 6] }, value, expected: 8, verdict: value === 8 ? 'pass' : 'fail', ...(measuredRevision ? { measuredRevision } : {}) }) as Mark
const png = (width: number, height: number, bytes = 200): Uint8Array => {
  const made = new Uint8Array(bytes)
  made.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(made.buffer).setUint32(16, width)
  new DataView(made.buffer).setUint32(20, height)
  return made
}
const missing = (): Promise<never> => Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))

function deps(over: Partial<CardDeps> = {}): CardDeps {
  const files: Record<string, string> = {
    '/ws/b/.torno/marks.json': JSON.stringify({ next: 3, marks: [pin('M1', 'draft'), pin('M2', 'resolved'), dimension('M3', 6)] }),
    '/ws/b/.torno/thumb.json': JSON.stringify({ at: '2026-10-08T21:14:03.000Z', layout: 'assembly', parts: 2, model: 'b.py', modelMtimeMs: 1000 }),
    '/ws/c/.torno/marks.json': '{ not json'
  }
  return {
    objects: () => [
      { id: 'a', name: 'a', dir: '/ws/a', model: 'a.py' },
      { id: 'b', name: 'b', dir: '/ws/b', model: 'b.py' },
      { id: 'c', name: 'c', dir: '/ws/c', model: null, problem: 'no model file in /ws/c' }
    ],
    opened: (id) => id === 'a',
    build: (id) => (id === 'a' ? { objectId: 'a', status: 'failed', revision: 4, stale: true, error: { kind: 'exception', message: 'NameError: name x is not defined\n  File …' } } : undefined),
    marks: async () => [pin('M1', 'sent'), dimension('M2', 6, 4), dimension('M3', 8, 4), dimension('M4', 8, 3)],
    session: (id) => (id === 'a' ? 'working' : null),
    readFile: async (path) => files[path] ?? missing(),
    mtimeMs: async (path) => (path === '/ws/b/b.py' ? 2000 : null),
    ...over
  }
}

describe('cardsOf', () => {
  it('says of an object opened here how its build, its marks and its dimensions stand', async () => {
    const [a] = await cardsOf(deps())
    expect(a).toEqual({
      id: 'a', name: 'a', opened: true,
      build: { status: 'failed', revision: 4, stale: true, error: 'NameError: name x is not defined' },
      thumb: null,
      marks: { open: 4, drafts: 0 },
      dimensions: { failing: 1, unmeasured: 1, passing: 1 },
      session: 'working'
    })
  })

  it('says of one not opened only what its files say, and no verdict of a build it has not seen', async () => {
    const [, b] = await cardsOf(deps())
    // What its one dimension said when it was last measured is of a run before: told as that, never as a verdict.
    expect(b).toEqual({ id: 'b', name: 'b', opened: false, thumb: { at: '2026-10-08T21:14:03.000Z', layout: 'assembly', behind: true }, marks: { open: 2, drafts: 1 }, dimensions: null, lastRun: { dimensions: 1, failed: 1 }, session: null })
  })

  it('says a marks file could not be read, and carries a problem', async () => {
    const [, , c] = await cardsOf(deps())
    expect(c).toMatchObject({ id: 'c', problem: 'no model file in /ws/c', marks: null, thumb: null })
    expect(c.lastRun).toBeUndefined()
  })

  it('takes an object with no marks file as one with no marks, and one whose file cannot be opened as unread', async () => {
    const [, b] = await cardsOf(deps({ readFile: missing }))
    expect(b).toMatchObject({ marks: { open: 0, drafts: 0 }, thumb: null, dimensions: null })
    const [, denied] = await cardsOf(deps({ readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) }))
    expect(denied.marks).toBeNull()
  })

  it('has no verdicts for an object opened here that has not built yet, and none when its marks cannot be listed', async () => {
    const [a] = await cardsOf(deps({ build: () => ({ objectId: 'a', status: 'building', revision: 0, stale: false }) }))
    expect(a).toMatchObject({ opened: true, build: { status: 'building', revision: 0, stale: false }, dimensions: null, lastRun: { dimensions: 3, failed: 1 } })
    const [unlisted] = await cardsOf(deps({ marks: () => Promise.reject(new Error('no folder')) }))
    expect(unlisted).toMatchObject({ marks: null, dimensions: null })
  })

  it('says the kernel let a build go, and that a picture is of another model file', async () => {
    const [a, b] = await cardsOf(deps({ build: () => ({ objectId: 'a', status: 'ok', revision: 2, stale: false, letGo: 'memory' }), mtimeMs: async () => 1000, objects: () => [{ id: 'a', name: 'a', dir: '/ws/a', model: 'a.py' }, { id: 'b', name: 'b', dir: '/ws/b', model: 'other.py' }] }))
    expect(a.build).toEqual({ status: 'ok', revision: 2, stale: false, letGo: 'memory' })
    expect(b.thumb).toEqual({ at: '2026-10-08T21:14:03.000Z', layout: 'assembly', behind: true })
  })
})

it('reads marks without keeping anything of a file that is not one', () => {
  expect(peekMarks('{ not json')).toBeNull()
  expect(peekMarks(JSON.stringify({ marks: 'none' }))).toBeNull()
  expect(peekMarks(JSON.stringify({ next: 2, marks: [pin('M1', 'draft')] }))).toHaveLength(1)
})

it('takes a picture as behind when the model file is newer, or another', () => {
  const meta = { at: '2026-10-08T21:14:03.000Z', layout: 'print', parts: 1, model: 'a.py', modelMtimeMs: 1000 }
  expect(thumbOf(meta, 1000)).toEqual({ at: meta.at, layout: 'print', behind: false })
  expect(thumbOf(meta, 1000.5)).toEqual({ at: meta.at, layout: 'print', behind: true })
  expect(thumbOf(meta, null)).toEqual({ at: meta.at, layout: 'print', behind: true })
  for (const none of [null, 'x', {}, { ...meta, at: 7 }, { ...meta, layout: '' }]) expect(thumbOf(none, 1000)).toBeNull()
})

it('says of a picture what it leaves out or draws otherwise than the parts are', () => {
  const meta = { at: '2026-10-08T21:14:03.000Z', layout: 'assembly', parts: 1, model: 'a.py', modelMtimeMs: 1000 }
  expect(thumbOf({ ...meta, cut: true, hidden: 2 }, 1000)).toEqual({ at: meta.at, layout: 'assembly', behind: false, cut: true, hidden: 2 })
  expect(thumbOf({ ...meta, apart: true, hidden: 0, cut: 'yes' }, 1000)).toEqual({ at: meta.at, layout: 'assembly', behind: false, apart: true })
})

it('keeps as a picture only a PNG of the size of one, and not a large one', () => {
  expect(thumbnailRefusal(png(480, 360))).toBeNull()
  expect(thumbnailRefusal(png(4000, 3000))).toBe('not a 480 × 360 picture')
  expect(thumbnailRefusal(new Uint8Array(200))).toBe('not a PNG')
  expect(thumbnailRefusal(png(480, 360, THUMB_MAX_BYTES + 1))).toBe('a picture of more than 512 KB')
  expect(thumbnailRefusal('PNG' as unknown as Uint8Array)).toBe('not a PNG')
})

it('writes the picture and what it is of under .torno, and has git pass over them unless the person said otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-thumb-'))
  try {
    await saveThumbnail(dir, png(480, 360), { layout: 'assembly', parts: 2, model: 'a.py', modelMtimeMs: 1000, cut: true }, new Date('2026-10-09T21:14:03.000Z'))
    expect(readdirSync(dir)).toEqual(['.torno'])
    expect(readdirSync(join(dir, '.torno')).sort()).toEqual(['.gitignore', 'thumb.json', 'thumb.png'])
    expect([...readFileSync(join(dir, '.torno', 'thumb.png')).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(JSON.parse(readFileSync(join(dir, '.torno', 'thumb.json'), 'utf8'))).toEqual({ at: '2026-10-09T21:14:03.000Z', layout: 'assembly', parts: 2, model: 'a.py', modelMtimeMs: 1000, cut: true })
    expect(readFileSync(join(dir, '.torno', '.gitignore'), 'utf8')).toBe('thumb.png\nthumb.json\n')
    // The person's own word on what git passes over stays.
    writeFileSync(join(dir, '.torno', '.gitignore'), '# mine\n')
    await saveThumbnail(dir, png(480, 360), { layout: 'print', parts: 1, model: 'a.py', modelMtimeMs: null }, new Date('2026-10-09T22:00:00.000Z'))
    expect(readFileSync(join(dir, '.torno', '.gitignore'), 'utf8')).toBe('# mine\n')
    expect(JSON.parse(readFileSync(join(dir, '.torno', 'thumb.json'), 'utf8'))).toEqual({ at: '2026-10-09T22:00:00.000Z', layout: 'print', parts: 1, model: 'a.py', modelMtimeMs: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArrowMark, Mark, MarksFile, PickMark, PinMark, ShapeMark, StrokeMark } from '../../shared/marks'
import { markAnchors } from '../../shared/marks'
import { loadMarksFile, MAX_NOTE, MAX_STROKE_POINTS, sanitiseMark, saveMarksFile } from './file'

const CAMERA = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 } as const

const BASE = {
  author: 'user',
  note: 'too thin here',
  status: 'draft',
  anchorState: 'ok',
  layout: 'assembly',
  revision: 3,
  camera: { ...CAMERA, position: [...CAMERA.position], target: [...CAMERA.target], up: [...CAMERA.up] },
  createdAt: '2026-10-09T10:00:00.000Z'
} as const

const ANCHOR = { point: [1, 2, 20], normal: [0, 0, 1], part: 'base', ref: 'base/F4', descriptor: 'plane, normal +Z, z = 20, 1180 mm²' }

const pin = (over: object = {}): PinMark => ({ ...BASE, id: 'M1', kind: 'pin', anchor: ANCHOR, ...over }) as PinMark
const pick: PickMark = { ...BASE, id: 'M2', kind: 'pick', target: 'face', anchor: ANCHOR } as PickMark
const arrow: ArrowMark = { ...BASE, id: 'M3', kind: 'arrow', from: ANCHOR, to: [1, 2, 32] } as ArrowMark
const surfaceStroke: StrokeMark = { ...BASE, id: 'M4', kind: 'stroke', space: 'surface', anchor: ANCHOR, points: [[1, 2, 20], [2, 2, 20], [3, 3, 20]] } as StrokeMark
const planeStroke: StrokeMark = {
  ...BASE,
  id: 'M5',
  kind: 'stroke',
  space: 'plane',
  anchor: { point: [0, 40, 0] },
  plane: { origin: [0, 40, 0], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 40.0' },
  points2d: [[0, 0], [10, 0], [10, 5]]
} as StrokeMark
const shape: ShapeMark = {
  ...BASE,
  id: 'M6',
  author: 'agent',
  status: 'resolved',
  anchorState: 'drifted',
  resolvedNote: 'made it 4 mm',
  kind: 'shape',
  shape: 'cylinder',
  intent: 'remove',
  position: [5, 5, 10],
  rotation: [0, 0, 0, 1],
  size: [6, 6, 20]
} as ShapeMark

const ALL: Mark[] = [pin(), pick, arrow, surfaceStroke, planeStroke, shape]

let dir: string
const path = (): string => join(dir, '.torno', 'marks.json')
const NOW = (): Date => new Date('2026-10-09T12:34:56.789Z')

function writeRaw(text: string): void {
  mkdirSync(join(dir, '.torno'), { recursive: true })
  writeFileSync(path(), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torno-marks-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('marks file', () => {
  it('round trips every kind of mark, creating .torno/ on demand', async () => {
    const file: MarksFile = { next: 7, marks: ALL }
    await saveMarksFile(dir, file)
    expect(await loadMarksFile(dir)).toEqual({ file })
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(file)
  })

  it('an atomic write leaves no temp file, and nothing outside .torno/', async () => {
    await Promise.all([saveMarksFile(dir, { next: 2, marks: [pin()] }), saveMarksFile(dir, { next: 3, marks: [pin(), { ...pick }] })])
    expect(readdirSync(dir)).toEqual(['.torno'])
    expect(readdirSync(join(dir, '.torno'))).toEqual(['marks.json'])
    // Saves of one file land in the order they were made.
    expect((await loadMarksFile(dir)).file.next).toBe(3)
  })

  it('a missing file is an empty list, and nothing is written', async () => {
    expect(await loadMarksFile(dir)).toEqual({ file: { next: 1, marks: [] } })
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['half a file', '{"next": 3, "marks": [{"id"'],
    ['not a marks file', '[1, 2]'],
    ['marks that are not a list', '{"next": 3, "marks": {}}']
  ])('a corrupt file (%s) is kept aside and a fresh one started', async (_what, text) => {
    writeRaw(text)
    const loaded = await loadMarksFile(dir, NOW)
    expect(loaded.file).toEqual({ next: 1, marks: [] })
    const aside = 'marks.json.corrupt-2026-10-09T12-34-56-789Z'
    expect(readdirSync(join(dir, '.torno'))).toEqual([aside])
    expect(readFileSync(join(dir, '.torno', aside), 'utf8')).toBe(text)
    expect(loaded.problem).toContain(`.torno/${aside}`)
    // The next read finds no file: the problem is told once.
    expect(await loadMarksFile(dir, NOW)).toEqual({ file: { next: 1, marks: [] } })
  })

  it('drops marks of unknown kinds and marks that are not whole, keeping the others', async () => {
    writeRaw(
      JSON.stringify({
        next: 9,
        marks: [
          pin(),
          { ...pin(), id: 'M2', kind: 'dimension' },
          { ...pin(), id: 'M3', anchor: { point: [1, null, 3] } },
          { ...pin(), id: 'M4', revision: 'three' },
          { ...pin(), id: 'four' },
          null,
          { ...shape, id: 'M5', extra: true }
        ]
      })
    )
    const { file, problem } = await loadMarksFile(dir)
    expect(problem).toBeUndefined()
    expect(file).toEqual({ next: 9, marks: [pin(), { ...shape, id: 'M5' }] })
  })

  it('never hands out an id again: next is past every id in the file, whatever the file says', async () => {
    writeRaw(JSON.stringify({ next: 1, marks: [pin({ id: 'M7' }), pin({ id: 'M7', note: 'the same id twice' })] }))
    const { file } = await loadMarksFile(dir)
    expect(file.next).toBe(8)
    expect(file.marks.map((m) => m.note)).toEqual(['too thin here'])
    writeRaw(JSON.stringify({ marks: [] }))
    expect((await loadMarksFile(dir)).file).toEqual({ next: 1, marks: [] })
  })

  it('sanitises on write as on read', async () => {
    await saveMarksFile(dir, { next: 2, marks: [pin({ note: 'x'.repeat(MAX_NOTE + 50), stray: 1 }), { ...pick, kind: 'region' } as unknown as Mark] })
    const written = JSON.parse(readFileSync(path(), 'utf8')) as MarksFile
    expect(written.marks).toHaveLength(1)
    expect(written.marks[0].note).toHaveLength(MAX_NOTE)
    expect(written.marks[0]).not.toHaveProperty('stray')
  })
})

describe('sanitising a mark', () => {
  it('keeps a whole mark as it is', () => {
    for (const mark of ALL) expect(sanitiseMark(mark)).toEqual(mark)
  })

  it('cuts notes at 2000 characters', () => {
    const cut = sanitiseMark({ ...shape, note: 'n'.repeat(5000), resolvedNote: 'r'.repeat(5000) })
    expect(cut?.note).toHaveLength(2000)
    expect(cut?.resolvedNote).toHaveLength(2000)
  })

  it('cuts strokes at 400 points', () => {
    const points = Array.from({ length: 1000 }, (_, i) => [i, 0, 0])
    const points2d = Array.from({ length: 1000 }, (_, i) => [i, 0])
    expect((sanitiseMark({ ...surfaceStroke, points }) as StrokeMark).points).toEqual(points.slice(0, MAX_STROKE_POINTS))
    expect((sanitiseMark({ ...planeStroke, points2d }) as StrokeMark).points2d).toEqual(points2d.slice(0, MAX_STROKE_POINTS))
  })

  it('refuses numbers that are not finite', () => {
    expect(sanitiseMark(pin({ anchor: { point: [0, Infinity, 0] } }))).toBeNull()
    expect(sanitiseMark(pin({ revision: NaN }))).toBeNull()
    expect(sanitiseMark(pin({ camera: { ...CAMERA, fov: NaN } }))).toBeNull()
    expect(sanitiseMark({ ...arrow, to: [1, 2] })).toBeNull()
    expect(sanitiseMark({ ...shape, size: [1, 2, -Infinity] })).toBeNull()
    expect(sanitiseMark({ ...shape, rotation: [0, 0, 1] })).toBeNull()
  })

  it('leaves out the optional parts of an anchor that are not right, and the points of a stroke that are not points', () => {
    expect(sanitiseMark(pin({ anchor: { point: [1, 2, 3], normal: [0, NaN, 1], part: 7, ref: 'base/F1' } }))).toEqual(
      pin({ anchor: { point: [1, 2, 3], ref: 'base/F1' } })
    )
    expect((sanitiseMark({ ...surfaceStroke, points: [[0, 0, 0], [1, NaN, 0], 'x', [2, 0, 0]] }) as StrokeMark).points).toEqual([[0, 0, 0], [2, 0, 0]])
  })

  it('refuses a stroke without the points of its space, and a mark with a field of the wrong sort', () => {
    expect(sanitiseMark({ ...surfaceStroke, points: undefined })).toBeNull()
    expect(sanitiseMark({ ...planeStroke, plane: undefined })).toBeNull()
    expect(sanitiseMark({ ...pick, target: 'vertex' })).toBeNull()
    expect(sanitiseMark({ ...shape, intent: 'paint' })).toBeNull()
    expect(sanitiseMark(pin({ status: 'drifted' }))).toBeNull()
    expect(sanitiseMark(pin({ author: 'cat' }))).toBeNull()
    expect(sanitiseMark('pin')).toBeNull()
  })
})

describe('the anchors of a mark', () => {
  it('one for a pin, a pick and a stroke; the start of an arrow; the first placing of a shape, if any', () => {
    expect(markAnchors(pin())).toEqual([ANCHOR])
    expect(markAnchors(pick)).toEqual([ANCHOR])
    expect(markAnchors(surfaceStroke)).toEqual([ANCHOR])
    expect(markAnchors(arrow)).toEqual([ANCHOR])
    expect(markAnchors(shape)).toEqual([])
    expect(markAnchors({ ...shape, anchor: ANCHOR } as ShapeMark)).toEqual([ANCHOR])
  })
})

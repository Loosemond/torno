import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Anchor, Mark, MarksFile, Quat, ShapeKind, StrokeMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'
import { MAX_STROKE_POINTS, MIN_SHAPE_SIZE } from '../../shared/marks'
import { writeFileAtomic } from '../atomic'

const FOLDER = '.torno'
const NAME = 'marks.json'

/** The longest note a mark keeps, in characters. */
export const MAX_NOTE = 2000
export { MAX_STROKE_POINTS }

/**
 * The marks of the object in `dir`. A missing file is an empty list, and
 * nothing is written. A file that cannot be read at all is an error.
 *
 * A file that is not a marks file is copied aside, as
 * `marks.json.corrupt-<time>` beside it, and an empty list started whose ids
 * go on from the highest the old file is seen to have given out. A file some
 * of whose marks are not marks this version can keep is copied aside, as
 * `marks.json.dropped-<time>`, and the others kept. Either way the file is
 * rewritten at once and `problem` says what happened: once, since the next
 * read finds a file with nothing wrong.
 */
export async function loadMarksFile(dir: string, now: () => Date = () => new Date()): Promise<{ file: MarksFile; problem?: string }> {
  const path = join(dir, FOLDER, NAME)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { file: { next: 1, marks: [] } }
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON
  }
  const read = readMarksFile(parsed)
  if (read && read.dropped === 0) return { file: read.file }

  const stamp = now().toISOString().replace(/[:.]/g, '-')
  if (!read) {
    const aside = `${NAME}.corrupt-${stamp}`
    // Copied, not moved: were the write below to fail, the next read must find the bad file again, and its ids with it.
    await copyFile(path, join(dir, FOLDER, aside))
    const file: MarksFile = { next: salvagedNext(text, parsed), marks: [] }
    await writeFileAtomic(path, textOf(file))
    return { file, problem: `The marks file of this object could not be read. It was kept as ${FOLDER}/${aside}, and a new list was started.` }
  }
  const aside = `${NAME}.dropped-${stamp}`
  await copyFile(path, join(dir, FOLDER, aside))
  await writeFileAtomic(path, textOf(read.file))
  const what = read.dropped === 1 ? '1 mark in the marks file of this object was' : `${read.dropped} marks in the marks file of this object were`
  return { file: read.file, problem: `${what} not of a kind this version of torno can read, and left out. The file as it was is kept as ${FOLDER}/${aside}.` }
}

/** Writes `<dir>/.torno/marks.json`, creating the folder. Readers see the old file or the new one, never half of one. */
export function saveMarksFile(dir: string, file: MarksFile): Promise<void> {
  return writeFileAtomic(join(dir, FOLDER, NAME), textOf(sanitiseMarksFile(file) ?? { next: 1, marks: [] }))
}

function textOf(file: MarksFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * Keeps what a marks file may hold: the marks that are whole, each id once,
 * and a `next` past every id in it. Null when the value is not a marks file.
 */
export function sanitiseMarksFile(value: unknown): MarksFile | null {
  return readMarksFile(value)?.file ?? null
}

/**
 * `sanitiseMarksFile`, and how many entries of `marks` it left out. `next` is
 * past the id of every entry that has one, kept or not: an id that was given
 * out is never given out again.
 */
function readMarksFile(value: unknown): { file: MarksFile; dropped: number } | null {
  if (!isRecord(value) || !Array.isArray(value.marks)) return null
  const marks: Mark[] = []
  const seen = new Set<string>()
  let next = idNumber(value.next) ?? 1
  for (const raw of value.marks) {
    const given = isRecord(raw) && typeof raw.id === 'string' ? idNumber(Number(/^M(\d+)$/.exec(raw.id)?.[1])) : undefined
    if (given !== undefined) next = Math.max(next, given + 1)
    const mark = sanitiseMark(raw)
    if (!mark || seen.has(mark.id)) continue
    seen.add(mark.id)
    marks.push(mark)
  }
  return { file: { next, marks }, dropped: value.marks.length - marks.length }
}

/**
 * Where the ids of a fresh list start after a file that could not be read:
 * past its `next` and past every mark id that can be made out in its text.
 */
function salvagedNext(text: string, parsed: unknown): number {
  let next = (isRecord(parsed) ? idNumber(parsed.next) : undefined) ?? 1
  for (const match of text.matchAll(/"next"\s*:\s*(\d+)/g)) next = Math.max(next, idNumber(Number(match[1])) ?? 1)
  for (const match of text.matchAll(/"M(\d+)"/g)) next = Math.max(next, (idNumber(Number(match[1])) ?? 0) + 1)
  return next
}

/** A number an id can have, or a file can say is next: a whole one from 1 that still counts exactly. */
function idNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER ? value : undefined
}

/**
 * A mark with only the fields a mark has, or null when the value is not one:
 * a kind this version does not know, a field missing or of the wrong sort, a
 * number that is not finite. Notes and strokes are cut to their limits.
 */
export function sanitiseMark(value: unknown): Mark | null {
  if (!isRecord(value)) return null
  const camera = cameraOf(value.camera)
  if (
    typeof value.id !== 'string' ||
    !/^M[1-9]\d{0,14}$/.test(value.id) ||
    !oneOf(value.author, ['user', 'agent'] as const) ||
    typeof value.note !== 'string' ||
    !oneOf(value.status, ['draft', 'sent', 'resolved'] as const) ||
    !oneOf(value.anchorState, ['ok', 'drifted', 'orphaned'] as const) ||
    typeof value.layout !== 'string' ||
    !isNumber(value.revision) ||
    !camera ||
    typeof value.createdAt !== 'string'
  ) {
    return null
  }
  const base = {
    id: value.id,
    author: value.author,
    note: value.note.slice(0, MAX_NOTE),
    status: value.status,
    anchorState: value.anchorState,
    layout: value.layout,
    revision: value.revision,
    camera,
    createdAt: value.createdAt,
    ...(typeof value.resolvedNote === 'string' ? { resolvedNote: value.resolvedNote.slice(0, MAX_NOTE) } : {}),
    // What main alone says of a mark. A file written before there were any has none, and is whole without.
    ...(value.status === 'resolved' && oneOf(value.resolvedBy, ['user', 'agent'] as const) ? { resolvedBy: value.resolvedBy } : {}),
    ...(value.status === 'resolved' && value.resolvedBy === 'agent' && value.acknowledged === true ? { acknowledged: true as const } : {}),
    ...(value.sentBefore === true ? { sentBefore: true as const } : {}),
    ...(isNumber(value.checkedRevision) ? { checkedRevision: value.checkedRevision } : {})
  }
  const anchor = anchorOf(value.anchor)
  switch (value.kind) {
    case 'pin':
      return anchor ? { ...base, kind: 'pin', anchor } : null
    case 'pick':
      return anchor && oneOf(value.target, ['face', 'edge', 'part'] as const) ? { ...base, kind: 'pick', target: value.target, anchor } : null
    case 'arrow': {
      const from = anchorOf(value.from)
      const to = tuple<Vec3>(value.to, 3)
      return from && to ? { ...base, kind: 'arrow', from, to } : null
    }
    case 'stroke':
      return anchor ? strokeOf(base, anchor, value) : null
    case 'shape': {
      const position = tuple<Vec3>(value.position, 3)
      const rotation = tuple<Quat>(value.rotation, 4)
      const size = tuple<Vec3>(value.size, 3)
      if (!oneOf(value.shape, ['box', 'cylinder', 'sphere', 'plane'] as const)) return null
      if (!oneOf(value.intent, ['add', 'remove', 'keep-out', 'reference'] as const)) return null
      if (!position || !rotation || !size) return null
      return { ...base, kind: 'shape', shape: value.shape, intent: value.intent, position, rotation, size: shapeSize(value.shape, size), ...(anchor ? { anchor } : {}) }
    }
    default:
      return null
  }
}

/**
 * The size of a shape as its kind has it, whoever asked for it: a box three
 * sides, a cylinder one diameter (twice) and a height, a sphere one diameter
 * (three times), a plane a width and a height and no thickness. Nothing it
 * has is less than a tenth of a millimetre.
 */
export function shapeSize(shape: ShapeKind, [x, y, z]: Vec3): Vec3 {
  const least = (side: number): number => Math.max(side, MIN_SHAPE_SIZE)
  if (shape === 'cylinder') return [least(x), least(x), least(z)]
  if (shape === 'sphere') return [least(x), least(x), least(x)]
  if (shape === 'plane') return [least(x), least(y), 0]
  return [least(x), least(y), least(z)]
}

/** A stroke has the points of its space: 3D points on a surface, or a plane and 2D points on it. */
function strokeOf(base: Omit<StrokeMark, 'kind' | 'space' | 'anchor'>, anchor: Anchor, value: Record<string, unknown>): StrokeMark | null {
  if (value.space === 'surface') {
    if (!Array.isArray(value.points)) return null
    return { ...base, kind: 'stroke', space: 'surface', anchor, points: tuples<Vec3>(value.points, 3) }
  }
  if (value.space === 'plane') {
    const plane = isRecord(value.plane) ? value.plane : {}
    const origin = tuple<Vec3>(plane.origin, 3)
    const x = tuple<Vec3>(plane.x, 3)
    const y = tuple<Vec3>(plane.y, 3)
    if (!origin || !x || !y || typeof plane.label !== 'string' || !Array.isArray(value.points2d)) return null
    return { ...base, kind: 'stroke', space: 'plane', anchor, plane: { origin, x, y, label: planeLabel(plane.label) }, points2d: tuples<[number, number]>(value.points2d, 2) }
  }
  return null
}

/** An anchor needs its point; what else it says is kept when it is of the right sort. */
function anchorOf(value: unknown): Anchor | null {
  if (!isRecord(value)) return null
  const point = tuple<Vec3>(value.point, 3)
  if (!point) return null
  const anchor: Anchor = { point }
  const normal = tuple<Vec3>(value.normal, 3)
  if (normal) anchor.normal = normal
  if (typeof value.part === 'string') anchor.part = value.part
  if (typeof value.ref === 'string') anchor.ref = value.ref
  if (typeof value.descriptor === 'string') anchor.descriptor = value.descriptor
  const arranged = tuple<Vec3>(value.arranged, 3)
  if (arranged) anchor.arranged = arranged
  if (typeof value.edge === 'string') anchor.edge = value.edge
  if (Array.isArray(value.between) && value.between.length === 2 && value.between.every((ref) => typeof ref === 'string')) anchor.between = [value.between[0], value.between[1]]
  return anchor
}

function cameraOf(value: unknown): Camera | null {
  if (!isRecord(value)) return null
  const position = tuple<Vec3>(value.position, 3)
  const target = tuple<Vec3>(value.target, 3)
  const up = tuple<Vec3>(value.up, 3)
  if (!position || !target || !up || typeof value.ortho !== 'boolean' || !isNumber(value.fov) || !isNumber(value.zoom)) return null
  return { position, target, up, ortho: value.ortho, fov: value.fov, zoom: value.zoom }
}

/** A copy of `value` when it is exactly `length` finite numbers. */
function tuple<T extends number[]>(value: unknown, length: T['length']): T | null {
  return Array.isArray(value) && value.length === length && value.every(isNumber) ? ([...value] as T) : null
}

/** The points of a stroke that are points, up to the most a stroke keeps. */
function tuples<T extends number[]>(values: unknown[], length: T['length']): T[] {
  const kept: T[] = []
  for (const value of values) {
    if (kept.length === MAX_STROKE_POINTS) break
    const point = tuple<T>(value, length)
    if (point) kept.push(point)
  }
  return kept
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The longest label a plane keeps. */
export const MAX_PLANE_LABEL = 120

/** A plane's label as it is kept: on one line and no longer than `MAX_PLANE_LABEL`. The agent is given it as it is. */
function planeLabel(label: string): string {
  return label.replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, ' ').trim().slice(0, MAX_PLANE_LABEL)
}

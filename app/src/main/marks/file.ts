import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Anchor, Mark, MarksFile, Quat, StrokeMark, Vec3 } from '../../shared/marks'
import type { Camera } from '../../shared/view'

const FOLDER = '.torno'
const NAME = 'marks.json'

/** The longest note a mark keeps, in characters. */
export const MAX_NOTE = 2000
/** The most points a stroke keeps. */
export const MAX_STROKE_POINTS = 400

/**
 * The marks of the object in `dir`. A missing file is an empty list. A file
 * that is not a marks file is moved aside, as `marks.json.corrupt-<time>`
 * beside it, and an empty list started; `problem` then says so, once, since
 * the next read finds no file. A file that cannot be read at all is an error.
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
  let file: MarksFile | null = null
  try {
    file = sanitiseMarksFile(JSON.parse(text))
  } catch {
    // not JSON
  }
  if (file) return { file }
  const aside = `${NAME}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`
  await rename(path, join(dir, FOLDER, aside))
  return {
    file: { next: 1, marks: [] },
    problem: `The marks file of this object could not be read. It was kept as ${FOLDER}/${aside}, and a new list was started.`
  }
}

/** The last write to each file, so that saves of one file land in the order they were made. */
const writes = new Map<string, Promise<void>>()

/** Writes `<dir>/.torno/marks.json`, creating the folder. Readers see the old file or the new one, never half of one. */
export function saveMarksFile(dir: string, file: MarksFile): Promise<void> {
  const folder = join(dir, FOLDER)
  const path = join(folder, NAME)
  const text = `${JSON.stringify(sanitiseMarksFile(file) ?? { next: 1, marks: [] }, null, 2)}\n`
  const write = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, text)
      await rename(temp, path)
    })
    .finally(() => {
      if (writes.get(path) === write) writes.delete(path)
    })
  writes.set(path, write)
  return write
}

/**
 * Keeps what a marks file may hold: the marks that are whole, each id once,
 * and a `next` past every id in it. Null when the value is not a marks file.
 */
export function sanitiseMarksFile(value: unknown): MarksFile | null {
  if (!isRecord(value) || !Array.isArray(value.marks)) return null
  const marks: Mark[] = []
  const seen = new Set<string>()
  let next = Number.isSafeInteger(value.next) && (value.next as number) >= 1 ? (value.next as number) : 1
  for (const raw of value.marks) {
    const mark = sanitiseMark(raw)
    if (!mark || seen.has(mark.id)) continue
    seen.add(mark.id)
    marks.push(mark)
    next = Math.max(next, Number(mark.id.slice(1)) + 1)
  }
  return { next, marks }
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
    ...(typeof value.resolvedNote === 'string' ? { resolvedNote: value.resolvedNote.slice(0, MAX_NOTE) } : {})
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
      return { ...base, kind: 'shape', shape: value.shape, intent: value.intent, position, rotation, size, ...(anchor ? { anchor } : {}) }
    }
    default:
      return null
  }
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
    return { ...base, kind: 'stroke', space: 'plane', anchor, plane: { origin, x, y, label: plane.label }, points2d: tuples<[number, number]>(value.points2d, 2) }
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

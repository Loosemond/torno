import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Quat, Vec3 } from '../../shared/marks'
import { type AlignStep, type Scan, type ScanAlignment, type ScanImport, type ScanPair, type ScanSource, type ScanTransform, type ScansFile, MAX_PAIRS } from '../../shared/scans'
import { canonical, reckoned } from '../../shared/align'
import { FOLDER, ownTorno, writeOwn } from '../own'
import { MESH, MESH_NAME, SCAN_ID, nextFolderId } from './meshfiles'

const NAME = 'scans.json'

/** The longest name a scan keeps, in characters. */
export const MAX_SCAN_NAME = 80
export { MAX_PAIRS }
/** The most steps an alignment says it was made by: the last ones. */
export const MAX_STEPS = 8
/** The longest name of a part an alignment keeps: a longer one names no part. */
const MAX_PART_NAME = 200
/** How far from the origin an alignment may put a scan, in mm: the kernel refuses coordinates beyond. */
const MAX_COORDINATE = 1e9
/** The least and the most an alignment may scale a scan by. */
const SCALE = { min: 1e-6, max: 1e6 }

/**
 * The scans of the object in `dir`. A missing file is an empty list, and
 * nothing is written. A file that cannot be read at all is an error.
 *
 * A file that is not a scans file is copied aside, as
 * `scans.json.corrupt-<time>` beside it, and an empty list started whose ids
 * go on from the highest the old file is seen to have given out. A file some
 * of whose scans are not scans this version can keep is copied aside, as
 * `scans.json.dropped-<time>`, and the others kept. Either way the file is
 * rewritten at once and `problem` says what happened. The meshes under
 * `.torno/scans/` are left as they are.
 *
 * Whatever the file says, or no file, `next` is past every scan folder
 * there is under `.torno/scans/`: an id that has a folder was given out.
 */
export async function loadScansFile(dir: string, now: () => Date = () => new Date()): Promise<{ file: ScansFile; problem?: string }> {
  const path = join(dir, FOLDER, NAME)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { file: { next: await nextFolderId(dir), scans: [] } }
    throw e
  }
  const folders = await nextFolderId(dir)
  const past = (file: ScansFile): ScansFile => ({ ...file, next: Math.max(file.next, folders) })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON
  }
  const read = readScansFile(parsed)
  // Revisions count from 1 in every run: the build an alignment was made on is not one of this run's.
  if (read) for (const scan of read.file.scans) for (const alignment of Object.values(scan.alignments)) forgetRevision(alignment)
  if (read && read.dropped === 0) return { file: past(read.file) }

  const stamp = now().toISOString().replace(/[:.]/g, '-')
  await ownTorno(dir)
  if (!read) {
    const aside = `${NAME}.corrupt-${stamp}`
    // Copied, not moved: were the write below to fail, the next read must find the bad file again, and its ids with it.
    await copyFile(path, join(dir, FOLDER, aside))
    const file = past({ next: salvagedNext(text, parsed), scans: [] })
    await writeOwn(dir, NAME, textOf(file))
    return { file, problem: `The scans file of this object could not be read. It was kept as ${FOLDER}/${aside}, and a new list was started. The meshes of its scans are still in ${FOLDER}/scans/.` }
  }
  const aside = `${NAME}.dropped-${stamp}`
  await copyFile(path, join(dir, FOLDER, aside))
  const file = past(read.file)
  await writeOwn(dir, NAME, textOf(file))
  const what = read.dropped === 1 ? '1 scan in the scans file of this object was' : `${read.dropped} scans in the scans file of this object were`
  return { file, problem: `${what} not one this version of torno can read, and left out. The file as it was is kept as ${FOLDER}/${aside}, and the meshes are still in ${FOLDER}/scans/.` }
}

function forgetRevision(alignment: ScanAlignment): void {
  for (const one of [alignment, ...(alignment.before ? [alignment.before as ScanAlignment] : [])]) {
    delete one.revision
    if (one.confirmed) delete one.confirmed.revision
  }
}

/** Writes `<dir>/.torno/scans.json`, creating the folder. Readers see the old file or the new one, never half of one. */
export function saveScansFile(dir: string, file: ScansFile): Promise<void> {
  return writeOwn(dir, NAME, textOf(readScansFile(file)?.file ?? { next: 1, scans: [] }))
}

function textOf(file: ScansFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * What a scans file may hold: the scans that are whole, each id once, and a
 * `next` past the id of every entry that has one, kept or not: an id that
 * was given out is never given out again. Null when the value is no scans
 * file. `dropped` counts the entries left out.
 */
function readScansFile(value: unknown): { file: ScansFile; dropped: number } | null {
  if (!isRecord(value) || !Array.isArray(value.scans)) return null
  const scans: Scan[] = []
  const seen = new Set<string>()
  let next = idNumber(value.next) ?? 1
  for (const raw of value.scans) {
    const given = isRecord(raw) && typeof raw.id === 'string' ? idNumber(Number(/^S(\d+)$/.exec(raw.id)?.[1])) : undefined
    if (given !== undefined) next = Math.max(next, given + 1)
    const scan = sanitiseScan(raw)
    if (!scan || seen.has(scan.id)) continue
    seen.add(scan.id)
    scans.push(scan)
  }
  return { file: { next, scans }, dropped: value.scans.length - scans.length }
}

/** Where the ids of a fresh list start after a file that could not be read: past its `next` and past every scan id that can be made out in its text. */
function salvagedNext(text: string, parsed: unknown): number {
  let next = (isRecord(parsed) ? idNumber(parsed.next) : undefined) ?? 1
  for (const match of text.matchAll(/"next"\s*:\s*(\d+)/g)) next = Math.max(next, idNumber(Number(match[1])) ?? 1)
  for (const match of text.matchAll(/"S(\d+)"/g)) next = Math.max(next, (idNumber(Number(match[1])) ?? 0) + 1)
  return next
}

/** A number an id can have, or a file can say is next: a whole one from 1 that still counts exactly. */
function idNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER ? value : undefined
}

export { SCAN_ID }

/**
 * A scan with only the fields a scan has, or null when the value is not one:
 * a field missing or of the wrong sort, a number that is not finite, a unit
 * or an up axis this version does not know. An alignment that is not one is
 * left out: the scan is then not aligned in that layout.
 */
export function sanitiseScan(value: unknown): Scan | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !SCAN_ID.test(value.id) || typeof value.name !== 'string') return null
  const source = sourceOf(value.source)
  const imported = importOf(value.imported)
  if (!source || !imported) return null
  const alignments: Array<[string, ScanAlignment]> = []
  for (const [layout, raw] of Object.entries(isRecord(value.alignments) ? value.alignments : {})) {
    const alignment = sanitiseAlignment(raw)
    // A layout is a name of the model's: one line, and no longer than any tool would say whole.
    if (isName(layout, MAX_LAYOUT_NAME) && alignment) alignments.push([layout, alignment])
  }
  // By `fromEntries`: a layout may have any name, and is a key of its own whatever it is.
  return { id: value.id, name: scanName(value.name) || value.id, source, imported, alignments: Object.fromEntries(alignments) }
}

/** A scan's name as it is kept: on one line, trimmed, and no longer than `MAX_SCAN_NAME`. Empty when there is nothing to it. */
export function scanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim().slice(0, MAX_SCAN_NAME).trim()
}

/** The longest name of a layout an alignment is kept for, and the longest path of a source. */
export const MAX_LAYOUT_NAME = 200
export const MAX_SOURCE_PATH = 4096
/** One line of at most so many characters: what is read from a file reaches the agent, and is not taken on trust. */
const isName = (text: string, most: number): boolean => text !== '' && text.length <= most && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(text)

function sourceOf(value: unknown): ScanSource | null {
  // A path on one line, of a length a path has. (One that is not whole is kept, and refused when it is to be read again.)
  if (isRecord(value) && typeof value.path === 'string' && !isName(value.path, MAX_SOURCE_PATH)) return null
  if (!isRecord(value) || typeof value.path !== 'string' || value.path === '' || !isCount(value.bytes) || !isNumber(value.mtimeMs) || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null
  return { path: value.path, bytes: value.bytes, mtimeMs: value.mtimeMs, sha256: value.sha256 }
}

function importOf(value: unknown): ScanImport | null {
  if (!isRecord(value)) return null
  const assumed = isRecord(value.assumed) ? value.assumed : {}
  const bbox = isRecord(value.bbox) ? value.bbox : {}
  const min = tuple<Vec3>(bbox.min, 3)
  const max = tuple<Vec3>(bbox.max, 3)
  if (
    !oneOf(value.unit, ['mm', 'cm', 'm', 'in'] as const) ||
    !oneOf(value.up, ['y', 'z'] as const) ||
    typeof assumed.unit !== 'boolean' ||
    typeof assumed.up !== 'boolean' ||
    !isCount(value.vertices) ||
    !isCount(value.triangles) ||
    !oneOf(value.colours, ['texture', 'vertex', 'none'] as const) ||
    !min ||
    !max ||
    min.some((low, axis) => low > max[axis]) ||
    !isNumber(value.area) ||
    value.area < 0 ||
    typeof value.at !== 'string' ||
    // A record that names a file torno would not have written is of no mesh torno knows.
    (value.mesh !== undefined && (typeof value.mesh !== 'string' || !MESH_NAME.test(value.mesh)))
  ) {
    return null
  }
  const reduced = isRecord(value.reduced) && isCount(value.reduced.from) && isNumber(value.reduced.cell) ? { from: value.reduced.from, cell: value.reduced.cell } : null
  return {
    unit: value.unit,
    up: value.up,
    assumed: { unit: assumed.unit, up: assumed.up },
    vertices: value.vertices,
    triangles: value.triangles,
    colours: value.colours,
    bbox: { min, max },
    area: value.area,
    ...(reduced ? { reduced } : {}),
    at: value.at,
    ...(typeof value.mesh === 'string' && value.mesh !== MESH ? { mesh: value.mesh } : {})
  }
}

/**
 * An alignment with only what an alignment has, or null when the value is
 * not one: no transform of finite numbers, a scale that is none, a turn that
 * is none (all zeros), no step this version knows, a place further off than
 * the kernel reckons with. Its rotation is kept as a unit quaternion, of its
 * two signs the one with w ≥ 0. What follows from the transform and the pairs
 * is worked out here, whatever the value says of it (`reckoned`): each pair's
 * residual, their rms, whether the scan was scaled, why it is rough. Pairs that are not two points are left out, and no more than
 * `MAX_PAIRS` kept; of its steps the last `MAX_STEPS`; a part whose name is
 * longer than a name is not named.
 */
export function sanitiseAlignment(value: unknown): ScanAlignment | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !isRecord(value.frame)) return null
  const transform = transformOf(value.transform)
  const steps = Array.isArray(value.steps) ? value.steps.filter((step): step is AlignStep => oneOf(step, ['floor', 'pairs', 'nudge', 'typed'] as const)) : []
  if (!transform || steps.length === 0) return null
  const alignment: ScanAlignment = { transform, steps: steps.slice(-MAX_STEPS), frame: {}, at: value.at }
  if (Array.isArray(value.pairs)) {
    const pairs: ScanPair[] = []
    for (const raw of value.pairs) {
      if (pairs.length === MAX_PAIRS) break
      const scan = isRecord(raw) ? tuple<Vec3>(raw.scan, 3) : null
      const model = isRecord(raw) ? tuple<Vec3>(raw.model, 3) : null
      if (!isRecord(raw) || !scan || !model) continue
      pairs.push({ scan, model, ...(isPartName(raw.part) ? { part: raw.part } : {}), residual: isNumber(raw.residual) && raw.residual >= 0 ? raw.residual : 0 })
    }
    alignment.pairs = pairs
  }
  if (isNumber(value.rms) && value.rms >= 0) alignment.rms = value.rms
  if (value.scaled === true) alignment.scaled = true
  const floor = isRecord(value.floor) ? tuple<Vec3>(value.floor.point, 3) : null
  if (isRecord(value.floor) && floor) alignment.floor = { ...(isPartName(value.floor.part) ? { part: value.floor.part } : {}), point: floor }
  const frame: Array<[string, Vec3]> = []
  for (const [part, raw] of Object.entries(value.frame)) {
    const arranged = tuple<Vec3>(raw, 3)
    if (arranged && isPartName(part)) frame.push([part, arranged])
  }
  alignment.frame = Object.fromEntries(frame)
  if (isRevision(value.revision)) alignment.revision = value.revision
  if (value.sourceChanged === true) alignment.sourceChanged = true
  if (isNumber(value.fitRms) && value.fitRms >= 0) alignment.fitRms = value.fitRms
  if (isRecord(value.confirmed) && typeof value.confirmed.at === 'string' && Array.isArray(value.confirmed.held)) {
    // Where the model was under each tied point; what is no point (a part that was not there, a file of another shape) is none.
    const held = value.confirmed.held.slice(0, MAX_PAIRS + 1).map((point) => tuple<Vec3>(point, 3))
    alignment.confirmed = { ...(isRevision(value.confirmed.revision) ? { revision: value.confirmed.revision } : {}), at: value.confirmed.at, held }
  }
  // One step back and no further: what was before the one before is not kept.
  if (value.before === null) alignment.before = null
  else if (value.before !== undefined) {
    const before = sanitiseAlignment(value.before)
    if (before) {
      delete before.before
      alignment.before = before
    }
  }
  return reckoned(alignment)
}

function transformOf(value: unknown): ScanTransform | null {
  if (!isRecord(value)) return null
  const t = tuple<Vec3>(value.t, 3)
  const q = tuple<Quat>(value.q, 4)
  if (!t || !q || !isNumber(value.s) || value.s < SCALE.min || value.s > SCALE.max || t.some((c) => Math.abs(c) > MAX_COORDINATE)) return null
  const length = Math.hypot(...q)
  // A quaternion of zeros, or of nothing that counts, is no turn at all: not one to take for "not turned".
  if (!Number.isFinite(length) || length <= 1e-12) return null
  return { t, q: canonical(q), s: value.s }
}

/** A copy of `value` when it is exactly `length` finite numbers. */
function tuple<T extends number[]>(value: unknown, length: T['length']): T | null {
  return Array.isArray(value) && value.length === length && value.every(isNumber) ? ([...value] as T) : null
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value)
}

/** A build's number in a run: a whole one from 1. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isPartName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PART_NAME
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** How many of something: a whole number, none or more. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

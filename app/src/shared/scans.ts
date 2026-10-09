import { fitNumber, number } from './format'
import type { Quat, Vec3 } from './marks'

export type ScanUnit = 'mm' | 'cm' | 'm' | 'in'
export type ScanUp = 'y' | 'z'
export const UNIT_MM: Record<ScanUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 }
export const SCAN_FORMATS = ['.glb', '.gltf', '.obj', '.ply', '.stl'] as const
export const MAX_SCAN_TRIANGLES = 2_000_000

/** Scan frame (mm, Z up, as imported) to the object frame of one layout: p' = s · R(q) · p + t. `s` is 1 unless a fit was made with scale. */
export interface ScanTransform { t: Vec3; q: Quat; s: number }
export const IDENTITY: ScanTransform = { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }

export type AlignStep = 'floor' | 'pairs' | 'nudge' | 'typed'
/** One pair of an alignment: a point of the scan, in the scan frame, and where it belongs, in the object frame of the layout. */
export interface ScanPair { scan: Vec3; model: Vec3; part?: string /* the part the model point was clicked on */; residual: number /* mm, after the fit */ }
export interface ScanAlignment {
  transform: ScanTransform
  /** How it came to be, in order: `['floor', 'pairs', 'nudge']`. Never empty. */
  steps: AlignStep[]
  pairs?: ScanPair[]
  /** Of the last fit: of the pairs, or of the floor patch about its plane. mm. */
  rms?: number
  /** The fit changed the scan's size. */
  scaled?: boolean
  /** The floor was laid on a face of this part, at this point of it (object frame). */
  floor?: { part?: string; point: Vec3 }
  /** `Part.arranged` of every part of the layout when it was aligned, zeros for a part that was not moved. */
  frame: Record<string, Vec3>
  at: string // ISO
  /** The build it was made on. Of this run: dropped when the file is read, like a mark's `checkedRevision`. */
  revision?: number
  /**
   * Why it is only rough, when it is: no pairs of points, fewer than three, pairs in a line, or pairs left further
   * apart than `ROUGH_RMS_MM` (`roughOf` in `shared/align.ts`). Worked out by main, and kept only once the person
   * said yes to it. Whatever reports the scan says so.
   */
  rough?: string
  /** The scan was imported again from a source that was no longer the file it was aligned with. Until it is aligned again, or the person says it still holds. */
  sourceChanged?: true
  /** The alignment this one took the place of, for one undo: null when the scan was not aligned there before. Absent when there is nothing to undo. */
  before?: Omit<ScanAlignment, 'before'> | null
}
/** What only main says of an alignment: never taken from the window or from a tool's arguments. */
export const ALIGNMENT_MAIN_ONLY = ['frame', 'at', 'revision', 'rough', 'sourceChanged', 'before'] as const
/** What a caller gives to align: main adds the rest. */
export type NewAlignment = Omit<ScanAlignment, (typeof ALIGNMENT_MAIN_ONLY)[number]>
/**
 * What goes with an alignment to be kept: the build it was fitted on, and what the person said yes to. An
 * alignment that is rough, or that changes the scan's size, is kept only with that yes.
 */
export interface AlignMade { revision: number; rough?: boolean; scaled?: boolean }

/** What main found when it checked an alignment against a build (`main/scans/alignCheck.ts`). Never stored: revisions are of this run. */
export interface AlignmentCheck { revision: number; of: number; off: number; worst: number; moved: string[] }

export interface ScanSource { path: string /* absolute */; bytes: number; mtimeMs: number; sha256: string }
export interface ScanImport {
  unit: ScanUnit
  up: ScanUp
  /** Whether each was assumed from the format and the size, not chosen by the person. */
  assumed: { unit: boolean; up: boolean }
  vertices: number
  triangles: number
  colours: 'texture' | 'vertex' | 'none'
  bbox: { min: Vec3; max: Vec3 } // scan frame
  area: number // mm²
  reduced?: { from: number; cell: number }
  at: string
  /** The file of its mesh in the scan's folder, when that is not `mesh.bin`: a conversion writes another, and this is what says it was made. Main's alone. */
  mesh?: string
}
/** A scan as `scans.json` keeps it. */
export interface Scan {
  id: string // 'S1'
  name: string
  source: ScanSource
  imported: ScanImport
  alignments: Record<string, ScanAlignment> // by layout
}
export interface ScansFile { next: number; scans: Scan[] }

/** A scan as main tells it: with what it found on the disk and at the last build. */
export interface ScanInfo extends Scan {
  sourceState: 'present' | 'missing' | 'changed'
  meshState: 'ok' | 'missing'
  checks: Record<string, AlignmentCheck> // by layout; absent for one not checked in this run
}

/**
 * What came of importing a scan again from its source, into the id it has. `sourceChanged`: the file is not the one
 * that was read before (another hash). `meshChanged`: the mesh has other vertex or triangle counts. With either, what
 * was checked of its alignments is forgotten: they are to be looked at again.
 */
export interface Reimported { scan: ScanInfo; sourceChanged: boolean; meshChanged: boolean }

/** The least a scan is thinned to: under it, it could not be found again. */
export const MIN_SCAN_OPACITY = 0.05

/** How a scan is looked at: view state, kept in scene.json by scan id. */
export interface ScanView { visible?: boolean; opacity?: number; colour?: 'own' | 'plain' }

export interface ScanMesh { vertices: Float32Array; colours: Uint8Array | null; triangles: Uint32Array; bbox: { min: Vec3; max: Vec3 } }

// The layout of a `mesh.bin` and of a `.mask`: `kernel/src/torno_kernel/scanfile.py` writes and reads the same.
const MESH_MAGIC = 'TORNOSCN'
const MASK_MAGIC = 'TORNOMSK'
const VERSION = 1
const MESH_HEADER = 64
const MASK_HEADER = 16

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

/** Views into a `mesh.bin`; nothing is copied. Throws a RangeError that says what is wrong with the bytes. */
export function parseScanMesh(blob: ArrayBuffer): ScanMesh {
  if (blob.byteLength < MESH_HEADER || ascii(new Uint8Array(blob, 0, 8)) !== MESH_MAGIC) throw new RangeError(`${blob.byteLength} bytes is not a scan torno wrote`)
  const header = new DataView(blob, 0, MESH_HEADER)
  const version = header.getUint32(8, true)
  if (version !== VERSION) throw new RangeError(`a scan of version ${version}: this torno reads version ${VERSION}`)
  const coloured = (header.getUint32(12, true) & 1) === 1
  const v = header.getUint32(16, true)
  const t = header.getUint32(20, true)
  const expected = MESH_HEADER + 12 * v + (coloured ? 4 * v : 0) + 12 * t
  if (blob.byteLength !== expected) throw new RangeError(`the scan has ${blob.byteLength} bytes, and its header says ${expected}`)
  const vertices = new Float32Array(blob, MESH_HEADER, 3 * v)
  const colours = coloured ? new Uint8Array(blob, MESH_HEADER + 12 * v, 4 * v) : null
  const triangles = new Uint32Array(blob, MESH_HEADER + 12 * v + (coloured ? 4 * v : 0), 3 * t)
  let highest = -1
  for (let n = 0; n < triangles.length; n++) if (triangles[n] > highest) highest = triangles[n]
  if (highest >= v) throw new RangeError(`a triangle names vertex ${highest}, and there are ${v}`)
  const corner = (at: number): Vec3 => [header.getFloat32(at, true), header.getFloat32(at + 4, true), header.getFloat32(at + 8, true)]
  return { vertices, colours, triangles, bbox: { min: corner(24), max: corner(36) } }
}

/** The bytes of a `.mask` for a bitset over `triangles` triangles. Throws a RangeError for a bitset of another length. */
export function maskFile(bits: Uint8Array, triangles: number): Uint8Array {
  const length = Math.ceil(triangles / 8)
  if (bits.length !== length) throw new RangeError(`a region of a mesh of ${triangles} triangles is ${length} bytes of bits, not ${bits.length}`)
  const file = new Uint8Array(MASK_HEADER + length)
  for (let n = 0; n < 8; n++) file[n] = MASK_MAGIC.charCodeAt(n)
  const header = new DataView(file.buffer)
  header.setUint32(8, VERSION, true)
  header.setUint32(12, triangles, true)
  file.set(bits, MASK_HEADER)
  return file
}

/** The bitset of a `.mask`, as a view into it. Throws a RangeError for a file of another length or count. */
export function maskBits(file: Uint8Array, triangles: number): Uint8Array {
  if (file.length < MASK_HEADER || ascii(file.subarray(0, 8)) !== MASK_MAGIC) throw new RangeError(`${file.length} bytes is not a region torno wrote`)
  const header = new DataView(file.buffer, file.byteOffset, MASK_HEADER)
  const version = header.getUint32(8, true)
  if (version !== VERSION) throw new RangeError(`a region of version ${version}: this torno reads version ${VERSION}`)
  const count = header.getUint32(12, true)
  if (count !== triangles) throw new RangeError(`a region of a mesh of ${count} triangles, not ${triangles}`)
  const expected = MASK_HEADER + Math.ceil(count / 8)
  if (file.length !== expected) throw new RangeError(`the region has ${file.length} bytes, and its header says ${expected}`)
  return file.subarray(MASK_HEADER)
}

/** `aligned` | `not aligned`: whether the scan has a transform for the layout. */
export function alignmentOf(scan: Pick<Scan, 'alignments'>, layout: string): ScanAlignment | null {
  return Object.hasOwn(scan.alignments, layout) ? scan.alignments[layout] : null
}

/**
 * Why an alignment may no longer hold, as a sentence, or null: what the last check against a build found, and
 * whether the scan itself was read again from a changed source since. One notion, with its reasons.
 */
export function staleText(check: AlignmentCheck | undefined, alignment?: Pick<ScanAlignment, 'sourceChanged'> | null): string | null {
  const why: string[] = []
  if (alignment?.sourceChanged) why.push('the scan was imported again from a source that had changed since it was aligned')
  if (check && check.moved.length > 0) why.push(`torno has moved ${check.moved.join(', ')} for display since it was aligned`)
  if (check && check.off > 0) why.push(`the model is no longer under ${count(check.off)} of its ${count(check.of)} points (worst ${number(check.worst)} mm off) on r${check.revision}`)
  return why.length > 0 ? `${why.join(', and ')}: check the alignment` : null
}

/** Why the alignment of a scan in a layout may no longer hold (`staleText`); null when it holds as far as is known, or the scan is not aligned there. */
export function doubtOf(scan: Pick<ScanInfo, 'alignments' | 'checks'>, layout: string): string | null {
  const alignment = alignmentOf(scan, layout)
  return alignment ? staleText(Object.hasOwn(scan.checks, layout) ? scan.checks[layout] : undefined, alignment) : null
}

/** `by floor + 4 pairs (rms 2.1 mm, worst 3.4 mm)`; `by floor only: its place in that plane is as imported`. */
export function alignmentText(alignment: ScanAlignment): string {
  const pairs = alignment.pairs ?? []
  const rms = alignment.rms === undefined ? null : `rms ${fitNumber(alignment.rms)} mm`
  // A floor says how high the scan stands and how it leans, and nothing of where it is on that floor.
  if (alignment.steps.length === 1 && alignment.steps[0] === 'floor') return `by floor only${rms ? ` (plane ${rms})` : ''}: its place in that plane is as imported`
  const said = alignment.steps.map((step) => {
    if (step === 'typed') return 'typed values'
    if (step !== 'pairs') return step
    const fit = [...(rms ? [rms] : []), ...(pairs.length > 0 ? [`worst ${fitNumber(Math.max(...pairs.map((pair) => pair.residual)))} mm`] : [])]
    return `${count(pairs.length)} ${pairs.length === 1 ? 'pair' : 'pairs'}${fit.length > 0 ? ` (${fit.join(', ')})` : ''}${alignment.scaled ? ', scaled' : ''}`
  })
  return `by ${said.join(' + ')}`
}

/** `2518 × 2351 × 1494 mm, from m, Y up (assumed)`. */
export function importText(imported: ScanImport): string {
  const { min, max } = imported.bbox
  const size = max.map((c, axis) => number(c - min[axis])).join(' × ')
  const assumed = imported.assumed.unit && imported.assumed.up ? ' (assumed)' : imported.assumed.unit ? ' (unit assumed)' : imported.assumed.up ? ' (up assumed)' : ''
  const reduced = imported.reduced ? `, reduced from ${count(imported.reduced.from)} triangles` : ''
  return `${size} mm, from ${imported.unit}, ${imported.up.toUpperCase()} up${assumed}${reduced}`
}

const count = (n: number): string => n.toLocaleString('en-US')

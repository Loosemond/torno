import type { ExplodeState } from './explode'
import { number } from './format'
import type { Mark, MarkStatus, Quat, Vec3 } from './marks'
import type { SavedView } from './views'

// What an exported page holds, and how a mesh is packed into it. Pure: main packs (`main/export/build.ts`), the
// page unpacks (`export/viewer`). Nothing here is of the machine it was written on: no path, no folder, no name
// of a person. What is in a file is what the person ticked in the export sheet, and nothing else.

export const EXPORT_VERSION = 1

export interface PackedMesh {
  vertices: number
  triangles: number
  /** Edge segments (two points each). */
  segments: number
  /** Positions and edge points are u16 per coordinate: lo + q / 65535 × span, in the part's own frame. */
  lo: [number, number, number]
  span: [number, number, number]
  /** Triangle indices are u32 (true) or u16. */
  wide: boolean
  /** base64 of zlib-deflated bytes: positions (u16 × 3 × vertices), normals (i8 × 3 × vertices, a pad byte when odd), indices, edge points (u16 × 6 × segments). Little-endian. */
  data: string
}

export interface ExportPart {
  name: string
  layout: string
  loc: { t: Vec3; q: Quat }
  bbox: { min: Vec3; max: Vec3 }
  color: string
  opacity: number
  visible: boolean
  faces: number
  /** Key into `meshes`. */
  mesh: string
  /** A solid made of a mesh: it has no edges in the file, and the page draws the creases of its surface. */
  creased?: true
}

/**
 * A mark as the page tells it: where it is, its note, and of a dimension what torno measured on the build
 * exported. The page measures nothing: `text`, `verdict` and `how` are the kernel's, through torno, of that build.
 */
export interface ExportMark {
  id: string
  kind: Mark['kind']
  author: 'user' | 'agent'
  layout: string
  note: string
  status: MarkStatus
  /** The part it is on: drawn apart, it goes with that part. */
  part?: string
  /** The parts its two ends are at, when it has two (a dimension between two ends, an arrow whose head is at another part): drawn apart otherwise than one another, it is not drawn. */
  ends?: [string | null, string | null]
  at: Vec3
  line?: Vec3[]
  /** A dimension's value as torno's row says it: `6 mm`, or `—` when it has none of the build exported. */
  text?: string
  verdict?: 'pass' | 'fail'
  /** What it should measure: `8.5 ± 0.05 mm`. */
  expected?: string
  /** How the kernel took the value: `between planes`. */
  how?: string
  /** In place of a value: `not measured on r3`, `not measurable`. Of a shape: what it is. */
  says?: string
  /** The build moved what it is on since it was placed. */
  moved?: true
  /** No check of this build confirmed where it is. */
  unchecked?: true
}

export interface ExportScan {
  id: string
  name: string
  triangles: number
  reducedFrom: number
  colours: boolean
  /** Positions are u16 per coordinate in this box, in the scan's own frame. */
  lo: Vec3
  span: Vec3
  /** base64 of zlib-deflated bytes: `vertices`, then positions (u16 × 3), colours when it has them (u8 × 3), a pad byte when that leaves an odd count, and indices (u16, or u32 above 65,535 vertices). Little-endian. */
  data: string
  vertices: number
  /** By layout: where it stands in each it is aligned in. It is drawn only there. */
  placed: Record<string, { t: Vec3; q: Quat; s: number }>
}

export interface ExportObject {
  id: string
  name: string
  revision: number
  layouts: string[]
  layout: string
  parts: ExportPart[]
  /** By the part's content hash: the same shape in two layouts is in the file once. */
  meshes: Record<string, PackedMesh>
  explode: Record<string, ExplodeState>
  views: SavedView[]
  marks?: ExportMark[]
  scans?: ExportScan[]
}

export interface ExportData {
  format: 'torno-export'
  version: 1
  title: string
  /** ISO time. */
  exportedAt: string
  objects: ExportObject[]
  /** What was reduced or left out to keep the file under its budget, a sentence each: the page says it too. */
  dropped: string[]
}

export interface MeshArrays { positions: Float32Array; normals: Float32Array; triangles: Uint32Array; edges: Float32Array }

const q16 = (value: number, lo: number, span: number): number => (span > 0 ? Math.round(((value - lo) / span) * 65535) : 0)

/** The bytes that are deflated, and the header that reads them back. A coordinate comes back within half of `span / 65535` of what it was. */
export function packMesh(mesh: MeshArrays): { header: Omit<PackedMesh, 'data'>; bytes: Uint8Array } {
  const vertices = mesh.positions.length / 3
  const triangles = mesh.triangles.length / 3
  const segments = mesh.edges.length / 6
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  // The edges with the vertices: an edge's point may lie a hair outside the box of the triangles' corners.
  for (const points of [mesh.positions, mesh.edges]) for (let i = 0; i < points.length; i++) {
    if (points[i] < lo[i % 3]) lo[i % 3] = points[i]
    if (points[i] > hi[i % 3]) hi[i % 3] = points[i]
  }
  if (!Number.isFinite(lo[0])) {
    lo.fill(0)
    hi.fill(0)
  }
  const span = hi.map((h, i) => h - lo[i]) as [number, number, number]
  const wide = vertices > 65535
  const normalBytes = vertices * 3 + ((vertices * 3) & 1)
  const bytes = new Uint8Array(vertices * 6 + normalBytes + triangles * 3 * (wide ? 4 : 2) + segments * 12)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (let i = 0; i < vertices * 3; i++, at += 2) view.setUint16(at, q16(mesh.positions[i], lo[i % 3], span[i % 3]), true)
  for (let i = 0; i < vertices * 3; i++) view.setInt8(at + i, Math.round(Math.min(Math.max(mesh.normals[i] || 0, -1), 1) * 127))
  at += normalBytes
  for (let i = 0; i < triangles * 3; i++, at += wide ? 4 : 2) {
    if (wide) view.setUint32(at, mesh.triangles[i], true)
    else view.setUint16(at, mesh.triangles[i], true)
  }
  for (let i = 0; i < segments * 6; i++, at += 2) view.setUint16(at, q16(mesh.edges[i], lo[i % 3], span[i % 3]), true)
  return { header: { vertices, triangles, segments, lo, span, wide }, bytes }
}

/** The most of anything a mesh in a page may claim to have: a header is read from a file, and sizes what is allocated. */
const MOST = 50_000_000

/** A mesh out of its bytes. Throws a RangeError for a header that is none, or bytes that are not of its counts. */
export function unpackMesh(header: Omit<PackedMesh, 'data'>, bytes: Uint8Array): MeshArrays {
  const { vertices, triangles, segments, lo, span, wide } = header
  for (const count of [vertices, triangles, segments]) if (!Number.isSafeInteger(count) || count < 0 || count > MOST) throw new RangeError(`${count} is no count of a mesh`)
  const normalBytes = vertices * 3 + ((vertices * 3) & 1)
  const expected = vertices * 6 + normalBytes + triangles * 3 * (wide ? 4 : 2) + segments * 12
  if (bytes.length !== expected) throw new RangeError(`${expected} bytes were expected, ${bytes.length} came`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const indices = new Uint32Array(triangles * 3)
  const edges = new Float32Array(segments * 6)
  let at = 0
  for (let i = 0; i < positions.length; i++, at += 2) positions[i] = lo[i % 3] + (view.getUint16(at, true) / 65535) * span[i % 3]
  for (let i = 0; i < normals.length; i++) normals[i] = view.getInt8(at + i) / 127
  at += normalBytes
  for (let i = 0; i < indices.length; i++, at += wide ? 4 : 2) indices[i] = wide ? view.getUint32(at, true) : view.getUint16(at, true)
  for (let i = 0; i < edges.length; i++, at += 2) edges[i] = lo[i % 3] + (view.getUint16(at, true) / 65535) * span[i % 3]
  return { positions, normals, triangles: indices, edges }
}

export interface ScanArrays { positions: Float32Array; colours: Uint8Array | null /* r g b a per vertex */; triangles: Uint32Array }

/** A scan's bytes for a page: positions to a 65535th of its box, a colour of three bytes a vertex when it has colours. */
export function packScan(scan: ScanArrays): { header: Pick<ExportScan, 'vertices' | 'triangles' | 'colours' | 'lo' | 'span'>; bytes: Uint8Array } {
  const vertices = scan.positions.length / 3
  const triangles = scan.triangles.length / 3
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < scan.positions.length; i++) {
    if (scan.positions[i] < lo[i % 3]) lo[i % 3] = scan.positions[i]
    if (scan.positions[i] > hi[i % 3]) hi[i % 3] = scan.positions[i]
  }
  if (!Number.isFinite(lo[0])) {
    lo.fill(0)
    hi.fill(0)
  }
  const span = hi.map((h, i) => h - lo[i]) as Vec3
  const wide = vertices > 65535
  const colourBytes = scan.colours ? vertices * 3 : 0
  const pad = colourBytes & 1
  const bytes = new Uint8Array(vertices * 6 + colourBytes + pad + triangles * 3 * (wide ? 4 : 2))
  const view = new DataView(bytes.buffer)
  let at = 0
  for (let i = 0; i < vertices * 3; i++, at += 2) view.setUint16(at, q16(scan.positions[i], lo[i % 3], span[i % 3]), true)
  if (scan.colours) for (let v = 0; v < vertices; v++) for (let c = 0; c < 3; c++) bytes[at + v * 3 + c] = scan.colours[v * 4 + c]
  at += colourBytes + pad
  for (let i = 0; i < triangles * 3; i++, at += wide ? 4 : 2) {
    if (wide) view.setUint32(at, scan.triangles[i], true)
    else view.setUint16(at, scan.triangles[i], true)
  }
  return { header: { vertices, triangles, colours: scan.colours !== null, lo, span }, bytes }
}

/** A scan out of its bytes: colours come back as three bytes a vertex. Throws a RangeError as `unpackMesh` does. */
export function unpackScan(header: Pick<ExportScan, 'vertices' | 'triangles' | 'colours' | 'lo' | 'span'>, bytes: Uint8Array): { positions: Float32Array; colours: Uint8Array | null; triangles: Uint32Array } {
  const { vertices, triangles, lo, span } = header
  for (const count of [vertices, triangles]) if (!Number.isSafeInteger(count) || count < 0 || count > MOST) throw new RangeError(`${count} is no count of a mesh`)
  const wide = vertices > 65535
  const colourBytes = header.colours ? vertices * 3 : 0
  const pad = colourBytes & 1
  const expected = vertices * 6 + colourBytes + pad + triangles * 3 * (wide ? 4 : 2)
  if (bytes.length !== expected) throw new RangeError(`${expected} bytes were expected, ${bytes.length} came`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const positions = new Float32Array(vertices * 3)
  let at = 0
  for (let i = 0; i < positions.length; i++, at += 2) positions[i] = lo[i % 3] + (view.getUint16(at, true) / 65535) * span[i % 3]
  const colours = header.colours ? bytes.slice(at, at + colourBytes) : null
  at += colourBytes + pad
  const indices = new Uint32Array(triangles * 3)
  for (let i = 0; i < indices.length; i++, at += wide ? 4 : 2) {
    const index = wide ? view.getUint32(at, true) : view.getUint16(at, true)
    if (index >= vertices) throw new RangeError(`a triangle names vertex ${index}, and there are ${vertices}`)
    indices[i] = index
  }
  return { positions, colours, triangles: indices }
}

/** What the person asks to be written: the objects, whether their marks go with them, and each scan they ticked. */
export interface ExportRequest {
  objects: string[]
  marks: boolean
  /** `<objectId>/<scanId>` of each scan the person ticked. */
  scans: string[]
  /** The parts that are switched off in torno go too (switched off in the page as well). Without it they are left out, with their meshes and the marks on them. */
  hidden?: boolean
  /** With the marks, those that are resolved go too. Without it they are left out. */
  resolved?: boolean
  title?: string
}

/** What a file of a request would hold and weigh, said before anything is written. */
export interface ExportPlan {
  objects: Array<{
    id: string
    exportable: boolean
    why?: string
    revision?: number
    triangles?: number
    layouts?: string[]
    /** The model has failed since: the file would be of its last good build. */
    failed?: true
    /** How many parts would go, by name; and how many it has that are switched off in torno, which go only when asked (`hidden`). `triangles` is of those that go. */
    parts?: number
    off?: number
    /** The saved views that would go: the person's, and those of the agent's they kept. */
    views?: string[]
    /** The marks that would go if marks were ticked, as the request stands: those that are no dimension, and the dimensions; how many of the two are drafts the agent was never sent; and how many resolved ones there are, which go only when asked (`resolved`). */
    marks?: number
    dimensions?: number
    drafts?: number
    resolved?: number
    /** The scans that can be ticked: those with a mesh, aligned in a layout of the build. */
    scans: Array<{ id: string; name: string; triangles: number }>
  }>
  /** What the file would weigh, and what was cut or left out to keep it under the budget, a sentence each. */
  bytes: number
  dropped: string[]
  /** It is over the budget all the same: the parts alone are. */
  over: boolean
  /** What a file should weigh at most, in bytes. */
  budget: number
  /** Why nothing would be written: no object chosen, or more than torno writes in one file. */
  refusal?: string
}

/** A size as it is said: `0.6 MB`, `1.4 MB`, `71 MB`. To a tenth under ten megabytes, whole from there: it is an estimate. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${number(mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb))} MB`
}

/** Said in the export sheet above the scans, whenever an object that is ticked has one. */
export const SCAN_WARNING = 'A scan may show the real world: a room, a number plate. It is left out unless you tick it, and is then reduced to at most 60,000 triangles.'

/** Whether a record that was read from a file, or is keyed by a name someone chose, has `key` as its own: a part may be called `constructor`. */
export function own<T>(record: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return record !== null && record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

/** A record with no keys but those put into it: for whatever is keyed by the name of a part or a layout. */
export function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

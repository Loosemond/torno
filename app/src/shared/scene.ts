export interface Buf { offset: number; length: number }        // bytes into the blob; offset % 4 === 0
export interface PartMesh {
  vertices: Buf          // float32 xyz, part-local
  normals: Buf           // float32 xyz
  triangles: Buf         // uint32, 3 per triangle
  edges: Buf             // float32, 6 per segment (x1 y1 z1 x2 y2 z2), part-local
  trianglesPerFace: Buf  // uint32, one per face, in face order
  segmentsPerEdge: Buf   // uint32, one per edge, in kernel edge order
  faceTypes: Buf         // uint32 GeomAbs_SurfaceType
  edgeTypes: Buf         // uint32 GeomAbs_CurveType
}
export interface Part {
  key: string            // `${layout}:${name}`, unique in a scene
  name: string
  layout: string         // "assembly" | "print" | "main"
  loc: { t: [number, number, number]; q: [number, number, number, number] }  // local → object frame, quaternion xyzw
  bbox: { min: [number, number, number]; max: [number, number, number] }      // object frame, from the mesh
  volume: number         // mm³, exact
  faceCount: number
  edgeCount: number
  triangleCount: number
  valid: boolean
  hash: string
  mesh: PartMesh
  /** The translation the kernel applied to set an overlapping print layout side by side; absent when it applied none. `loc`, `bbox` and the mesh include it. */
  arranged?: [number, number, number]
}
export interface Scene { model: string; layouts: string[]; parts: Part[]; seconds: number; output: string }

type BufArray = Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>
type BufArrayConstructor<T extends BufArray> = {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T
  readonly BYTES_PER_ELEMENT: number
  readonly name: string
}

/** A typed view of one `Buf` of a scene blob. It shares the blob's memory; nothing is copied. */
export function bufView<T extends BufArray>(blob: ArrayBuffer, buf: Buf, type: BufArrayConstructor<T>): T {
  const { offset, length } = buf
  const size = type.BYTES_PER_ELEMENT
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new RangeError(`bufView: offset ${offset} and length ${length} must be non-negative integers`)
  }
  if (offset % 4 !== 0) {
    throw new RangeError(`bufView: offset ${offset} is not a multiple of 4`)
  }
  if (length % size !== 0) {
    throw new RangeError(`bufView: length ${length} is not a whole number of ${type.name} elements`)
  }
  if (offset + length > blob.byteLength) {
    throw new RangeError(`bufView: bytes ${offset}..${offset + length} run past the end of a ${blob.byteLength}-byte blob`)
  }
  return new type(blob, offset, length / size)
}

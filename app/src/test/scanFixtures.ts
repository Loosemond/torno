// Scans made by test code. Nothing here is a file in the repository, and none is the owner's.
type Vec3 = [number, number, number]

const BOX = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]

/** A box: 8 vertices, 12 triangles facing out. Vertex 4·i + 2·j + k is at (±x, ±y, ±z), minus first. */
export function box(size: Vec3 = [40, 30, 5], centre: Vec3 = [0, 0, 0]): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push(centre[0] + (x * size[0]) / 2, centre[1] + (y * size[1]) / 2, centre[2] + (z * size[2]) / 2)
  return { vertices, triangles: BOX.flat() }
}

/** A flat square sheet facing +Z: `count` vertices a side, `cell` apart, centred on the Z axis, lifted by `height(x, y)`. */
export function grid(count = 30, cell = 1, height: (x: number, y: number) => number = () => 0): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = []
  const triangles: number[] = []
  const at = (n: number): number => (n - (count - 1) / 2) * cell
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) vertices.push(at(i), at(j), height(at(i), at(j)))
  for (let i = 0; i < count - 1; i++) {
    for (let j = 0; j < count - 1; j++) {
      const a = i * count + j
      triangles.push(a, a + count, a + count + 1, a, a + count + 1, a + 1)
    }
  }
  return { vertices, triangles }
}

/** A rigid move of a mesh: turned by `degrees` about +Z, then moved by `by`. */
export function moved(mesh: { vertices: number[]; triangles: number[] }, degrees: number, by: Vec3): { vertices: number[]; triangles: number[] } {
  const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)]
  const vertices: number[] = []
  for (let n = 0; n < mesh.vertices.length; n += 3) {
    const [x, y, z] = mesh.vertices.slice(n, n + 3)
    vertices.push(c * x - s * y + by[0], s * x + c * y + by[1], z + by[2])
  }
  return { vertices, triangles: mesh.triangles }
}

/** A binary STL of a mesh. */
export function stl(mesh: { vertices: number[]; triangles: number[] }): Buffer {
  const count = mesh.triangles.length / 3
  const out = Buffer.alloc(84 + 50 * count)
  out.writeUInt32LE(count, 80)
  for (let n = 0; n < count; n++) {
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.triangles[n * 3 + corner] * 3
      for (let axis = 0; axis < 3; axis++) out.writeFloatLE(mesh.vertices[v + axis], 84 + 50 * n + 12 + 12 * corner + 4 * axis)
    }
  }
  return out
}

/** A `mesh.bin` of a mesh, as the import process would write it; `colours` are r g b a bytes, one quad a vertex. */
export function meshBin(mesh: { vertices: number[]; triangles: number[] }, colours?: number[]): ArrayBuffer {
  const v = mesh.vertices.length / 3
  const t = mesh.triangles.length / 3
  const out = new ArrayBuffer(64 + 12 * v + (colours ? 4 * v : 0) + 12 * t)
  const view = new DataView(out)
  new Uint8Array(out).set(new TextEncoder().encode('TORNOSCN'))
  view.setUint32(8, 1, true)
  view.setUint32(12, colours ? 1 : 0, true)
  view.setUint32(16, v, true)
  view.setUint32(20, t, true)
  for (let axis = 0; axis < 3; axis++) {
    const along = mesh.vertices.filter((_, n) => n % 3 === axis)
    view.setFloat32(24 + 4 * axis, Math.min(...along), true)
    view.setFloat32(36 + 4 * axis, Math.max(...along), true)
  }
  new Float32Array(out, 64, 3 * v).set(mesh.vertices)
  if (colours) new Uint8Array(out, 64 + 12 * v, 4 * v).set(colours)
  new Uint32Array(out, 64 + 12 * v + (colours ? 4 * v : 0), 3 * t).set(mesh.triangles)
  return out
}

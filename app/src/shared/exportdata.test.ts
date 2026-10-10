import { describe, expect, it } from 'vitest'
import { megabytes, packMesh, unpackMesh } from './exportdata'

const box = {
  positions: new Float32Array([-20, -15, -2.5, 20, -15, -2.5, 20, 15, -2.5, -20, 15, 2.5, 3.14159, -7.5, 1.25]),
  normals: new Float32Array([0, 0, -1, 0, 0, -1, 0.6, 0.8, 0, -1, 0, 0, 0, 0, 1]),
  triangles: new Uint32Array([0, 2, 1, 0, 3, 2, 1, 2, 4]),
  edges: new Float32Array([-20, -15, -2.5, 20, -15, -2.5, 20, -15, -2.5, 20, 15, -2.5])
}

describe('packMesh', () => {
  it('comes back within a 65535th of the part\'s size, with its triangles to the number', () => {
    const { header, bytes } = packMesh(box)
    expect(header).toMatchObject({ vertices: 5, triangles: 3, segments: 2, wide: false, lo: [-20, -15, -2.5], span: [40, 30, 5] })
    // 5 vertices: 30 bytes of positions, 15 of normals and one to keep the rest even, 18 of indices, 24 of edges.
    expect(bytes).toHaveLength(30 + 16 + 18 + 24)
    const back = unpackMesh(header, bytes)
    expect([...back.triangles]).toEqual([...box.triangles])
    for (let i = 0; i < box.positions.length; i++) expect(Math.abs(back.positions[i] - box.positions[i])).toBeLessThanOrEqual(header.span[i % 3] / 65535 / 2 + 1e-6)
    for (let i = 0; i < box.normals.length; i++) expect(Math.abs(back.normals[i] - box.normals[i])).toBeLessThan(1 / 127)
    for (let i = 0; i < box.edges.length; i++) expect(Math.abs(back.edges[i] - box.edges[i])).toBeLessThanOrEqual(header.span[i % 3] / 65535 / 2 + 1e-6)
  })

  it('uses wide indices above 65,535 vertices, and takes a flat part and an empty one', () => {
    const many = { positions: new Float32Array(65536 * 3), normals: new Float32Array(65536 * 3), triangles: new Uint32Array([0, 1, 65535]), edges: new Float32Array(0) }
    const wide = packMesh(many)
    expect(wide.header.wide).toBe(true)
    expect([...unpackMesh(wide.header, wide.bytes).triangles]).toEqual([0, 1, 65535])
    const none = packMesh({ positions: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0), edges: new Float32Array(0) })
    expect(none.header).toMatchObject({ vertices: 0, lo: [0, 0, 0], span: [0, 0, 0] })
    expect(none.bytes).toHaveLength(0)
    // A part with no size along an axis comes back where it was.
    const flat = packMesh({ ...box, positions: new Float32Array([1, 2, 3, 5, 2, 3, 5, 6, 3]), normals: new Float32Array(9), triangles: new Uint32Array([0, 1, 2]), edges: new Float32Array(0) })
    expect(unpackMesh(flat.header, flat.bytes).positions[2]).toBe(3)
  })

  it('refuses bytes that are not of the header\'s counts', () => {
    const { header, bytes } = packMesh(box)
    expect(() => unpackMesh(header, bytes.subarray(0, 40))).toThrow('88 bytes were expected, 40 came')
    expect(() => unpackMesh({ ...header, vertices: 1e9 }, bytes)).toThrow(RangeError)
  })

  it('refuses a header that is no header, whatever a file edited by hand says', () => {
    const { header, bytes } = packMesh(box)
    expect(() => unpackMesh({ ...header, triangles: -1 }, bytes)).toThrow(RangeError)
    expect(() => unpackMesh({ ...header, segments: 1.5 }, bytes)).toThrow(RangeError)
  })
})

describe('packScan', () => {
  it('comes back where it was, with its colours, and refuses what is not its own', async () => {
    const { packScan, unpackScan } = await import('./exportdata')
    const scan = { positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 50, 7]), colours: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]), triangles: new Uint32Array([0, 1, 2]) }
    const { header, bytes } = packScan(scan)
    expect(header).toMatchObject({ vertices: 3, triangles: 1, colours: true, lo: [0, 0, 0], span: [100, 50, 7] })
    // 18 of positions, 9 of colours and one to keep the rest even, 6 of indices.
    expect(bytes).toHaveLength(18 + 10 + 6)
    const back = unpackScan(header, bytes)
    expect([...back.positions]).toEqual([0, 0, 0, 100, 0, 0, 0, 50, 7])
    expect([...back.colours!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect([...back.triangles]).toEqual([0, 1, 2])
    expect(unpackScan(...Object.values(packScan({ ...scan, colours: null })) as [typeof header, Uint8Array]).colours).toBeNull()
    expect(() => unpackScan({ ...header, vertices: 2 }, bytes)).toThrow(RangeError)
    const lying = bytes.slice()
    lying[lying.length - 2] = 9
    expect(() => unpackScan(header, lying)).toThrow('a triangle names vertex 9, and there are 3')
  })
})

it('says a size to a tenth of a megabyte, and whole from ten', () => {
  expect(megabytes(678_787)).toBe('0.6 MB')
  expect(megabytes(1.44 * 1024 * 1024)).toBe('1.4 MB')
  expect(megabytes(12 * 1024 * 1024)).toBe('12 MB')
  expect(megabytes(71.3 * 1024 * 1024)).toBe('71 MB')
})

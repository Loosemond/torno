import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { box, meshBin } from '../../test/scanFixtures'
import { buildScan, linearColours, placeScan } from './scanMesh'

describe('linearColours', () => {
  it('turns sRGB bytes into linear light, three a vertex', () => {
    expect([...linearColours(new Uint8Array([0, 128, 255, 255, 255, 0, 128, 255]))]).toEqual([0, 14146, 65535, 65535, 0, 14146])
  })
})

describe('buildScan', () => {
  it('draws a coloured scan unlit, in its own colours, from both sides', () => {
    const built = buildScan('S1', meshBin(box([40, 30, 5]), new Array(32).fill(255)))
    expect(built).toMatchObject({ id: 'S1', vertices: 8, triangles: 12 })
    expect(built.mesh.material).toBe(built.own)
    expect(built.own).toMatchObject({ vertexColors: true, side: THREE.DoubleSide })
    expect(built.mesh.geometry.getAttribute('color').count).toBe(8)
    expect(built.mesh.geometry.getAttribute('normal')).toBeUndefined()
    // The triangles are in the file's order: a triangle's number means the same everywhere.
    expect([...built.mesh.geometry.index!.array.slice(0, 6)]).toEqual([0, 1, 3, 0, 3, 2])
    expect(built.mesh.geometry.boundsTree).toBeUndefined()
  })

  it('draws a scan without colours lit and flat, and owns its data', () => {
    const blob = meshBin(box())
    const built = buildScan('S2', blob)
    expect(built.own).toBeNull()
    expect(built.mesh.material).toBe(built.plain)
    expect(built.plain).toMatchObject({ flatShading: true, side: THREE.DoubleSide, polygonOffset: true })
    new Float32Array(blob, 64, 3).fill(999)
    expect(built.mesh.geometry.getAttribute('position').getX(0)).toBe(-20)
  })

  // Fix round 1: the box is the one the file says, and the sphere is round it: no pass over the vertices for either.
  it('takes its box from the file and its sphere from the box', () => {
    const blob = meshBin(box([40, 30, 5]))
    new DataView(blob).setFloat32(36, 25, true) // the header's max x, as only the header says it
    const { geometry } = buildScan('S1', blob).mesh
    expect(geometry.boundingBox!.min.toArray()).toEqual([-20, -15, -2.5])
    expect(geometry.boundingBox!.max.toArray()).toEqual([25, 15, 2.5])
    expect(geometry.boundingSphere!.center.toArray()).toEqual([2.5, 0, 0])
    expect(geometry.boundingSphere!.radius).toBeCloseTo(Math.hypot(22.5, 15, 2.5), 5)
  })

  it('stands where its transform says, scaled when a fit scaled it', () => {
    const built = buildScan('S1', meshBin(box()))
    placeScan(built, { t: [10, 20, 30], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], s: 2 })
    built.group.updateMatrixWorld(true)
    // (1, 0, 0) turned a quarter about Z, doubled, moved.
    expect(new THREE.Vector3(1, 0, 0).applyMatrix4(built.group.matrixWorld).toArray().map((c) => Math.round(c * 1e6) / 1e6)).toEqual([10, 22, 30])
  })
})

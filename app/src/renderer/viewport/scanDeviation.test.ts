import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { grid, meshBin } from '../../test/scanFixtures'
import { MAX_COLOURED, deviationColour, deviationColours, linearOf, type Rgb } from './scanDeviation'
import { buildScan, placeScan } from './scanMesh'

const COLOURS = { near: [1, 0, 0] as Rgb, far: [0, 0, 1] as Rgb, inside: [0, 0, 0] as Rgb }

it('runs from the near colour at the part to the far one at the range and beyond, and marks what is inside', () => {
  expect(deviationColour(0, false, 20, COLOURS)).toEqual([1, 0, 0])
  expect(deviationColour(10, false, 20, COLOURS)).toEqual([0.5, 0, 0.5])
  expect(deviationColour(20, false, 20, COLOURS)).toEqual([0, 0, 1])
  expect(deviationColour(500, false, 20, COLOURS)).toEqual([0, 0, 1])
  expect(deviationColour(3, true, 20, COLOURS)).toEqual([0, 0, 0])
})

/** A box 20 × 20 × 10 standing on z = 0, as a part is built: its mesh in its own frame, placed by its group. */
function boxPart(solid: boolean, at: [number, number, number] = [0, 0, 5]) {
  const geometry = new THREE.BoxGeometry(20, 20, 10)
  geometry.boundsTree = new MeshBVH(geometry, { indirect: true })
  const group = new THREE.Group()
  group.position.fromArray(at)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  group.add(mesh)
  return { group, mesh, solid }
}
const colourAt = (colours: Uint16Array, vertex: number): Rgb => [colours[3 * vertex], colours[3 * vertex + 1], colours[3 * vertex + 2]]
const stored = (rgb: Rgb): Rgb => rgb.map((c) => Math.round(linearOf(c) * 65535)) as Rgb

describe('the colours of a scan by its distance to a part', () => {
  // A sheet of 3 × 3 vertices 20 mm apart, at z = 4: its middle vertex is inside the box, the others 10 mm and more from it.
  const sheet = () => buildScan('S1', meshBin(grid(3, 20, () => 4)))

  it('gives each vertex the colour of its distance to the part where the two are drawn, and marks one that is inside', () => {
    const scan = sheet()
    placeScan(scan, { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 })
    const colours = deviationColours(scan, boxPart(true), 20, COLOURS)
    expect(colours).toHaveLength(27)
    // The middle one is in the box; its neighbour along X is 10 mm from the box's side, half way along the ramp.
    expect(colourAt(colours, 4)).toEqual(stored(COLOURS.inside))
    expect(colourAt(colours, 1)).toEqual(stored([0.5, 0, 0.5]))
    // A corner is 10 mm off in X and in Y: √200 ≈ 14.14 mm.
    const corner = Math.hypot(10, 10) / 20
    expect(colourAt(colours, 0)).toEqual(stored([1 - corner, 0, corner]))
  })

  it('goes by where the scan and the part stand, not by their own frames', () => {
    const scan = sheet()
    // The scan is moved 30 mm along X, and so is the part: nothing has changed between them.
    placeScan(scan, { t: [30, 0, 0], q: [0, 0, 0, 1], s: 1 })
    const colours = deviationColours(scan, boxPart(true, [30, 0, 5]), 20, COLOURS)
    expect(colourAt(colours, 4)).toEqual(stored(COLOURS.inside))
    // Lifted 100 mm, all of it is beyond the range.
    placeScan(scan, { t: [30, 0, 100], q: [0, 0, 0, 1], s: 1 })
    const far = deviationColours(scan, boxPart(true, [30, 0, 5]), 20, COLOURS)
    for (let v = 0; v < 9; v++) expect(colourAt(far, v)).toEqual(stored(COLOURS.far))
  })

  it('marks nothing as inside a part that is no solid: the vertex is then on its distance to the surface', () => {
    const scan = sheet()
    placeScan(scan, { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 })
    const colours = deviationColours(scan, boxPart(false), 20, COLOURS)
    // 4 mm above the bottom of the box.
    expect(colourAt(colours, 4)).toEqual(stored([0.8, 0, 0.2]))
  })

  it('refuses more vertices near the part than a picture colours, saying how many and what to do', () => {
    const scan = sheet()
    placeScan(scan, { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 })
    expect(() => deviationColours(scan, boxPart(true), 20, COLOURS, 4)).toThrow('9 points of S1 are within 20 mm of the part, more than the 4 a picture colours: ask for a smaller range')
    expect(MAX_COLOURED).toBe(300_000)
  })
})

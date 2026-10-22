import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Camera } from '../../shared/view'
import { hiddenBehind } from './focus'

/** A part of a box, as the picture has one: a mesh in a group that is placed. */
function box(name: string, min: [number, number, number], max: [number, number, number]): { name: string; mesh: THREE.Mesh } {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), new THREE.MeshStandardMaterial())
  mesh.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  mesh.updateMatrixWorld(true)
  return { name, mesh }
}

// Seen from the front the camera is on the -Y side and looks along +Y.
const FRONT: Camera = { position: [0, -500, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 }
const PLATE = box('plate', [-20, -15, -2.5], [20, 15, 2.5])
const LID = box('lid', [-30, -40, -10], [30, -30, 10])
const FAR = box('far', [-5, 100, -5], [5, 110, 5])

describe('what stands between the camera and a focus', () => {
  it('is nothing for a part in plain sight: its own near face is not in the way, nor is what lies behind it', () => {
    expect(hiddenBehind([PLATE, FAR], FRONT, { min: [-20, -15, -2.5], max: [20, 15, 2.5] })).toEqual([])
  })

  it('names a part that lies in front, nearest first, for an orthographic camera and for a perspective one', () => {
    const behind = { min: [-20, -15, -2.5], max: [20, 15, 2.5] } as const
    expect(hiddenBehind([PLATE, LID], FRONT, behind)).toEqual(['lid'])
    const near = box('near', [-30, -80, -10], [30, -70, 10])
    expect(hiddenBehind([PLATE, LID, near], FRONT, behind)).toEqual(['near', 'lid'])
    const seen: Camera = { ...FRONT, position: [0, -300, 0], ortho: false }
    expect(hiddenBehind([PLATE, LID], seen, behind)).toEqual(['lid'])
  })

  it('names the part itself for a face on its far side, which the part hides from this side', () => {
    expect(hiddenBehind([PLATE], FRONT, { min: [-20, 15, -2.5], max: [20, 15, 2.5] })).toEqual(['plate'])
    // From the other side it is the near face.
    expect(hiddenBehind([PLATE], { ...FRONT, position: [0, 500, 0] }, { min: [-20, 15, -2.5], max: [20, 15, 2.5] })).toEqual([])
  })

  it('is nothing when the camera is inside the focus, or when what is in the way is not along the line to its middle', () => {
    expect(hiddenBehind([PLATE, LID], { ...FRONT, position: [0, -35, 0], ortho: false }, { min: [-50, -50, -50], max: [50, 50, 50] })).toEqual([])
    expect(hiddenBehind([PLATE, LID], FRONT, { min: [-20, -15, 12], max: [20, 15, 14] })).toEqual([])
  })

  it('does not count what a cut has taken away', () => {
    const cut = { origin: [0, -35, 0] as [number, number, number], normal: [0, -1, 0] as [number, number, number] }
    // The plane takes away what lies to -Y of y = -35: the lid is from -40 to -30, cut through, and its near half is gone; the half that stays still hides.
    expect(hiddenBehind([PLATE, LID], FRONT, { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, cut)).toEqual(['lid'])
    const away = { origin: [0, -20, 0] as [number, number, number], normal: [0, -1, 0] as [number, number, number] }
    expect(hiddenBehind([PLATE, LID], FRONT, { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, away)).toEqual([])
  })

  it('skips a part that has no mesh', () => {
    expect(hiddenBehind([{ name: 'ghost' }, PLATE], FRONT, { min: [-20, -15, -2.5], max: [20, 15, 2.5] })).toEqual([])
  })
})

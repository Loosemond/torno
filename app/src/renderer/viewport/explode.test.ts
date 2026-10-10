import { describe, expect, it } from 'vitest'
import { explodeOffsets } from '../../shared/explode'
import type { Vec3 } from '../../shared/marks'
import * as THREE from 'three'
import { EXPLODE_MS, PartsApart, asBuilt, drawnAt, drawnBox, reachingApart, leavesView } from './explode'
import type { Hit } from './picking'

const part = (name: string, min: Vec3, max: Vec3) => ({ name, bbox: { min, max } })
const TRAY = part('tray', [-20, -15, 0], [20, 15, 10])
const LID = part('lid', [-20, -15, 10], [20, 15, 12])
const Z = { amount: 1, scale: 1, axis: 'z' } as const
const R = Math.hypot(20, 15, 6)

describe('the parts of a layout, drawn apart', () => {
  it('draws nothing apart until asked, and then each part as far off as the explode says, at once', () => {
    const apart = new PartsApart()
    expect([apart.get(), apart.offsets(), apart.any, apart.moving]).toEqual([null, {}, false, false])
    apart.set(Z, [TRAY, LID])
    expect(apart.get()).toEqual(Z)
    expect(apart.offsets()).toEqual(explodeOffsets([TRAY, LID], Z))
    // Along z upward from the lowest part, which stays: the lid goes the whole of the step.
    expect(apart.offsets().lid[2]).toBeCloseTo(2 * R, 9)
    expect(apart.offsets().tray[2]).toBe(0)
    expect([apart.any, apart.moving]).toEqual([true, false])
    apart.set(null, [TRAY, LID])
    expect([apart.get(), apart.offsets(), apart.any]).toEqual([null, {}, false])
  })

  it('takes an explode of nothing for none', () => {
    const apart = new PartsApart()
    apart.set({ amount: 0, scale: 2, axis: 'x' }, [TRAY, LID])
    expect([apart.get(), apart.offsets()]).toEqual([null, {}])
  })

  it('goes there over a moment when asked to, and says where the parts are drawn meanwhile and where they are going', () => {
    const apart = new PartsApart()
    apart.set(Z, [TRAY, LID], 1000)
    // Nothing has been drawn yet: the parts are where they were.
    expect(apart.offsets()).toEqual({})
    expect(apart.target().lid[2]).toBeCloseTo(2 * R, 9)
    expect([apart.any, apart.moving]).toEqual([true, true])
    expect(apart.step(1000 + EXPLODE_MS / 2)).toBe(true)
    const half = apart.offsets().lid[2]
    expect(half).toBeGreaterThan(0.6 * R)
    expect(half).toBeLessThan(2 * R)
    expect(apart.offsets().tray[2]).toBe(0)
    expect(apart.step(1000 + EXPLODE_MS)).toBe(true)
    expect(apart.offsets()).toEqual(explodeOffsets([TRAY, LID], Z))
    expect(apart.moving).toBe(false)
    // Arrived: nothing more to draw.
    expect(apart.step(1000 + 2 * EXPLODE_MS)).toBe(false)
  })

  it('comes together over a moment too, and is apart until it has', () => {
    const apart = new PartsApart()
    apart.set(Z, [TRAY, LID])
    apart.set(null, [TRAY, LID], 0)
    expect([apart.get(), apart.any, apart.moving]).toEqual([null, true, true])
    apart.step(EXPLODE_MS / 2)
    expect(apart.offsets().lid[2]).toBeGreaterThan(0)
    expect(apart.any).toBe(true)
    apart.step(EXPLODE_MS)
    expect([apart.offsets(), apart.any, apart.moving]).toEqual([{}, false, false])
  })

  it('turns to another explode from wherever it has got to', () => {
    const apart = new PartsApart()
    apart.set(Z, [TRAY, LID], 0)
    apart.step(EXPLODE_MS / 2)
    const from = apart.offsets().lid[2]
    apart.set({ amount: 1, scale: 1, axis: 'x' }, [TRAY, LID], EXPLODE_MS / 2)
    expect(apart.offsets().lid[2]).toBe(from)
    apart.step(EXPLODE_MS * 2)
    expect(apart.offsets().lid).toEqual([expect.closeTo(R, 9), 0, 0])
  })

  it('is of the parts it is given: others are apart as the same explode has them, at once', () => {
    const apart = new PartsApart()
    apart.set(Z, [TRAY, LID], 0)
    const post = part('post', [0, 0, 12], [2, 2, 40])
    apart.over([TRAY, LID, post])
    expect(apart.moving).toBe(false)
    expect(apart.offsets()).toEqual(explodeOffsets([TRAY, LID, post], Z))
    apart.over([TRAY])
    expect([apart.offsets(), apart.any, apart.get()]).toEqual([{}, false, Z])
  })
})

describe('what is picked on a part drawn apart', () => {
  const hit: Hit = { partKey: 'assembly:lid', part: 'lid', kind: 'face', index: 3, ref: 'lid/F3', point: [1, 2, 12 + 26], normal: [0, 0, 1], distance: 80 }

  it('is answered with the point of the part as built: where it is drawn is taken away', () => {
    expect(asBuilt(hit, { lid: [0, 0, 26], tray: [0, 0, -26] })).toEqual({ ...hit, point: [1, 2, 12] })
    // The ref, the normal and how far along the ray it was seen are as they were.
    expect(asBuilt(hit, { lid: [0, 0, 26] })?.distance).toBe(80)
  })

  it('is as it was hit when its part is not moved, or nothing is', () => {
    expect(asBuilt(hit, { tray: [0, 0, -26] })).toBe(hit)
    expect(asBuilt(hit, {})).toBe(hit)
    expect(asBuilt(null, { lid: [0, 0, 26] })).toBeNull()
  })
})

describe('the box round parts as they are drawn', () => {
  it('is round each part moved by how far it is drawn off; the box as built when nothing is', () => {
    expect(drawnBox([TRAY, LID], {})).toEqual({ min: [-20, -15, 0], max: [20, 15, 12] })
    expect(drawnBox([TRAY, LID], { lid: [0, 0, 30], tray: [-5, 0, -10] })).toEqual({ min: [-25, -15, -10], max: [20, 15, 42] })
    expect(drawnBox([], { lid: [0, 0, 30] })).toBeNull()
  })
})

describe('where a part is drawn, and how far the camera must reach', () => {
  it('is where the part is, off by how far it is drawn apart', () => {
    expect(drawnAt({ name: 'lid', loc: { t: [1, 2, 3] } }, { lid: [0, 0, 30] })).toEqual([1, 2, 33])
    expect(drawnAt({ name: 'lid', loc: { t: [1, 2, 3] } }, { tray: [0, 0, 30] })).toEqual([1, 2, 3])
    expect(drawnAt({ name: 'lid', loc: { t: [1, 2, 3] } }, {})).toEqual([1, 2, 3])
  })

  it('holds the parts where they are drawn and where they are going, and is the sphere it was given when nothing is apart', () => {
    const built = new THREE.Sphere(new THREE.Vector3(0, 0, 6), 30)
    const apart = new PartsApart()
    expect(reachingApart(built, [TRAY, LID], apart)).toBe(built)
    apart.set(Z, [TRAY, LID], 0)
    // Not there yet: it reaches where they are going already.
    const reach = reachingApart(built, [TRAY, LID], apart)
    expect(reach).not.toBe(built)
    expect(built.radius).toBe(30)
    // To a hair: the corners of what a sphere is drawn round lie on it.
    for (const corner of [[20, 15, 12 + 2 * R], [-20, -15, 0]]) expect(reach.distanceToPoint(new THREE.Vector3(...corner))).toBeLessThan(1e-9)
    expect(built.distanceToPoint(new THREE.Vector3(20, 15, 12 + 2 * R))).toBeGreaterThan(1)
  })
})

describe('whether parts drawn apart leave the view', () => {
  // A view 200 wide and 100 high, looking down z: a point is on screen where it is in the box, in fractions of the half size.
  const project = (p: Vec3): [number, number] => [p[0] / 100, p[1] / 50]

  it('is so when a corner of any part, where it is going, is off the screen', () => {
    const offsets = { tray: [0, 0, 0] as Vec3, lid: [90, 0, 0] as Vec3 }
    expect(leavesView([TRAY, LID], offsets, project)).toBe(true)
    expect(leavesView([TRAY, LID], { ...offsets, lid: [0, 40, 0] }, project)).toBe(true)
    expect(leavesView([TRAY], offsets, project)).toBe(false)
  })

  it('is not so while every part is still within it, and of no parts', () => {
    expect(leavesView([TRAY, LID], { tray: [-70, 0, 0], lid: [70, 0, 0] }, project)).toBe(false)
    expect(leavesView([TRAY, LID], {}, project)).toBe(false)
    expect(leavesView([], {}, project)).toBe(false)
  })
})

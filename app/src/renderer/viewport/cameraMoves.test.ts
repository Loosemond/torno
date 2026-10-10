import { describe, expect, it } from 'vitest'
import type { Camera } from '../../shared/view'
import { CameraMove, MOVE_MS, between, standingAt } from './cameraMoves'

const ISO: Camera = { position: [90, -90, 110], target: [0, 0, 20], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const TOP: Camera = { position: [0, 0, 180], target: [0, 0, 20], up: [0, 1, 0], ortho: false, fov: 35, zoom: 2 }

describe('a move of the camera', () => {
  it('swings round the target from one view to the other, and is the other once its time is up', () => {
    const move = new CameraMove()
    expect([move.under, move.step(0)]).toEqual([false, null])
    move.begin(ISO, TOP, 1000)
    const half = move.step(1000 + MOVE_MS / 2)!
    expect(move.under).toBe(true)
    expect(half.target).toEqual([0, 0, 20])
    // Half way it is as far from the target as the two are, between them, and half way in zoom.
    expect(Math.hypot(half.position[0], half.position[1], half.position[2] - 20)).toBeCloseTo(Math.sqrt(Math.hypot(90, 90, 90) * 160), 6)
    expect(half.zoom).toBeCloseTo(Math.SQRT2, 9)
    expect(move.step(1000 + MOVE_MS)).toEqual(TOP)
    expect(move.under).toBe(false)
    expect(between(ISO, TOP, 0).position.map((c) => Math.round(c))).toEqual([90, -90, 110])
  })

  it('dropped, it is over where it had got to: nothing takes it to its end', () => {
    const move = new CameraMove()
    move.begin(ISO, TOP, 0)
    move.step(MOVE_MS / 4)
    move.drop()
    expect([move.under, move.step(MOVE_MS)]).toEqual([false, null])
    expect(move).not.toHaveProperty('finish')
  })

  it('leans a camera that looks straight along Z by a hair, so that its up is up on the screen', () => {
    const { position, target } = standingAt(TOP)
    expect(target.toArray()).toEqual([0, 0, 20])
    expect(position.x).toBe(0)
    expect(position.y).toBeLessThan(0)
    expect(Math.abs(position.y)).toBeLessThan(0.01)
    expect(standingAt(ISO).position.toArray()).toEqual([90, -90, 110])
  })
})

describe('where a camera is going', () => {
  it('is the view it was sent to while it is on its way, and nowhere once it has arrived or the move was given up', () => {
    const from = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 } as Camera
    const to = { ...from, position: [100, 0, 0] } as Camera
    const move = new CameraMove()
    expect(move.goal).toBeNull()
    move.begin(from, to, 1000)
    move.step(1100)
    expect(move.goal).toEqual(to)
    move.step(1000 + MOVE_MS)
    expect(move.goal).toBeNull()
    move.begin(from, to, 2000)
    move.drop()
    expect(move.goal).toBeNull()
  })
})

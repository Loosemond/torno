import { expect, it } from 'vitest'
import { facingAxis, newCut, towardsViewer } from './cut'

const BOX = { min: [-20, -15, 0] as [number, number, number], max: [20.011, 15, 10] as [number, number, number] }
const from = (position: [number, number, number]) => ({ position, target: [0, 0, 5] as [number, number, number] })

it('cuts across the axis the camera looks most along, through the middle of the parts', () => {
  expect(facingAxis(from([10, -200, 40]))).toBe('y')
  expect(facingAxis(from([300, -200, 40]))).toBe('x')
  expect(facingAxis(from([10, -20, 400]))).toBe('z')
  // The standard iso view looks no more along one of the two than the other: the first of them, always the same.
  expect(facingAxis(from([100, -100, 60]))).toBe('x')
  expect(newCut(BOX, from([10, -200, 40]))).toEqual({ origin: [0.01, 0, 5], normal: [0, -1, 0] })
})

it('opens towards whoever looks: the half taken away is the one on the camera\'s side', () => {
  expect(towardsViewer(from([300, 0, 0]), 'x')).toBe(1)
  expect(towardsViewer(from([-300, 0, 0]), 'x')).toBe(-1)
  // Level with the plane, it is the +axis side, as a cut always was.
  expect(towardsViewer(from([0, -300, 5]), 'z')).toBe(1)
  expect(newCut(BOX, from([100, -100, 60]), 'y').normal).toEqual([0, -1, 0])
  expect(newCut(BOX, from([100, -100, 60]), 'x').normal).toEqual([1, 0, 0])
  expect(newCut(BOX, from([100, -100, -60]), 'z').normal).toEqual([0, 0, -1])
})

it('puts the plane at the middle to the hundredth of a millimetre, and never at a negative zero', () => {
  const off = { min: [-65.011246, -1, -1] as [number, number, number], max: [65, 1, 1] as [number, number, number] }
  const cut = newCut(off, from([300, 0, 0]), 'x')
  // -0.005623 is what the middle is; told, it reads as if it were meant.
  expect(cut.origin).toEqual([-0.01, 0, 0])
  expect(newCut({ min: [-65.0000048, -1, -1], max: [65, 1, 1] }, from([300, 0, 0]), 'x').origin).toEqual([0, 0, 0])
  expect(Object.is(newCut({ min: [-65.0000048, -1, -1], max: [65, 1, 1] }, from([300, 0, 0]), 'x').origin[0], 0)).toBe(true)
})

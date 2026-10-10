import { expect, it } from 'vitest'
import { toKeep } from './Field'

it('keeps a number that was typed, and nothing that is none or is what the field showed', () => {
  expect(toKeep('0.8', '0', null)).toBe(0.8)
  expect(toKeep(' 0,8 ', '0', null)).toBe(0.8)
  expect(toKeep('0', '0', null)).toBeNull()
  expect(toKeep('', '0', null)).toBeNull()
  expect(toKeep('wide', '0', null)).toBeNull()
})

it('keeps what was typed once: Enter keeps it, and the focus leaving the field afterwards does not keep it again', () => {
  // The value the field was given is still the old one when the blur comes: the store answers later.
  expect(toKeep('90', '0', null)).toBe(90)
  expect(toKeep('90', '0', '90')).toBeNull()
  // Typed over again, it is another value to keep.
  expect(toKeep('45', '0', '90')).toBe(45)
})

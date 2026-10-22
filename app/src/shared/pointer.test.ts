import { expect, it } from 'vitest'
import { matchingPointer } from '../renderer/ui/KeySheet'
import { KEYS } from './keys'
import { POINTER, POINTER_GROUP, pointerLine } from './pointer'

it('says how the pointer moves the view: drag turns, right drag pans, scroll zooms, a double click measures what is round', () => {
  expect(POINTER.map((row) => [row.id, row.gesture])).toEqual([['turn', 'Drag'], ['pan', 'Right drag'], ['zoom', 'Scroll'], ['round', 'Double click']])
  for (const row of POINTER) expect([row.id, /^[A-Z]/.test(row.gesture), /^[A-Z]/.test(row.does)]).toEqual([row.id, true, true])
})

it('has its line for the hint in sentence case, from the three rows that move the view, and names no key', () => {
  expect(pointerLine()).toBe('Drag to turn · right drag to pan · scroll to zoom')
})

it('is no row of the table of keys: a gesture is nothing a handler is told', () => {
  for (const row of POINTER) expect(KEYS.some((key) => (key.id as string) === row.id)).toBe(false)
})

it('is searched in the sheet as the keys are, all the words in any order', () => {
  expect(matchingPointer('').map((row) => row.id)).toEqual(['turn', 'pan', 'zoom', 'round'])
  expect(matchingPointer('pan').map((row) => row.id)).toEqual(['pan'])
  expect(POINTER_GROUP.when).toBe('In the view')
  expect(matchingPointer('zoom scroll').map((row) => row.id)).toEqual(['zoom'])
  expect(matchingPointer('measure round').map((row) => row.id)).toEqual(['round'])
  expect(matchingPointer('nothing does this')).toEqual([])
})

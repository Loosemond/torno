import { expect, it } from 'vitest'
import { commandsFor, rateLine } from './foot'

const at = new Date(2026, 9, 15, 18, 5).getTime()

it('says nothing until a window is half used', () => {
  expect(rateLine({ window: 'five_hour', used: 49, resetsAt: at })).toBeNull()
  expect(rateLine({ window: 'five_hour', used: 0 })).toBeNull()
  expect(rateLine(undefined)).toBeNull()
})

it('names the window, the percent used and when it resets, in the time of the locale', () => {
  expect(rateLine({ window: 'five_hour', used: 72, resetsAt: at }, 'en-GB')).toBe('5-hour limit: 72 % used, resets at 18:05')
  expect(rateLine({ window: 'five_hour', used: 50, resetsAt: at }, 'de-DE')).toBe('5-hour limit: 50 % used, resets at 18:05')
  expect(rateLine({ window: 'five_hour', used: 72, resetsAt: at }, 'en-US')).toMatch(/^5-hour limit: 72 % used, resets at 6:05\s?PM$/)
  expect(rateLine({ window: 'seven_day', used: 91 })).toBe('7-day limit: 91 % used')
  expect(rateLine({ window: 'seven_day_opus', used: 60 })).toBe('7-day opus limit: 60 % used')
})

it('offers the commands for a single /word, and none once there is a space or other text', () => {
  const all = [
    { name: 'compact', description: 'Compact', argumentHint: '' },
    { name: 'clear', description: 'Clear', argumentHint: '' },
    { name: 'review', description: 'Review', argumentHint: '' }
  ]
  expect(commandsFor('/', all).map((c) => c.name)).toEqual(['compact', 'clear', 'review'])
  expect(commandsFor('/c', all).map((c) => c.name)).toEqual(['compact', 'clear'])
  expect(commandsFor('/CO', all).map((c) => c.name)).toEqual(['compact'])
  expect(commandsFor('/compact', all).map((c) => c.name)).toEqual(['compact'])
  expect(commandsFor('/compact ', all)).toEqual([])
  expect(commandsFor('/compact now', all)).toEqual([])
  expect(commandsFor('see /co', all)).toEqual([])
  expect(commandsFor('/zzz', all)).toEqual([])
  expect(commandsFor('', all)).toEqual([])
  expect(commandsFor('/c\nmore', all)).toEqual([])
  // Only a name that begins with what is typed is offered.
  expect(commandsFor('/view', all.concat({ name: 'preview', description: '', argumentHint: '' }, { name: 'view', description: '', argumentHint: '' })).map((c) => c.name)).toEqual(['view'])
})

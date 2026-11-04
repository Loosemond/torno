import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MAX_RECENT, configOf, listed, recentWith, recentWithout } from './recent'

const made: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-recent-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('keeps the folders opened last, the newest first, each once, eight at most', () => {
  expect(recentWith([], '/a')).toEqual(['/a'])
  expect(recentWith(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
  const nine = Array.from({ length: 9 }, (_, i) => `/f${i}`).reduce<string[]>((list, root) => recentWith(list, root), [])
  expect(nine).toHaveLength(MAX_RECENT)
  expect(MAX_RECENT).toBe(8)
  expect(nine[0]).toBe('/f8')
  expect(nine).not.toContain('/f0')
  expect(recentWithout(['/a', '/b'], '/a')).toEqual(['/b'])
  expect(recentWithout(['/a'], '/x')).toEqual(['/a'])
})

it('reads a config file of any age, and nothing from what is not one', () => {
  expect(configOf({ workspace: '/a' })).toEqual({ workspace: '/a', recent: [] })
  expect(configOf({ workspace: '/a', recent: ['/a', 3, '', 'relative', '/b', '/a'] })).toEqual({ workspace: '/a', recent: ['/a', '/b'] })
  expect(configOf({ recent: Array.from({ length: 20 }, (_, i) => `/f${i}`) }).recent).toHaveLength(8)
  expect(configOf(null)).toEqual({ recent: [] })
  expect(configOf('text')).toEqual({ recent: [] })
  expect(configOf({ workspace: 4, recent: 'no' })).toEqual({ recent: [] })
})

it('says which of them is no longer a folder', async () => {
  const dir = temp()
  mkdirSync(join(dir, 'here'))
  writeFileSync(join(dir, 'file'), '')
  expect(await listed([join(dir, 'here'), join(dir, 'gone'), join(dir, 'file')])).toEqual([
    { root: join(dir, 'here'), missing: false },
    { root: join(dir, 'gone'), missing: true },
    { root: join(dir, 'file'), missing: true }
  ])
})

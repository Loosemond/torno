import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EXAMPLE_OBJECTS, copyExample, exampleSource } from './example'
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

it('offers the example only from the repository, and copies it without touching it', async () => {
  const repo = temp()
  const ws = join(repo, 'kernel', 'tests', 'fixtures', 'ws')
  for (const name of [...EXAMPLE_OBJECTS, 'broken']) {
    mkdirSync(join(ws, name, '__pycache__'), { recursive: true })
    writeFileSync(join(ws, name, `${name}.py`), `# ${name}\n`)
    writeFileSync(join(ws, name, '__pycache__', 'x.pyc'), 'x')
    mkdirSync(join(ws, name, '.torno'))
    writeFileSync(join(ws, name, '.torno', 'marks.json'), '{}')
  }
  writeFileSync(join(ws, 'gauge', 'variant.txt'), 'a\n')
  expect(exampleSource(join(repo, 'app'), false)).toBe(ws)
  // An app that was packaged has no repository beside it; nor has one whose fixtures are gone.
  expect(exampleSource(join(repo, 'app'), true)).toBeNull()
  expect(exampleSource(join(repo, 'elsewhere', 'app'), false)).toBeNull()

  const into = temp()
  const before = readdirSync(ws, { recursive: true }).sort()
  const copy = await copyExample(ws, into)
  expect(copy.startsWith(join(into, 'torno-example-'))).toBe(true)
  // The objects that build and show something, their files beside them, and nothing torno or Python wrote there.
  expect(readdirSync(copy).sort()).toEqual([...EXAMPLE_OBJECTS].sort())
  expect(readdirSync(join(copy, 'gauge')).sort()).toEqual(['gauge.py', 'variant.txt'])
  expect(readFileSync(join(copy, 'hollow', 'hollow.py'), 'utf8')).toBe('# hollow\n')
  expect(readdirSync(ws, { recursive: true }).sort()).toEqual(before)
  // Each asking is a copy of its own.
  expect(await copyExample(ws, into)).not.toBe(copy)
})

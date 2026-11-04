import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '../../shared/changes'
import { changesBetween, KeptChanges, MAX_TURNS, snapshotSources } from './snapshots'

const dirs: string[] = []
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-snap-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the snapshot of the sources of a project', () => {
  it('holds the .py files directly in the folder and nothing else', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'hollow.py'), 'W = 2\n')
    writeFileSync(join(dir, 'brief.md'), 'words')
    mkdirSync(join(dir, 'sub.py'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'deep.py'), 'x')
    const snap = await snapshotSources(dir)
    expect([...snap.keys()]).toEqual(['hollow.py'])
  })

  it('does not follow a link', async () => {
    const dir = folder()
    const elsewhere = folder()
    writeFileSync(join(elsewhere, 'secret.py'), 'secret')
    symlinkSync(join(elsewhere, 'secret.py'), join(dir, 'linked.py'))
    expect((await snapshotSources(dir)).size).toBe(0)
  })

  it('is empty for a folder that is not there', async () => {
    expect((await snapshotSources(join(folder(), 'gone'))).size).toBe(0)
  })

  it('tells a file larger than the cap changed, and keeps none of its text', async () => {
    const dir = folder()
    const file = join(dir, 'big.py')
    writeFileSync(file, 'a'.repeat(MAX_FILE_BYTES + 10))
    const before = await snapshotSources(dir)
    writeFileSync(file, 'b'.repeat(MAX_FILE_BYTES + 20))
    const same = changesBetween(before, before)
    expect(same.files).toEqual([])
    const after = await snapshotSources(dir)
    expect(JSON.stringify(after)).not.toContain('aaaa')
    const changed = changesBetween(before, after)
    expect(changed.files).toEqual([{ file: 'big.py', before: null, after: null, tooLarge: true }])
  })
})

describe('the changes between two snapshots', () => {
  it('lists the files that differ, added and removed ones too, with both texts', () => {
    const before = new Map([
      ['a.py', { text: 'one\n' }],
      ['b.py', { text: 'same\n' }],
      ['c.py', { text: 'gone\n' }]
    ])
    const after = new Map([
      ['a.py', { text: 'two\n' }],
      ['b.py', { text: 'same\n' }],
      ['d.py', { text: 'new\n' }]
    ])
    expect(changesBetween(before, after).files).toEqual([
      { file: 'a.py', before: 'one\n', after: 'two\n' },
      { file: 'c.py', before: 'gone\n', after: null },
      { file: 'd.py', before: null, after: 'new\n' }
    ])
  })
})

describe('the changes a session keeps', () => {
  it('keeps the last turns only', () => {
    const kept = new KeptChanges()
    for (let n = 0; n < MAX_TURNS + 5; n += 1) kept.keep(`t${n}`, { files: [{ file: 'a.py', before: 'x', after: 'y' }] })
    expect(kept.get('t0')).toBeUndefined()
    expect(kept.get('t4')).toBeUndefined()
    expect(kept.get('t5')).toBeDefined()
    expect(kept.get(`t${MAX_TURNS + 4}`)).toBeDefined()
  })

  it('lets go of the oldest turns when the text grows past its cap, but never the newest', () => {
    const kept = new KeptChanges()
    const text = 'x'.repeat(190_000)
    for (let n = 0; n < 20; n += 1) kept.keep(`t${n}`, { files: [{ file: 'a.py', before: text, after: text + 'y' }] })
    expect(kept.get('t19')).toBeDefined()
    expect(kept.get('t0')).toBeUndefined()
  })
})

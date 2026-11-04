import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { BUILDS_FILE, BuildLog, MOST_LINES, readBuilds, recordOf, sourcesHash } from './buildlog'

let root: string
let box: ObjectInfo
const scene = {} as Scene

function put(path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-builds-'))
  put('box/model.py', 'a = 1\n')
  put('common/util.py', 'c = 1\n')
  put('lid/model.py', 'b = 1\n')
  box = { id: 'box', name: 'box', dir: join(root, 'box'), model: 'model.py' } as ObjectInfo
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sourcesHash', () => {
  it('is the same for the same sources and another for a change of the project or of common/', async () => {
    const first = await sourcesHash(box.dir)
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    expect(await sourcesHash(box.dir)).toBe(first)
    put('box/model.py', 'a = 2\n')
    const second = await sourcesHash(box.dir)
    expect(second).not.toBe(first)
    put('common/util.py', 'c = 2\n')
    expect(await sourcesHash(box.dir)).not.toBe(second)
  })

  it('does not change for another project, or for a file that is not Python', async () => {
    const first = await sourcesHash(box.dir)
    put('lid/model.py', 'b = 2\n')
    put('box/notes.txt', 'hello')
    expect(await sourcesHash(box.dir)).toBe(first)
  })

  it('holds the files the build imported from elsewhere in the workspace, and none from outside it', async () => {
    const first = await sourcesHash(box.dir)
    const uses = ['lid/model.py', '../elsewhere.py']
    const withLid = await sourcesHash(box.dir, uses)
    expect(withLid).not.toBe(first)
    put('lid/model.py', 'b = 2\n')
    expect(await sourcesHash(box.dir, uses)).not.toBe(withLid)
    // A path that leaves the workspace counts for nothing.
    expect(await sourcesHash(box.dir, ['../elsewhere.py'])).toBe(first)
  })
})

describe('BuildLog', () => {
  it('writes a line for a build, ignores the file, and answers for the revision', async () => {
    const log = new BuildLog()
    const record = await log.record(box, 1, scene, new Date('2026-11-04T10:00:00Z'))
    await log.settled()
    expect(record).toMatchObject({ revision: 1, at: '2026-11-04T10:00:00.000Z', run: log.run })
    expect(record.sources).toBe(await sourcesHash(box.dir))
    expect(record.head).toBeUndefined()
    expect(await readBuilds(box.dir)).toEqual([record])
    expect(log.identity('box', 1)).toEqual({ sources: record.sources })
    expect(log.identity('box', 2)).toBeUndefined()
    expect(readFileSync(join(box.dir, '.torno', '.gitignore'), 'utf8').split('\n')).toContain(BUILDS_FILE)
  })

  it('keeps the last 500 lines', async () => {
    const log = new BuildLog()
    // Seed a full file directly, then let a few builds land over the cap.
    const seeded = Array.from({ length: MOST_LINES }, (_, i) => JSON.stringify({ revision: i + 1, at: 'x', run: 'old', sources: 's' }))
    mkdirSync(join(box.dir, '.torno'), { recursive: true })
    writeFileSync(join(box.dir, '.torno', BUILDS_FILE), `${seeded.join('\n')}\n`)
    for (let i = MOST_LINES + 1; i <= MOST_LINES + 3; i++) await log.record(box, i, scene)
    await log.settled()
    const on = await readBuilds(box.dir)
    expect(on).toHaveLength(MOST_LINES)
    expect(on[0].revision).toBe(4)
    expect(on.at(-1)?.revision).toBe(MOST_LINES + 3)
  })

  it('writes every build in the order they landed, though they are asked together', async () => {
    const log = new BuildLog()
    await Promise.all([1, 2, 3, 4].map((n) => log.record(box, n, scene)))
    await log.settled()
    expect((await readBuilds(box.dir)).map((r) => r.revision)).toEqual([1, 2, 3, 4])
  })

  it('says the commit, and whether files differ from it', async () => {
    const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    const log = new BuildLog()
    const clean = await log.record(box, 1, scene)
    expect(clean.head).toMatch(/^[0-9a-f]{7}$/)
    expect(clean.dirty).toBeUndefined()
    put('box/model.py', 'a = 2\n')
    const changed = await log.record(box, 2, scene)
    expect(changed).toMatchObject({ head: clean.head, dirty: true })
    expect(log.identity('box', 2)).toEqual({ sources: changed.sources, head: clean.head, dirty: true })
    await log.settled()
  })

  it('writes nothing where .torno is a link', async () => {
    mkdirSync(join(root, 'elsewhere'))
    rmSync(join(box.dir, '.torno'), { recursive: true, force: true })
    execFileSync('ln', ['-s', join(root, 'elsewhere'), join(box.dir, '.torno')])
    const log = new BuildLog()
    await log.record(box, 1, scene)
    await log.settled()
    expect(existsSync(join(root, 'elsewhere', BUILDS_FILE))).toBe(false)
    expect(log.identity('box', 1)).toBeDefined()
  })
})

describe('recordOf', () => {
  it('reads a line and passes over what is not one', () => {
    expect(recordOf('{"revision":3,"at":"x","run":"r","sources":"s","head":"abc1234","dirty":true}')).toEqual({ revision: 3, at: 'x', run: 'r', sources: 's', head: 'abc1234', dirty: true })
    expect(recordOf('{"revision":"3"}')).toBeNull()
    expect(recordOf('not json')).toBeNull()
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitState, parseStatus } from './git'

let root: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } })
}

function put(path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-git-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function repo(): void {
  git('init', '-q', '-b', 'main')
  put('box/model.py', 'a = 1\n')
  put('lid/model.py', 'b = 1\n')
  put('common/util.py', 'c = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
}

describe('gitState', () => {
  it('is clean after a commit, and says the commit and the branch', async () => {
    repo()
    const state = await gitState(join(root, 'box'))
    expect(state).toEqual({ head: git('rev-parse', '--short=7', 'HEAD').trim(), branch: 'main', files: [], changed: 0 })
  })

  it('lists the files that changed in the project and in common/, not those of other projects', async () => {
    repo()
    put('box/model.py', 'a = 2\n')
    put('box/notes.py', 'new\n')
    put('common/util.py', 'c = 2\n')
    put('lid/model.py', 'b = 2\n')
    const state = await gitState(join(root, 'box'))
    expect(state?.changed).toBe(3)
    expect([...(state?.files ?? [])].sort()).toEqual(['box/model.py', 'box/notes.py', 'common/util.py'])
  })

  it('does not count what is under .torno/', async () => {
    repo()
    put('box/.torno/marks.json', '[]')
    put('box/.torno/scene.json', '{}')
    expect((await gitState(join(root, 'box')))?.changed).toBe(0)
  })

  it('names a repository with no commit yet', async () => {
    git('init', '-q', '-b', 'main')
    put('box/model.py', 'a = 1\n')
    expect(await gitState(join(root, 'box'))).toEqual({ head: null, branch: 'main', files: ['box/model.py'], changed: 1 })
  })

  it('works in a repository that is the project itself', async () => {
    mkdirSync(join(root, 'box'))
    const own = join(root, 'box')
    execFileSync('git', ['init', '-q'], { cwd: own })
    writeFileSync(join(own, 'model.py'), 'a = 1\n')
    const state = await gitState(own)
    expect(state?.changed).toBe(1)
    expect(state?.files).toEqual(['box/model.py'])
  })

  it('is null where there is no repository', async () => {
    put('box/model.py', 'a = 1\n')
    expect(await gitState(join(root, 'box'))).toBeNull()
  })

  it('is null where git is missing', async () => {
    repo()
    expect(await gitState(join(root, 'box'), { git: '/nonexistent/git' })).toBeNull()
  })

  it('is null for a folder that is not there', async () => {
    expect(await gitState(join(root, 'nothing'))).toBeNull()
  })

  it('gives up after its time', async () => {
    repo()
    expect(await gitState(join(root, 'box'), { timeoutMs: 1, git: 'sleep' })).toBeNull()
  })

  it('never writes the index: its time and its bytes stay as they were', async () => {
    repo()
    // Touch a file so that the index entry is stale: a status that refreshes it would rewrite the index.
    const later = new Date(Date.now() + 5000)
    execFileSync('touch', ['-d', later.toISOString(), join(root, 'box/model.py')])
    const index = join(root, '.git', 'index')
    const before = statSync(index)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const state = await gitState(join(root, 'box'))
    expect(state?.changed).toBe(0)
    const after = statSync(index)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)
  })
})

describe('parseStatus', () => {
  it('reads the commit, the branch, the changes, renames and spaces in names', () => {
    const text = ['# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head feature', '1 .M N... 100644 100644 100644 aaa bbb box/a b.py', '2 R. N... 100644 100644 100644 aaa bbb R100 box/new.py', 'box/old.py', '? box/extra.py', 'u UU N... 1 2 3 4 aaa bbb ccc box/conflict.py', ''].join('\0')
    expect(parseStatus(text)).toEqual({ head: '0123456', branch: 'feature', paths: ['box/a b.py', 'box/new.py', 'box/extra.py', 'box/conflict.py'] })
  })

  it('takes (initial) and (detached) for none', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0')).toEqual({ head: null, branch: null, paths: [] })
  })
})

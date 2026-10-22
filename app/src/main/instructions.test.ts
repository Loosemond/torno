import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstructionFile } from '../shared/instructions'
import { InstructionList, MOST_RULE_ENTRIES, MOST_RULE_DEPTH, findInstructions, withDeadline } from './instructions'

let root: string
let home: string
let ws: string
let object: string
let managed: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-instr-'))
  home = join(root, 'home')
  ws = join(home, 'objects')
  object = join(ws, 'box')
  managed = join(root, 'etc', 'CLAUDE.md')
  mkdirSync(object, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const put = (path: string, text = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** What was found, the way up stopping at the test's own root: a CLAUDE.md of the machine above the temporary folder is never seen. */
async function found(opts: { dir?: string } = {}): Promise<InstructionFile[]> {
  const all = await findInstructions(opts.dir ?? object, { home, managed, top: root })
  return all.filter((f) => f.path.startsWith(root))
}
const names = (files: InstructionFile[]): string[] => files.map((f) => `${f.kind} ${f.path.slice(root.length + 1)}`)

describe('the instruction files Claude Code reads for an object', () => {
  it('are none in a tree that has none', async () => {
    expect(await found()).toEqual([])
  })

  it('are every kind, in the order Claude Code loads them: managed, the person\'s, then from the top down, each folder\'s CLAUDE.md, .claude/CLAUDE.md, rules, CLAUDE.local.md', async () => {
    put(managed, 'm'.repeat(10))
    put(join(home, '.claude', 'CLAUDE.md'), 'u'.repeat(20))
    put(join(home, '.claude', 'rules', 'style.md'), 'r'.repeat(30))
    put(join(ws, 'CLAUDE.md'), 'w'.repeat(7000))
    put(join(object, 'CLAUDE.local.md'), 'l'.repeat(5))
    put(join(object, '.claude', 'rules', 'a.md'), 'a'.repeat(100))
    put(join(object, '.claude', 'CLAUDE.md'), 'p'.repeat(40))
    put(join(object, 'CLAUDE.md'), 'o'.repeat(50))
    const files = await found()
    expect(names(files)).toEqual([
      'managed etc/CLAUDE.md',
      'user home/.claude/CLAUDE.md',
      'user home/.claude/rules',
      'project home/objects/CLAUDE.md',
      'project home/objects/box/CLAUDE.md',
      'project home/objects/box/.claude/CLAUDE.md',
      'project home/objects/box/.claude/rules',
      'local home/objects/box/CLAUDE.local.md'
    ])
    expect(files.map((f) => f.bytes)).toEqual([10, 20, 30, 7000, 50, 40, 100, 5])
    expect(files[2]).toMatchObject({ files: 1 })
    expect(files[0].shown).toBe(managed)
    expect(files[3].shown).toBe('~/objects/CLAUDE.md')
    expect(files[1].shown).toBe('~/.claude/CLAUDE.md')
  })

  it('lists the person\'s own file once, though the walk up passes through their home folder', async () => {
    put(join(home, '.claude', 'CLAUDE.md'))
    put(join(home, 'CLAUDE.md'))
    expect(names(await found())).toEqual(['user home/.claude/CLAUDE.md', 'project home/CLAUDE.md'])
  })

  it('has the person\'s file also for an object outside their home folder', async () => {
    put(join(home, '.claude', 'CLAUDE.md'))
    const elsewhere = join(root, 'elsewhere', 'obj')
    mkdirSync(elsewhere, { recursive: true })
    expect(names(await found({ dir: elsewhere }))).toEqual(['user home/.claude/CLAUDE.md'])
  })

  it('is no file that is a folder or sits in a folder below the object', async () => {
    mkdirSync(join(object, 'CLAUDE.md'))
    put(join(object, 'sub', 'CLAUDE.md'))
    put(join(object, 'node_modules', '.claude', 'CLAUDE.md'))
    expect(await found()).toEqual([])
  })
})

describe('AGENTS.md', () => {
  it('is read when no CLAUDE.md is in the folder or above it, in the folder and above, and .claude/AGENTS.md too', async () => {
    put(join(ws, 'AGENTS.md'), 'aa')
    put(join(object, '.claude', 'AGENTS.md'), 'bbb')
    const files = await found()
    expect(names(files)).toEqual(['agents home/objects/AGENTS.md', 'agents home/objects/box/.claude/AGENTS.md'])
    expect(files.map((f) => f.bytes)).toEqual([2, 3])
  })

  it('is not read when a CLAUDE.md is above the object, though AGENTS.md is in its folder', async () => {
    put(join(object, 'AGENTS.md'))
    put(join(ws, 'CLAUDE.md'))
    expect(names(await found())).toEqual(['project home/objects/CLAUDE.md'])
  })

  it('is not read for a .claude/CLAUDE.md or a CLAUDE.local.md', async () => {
    put(join(object, 'AGENTS.md'))
    put(join(ws, '.claude', 'CLAUDE.md'))
    expect(names(await found())).toEqual(['project home/objects/.claude/CLAUDE.md'])
    rmSync(join(ws, '.claude'), { recursive: true })
    put(join(home, 'CLAUDE.local.md'))
    expect(names(await found())).toEqual(['local home/CLAUDE.local.md'])
  })

  it('is read beside the person\'s CLAUDE.md, the managed file and rules, which do not count', async () => {
    put(managed)
    put(join(home, '.claude', 'CLAUDE.md'))
    put(join(object, '.claude', 'rules', 'r.md'))
    put(join(object, 'AGENTS.md'))
    expect(names(await found())).toEqual(['managed etc/CLAUDE.md', 'user home/.claude/CLAUDE.md', 'project home/objects/box/.claude/rules', 'agents home/objects/box/AGENTS.md'])
  })

  it('is read in its own name only: AGENTS.local.md and AGENTS.override.md are not', async () => {
    put(join(object, 'AGENTS.local.md'))
    put(join(object, 'AGENTS.override.md'))
    expect(await found()).toEqual([])
  })
})

describe('the folder the way up stops at', () => {
  it('is the filesystem root unless a test gives another: nothing above it is looked at', async () => {
    put(join(root, 'CLAUDE.md'), 'above')
    put(join(ws, 'AGENTS.md'))
    // With the root of the tree as the top, the CLAUDE.md there is the last folder looked at.
    expect(names(await found())).toEqual(['project CLAUDE.md'])
    // With the object's own folder as the top, it is not seen, and an AGENTS.md of the folder above is not either.
    const files = await findInstructions(object, { home, managed, top: object })
    expect(files.filter((f) => f.path.startsWith(root))).toEqual([])
  })
})

describe('a link', () => {
  it('is reported by its own path, with no size, and not followed', async () => {
    put(join(root, 'elsewhere', 'real.md'), 'z'.repeat(999))
    symlinkSync(join(root, 'elsewhere', 'real.md'), join(ws, 'CLAUDE.md'))
    symlinkSync(join(root, 'nothing-there.md'), join(object, 'CLAUDE.local.md'))
    const files = await found()
    expect(names(files)).toEqual(['project home/objects/CLAUDE.md', 'local home/objects/box/CLAUDE.local.md'])
    expect(files.every((f) => f.link === true && f.bytes === undefined)).toBe(true)
  })

  it('counts as a CLAUDE.md for AGENTS.md: it may well be loaded', async () => {
    put(join(object, 'AGENTS.md'))
    symlinkSync(join(root, 'nothing-there.md'), join(ws, 'CLAUDE.md'))
    expect(names(await found())).toEqual(['project home/objects/CLAUDE.md'])
  })

  it('is a .claude that is a link: reported as it is, and nothing is looked into', async () => {
    put(join(root, 'shared', 'CLAUDE.md'))
    put(join(root, 'shared', 'rules', 'a.md'))
    symlinkSync(join(root, 'shared'), join(object, '.claude'))
    put(join(object, 'AGENTS.md'))
    const files = await found()
    expect(names(files)).toEqual(['project home/objects/box/.claude'])
    expect(files[0]).toMatchObject({ link: true })
    expect(files[0].bytes).toBeUndefined()
  })
})

describe('a rules folder', () => {
  it('is one entry: the .md files under it at any depth and their size, nothing else', async () => {
    const rules = join(object, '.claude', 'rules')
    put(join(rules, 'a.md'), 'a'.repeat(10))
    put(join(rules, 'frontend', 'b.md'), 'b'.repeat(20))
    put(join(rules, 'frontend', 'deep', 'c.md'), 'c'.repeat(30))
    put(join(rules, 'notes.txt'), 'n'.repeat(1000))
    const files = await found()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ kind: 'project', files: 3, bytes: 60, path: rules })
    expect(files[0].partial).toBeUndefined()
  })

  it('is no entry when it holds no .md file', async () => {
    put(join(object, '.claude', 'rules', 'notes.txt'))
    mkdirSync(join(ws, '.claude', 'rules'), { recursive: true })
    expect(await found()).toEqual([])
  })

  it('does not follow a link inside: it counts it and goes no further', async () => {
    const rules = join(object, '.claude', 'rules')
    put(join(rules, 'a.md'), 'a'.repeat(10))
    put(join(root, 'shared', 'big.md'), 'x'.repeat(5000))
    symlinkSync(join(root, 'shared'), join(rules, 'shared'))
    symlinkSync(join(root, 'shared', 'big.md'), join(rules, 'big.md'))
    const files = await found()
    expect(files[0]).toMatchObject({ files: 1, bytes: 10, links: 2 })
  })

  it('is a link itself: reported as one', async () => {
    put(join(root, 'shared', 'a.md'))
    mkdirSync(join(object, '.claude'), { recursive: true })
    symlinkSync(join(root, 'shared'), join(object, '.claude', 'rules'))
    const files = await found()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ link: true, path: join(object, '.claude', 'rules') })
  })

  it('stops at its cap of entries, and says the counts are at least these', async () => {
    const rules = join(object, '.claude', 'rules')
    mkdirSync(rules, { recursive: true })
    for (let i = 0; i < MOST_RULE_ENTRIES + 20; i += 1) writeFileSync(join(rules, `r${String(i).padStart(4, '0')}.md`), 'x')
    const files = await found()
    expect(files[0]).toMatchObject({ files: MOST_RULE_ENTRIES, partial: true })
  })

  it('stops at its cap of depth', async () => {
    const rules = join(object, '.claude', 'rules')
    let at = rules
    for (let i = 0; i <= MOST_RULE_DEPTH + 1; i += 1) {
      put(join(at, 'r.md'))
      at = join(at, 'd')
    }
    const files = await found()
    expect(files[0]).toMatchObject({ files: MOST_RULE_DEPTH + 1, partial: true })
  })

  it.skipIf(process.getuid?.() === 0)('does not stop at a folder it cannot read', async () => {
    const rules = join(object, '.claude', 'rules')
    put(join(rules, 'a.md'), 'aa')
    put(join(rules, 'closed', 'b.md'), 'bbb')
    chmodSync(join(rules, 'closed'), 0o000)
    try {
      const files = await found()
      expect(files[0]).toMatchObject({ files: 1, bytes: 2 })
    } finally {
      chmodSync(join(rules, 'closed'), 0o755)
    }
  })
})

describe('the time it may take', () => {
  it('is bounded: a lookup that does not come back is answered with what is given instead', async () => {
    expect(await withDeadline(new Promise<number>(() => {}), 20, -1)).toBe(-1)
    expect(await withDeadline(Promise.resolve(7), 20, -1)).toBe(7)
  })
})

describe('the list main keeps for the window', () => {
  it('is what was last found for the object, and the window asks for a row by its place in it', async () => {
    put(join(ws, 'CLAUDE.md'))
    put(join(object, 'CLAUDE.md'))
    const list = new InstructionList({ home, managed, top: root })
    const files = (await list.find('box', object)).filter((f) => f.path.startsWith(root))
    expect(files).toHaveLength(2)
    const all = list.of('box')
    expect(list.at('box', all.indexOf(files[1]))?.path).toBe(join(object, 'CLAUDE.md'))
    expect(list.at('box', -1)).toBeNull()
    expect(list.at('box', all.length)).toBeNull()
    expect(list.at('box', 0.5)).toBeNull()
    expect(list.at('other', 0)).toBeNull()
    // The workspace was left: the list means nothing any more.
    list.forget()
    expect(list.at('box', 0)).toBeNull()
  })
})

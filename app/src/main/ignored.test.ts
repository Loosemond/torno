import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ensureIgnored } from './ignored'

const made = (): string => mkdtempSync(join(tmpdir(), 'torno-ignored-'))
const file = (dir: string): string => readFileSync(join(dir, '.torno', '.gitignore'), 'utf8')

it('makes the file with the lines asked for, and nothing beside it', async () => {
  const dir = made()
  try {
    await ensureIgnored(dir, ['thumb.png', 'thumb.json'])
    expect(file(dir)).toBe('thumb.png\nthumb.json\n')
    expect(readdirSync(join(dir, '.torno'))).toEqual(['.gitignore'])
    expect(readdirSync(dir)).toEqual(['.torno'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('adds only the lines that are missing, at the end, and never removes or rewrites what is there', async () => {
  const dir = made()
  try {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', '.gitignore'), '# mine\n!thumb.png\n  thumb.json  \nviews/')
    await ensureIgnored(dir, ['thumb.png', 'thumb.json', 'exports/'])
    // A line the person wrote to keep a file in git (`!thumb.png`) is their word on it: nothing is added against it.
    expect(file(dir)).toBe('# mine\n!thumb.png\n  thumb.json  \nviews/\nexports/\n')
    // Asked again, it is left as it is: not written at all.
    const before = file(dir)
    await ensureIgnored(dir, ['exports/', 'thumb.png'])
    expect(file(dir)).toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('loses no line when it is asked twice at once', async () => {
  const dir = made()
  try {
    await Promise.all([ensureIgnored(dir, ['thumb.png', 'thumb.json']), ensureIgnored(dir, ['exports/']), ensureIgnored(dir, ['thumb.png'])])
    expect(file(dir).split('\n').filter(Boolean).sort()).toEqual(['exports/', 'thumb.json', 'thumb.png'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

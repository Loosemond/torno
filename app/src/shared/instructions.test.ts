import { describe, expect, it } from 'vitest'
import { bytes } from './format'
import { INSTRUCTIONS_LIMIT, type InstructionFile, instructionsLine, named, weighed } from './instructions'

const file = (more: Partial<InstructionFile> & { shown: string }): InstructionFile => ({ path: more.shown.replace('~', '/home/me'), kind: 'project', ...more })

describe('what a file weighs', () => {
  it('is bytes, then kilobytes and megabytes to a tenth under ten, whole above', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(812)).toBe('812 B')
    expect(bytes(1024)).toBe('1 KB')
    expect(bytes(7300)).toBe('7.1 KB')
    expect(bytes(12 * 1024 + 300)).toBe('12 KB')
    expect(bytes(3.2 * 1024 * 1024)).toBe('3.2 MB')
  })
})

describe('how a file or folder of instructions is told', () => {
  it('is its size', () => {
    expect(weighed(file({ shown: '~/objects/CLAUDE.md', bytes: 7300 }))).toBe('7.1 KB')
  })

  it('is no size for a link, which is not followed', () => {
    expect(weighed(file({ shown: '~/CLAUDE.md', link: true }))).toBe('a link, not followed')
  })

  it('is, for a rules folder, the files counted as the most that load (a rule with paths loads only for matching files), their size and the links left alone; its name ends in a slash', () => {
    const rules = file({ shown: '~/objects/.claude/rules', files: 3, bytes: 2150, links: 1 })
    expect(weighed(rules)).toBe('up to 3 files, 2.1 KB, 1 link not followed')
    expect(named(rules)).toBe('~/objects/.claude/rules/')
    expect(weighed(file({ shown: '~/.claude/rules', files: 1, bytes: 10 }))).toBe('up to 1 file, 10 B')
    expect(weighed(file({ shown: '~/.claude/rules', files: 500, bytes: 5000, partial: true }))).toBe('at least 500 files, 4.9 KB')
  })
})

describe('what the first prompt says of them', () => {
  it('is nothing when there are none', () => {
    expect(instructionsLine([])).toBeNull()
  })

  it('names each file and its size, and says torno\'s tools are current for seeing the build', () => {
    const line = instructionsLine([file({ shown: '~/objects/CLAUDE.md', bytes: 7300 }), file({ shown: '~/.claude/CLAUDE.md', kind: 'user', bytes: 900 })])!
    expect(line).toContain('~/objects/CLAUDE.md (7.1 KB), ~/.claude/CLAUDE.md (900 B)')
    expect(line).toContain("What torno's tools say of the build is current")
    expect(line).toContain('take its advice on how to model, not on how to see the build')
  })

  it('says they are the ones loaded by default', () => {
    expect(instructionsLine([file({ shown: '~/CLAUDE.md', bytes: 1 })])).toContain('Claude Code loads these instruction files here by default: ~/CLAUDE.md (1 B)')
  })

  it('is bounded whatever the paths: six very long ones, a rules folder and the count of the rest', () => {
    const deep = `/${'a-very-long-folder-name/'.repeat(30)}`
    const many = Array.from({ length: 12 }, (_, i) => file({ shown: `${deep}${i}/CLAUDE.md`, bytes: 123456, files: i === 0 ? 500 : undefined, links: i === 0 ? 12 : undefined, partial: i === 0 ? true : undefined }))
    const line = instructionsLine(many)!
    expect(line.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT)
    // A path keeps its end, which names it.
    expect(line).toContain('…')
    expect(line).toContain('5/CLAUDE.md (')
    expect(line).toContain(' and 6 more.')
  })

  it('counts the files past the sixth', () => {
    const many = Array.from({ length: 9 }, (_, i) => file({ shown: `/a/${i}/CLAUDE.md`, bytes: 1 }))
    const line = instructionsLine(many)!
    expect(line).toContain('/a/5/CLAUDE.md (1 B) and 3 more.')
    expect(line).not.toContain('/a/6/')
  })
})

import { describe, expect, it } from 'vitest'
import type { HistoryEntry, HistoryList } from '../../shared/history'
import { copyPathOf, goBackPrompt, marksOf, nameOf } from './historyBits'

const entry = (id: string, more: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, at: '2026-11-04T10:00:00.000Z', run: 'old', revision: 3, sources: 'aaaaaaaaaaaa', model: 'box.py', files: ['box/box.py', 'common/util.py'], parts: 2, seconds: 1, line: 'tub changed, lid same', ...more })
const list = (entries: HistoryEntry[]): HistoryList => ({ run: 'now', base: '/ws/box/.torno/history', entries })

describe('nameOf', () => {
  it('gives the revision of a build made in this run, beside its id, and the id alone of an earlier one', () => {
    expect(nameOf(list([]), entry('h41', { run: 'now', revision: 3 }))).toBe('h41 · r3')
    expect(nameOf(list([]), entry('h41'))).toBe('h41')
  })
})

describe('marksOf', () => {
  it('says what a build had then, and nothing of one that was clean', () => {
    expect(marksOf(entry('h1'))).toEqual([])
    expect(marksOf(entry('h1', { failing: ['walls'], defects: ['tub: not valid', 'lid: not closed'], dimensions: { pass: 1, fail: 2, none: 0 } }))).toEqual(['1 check failed', '2 parts with defects', '2 dimensions failed'])
    expect(marksOf(entry('h1', { dimensions: { pass: 3, fail: 0, none: 1 } }))).toEqual([])
  })
})

describe('goBackPrompt', () => {
  it('names the copies by their paths, asks the agent to edit the project and not the copies, and says where the build came from', () => {
    const l = list([])
    const text = goBackPrompt(l, entry('h41', { head: 'a1b2c3d' }), 'box', Date.parse('2026-11-04T10:30:00.000Z'))
    expect(text).toContain('Go back to build h41, made 30 minutes ago: tub changed, lid same.')
    expect(text).toContain(`${copyPathOf(l, entry('h41'), 'box/box.py')}, /ws/box/.torno/history/h41/source/common/util.py`)
    expect(text).toContain('Its files are those of commit a1b2c3d.')
    expect(text).toContain('Change the files of box to match them')
    expect(text).toContain('Do not edit the copies.')
  })

  it('gives the revision of a build of this run, and does not claim a commit for files that differed from it', () => {
    const text = goBackPrompt(list([]), entry('h2', { run: 'now', revision: 5, head: 'a1b2c3d', dirty: true }), 'box', Date.parse('2026-11-04T10:00:10.000Z'))
    expect(text).toContain('build h2 (r5), made just now')
    expect(text).not.toContain('commit')
  })
})

import { describe, expect, it } from 'vitest'
import { CHANGE_LINES, diffText, editHunks, limitHunks } from './diff'

const kinds = (text: { rows: Array<{ kind: string; text: string }> }): string[] => text.rows.map((r) => `${r.kind === 'same' ? ' ' : r.kind === 'removed' ? '-' : r.kind === 'added' ? '+' : r.kind === 'gap' ? '~' : '?'}${r.text}`)

describe('the line diff of two texts', () => {
  it('shows a line changed as the line removed and the line added', () => {
    expect(kinds(diffText('WALL = 2', 'WALL = 3'))).toEqual(['-WALL = 2', '+WALL = 3'])
  })

  it('keeps one line of what did not change on each side of a change, and counts the rest as a gap', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const now = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'H'].join('\n')
    expect(kinds(diffText(old, now))).toEqual(['~2 unchanged lines', ' c', '-d', '+D', ' e', ' f', ' g', '-h', '+H'])
  })

  it('puts the lines removed before the lines added of the same change, and finds what was only added or only taken out', () => {
    expect(kinds(diffText('a\nb\nc', 'a\nx\ny\nc'))).toEqual([' a', '-b', '+x', '+y', ' c'])
    expect(kinds(diffText('keep\nold1\nold2', 'keep'))).toEqual([' keep', '-old1', '-old2'])
    expect(kinds(diffText('', 'new1\nnew2'))).toEqual(['+new1', '+new2'])
    expect(kinds(diffText('gone', ''))).toEqual(['-gone'])
  })

  it('does not count the newline that ends both texts as a line', () => {
    expect(kinds(diffText('a\nb\n', 'a\nc\n'))).toEqual([' a', '-b', '+c'])
    // ...but one that is only in one of them is a change.
    expect(diffText('a', 'a\n').rows.some((r) => r.kind === 'added')).toBe(true)
  })

  it('says a text is the same when nothing differs', () => {
    expect(diffText('a\nb', 'a\nb')).toEqual({ rows: [], same: true })
  })

  it('compares up to 400 lines each, and says so beyond: the new text is shown plain', () => {
    const lines = (n: number, tag = ''): string => Array.from({ length: n }, (_, i) => `l${i}${tag}`).join('\n')
    expect(diffText(lines(400), lines(400, 'x')).tooLong).toBeUndefined()
    const long = diffText(lines(401), lines(10, 'x'))
    expect(long.tooLong).toBe(true)
    expect(long.rows).toHaveLength(10)
    expect(long.rows.every((r) => r.kind === 'plain')).toBe(true)
  })
})

describe('the hunks of an edit of a file', () => {
  it('has one for an Edit, none for what it cannot read', () => {
    expect(editHunks('Edit', { file_path: 'a.py', old_string: 'x', new_string: 'y' })).toEqual([{ rows: [{ kind: 'removed', text: 'x' }, { kind: 'added', text: 'y' }] }])
    expect(editHunks('Edit', { file_path: 'a.py', new_string: 'y' })).toBeUndefined()
    expect(editHunks('Edit', null)).toBeUndefined()
    expect(editHunks('Write', { file_path: 'a.py', content: 'y' })).toBeUndefined()
    expect(editHunks('Bash', { command: 'ls' })).toBeUndefined()
  })

  it('has one for each edit of a MultiEdit, titled by its place, and leaves out what is not an edit', () => {
    const hunks = editHunks('MultiEdit', { file_path: 'a.py', edits: [{ old_string: 'a', new_string: 'b' }, 'junk', { old_string: 'c', new_string: 'd' }] })
    expect(hunks?.map((h) => h.title)).toEqual(['Edit 1 of 2', 'Edit 2 of 2'])
    expect(kinds(hunks![1])).toEqual(['-c', '+d'])
    expect(editHunks('MultiEdit', { file_path: 'a.py', edits: [] })).toBeUndefined()
    expect(editHunks('MultiEdit', { file_path: 'a.py' })).toBeUndefined()
  })

  it('has no hunk for an edit that changes nothing, but keeps the others', () => {
    expect(editHunks('MultiEdit', { edits: [{ old_string: 'a', new_string: 'a' }, { old_string: 'b', new_string: 'c' }] })).toHaveLength(2)
    expect(editHunks('Edit', { old_string: 'a', new_string: 'a' })?.[0].rows).toEqual([])
  })
})

describe('the lines of a diff shown', () => {
  const hunks = editHunks('MultiEdit', {
    edits: [
      { old_string: '1\n2\n3\n4', new_string: 'a\nb\nc\nd' },
      { old_string: 'x', new_string: 'y' }
    ]
  })!

  it('counts the lines removed and added, and cuts after the first few', () => {
    expect(CHANGE_LINES).toBe(6)
    const cut = limitHunks(hunks, 5)
    expect(cut.more).toBe(5)
    expect(cut.hunks).toHaveLength(2)
    expect(kinds(cut.hunks[0])).toEqual(['-1', '-2', '-3', '-4', '+a'])
    expect(cut.hunks[1].rows).toEqual([])
  })

  it('shows all of them when asked, and when they fit', () => {
    expect(limitHunks(hunks, 5, true)).toEqual({ hunks, more: 0 })
    expect(limitHunks(hunks, 10)).toEqual({ hunks, more: 0 })
  })
})

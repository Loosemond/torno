import { describe, expect, it } from 'vitest'
import { MAX_REVERSE_CHARS, reverseBlock, undoPrompt } from './undo'

describe('reverseBlock', () => {
  it('lists the lines the file has now as removed and the lines it had as added, with a line beside', () => {
    expect(reverseBlock('a\nwall = 3\nb\n', 'a\nwall = 4\nb\n')).toBe('from line 1:\n  a\n- wall = 4\n+ wall = 3\n  b')
  })
  it('says nothing for two texts that are the same', () => {
    expect(reverseBlock('x\n', 'x\n')).toBeNull()
  })
  it('names the line it begins at', () => {
    expect(reverseBlock('1\n2\n3\n4\n', '1\n2\nthree\n4\n')).toBe('from line 2:\n  2\n- three\n+ 3\n  4')
  })
})

describe('undoPrompt', () => {
  it('asks for the files to be put back, with the lines to reverse', () => {
    const text = undoPrompt({ files: [{ file: 'hollow.py', before: 'wall = 3\n', after: 'wall = 4\n' }] }, new Map([['hollow.py', 'wall = 4\n']]))
    expect(text).toContain('Undo your last turn')
    expect(text).toContain('hollow.py, from line 1:\n- wall = 4\n+ wall = 3')
    expect(text).not.toContain('changed again')
  })
  it('says a file was changed again after the turn', () => {
    const text = undoPrompt({ files: [{ file: 'hollow.py', before: 'wall = 3\n', after: 'wall = 4\n' }] }, new Map([['hollow.py', 'wall = 5\n']]))
    expect(text).toContain('hollow.py, from line 1')
    expect(text).toContain('changed again since that turn')
  })
  it('tells a file the turn made, one it removed, and one too large to have been kept', () => {
    const text = undoPrompt(
      {
        files: [
          { file: 'new.py', before: null, after: 'x = 1\n' },
          { file: 'gone.py', before: 'y = 2\n', after: null },
          { file: 'big.py', before: null, after: null, tooLarge: true }
        ]
      },
      new Map()
    )
    expect(text).toContain('new.py: the turn made this file')
    expect(text).toContain('gone.py, was removed; write it back as it was:\ny = 2')
    expect(text).toContain('big.py: the turn changed it, and it is too large')
  })
  it('names a file whose lines would not fit instead of listing them', () => {
    const long = Array.from({ length: 4000 }, (_, n) => `line number ${n}`).join('\n')
    expect(long.length).toBeGreaterThan(MAX_REVERSE_CHARS)
    const text = undoPrompt({ files: [{ file: 'long.py', before: long, after: 'short\n' }] }, new Map())
    expect(text).toContain('long.py: the turn changed it, and the lines are too many to list here')
    expect(text.length).toBeLessThan(MAX_REVERSE_CHARS)
  })
})

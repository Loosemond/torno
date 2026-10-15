import { describe, expect, it } from 'vitest'
import { pulledFromTorno, refsIn, shownPath, toolLabel } from './chat'

const refs = (text: string): string[] => refsIn(text).flatMap((piece) => (piece.ref ? [piece.ref] : []))

describe('refsIn', () => {
  it('finds marks, builds, and faces and edges of a part, and leaves the text between them whole', () => {
    expect(refs('M4 and lid/F12, r3; tub_2/E10.')).toEqual(['M4', 'lid/F12', 'r3', 'tub_2/E10'])
    expect(refsIn('see M4 now').map((p) => p.text)).toEqual(['see ', 'M4', ' now'])
    expect(refsIn('M4 and lid/F12, r3; tub_2/E10.').map((p) => p.text).join('')).toBe('M4 and lid/F12, r3; tub_2/E10.')
  })

  it('never takes a letter, a bare face number or a decimal for one', () => {
    expect(refs('M alone, F12 alone, 3.5 mm, M4x, version 12, r')).toEqual([])
    expect(refs('a part named lid is not one')).toEqual([])
  })

  it('has no pieces for no text and one for text with no ref', () => {
    expect(refsIn('')).toEqual([])
    expect(refsIn('nothing here')).toEqual([{ text: 'nothing here' }])
  })

  it('finds the same refs however many times it is asked', () => {
    expect(refs('M1 M2')).toEqual(['M1', 'M2'])
    expect(refs('M1 M2')).toEqual(['M1', 'M2'])
  })
})

describe('toolLabel', () => {
  it('names the file of Read, Edit and Write', () => {
    expect(toolLabel('Read', { file_path: 'app.py' })).toBe('Read app.py')
    expect(toolLabel('Edit', { file_path: '/work/obj/lid.py' })).toBe('Edit /work/obj/lid.py')
    expect(toolLabel('Write', { file_path: 'probe.txt', content: 'x' })).toBe('Write probe.txt')
  })

  it('gives the first line of a Bash command, cut when it is long', () => {
    expect(toolLabel('Bash', { command: 'uv run pytest' })).toBe('Bash: uv run pytest')
    expect(toolLabel('Bash', { command: 'a\nb' })).toBe('Bash: a')
    expect(toolLabel('Bash', { command: 'x'.repeat(200) })).toHaveLength('Bash: '.length + 80)
  })

  it('gives the pattern of Grep and Glob and the description of Task', () => {
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('Grep: TODO')
    expect(toolLabel('Glob', { pattern: '**/*.py' })).toBe('Glob: **/*.py')
    expect(toolLabel('Task', { description: 'find the lid', prompt: 'long' })).toBe('Task: find the lid')
  })

  it('shows a tool of torno as torno\'s, with the view it was asked for', () => {
    expect(toolLabel('mcp__torno__look', { view: 'iso' })).toBe('torno · look (iso)')
    expect(toolLabel('mcp__torno__scene', {})).toBe('torno · scene')
    expect(toolLabel('mcp__torno__describe', { ref: 'lid/F12' })).toBe('torno · describe (lid/F12)')
  })

  it('is the name for anything else, and for input that is not an object', () => {
    expect(toolLabel('CronList', {})).toBe('CronList')
    expect(toolLabel('Read', null)).toBe('Read')
    expect(toolLabel('Bash', 'ls')).toBe('Bash')
    expect(toolLabel('mcp__other__thing', {})).toBe('mcp__other__thing')
  })
})

describe('pulledFromTorno', () => {
  it('says nothing for nothing', () => {
    expect(pulledFromTorno({})).toBeNull()
  })

  it('lists tools in the order they were pulled, counted past one, and the pictures', () => {
    expect(pulledFromTorno({ look: 1, pictures: 1 })).toBe('Pulled from torno: look, 1 picture')
    expect(pulledFromTorno({ scene: 1, pictures: 2, measure: 3 })).toBe('Pulled from torno: scene, 2 pictures, measure ×3')
  })
})

describe('a path in the chat', () => {
  const where = { dir: '/work/micra-intake', home: '/home/luis' }
  it('is relative to the object folder inside it, with ~ for the home folder elsewhere, as given otherwise', () => {
    expect(shownPath('/work/micra-intake/probe-note.txt', where)).toBe('probe-note.txt')
    expect(shownPath('/work/micra-intake/parts/lid.py', where)).toBe('parts/lid.py')
    expect(shownPath('/work/micra-intake', where)).toBe('.')
    expect(shownPath('/work/micra-intake-2/a.py', where)).toBe('/work/micra-intake-2/a.py')
    expect(shownPath('/home/luis/notes/a.md', where)).toBe('~/notes/a.md')
    expect(shownPath('/home/luis', where)).toBe('~')
    expect(shownPath('/home/luisa/a.md', where)).toBe('/home/luisa/a.md')
    expect(shownPath('/tmp/x', where)).toBe('/tmp/x')
    expect(shownPath('lid.py', where)).toBe('lid.py')
    expect(shownPath('/tmp/x')).toBe('/tmp/x')
  })
  it('is shortened in the label of a file tool and of Grep and Glob, not when nothing is known', () => {
    expect(toolLabel('Write', { file_path: '/work/micra-intake/probe-note.txt' }, where)).toBe('Write probe-note.txt')
    expect(toolLabel('NotebookEdit', { notebook_path: '/home/luis/n.ipynb' }, where)).toBe('NotebookEdit ~/n.ipynb')
    expect(toolLabel('Grep', { pattern: 'TODO', path: '/work/micra-intake/parts' }, where)).toBe('Grep: TODO in parts')
    expect(toolLabel('Glob', { pattern: '*.py', path: '/work/micra-intake' }, where)).toBe('Glob: *.py in .')
    expect(toolLabel('Write', { file_path: '/work/micra-intake/a.txt' })).toBe('Write /work/micra-intake/a.txt')
  })
})

import { describe, expect, it } from 'vitest'
import { pulledFromTorno, refsIn, toolLabel } from './chat'

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

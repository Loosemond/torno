import { expect, it } from 'vitest'
import { answerFor, describeInput, questionsOf } from './ask'

it('shows a command as the command, and a file as its path and a few lines of what goes in it', () => {
  expect(describeInput('Bash', { command: 'ls -la\ncat x' })).toEqual({ lead: undefined, body: 'ls -la\ncat x', more: 0 })
  const content = Array.from({ length: 10 }, (_, n) => `line ${n + 1}`).join('\n')
  expect(describeInput('Write', { file_path: 'a/b.py', content })).toEqual({ lead: 'a/b.py', body: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6', more: 4 })
  // Every line, when asked for.
  expect(describeInput('Write', { file_path: 'a/b.py', content }, true)).toEqual({ lead: 'a/b.py', body: content, more: 0 })
  expect(describeInput('Edit', { file_path: 'a.py', old_string: 'x', new_string: 'y\nz' })).toEqual({ lead: 'a.py', body: 'y\nz', more: 0 })
  expect(describeInput('Write', { file_path: 'empty.txt', content: '' })).toEqual({ lead: 'empty.txt', body: '', more: 0 })
})

it('shows any other input as compact JSON, cut when long, and survives what is not an object', () => {
  expect(describeInput('mcp__torno__look', { view: 'iso' })).toEqual({ lead: undefined, body: '{"view":"iso"}', more: 0 })
  expect(describeInput('Task', { description: 'x'.repeat(2000) }).body.length).toBeLessThan(700)
  expect(describeInput('Bash', null)).toEqual({ lead: undefined, body: '', more: 0 })
  expect(describeInput('Bash', 'ls')).toEqual({ lead: undefined, body: '"ls"', more: 0 })
  expect(describeInput('Write', { file_path: 3 }).lead).toBeUndefined()
})

it('reads the questions of AskUserQuestion, leaving out what is not one', () => {
  const input = {
    questions: [
      { question: 'Which wall?', header: 'Wall', multiSelect: false, options: [{ label: '2 mm', description: 'thin' }, { label: '3 mm' }, { nope: 1 }] },
      { question: 'Finish?', multiSelect: true, options: [{ label: 'Matte', description: '' }] },
      { header: 'no question text', options: [] },
      'junk'
    ]
  }
  expect(questionsOf(input)).toEqual([
    { question: 'Which wall?', header: 'Wall', multi: false, options: [{ label: '2 mm', description: 'thin' }, { label: '3 mm', description: '' }] },
    { question: 'Finish?', header: '', multi: true, options: [{ label: 'Matte', description: '' }] }
  ])
  expect(questionsOf(undefined)).toEqual([])
  expect(questionsOf({ questions: 'x' })).toEqual([])
})

it('answers a question with what was typed in its Other line, else the labels chosen, in the order of the options', () => {
  const q = { question: 'Finish?', header: '', multi: true, options: [{ label: 'Matte', description: '' }, { label: 'Gloss', description: '' }, { label: 'Brushed', description: '' }] }
  expect(answerFor(q, [], '')).toBeUndefined()
  expect(answerFor(q, ['Gloss', 'Matte'], '')).toBe('Matte, Gloss')
  expect(answerFor(q, ['Matte'], '  none of these ')).toBe('none of these')
  expect(answerFor(q, [], '   ')).toBeUndefined()
  expect(answerFor({ ...q, multi: false }, ['Gloss'], '')).toBe('Gloss')
})

it('shows a file path on a card relative to the object folder, with the full path kept', () => {
  const shown = describeInput('Write', { file_path: '/w/obj/parts/lid.py', content: 'x' }, false, { dir: '/w/obj' })
  expect(shown.lead).toBe('parts/lid.py')
  expect(shown.full).toBe('/w/obj/parts/lid.py')
})

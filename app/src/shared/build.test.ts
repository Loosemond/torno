import { describe, expect, it } from 'vitest'
import { ERROR_LINE, errorLine } from './build'

describe('the line of a failed build the chat shows', () => {
  it('is the last line of the traceback, which names the kind of error', () => {
    expect(errorLine({ message: "name 'WAL' is not defined", traceback: 'Traceback (most recent call last):\n  File "part.py", line 3, in assembly\nNameError: name \'WAL\' is not defined\n\n' })).toBe("NameError: name 'WAL' is not defined")
  })

  it('is the last line of the message where there is no traceback, and is nothing where there is neither', () => {
    expect(errorLine({ message: 'the model has no scene\nsay assembly(p)' })).toBe('say assembly(p)')
    expect(errorLine({ message: 'timed out after 600 s', traceback: '' })).toBe('timed out after 600 s')
    expect(errorLine({ message: '' })).toBe('')
  })

  it('is cut to what a line holds', () => {
    const line = errorLine({ message: 'x'.repeat(ERROR_LINE * 2) })
    expect(line).toHaveLength(ERROR_LINE)
    expect(line.endsWith('…')).toBe(true)
  })
})

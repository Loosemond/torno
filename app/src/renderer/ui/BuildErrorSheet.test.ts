import { describe, expect, it } from 'vitest'
import { probe } from '../../test/diagnosisFixtures'
import { errorText } from './BuildErrorSheet'

describe('errorText', () => {
  it('is the message, the traceback and the output, a blank line apart', () => {
    const text = errorText({ kind: 'exception', message: 'boom', traceback: 'Traceback\n  File "a.py"\n', output: 'printed\n' })
    expect(text).toBe('boom\n\nTraceback\n  File "a.py"\n\nprinted')
  })

  it('leaves out what the kernel did not send', () => {
    expect(errorText({ kind: 'no_model', message: 'no model file in /ws/empty' })).toBe('no model file in /ws/empty')
    expect(errorText({ kind: 'crash', message: 'kernel stopped', traceback: '', output: '  \n' })).toBe('kernel stopped')
  })

  it('holds why a fillet failed after the message', () => {
    const text = errorText({ kind: 'exception', message: 'ValueError: fillet', traceback: 'Traceback', diagnosis: probe() })
    expect(text.startsWith('ValueError: fillet\n\nWhy: fillet R6 of 8 edges: each works alone;')).toBe(true)
    expect(text.endsWith('(6, 6, -2.5) to (6, 6, 2.5)\n\nTraceback')).toBe(true)
  })
})

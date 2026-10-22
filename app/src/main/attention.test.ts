import { describe, expect, it } from 'vitest'
import { Attention } from './attention'

describe('Attention: when a session that needs the person draws the eye of the window', () => {
  it('asks once for a session that moves to needs_input while the window is not focused', () => {
    const attention = new Attention()
    expect(attention.moved('s1', 'working', false)).toBe(false)
    expect(attention.moved('s1', 'needs_input', false)).toBe(true)
    // The same ask told again is no new ask.
    expect(attention.moved('s1', 'needs_input', false)).toBe(false)
  })

  it('asks nothing of a window that is focused: the person sees the card', () => {
    const attention = new Attention()
    attention.moved('s1', 'working', true)
    expect(attention.moved('s1', 'needs_input', true)).toBe(false)
    // Looking away while it waits is no new ask either.
    expect(attention.moved('s1', 'needs_input', false)).toBe(false)
  })

  it('asks again for the next ask, once the first was answered', () => {
    const attention = new Attention()
    expect(attention.moved('s1', 'needs_input', false)).toBe(true)
    expect(attention.moved('s1', 'working', false)).toBe(false)
    expect(attention.moved('s1', 'needs_input', false)).toBe(true)
  })

  it('keeps the sessions apart, and asks for nothing but needs_input', () => {
    const attention = new Attention()
    expect(attention.moved('s1', 'needs_input', false)).toBe(true)
    expect(attention.moved('s2', 'needs_input', false)).toBe(true)
    for (const status of ['starting', 'idle', 'working', 'exited'] as const) expect(attention.moved('s3', status, false)).toBe(false)
  })
})

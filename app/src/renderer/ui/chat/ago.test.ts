import { describe, expect, it } from 'vitest'
import { ago } from './ago'

const now = Date.parse('2026-11-04T12:00:00Z')
const before = (ms: number): string => new Date(now - ms).toISOString()

describe('ago', () => {
  it('says it as a person does', () => {
    expect(ago(before(20_000), now)).toBe('just now')
    expect(ago(before(60_000), now)).toBe('1 minute ago')
    expect(ago(before(5 * 60_000), now)).toBe('5 minutes ago')
    expect(ago(before(3 * 3_600_000), now)).toBe('3 hours ago')
    expect(ago(before(30 * 3_600_000), now)).toBe('yesterday')
    expect(ago(before(2 * 86_400_000), now)).toBe('2 days ago')
  })
  it('gives a date for a conversation that is old, and nothing for no time', () => {
    expect(ago(before(30 * 86_400_000), now, 'en-GB')).toBe('on 5 Oct')
    expect(ago(before(400 * 86_400_000), now, 'en-GB')).toMatch(/^on \d+ \w+ 2025$/)
    expect(ago(null, now)).toBe('')
    expect(ago('not a date', now)).toBe('')
  })
})

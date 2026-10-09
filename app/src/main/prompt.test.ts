import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from './prompt'

describe('the system prompt', () => {
  it('says what each thing means that a prompt may say of a mark, and what its other lines are', () => {
    // As `contextFor` and `describeMark` write them.
    for (const said of ['(changed)', 'reopened by the user', '[not checked against rN]', '"Selected:"', '"Marks still open"']) expect(SYSTEM_PROMPT).toContain(said)
  })

  it('says of a mark told as changed that it may have been moved: one put somewhere else is told so too', () => {
    expect(SYSTEM_PROMPT).toContain('(changed) is of a mark you were given before that the user has since changed or moved')
  })

  it('stays short', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThan(4500)
  })
})

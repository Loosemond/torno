import { describe, expect, it } from 'vitest'
import type { Mark } from './marks'
import { AGENT_LABEL, busyWith, nextCarries, nextPromptLine } from './agents'

describe('what is said of a session', () => {
  it('is asked about before it is ended only while it works or waits for an answer', () => {
    expect([busyWith('working'), busyWith('needs_input'), busyWith('idle'), busyWith('starting'), busyWith('exited')]).toEqual(['is working', 'is waiting for your answer', undefined, undefined, undefined])
  })

  it('names the agent as the person reads it', () => {
    expect(AGENT_LABEL).toBe('Claude Code')
  })
})

// Final review, "easy to use" 3: the pane says what the next prompt carries.
describe('nextPromptLine', () => {
  it('says what goes with the next prompt of a session that is there: the drafts, and the pinned dimensions that fail or have no value', () => {
    expect(nextPromptLine({ drafts: 2, failing: 1, unmeasured: 0 }, true)).toBe('2 marks and 1 failing dimension go with your next prompt')
    expect(nextPromptLine({ drafts: 1, failing: 0, unmeasured: 0 }, true)).toBe('1 mark goes with your next prompt')
    expect(nextPromptLine({ drafts: 0, failing: 2, unmeasured: 0 }, true)).toBe('2 failing dimensions go with your next prompt')
    expect(nextPromptLine({ drafts: 0, failing: 0, unmeasured: 1 }, true)).toBe('1 dimension with no value goes with your next prompt')
    expect(nextPromptLine({ drafts: 3, failing: 1, unmeasured: 2 }, true)).toBe('3 marks, 1 failing dimension and 2 dimensions with no value go with your next prompt')
  })

  it('says nothing when there is nothing to carry, and with no session what to do about the drafts', () => {
    expect(nextPromptLine({ drafts: 0, failing: 0, unmeasured: 0 }, true)).toBeNull()
    expect(nextPromptLine({ drafts: 0, failing: 0, unmeasured: 0 }, false)).toBeNull()
    expect(nextPromptLine({ drafts: 2, failing: 1, unmeasured: 0 }, false)).toBe('2 marks are not sent yet: start a session, and they go with your first prompt')
    expect(nextPromptLine({ drafts: 1, failing: 0, unmeasured: 0 }, false)).toBe('1 mark is not sent yet: start a session, and it goes with your first prompt')
    // Pinned dimensions alone are no reason to start one: they were sent, and are told again whenever there is a prompt.
    expect(nextPromptLine({ drafts: 0, failing: 1, unmeasured: 0 }, false)).toBeNull()
  })

  it('counts what a prompt would carry of the marks, as the prompt itself does', () => {
    const base = { author: 'user', note: '', anchorState: 'ok', layout: 'assembly', revision: 3, createdAt: 't' }
    const dim = (id: string, status: string, over: object = {}) => ({ ...base, id, kind: 'dimension', measure: 'diameter', status, a: { point: [0, 0, 0] }, value: 8, measuredRevision: 3, expected: 8.5, verdict: 'fail', ...over }) as unknown as Mark
    const marks = [{ ...base, id: 'M1', kind: 'pin', status: 'draft', anchor: { point: [0, 0, 0] } } as unknown as Mark, dim('M2', 'sent'), dim('M3', 'sent', { measuredRevision: 2 }), dim('M4', 'sent', { verdict: 'pass', value: 8.5 }), dim('M5', 'draft'), dim('M6', 'resolved')]
    expect(nextCarries(marks, 3)).toEqual({ drafts: 2, failing: 1, unmeasured: 1 })
  })
})

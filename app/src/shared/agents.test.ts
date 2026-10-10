import { describe, expect, it } from 'vitest'
import type { Mark } from './marks'
import { AGENT_LABEL, busyWith, nextCarries, nextPromptLine, sendLabel, sessionSaid, toSend, toldLine } from './agents'

describe('what is said of a session', () => {
  it('is its status when the agent posts hooks, and only that it runs when it posts none', () => {
    expect((['starting', 'idle', 'working', 'needs_input', 'exited'] as const).map((status) => sessionSaid(status, true))).toEqual(['starting', 'idle', 'working', 'needs_input', 'exited'])
    // Never a guess: an agent that says nothing of its work is not idle.
    expect((['starting', 'idle', 'exited'] as const).map((status) => sessionSaid(status, false))).toEqual(['starting', 'running', 'exited'])
  })

  it('takes an agent that says nothing of its work for one that may be working, whenever ending it is asked about', () => {
    expect([busyWith('working', true), busyWith('needs_input', true), busyWith('idle', true), busyWith('starting', true), busyWith('exited', true)]).toEqual(['is working', 'is waiting for your answer', undefined, undefined, undefined])
    expect([busyWith('idle', false), busyWith('starting', false), busyWith('exited', false)]).toEqual(['may be working: torno cannot tell', undefined, undefined])
  })

  it('names the agents as the person reads them', () => {
    expect(AGENT_LABEL).toEqual({ claude: 'Claude Code', copilot: 'Copilot CLI' })
  })
})

describe('what "Send marks" has to send', () => {
  const mark = (over: Partial<Mark>): Mark => ({ id: 'M1', kind: 'pin', status: 'draft', author: 'user', note: '', layout: 'assembly', ...over }) as Mark
  const dimension = (over: Record<string, unknown>): Mark => mark({ kind: 'dimension', measure: 'distance', status: 'sent', ...over } as Partial<Mark>)

  it('counts the drafts, and the dimensions the agent was given that the last build does not meet', () => {
    const marks = [
      mark({ id: 'M1' }),
      mark({ id: 'M2', status: 'sent' }),
      mark({ id: 'M3', status: 'resolved' }),
      dimension({ id: 'M4', value: 6, expected: 8, verdict: 'fail', measuredRevision: 3 }),
      dimension({ id: 'M5', value: 8, expected: 8, verdict: 'pass', measuredRevision: 3 }),
      // Not measured on the last build: nothing can be said of it there.
      dimension({ id: 'M6', value: 8, expected: 8, verdict: 'pass', measuredRevision: 2 }),
      // A draft is counted once, as a draft.
      dimension({ id: 'M7', status: 'draft', value: 6, expected: 8, verdict: 'fail', measuredRevision: 3 })
    ]
    expect(toSend(marks, 3)).toEqual({ drafts: 2, unmet: 2 })
    expect(toSend([], 3)).toEqual({ drafts: 0, unmet: 0 })
  })

  it('offers the button only when there is something of the two, and says which', () => {
    expect(sendLabel({ drafts: 0, unmet: 0 })).toBeNull()
    expect(sendLabel({ drafts: 2, unmet: 1 })).toEqual({ text: 'Send marks', count: 2 })
    expect(sendLabel({ drafts: 0, unmet: 1 })).toEqual({ text: 'Send dimensions', count: 1 })
  })

  it('says in a line what torno knows of the line it put at the cursor, and no more', () => {
    expect(toldLine(undefined, 1)).toBe('This agent is not told with each prompt: use "Send marks".')
    expect(toldLine({ state: 'waiting' }, 1)).toBe('A line is at the cursor: press Enter to send it as it is. Marks stay drafts until you do.')
    expect(toldLine({ state: 'dropped', why: 'typed' }, 1)).toBe('Something was typed after the line, so the marks are still drafts: use "Send marks" again.')
    expect(toldLine({ state: 'dropped', why: 'absent' }, 1)).toBe('The line was not at the prompt when Enter was pressed, so the marks are still drafts: use "Send marks" again.')
    // That Enter was pressed is known; that the agent has the marks is not, and is not said.
    expect(toldLine({ state: 'sent' }, 0)).toBe('Enter was pressed with the line at the prompt. Whether the agent read the file, torno cannot see.')
    // With drafts made since, what to do comes first again.
    expect(toldLine({ state: 'sent' }, 2)).toBe('This agent is not told with each prompt: use "Send marks".')
  })
})

// Final review, "easy to use" 3: for an agent that is told with every prompt, the pane says what the next one carries.
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

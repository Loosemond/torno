import { describe, expect, it } from 'vitest'
import { dockToggleLabel, rowLabel, signOf, waitingObjects } from './sessionSign'

const objects = [
  { id: 'bracket', name: 'bracket' },
  { id: 'hollow', name: 'hollow' },
  { id: 'plain', name: 'plain' }
]

describe('signOf', () => {
  it('has one for a session at work and one that waits for the person, and none for the rest', () => {
    expect(signOf('needs_input')).toBe('needs_input')
    expect(signOf('working')).toBe('working')
    for (const status of ['starting', 'idle', 'exited'] as const) expect(signOf(status)).toBeNull()
    expect(signOf(undefined)).toBeNull()
  })
})

describe('waitingObjects', () => {
  it('lists the objects whose session needs the person, in the order of the list and not of the sessions', () => {
    const sessions = {
      plain: { sessionId: 'c', view: 'chat' as const, status: 'needs_input' as const },
      bracket: { sessionId: 'a', view: 'chat' as const, status: 'working' as const },
      hollow: { sessionId: 'b', view: 'terminal' as const, status: 'needs_input' as const }
    }
    expect(waitingObjects(objects, sessions).map((o) => o.id)).toEqual(['hollow', 'plain'])
  })

  it('names none for a session of no object of the list, nor for sessions that are idle or ended', () => {
    const sessions = {
      ghost: { sessionId: 'g', view: 'chat' as const, status: 'needs_input' as const },
      bracket: { sessionId: 'a', view: 'chat' as const, status: 'idle' as const },
      hollow: { sessionId: 'b', view: 'chat' as const, status: 'exited' as const }
    }
    expect(waitingObjects(objects, sessions)).toEqual([])
  })
})

describe('what is said, for a screen reader and for a title', () => {
  it('names the object and the state of a row, and says nothing more of one with no sign', () => {
    expect(rowLabel('bracket', 'needs_input')).toBe('bracket, session needs you')
    expect(rowLabel('bracket', 'working')).toBe('bracket, session is working')
    expect(rowLabel('bracket', null)).toBeUndefined()
  })

  it('tells the toggle of a dock that is shown or hidden, and of a hidden one whose session has a sign', () => {
    expect(dockToggleLabel(true, 'needs_input')).toBe('Hide session')
    expect(dockToggleLabel(false, null)).toBe('Show session')
    expect(dockToggleLabel(false, 'needs_input')).toBe('Show session: Claude Code needs you')
    expect(dockToggleLabel(false, 'working')).toBe('Show session: Claude Code is working')
  })
})

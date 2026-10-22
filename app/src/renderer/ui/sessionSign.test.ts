import { describe, expect, it } from 'vitest'
import { dockToggleName, dockToggleSaid, rowSaid, signOf, switcherSign, waitingObjects } from './sessionSign'

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
  it('describes a row by its session, and says nothing of one with no sign; the name is never changed', () => {
    expect(rowSaid('needs_input')).toBe('session needs you')
    expect(rowSaid('working')).toBe('session is working')
    expect(rowSaid(null)).toBeUndefined()
  })

  it('names the toggle of the dock the same with or without a sign, and describes a hidden one whose session has a sign', () => {
    expect(dockToggleName(true)).toBe('Hide session')
    expect(dockToggleName(false)).toBe('Show session')
    expect(dockToggleSaid(true, 'needs_input')).toBeUndefined()
    expect(dockToggleSaid(false, null)).toBeUndefined()
    expect(dockToggleSaid(false, 'needs_input')).toBe('Claude Code needs you')
    expect(dockToggleSaid(false, 'working')).toBe('Claude Code is working')
  })
})

describe('switcherSign', () => {
  const at = (statuses: Record<string, 'needs_input' | 'working' | 'idle' | 'exited'>) =>
    Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { sessionId: id, view: 'chat' as const, status }]))

  it('carries the sign of any object of the list: one that needs the person before one at work', () => {
    expect(switcherSign('hollow', objects, at({ hollow: 'working' }))).toEqual({ sign: 'working', said: 'session is working', word: undefined })
    expect(switcherSign('hollow', objects, at({ hollow: 'working', plain: 'needs_input' }))).toEqual({ sign: 'needs_input', said: 'session is working; plain needs you', word: 'plain needs you' })
    expect(switcherSign('hollow', objects, at({ plain: 'working', bracket: 'needs_input' }))).toEqual({ sign: 'needs_input', said: 'bracket needs you; plain is working', word: 'bracket needs you' })
  })

  it('says "needs you" beside the dot of the open object\'s session that waits, and names another\'s', () => {
    expect(switcherSign('hollow', objects, at({ hollow: 'needs_input', plain: 'needs_input' }))).toEqual({ sign: 'needs_input', said: 'session needs you; plain needs you', word: 'needs you' })
    expect(switcherSign('plain', objects, at({ bracket: 'needs_input', hollow: 'needs_input' })).word).toBe('bracket needs you')
  })

  it('has none while no session works or waits, and none for an object not in the list', () => {
    expect(switcherSign('hollow', objects, at({ hollow: 'idle', bracket: 'exited', ghost: 'needs_input' }))).toEqual({ sign: null, said: undefined, word: undefined })
    expect(switcherSign(null, objects, {})).toEqual({ sign: null, said: undefined, word: undefined })
  })
})

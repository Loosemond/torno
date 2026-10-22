import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuildError, BuildState } from '../../shared/build'
import { probe } from '../../test/diagnosisFixtures'
import { chatStore } from '../state/chat'
import { store } from '../state/store'
import { BuildErrorSheet, askLabel, errorText, toldLine } from './BuildErrorSheet'

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

describe('what the sheet says of who is told, and offers', () => {
  const NAME_ERROR: BuildError = { kind: 'exception', message: "name 'WAL' is not defined", traceback: 'Traceback\nNameError: name \'WAL\' is not defined\n' }
  const failed = (error: BuildError, revision = 2, more: Partial<BuildState> = {}): BuildState => ({ objectId: 'bracket', status: 'failed', revision, stale: true, error, ...more })
  const session = { sessionId: 's1', status: 'idle' as const, view: 'chat' as const }
  const edit = { kind: 'context' as const, id: 's1-i3', forUser: 's1-i2', forTool: true as const, text: '', marks: [], revision: 2, buildState: 'failed' as const, error: "NameError: name 'WAL' is not defined" }
  const chatWith = (...items: unknown[]) => chatStore.setState({ sessions: { s1: { items, earlier: [], meta: {}, commands: [], models: [], seq: 1, loading: false, told: [] } } as never })
  // A static render reads the first state of each store (zustand's server snapshot): they are made the state there is now.
  function sheet(error = NAME_ERROR): string {
    const now = vi.spyOn(store, 'getInitialState').mockReturnValue(store.getState())
    const chat = vi.spyOn(chatStore, 'getInitialState').mockReturnValue(chatStore.getState())
    try {
      return renderToStaticMarkup(createElement(BuildErrorSheet, { objectName: 'bracket', error, onClose: () => {} }))
    } finally {
      now.mockRestore()
      chat.mockRestore()
    }
  }
  const text = (html: string): string => html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'")
  const button = (html: string, name: string): string => new RegExp(`<button[^>]*>${name}</button>`).exec(html)?.[0] ?? ''

  afterEach(() => {
    store.setState({ build: null, objectId: null, sessions: {}, errorOpen: false })
    chatStore.setState({ sessions: {} })
  })

  it('says in words that Claude Code is told, so that the error need not be pasted into the chat', () => {
    expect(toldLine('prompt')).toBe('Claude Code is told this with your next prompt.')
    expect(toldLine('edit')).toBe('Claude Code was told after its edit, and your next prompt carries it too.')
    expect(toldLine('none')).toBe('No session is running. Start one, and it is told with your first prompt.')
    expect([askLabel('prompt'), askLabel('edit'), askLabel('none')]).toEqual(['Ask Claude Code to fix it', 'Ask Claude Code to fix it', 'Start a session to fix it'])
  })

  it('tells of a failure with a session running as told with the next prompt, and offers to ask for the fix as the one primary button', () => {
    store.setState({ objectId: 'bracket', build: failed(NAME_ERROR), sessions: { bracket: session } })
    chatWith()
    const out = sheet()
    expect(text(out)).toContain('Claude Code is told this with your next prompt.')
    expect(button(out, 'Ask Claude Code to fix it')).toContain('button-primary')
    expect(button(out, 'Copy')).toContain('button-quiet')
    // After an error in the model building it again gives the same error: no Rebuild is offered here.
    expect(out).not.toContain('Rebuild')
  })

  it('tells of a failure the session met in its own edit as told after it', () => {
    store.setState({ objectId: 'bracket', build: failed(NAME_ERROR), sessions: { bracket: session } })
    chatWith(edit)
    expect(text(sheet())).toContain('Claude Code was told after its edit')
    // An edit whose build is not this failure is not it.
    chatWith({ ...edit, error: 'TypeError: y' })
    expect(text(sheet())).toContain('Claude Code is told this with your next prompt.')
  })

  it('offers to start a session when none runs, or the one there was has ended', () => {
    store.setState({ objectId: 'bracket', build: failed(NAME_ERROR), sessions: {} })
    expect(text(sheet())).toContain('No session is running.')
    expect(button(sheet(), 'Start a session to fix it')).toContain('button-primary')
    store.setState({ sessions: { bracket: { ...session, status: 'exited' } } })
    expect(button(sheet(), 'Start a session to fix it')).not.toBe('')
  })

  it('says the kind in words and the build as the chat does, and keeps the kernel word out of the text', () => {
    store.setState({ objectId: 'bracket', build: failed(NAME_ERROR, 2), sessions: {} })
    const out = sheet()
    expect(text(out)).toContain('Build after r2 failed · Python error in the model')
    expect(text(out)).not.toMatch(/\bexception\b/)
    store.setState({ build: failed(NAME_ERROR, 0) })
    expect(text(sheet())).toContain('First build failed · Python error in the model')
  })

  it('makes Rebuild the primary button after a failure outside the model, and the ask quiet', () => {
    for (const [kind, words] of [['crash', 'The build process stopped (crash)'], ['timeout', 'The build took too long (timeout)'], ['cancelled', 'The build was cancelled']] as const) {
      const error = { kind, message: 'it ended' }
      store.setState({ objectId: 'bracket', build: failed(error), sessions: { bracket: session } })
      const out = sheet(error)
      expect(text(out)).toContain(`Build after r2 failed · ${words}`)
      expect(button(out, 'Rebuild')).toContain('button-primary')
      expect(button(out, 'Ask Claude Code to fix it')).not.toContain('button-primary')
    }
  })
})

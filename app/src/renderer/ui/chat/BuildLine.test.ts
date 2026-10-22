import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/chat'
import type { BuildDigest } from '../../../shared/sanity'
import { store } from '../../state/store'
import { BuildLine, failedAs, MOST_PARTS, stillLatest, verdictWord } from './BuildLine'

type Context = Extract<ChatItem, { kind: 'context' }>
const context = (more: Partial<Context> = {}): Context => ({ kind: 'context', id: 'i3', forUser: 'i2', forTool: true, text: 'THE WHOLE TEXT THE AGENT WAS GIVEN', marks: [], ...more })
const digest = (more: Partial<BuildDigest> = {}): BuildDigest => ({ revision: 2, since: 1, changed: true, parts: [], unchanged: 0, flags: [], dimensions: [], ...more })
const part = (name: string, text: string) => ({ name, layout: 'assembly', text }) as BuildDigest['parts'][number]

// A static render reads the store's first state (zustand's server snapshot): it is made the state there is now.
function drawn(item: Context): string {
  const now = vi.spyOn(store, 'getInitialState').mockReturnValue(store.getState())
  try {
    return renderToStaticMarkup(createElement(BuildLine, { item }))
  } finally {
    now.mockRestore()
  }
}
const text = (html: string): string => html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'")

afterEach(() => store.setState({ build: null, errorOpen: false, marks: [] }))

describe('the build line under an edit', () => {
  it('says a build that worked as a build, with its revision and how long it took, and not as what torno added', () => {
    const out = drawn(context({ revision: 2, buildState: 'ok', seconds: 1.234 }))
    expect(text(out)).toContain('Built r2 · ok · 1.2 s')
    expect(text(out)).not.toContain('torno added')
    expect(out).toContain('Show text')
    // The text the agent was given is behind "Show text", not drawn.
    expect(out).not.toContain('THE WHOLE TEXT')
  })

  it('names the failure of a build that failed by the last line of its error, as the build the revision after the last good one', () => {
    const out = drawn(context({ revision: 2, buildState: 'failed', error: "NameError: name 'WAL' is not defined" }))
    expect(text(out)).toContain("r3 failed: NameError: name 'WAL' is not defined")
    expect(out).toContain('data-verdict="failed"')
    expect(failedAs({})).toBe('r1')
    expect(failedAs({ revision: 2 })).toBe('r3')
  })

  it('offers "Show error" only while that failure is the latest build', () => {
    const item = context({ revision: 2, buildState: 'failed', error: 'NameError: x' })
    expect(drawn(item)).not.toContain('Show error')
    store.setState({ build: { objectId: 'a', status: 'failed', revision: 2, stale: true, error: { kind: 'exception', message: 'x', traceback: 'File "a.py"\nNameError: x\n' } } })
    expect(drawn(item)).toContain('Show error')
    // Another failure since, or a build that worked after it: the sheet would show another build.
    store.setState({ build: { objectId: 'a', status: 'failed', revision: 2, stale: true, error: { kind: 'exception', message: 'y', traceback: 'TypeError: y' } } })
    expect(drawn(item)).not.toContain('Show error')
    store.setState({ build: { objectId: 'a', status: 'ok', revision: 3, stale: false } })
    expect(drawn(item)).not.toContain('Show error')
    expect(stillLatest(null, item)).toBe(false)
  })

  it('says a build still running as that, with no revision', () => {
    expect(text(drawn(context({ buildState: 'building' })))).toContain('Build running')
  })

  it('shows the dimensions whose verdict the build changed, each as a chip with the word', () => {
    const out = drawn(context({ revision: 2, buildState: 'ok', digest: digest({ dimensions: [{ id: 'M3', was: 'fail', now: 'pass' }, { id: 'M2', was: 'pass', now: 'fail' }, { id: 'M5', was: 'pass', now: 'none' }] }) }))
    expect(text(out)).toContain('M3 now passes')
    expect(text(out)).toContain('M2 now fails')
    expect(text(out)).toContain('M5 is no longer measured')
    expect(out).toContain('data-ref="M3"')
    expect([verdictWord('pass'), verdictWord('fail'), verdictWord('none')]).toEqual(['now passes', 'now fails', 'is no longer measured'])
  })

  it('shows the parts the build changed as the kernel said them, a few, then how many more', () => {
    const parts = ['tub', 'lid', 'cap', 'clip', 'pin', 'peg'].map((name) => part(name, `${name}: volume ≈ 100 → 90 mm³ (-10, -10 %)`))
    const out = text(drawn(context({ revision: 2, buildState: 'ok', digest: digest({ parts }) })))
    for (const name of parts.slice(0, MOST_PARTS)) expect(out).toContain(name.text)
    expect(out).not.toContain('pin:')
    expect(out).toContain(`${parts.length - MOST_PARTS} more changed`)
    expect(out).toContain('≈ 100')
  })

  it('has nothing to add for a build that changed nothing', () => {
    const out = drawn(context({ revision: 2, buildState: 'ok', digest: digest({ changed: false, unchanged: 2 }) }))
    expect(out).not.toContain('chat-build-parts')
    expect(out).not.toContain('chat-build-dimensions')
  })
})

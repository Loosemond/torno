import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Param, Scene } from '../../shared/scene'
import { COLUMN_DEFAULT } from '../state/column'
import { store } from '../state/store'
import { ParamsPanel } from './ParamsPanel'

const PARAMS: Param[] = [
  { name: 'wall', type: 'float', default: 2.4, literal: true, doc: 'Clearance 0.2 mm, M3' },
  { name: 'inner', type: 'float', default: 18.4, literal: false, doc: null },
  { name: 'ribs', type: 'int', default: 4, literal: true, doc: null },
  { name: 'label', type: 'str', default: 'M3', literal: true, doc: null }
]
const scene = (params: Param[] | undefined): Scene => ({ model: 'm.py', layouts: ['assembly'], parts: [], seconds: 0, output: '', params }) as unknown as Scene

describe('the Parameters section of the left column', () => {
  afterEach(() => store.setState({ scene: null, objectId: null, sessions: {}, column: COLUMN_DEFAULT }))
  // A static render reads the store's first state (zustand's server snapshot): it is made the state there is now.
  const html = (): string => {
    const now = vi.spyOn(store, 'getInitialState').mockReturnValue(store.getState())
    try {
      return renderToStaticMarkup(createElement(ParamsPanel))
    } finally {
      now.mockRestore()
    }
  }
  const open = { ...COLUMN_DEFAULT, folded: { ...COLUMN_DEFAULT.folded, params: false } }

  it('is no section for a model with no Params fields, or a kernel that does not read them', () => {
    store.setState({ scene: scene([]), column: open })
    expect(html()).toBe('')
    store.setState({ scene: scene(undefined), column: open })
    expect(html()).toBe('')
    store.setState({ scene: null, column: open })
    expect(html()).toBe('')
  })

  it('is folded to its title with the count at first', () => {
    store.setState({ scene: scene(PARAMS), column: COLUMN_DEFAULT })
    const out = html()
    expect(out).toContain('aria-label="Parameters"')
    expect(out).toContain('data-folded')
    expect(out).not.toContain('data-param=')
  })

  it('has a row for each field, in the model order, the value in the monospace face', () => {
    store.setState({ scene: scene(PARAMS), column: open })
    const out = html()
    expect([...out.matchAll(/data-param="([^"]+)"/g)].map((m) => m[1])).toEqual(['wall', 'inner', 'ribs', 'label'])
    expect(out).toContain('<span class="param-value num">2.4</span>')
    expect(out).toContain('<span class="param-value num">4</span>')
    expect(out).toContain('<span class="param-value num">&quot;M3&quot;</span>')
  })

  it('shows the comment as written, and says a default worked out in the model is', () => {
    store.setState({ scene: scene(PARAMS), column: open })
    const out = html()
    // The comment is as written; the numbers in it are in the monospace face.
    expect(out).toContain('<span class="param-doc">Clearance <span class="num">0.2</span> mm, <span class="num">M3</span></span>')
    expect(out.match(/<span class="param-worked">worked out in the model<\/span>/g)).toHaveLength(1)
    const inner = out.slice(out.indexOf('data-param="inner"'), out.indexOf('data-param="ribs"'))
    expect(inner).toContain('param-worked')
    expect(inner).toContain('18.4')
    expect(out.slice(out.indexOf('data-param="wall"'), out.indexOf('data-param="inner"'))).not.toContain('param-worked')
  })

  it('has rows that cannot be clicked, and say why, while no session runs', () => {
    store.setState({ scene: scene(PARAMS), column: open, objectId: 'o', sessions: {} })
    const out = html()
    expect(out).not.toContain('<button type="button" class="param-button"')
    expect(out).toContain('aria-description="Params.wall: float = 2.4. Clearance 0.2 mm, M3. Start a session to put Params.wall in its prompt"')
  })

  it('has a button for each row, named for the text it puts in the prompt, while a session runs', () => {
    store.setState({ scene: scene(PARAMS), column: open, objectId: 'o', sessions: { o: { sessionId: 's', status: 'idle', view: 'chat' } } })
    const out = html()
    expect(out.match(/<button type="button" class="param-button"/g)).toHaveLength(PARAMS.length)
    expect(out).toContain('aria-label="Params.wall"')
    expect(out).toContain('aria-description="Params.wall: float = 2.4. Clearance 0.2 mm, M3. Put it in the session&#x27;s prompt"')
  })
})

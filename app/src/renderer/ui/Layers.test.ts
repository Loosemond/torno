import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Scene } from '../../shared/scene'
import { store } from '../state/store'
import { Layers } from './Layers'

describe('a layer row of a part the build says is broken', () => {
  afterEach(() => store.setState({ scene: null, layout: 'assembly', layers: {}, marks: [] }))
  // A static render reads the store's first state (zustand's server snapshot): it is made the state there is now.
  const rows = (): string => {
    const now = vi.spyOn(store, 'getInitialState').mockReturnValue(store.getState())
    try {
      return renderToStaticMarkup(createElement(Layers))
    } finally {
      now.mockRestore()
    }
  }
  const part = (name: string, more: object = {}) => ({ key: `assembly:${name}`, name, layout: 'assembly', valid: true, ...more })

  it('says its first defect in a word beside its name, every one in its title, and nothing of a sound part', () => {
    const scene = { model: 'm.py', layouts: ['assembly'], parts: [part('tub', { valid: false, reversed: [1] }), part('lid')], seconds: 0, output: '' } as unknown as Scene
    store.setState({ scene, layout: 'assembly', layers: {}, folded: [] })
    const out = rows()
    expect(out).toContain(`<span class="layer-defect" data-part="defect" title="Not valid: OCC&#x27;s check of the shape finds a defect. Inside out: a solid of it has its faces pointing inward: its volume is a size only">not valid +<span class="num">1</span></span>`)
    expect(out.match(/layer-defect/g)).toHaveLength(1)
  })

  it('has a "Show all" and the count of what is hidden in its title only while a part is switched off', () => {
    const scene = { model: 'm.py', layouts: ['assembly'], parts: [part('tub'), part('lid')], seconds: 0, output: '' } as unknown as Scene
    store.setState({ scene, layout: 'assembly', layers: {}, folded: [] })
    expect(rows()).not.toContain('layers-hidden')
    store.setState({ layers: { lid: { visible: false } } })
    const out = rows()
    expect(out).toContain('<span class="num">1</span> hidden')
    expect(out).toContain('Show all</button>')
  })

  it('gives each part a name that selects it, a "Show only", and the count of its open marks, in the colour of a failing check when one is', () => {
    const scene = { model: 'm.py', layouts: ['assembly'], parts: [part('tub'), part('lid')], seconds: 0, output: '' } as unknown as Scene
    const pin = { id: 'M1', kind: 'pin', author: 'user', note: '', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, anchor: { point: [0, 0, 0], part: 'lid' } }
    store.setState({ scene, layout: 'assembly', layers: {}, folded: [], marks: [pin] as never })
    const out = rows()
    expect(out).toContain('aria-label="Show only lid"')
    expect(out).toContain('aria-label="1 open mark on lid"')
    expect(out).not.toContain('open mark on tub')
    expect(out).not.toContain('data-failing')
    store.setState({ marks: [] })
  })
})

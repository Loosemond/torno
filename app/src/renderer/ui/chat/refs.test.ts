import { beforeEach, describe, expect, it } from 'vitest'
import type { Mark } from '../../../shared/marks'
import type { Part, Scene } from '../../../shared/scene'
import { actions, store } from '../../state/store'
import { refInfo } from './refs'

const part = (layout: string, name: string): Part => ({ key: `${layout}:${name}`, name, layout, faceCount: 6, edgeCount: 12, bbox: { min: [0, 0, 0], max: [1, 1, 1] } }) as Part
const SCENE: Scene = { model: 'box.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'lid'), part('assembly', 'tub'), part('print', 'lid')], seconds: 1, output: '' }
const pin = (id: string, author: 'user' | 'agent', ref: string | undefined, layout = 'assembly'): Mark =>
  ({ id, kind: 'pin', author, note: 'thin here', status: 'draft', anchorState: 'ok', layout, revision: 3, createdAt: '', camera: {}, anchor: { point: [0, 0, 0], ...(ref ? { part: 'lid', ref } : {}) } }) as unknown as Mark

beforeEach(() => {
  actions.setWorkspace({ root: '/ws', hasProject: true, objects: [{ id: 'box', name: 'box', dir: '/ws/box', model: 'box.py' }] })
  actions.openObject('box', { layers: {} })
  actions.applyScene({ objectId: 'box', revision: 3, scene: SCENE })
})

describe('what a ref in the chat can do', () => {
  it('lights and focuses a mark of the object, in the colour of its author, and lights the place it is anchored at', () => {
    store.setState({ marks: [pin('M1', 'user', 'lid/F2'), pin('M2', 'agent', undefined)] })
    expect(refInfo(store.getState(), 'M1')).toMatchObject({ kind: 'mark', live: true, author: 'user', lights: ['lid/F2'], act: 'focus' })
    expect(refInfo(store.getState(), 'M1').title).toContain('thin here')
    // A mark in empty space has nothing to light, but can still be gone to.
    expect(refInfo(store.getState(), 'M2')).toMatchObject({ live: true, author: 'agent', lights: [], act: 'focus' })
  })

  it('says a mark the object does not have is not among its marks, and does nothing', () => {
    expect(refInfo(store.getState(), 'M9')).toMatchObject({ kind: 'mark', live: false, lights: [], title: 'M9 is not among the marks of this object' })
  })

  it('says a mark of a layout the build no longer has cannot be shown', () => {
    store.setState({ marks: [pin('M1', 'user', 'lid/F2', 'gone')] })
    expect(refInfo(store.getState(), 'M1')).toMatchObject({ live: false, title: 'M1 is on the layout gone, which this build does not have' })
  })

  it('lights and selects a face or an edge of a part that is drawn', () => {
    expect(refInfo(store.getState(), 'lid/F3')).toMatchObject({ kind: 'geometry', live: true, lights: ['lid/F3'], act: 'select' })
    expect(refInfo(store.getState(), 'tub/E11')).toMatchObject({ live: true })
  })

  it('says why a ref of a part that is not drawn, or not there, does nothing', () => {
    expect(refInfo(store.getState(), 'cap/F1')).toMatchObject({ live: false, lights: [], title: 'cap/F1 is not in the layout shown (assembly)' })
    expect(refInfo(store.getState(), 'lid/F6')).toMatchObject({ live: false, title: 'lid has no F6' })
    store.setState({ layers: { tub: { visible: false } } as never })
    expect(refInfo(store.getState(), 'tub/F1')).toMatchObject({ live: false, title: 'tub/F1 is on a part that is switched off' })
  })

  it('says a build is a build, and does nothing', () => {
    expect(refInfo(store.getState(), 'r3')).toMatchObject({ kind: 'build', live: false, title: 'Build r3, the one on show' })
    expect(refInfo(store.getState(), 'r2')).toMatchObject({ kind: 'build', live: false, title: 'Build r2' })
  })

  it('is no ref for anything else', () => {
    expect(refInfo(store.getState(), 'lid')).toMatchObject({ kind: 'none', live: false })
  })
})

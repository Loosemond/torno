import { beforeEach, describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { actions, store } from '../state/store'
import { hoverMark, unhoverMark } from './markHover'

const pin = (id: string): Mark => ({ id, kind: 'pin', author: 'user', note: '', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 1, camera: { position: [100, -100, 80], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }, createdAt: '2026-10-22T12:00:00.000Z', anchor: { point: [0, 0, 0] } })

describe('the mark pointed at, by the pointer or by the keys', () => {
  beforeEach(() => {
    store.setState({ objectId: 'bracket', marks: [pin('M1'), pin('M2')], hoveredMark: null })
    unhoverMark('M1', 'pointer')
    unhoverMark('M2', 'pointer')
    unhoverMark('M1', 'focus')
    unhoverMark('M2', 'focus')
    actions.hoverMark(null)
  })

  it('is the pointer\'s while the pointer is on one, and the focus\'s otherwise', () => {
    hoverMark('M1', 'focus')
    expect(store.getState().hoveredMark).toBe('M1')
    hoverMark('M2', 'pointer')
    expect(store.getState().hoveredMark).toBe('M2')
    // The pointer leaves row M2: the row the keys are in is lit again, not put out.
    unhoverMark('M2', 'pointer')
    expect(store.getState().hoveredMark).toBe('M1')
    unhoverMark('M1', 'focus')
    expect(store.getState().hoveredMark).toBeNull()
  })

  it('is let go only by what took it: a row the pointer left does not put out another\'s', () => {
    hoverMark('M2', 'pointer')
    unhoverMark('M1', 'pointer')
    expect(store.getState().hoveredMark).toBe('M2')
    hoverMark('M1', 'focus')
    unhoverMark('M2', 'focus')
    unhoverMark('M2', 'pointer')
    expect(store.getState().hoveredMark).toBe('M1')
  })
})

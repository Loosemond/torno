import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewDrawing } from '../../shared/drawing'
import { type Drawn, type Pictured, drawingActions, drawingStore, drawingWaits } from './drawing'

// The store of a drawing on the view: what waits for which session, and when what a picture holds of the window's
// memory (its object URL and its decoded bitmap) is let go: once no board and no drawing holds it, and not before.

let closed: string[] = []
let revoked: string[] = []

const picture = (name: string): Pictured => ({
  url: `blob:${name}`,
  bitmap: { close: () => void closed.push(name) } as unknown as ImageBitmap,
  width: 64, height: 48, objectId: 'bracket', revision: 3, layout: 'assembly', caption: 'view current', ink: '#B5127A', casing: '#FAF9F6',
  camera: { position: [1, 1, 1], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
  shows: 'same'
})
const drawn = (p: Pictured, thumb: string): Drawn => ({ picture: p, strokes: [{ tool: 'pen', width: 3, points: [[1, 1]] }], drawing: { objectId: p.objectId } as ViewDrawing, thumb: `blob:${thumb}` })

beforeEach(() => {
  closed = []
  revoked = []
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => void revoked.push(url))
})
afterEach(() => {
  drawingStore.setState({ board: null, drawn: {}, opening: null })
  vi.restoreAllMocks()
})

describe('a drawing that waits', () => {
  it('waits for the session it was kept for, and puts the board away', () => {
    const p = picture('one')
    drawingActions.openOn('s1', p)
    drawingActions.keep('s1', drawn(p, 'thumb1'))
    expect(drawingStore.getState().board).toBeNull()
    expect(drawingWaits('s1')).toBe(true)
    expect(drawingWaits('s2')).toBe(false)
    expect(closed).toEqual([])
  })
  it('takes the place of the one that waited, which is let go, picture and all', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    drawingActions.keep('s1', drawn(picture('two'), 'thumb2'))
    expect(drawingStore.getState().drawn.s1.thumb).toBe('blob:thumb2')
    expect(revoked).toEqual(['blob:thumb1', 'blob:one'])
    expect(closed).toEqual(['one'])
  })
  it('opened again and kept, keeps its picture: only the old thumbnail goes', () => {
    const p = picture('one')
    drawingActions.keep('s1', drawn(p, 'thumb1'))
    drawingActions.edit('s1')
    expect(drawingStore.getState().board?.strokes).toHaveLength(1)
    drawingActions.keep('s1', drawn(p, 'thumb2'))
    expect(revoked).toEqual(['blob:thumb1'])
    expect(closed).toEqual([])
  })
  it('opened again and put away, still waits as it was', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    drawingActions.edit('s1')
    drawingActions.cancel()
    expect(drawingWaits('s1')).toBe(true)
    expect(revoked).toEqual([])
  })
  it('removed, is let go', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    drawingActions.remove('s1')
    expect(drawingWaits('s1')).toBe(false)
    expect(revoked).toEqual(['blob:thumb1', 'blob:one'])
    expect(closed).toEqual(['one'])
  })
})

describe('a board put away', () => {
  it('lets go of a picture nothing else holds', () => {
    drawingActions.openOn('s1', picture('one'))
    drawingActions.cancel()
    expect(drawingStore.getState().board).toBeNull()
    expect(closed).toEqual(['one'])
  })
})

describe('a prompt with a drawing', () => {
  it('takes the drawing out of waiting; sent, the drawing is let go', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    const taken = drawingActions.taken('s1')!
    expect(drawingWaits('s1')).toBe(false)
    drawingActions.spent(taken)
    expect(closed).toEqual(['one'])
  })
  it('not sent, gives the drawing back to wait again', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    const taken = drawingActions.taken('s1')!
    drawingActions.giveBack('s1', taken)
    expect(drawingStore.getState().drawn.s1).toBe(taken)
    expect(closed).toEqual([])
  })
  it('not sent while another was drawn meanwhile: the newer waits, the one given back is let go', () => {
    drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
    const taken = drawingActions.taken('s1')!
    drawingActions.keep('s1', drawn(picture('two'), 'thumb2'))
    drawingActions.giveBack('s1', taken)
    expect(drawingStore.getState().drawn.s1.thumb).toBe('blob:thumb2')
    expect(closed).toEqual(['one'])
  })
})

it('lets everything go with the workspace: every drawing, and the board', () => {
  drawingActions.keep('s1', drawn(picture('one'), 'thumb1'))
  drawingActions.keep('s2', drawn(picture('two'), 'thumb2'))
  drawingActions.openOn('s3', picture('three'))
  drawingActions.clear()
  expect(drawingStore.getState()).toEqual({ board: null, drawn: {}, opening: null })
  expect(closed.sort()).toEqual(['one', 'three', 'two'])
})

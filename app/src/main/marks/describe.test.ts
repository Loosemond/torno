import { describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { describeMark, number } from './describe'

const BASE = {
  author: 'user',
  note: '',
  status: 'draft',
  anchorState: 'ok',
  layout: 'assembly',
  revision: 1,
  camera: { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
  createdAt: '2026-10-09T12:00:00.000Z'
} as const

const mark = (m: object): Mark => ({ ...BASE, ...m }) as Mark

describe('number', () => {
  // The cases of the kernel's own `number` (kernel/tests/test_queries.py): the two write numbers alike.
  it.each([
    [20, '20'],
    [1180.0, '1180'],
    [502.6548, '502.7'],
    [25.1327, '25.13'],
    [6000.0000001, '6000'],
    [12345.6, '12350'],
    [0.5, '0.5'],
    [0.012346, '0.01235'],
    [-2.5, '-2.5'],
    [-0, '0'],
    [1e-12, '0'],
    [-1e-12, '0'],
    [-0.0000001, '0'],
    [9e-7, '0'],
    [0.000002, '0.000002'],
    [-0.00025, '-0.00025'],
    [40.5, '40.5'],
    [14.2, '14.2'],
    [0.99996, '1'],
    [9999.6, '10000']
  ])('writes %f as %s', (value, text) => {
    expect(number(value)).toBe(text)
  })
})

describe('describeMark', () => {
  it('says what a pin is on, where, and its note', () => {
    const pin = mark({
      id: 'M3',
      kind: 'pin',
      note: 'this edge is ugly',
      anchor: { point: [12, 40.5, 20.0000001], part: 'lid', ref: 'lid/F12', descriptor: 'plane, normal +Z, z = 20, 1180 mm²' }
    })
    expect(describeMark(pin)).toBe('M3 pin on lid/F12 (plane, normal +Z, z = 20, 1180 mm²) at (12, 40.5, 20): "this edge is ugly"')
  })

  it('says of a pin in empty space only where it is', () => {
    expect(describeMark(mark({ id: 'M1', kind: 'pin', note: 'here', anchor: { point: [1.23456, -0, 3] } }))).toBe('M1 pin at (1.235, 0, 3): "here"')
  })

  it('names what a pick is of', () => {
    const pick = mark({ id: 'M4', kind: 'pick', target: 'edge', note: 'round this', anchor: { point: [0, 0, 0], part: 'base', ref: 'base/E7', descriptor: 'line, 40 mm' } })
    expect(describeMark(pick)).toBe('M4 pick of base/E7 (line, 40 mm): "round this"')
    const bare = mark({ id: 'M4', kind: 'pick', target: 'part', anchor: { point: [0, 0, 0], part: 'base', ref: 'base' } })
    expect(describeMark(bare)).toBe('M4 pick of base')
  })

  it('gives an arrow its start, its vector and its length', () => {
    const arrow = mark({
      id: 'M5',
      kind: 'arrow',
      note: 'move this wall out',
      from: { point: [0, 10, 5], part: 'lid', ref: 'lid/F3', descriptor: 'plane, normal +Y, y = 10, 200 mm²' },
      to: [0, 24.2, 5]
    })
    expect(describeMark(arrow)).toBe('M5 arrow from lid/F3 (plane, normal +Y, y = 10, 200 mm²) at (0, 10, 5) by (0, 14.2, 0), 14.2 mm: "move this wall out"')
    expect(describeMark(mark({ id: 'M5', kind: 'arrow', from: { point: [0, 0, 0] }, to: [3, 4, 0] }))).toBe('M5 arrow from (0, 0, 0) by (3, 4, 0), 5 mm')
  })

  it('names the plane of a stroke drawn on a view, counts its points and measures it', () => {
    const points2d = Array.from({ length: 23 }, (_, i) => [(i * 60) / 22, i % 2 === 0 ? 0 : 35])
    const stroke = mark({
      id: 'M6',
      kind: 'stroke',
      space: 'plane',
      note: 'profile like this',
      anchor: { point: [0, 40, 0] },
      plane: { origin: [0, 40, 0], x: [1, 0, 0], y: [0, 0, 1], label: 'XZ at y = 40.0' },
      points2d
    })
    expect(describeMark(stroke)).toBe('M6 stroke on plane XZ at y = 40.0, 23 points, 60 × 35 mm: "profile like this"')
  })

  it('says what a stroke on a surface starts on', () => {
    const stroke = mark({
      id: 'M8',
      kind: 'stroke',
      space: 'surface',
      note: 'crack',
      anchor: { point: [1, 2, 20], part: 'lid', ref: 'lid/F12', descriptor: 'plane, normal +Z, z = 20, 1180 mm²' },
      points: [
        [1, 2, 20],
        [11, 2, 20],
        [11, 7.5, 20]
      ]
    })
    expect(describeMark(stroke)).toBe('M8 stroke on lid/F12 (plane, normal +Z, z = 20, 1180 mm²) from (1, 2, 20), 3 points, 10 × 5.5 × 0 mm: "crack"')
  })

  it('gives a shape its size, where its centre is and what it is meant for', () => {
    const shape = { id: 'M7', kind: 'shape', note: 'pocket here', intent: 'remove', position: [5, 5, 4.5], rotation: [0, 0, 0, 1] }
    expect(describeMark(mark({ ...shape, shape: 'box', size: [10, 10, 4] }))).toBe('M7 box 10 × 10 × 4 mm centred at (5, 5, 4.5), intent remove: "pocket here"')
    expect(describeMark(mark({ ...shape, shape: 'cylinder', size: [8, 8, 20], note: '' }))).toBe('M7 cylinder diameter 8, height 20 mm centred at (5, 5, 4.5), intent remove')
    expect(describeMark(mark({ ...shape, shape: 'sphere', size: [6, 6, 6], note: '', intent: 'keep-out' }))).toBe('M7 sphere diameter 6 mm centred at (5, 5, 4.5), intent keep-out')
    expect(describeMark(mark({ ...shape, shape: 'plane', size: [30, 20, 0], note: '', intent: 'reference' }))).toBe('M7 plane 30 × 20 mm centred at (5, 5, 4.5), intent reference')
  })

  it('says how a shape is turned when it is, in degrees about X, Y and Z', () => {
    const box = { id: 'M7', kind: 'shape', shape: 'box', intent: 'add', size: [10, 10, 4], position: [0, 0, 0] }
    const half = (degrees: number) => [Math.sin((degrees * Math.PI) / 360), Math.cos((degrees * Math.PI) / 360)]
    const [s15, c15] = half(15)
    expect(describeMark(mark({ ...box, rotation: [0, 0, s15, c15] }))).toBe('M7 box 10 × 10 × 4 mm centred at (0, 0, 0), rotated (0, 0, 15)°, intent add')
    const [s90, c90] = half(90)
    expect(describeMark(mark({ ...box, rotation: [s90, 0, 0, c90] }))).toBe('M7 box 10 × 10 × 4 mm centred at (0, 0, 0), rotated (90, 0, 0)°, intent add')
    expect(describeMark(mark({ ...box, rotation: [0, -s15, 0, c15] }))).toBe('M7 box 10 × 10 × 4 mm centred at (0, 0, 0), rotated (0, -15, 0)°, intent add')
    // About X by 30, then about Z by 45, as three.js composes 'XYZ': q = qx · qz.
    const [sx, cx] = half(30)
    const [sz, cz] = half(45)
    expect(describeMark(mark({ ...box, rotation: [sx * cz, -sx * sz, cx * sz, cx * cz] }))).toBe('M7 box 10 × 10 × 4 mm centred at (0, 0, 0), rotated (30, 0, 45)°, intent add')
    // A quaternion and its negative are one rotation; none at all is not said.
    expect(describeMark(mark({ ...box, rotation: [0, 0, -s15, -c15] }))).toContain('rotated (0, 0, 15)°')
    expect(describeMark(mark({ ...box, rotation: [0, 0, 0, -1] }))).toBe('M7 box 10 × 10 × 4 mm centred at (0, 0, 0), intent add')
  })

  it('says where a mark that moved or lost its part was placed, not what is there: the ref may now name something else', () => {
    const pin = { id: 'M3', kind: 'pin', note: 'here', anchor: { point: [1, 2, 3], part: 'lid', ref: 'lid/F12', descriptor: 'plane, normal +Z, z = 20, 1180 mm²' } }
    expect(describeMark(mark({ ...pin, anchorState: 'drifted' }))).toBe('M3 pin placed on lid/F12 at (1, 2, 3): "here" [moved since it was placed: check it]')
    expect(describeMark(mark({ ...pin, anchorState: 'orphaned', note: '' }))).toBe('M3 pin placed on lid/F12 at (1, 2, 3) [its part is gone]')

    // A pick of an edge that drifted keeps its ref, and carries the descriptor of the face now under it.
    const pick = { id: 'M4', kind: 'pick', target: 'edge', note: 'round this', anchor: { point: [0, 0, 0], part: 'plate', ref: 'plate/E1', descriptor: 'plane, normal +Z, z = 5, 1200 mm²' } }
    expect(describeMark(mark({ ...pick, anchorState: 'drifted' }))).toBe('M4 pick placed on plate/E1: "round this" [moved since it was placed: check it]')
    expect(describeMark(mark({ ...pick, anchorState: 'orphaned' }))).toBe('M4 pick placed on plate/E1: "round this" [its part is gone]')

    const arrow = mark({ id: 'M5', kind: 'arrow', anchorState: 'drifted', from: { point: [0, 10, 5], part: 'lid', ref: 'lid/F3', descriptor: 'plane, normal +Y, y = 10, 200 mm²' }, to: [0, 20, 5] })
    expect(describeMark(arrow)).toBe('M5 arrow placed on lid/F3, from (0, 10, 5) by (0, 10, 0), 10 mm [moved since it was placed: check it]')
    const stroke = mark({ id: 'M8', kind: 'stroke', space: 'surface', anchorState: 'orphaned', anchor: { point: [1, 2, 20], part: 'lid', ref: 'lid/F12', descriptor: 'plane' }, points: [[1, 2, 20], [11, 2, 20]] })
    expect(describeMark(stroke)).toBe('M8 stroke placed on lid/F12 from (1, 2, 20), 2 points, 10 × 0 × 0 mm [its part is gone]')
    // What names nothing says nothing more.
    expect(describeMark(mark({ id: 'M1', kind: 'pin', anchorState: 'drifted', anchor: { point: [1, 2, 3] } }))).toBe('M1 pin at (1, 2, 3) [moved since it was placed: check it]')
  })

  it('says a pin on an edge is on the edge, between which faces, and what the edge is', () => {
    const anchor = { point: [20, 0, 5], part: 'lid', ref: 'lid/E40', edge: 'lid/E40', between: ['lid/F12', 'lid/F40'], descriptor: 'line, 40 mm' }
    expect(describeMark(mark({ id: 'M3', kind: 'pin', note: 'this edge is ugly', anchor }))).toBe(
      'M3 pin on the edge lid/E40 between lid/F12 and lid/F40 (line, 40 mm) at (20, 0, 5): "this edge is ugly"'
    )
    // A seam has one face, and a kernel that could not describe the edge says nothing of it.
    const { between: _one, descriptor: _none, ...seam } = anchor
    expect(describeMark(mark({ id: 'M3', kind: 'pin', anchor: seam }))).toBe('M3 pin on the edge lid/E40 at (20, 0, 5)')
    // Once it has moved off it, only where it was placed.
    expect(describeMark(mark({ id: 'M3', kind: 'pin', anchorState: 'drifted', anchor }))).toBe('M3 pin placed on lid/E40 at (20, 0, 5) [moved since it was placed: check it]')
  })

  it('says so when nothing has checked an open mark against the build there is', () => {
    const pin = { id: 'M6', kind: 'pin', note: 'here', anchor: { point: [1, 2, 3], part: 'lid', ref: 'lid/F2' } }
    expect(describeMark(mark({ ...pin, checkedRevision: 11 }), { revision: 12 })).toBe('M6 pin on lid/F2 at (1, 2, 3): "here" [not checked against r12]')
    expect(describeMark(mark(pin), { revision: 12 })).toBe('M6 pin on lid/F2 at (1, 2, 3): "here" [not checked against r12]')
    expect(describeMark(mark({ ...pin, checkedRevision: 12 }), { revision: 12 })).toBe('M6 pin on lid/F2 at (1, 2, 3): "here"')
    // Any other build than this one: revisions count anew when an object is opened again.
    expect(describeMark(mark({ ...pin, checkedRevision: 13 }), { revision: 12 })).toBe('M6 pin on lid/F2 at (1, 2, 3): "here" [not checked against r12]')
    // After what the last check found, when it found something.
    expect(describeMark(mark({ ...pin, checkedRevision: 11, anchorState: 'drifted' }), { revision: 12 })).toBe(
      'M6 pin placed on lid/F2 at (1, 2, 3): "here" [moved since it was placed: check it] [not checked against r12]'
    )
    // A resolved mark is checked by nothing, and nothing is said of it; nor when no build is named.
    expect(describeMark(mark({ ...pin, status: 'resolved', checkedRevision: 3 }), { revision: 12 })).toBe('M6 pin on lid/F2 at (1, 2, 3): "here"')
    expect(describeMark(mark(pin))).toBe('M6 pin on lid/F2 at (1, 2, 3): "here"')
  })

  it('says what a line is news of, before the mark', () => {
    const pin = { id: 'M2', kind: 'pin', note: 'here', anchor: { point: [1, 2, 3] } }
    expect(describeMark(mark(pin), { tag: 'changed' })).toBe('(changed) M2 pin at (1, 2, 3): "here"')
    expect(describeMark(mark({ ...pin, author: 'agent' }), { tag: 'reopened by the user' })).toBe('(yours, reopened by the user) M2 pin at (1, 2, 3): "here"')
  })

  it("marks the agent's own", () => {
    const pin = mark({ id: 'M9', kind: 'pin', author: 'agent', note: 'this face?', anchor: { point: [1, 2, 3], part: 'lid', ref: 'lid/F2' } })
    expect(describeMark(pin)).toBe('(yours) M9 pin on lid/F2 at (1, 2, 3): "this face?"')
  })

  it('is one line whatever the note holds', () => {
    const pin = mark({ id: 'M1', kind: 'pin', note: '  two\nlines\tand a tab ', anchor: { point: [0, 0, 0] } })
    expect(describeMark(pin)).toBe('M1 pin at (0, 0, 0): "two lines and a tab"')
  })
})

describe('a dimension in one line', () => {
  const TOP = { point: [5, 3, 3], normal: [0, 0, 1], part: 'base', ref: 'base/F5', descriptor: 'plane, normal +Z, z = 3, 1100 mm²' }
  const BOTTOM = { point: [5, 3, -3], normal: [0, 0, -1], part: 'base', ref: 'base/F0' }
  const distance = (m: object = {}): Mark => mark({ id: 'M7', kind: 'dimension', measure: 'distance', a: TOP, b: BOTTOM, value: 6, how: 'between planes', points: [[5, 3, 3], [5, 3, -3]], measuredRevision: 4, ...m })
  const hole = (m: object = {}): Mark => mark({ id: 'M8', kind: 'dimension', measure: 'diameter', a: { point: [-6, 5, 0], part: 'base', ref: 'base/F9' }, value: 8, how: 'cylinder', measuredRevision: 4, ...m })

  it('says the value, how it was taken and between what', () => {
    expect(describeMark(distance())).toBe('M7 distance 6 mm between planes, base/F5 to base/F0')
    expect(describeMark(distance({ value: 6.00000001, note: 'the plate' }))).toBe('M7 distance 6 mm between planes, base/F5 to base/F0: "the plate"')
    expect(describeMark(distance({ how: 'point to plane', a: { point: [1, 2, 9.5] }, value: 6.5 }))).toBe('M7 distance 6.5 mm point to plane, (1, 2, 9.5) to base/F0')
    expect(describeMark(distance({ measure: 'angle', value: 45, how: 'between normals' }))).toBe('M7 angle 45° between normals, base/F5 to base/F0')
    expect(describeMark(distance({ measure: 'thickness', b: undefined, value: 2, how: 'wall, along the normal' }))).toBe('M7 thickness 2 mm wall, along the normal, base/F5 at (5, 3, 3)')
  })

  it('of a diameter or a radius says what it is of, and no more of how unless that says which', () => {
    expect(describeMark(hole())).toBe('M8 diameter 8 mm, base/F9')
    expect(describeMark(hole({ measure: 'radius', value: 4, how: 'circle', a: { point: [0, 0, 0], part: 'base', ref: 'base/E3' } }))).toBe('M8 radius 4 mm, base/E3')
    expect(describeMark(hole({ measure: 'radius', value: 2, how: 'torus, of the tube' }))).toBe('M8 radius 2 mm (torus, of the tube), base/F9')
  })

  it('with an expectation says what was expected and the tolerance, the verdict, and how far off which way', () => {
    expect(describeMark(hole({ expected: 8.5, verdict: 'fail' }))).toBe('M8 diameter 8 mm, base/F9 (expected 8.5 ± 0.05: FAIL, 0.5 under)')
    expect(describeMark(hole({ value: 8.7, expected: 8.5, tolerance: 0.1, verdict: 'fail' }))).toBe('M8 diameter 8.7 mm, base/F9 (expected 8.5 ± 0.1: FAIL, 0.2 over)')
    expect(describeMark(hole({ value: 8.02, expected: 8, verdict: 'pass' }))).toBe('M8 diameter 8.02 mm, base/F9 (expected 8 ± 0.05: pass)')
    expect(describeMark(distance({ measure: 'angle', value: 44, how: 'between normals', expected: 45, verdict: 'fail' }))).toBe('M7 angle 44° between normals, base/F5 to base/F0 (expected 45 ± 0.1: FAIL, 1 under)')
  })

  it('never gives a value it cannot stand by: none without one, none once an end moved or lost its part', () => {
    expect(describeMark(distance({ id: 'M9', value: undefined, how: undefined, points: undefined, anchorState: 'orphaned' }))).toBe('M9 distance: not measurable, [its part is gone]')
    expect(describeMark(distance({ id: 'M9', anchorState: 'orphaned', expected: 6, verdict: 'pass' }))).toBe('M9 distance: not measurable, [its part is gone]')
    expect(describeMark(distance({ id: 'M9', anchorState: 'drifted', note: 'the plate' }))).toBe('M9 distance: not measurable, [moved since it was placed: check it]: "the plate"')
    expect(describeMark(hole({ value: undefined, how: undefined }))).toBe('M8 diameter: not measurable, base/F9')
    expect(describeMark(hole({ value: undefined, how: undefined, expected: 8.5 }))).toBe('M8 diameter: not measurable, base/F9 (expected 8.5 ± 0.05)')
  })

  it('says when the value is of an older build than the last, or of none it knows', () => {
    expect(describeMark(hole(), { revision: 4 })).toBe('M8 diameter 8 mm, base/F9 [not checked against r4]')
    expect(describeMark(hole({ checkedRevision: 4 }), { revision: 4 })).toBe('M8 diameter 8 mm, base/F9')
    expect(describeMark(hole({ checkedRevision: 5 }), { revision: 5 })).toBe('M8 diameter 8 mm, base/F9 [measured on r4, not on r5]')
    expect(describeMark(hole({ checkedRevision: 5, measuredRevision: undefined }), { revision: 5 })).toBe('M8 diameter 8 mm, base/F9 [measured on an earlier build, not on r5]')
    expect(describeMark(hole({ status: 'resolved', measuredRevision: 2 }), { revision: 5 })).toBe('M8 diameter 8 mm, base/F9')
  })

  it('says whose it is, and that it changed, like any mark', () => {
    expect(describeMark(hole({ author: 'agent' }), { tag: 'changed' })).toBe('(yours, changed) M8 diameter 8 mm, base/F9')
  })
})

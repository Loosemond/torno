import * as THREE from 'three'
import type { Line2 } from 'three/addons/lines/Line2.js'
import { describe, expect, it } from 'vitest'
import type { DimensionMark, Vec3 } from '../../../shared/marks'
import { labelValue, place, project } from './labels'
import { MarkLayer, onHidden } from './MarkLayer'
import { ARC_PX, DIMENSION_BEHIND, LEADER_PX, TICK_PX, build, labelAnchor, markPoints, rescale } from './markObjects'

const CAMERA = { position: [100, -100, 80] as Vec3, target: [0, 0, 10] as Vec3, up: [0, 0, 1] as Vec3, ortho: false, fov: 35, zoom: 1 }
// Measured on r1, the build the tests draw unless they say otherwise.
const BASE = { author: 'user', note: '', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 1, measuredRevision: 1, camera: CAMERA, createdAt: '2026-10-09T10:00:00.000Z' } as const
const COLOURS = { user: '#cf3f2c', agent: '#2b8a5c', reference: '#6c7178' }
const SIZE = { width: 800, height: 600 }

const TOP = { point: [5, 3, 3] as Vec3, normal: [0, 0, 1] as Vec3, part: 'plate', ref: 'plate/F5' }
const BOTTOM = { point: [9, 8, -3] as Vec3, normal: [0, 0, -1] as Vec3, part: 'plate', ref: 'plate/F0' }
const distance = (over: Partial<DimensionMark> = {}): DimensionMark => ({ ...BASE, id: 'M1', kind: 'dimension', measure: 'distance', a: TOP, b: BOTTOM, value: 6, how: 'between planes', points: [[5, 3, 3], [5, 3, -3]], ...over })
const diameter = (over: Partial<DimensionMark> = {}): DimensionMark => ({ ...BASE, id: 'M2', kind: 'dimension', measure: 'diameter', a: { point: [-6, 5, 0], part: 'plate', ref: 'plate/F9' }, value: 8, how: 'cylinder', points: [[-14, 5, 0], [-6, 5, 0]], ...over })
// The top of the plate and its chamfer, which meet along Y at x = 18, z = 3.
const angle = (over: Partial<DimensionMark> = {}): DimensionMark => ({
  ...BASE,
  id: 'M3',
  kind: 'dimension',
  measure: 'angle',
  a: { point: [10, 0, 3], normal: [0, 0, 1], part: 'plate', ref: 'plate/F5' },
  b: { point: [19, 0, 2], normal: [Math.SQRT1_2, 0, Math.SQRT1_2], part: 'plate', ref: 'plate/F3' },
  value: 45,
  how: 'between normals',
  points: [[10, 0, 3], [19, 0, 2]],
  ...over
})

const names = (object: THREE.Object3D): string[] => object.children.flatMap((c) => (c.name ? [c.name] : names(c)))
function ends(line: THREE.Object3D): Array<[THREE.Vector3, THREE.Vector3]> {
  let fat: Line2 | undefined
  line.traverse((c) => {
    if ((c as Line2).geometry && !fat) fat = c as Line2
  })
  const start = fat!.geometry.getAttribute('instanceStart')
  const end = fat!.geometry.getAttribute('instanceEnd')
  return Array.from({ length: start.count }, (_, i) => [new THREE.Vector3().fromBufferAttribute(start, i), new THREE.Vector3().fromBufferAttribute(end, i)])
}
function topCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 1, 500)
  camera.position.set(0, 0, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

describe('a dimension as it is drawn', () => {
  it('is a line between the points its value was taken between, with a tick at each end', () => {
    const drawn = build(distance(), COLOURS, 1)
    expect(names(drawn)).toEqual(['line', 'tick', 'tick', 'witness'])
    const [[from, to]] = ends(drawn.getObjectByName('line')!)
    expect(from.toArray()).toEqual([5, 3, 3])
    expect(to.toArray()).toEqual([5, 3, -3])
    // From the end that was clicked elsewhere than the value was taken to: a witness line to it.
    const [[clicked, measured]] = ends(drawn.getObjectByName('witness')!)
    expect(clicked.toArray()).toEqual([9, 8, -3])
    expect(measured.toArray()).toEqual([5, 3, -3])
    // None where both ends are where the value was taken.
    expect(names(build(distance({ b: { ...BOTTOM, point: [5, 3, -3] } }), COLOURS, 1))).toEqual(['line', 'tick', 'tick'])
  })

  it('of a diameter is the line across, with a leader standing off the rim for its value; of a radius the line from the centre', () => {
    expect(names(build(diameter(), COLOURS, 1))).toEqual(['line', 'tick', 'tick', 'leader'])
    expect(names(build(diameter({ measure: 'radius', value: 4, points: [[-10, 5, 0], [-6, 5, 0]] }), COLOURS, 1))).toEqual(['line', 'dot', 'tick', 'leader'])
    expect(labelAnchor(diameter())).toEqual({ point: [-6, 5, 0], leader: [1, 0, 0] })
  })

  it('of an angle between two faces is an arc where they meet, as wide as the angle', () => {
    const drawn = build(angle(), COLOURS, 1)
    expect(names(drawn)).toEqual(['arc'])
    const arc = drawn.getObjectByName('arc')!
    // Where the two planes meet, level with the points: x = 18, z = 3.
    expect(arc.position.x).toBeCloseTo(18)
    expect(arc.position.y).toBeCloseTo(0)
    expect(arc.position.z).toBeCloseTo(3)
    const sweep = ends(arc.getObjectByName('sweep')!)
    const first = sweep[0][0].clone().normalize()
    const last = sweep.at(-1)![1].clone().normalize()
    expect(THREE.MathUtils.radToDeg(first.angleTo(last))).toBeCloseTo(45, 4)
    expect(sweep[0][0].length()).toBeCloseTo(ARC_PX)
    // The first side lies in the first face.
    expect(first.dot(new THREE.Vector3(0, 0, 1))).toBeCloseTo(0)
    // Its label hangs off the middle of the arc.
    const anchor = labelAnchor(angle())
    expect(anchor.reach).toBe(ARC_PX)
    expect(new THREE.Vector3().fromArray(anchor.leader!).angleTo(first)).toBeCloseTo(Math.PI / 8)
  })

  it('of an angle with no two faces to meet (edges, parallel faces) is a line between its points', () => {
    expect(names(build(angle({ a: { point: [10, 0, 3], part: 'plate', ref: 'plate/E2' } }), COLOURS, 1))).toEqual(['line', 'tick', 'tick'])
    expect(names(build(angle({ b: { ...angle().b!, normal: [0, 0, -1] }, value: 180 }), COLOURS, 1))).toEqual(['line', 'tick', 'tick'])
  })

  it('without points, or once an end moved, is a leader from its first end: there is nothing it was taken between', () => {
    expect(names(build(distance({ value: undefined, points: undefined }), COLOURS, 1))).toEqual(['dot', 'leader'])
    expect(names(build(distance({ anchorState: 'drifted' }), COLOURS, 1))).toEqual(['dot', 'leader'])
    expect(labelAnchor(distance({ anchorState: 'orphaned' }))).toEqual({ point: [5, 3, 3], leader: [0, 0, 1] })
  })

  it('keeps more of itself where a part is in front than other marks do: its lines run through the part as a rule', () => {
    const materials: THREE.Material[] = []
    build(distance(), COLOURS, 1).getObjectByName('line')!.traverse((c) => {
      const material = (c as THREE.Mesh).material as THREE.Material | undefined
      if (material) materials.push(material)
    })
    const [behind, open] = materials
    expect(behind.depthFunc).toBe(THREE.GreaterDepth)
    expect(behind.opacity).toBeCloseTo(open.opacity * DIMENSION_BEHIND)
  })

  it('is bounded by its ends and the points it was taken between', () => {
    expect(markPoints(distance())).toEqual([[5, 3, 3], [9, 8, -3], [5, 3, 3], [5, 3, -3]])
    expect(markPoints(diameter({ points: undefined }))).toEqual([[-6, 5, 0]])
  })

  it('keeps its ticks a few pixels long, square to its line and facing the view', () => {
    const camera = topCamera()
    // Along X, seen from above: the ticks run along Y.
    const drawn = build(distance({ points: [[0, 0, 0], [20, 0, 0]] }), COLOURS, 1)
    rescale(drawn, () => 0.25, 1, camera)
    const tick = drawn.getObjectByName('tick')!
    const [[from, to]] = ends(tick)
    const along = to.clone().sub(from).applyQuaternion(tick.quaternion).multiplyScalar(tick.scale.x)
    expect(Math.abs(along.y)).toBeCloseTo(2 * TICK_PX * 0.25)
    expect(along.x).toBeCloseTo(0)
    expect(along.z).toBeCloseTo(0)
  })
})

describe('the label of a dimension', () => {
  const camera = topCamera()

  it('hangs at the middle of its line and carries its value, with the verdict when it has one', () => {
    const [plain, failing, passing] = project([distance({ points: [[0, 0, 0], [20, 0, 0]] }), diameter({ expected: 8.5, verdict: 'fail' }), diameter({ id: 'M4', expected: 8, verdict: 'pass', author: 'agent' })], camera, SIZE, 1, 1)
    expect(plain).toMatchObject({ id: 'M1', text: 'M1', value: { text: '6 mm' }, x: 500, y: 300 })
    expect(plain.value).not.toHaveProperty('verdict')
    expect(failing).toMatchObject({ text: 'M2', value: { text: '⌀ 8 mm', verdict: 'fail' } })
    expect(passing).toMatchObject({ author: 'agent', value: { text: '⌀ 8 mm', verdict: 'pass' } })
    // A diameter's hangs at the end of its leader, off the rim.
    expect(failing.x).toBeCloseTo(400 + (-6 / 80) * 800 + LEADER_PX)
  })

  it('shows no value it cannot stand by: none where the kernel gave none or its part is gone', () => {
    const [unmeasurable, orphaned] = project([distance({ value: undefined, points: undefined }), distance({ anchorState: 'orphaned', expected: 6, verdict: 'pass' })], camera, SIZE, 1, 1)
    expect(unmeasurable.value).toEqual({ text: '—' })
    expect(orphaned).toMatchObject({ text: 'M1?', value: { text: '—' } })
  })

  it('one whose end moved is measured from what is under it now: its value and verdict stand, and its number says it moved', () => {
    const [drifted] = project([distance({ anchorState: 'drifted', expected: 6, verdict: 'pass' })], camera, SIZE, 1, 1)
    expect(drifted).toMatchObject({ text: 'M1~', value: { text: '6 mm', verdict: 'pass' } })
  })

  it('a value of another build than the one drawn is what it was: stale, and without its verdict', () => {
    const failing = diameter({ expected: 8.5, verdict: 'fail' })
    expect(labelValue(failing, 1)).toEqual({ text: '⌀ 8 mm', verdict: 'fail' })
    // It says which build it is of: faint alone is easily missed in a picture.
    expect(labelValue(failing, 2)).toEqual({ text: '⌀ 8 mm (r1)', stale: true })
    // Of a run before this one, or with no build at all.
    expect(labelValue({ ...failing, measuredRevision: undefined }, 2)).toEqual({ text: '⌀ 8 mm (earlier)', stale: true })
    expect(labelValue(failing, 0)).toEqual({ text: '⌀ 8 mm (r1)', stale: true })
    expect(labelValue(failing, undefined)).toEqual({ text: '⌀ 8 mm (r1)', stale: true })
    expect(labelValue(diameter({ value: undefined, measuredRevision: undefined }), 2)).toEqual({ text: '—' })
    // The layer draws its labels as of the build it was last told of, on screen and in a picture alike.
    const marks = new MarkLayer(COLOURS)
    const chip = () => ({ w: 40, h: 17 })
    marks.setMarks([failing], 1)
    marks.show('assembly')
    expect(marks.labels('assembly', camera, SIZE, 1, chip)[0].value).toEqual({ text: '⌀ 8 mm', verdict: 'fail' })
    marks.setMarks([failing], 2)
    expect(marks.labels('assembly', camera, SIZE, 1, chip)[0].value).toEqual({ text: '⌀ 8 mm (r1)', stale: true })
    // Told of the marks alone, it keeps the build it knew.
    marks.setMarks([{ ...failing, measuredRevision: 2 }])
    expect(marks.labels('assembly', camera, SIZE, 1, chip)[0].value).toEqual({ text: '⌀ 8 mm', verdict: 'fail' })
  })

  it('is hidden with its parts only when the part of each end is switched off', () => {
    const across = distance({ b: { ...BOTTOM, part: 'lid' } })
    expect(onHidden(across, new Set(['plate']))).toBe(false)
    expect(onHidden(across, new Set(['lid']))).toBe(false)
    expect(onHidden(across, new Set(['plate', 'lid']))).toBe(true)
    expect(onHidden(distance(), new Set(['plate']))).toBe(true)
    expect(onHidden(diameter(), new Set(['plate']))).toBe(true)
    // An end in the air is on no part: the dimension is drawn while it has such an end.
    expect(onHidden(distance({ b: { point: [0, 0, 9] } }), new Set(['plate']))).toBe(false)
    // Any other mark goes by the part it is anchored on.
    expect(onHidden({ ...BASE, id: 'M9', kind: 'pin', anchor: TOP }, new Set(['plate']))).toBe(true)
  })

  it('other marks have none', () => {
    const [pin] = project([{ ...BASE, id: 'M9', kind: 'pin', anchor: { point: [0, 0, 0] } }], camera, SIZE)
    expect(pin).not.toHaveProperty('value')
  })

  it('is given a chip wide enough for its number and its value', () => {
    const asked: Array<[string, string | undefined]> = []
    const chip = (text: string, value?: { text: string }) => {
      asked.push([text, value?.text])
      return { w: 8 * (text.length + (value ? value.text.length + 1 : 0)), h: 16 }
    }
    const [placed] = place(project([distance({ points: [[0, 0, 0], [20, 0, 0]] })], camera, SIZE, 1, 1), chip, SIZE)
    expect(asked).toEqual([['M1', '6 mm']])
    expect(placed.box.w).toBe(56)
  })

  it('a draft of one has no label, and is drawn as its line', () => {
    const marks = new MarkLayer(COLOURS)
    marks.setDraft({ kind: 'dimension', from: [0, 0, 0], to: [10, 0, 0] })
    expect(names(marks.group.children[0])).toEqual(['line', 'tick', 'tick'])
    marks.setDraft({ kind: 'dimension', from: [0, 0, 0], to: null })
    expect(names(marks.group.children[0])).toEqual(['dot'])
    expect(marks.labels('', camera, SIZE, 1, () => ({ w: 10, h: 10 }))).toEqual([])
  })

  it('is not made again when it is only measured on another build, and is when its value changes', () => {
    const marks = new MarkLayer(COLOURS)
    marks.setMarks([distance({ measuredRevision: 1 })])
    const drawn = marks.group.children[0]
    marks.setMarks([distance({ measuredRevision: 2 })])
    expect(marks.group.children[0]).toBe(drawn)
    marks.setMarks([distance({ measuredRevision: 3, value: 7, points: [[5, 3, 4], [5, 3, -3]] })])
    expect(marks.group.children[0]).not.toBe(drawn)
  })
})

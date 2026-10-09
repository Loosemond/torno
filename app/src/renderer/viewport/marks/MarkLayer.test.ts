import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { DimensionMark, Mark, PickMark, PinMark, ShapeMark, Vec3 } from '../../../shared/marks'
import { MarkLayer, markOffset } from './MarkLayer'

const CAMERA = { position: [100, -100, 80] as Vec3, target: [0, 0, 10] as Vec3, up: [0, 0, 1] as Vec3, ortho: false, fov: 35, zoom: 1 }
const BASE = { author: 'user', note: '', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: 1, camera: CAMERA, createdAt: '2026-10-09T10:00:00.000Z' } as const
const COLOURS = { user: '#cf3f2c', agent: '#2b8a5c', reference: '#6c7178' }

const onBase: PinMark = { ...BASE, id: 'M1', kind: 'pin', anchor: { point: [1, 2, 2.5], normal: [0, 0, 1], part: 'base', ref: 'base/F4' } }
const onPost: PickMark = { ...BASE, id: 'M2', kind: 'pick', target: 'face', anchor: { point: [4, 0, 12], part: 'post', ref: 'post/F0' } }
const inSpace: ShapeMark = { ...BASE, id: 'M3', kind: 'shape', shape: 'box', intent: 'add', position: [50, 0, 0], rotation: [0, 0, 0, 1], size: [5, 5, 5] }
const elsewhere: PinMark = { ...onBase, id: 'M4', layout: 'print' }
const MARKS: Mark[] = [onBase, onPost, inSpace, elsewhere]

function layer(): { marks: MarkLayer; drawn: () => string[]; labelled: (hidden?: ReadonlySet<string>) => string[] } {
  const marks = new MarkLayer(COLOURS)
  marks.setMarks(MARKS)
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 1000)
  camera.position.set(100, -100, 80)
  camera.lookAt(0, 0, 10)
  camera.updateMatrixWorld()
  const chip = (text: string) => ({ w: 8 * text.length, h: 16 })
  return {
    marks,
    drawn: () => marks.group.children.filter((object) => object.visible).map((object) => object.name).sort(),
    labelled: (hidden) => marks.labels('assembly', camera, { width: 800, height: 600 }, 1, chip, hidden).map((label) => label.id)
  }
}

describe('the marks of a part that is switched off', () => {
  it('are not drawn, nor labelled, nor tinted, nor counted in what is to be seen; a mark on no part always is', () => {
    const { marks, drawn, labelled } = layer()
    marks.show('assembly')
    expect(drawn()).toEqual(['M1', 'M2', 'M3'])
    expect(labelled()).toEqual(['M1', 'M2', 'M3'])

    marks.show('assembly', new Set(['post']))
    expect(drawn()).toEqual(['M1', 'M3'])
    expect(labelled()).toEqual(['M1', 'M3'])
    expect(marks.pickRefs('assembly')).toEqual({ user: [], agent: [] })
    expect(marks.markOf('assembly', 'M2')).toBeUndefined()
    expect(marks.markOf('assembly', 'M1')).toBe(onBase)

    marks.show('assembly', new Set(['base', 'post']))
    expect(drawn()).toEqual(['M3'])
    // What there is to see reaches as far as the marks drawn, and no further.
    const alone = new MarkLayer(COLOURS)
    alone.setMarks([inSpace])
    alone.show('assembly')
    const sphere = (of: MarkLayer): THREE.Sphere => of.extend(new THREE.Sphere(new THREE.Vector3(), 0), 'assembly')
    expect(sphere(marks).radius).toBe(sphere(alone).radius)
    // Switched on again, they are back.
    marks.show('assembly')
    expect(drawn()).toEqual(['M1', 'M2', 'M3'])
    expect(marks.pickRefs('assembly')).toEqual({ user: ['post/F0'], agent: [] })
  })

  it('a picture is labelled by the parts it draws, whatever is switched off on screen', () => {
    const { marks, labelled } = layer()
    marks.show('assembly', new Set(['post']))
    expect(labelled(new Set(['base']))).toEqual(['M2', 'M3'])
    expect(labelled(new Set())).toEqual(['M1', 'M2', 'M3'])
    expect(labelled()).toEqual(['M1', 'M3'])
  })

  it('a mark made or changed while its part is off is not drawn either', () => {
    const { marks, drawn } = layer()
    marks.show('assembly', new Set(['post']))
    marks.setMarks([...MARKS, { ...onPost, id: 'M5' }, { ...onBase, id: 'M6' }])
    expect(drawn()).toEqual(['M1', 'M3', 'M6'])
  })
})

describe('what a mark is drawn as', () => {
  it('is not made again for what does not change how it looks: a note, being sent, having been reopened', () => {
    const marks = new MarkLayer(COLOURS)
    marks.setMarks([{ ...onBase, reopened: true }])
    const drawn = marks.group.children[0]
    marks.setMarks([{ ...onBase, status: 'sent', sentBefore: true, note: 'thicker', checkedRevision: 4 }])
    expect(marks.group.children[0]).toBe(drawn)
    // Somewhere else, it is.
    marks.setMarks([{ ...onBase, anchor: { ...onBase.anchor, point: [5, 5, 2.5] } }])
    expect(marks.group.children[0]).not.toBe(drawn)
  })
})

// Task 8, fix round 1: a region is of its scan in every layout.
describe('a region of a scan', () => {
  const region = { ...BASE, id: 'M9', kind: 'region', layout: 'print', scan: 'S1', triangles: 2, area: 100, local: { centroid: [1, 2, 3], bbox: { min: [0, 0, 3], max: [2, 4, 3] }, plane: { origin: [1, 2, 3], normal: [0, 0, 1], rms: 0 }, box: { centre: [1, 2, 3], axes: [[0, 1, 0], [1, 0, 0], [0, 0, 1]], half: [2, 1, 0] } } } as unknown as Mark
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 1000)
  camera.position.set(100, -100, 80)
  camera.lookAt(0, 0, 10)
  camera.updateMatrixWorld()
  const chip = (text: string) => ({ w: 8 * text.length, h: 16 })
  const scans = (drawn: Record<string, boolean>) => ({
    // Aligned in assembly, 10 mm along X; as imported anywhere else.
    placedIn: (scan: string, layout: string) => (scan in drawn ? { t: [layout === 'assembly' ? 10 : 0, 0, 0] as Vec3, q: [0, 0, 0, 1] as [number, number, number, number], s: 1 } : null),
    drawn: (scan: string) => drawn[scan] === true
  })

  it('has its number at its middle in whichever layout is shown, where its scan stands there, and none where its scan is not drawn', () => {
    const marks = new MarkLayer(COLOURS, scans({ S1: true }))
    marks.setMarks([region])
    for (const layout of ['assembly', 'print']) {
      marks.show(layout)
      expect(marks.labels(layout, camera, { width: 800, height: 600 }, 1, chip).map((label) => label.id)).toEqual(['M9'])
      expect(marks.markOf(layout, 'M9')).toBe(region)
    }
    marks.show('assembly')
    expect(marks.anchorOf(region).point).toEqual([11, 2, 3])
    marks.show('print')
    expect(marks.anchorOf(region).point).toEqual([1, 2, 3])
    // Switched off on screen; left out of a picture; gone; orphaned.
    const off = new MarkLayer(COLOURS, scans({ S1: false }))
    off.setMarks([region])
    expect(off.labels('assembly', camera, { width: 800, height: 600 }, 1, chip)).toEqual([])
    expect(marks.labels('assembly', camera, { width: 800, height: 600 }, 1, chip, new Set(['scan:S1']))).toEqual([])
    // A picture that draws a scan the screen has switched off has its regions' numbers.
    expect(off.labels('assembly', camera, { width: 800, height: 600 }, 1, chip, new Set()).map((label) => label.id)).toEqual(['M9'])
    const none = new MarkLayer(COLOURS, scans({}))
    none.setMarks([region])
    expect(none.labels('assembly', camera, { width: 800, height: 600 }, 1, chip)).toEqual([])
    marks.setMarks([{ ...region, anchorState: 'orphaned' } as Mark])
    expect(marks.labels('assembly', camera, { width: 800, height: 600 }, 1, chip)).toEqual([])
  })
})

describe('marks while the parts are drawn apart', () => {
  it('moves a mark with its part, leaves one on no part, and does not draw one whose ends moved apart', () => {
    const pin = { kind: 'pin', anchor: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
    const free = { kind: 'shape', position: [5, 5, 5] } as unknown as Mark
    const across = { kind: 'dimension', a: { point: [0, 0, 10], part: 'tray' }, b: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
    const within = { kind: 'dimension', a: { point: [0, 0, 10], part: 'lid' }, b: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
    const offsets = { lid: [0, 0, 15] as [number, number, number], tray: [0, 0, -13] as [number, number, number] }
    expect(markOffset(pin, offsets)).toEqual([0, 0, 15])
    expect(markOffset(free, offsets)).toEqual([0, 0, 0])
    expect(markOffset(within, offsets)).toEqual([0, 0, 15])
    expect(markOffset(across, offsets)).toBe('split')
    expect(markOffset(across, {})).toEqual([0, 0, 0])
    // One end on a part that moved and one on none: they moved differently too.
    expect(markOffset({ kind: 'dimension', a: { point: [0, 0, 10] }, b: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark, offsets)).toBe('split')
    // An arrow goes with what it starts on.
    expect(markOffset({ kind: 'arrow', from: { point: [0, 0, 12], part: 'lid' }, to: [0, 0, 30] } as unknown as Mark, offsets)).toEqual([0, 0, 15])
  })

  const across: DimensionMark = { ...BASE, id: 'M5', kind: 'dimension', measure: 'distance', a: { point: [0, 0, 2.5], part: 'base', ref: 'base/F4' }, b: { point: [0, 0, 12], part: 'post', ref: 'post/F0' }, value: 9.5, points: [[0, 0, 2.5], [0, 0, 12]] }
  const APART = { base: [0, 0, -30] as Vec3, post: [0, 0, 40] as Vec3 }

  it('draws each mark where its part is drawn, and its label there; back where it is when the parts are together', () => {
    const { marks } = layer()
    const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 1000)
    camera.position.set(100, -100, 80)
    camera.lookAt(0, 0, 10)
    camera.updateMatrixWorld()
    const chip = (text: string) => ({ w: 8 * text.length, h: 16 })
    const at = (id: string) => marks.group.children.find((object) => object.name === id)!.position.toArray()
    const label = (id: string) => marks.labels('assembly', camera, { width: 800, height: 600 }, 1, chip).find((one) => one.id === id)!
    const before = { M1: label('M1'), M3: label('M3') }
    marks.setOffsets(APART)
    expect([at('M1'), at('M2'), at('M3')]).toEqual([[0, 0, -30], [0, 0, 40], [0, 0, 0]])
    // Its label hangs where it is drawn: lower on the screen for a part drawn lower; the shape in space has not moved.
    expect(label('M1').y).toBeGreaterThan(before.M1.y + 20)
    expect([label('M3').x, label('M3').y]).toEqual([before.M3.x, before.M3.y])
    expect(marks.anchorOf(onBase).point).toEqual([1, 2, -27.5])
    expect(marks.offsetOf(onPost)).toEqual([0, 0, 40])
    // What a sphere round the marks must hold is where they are drawn.
    const far = marks.extend(new THREE.Sphere(new THREE.Vector3(), 1), 'assembly')
    expect(far.containsPoint(new THREE.Vector3(4, 0, 52))).toBe(true)
    // A mark made while they are apart is drawn apart too.
    marks.setMarks([...MARKS, { ...onPost, id: 'M6' }])
    expect(at('M6')).toEqual([0, 0, 40])
    marks.setOffsets({})
    expect([at('M1'), at('M2'), at('M6')]).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]])
    expect(label('M1').y).toBe(before.M1.y)
  })

  it('does not draw a dimension between two parts that moved differently, nor its label, and draws it again when they are together', () => {
    const { marks, drawn, labelled } = layer()
    marks.setMarks([...MARKS, across], 1)
    marks.show('assembly')
    expect(drawn()).toContain('M5')
    marks.setOffsets(APART)
    expect(drawn()).not.toContain('M5')
    expect(labelled()).toEqual(['M1', 'M2', 'M3'])
    expect(marks.markOf('assembly', 'M5')).toBeUndefined()
    expect(marks.split('assembly')).toEqual(['M5'])
    // Both moved alike: it is drawn, moved with them.
    marks.setOffsets({ base: [10, 0, 0], post: [10, 0, 0] })
    expect(drawn()).toContain('M5')
    expect(marks.split('assembly')).toEqual([])
    marks.setOffsets({})
    expect(drawn()).toContain('M5')
    expect(labelled()).toEqual(['M1', 'M2', 'M3', 'M5'])
  })
})

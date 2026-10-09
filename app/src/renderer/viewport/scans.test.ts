import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ScanInfo } from '../../shared/scans'
import { box, meshBin } from '../../test/scanFixtures'
import { ScanLayer } from './scans'

const scan = (id: string, more: Partial<ScanInfo> = {}): ScanInfo =>
  ({ id, name: `${id}.stl`, source: { path: `/d/${id}.stl`, bytes: 1, mtimeMs: 1, sha256: '' }, imported: { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, at: '' }, alignments: {}, sourceState: 'present', meshState: 'ok', checks: {}, ...more }) as ScanInfo
const aligned = (t: [number, number, number]) => ({ print: { transform: { t, q: [0, 0, 0, 1] as [number, number, number, number], s: 1 }, steps: ['typed' as const], frame: {}, at: '' } })

describe('ScanLayer', () => {
  it('asks for the meshes it has not got, and draws each where its layout puts it', () => {
    let drawn = 0
    const layer = new ScanLayer(() => (drawn += 1))
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]) }), scan('S2'), scan('S3', { meshState: 'missing' })], 'print')
    expect(layer.wanting()).toEqual(['S1', 'S2'])
    layer.load('S1', meshBin(box()))
    layer.load('S2', meshBin(box()))
    expect(layer.wanting()).toEqual([])
    expect(layer.state().map(({ id, loaded, aligned, transform }) => [id, loaded, aligned, transform.t])).toEqual([['S1', true, true, [100, 0, 0]], ['S2', true, false, [0, 0, 0]], ['S3', false, false, [0, 0, 0]]])
    expect(layer.box()!.max.toArray()).toEqual([120, 15, 2.5])
    // In another layout it is aligned in neither.
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]) }), scan('S2')], 'assembly')
    expect(layer.state().map((s) => s.aligned)).toEqual([false, false])
    expect(drawn).toBeGreaterThan(0)
  })

  it('switches a scan off, thins it, and lets a picture choose', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1'), scan('S2')], 'print')
    layer.load('S1', meshBin(box()))
    layer.load('S2', meshBin(box()))
    layer.setView('S2', { visible: false })
    layer.setView('S1', { opacity: 0.6 })
    expect(layer.shown()).toEqual([{ id: 'S1', visible: true, opacity: 0.6 }, { id: 'S2', visible: false, opacity: 1 }])
    const mesh = layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    expect(mesh.material).toMatchObject({ transparent: true, opacity: 0.6, depthWrite: false })
    const back = layer.showOnly(['S2'])
    expect(layer.group.children.map((g) => g.visible)).toEqual([false, true])
    back()
    expect(layer.group.children.map((g) => g.visible)).toEqual([true, false])
    expect(() => layer.showOnly(['S9'])).toThrow('no scan S9; scans: S1, S2')
    layer.showOnly(null)()
  })

  it('is clipped by the section and never capped, and lets go of a scan that is removed', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box(), new Array(32).fill(255)))
    const planes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)]
    layer.setClipping(planes)
    const mesh = layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    expect(mesh.material.clippingPlanes).toBe(planes)
    layer.setView('S1', { colour: 'plain' })
    expect((layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.clippingPlanes).toBe(planes)
    layer.set([], 'print')
    expect(layer.group.children).toHaveLength(0)
    expect(layer.box()).toBeNull()
  })
})

// Beyond the brief's tests.
describe('ScanLayer, further', () => {
  const meshOfLayer = (layer: ScanLayer, n = 0) => layer.group.children[n].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>

  it('lets go of a mesh whose record says it is another, and asks for it again', () => {
    const layer = new ScanLayer(() => {})
    const first = scan('S1')
    layer.set([first], 'print')
    layer.load('S1', meshBin(box()))
    // Told again as it was (a rename, an alignment): the mesh stays.
    layer.set([{ ...first, name: 'other' }], 'print')
    expect(layer.wanting()).toEqual([])
    // Converted to another unit: main wrote the mesh anew.
    layer.set([{ ...first, imported: { ...first.imported, unit: 'cm', at: 'later' } }], 'print')
    expect(layer.wanting()).toEqual(['S1'])
    expect(layer.group.children).toHaveLength(0)
    layer.load('S1', meshBin(box([400, 300, 50])))
    expect(layer.box()!.max.toArray()).toEqual([200, 150, 25])
    // Kept in another file from now on: the same.
    layer.set([{ ...first, imported: { ...first.imported, unit: 'cm', at: 'later', mesh: 'mesh-2.bin' } as ScanInfo['imported'] }], 'print')
    expect(layer.wanting()).toEqual(['S1'])
    // Gone from the disk: nothing is drawn of it, and nothing is asked for.
    layer.load('S1', meshBin(box()))
    layer.set([{ ...first, meshState: 'missing' }], 'print')
    expect(layer.wanting()).toEqual([])
    expect(layer.state()[0]).toMatchObject({ loaded: false })
  })

  it('takes no mesh for a scan that is not there, nor a second for one that has its own', () => {
    const layer = new ScanLayer(() => {})
    layer.load('S1', meshBin(box()))
    expect(layer.group.children).toHaveLength(0)
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box()))
    const had = meshOfLayer(layer)
    layer.load('S1', meshBin(box([1, 1, 1])))
    expect(meshOfLayer(layer)).toBe(had)
    expect(() => new ScanLayer(() => {}).showOnly(['S1'])).toThrow('no scan S1; scans: none')
  })

  it('stands in a picture of another layout where that layout puts it, and where the screen has it again after', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]) })], 'assembly')
    layer.load('S1', meshBin(box()))
    expect(layer.box()!.max.x).toBe(20)
    const back = layer.showOnly(['S1'], 'print')
    expect(layer.box()!.max.x).toBe(120)
    back()
    expect(layer.box()!.max.x).toBe(20)
  })

  it('is drawn solid from 95 %, never thinner than 5 %, and plain when it has no colours of its own', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box()))
    layer.setView('S1', { opacity: 0.97, colour: 'own' })
    expect(meshOfLayer(layer).material).toMatchObject({ type: 'MeshStandardMaterial', transparent: false, depthWrite: true })
    layer.setView('S1', { opacity: 0 })
    expect(layer.state()[0].opacity).toBe(0.05)
    expect(meshOfLayer(layer).material).toMatchObject({ transparent: true, opacity: 0.05 })
  })

  it('fades with the parts while they are stale, towards the background, in either way of drawing it', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box(), new Array(32).fill(255)))
    const own = meshOfLayer(layer).material as THREE.MeshBasicMaterial
    layer.setLook({ plain: '#B4AFA5', surface: '#F1EFEA' }, false)
    expect(own.userData.fade.by.value).toBe(0)
    layer.setLook({ plain: '#B4AFA5', surface: '#F1EFEA' }, true)
    expect(own.userData.fade).toMatchObject({ by: { value: 0.6 } })
    expect(`#${(own.userData.fade.to.value as THREE.Color).getHexString()}`).toBe('#f1efea')
    layer.setView('S1', { colour: 'plain' })
    expect(`#${(meshOfLayer(layer).material as THREE.MeshStandardMaterial).color.getHexString()}`).toBe('#d9d5ce')
  })
})

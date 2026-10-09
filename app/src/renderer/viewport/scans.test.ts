import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ScanInfo } from '../../shared/scans'
import { box, meshBin } from '../../test/scanFixtures'
import { ScanLayer, reaching } from './scans'

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
    // Changed in fix round 1 (I1): what is drawn of a scan says whether it is aligned in the layout drawn.
    expect(layer.shown()).toEqual([{ id: 'S1', visible: true, opacity: 0.6, aligned: false, stale: null }, { id: 'S2', visible: false, opacity: 1, aligned: false, stale: null }])
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

// Fix round 1.
describe('ScanLayer, what it says and what it lets go of', () => {
  it('says of each scan it draws whether it is aligned in the layout drawn, and why that may no longer hold', () => {
    const layer = new ScanLayer(() => {})
    const check = { revision: 7, of: 3, off: 1, worst: 12.345, moved: [] }
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]), checks: { print: check } }), scan('S2', { alignments: aligned([0, 0, 0]) })], 'assembly')
    layer.load('S1', meshBin(box()))
    layer.load('S2', meshBin(box()))
    expect(layer.shown().map(({ id, aligned, stale }) => [id, aligned, stale])).toEqual([['S1', false, null], ['S2', false, null]])
    // In a picture of the layout it is aligned in, it is: and of S1 the last build's check says the model moved.
    const back = layer.showOnly(['S1', 'S2'], 'print')
    expect(layer.shown().map(({ id, aligned, stale }) => [id, aligned, stale])).toEqual([
      ['S1', true, 'the model is no longer under 1 of its 3 points (worst 12.35 mm off) on r7: check the alignment'],
      ['S2', true, null]
    ])
    back()
    expect(layer.shown().every((s) => !s.aligned)).toBe(true)
    expect(layer.state().map((s) => s.loaded)).toEqual([true, true])
  })

  it('frees the geometry and both materials of a scan that is removed, converted or left with the object', () => {
    const layer = new ScanLayer(() => {})
    const freed: string[] = []
    const watch = (n: number, name: string): void => {
      const mesh = layer.group.children[n].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
      mesh.geometry.addEventListener('dispose', () => freed.push(`${name} geometry`))
      mesh.material.addEventListener('dispose', () => freed.push(`${name} ${mesh.material.type}`))
    }
    layer.set([scan('S1'), scan('S2'), scan('S3')], 'print')
    for (const id of ['S1', 'S2', 'S3']) layer.load(id, meshBin(box()))
    for (const n of [0, 1, 2]) watch(n, `S${n + 1}`)
    layer.set([scan('S1'), { ...scan('S2'), imported: { ...scan('S2').imported, at: 'later' } }], 'print')
    expect(freed.sort()).toEqual(['S2 MeshStandardMaterial', 'S2 geometry', 'S3 MeshStandardMaterial', 'S3 geometry'])
    layer.dispose()
    expect(freed).toContain('S1 geometry')
    expect(layer.group.children).toHaveLength(0)
  })

  it('has no cut face: cut by a section it is one mesh still, which writes nothing to the stencil the caps are counted in', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box(), new Array(32).fill(255)))
    layer.setClipping([new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)])
    const drawn: THREE.Object3D[] = []
    layer.group.traverse((o) => void ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine ? drawn.push(o) : null))
    expect(drawn).toHaveLength(1)
    for (const colour of ['own', 'plain'] as const) {
      layer.setView('S1', { colour })
      expect((drawn[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material).toMatchObject({ stencilWrite: false, clipIntersection: false })
    }
  })
})

describe('how far the camera reaches for the scans', () => {
  const parts = new THREE.Sphere(new THREE.Vector3(0, 0, 10), 50)
  const boxAt = (x: number, half: number) => new THREE.Box3(new THREE.Vector3(x - half, -half, -half), new THREE.Vector3(x + half, half, half))

  it('is all of a scan that stands round the parts or some way off, and nothing more with no scan', () => {
    expect(reaching(parts.clone(), null, parts)).toEqual(parts)
    const room = reaching(parts.clone(), boxAt(0, 1250), parts)
    expect(room.distanceToPoint(new THREE.Vector3(1250, 1250, 1250))).toBeLessThanOrEqual(1e-6)
    expect(reaching(parts.clone(), boxAt(900, 10), parts).distanceToPoint(new THREE.Vector3(910, 10, 10))).toBeLessThanOrEqual(1e-6)
  })

  it('is no further than 200 times the size of the parts: a scan read a thousand times too large does not take the near plane past them', () => {
    const far = reaching(parts.clone(), boxAt(0, 1_250_000), parts)
    expect(far.radius).toBe(10_000)
    expect(far.center.toArray()).toEqual([0, 0, 10])
    // What else is drawn (marks, the plane of a section) is never left out for it.
    const wide = new THREE.Sphere(new THREE.Vector3(), 20_000)
    expect(reaching(wide.clone(), boxAt(0, 1_250_000), parts).radius).toBeGreaterThanOrEqual(20_000)
  })
})

describe('a scan in its own colours on a dark background', () => {
  it('is drawn at half its light, so that a white wall is not the brightest thing on screen; on a light one, as it is', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box(), new Array(32).fill(255)))
    const own = (layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material
    layer.setLook({ plain: '#5A5E64', surface: '#1A1C1F' }, false)
    expect(own.userData.fade.light.value).toBe(0.5)
    layer.setLook({ plain: '#B4AFA5', surface: '#F1EFEA' }, false)
    expect(own.userData.fade.light.value).toBe(1)
  })
})

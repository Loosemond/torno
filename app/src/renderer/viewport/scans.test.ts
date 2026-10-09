import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ScanInfo } from '../../shared/scans'
import { MeshBVH } from 'three-mesh-bvh'
import { box, grid, meshBin } from '../../test/scanFixtures'
import { SCAN_OFFSET_FACTOR } from './scanMesh'
import { SCAN_BEHIND_MM, ScanLayer, drawnBehind, reaching, type TreeBuilder } from './scans'

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
    expect(layer.shown()).toEqual([{ id: 'S1', visible: true, opacity: 0.6, aligned: false, stale: null, rough: null, basis: null, note: null }, { id: 'S2', visible: false, opacity: 1, aligned: false, stale: null, rough: null, basis: null, note: null }])
    const mesh = layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    expect(mesh.material).toMatchObject({ transparent: true, opacity: 0.6, depthWrite: false })
    const back = layer.showOnly(['S2'])
    expect(layer.group.children.map((g) => g.visible)).toEqual([false, true])
    back()
    expect(layer.group.children.map((g) => g.visible)).toEqual([true, false])
    expect(() => layer.showOnly(['S9'])).toThrow('no scan S9; scans: S1, S2')
    layer.showOnly(null)()
  })

  it('draws a scan in colours of its own for one picture, over its own positions, and puts it back as it was', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1'), scan('S2')], 'print')
    // With colours of its own: those are a shader's, and are not what the picture is drawn through.
    layer.load('S1', meshBin(box(), Array.from({ length: 32 }, () => 200)))
    layer.setView('S1', { opacity: 0.4 })
    const plane = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]
    layer.setClipping(plane)
    const group = layer.group.children[0]
    const own = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    const was = { material: own.material, colour: own.geometry.getAttribute('color'), position: own.geometry.getAttribute('position'), index: own.geometry.index }
    const colours = new Uint16Array(24).fill(65535)
    layer.colourFor('S1', colours)
    expect(group.children).toHaveLength(2)
    const coloured = group.children[1] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
    expect(own.visible).toBe(false)
    expect(coloured.geometry.getAttribute('position')).toBe(was.position)
    expect(coloured.geometry.index).toBe(was.index)
    expect(coloured.geometry.getAttribute('color').array).toBe(colours)
    // Drawn as the colours are, whatever the scan's own look: unlit, solid, untouched by tone or by the scan's shader, and cut as the scan is.
    expect(coloured.material).toMatchObject({ vertexColors: true, transparent: false, opacity: 1, toneMapped: false, side: THREE.DoubleSide, clippingPlanes: plane })
    expect(coloured.material.onBeforeCompile).toBe(new THREE.MeshBasicMaterial().onBeforeCompile)
    expect(coloured.material).not.toBe(was.material)
    layer.colourFor('S1', null)
    expect(group.children).toEqual([own])
    expect(own.visible).toBe(true)
    expect(own.material).toBe(was.material)
    // The scan's own geometry is whole: what the picture borrowed was not freed with what it made.
    expect(own.geometry.getAttribute('color')).toBe(was.colour)
    expect(own.geometry.getAttribute('position')).toBe(was.position)
    expect(own.geometry.index).toBe(was.index)
    expect(coloured.geometry.getAttribute('position')).toBeUndefined()
    expect(() => layer.colourFor('S2', colours)).toThrow("S2's mesh has not come to the window yet: look again in a moment")
    expect(() => layer.colourFor('S9', colours)).toThrow('no scan S9; scans: S1, S2')
    expect(() => layer.colourFor('S1', new Uint16Array(3))).toThrow('S1 has 8 vertices, and 1 colours were given')
    layer.colourFor('S1', null)
    expect(layer.built('S1')?.vertices).toBe(8)
    expect(layer.built('S2')).toBeNull()
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

describe('pointing at a scan', () => {
  const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  async function layerWith(alignments = {}): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { alignments })], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    await layer.whenReady('S1')
    return layer
  }

  it('cannot be picked until its tree is there, and then says the triangle by its number in the file', async () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    expect(layer.state()[0].ready).toBe(false)
    expect(layer.pick(down(5, 1), null)).toBeNull()
    await layer.whenReady('S1')
    expect(layer.tree('S1')!.how).toBe('main')
    const hit = layer.pick(down(5, 1), null)!
    // The top of the box is triangles 10 and 11 of the file: (1, 5, 7) and (1, 7, 3).
    expect(hit).toMatchObject({ scan: 'S1', triangle: 10, point: [5, 1, 2.5], local: [5, 1, 2.5], normal: [0, 0, 1], distance: 97.5 })
    expect(layer.pick(down(50, 0), null)).toBeNull()
  })

  it('answers in the object frame where the scan stands, and in its own', async () => {
    const layer = await layerWith(aligned([100, 0, 10]))
    const hit = layer.pick(down(105, 1), null)!
    expect(hit.point).toEqual([105, 1, 12.5])
    expect(hit.local).toEqual([5, 1, 2.5])
  })

  it('sees what the section leaves, not what it takes away, and nothing of a scan that is switched off', async () => {
    const layer = await layerWith()
    // Keeps z <= 0: the top of the box is gone, and the ray meets its underside from inside.
    const keeps = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    const hit = layer.pick(down(5, 1), keeps)!
    expect(hit.point).toEqual([5, 1, -2.5])
    // Seen from above through the open top: the normal told looks at the eye.
    expect(hit.normal).toEqual([0, 0, 1])
    layer.setView('S1', { visible: false })
    expect(layer.pick(down(5, 1), null)).toBeNull()
  })
})

// Beyond the brief's tests.
describe('pointing at a scan, further', () => {
  const down = (x: number, y: number, from = 100): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, from), new THREE.Vector3(0, 0, -1))
  async function layerOf(...scans: ScanInfo[]): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set(scans, 'print')
    for (const { id } of scans) layer.load(id, meshBin(box([40, 30, 5])))
    await Promise.all(scans.map(({ id }) => layer.whenReady(id)))
    return layer
  }

  it('says how far along the ray, in millimetres of the object, of a scan that was scaled and turned', async () => {
    // Twice the size, a quarter turn about +Z, lifted by 10: the box is 60 × 80 × 10, its top at z = 15.
    const half = Math.SQRT1_2
    const layer = await layerOf(scan('S1', { alignments: { print: { transform: { t: [0, 0, 10], q: [0, 0, half, half], s: 2 }, steps: ['typed'], frame: {}, at: '' } } } as Partial<ScanInfo>))
    const hit = layer.pick(down(-2, 10), null)!
    expect(hit.point).toEqual([-2, 10, 15])
    expect(hit.distance).toBe(85)
    expect(hit.local).toEqual([5, 1, 2.5])
    expect(hit.normal).toEqual([0, 0, 1])
    expect(hit.triangle).toBe(10)
  })

  it('answers with the nearest of several, and with none further than asked', async () => {
    const layer = await layerOf(scan('S1'), scan('S2', { alignments: aligned([0, 0, 20]) }))
    expect(layer.pick(down(5, 1), null)).toMatchObject({ scan: 'S2', point: [5, 1, 22.5] })
    // Not as far as S2: what is in front of something 70 mm along the ray.
    expect(layer.pick(down(5, 1), null, 70)).toBeNull()
    expect(layer.pick(down(5, 1), null, 80)).toMatchObject({ scan: 'S2' })
    // A picture that leaves S2 out does not have it in the way.
    const back = layer.showOnly(['S1'])
    expect(layer.pick(down(5, 1), null)).toMatchObject({ scan: 'S1' })
    back()
    // From inside S2, looking down: its underside, whose normal is told towards the eye.
    expect(layer.pick(down(5, 1, 20), null)).toMatchObject({ scan: 'S2', point: [5, 1, 17.5], normal: [0, 0, 1], distance: 2.5 })
  })

  it('asked for what is drawn solid only, passes through a scan drawn thin, whichever is in front', async () => {
    // S2 is above S1. Thin, it is in nobody's way: the solid one behind it is what stands in front of a part.
    const layer = await layerOf(scan('S1'), scan('S2', { alignments: aligned([0, 0, 20]) }))
    layer.setView('S2', { opacity: 0.3 })
    expect(layer.pick(down(5, 1), null)).toMatchObject({ scan: 'S2' })
    expect(layer.pick(down(5, 1), null, Infinity, true)).toMatchObject({ scan: 'S1', point: [5, 1, 2.5] })
    layer.setView('S1', { opacity: 0.94 })
    expect(layer.pick(down(5, 1), null, Infinity, true)).toBeNull()
    layer.setView('S1', { opacity: 0.95 })
    expect(layer.pick(down(5, 1), null, Infinity, true)).toMatchObject({ scan: 'S1' })
  })

  it('has no tree for a mesh that was let go of while its tree was made, and keeps no one waiting', async () => {
    const layer = new ScanLayer(() => {})
    const first = scan('S1')
    layer.set([first], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    const waited = layer.whenReady('S1')
    // Converted meanwhile: the mesh built is no longer the scan's.
    layer.set([{ ...first, imported: { ...first.imported, unit: 'cm', at: 'later' } }], 'print')
    await waited
    expect(layer.tree('S1')).toBeNull()
    expect(layer.state()[0].ready).toBe(false)
    // The new mesh gets a tree of its own, and the one made for the old mesh is not taken for it.
    layer.load('S1', meshBin(box([400, 300, 50])))
    await layer.whenReady('S1')
    expect(layer.pick(down(150, 100), null)).toMatchObject({ scan: 'S1', point: [150, 100, 25] })
    // Removed: nothing to point at, and nothing to wait for.
    layer.set([], 'print')
    await layer.whenReady('S1')
    expect(layer.pick(down(5, 1), null)).toBeNull()
    expect(layer.tree('S1')).toBeNull()
  })

  it('is ready, and drawn again, when its tree has come', async () => {
    let drawn = 0
    const layer = new ScanLayer(() => (drawn += 1))
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    const before = drawn
    await layer.whenReady('S1')
    expect(layer.state()[0].ready).toBe(true)
    expect(layer.tree('S1')!.built.id).toBe('S1')
    expect(drawn).toBe(before + 1)
  })
})

// Task 5, and what Task 4's review asked for.
describe('a scan in front of a part', () => {
  const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  const PX = (): number => 0.1
  async function layerOf(...scans: ScanInfo[]): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set(scans, 'print')
    for (const { id } of scans) layer.load(id, meshBin(box([40, 30, 5])))
    await Promise.all(scans.map(({ id }) => layer.whenReady(id)))
    return layer
  }

  it('takes the pick when it is drawn solid, and never when it is seen through', async () => {
    // The top of the scan is 97.5 mm along the ray; a part 110 mm along it is behind the scan.
    const layer = await layerOf(scan('S1'))
    expect(layer.blocks(down(5, 1), null, 110, PX)).toBe(true)
    // The part in front of the scan, and where the scan is not.
    expect(layer.blocks(down(5, 1), null, 90, PX)).toBe(false)
    expect(layer.blocks(down(50, 1), null, 110, PX)).toBe(false)
    layer.setView('S1', { opacity: 0.9 })
    expect(layer.blocks(down(5, 1), null, 110, PX)).toBe(false)
    layer.setView('S1', { opacity: 1, visible: false })
    expect(layer.blocks(down(5, 1), null, 110, PX)).toBe(false)
  })

  it('does not when the part lies in its surface: the scan is drawn pushed back, so the part is what is seen', async () => {
    const layer = await layerOf(scan('S1'))
    expect(layer.blocks(down(5, 1), null, 97.5, PX)).toBe(false)
    expect(layer.blocks(down(5, 1), null, 97.5 + SCAN_BEHIND_MM / 2, PX)).toBe(false)
    expect(layer.blocks(down(5, 1), null, 97.6, PX)).toBe(true)
  })

  it('nor, seen at a slant, when the scan is in front by less than it is pushed back there', async () => {
    // Head on, the scan is pushed back by next to nothing; at a slant, by two pixels' worth of its slope.
    expect(drawnBehind([0, 0, 1], [0, 0, -1], 0.1)).toBeCloseTo(SCAN_BEHIND_MM, 12)
    const slant = Math.tan(Math.PI / 3)
    expect(drawnBehind([0, 0, 1], [Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3)], 0.1)).toBeCloseTo(SCAN_BEHIND_MM + SCAN_OFFSET_FACTOR * 0.1 * slant, 9)
    // Along the surface there is no telling: it never takes the pick there.
    expect(drawnBehind([0, 0, 1], [1, 0, 0], 0.1)).toBeGreaterThan(1e3)
    // A ray 80° off the normal of the scan's top, which it meets at (0, 0, 2.5): a part 0.5 mm further along is drawn in front of it.
    const layer = await layerOf(scan('S1'))
    const angle = (80 * Math.PI) / 180
    const direction = new THREE.Vector3(Math.sin(angle), 0, -Math.cos(angle))
    const ray = new THREE.Ray(new THREE.Vector3(0, 0, 2.5).addScaledVector(direction, -100), direction)
    expect(layer.pick(ray, null)!.distance).toBeCloseTo(100, 6)
    expect(layer.blocks(ray, null, 100.5, PX)).toBe(false)
    expect(layer.blocks(ray, null, 103, PX)).toBe(true)
    // Head on, half a millimetre is plenty.
    expect(layer.blocks(down(5, 1), null, 98, PX)).toBe(true)
  })
})

describe('waiting for a scan’s tree', () => {
  /** A builder whose trees are made when the test says, each by the mesh it was asked for. */
  function builder(): { build: TreeBuilder; asked: Array<{ geometry: THREE.BufferGeometry; signal: AbortSignal; finish(ok: boolean): Promise<void> }> } {
    const asked: ReturnType<typeof builder>['asked'] = []
    const build: TreeBuilder = (geometry, signal) =>
      new Promise((resolve, reject) => {
        asked.push({
          geometry,
          signal,
          finish: async (ok) => {
            if (ok) resolve({ tree: new MeshBVH(geometry, { indirect: true }), how: 'main' })
            else reject(new Error('no tree'))
            await Promise.resolve()
            await Promise.resolve()
          }
        })
      })
    return { build, asked }
  }
  const waiting = (promise: Promise<void>): (() => boolean) => {
    let done = false
    void promise.then(() => (done = true))
    return () => done
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('is over at once for a scan whose mesh cannot come', async () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { meshState: 'missing' })], 'print')
    await layer.whenReady('S1')
    expect(layer.state()[0].ready).toBe(false)
  })

  it('is not ended by the failure of a tree for a mesh that was replaced meanwhile', async () => {
    const { build, asked } = builder()
    const layer = new ScanLayer(() => {}, build)
    const first = scan('S1')
    layer.set([first], 'print')
    layer.load('S1', meshBin(box()))
    // Converted: another mesh, with a tree of its own to wait for.
    layer.set([{ ...first, imported: { ...first.imported, at: 'later' } }], 'print')
    layer.load('S1', meshBin(box()))
    const ready = waiting(layer.whenReady('S1'))
    await asked[0].finish(false)
    await settle()
    expect(ready()).toBe(false)
    await asked[1].finish(true)
    await settle()
    expect(ready()).toBe(true)
    expect(layer.state()[0].ready).toBe(true)
  })

  it('tells whoever makes the tree when the mesh is let go of, so that nothing more is built for it', () => {
    const { build, asked } = builder()
    const layer = new ScanLayer(() => {}, build)
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box()))
    expect(asked[0].signal.aborted).toBe(false)
    layer.set([], 'print')
    expect(asked[0].signal.aborted).toBe(true)
  })
})

describe('a scan drawn somewhere else for now', () => {
  const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  const THERE = { t: [100, 0, 10] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], s: 1 }
  async function layerWith(alignments = {}): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { alignments })], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    await layer.whenReady('S1')
    return layer
  }

  it('is drawn and pointed at there, and where main has it again afterwards', async () => {
    let drawn = 0
    const layer = new ScanLayer(() => (drawn += 1))
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    await layer.whenReady('S1')
    const before = drawn
    layer.preview('S1', THERE)
    expect(drawn).toBe(before + 1)
    expect(layer.state()[0]).toMatchObject({ aligned: false, transform: THERE })
    expect(layer.placed('S1')).toEqual(THERE)
    expect(layer.pick(down(105, 1), null)).toMatchObject({ point: [105, 1, 12.5], local: [5, 1, 2.5] })
    expect(layer.box()!.max.toArray()).toEqual([120, 15, 12.5])
    layer.preview('S1', null)
    expect(layer.state()[0].transform.t).toEqual([0, 0, 0])
    expect(layer.pick(down(105, 1), null)).toBeNull()
    expect(layer.placed('S9')).toBeNull()
  })

  it('is in no picture: a picture draws it where main has it', async () => {
    const layer = await layerWith()
    layer.preview('S1', THERE)
    const back = layer.showOnly(['S1'])
    expect(layer.group.children[0].position.toArray()).toEqual([0, 0, 0])
    back()
    expect(layer.group.children[0].position.toArray()).toEqual([100, 0, 10])
  })

  it('says of an aligned scan that it is rough, when it is', async () => {
    const layer = await layerWith({ print: { ...aligned([0, 0, 0]).print, rough: 'it has 2 pairs of points' } })
    expect(layer.shown()[0]).toMatchObject({ aligned: true, rough: 'it has 2 pairs of points' })
    // Fix round 1: what it rests on, what no build can say of it, and that it was not checked against the build on show.
    expect(layer.shown()[0]).toMatchObject({ basis: 'by hand', note: 'tied to no point of the model: not checked against builds', stale: null })
    layer.set([scan('S1', { alignments: aligned([0, 0, 0]) })], 'print', 13)
    expect(layer.shown()[0].stale).toBe('it was not checked against r13')
    layer.set([scan('S1', { alignments: aligned([0, 0, 0]), checks: { print: { revision: 13, of: 0, off: 0, worst: 0, moved: [] } } })], 'print')
    expect(layer.shown()[0].stale).toBeNull()
    const changed = await layerWith({ print: { ...aligned([0, 0, 0]).print, sourceChanged: true } })
    expect(changed.shown()[0].stale).toBe('the scan was imported again from a source that had changed since it was aligned: check the alignment')
  })
})

describe('a patch of a scan', () => {
  const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  async function sheet(alignments = {}): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { alignments })], 'print')
    // A sheet 19 mm square of 1 mm cells with a step: flat at z = 0, and 5 mm up from x = 5 on.
    layer.load('S1', meshBin(grid(20, 1, (x) => (x > 5 ? 5 : 0))))
    await layer.whenReady('S1')
    return layer
  }

  it('is the triangles round a point of it that face as the one hit does, by their middles and their areas', async () => {
    const layer = await sheet()
    const hit = layer.pick(down(0.2, 0.2), null)!
    const patch = layer.patch(hit, 3)!
    // Every triangle of a 1 mm grid has half a square millimetre, and all of these lie flat at z = 0.
    expect(patch.points.length).toBeGreaterThan(40)
    expect(patch.points.length).toBe(patch.weights.length)
    expect(patch.weights.every((w) => Math.abs(w - 0.5) < 1e-6)).toBe(true)
    expect(patch.points.every((p) => Math.hypot(p[0] - 0.2, p[1] - 0.2) <= 3 && Math.abs(p[2]) < 1e-6)).toBe(true)
    // About π r² of it.
    expect(patch.weights.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.85 * Math.PI * 9)
    // A patch that reaches the step leaves out the riser, which faces another way, and takes the flat beyond it.
    const wide = layer.patch(hit, 8)!
    expect(wide.points.some((p) => p[2] > 4.9)).toBe(true)
    expect(wide.points.some((p) => p[2] > 0.1 && p[2] < 4.9)).toBe(false)
    expect(layer.patch(null, 3)).toBeNull()
  })

  it('is said in the object frame of a scan that was moved and scaled, with its radius in millimetres there', async () => {
    const layer = await sheet({ print: { transform: { t: [100, 0, 10], q: [0, 0, 0, 1], s: 2 }, steps: ['typed'], frame: {}, at: '' } })
    const hit = layer.pick(down(100.4, 0.4), null)!
    const patch = layer.patch(hit, 6)!
    expect(patch.weights.every((w) => Math.abs(w - 2) < 1e-6)).toBe(true)
    expect(patch.points.every((p) => Math.hypot(p[0] - 100.4, p[1] - 0.4) <= 6 && Math.abs(p[2] - 10) < 1e-6)).toBe(true)
    expect(patch.weights.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.85 * Math.PI * 36)
  })

  it('is tinted over the scan while asked, with nothing copied of the scan, and in no picture', async () => {
    const layer = await sheet()
    const hit = layer.pick(down(0.2, 0.2), null)!
    const group = layer.group.children[0]
    expect(group.children).toHaveLength(1)
    const patch = layer.patch(hit, 3, { tint: true })!
    expect(group.children).toHaveLength(2)
    const [mesh, tint] = group.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]
    expect(tint.geometry.getAttribute('position')).toBe(mesh.geometry.getAttribute('position'))
    expect(tint.geometry.drawRange.count).toBe(3 * patch.points.length)
    expect(tint.material).toMatchObject({ transparent: true, opacity: 0.35, depthWrite: false })
    const back = layer.showOnly(['S1'])
    expect(tint.visible).toBe(false)
    back()
    expect(tint.visible).toBe(true)
    // Asked without a tint, or for nothing: the tint goes.
    layer.patch(hit, 3)
    expect(group.children).toHaveLength(1)
    layer.patch(hit, 3, { tint: true })
    layer.patch(null, 0)
    expect(group.children).toHaveLength(1)
  })
})

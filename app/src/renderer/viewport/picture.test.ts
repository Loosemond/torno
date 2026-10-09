import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Part } from '../../shared/scene'
import { asPictured, pictureSize, type PictureHost, type PicturePart, type PictureState } from './picture'

describe('the size of a picture', () => {
  it('is 1280 on its long edge when none is asked for, or what is asked for is no number', () => {
    expect(pictureSize(undefined, 4 / 3)).toEqual({ width: 1280, height: 960 })
    expect(pictureSize(Number.NaN, 4 / 3)).toEqual({ width: 1280, height: 960 })
    expect(pictureSize(Infinity, 4 / 3)).toEqual({ width: 1280, height: 960 })
  })

  it('is kept within 64 and 2000 pixels on its long edge', () => {
    expect(pictureSize(5000, 4 / 3)).toEqual({ width: 2000, height: 1500 })
    expect(pictureSize(10, 4 / 3)).toEqual({ width: 64, height: 48 })
    expect(pictureSize(-1, 1)).toEqual({ width: 64, height: 64 })
    expect(pictureSize(800.4, 2)).toEqual({ width: 800, height: 400 })
  })

  it('has its long edge upright for a canvas taller than wide, and no edge under a pixel', () => {
    expect(pictureSize(1000, 0.5)).toEqual({ width: 500, height: 1000 })
    expect(pictureSize(64, 1000)).toEqual({ width: 64, height: 1 })
    expect(pictureSize(64, 0.001)).toEqual({ width: 1, height: 64 })
  })
})

/** A viewport showing `assembly`, with one of its two parts switched off, that writes down what is asked of it. */
function viewport(): { host: PictureHost; log: string[]; parts: PicturePart[]; visible: () => boolean[]; ground: THREE.Sphere } {
  const log: string[] = []
  const part = (layout: string, name: string, visible: boolean): PicturePart => ({ part: { key: `${layout}:${name}`, layout, name } as Part, built: { group: { visible } } })
  const parts = [part('assembly', 'base', true), part('assembly', 'post', false), part('print', 'base', false)]
  const ground = new THREE.Sphere(new THREE.Vector3(), 10)
  let active: string | null = 'M2'
  const renderer = {
    getViewport: (into: THREE.Vector4) => into.set(0, 0, 800, 600),
    setViewport: (x: THREE.Vector4 | number, _y?: number, width?: number, height?: number) => log.push(typeof x === 'number' ? `viewport ${width}×${height}` : `viewport ${x.z}×${x.w}`),
    setRenderTarget: (target: unknown) => log.push(`target ${String(target)}`)
  }
  const host: PictureHost = {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    marks: {
      get activeId() {
        return active
      },
      setActive: (id) => {
        active = id
        log.push(`active ${id}`)
      },
      show: (layout, hidden) => log.push(`marks ${layout} but on ${[...(hidden ?? [])].join(',') || 'none'}`),
      showDraft: (shown) => log.push(`draft ${shown ? 'on' : 'off'}`),
      extend: (sphere, layout) => {
        log.push(`extend ${layout}`)
        sphere.radius += 5
        return sphere
      },
      update: () => {},
      labels: () => []
    },
    highlights: { setVisible: (visible, layers) => log.push(`highlights ${visible ? 'on' : 'off'}${layers ? ` ${layers.join(',')}` : ''}`) },
    closed: () => false,
    layouts: () => ['assembly', 'print'],
    layout: () => 'assembly',
    aspect: () => 4 / 3,
    parts: () => parts,
    currentView: () => ({ position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 }),
    namedView: () => ({ position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: true, fov: 35, zoom: 1 }),
    cameraFor: () => new THREE.OrthographicCamera(),
    hiddenParts: () => new Set(),
    hideGizmo: () => {
      log.push('gizmo off')
      return () => log.push('gizmo on')
    },
    layGround: (layout) => {
      log.push(`ground ${layout}`)
      return layout === 'assembly' ? ground : new THREE.Sphere(new THREE.Vector3(), 20)
    },
    groundExtent: () => ground,
    tintPicks: (layout) => log.push(`tint ${layout}`),
    showMarks: () => log.push('marks as on screen'),
    colours: () => ({ user: '#cf3f2c', agent: '#2b8a5c', paper: '#faf9f6', surface: '#f1efea', ink: '#22252a', muted: '#6c7178' })
  }
  return { host, log, parts, visible: () => parts.map((p) => p.built.group.visible), ground }
}

describe('what the scene is while a picture of it is drawn', () => {
  it('is the picture’s parts, layout and marks, with nothing of what the person points at or holds; and the screen’s again after, in this order', () => {
    const { host, log, parts, visible } = viewport()
    const state: PictureState = { layout: 'print', shown: [parts[2]], withMarks: true, notDrawn: new Set(['lid']), width: 640, height: 480 }
    const radius = asPictured(host, state, (extent) => {
      expect(visible()).toEqual([false, false, true])
      log.push('draw')
      return extent.radius
    })

    expect(radius).toBe(25) // the other layout's ground, and its marks
    expect(log).toEqual([
      'highlights off',
      'gizmo off',
      'viewport 640×480',
      'ground print',
      'active null',
      'marks print but on lid',
      'draft off',
      'extend print',
      'highlights on userMark,agentMark',
      'tint print',
      'draw',
      'viewport 800×600',
      'target null',
      'gizmo on',
      'highlights on',
      'active M2',
      'marks as on screen',
      'draft on',
      'ground assembly',
      'tint assembly'
    ])
    expect(visible()).toEqual([true, false, false])
  })

  it('leaves the ground and the tints alone for a picture of the layout on screen without its marks', () => {
    const { host, log, parts, visible, ground } = viewport()
    asPictured(host, { layout: 'assembly', shown: [parts[1]], withMarks: false, notDrawn: new Set(), width: 64, height: 48 }, (extent) => {
      expect(extent).toBe(ground)
      expect(visible()).toEqual([false, true, false])
    })

    expect(log).toEqual(['highlights off', 'gizmo off', 'viewport 64×48', 'active null', 'marks null but on none', 'draft off', 'viewport 800×600', 'target null', 'gizmo on', 'highlights on', 'active M2', 'marks as on screen', 'draft on'])
    expect(visible()).toEqual([true, false, false])
    expect(ground.radius).toBe(10) // what the marks add is added to a copy
  })

  it('puts everything back when the drawing fails', () => {
    const { host, log, parts, visible } = viewport()
    const state: PictureState = { layout: 'print', shown: [parts[2]], withMarks: true, notDrawn: new Set(), width: 640, height: 480 }
    expect(() =>
      asPictured(host, state, () => {
        throw new Error('no context')
      })
    ).toThrow('no context')

    expect(log.slice(log.indexOf('tint print') + 1)).toEqual(['viewport 800×600', 'target null', 'gizmo on', 'highlights on', 'active M2', 'marks as on screen', 'draft on', 'ground assembly', 'tint assembly'])
    expect(visible()).toEqual([true, false, false])
  })
})

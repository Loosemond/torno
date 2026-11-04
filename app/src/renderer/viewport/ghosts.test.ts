import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GHOST_FADE_MS, GHOST_HOLD_MS, GHOST_MS, type GhostItem, Ghosts, ghostLevel } from './ghosts'

const edges = (): THREE.BufferGeometry => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3))
const item = (part: string, after = true): GhostItem => ({
  part,
  layout: 'assembly',
  before: { edges: edges(), position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() },
  after: after ? { edges: edges(), position: new THREE.Vector3(0, 0, 2), quaternion: new THREE.Quaternion() } : null
})
const LOOK = { old: '#646970', fresh: '#1D46B8' }

describe('how strong the ghosts are', () => {
  it('holds, fades once, and is gone', () => {
    expect(ghostLevel(0)).toBe(1)
    expect(ghostLevel(GHOST_HOLD_MS)).toBe(1)
    expect(ghostLevel(GHOST_HOLD_MS + GHOST_FADE_MS / 2)).toBeCloseTo(0.5)
    expect(ghostLevel(GHOST_MS)).toBe(0)
    expect(ghostLevel(GHOST_MS + 1000)).toBe(0)
  })
  it('does not fade with reduced motion: held, then gone', () => {
    expect(ghostLevel(GHOST_HOLD_MS + GHOST_FADE_MS / 2, true)).toBe(1)
    expect(ghostLevel(GHOST_MS, true)).toBe(0)
  })
})

describe('the ghosts of the parts a build changed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('draw the old edges and the new for each part given, and nothing for none', () => {
    const ghosts = new Ghosts()
    ghosts.begin([], LOOK, 0)
    expect(ghosts.on).toBe(false)
    ghosts.begin([item('assembly:tub'), item('assembly:lid', false)], LOOK, 0)
    expect(ghosts.keys()).toEqual(['assembly:tub', 'assembly:lid'])
    expect(ghosts.group.children).toHaveLength(3)
    // The old edges stand where the part stood.
    expect(ghosts.group.children[0].position.z).toBe(0)
    expect(ghosts.group.children[1].position.z).toBe(2)
  })

  it('fade with the frames and are removed after the time, by themselves', () => {
    const onEnd = vi.fn()
    const ghosts = new Ghosts(onEnd)
    ghosts.begin([item('assembly:tub')], LOOK, 0)
    expect(ghosts.step(500)).toBe(true)
    const line = ghosts.group.children[0] as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    expect(line.material.opacity).toBe(1)
    expect(ghosts.step(GHOST_HOLD_MS + GHOST_FADE_MS / 2)).toBe(true)
    expect(line.material.opacity).toBeCloseTo(0.5)
    // No frame comes: the clock ends them all the same.
    vi.advanceTimersByTime(GHOST_MS + 100)
    expect(ghosts.on).toBe(false)
    expect(ghosts.group.children).toHaveLength(0)
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('end at once when asked (a key, a click), once, and free their geometry', () => {
    const onEnd = vi.fn()
    const ghosts = new Ghosts(onEnd)
    const part = item('assembly:tub')
    const disposed = vi.fn()
    part.before.edges.addEventListener('dispose', disposed)
    ghosts.begin([part], LOOK, 0)
    ghosts.end()
    ghosts.end()
    expect(ghosts.on).toBe(false)
    expect(ghosts.group.children).toHaveLength(0)
    expect(disposed).toHaveBeenCalledOnce()
    expect(onEnd).toHaveBeenCalledOnce()
    expect(ghosts.step(10)).toBe(false)
  })

  it('are hidden for a picture and shown again after it', () => {
    const ghosts = new Ghosts()
    ghosts.begin([item('assembly:tub')], LOOK, 0)
    const back = ghosts.hide()
    expect(ghosts.group.visible).toBe(false)
    back()
    expect(ghosts.group.visible).toBe(true)
  })

  it('are replaced by the next set without telling the viewport in between', () => {
    const onEnd = vi.fn()
    const ghosts = new Ghosts(onEnd)
    ghosts.begin([item('assembly:tub')], LOOK, 0)
    ghosts.begin([item('assembly:lid')], LOOK, 100)
    expect(ghosts.keys()).toEqual(['assembly:lid'])
    expect(ghosts.group.children).toHaveLength(2)
    expect(onEnd).not.toHaveBeenCalled()
  })
})

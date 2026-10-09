import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Camera } from '../../shared/view'
import type { Hit } from './picking'
import { PointerRouter, isClick, wheelZoom, type PointerHost, type ViewportPointer } from './pointer'

describe('whether a press is a click', () => {
  const press = { x: 100, y: 100, at: 1000 }

  it('is when the left button is let go within 4 pixels and 400 ms of where and when it was pressed', () => {
    expect(isClick(press, { button: 0, x: 100, y: 100, at: 1001 })).toBe(true)
    expect(isClick(press, { button: 0, x: 104, y: 100, at: 1400 })).toBe(true)
    expect(isClick(press, { button: 0, x: 103, y: 103, at: 1400 })).toBe(false) // 4.24 pixels away
    expect(isClick(press, { button: 0, x: 100, y: 105, at: 1001 })).toBe(false)
    expect(isClick(press, { button: 0, x: 100, y: 100, at: 1401 })).toBe(false)
  })

  it('is not without a press of the left button, nor for the release of another', () => {
    expect(isClick(null, { button: 0, x: 100, y: 100, at: 1001 })).toBe(false)
    expect(isClick(press, { button: 2, x: 100, y: 100, at: 1001 })).toBe(false)
  })
})

describe('how far a turn of the wheel zooms', () => {
  it('is the orbit’s step: closer for a turn away from the person, as much farther for one towards them', () => {
    expect(wheelZoom(-100, 0)).toBeCloseTo(1 / 0.95, 12)
    expect(wheelZoom(100, 0)).toBeCloseTo(0.95, 12)
    expect(wheelZoom(-100, 0) * wheelZoom(100, 0)).toBeCloseTo(1, 12)
  })

  it('takes a line for 16 pixels', () => {
    expect(wheelZoom(3, 1)).toBeCloseTo(wheelZoom(48, 0), 12)
  })
})

const HIT = { ref: 'base/F1' } as Hit
const VIEW: Camera = { position: [0, -100, 0], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

/** An event as the canvas or the window would be given it. */
function fire(target: EventTarget, type: string, init: Partial<Record<'button' | 'buttons' | 'clientX' | 'clientY' | 'timeStamp' | 'deltaY' | 'deltaMode', number>> = {}): Event {
  const event = new Event(type, { cancelable: true })
  const all = { button: 0, buttons: 0, clientX: 0, clientY: 0, timeStamp: 0, deltaY: 0, deltaMode: 0, shiftKey: false, altKey: false, ...init }
  for (const [key, value] of Object.entries(all)) Object.defineProperty(event, key, { value })
  target.dispatchEvent(event)
  return event
}

/** A router on a canvas of its own, with what it told its listener and what it asked of the viewport. */
function router(): { pointer: PointerRouter; canvas: EventTarget; orbit: { enabled: boolean }; gizmo: { dragging: boolean; onIt: boolean; enabled: boolean }; told: () => string[]; picks: () => number; views: Camera[] } {
  const canvas = new EventTarget()
  const orbit = { enabled: true }
  const gizmo = { dragging: false, onIt: false, enabled: true }
  const events: ViewportPointer[] = []
  const views: Camera[] = []
  let picks = 0
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 1000)
  const host: PointerHost = {
    canvas: canvas as HTMLCanvasElement,
    orbit,
    gizmo: {
      get dragging() {
        return gizmo.dragging
      },
      takes: () => gizmo.onIt,
      setEnabled: (enabled) => {
        gizmo.enabled = enabled
      }
    },
    camera: () => camera,
    canvasPoint: () => ({ ndc: { x: 0, y: 0 } }),
    pick: () => {
      picks++
      return HIT
    },
    syncMatrices: () => {},
    view: () => VIEW,
    setView: (c) => views.push(c)
  }
  const pointer = new PointerRouter(host)
  pointer.listen((e) => events.push(e))
  return { pointer, canvas, orbit, gizmo, told: () => events.splice(0).map((e) => `${e.type}${e.hit ? ` ${e.hit.ref}` : ''}`), picks: () => picks, views }
}

describe('the pointer over the canvas', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tells of a click after the release of a press that did not move, and of none after a drag', () => {
    const { canvas, told } = router()
    fire(canvas, 'pointerdown', { buttons: 1, clientX: 50, clientY: 50, timeStamp: 10 })
    fire(canvas, 'pointerup', { clientX: 52, clientY: 50, timeStamp: 200 })
    expect(told()).toEqual(['down base/F1', 'up base/F1', 'click base/F1'])

    fire(canvas, 'pointerdown', { buttons: 1, clientX: 50, clientY: 50, timeStamp: 300 })
    fire(canvas, 'pointerup', { clientX: 60, clientY: 50, timeStamp: 350 })
    expect(told()).toEqual(['down base/F1', 'up base/F1'])

    // The right button's press is no click, and forgets the left's.
    fire(canvas, 'pointerdown', { buttons: 1, timeStamp: 400 })
    fire(canvas, 'pointerdown', { button: 2, buttons: 3, timeStamp: 410 })
    fire(canvas, 'pointerup', { buttons: 2, timeStamp: 420 })
    expect(told()).toEqual(['down base/F1', 'down base/F1', 'up base/F1'])
  })

  it('says the pointer left as a cancel, on nothing', () => {
    const { canvas, told } = router()
    fire(canvas, 'pointerleave')
    fire(canvas, 'pointercancel')
    expect(told()).toEqual(['cancel', 'cancel'])
  })

  it('points at nothing while a drag turns the camera, and picks nothing then', () => {
    const { pointer, canvas, told, picks } = router()
    fire(canvas, 'pointermove', { buttons: 1 })
    expect(told()).toEqual(['move'])
    expect(picks()).toBe(0)

    // A tool's drag: the camera is not the pointer's.
    pointer.setNavigation(false)
    fire(canvas, 'pointermove', { buttons: 1 })
    expect(told()).toEqual(['move base/F1'])
  })

  it('keeps the camera still for the rest of a drag when a tool gives it up, and hands it back when the button is let go', () => {
    const { pointer, canvas, orbit, gizmo } = router()
    fire(canvas, 'pointerdown', { buttons: 1 })
    pointer.setNavigation(false)
    expect([orbit.enabled, gizmo.enabled]).toEqual([false, false])
    pointer.setNavigation(true)
    expect([orbit.enabled, gizmo.enabled]).toEqual([false, true])
    fire(canvas, 'pointermove', { buttons: 1 })
    expect(orbit.enabled).toBe(false)
    expect(pointer.busy).toBe(true)
    fire(canvas, 'pointerup')
    expect(orbit.enabled).toBe(true)
    expect(pointer.busy).toBe(false)

    // With no button held, it is switched at once.
    pointer.setNavigation(false)
    pointer.setNavigation(true)
    expect(orbit.enabled).toBe(true)
  })

  it('knows a button was let go beside the canvas, or the window left: only while another is still held does it stay busy', () => {
    const { pointer, canvas } = router()
    fire(canvas, 'pointerdown', { buttons: 3 })
    fire(window, 'pointerup', { buttons: 2 })
    expect(pointer.busy).toBe(true)
    fire(window, 'pointerup', { buttons: 0 })
    expect(pointer.busy).toBe(false)

    fire(canvas, 'pointerdown', { buttons: 1 })
    fire(window, 'blur')
    expect(pointer.busy).toBe(false)
  })

  it('tells the tool once that the pointer has gone to the gizmo, and nothing more until it is back', () => {
    const { canvas, gizmo, told, picks } = router()
    fire(canvas, 'pointermove')
    gizmo.onIt = true
    fire(canvas, 'pointermove')
    fire(canvas, 'pointerdown', { buttons: 1 })
    fire(canvas, 'pointerup')
    expect(told()).toEqual(['move base/F1', 'cancel'])
    expect(picks()).toBe(1)
    gizmo.onIt = false
    fire(canvas, 'pointermove')
    gizmo.onIt = true
    fire(canvas, 'pointermove')
    expect(told()).toEqual(['move base/F1', 'cancel'])
  })

  it('leaves the orbit off while the gizmo is dragged, whatever the buttons say, and gives it back as navigation was last asked', () => {
    const { pointer, canvas, orbit, gizmo } = router()
    gizmo.dragging = true
    pointer.gizmoDragging(true)
    expect(orbit.enabled).toBe(false)
    fire(canvas, 'pointermove')
    expect(orbit.enabled).toBe(false)
    expect(pointer.busy).toBe(true)
    gizmo.dragging = false
    pointer.gizmoDragging(false)
    expect(orbit.enabled).toBe(true)

    // Let go while a button is still held on the canvas: not before that is let go too.
    fire(canvas, 'pointerdown', { buttons: 1 })
    pointer.gizmoDragging(true)
    pointer.gizmoDragging(false)
    expect(orbit.enabled).toBe(false)
  })

  it('zooms by the wheel only while navigation is off and the wheel was kept', () => {
    const { pointer, canvas, views } = router()
    expect(fire(canvas, 'wheel', { deltaY: -100 }).defaultPrevented).toBe(false)
    pointer.setNavigation(false)
    expect(fire(canvas, 'wheel', { deltaY: -100 }).defaultPrevented).toBe(false)
    expect(views).toEqual([])

    pointer.setNavigation(false, { wheel: true })
    expect(fire(canvas, 'wheel', { deltaY: -100 }).defaultPrevented).toBe(true)
    // A perspective camera comes nearer its target, and is not turned.
    expect(views).toHaveLength(1)
    expect(views[0].position[1]).toBeCloseTo(-95, 9)
    expect(views[0]).toMatchObject({ target: [0, 0, 0], zoom: 1 })
  })

  it('hears nothing once disposed of', () => {
    const { pointer, canvas, orbit, told } = router()
    pointer.dispose()
    pointer.listen(() => {
      throw new Error('told after dispose')
    })
    orbit.enabled = false // a pointer event heard would give it back
    fire(canvas, 'pointerup')
    fire(canvas, 'wheel', { deltaY: -100 })
    expect(orbit.enabled).toBe(false)
    expect(told()).toEqual([])
  })
})

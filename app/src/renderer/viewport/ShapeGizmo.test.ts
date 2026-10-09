import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { draggedTo, gizmoTakes } from './ShapeGizmo'

const OFF = { dragging: false, onHandle: false }
const ON = { dragging: false, onHandle: true }

/** Runs pointer events past the rule, as the viewport does, and says which of them were the gizmo's. */
function run(events: Array<{ kind: 'move' | 'down' | 'up' | 'cancel'; buttons: number; gizmo: { dragging: boolean; onHandle: boolean } }>): boolean[] {
  let press = false
  return events.map((e) => {
    const said = gizmoTakes(e.gizmo, e, press)
    press = said.press
    return said.takes
  })
}

describe('whose the pointer is, the gizmo’s or the tool’s', () => {
  it('is the gizmo’s over a handle while no button is held, and the tool’s again off it', () => {
    expect(run([{ kind: 'move', buttons: 0, gizmo: OFF }, { kind: 'move', buttons: 0, gizmo: ON }, { kind: 'move', buttons: 0, gizmo: OFF }])).toEqual([false, true, false])
  })

  it('is the gizmo’s for the whole of a press that began on a handle, wherever it goes, and for its release', () => {
    const dragging = { dragging: true, onHandle: true }
    expect(
      run([
        { kind: 'down', buttons: 1, gizmo: dragging },
        { kind: 'move', buttons: 1, gizmo: dragging },
        // The gizmo has let go by the time the viewport hears of the release, and the pointer is off the handle.
        { kind: 'up', buttons: 0, gizmo: OFF },
        { kind: 'move', buttons: 0, gizmo: OFF }
      ])
    ).toEqual([true, true, true, false])
    // A click on a handle, with no drag: the release is not a click on the part behind.
    expect(run([{ kind: 'down', buttons: 1, gizmo: ON }, { kind: 'up', buttons: 0, gizmo: ON }])).toEqual([true, true])
  })

  it('stays the tool’s when a press that began off the gizmo passes over a handle: a stroke drawn across it is not cut short', () => {
    expect(
      run([
        { kind: 'down', buttons: 1, gizmo: OFF },
        { kind: 'move', buttons: 1, gizmo: OFF },
        { kind: 'move', buttons: 1, gizmo: ON },
        { kind: 'move', buttons: 1, gizmo: OFF },
        // Let go on a handle: still the end of the tool's drag.
        { kind: 'move', buttons: 1, gizmo: ON },
        { kind: 'up', buttons: 0, gizmo: ON }
      ])
    ).toEqual([false, false, false, false, false, false])
  })

  it('forgets a press when the pointer is taken away', () => {
    expect(run([{ kind: 'down', buttons: 1, gizmo: ON }, { kind: 'cancel', buttons: 0, gizmo: OFF }, { kind: 'move', buttons: 1, gizmo: OFF }])).toEqual([true, true, false])
  })
})

describe('what a drag of the gizmo made of a shape', () => {
  const stand = (): THREE.Object3D => {
    const object = new THREE.Object3D()
    object.position.set(14.23456, -8.5, 6.504)
    object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6)
    object.scale.set(1.5, 1, 0.5)
    return object
  }

  it('moving changes the position only, to the hundredth of a millimetre', () => {
    expect(draggedTo('translate', 'box', [10, 10, 4], stand())).toEqual({ position: [14.23, -8.5, 6.5] })
  })

  it('turning changes the rotation only', () => {
    const made = draggedTo('rotate', 'box', [10, 10, 4], stand())
    expect(Object.keys(made)).toEqual(['rotation'])
    expect(made.rotation![2]).toBeCloseTo(Math.sin(Math.PI / 12), 12)
    expect(made.rotation![3]).toBeCloseTo(Math.cos(Math.PI / 12), 12)
  })

  it('sizing changes the size only, in millimetres from the size the drag began with, and puts the scale back to 1', () => {
    const object = stand()
    expect(draggedTo('scale', 'box', [10, 10, 4], object)).toEqual({ size: [15, 10, 2] })
    expect(object.scale.toArray()).toEqual([1, 1, 1])
    expect(draggedTo('scale', 'cylinder', [10, 10, 4], stand())).toEqual({ size: [15, 15, 2] })
    expect(draggedTo('scale', 'plane', [10, 10, 0], stand())).toEqual({ size: [15, 10, 0] })
    // Dragged through itself, or to nothing: never under 0.1 mm.
    const flipped = stand()
    flipped.scale.set(-1.2, 0, 1)
    expect(draggedTo('scale', 'box', [10, 10, 4], flipped)).toEqual({ size: [12, 0.1, 4] })
  })
})

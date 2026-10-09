import { describe, expect, it } from 'vitest'
import { apply } from '../../shared/align'
import type { Vec3 } from '../../shared/marks'
import type { ScanTransform } from '../../shared/scans'
import { ScanEdit } from './scanEdit'

const I: [number, number, number, number] = [0, 0, 0, 1]
const HALF = Math.SQRT1_2
const near = (a: number[], b: number[]): void => a.forEach((c, i) => expect(c).toBeCloseTo(b[i], 9))

function edit(placed: ScanTransform | null = { t: [10, 0, 0], q: I, s: 1 }) {
  const previews: Array<[string, ScanTransform | null]> = []
  const made = new ScanEdit({ placed: (id) => (id === 'S1' ? placed : null), preview: (id, transform) => void previews.push([id, transform]) })
  return { made, previews }
}

describe('the gizmo on a scan', () => {
  it('holds it at the point given, turned no way, and only while that scan is drawn', () => {
    const { made } = edit()
    expect(made.subject('S1')).toBeNull()
    made.edit('S1', [1, 2, 3], () => {})
    expect(made.subject('S1')).toEqual({ position: [1, 2, 3], rotation: I })
    expect(made.subject('S2')).toBeNull()
    made.edit(null, [0, 0, 0], () => {})
    expect(made.subject('S1')).toBeNull()
    const gone = edit(null)
    gone.made.edit('S1', [1, 2, 3], () => {})
    expect(gone.made.subject('S1')).toBeNull()
  })

  it('draws the scan as a drag has it: moved by how far the handle went, turned about the point it is held at', () => {
    const { made, previews } = edit()
    made.edit('S1', [10, 0, 0], () => {})
    made.preview('S1', { position: [10, 5, 0] })
    expect(previews.at(-1)).toEqual(['S1', { t: [10, 5, 0], q: I, s: 1 }])
    // A quarter turn about +Z, about the point it is held at: that point stays, the scan's origin with it.
    made.preview('S1', { rotation: [0, 0, HALF, HALF] })
    const turned = previews.at(-1)![1]!
    near(apply(turned, [0, 0, 0]), [10, 0, 0])
    near(apply(turned, [1, 0, 0]), [10, 1, 0])
  })

  it('moves it by hundredths of a millimetre, whatever the point it is held at: along one axis is along that axis only', () => {
    const said: Array<{ move: Vec3 }> = []
    const { made } = edit()
    made.edit('S1', [10.123456, -2.320509, 7.5], (change) => void said.push(change))
    made.released({ position: [13.396789, -2.320509, 7.5] })
    expect(said[0].move).toEqual([3.27, 0, 0])
  })

  it('says once, on release, how far it was moved and turned, and holds it where it was let go until it is told otherwise', () => {
    const said: Array<{ move: Vec3; turn: [number, number, number, number] }> = []
    const { made, previews } = edit()
    made.edit('S1', [10, 0, 0], (change) => void said.push(change))
    made.preview('S1', { position: [10, 5, 0] })
    made.released({ position: [10, 5, 0] })
    expect(said).toEqual([{ move: [0, 5, 0], turn: I }])
    // The handles are where they were let go, and the scan is still drawn there: main has not answered yet.
    expect(made.subject('S1')).toEqual({ position: [10, 5, 0], rotation: I })
    expect(previews.at(-1)).toEqual(['S1', { t: [10, 5, 0], q: I, s: 1 }])
    made.released({ rotation: [0, 0, HALF, HALF] })
    expect(said[1]).toEqual({ move: [0, 0, 0], turn: [0, 0, HALF, HALF] })
    // A drag that changed nothing says nothing.
    made.released({})
    expect(said).toHaveLength(2)
  })
})

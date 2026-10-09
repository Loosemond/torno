import { nudged } from '../../shared/align'
import type { Quat, Vec3 } from '../../shared/marks'
import type { ScanTransform } from '../../shared/scans'
import type { ScanLayer } from './scans'
import type { GizmoSubject, ShapeTransform } from './ShapeGizmo'

const NO_TURN: Quat = [0, 0, 0, 1]
/** How far a scan is moved is kept to the hundredth of a millimetre, as a shape's place is. */
const STEPS_PER_MM = 100
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]].map((mm) => Math.round(mm * STEPS_PER_MM) / STEPS_PER_MM + 0) as Vec3

/**
 * A scan under the gizmo: held at a point of the object frame (`pivot`), about which it is turned. While a
 * handle is dragged the scan is drawn as the drag has it (`ScanLayer.preview`) and nothing is told; on release
 * whoever asked hears once how far it was moved and turned about that point, and the scan stays drawn where it
 * was let go until the caller draws it otherwise (main has it there by then, or refused). A scan is never sized.
 */
export class ScanEdit {
  private on: { id: string; pivot: Vec3; from: ScanTransform; onChange: (change: { move: Vec3; turn: Quat }) => void } | null = null

  constructor(private readonly scans: Pick<ScanLayer, 'placed' | 'preview'>) {}

  /** The scan to hold, where, and who hears what a drag made of it; null for none. It is held as it is drawn now. */
  edit(id: string | null, pivot: Vec3, onChange: (change: { move: Vec3; turn: Quat }) => void): void {
    const from = id === null ? null : this.scans.placed(id)
    this.on = id !== null && from ? { id, pivot: [...pivot], from, onChange } : null
  }

  /** What the gizmo is on, for a scan's id: the point it is held at, turned no way. Null unless that scan is the one held and is there. */
  subject(id: string): GizmoSubject | null {
    return this.on?.id === id && this.scans.placed(id) ? { position: [...this.on.pivot], rotation: NO_TURN } : null
  }

  /** Draws the scan as a drag has it. */
  preview(id: string, change: Partial<ShapeTransform>): void {
    const made = this.on?.id === id ? this.made(change) : null
    if (made) this.scans.preview(id, made.transform)
  }

  /** The drag was let go: tells how far the scan was moved and turned. One that changed nothing tells nothing. */
  released(change: Partial<ShapeTransform>): void {
    const on = this.on
    const made = on && (change.position || change.rotation) ? this.made(change) : null
    if (!on || !made) return
    // Held from where it was let go, before anyone is told: whoever hears may ask for it to be held anew.
    this.on = { ...on, pivot: [on.pivot[0] + made.move[0], on.pivot[1] + made.move[1], on.pivot[2] + made.move[2]], from: made.transform }
    this.scans.preview(on.id, made.transform)
    on.onChange({ move: made.move, turn: made.turn })
  }

  private made(change: Partial<ShapeTransform>): { move: Vec3; turn: Quat; transform: ScanTransform } | null {
    if (!this.on) return null
    const move = change.position ? sub(change.position, this.on.pivot) : ([0, 0, 0] as Vec3)
    const turn = change.rotation ?? NO_TURN
    return { move, turn, transform: nudged(this.on.from, this.on.pivot, move, turn) }
  }
}

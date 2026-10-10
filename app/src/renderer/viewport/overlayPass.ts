import type * as THREE from 'three'
import type { Vec3 } from '../../shared/marks'
import { type AlignPoint, drawAlignPoints } from './alignPoints'
import { type BrushRing, drawBrushRing } from './brushRing'
import type { MarkLayer } from './marks/MarkLayer'
import type { Placed } from './marks/labels'
import { markPoints } from './marks/markObjects'
import { chipSize, drawLabels, type LabelStyle } from './overlay'

/** What the overlay needs of the viewport it lies over. */
export interface OverlayHost {
  readonly canvas: HTMLCanvasElement
  readonly marks: Pick<MarkLayer, 'labels' | 'markOf' | 'anchorOf' | 'offsetOf' | 'drawn' | 'activeId'>
  camera(): THREE.Camera
  layout(): string
  style(): LabelStyle & { accent: string }
  /** Where a point of the object frame falls in the window, in client pixels. */
  project(point: Vec3): [number, number]
  syncMatrices(): void
  /** The parts are drawn apart: what a tool shows of itself is of the parts where they are, and is not drawn meanwhile. */
  exploded?(): boolean
}

/**
 * What is drawn over the 3D view with every frame, on a canvas of its own and never through React: the labels of
 * the marks, the points of an alignment being made, the ring of the Region tool's brush. None of the last two is
 * in a picture for the agent. It also says where a mark's label is, for whatever is put beside a mark.
 */
export class OverlayPass {
  /** Over the 3D canvas; null where that has no parent to hold it. */
  readonly canvas: HTMLCanvasElement | null
  alignPoints: AlignPoint[] = []
  brush: BrushRing | null = null

  constructor(private readonly host: OverlayHost) {
    this.canvas = host.canvas.parentElement ? document.createElement('canvas') : null
    if (this.canvas) {
      this.canvas.className = 'mark-labels'
      host.canvas.after(this.canvas)
    }
  }

  resize(width: number, height: number): void {
    if (!this.canvas) return
    this.canvas.width = Math.round(width * window.devicePixelRatio)
    this.canvas.height = Math.round(height * window.devicePixelRatio)
  }

  draw(size: { width: number; height: number }): void {
    const ctx = this.canvas?.getContext('2d')
    if (!this.canvas || !ctx || size.width === 0 || size.height === 0) return
    const { host } = this
    const style = host.style()
    ctx.setTransform(this.canvas.width / size.width, 0, 0, this.canvas.height / size.height, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    drawLabels(ctx, host.marks.labels(host.layout(), host.camera(), size, 1, chipSize(ctx, 1)), style, 1, host.marks.activeId)
    // Not while the parts are drawn apart: a point picked on the model would be drawn where its part is not.
    if (host.exploded?.()) return
    drawAlignPoints(ctx, this.alignPoints, host.camera(), size, { accent: style.accent, paper: style.paper })
    drawBrushRing(ctx, this.brush, host.camera(), size, { mark: style.user, paper: style.paper })
  }

  /** Where the label of a mark of the layout shown is on the canvas, in client pixels, and whether it is in view; null for a mark that is not drawn. */
  markLabel(id: string): { x: number; y: number; visible: boolean } | null {
    const rect = this.host.canvas.getBoundingClientRect()
    const label = this.placed(id)
    return label ? { x: rect.left + label.box.x + label.box.w / 2, y: rect.top + label.box.y + label.box.h / 2, visible: label.visible } : null
  }

  /**
   * What a mark of the layout shown covers on the canvas, in client pixels: its points and the chip of its
   * number. `at` is where it is anchored. Null for a mark that is not drawn. For whatever is put beside a mark.
   */
  markBox(id: string): { left: number; top: number; right: number; bottom: number; at: [number, number]; visible: boolean } | null {
    const { host } = this
    const mark = host.marks.markOf(host.layout(), id)
    const label = mark && this.placed(id)
    if (!mark || !label) return null
    const rect = host.canvas.getBoundingClientRect()
    const at = host.project(host.marks.anchorOf(mark).point)
    const xs = [at[0], rect.left + label.box.x, rect.left + label.box.x + label.box.w]
    const ys = [at[1], rect.top + label.box.y, rect.top + label.box.y + label.box.h]
    // Where it is drawn: with its part, while the parts are drawn apart (`anchorOf` says so of its anchor already).
    const by = host.marks.offsetOf(mark)
    for (const point of markPoints(host.marks.drawn(mark))) {
      const [x, y] = host.project([point[0] + by[0], point[1] + by[1], point[2] + by[2]])
      xs.push(x)
      ys.push(y)
    }
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), at, visible: label.visible }
  }

  dispose(): void {
    this.canvas?.remove()
  }

  /** The label of a mark of the layout shown as it is placed on the canvas, in the canvas's own pixels. */
  private placed(id: string): Placed | null {
    const { host } = this
    const rect = host.canvas.getBoundingClientRect()
    host.syncMatrices()
    const size = { width: rect.width, height: rect.height }
    const ctx = this.canvas?.getContext('2d')
    if (!ctx || size.width === 0 || size.height === 0) return null
    return host.marks.labels(host.layout(), host.camera(), size, 1, chipSize(ctx, 1)).find((l) => l.id === id) ?? null
  }
}

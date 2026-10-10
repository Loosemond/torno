import type { TornoBridge } from '../shared/bridge'
import type { Camera, LookRequest, LookResult } from '../shared/view'
import type { TornoState } from './state/store'
import type { Hit } from './viewport/picking'
import type { ScanHit, ScanLayerState } from './viewport/scans'
import type { ScanTints } from './viewport/scanTints'

declare global {
  interface Window {
    /** Exposed by the preload script; see src/shared/bridge.ts. */
    torno: TornoBridge
    /** Only when main runs with TORNO_TEST=1: what the e2e tests read and the pictures they take. */
    __tornoTest?: {
      state(): TornoState
      look(req: LookRequest): Promise<LookResult>
      camera(): Camera
      /** What a point of the canvas is on; `fx` and `fy` are fractions of its width and height, from the top left. */
      pickAt(fx: number, fy: number, opts?: { edges?: boolean; partsOnly?: boolean }): Hit | null
      /** How long `count` picks spread over the canvas take, as a pointer move makes them: the mean and the worst, in milliseconds, and how many were on a part. */
      timePicks(count?: number, opts?: { edges?: boolean }): { count: number; hits: number; meanMs: number; worstMs: number }
      /** What drawing the view as it is costs, over `count` frames: the mean and the worst, in milliseconds. */
      timeFrames(count?: number): { count: number; meanMs: number; worstMs: number }
      /** Where a point of the object frame is drawn on the canvas, as such fractions; with `part`, where it is drawn as a point of that part, which may be drawn apart from where it is (explode). */
      project(point: [number, number, number], part?: string): [number, number]
      /** Whether the viewport draws the parts apart now, or is on its way there or back. */
      exploded(): boolean
      /** Where the label of a mark is drawn, as such fractions, and whether it is in view; null for a mark that is not drawn. */
      markScreen(id: string): { x: number; y: number; visible: boolean } | null
      /** What a thumbnail of the build on show (or of a scene given, with its meshes) costs, drawn `count` times off screen as a card's picture is: the mean and the worst, in milliseconds, and the size of the PNG. */
      timeThumbnail(count?: number, given?: { scene: import('../shared/scene').Scene; blob: ArrayBuffer }): Promise<{ count: number; meanMs: number; worstMs: number; bytes: number }>
      /** The scans of the open object as the viewport has them: whether each mesh has come, where it stands, how it is drawn. */
      scans(): ScanLayerState[]
      /** What is tinted on the scans: the regions kept, each with how many triangles it draws and in which colour, and the set being painted. */
      regions(): ReturnType<ScanTints['state']>
      /** What a point of the canvas is on of the scans drawn, as `pickAt` is of the parts. */
      pickScanAt(fx: number, fy: number): ScanHit | null
      /** Where a point of a scan, in the scan's own frame, is drawn: fractions of the canvas, as `project`. */
      projectScan(id: string, local: [number, number, number]): [number, number]
      /** What `count` picks of the scans cost, at points spread over the canvas, and how each tree was made. */
      timeScanPicks(count?: number): { count: number; hits: number; meanMs: number; worstMs: number; how: Record<string, 'worker' | 'main'> }
    }
    /** Only with TORNO_TEST=1: what the terminal of the open object shows, as text. */
    __tornoTerm?: {
      text(): string
      size(): { cols: number; rows: number } | null
      theme(): { background?: string; foreground?: string }
      renderer(): 'webgl' | 'dom' | null
    }
  }
}

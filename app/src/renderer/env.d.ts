import type { TornoBridge } from '../shared/bridge'
import type { Camera, LookRequest, LookResult } from '../shared/view'
import type { TornoState } from './state/store'
import type { Hit } from './viewport/picking'

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
      pickAt(fx: number, fy: number, opts?: { edges?: boolean }): Hit | null
      /** Where a point of the object frame falls on the canvas, as such fractions. */
      project(point: [number, number, number]): [number, number]
      /** Where the label of a mark is drawn, as such fractions, and whether it is in view; null for a mark that is not drawn. */
      markScreen(id: string): { x: number; y: number; visible: boolean } | null
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

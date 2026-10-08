import type { TornoBridge } from '../shared/bridge'
import type { Camera, LookRequest, LookResult } from '../shared/view'
import type { TornoState } from './state/store'

declare global {
  interface Window {
    /** Exposed by the preload script; see src/shared/bridge.ts. */
    torno: TornoBridge
    /** Only when main runs with TORNO_TEST=1: what the e2e tests read and the pictures they take. */
    __tornoTest?: {
      state(): TornoState
      look(req: LookRequest): Promise<LookResult>
      camera(): Camera
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

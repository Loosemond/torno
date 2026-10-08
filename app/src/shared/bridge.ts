import type { BuildState } from './build'
import type { Scene } from './scene'
import type { LookRequest, LookResult, ViewState } from './view'
import type { WorkspaceInfo } from './workspace'

export interface TornoBridge {
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    pick(): Promise<WorkspaceInfo | null>            // folder dialog
    open(root: string): Promise<WorkspaceInfo>
  }
  object: {
    open(id: string): Promise<BuildState>            // starts watching and building
    rebuild(id: string): Promise<void>
    onBuild(cb: (s: BuildState) => void): () => void
    onScene(cb: (m: { objectId: string; revision: number; scene: Scene; blob: ArrayBuffer }) => void): () => void
  }
  view: {
    report(v: ViewState): void
    onLook(cb: (m: { id: number; request: LookRequest }) => void): () => void
    lookReply(id: number, result: LookResult | { error: string }): void
  }
  session: {
    start(objectId: string, opts?: { resume?: boolean }): Promise<{ sessionId: string; cols: number; rows: number }>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    stop(sessionId: string): Promise<void>
    onData(cb: (m: { sessionId: string; data: string }) => void): () => void
    onStatus(cb: (m: { sessionId: string; status: SessionStatus }) => void): () => void
  }
}
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'

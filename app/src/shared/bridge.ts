import type { BuildState } from './build'
import type { Scene } from './scene'
import type { SceneFile } from './scenefile'
import type { LookRequest, LookResult, ViewState } from './view'
import type { WorkspaceInfo } from './workspace'

export interface TornoBridge {
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    pick(): Promise<WorkspaceInfo | null>            // folder dialog
    open(root: string): Promise<WorkspaceInfo>
    versions(): Promise<Record<string, string>>     // of the kernel, once it is ready: build123d, python
    onRequested(cb: (root: string) => void): () => void  // a second launch of torno was given this folder to open
  }
  object: {
    open(id: string): Promise<BuildState>            // starts watching and building
    rebuild(id: string): Promise<void>
    loadSceneFile(id: string): Promise<SceneFile>    // <object>/.torno/scene.json, defaults when there is none
    saveSceneFile(id: string, file: SceneFile): void
    onBuild(cb: (s: BuildState) => void): () => void
    onScene(cb: (m: { objectId: string; revision: number; scene: Scene; blob: ArrayBuffer }) => void): () => void
  }
  view: {
    report(v: ViewState): void
    onLook(cb: (m: { id: number; request: LookRequest }) => void): () => void
    lookReply(id: number, result: LookResult | { error: string }): void
  }
  session: {
    /** What there is for an object: its running session, and whether an earlier conversation can be resumed. */
    current(objectId: string): Promise<{ running: { sessionId: string; status: SessionStatus } | null; resumable: boolean }>
    /** Starts the agent in the object's folder, at the terminal's size; returns the session already running there, if any. */
    start(objectId: string, opts?: { resume?: boolean; cols?: number; rows?: number }): Promise<{ sessionId: string; cols: number; rows: number }>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    stop(sessionId: string): Promise<void>
    onData(cb: (m: { sessionId: string; data: string }) => void): () => void
    onStatus(cb: (m: { sessionId: string; status: SessionStatus }) => void): () => void
  }
}
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'

import type { BuildState } from './build'
import type { Described } from './geometry'
import type { Mark, MarkPatch, NewMark } from './marks'
import type { Scene } from './scene'
import type { SceneFile } from './scenefile'
import type { HighlightRequest, HighlightResult, LookRequest, LookResult, ShowRequest, ShowResult, ViewState } from './view'
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
    /** The agent asks to change what the person sees, or to point something out: each is answered with what was done, or why not. */
    onShow(cb: (m: { id: number; request: ShowRequest }) => void): () => void
    showReply(id: number, result: ShowResult | { error: string }): void
    onHighlight(cb: (m: { id: number; request: HighlightRequest }) => void): () => void
    highlightReply(id: number, result: HighlightResult | { error: string }): void
  }
  /** The marks of an object, kept by main in <object>/.torno/marks.json. Calls reject with a plain message. */
  marks: {
    list(objectId: string): Promise<Mark[]>
    add(objectId: string, mark: NewMark): Promise<Mark>
    update(objectId: string, id: string, patch: MarkPatch): Promise<Mark>
    remove(objectId: string, id: string): Promise<void>
    onChanged(cb: (m: { objectId: string; marks: Mark[] }) => void): () => void
    /** Something about an object's marks file the person should know, said once: a file that could not be read was set aside. */
    onProblem(cb: (m: { objectId: string; message: string }) => void): () => void
    /** What `onProblem` last said of an object, for a window that was not listening then; null when nothing, or once dismissed. */
    problem(objectId: string): Promise<string | null>
    dismissProblem(objectId: string): Promise<void>
  }
  geometry: {
    describe(objectId: string, layout: string, ref: string): Promise<Described>   // rejects with a plain message
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
    insert(sessionId: string, text: string): void     // bracketed paste at the cursor, never submitted
  }
}
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'

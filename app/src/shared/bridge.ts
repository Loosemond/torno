import type { BuildState } from './build'
import type { Described, MeasureArgs, Measured } from './geometry'
import type { Mark, MarkPatch, NewMark, Replacement } from './marks'
import type { Scene } from './scene'
import type { SceneFile } from './scenefile'
import type { HighlightRequest, HighlightResult, LookRequest, LookResult, SectionDrawingRequest, SectionDrawingResult, ShowRequest, ShowResult, ViewState } from './view'
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
    /** The agent asked for what a plane cuts: main has the outlines from the kernel, and the window draws them. */
    onDrawSection(cb: (m: { id: number; request: SectionDrawingRequest }) => void): () => void
    drawSectionReply(id: number, result: SectionDrawingResult | { error: string }): void
  }
  /** The marks of an object, kept by main in <object>/.torno/marks.json. Calls reject with a plain message. */
  marks: {
    list(objectId: string): Promise<Mark[]>
    /** A dimension is measured by main as it is kept, and comes back with its value; one the kernel cannot measure is not kept, and the rejection says why. */
    add(objectId: string, mark: NewMark): Promise<Mark>
    update(objectId: string, id: string, patch: MarkPatch): Promise<Mark>
    remove(objectId: string, id: string): Promise<void>
    /** Puts a pin, a pick or an arrow somewhere else on a part: the same mark and note, tied where it was clicked. An arrow keeps its length and direction. */
    replace(objectId: string, id: string, placed: Replacement): Promise<Mark>
    onChanged(cb: (m: { objectId: string; marks: Mark[] }) => void): () => void
    /** Something about an object's marks file the person should know, said once: a file that could not be read was set aside. */
    onProblem(cb: (m: { objectId: string; message: string }) => void): () => void
    /** What `onProblem` last said of an object, for a window that was not listening then; null when nothing, or once dismissed. */
    problem(objectId: string): Promise<string | null>
    dismissProblem(objectId: string): Promise<void>
  }
  geometry: {
    describe(objectId: string, layout: string, ref: string): Promise<Described>   // rejects with a plain message
    /** An exact measurement on the object's last good build, between refs or points of a layout. Rejects with a plain message: the kernel's reason when it refuses what was asked. */
    measure(objectId: string, args: MeasureArgs): Promise<Measured>
  }
  session: {
    /** What there is for an object: its running session, and whether an earlier conversation can be resumed. */
    current(objectId: string): Promise<{ running: { sessionId: string; status: SessionStatus } | null; resumable: boolean }>
    /** Starts the agent in the object's folder, at the terminal's size; returns the session already running there, if any. Either way with its status as it is then. */
    start(objectId: string, opts?: { resume?: boolean; cols?: number; rows?: number }): Promise<{ sessionId: string; cols: number; rows: number; status: SessionStatus }>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    stop(sessionId: string): Promise<void>
    onData(cb: (m: { sessionId: string; data: string }) => void): () => void
    onStatus(cb: (m: { sessionId: string; status: SessionStatus }) => void): () => void
    insert(sessionId: string, text: string): void     // bracketed paste at the cursor, never submitted
  }
}
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'

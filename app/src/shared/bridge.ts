import type { BuildState } from './build'
import type { Described } from './geometry'
import type { Mark, MarkPatch, NewMark, NewRegion, Replacement } from './marks'
import type { Scene } from './scene'
import type { AlignMade, NewAlignment, Reimported, ScanInfo, ScanUnit, ScanUp } from './scans'
import type { SceneFile } from './scenefile'
import type { HighlightRequest, HighlightResult, LookRequest, LookResult, SaveViewRequest, SaveViewResult, SectionDrawingRequest, SectionDrawingResult, ShowRequest, ShowResult, ViewState } from './view'
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
    /** The agent proposes a view: the window keeps it among the saved views of the object it shows, marked as proposed, and says what it kept. */
    onSaveView(cb: (m: { id: number; request: SaveViewRequest }) => void): () => void
    saveViewReply(id: number, result: SaveViewResult | { error: string }): void
  }
  /** The marks of an object, kept by main in <object>/.torno/marks.json. Calls reject with a plain message. */
  marks: {
    list(objectId: string): Promise<Mark[]>
    /** A dimension is measured by main as it is kept, and comes back with its value; one the kernel cannot measure is not kept, and the rejection says why. */
    add(objectId: string, mark: NewMark): Promise<Mark>
    /** Keeps what was painted on a scan as a region mark: main works out its count, area and place from the mesh, and writes its triangles beside it. Rejects for no triangle, or bits that are not of that scan's mesh. */
    addRegion(objectId: string, region: NewRegion): Promise<Mark>
    /** A kept region painted again: the same mark and note, of these triangles (the bits of a mask). One the agent was sent is a draft again. */
    repaintRegion(objectId: string, id: string, bits: Uint8Array): Promise<Mark>
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
  /** The scans of an object, kept by main in <object>/.torno/scans.json and .torno/scans/. Calls reject with a plain message. */
  scans: {
    list(objectId: string): Promise<ScanInfo[]>
    /** The file dialog; under test, what `__tornoMain.pickFile` holds. Null when nothing was chosen. */
    pick(): Promise<string | null>
    /** Where a file dropped on the window is on the disk (`webUtils.getPathForFile`); '' for one that is nowhere. */
    pathOf(file: File): string
    /** Has the file read by the import process, which takes seconds: `onProgress` says where it stands. The file itself is never changed. */
    import(objectId: string, path: string): Promise<ScanInfo>
    /** Reads the scan's source again into the same scan: its id, its name and its alignments stay. Rejects when the source is missing. Told by `onProgress` as an import is. */
    reimport(objectId: string, id: string): Promise<Reimported>
    /** The scan as if its source had been read with this unit and up axis. Its alignments are dropped when either changes. */
    convert(objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo>
    rename(objectId: string, id: string, name: string): Promise<ScanInfo>
    remove(objectId: string, id: string): Promise<void>
    /**
     * Where the scan is in a layout of the last build, or null for nowhere. `made` says which build it was fitted
     * on (main refuses another than the last) and what the person said yes to: an alignment that is rough, or
     * that changes the scan's size, is kept only with that yes. Main adds how that build's parts are spread, when,
     * the residuals and why it is rough.
     */
    align(objectId: string, id: string, layout: string, alignment: NewAlignment, made: AlignMade): Promise<ScanInfo>
    /** With null: the scan is aligned to nothing in that layout any more. */
    align(objectId: string, id: string, layout: string, alignment: null): Promise<ScanInfo>
    /** Puts back the alignment the scan had in that layout before the last one was kept. Rejects when there is none to go back to. */
    undoAlign(objectId: string, id: string, layout: string): Promise<ScanInfo>
    /**
     * The person looked and says the alignment still holds, whatever put it in doubt. Main asks the kernel where the
     * model points it is tied to are now, and holds later builds against that; rejects when the kernel cannot say.
     */
    alignHolds(objectId: string, id: string, layout: string): Promise<ScanInfo>
    /** The scan's `mesh.bin`, for `parseScanMesh`. */
    mesh(objectId: string, id: string): Promise<ArrayBuffer>
    /** The `.mask` of a region of a scan, as the file is, by its stem (`maskStem`): for `maskBits`. */
    mask(objectId: string, id: string, stem: string): Promise<ArrayBuffer>
    onChanged(cb: (m: { objectId: string; scans: ScanInfo[] }) => void): () => void
    onProgress(cb: (m: { objectId: string; name: string; stage: string | null }) => void): () => void
    /** Something about an object's scans file the person should know, said once: a file that could not be read was set aside. */
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

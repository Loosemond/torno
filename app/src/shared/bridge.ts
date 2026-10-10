import type { BuildState } from './build'
import type { ExportPlan, ExportRequest } from './exportdata'
import type { Described } from './geometry'
import type { Mark, MarkPatch, NewMark, NewRegion, Replacement } from './marks'
import type { Scene } from './scene'
import type { AlignMade, NewAlignment, Reimported, ScanInfo, ScanUnit, ScanUp } from './scans'
import type { SceneFile } from './scenefile'
import type { ObjectCard, ThumbnailOf } from './show'
import type { HighlightRequest, HighlightResult, LookRequest, LookResult, SaveViewRequest, SaveViewResult, SectionDrawingRequest, SectionDrawingResult, ShowRequest, ShowResult, ViewState } from './view'
import type { RecentFolder, WorkspaceInfo } from './workspace'

export interface TornoBridge {
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    pick(): Promise<WorkspaceInfo | null>            // folder dialog
    open(root: string): Promise<WorkspaceInfo>
    versions(): Promise<Record<string, string>>     // of the kernel, once it is ready: build123d, python
    /** The folders opened lately, the newest first, eight at most: kept in torno's own config file, never in a workspace. */
    recent(): Promise<RecentFolder[]>
    /** Takes one off that list; answers with the list. */
    forget(root: string): Promise<RecentFolder[]>
    /** Whether this torno has an example to open: it has when it runs from its repository. */
    hasExample(): Promise<boolean>
    /** Opens a copy of the example, made in a temporary folder. It is not remembered. */
    openExample(): Promise<WorkspaceInfo>
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
  /** The page of objects: a card for each object of the workspace, read from what main knows and from what is on file. Asking builds nothing. */
  show: {
    cards(): Promise<ObjectCard[]>
    /** The PNG on file, or null. */
    thumbnail(objectId: string): Promise<ArrayBuffer | null>
    /** A picture of the build `revision` of an object opened in this run. Dropped without a word when that is no longer its last build, or the bytes are no such picture. */
    saveThumbnail(objectId: string, revision: number, png: Uint8Array, of: ThumbnailOf): void
    /** Something a card says may have changed. */
    onChanged(cb: () => void): () => void
  }
  /** One HTML file of an object or of several, that opens by itself: see `main/export`. Calls reject with a plain message. */
  export: {
    /** What a file of this request would hold and weigh, with every object of the workspace and whether it can be exported. Writes nothing. */
    plan(req: ExportRequest): Promise<ExportPlan>
    /** Asks where to save (under test: `__tornoMain.pickSave`), writes the file there, and says where; null when the dialog was cancelled. The path is the dialog's alone: the window never names one. */
    save(req: ExportRequest): Promise<{ path: string; bytes: number; dropped: string[] } | null>
    /** The export sheet was put away: what main kept ready for it (scans reduced) is let go. */
    done(): void
  }
  session: {
    /**
     * What there is for an object: its running session and the agent that one is of; the agent its next session
     * runs (`agent`, `hooks`: the one chosen for it) and whether one of that agent's conversations can be resumed.
     * `note` says so when the object's `agent.json` could not be followed and Claude Code is used in its place.
     */
    current(objectId: string): Promise<{ running: { sessionId: string; status: SessionStatus; agent: AgentId; hooks: boolean } | null; resumable: boolean; agent: AgentId; hooks: boolean; note?: string }>
    /** Starts the agent chosen for the object in its folder, at the terminal's size; returns the session already running there, if any. Either way with its status as it is then, and the agent it is of. */
    start(objectId: string, opts?: { resume?: boolean; cols?: number; rows?: number }): Promise<{ sessionId: string; cols: number; rows: number; status: SessionStatus; agent: AgentId; hooks: boolean }>
    /** The agents there are, and of each whether its command is on PATH now. */
    agents(): Promise<Array<{ id: AgentId; label: string; installed: boolean; hooks: boolean }>>
    /** Keeps the agent of an object's sessions to come in its `.torno/agent.json`. Rejects while a session runs in that object. */
    chooseAgent(objectId: string, agent: AgentId): Promise<void>
    /** For an agent without hooks: writes `.torno/prompt.md` and pastes one line at its cursor, not sent. Answers with the marks the file tells of for the first time. */
    sendMarks(sessionId: string): Promise<{ marks: string[]; line: string }>
    /** What became of that line, and how many marks its file tells of: they are sent only by `sent`. */
    onSend(cb: (m: { sessionId: string; state: SendState; marks: number; why?: SendDropped }) => void): () => void
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    stop(sessionId: string): Promise<void>
    onData(cb: (m: { sessionId: string; data: string }) => void): () => void
    onStatus(cb: (m: { sessionId: string; status: SessionStatus }) => void): () => void
    insert(sessionId: string, text: string): void     // bracketed paste at the cursor, never submitted
  }
}
/** An agent CLI torno can start (`main/sessions/adapter.ts`). */
export type AgentId = 'claude' | 'copilot'

/**
 * What became of the line "Send marks" put at the cursor of an agent without hooks: `waiting` there for the
 * person's Enter; `sent` by it, when the agent had shown the line and nothing was typed after it; `dropped`
 * otherwise, and then the marks it told of are drafts still.
 */
export type SendState = 'waiting' | 'sent' | 'dropped'
/** Why a line was dropped: something was typed or pasted after it, or the agent had not shown it when Enter was pressed. */
export type SendDropped = 'typed' | 'absent'

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'

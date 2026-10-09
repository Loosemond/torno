import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { SessionStatus } from '../../shared/bridge'
import type { BuildState } from '../../shared/build'
import type { Mark, Vec3 } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { ScanInfo, ScanView } from '../../shared/scans'
import { sectionOf, snappedSection, type SectionPlane, type ViewName } from '../../shared/view'
import type { LayerSettings, SceneFile } from '../../shared/scenefile'
import type { WorkspaceInfo } from '../../shared/workspace'

/** The agent session of an object. Its output is not here: it goes straight into the terminal. */
export interface SessionView {
  sessionId: string
  status: SessionStatus
}

/** Where a selected ref was clicked: the point, and the normal there (an edge has none). Object frame. */
export interface PickedAt {
  point: Vec3
  normal: Vec3 | null
}

/**
 * What the window shows, as plain data: no functions, no mesh bytes. The blob
 * of a scene goes straight to the viewport; camera motion never passes through
 * here.
 */
export interface TornoState {
  /** null until main has answered (`workspaceKnown`), and when no folder is open. */
  workspace: WorkspaceInfo | null
  workspaceKnown: boolean
  /** Versions the kernel reported: build123d, python. */
  versions: Record<string, string>
  objectId: string | null
  /** Build state of the open object. */
  build: BuildState | null
  /** The last good scene of the open object, and the revision it is. */
  scene: Scene | null
  revision: number
  layout: string
  /** By part name, so a setting holds in every layout. */
  layers: Record<string, LayerSettings>
  /**
   * The plane the parts are cut by, or null: part of how the object is looked
   * at. It changes when a drag of the plane is let go or a field is left,
   * never while the plane moves.
   */
  section: SectionPlane | null
  /** The marks of the open object, as main last told them. */
  marks: Mark[]
  /** What main said was wrong with the marks file of the open object, as a sentence; null when nothing was. */
  marksProblem: string | null
  /** The mark being worked on: the row lit in the panel and the label ringed in the viewport. Null for none. */
  activeMark: string | null
  /** The scans of the open object, as main last told them. Their meshes are not here: they go straight to the viewport. */
  scans: ScanInfo[]
  /**
   * Whether `scans` is what main said of the object on show: false from when an object is opened until its
   * scans have come. Meanwhile `scans` is empty, and that says nothing of what the object has.
   */
  scansKnown: boolean
  /** How each scan is looked at, by scan id, where the person changed it: what the scene file keeps. */
  scanViews: Record<string, ScanView>
  /** The scans the view cuts, by id: each reaches further than the camera does for a scan (`ScanLayerState.clipped`). As the viewport last found, not per frame. */
  scansClipped: readonly string[]
  /** The file being imported into the open object as a scan, and what the process is doing; null for none. */
  importing: { name: string; stage: string | null } | null
  /** Why what was last asked of the scans here (an import, another unit, a removal) came to nothing, as main said it; null once it is put away. */
  scansRefused: string | null
  /** What main said was wrong with the scans file of the open object, as a sentence; null when nothing was. */
  scansProblem: string | null
  /** The mark whose note is open over the viewport, for the person to write it; null for none. It is the active one. */
  noting: string | null
  /** Counts the times the camera was asked to go to the active mark's view. */
  markFocus: number
  /** The scan to bring into view with the parts, and a count of the times that was asked: "Frame" on its row. Null until it is. */
  scanFramed: { id: string; n: number } | null
  /**
   * What the person has picked: refs in the layout shown (`lid/F12`, `lid/E3`),
   * in the order picked. They name geometry of the revision on screen, so the
   * selection is emptied when the object, the layout or the revision changes.
   */
  selection: string[]
  /** By selected ref, where it was clicked: a note left on the selection is anchored there. */
  picked: Record<string, PickedAt>
  ortho: boolean
  /**
   * The standard view the camera is locked on (orthographic, and not turned
   * since it went there), as of the last time the camera came to rest; null
   * for none. A stroke drawn on a locked view is a profile on that plane.
   */
  lockedView: ViewName | null
  /** Counts changes of layout and layers made by hand: what the scene file is saved for. */
  edits: number
  /**
   * What the person had chosen where the agent's `show` now shows something
   * else: their layout, and by part name whether they had it switched on
   * (undefined for a part they had never switched). It is what the scene file
   * keeps (`sceneFileOf`): an agent that changes the view does not rewrite the
   * person's saved settings. A choice the person makes by hand afterwards is
   * theirs again, and is taken out of here. `section` is there when the agent
   * cut the parts otherwise: `theirs` is the person's plane, or null for none.
   * `scans` holds, by scan id, how the person looked at each scan the agent
   * shows otherwise (undefined for one they had never changed). What they set
   * of such a scan by hand afterwards is theirs, field by field: the fields
   * they did not touch stay as they had them.
   */
  shownByAgent: { layout?: string; visible: Record<string, boolean | undefined>; section?: { theirs: SectionPlane | null }; scans?: Record<string, ScanView | undefined> } | null
  /** By object id: the session started there, running or ended. It outlives the object being shown. */
  sessions: Record<string, SessionView>
}

const NOTHING_SELECTED: string[] = []
const NOTHING_PICKED: Record<string, PickedAt> = {}
const NO_SCANS: ScanInfo[] = []
const NOT_CLIPPED: readonly string[] = []
const NO_SELECTION = { selection: NOTHING_SELECTED, picked: NOTHING_PICKED }
const NO_OBJECT = { objectId: null, build: null, scene: null, revision: 0, layout: '', layers: {}, section: null, marks: [], marksProblem: null, scans: NO_SCANS, scansKnown: true, scanViews: {}, scansClipped: NOT_CLIPPED, importing: null, scansRefused: null, scansProblem: null, activeMark: null, noting: null, shownByAgent: null, ...NO_SELECTION }

export const store = createStore<TornoState>(() => ({
  workspace: null,
  workspaceKnown: false,
  versions: {},
  ...NO_OBJECT,
  markFocus: 0,
  scanFramed: null,
  ortho: false,
  lockedView: null,
  edits: 0,
  sessions: {}
}))

export function useStore<T>(selector: (s: TornoState) => T): T {
  return useZustand(store, selector)
}

export const actions = {
  /** A workspace was opened (or there is none): nothing of the old one stays. */
  setWorkspace(workspace: WorkspaceInfo | null): void {
    store.setState({ workspace, workspaceKnown: true, versions: {}, ...NO_OBJECT, sessions: {} })
  },

  /** The object list was scanned again. */
  refreshWorkspace(workspace: WorkspaceInfo): void {
    if (store.getState().workspace?.root === workspace.root) store.setState({ workspace })
  },

  setVersions(versions: Record<string, string>): void {
    store.setState({ versions })
  },

  /** Start showing an object, as its scene file left it. Its build state and scene follow. */
  openObject(objectId: string, file: SceneFile): void {
    store.setState({ ...NO_OBJECT, objectId, scansKnown: false, layout: file.layout ?? '', layers: file.layers, section: sectionOf(file.section), scanViews: file.scans ?? {} })
  },

  applyBuild(build: BuildState): void {
    if (build.objectId === store.getState().objectId) store.setState({ build })
  },

  /**
   * A build of the open object succeeded. False when there is nothing new to
   * show: a scene of another object, or the revision already here (main sends
   * the last scene again when an object is opened).
   *
   * The selection names faces and edges by number, and a build numbers them
   * anew: it is emptied, unless every part of the new scene is the part the
   * old one had under that key (the same hash), as when main had the same
   * sources built again for the kernel's sake.
   */
  applyScene(m: { objectId: string; revision: number; scene: Scene }): boolean {
    const s = store.getState()
    if (m.objectId !== s.objectId) return false
    if (s.scene && m.revision === s.revision) return false
    const layout = m.scene.layouts.includes(s.layout) ? s.layout : (m.scene.layouts[0] ?? '')
    const names = new Set(m.scene.parts.map((p) => p.name))
    const kept = Object.entries(s.layers).filter(([name]) => names.has(name))
    const layers = kept.length === Object.keys(s.layers).length ? s.layers : Object.fromEntries(kept)
    const same = s.scene !== null && layout === s.layout && sameParts(s.scene, m.scene)
    // The layout shown is gone with this build: what was being done there (a note, a mark worked on) is of
    // a layout that is no longer shown, as when the layout is changed by hand.
    const elsewhere = s.scene !== null && layout !== s.layout ? layoutChange(s, layout) : {}
    store.setState({ ...elsewhere, scene: m.scene, revision: m.revision, layout, layers, ...(same ? {} : NO_SELECTION) })
    return true
  },

  setLayout(layout: string): void {
    const s = store.getState()
    if (layout === s.layout || !s.scene?.layouts.includes(layout)) return
    // The person's own choice from here on, whatever the agent had shown.
    const { layout: _theirsAgain, ...shownByAgent } = s.shownByAgent ?? { visible: {} }
    store.setState({ ...layoutChange(s, layout), edits: s.edits + 1, shownByAgent: s.shownByAgent && shownByAgent })
  },

  /** Change some settings of one part; the others keep their values. */
  setLayer(name: string, settings: LayerSettings): void {
    const s = store.getState()
    let shownByAgent = s.shownByAgent
    if (shownByAgent && settings.visible !== undefined && name in shownByAgent.visible) {
      const { [name]: _theirsAgain, ...visible } = shownByAgent.visible
      shownByAgent = { ...shownByAgent, visible }
    }
    store.setState({ layers: { ...s.layers, [name]: { ...s.layers[name], ...settings } }, edits: s.edits + 1, shownByAgent })
  },

  /**
   * Cut the parts by a plane, or by none, by hand: when a drag of the plane is
   * let go, a field is left, a button is pressed. It is the person's own
   * choice, whatever the agent had shown, and is what the scene file keeps.
   */
  setSection(plane: SectionPlane | null): void {
    const s = store.getState()
    const section = plane && snappedSection(plane)
    if (samePlane(section, s.section) && !s.shownByAgent?.section) return
    const { section: _theirsAgain, ...shownByAgent } = s.shownByAgent ?? { visible: {} }
    store.setState({ section, edits: s.edits + 1, shownByAgent: s.shownByAgent && shownByAgent })
  },

  /**
   * Show a layout, and of its parts those switched on in `visible` (by name),
   * because the agent asked: for now, and not for keeps. With `section`, cut
   * them by that plane too, or by none for null. What the person had
   * chosen is remembered (`shownByAgent`) and is what the scene file goes on
   * saying; this counts as no edit of theirs. With `scans`, each scan named
   * is looked at that way too (what is left out of one keeps its value).
   */
  showForAgent(layout: string, visible: Record<string, boolean>, section?: SectionPlane | null, scans?: Record<string, ScanView>): void {
    const s = store.getState()
    if (!s.scene?.layouts.includes(layout)) return
    const theirs = { ...s.shownByAgent, visible: { ...s.shownByAgent?.visible } }
    let next: Partial<TornoState> = {}
    if (layout !== s.layout) {
      next = layoutChange(s, layout)
      if (theirs.layout === undefined) theirs.layout = s.layout
      if (theirs.layout === layout) delete theirs.layout // back to what they had
    }
    let layers = s.layers
    for (const [name, on] of Object.entries(visible)) {
      const was = layers[name]?.visible
      if ((was !== false) === on) continue
      if (!(name in theirs.visible)) theirs.visible[name] = was
      else if ((theirs.visible[name] !== false) === on) delete theirs.visible[name]
      layers = { ...layers, [name]: { ...layers[name], visible: on } }
    }
    if (section !== undefined && !samePlane(section, s.section)) {
      next.section = section
      if (!theirs.section) theirs.section = { theirs: s.section }
      else if (samePlane(theirs.section.theirs, section)) delete theirs.section // back to what they had
    }
    let scanViews = s.scanViews
    const had: Record<string, ScanView | undefined> = { ...theirs.scans }
    for (const [id, view] of Object.entries(scans ?? {})) {
      const shown = { ...scanViews[id], ...view }
      if (sameScanView(shown, scanViews[id])) continue
      if (!(id in had)) had[id] = scanViews[id]
      else if (sameScanView(shown, had[id])) {
        // Back to what they had: as they had it, to the letter, and nothing is left to remember of it.
        const { [id]: theirsAgain, ...rest } = scanViews
        scanViews = theirsAgain === undefined || had[id] === undefined ? rest : { ...rest, [id]: had[id] }
        delete had[id]
        continue
      }
      scanViews = { ...scanViews, [id]: shown }
    }
    if (Object.keys(had).length > 0) theirs.scans = had
    else delete theirs.scans
    const none = theirs.layout === undefined && Object.keys(theirs.visible).length === 0 && !theirs.section && !theirs.scans
    store.setState({ ...next, layers, scanViews, shownByAgent: none ? null : theirs })
  },

  /** The marks of an object, as loaded or as changed. Those of an object that is not the open one are not kept. */
  setMarks(m: { objectId: string; marks: Mark[] }): void {
    const s = store.getState()
    if (m.objectId !== s.objectId) return
    // A mark that is gone is no longer the active one. One whose note was opened
    // the moment main kept it may not have been told of yet: it stays until it has been.
    const awaited = s.noting !== null && s.noting === s.activeMark && !s.marks.some((mark) => mark.id === s.noting)
    const activeMark = awaited || m.marks.some((mark) => mark.id === s.activeMark) ? s.activeMark : null
    store.setState({ marks: m.marks, activeMark, noting: activeMark === null ? null : s.noting })
  },

  /** The scans of an object, as listed or as changed. Those of an object that is not the open one are not kept. */
  setScans(m: { objectId: string; scans: ScanInfo[] }): void {
    const s = store.getState()
    if (m.objectId !== s.objectId) return
    // How a scan that is gone was looked at goes with it: ids are never given again. Not the person's doing: no edit.
    const kept = Object.entries(s.scanViews).filter(([id]) => m.scans.some((scan) => scan.id === id))
    // And what was remembered of how the person had it, where the agent shows it otherwise.
    const shownByAgent = withoutScans(s.shownByAgent, (id) => !m.scans.some((scan) => scan.id === id))
    store.setState({ scans: m.scans, scansKnown: true, scanViews: kept.length === Object.keys(s.scanViews).length ? s.scanViews : Object.fromEntries(kept), shownByAgent })
  },

  /** A file was given to main to read as a scan of the open object: said from now, before the process has said anything. */
  startImporting(name: string): void {
    store.setState({ importing: { name, stage: null } })
  },

  /** Reading that file is over, read or refused. Nothing when another is being read by now. */
  endImporting(name: string): void {
    if (store.getState().importing?.name === name) store.setState({ importing: null })
  },

  /** Change how one scan is looked at, by hand; what is left out keeps its value. It is what the scene file keeps. */
  setScanView(id: string, view: ScanView): void {
    const s = store.getState()
    const shown = { ...s.scanViews[id], ...view }
    // Their own choice from here on, for what they set: where the agent shows that scan otherwise, what they have
    // just set is theirs, and what they did not touch stays the agent's on screen and theirs as they had it.
    let shownByAgent = s.shownByAgent
    if (shownByAgent?.scans && id in shownByAgent.scans) {
      const theirs = { ...shownByAgent.scans[id], ...view }
      shownByAgent = sameScanView(shown, theirs) ? withoutScans(shownByAgent, (one) => one === id) : { ...shownByAgent, scans: { ...shownByAgent.scans, [id]: theirs } }
    }
    store.setState({ scanViews: { ...s.scanViews, [id]: shown }, edits: s.edits + 1, shownByAgent })
  },

  /** What the import of a scan into an object is doing; no stage when it is over. Of another object than the open one, nothing is kept. */
  setImporting(m: { objectId: string; name: string; stage: string | null }): void {
    const s = store.getState()
    if (m.objectId !== s.objectId) return
    if (m.stage !== null) store.setState({ importing: { name: m.name, stage: m.stage } })
    else if (s.importing?.name === m.name) store.setState({ importing: null })
  },

  /** Brings a scan into view with the parts, without turning the camera: "Frame" on its row. */
  frameScan(id: string): void {
    store.setState({ scanFramed: { id, n: (store.getState().scanFramed?.n ?? 0) + 1 } })
  },

  /** Which scans the view cuts, as the viewport found them now: set only when they are others than before. */
  setScansClipped(ids: readonly string[]): void {
    const had = store.getState().scansClipped
    if (ids.length !== had.length || ids.some((id, n) => id !== had[n])) store.setState({ scansClipped: ids.length === 0 ? NOT_CLIPPED : [...ids] })
  },

  /** Why what was asked of the scans came to nothing, for the panel to say; null puts it away. */
  setScansRefused(message: string | null): void {
    if (message !== store.getState().scansRefused) store.setState({ scansRefused: message })
  },

  /** Main said what was wrong with an object's scans file. It stays until it is dismissed or another object is opened. */
  setScansProblem(m: { objectId: string; message: string }): void {
    if (m.objectId === store.getState().objectId) store.setState({ scansProblem: m.message })
  },

  dismissScansProblem(): void {
    store.setState({ scansProblem: null })
  },

  /** Make a mark of the open object the active one, or none. The note that was open is of another mark: it closes. */
  setActiveMark(id: string | null): void {
    const s = store.getState()
    if (id !== s.activeMark && (id === null || s.marks.some((m) => m.id === id))) store.setState({ activeMark: id, noting: null })
  },

  /**
   * Open the note of a mark over the viewport, and make the mark the active
   * one. For a mark just made, which main may not have told of yet; one of
   * another object or another layout than is shown opens nothing.
   */
  openNote(m: { objectId: string; layout: string; id: string }): void {
    const s = store.getState()
    if (m.objectId === s.objectId && m.layout === s.layout) store.setState({ activeMark: m.id, noting: m.id })
  },

  /** Close the note that is open; its mark stays the active one. */
  closeNote(): void {
    if (store.getState().noting !== null) store.setState({ noting: null })
  },

  /**
   * Make a mark the active one and go to the view it was placed from, in its
   * own layout: the layout is switched first when it is another, so the
   * column and the viewport follow. Nothing for a mark whose layout the
   * build no longer has.
   */
  focusMark(id: string): void {
    const before = store.getState()
    const mark = before.marks.find((m) => m.id === id)
    // A mark of a layout the build no longer has cannot be shown: nothing is made of it, and the row says why.
    // A region is of its scan in every layout: it is gone to where the person is.
    if (!mark || (mark.kind !== 'region' && before.scene !== null && !before.scene.layouts.includes(mark.layout))) return
    if (mark.kind !== 'region') actions.setLayout(mark.layout)
    const s = store.getState()
    store.setState({ activeMark: id, markFocus: s.markFocus + 1, noting: s.noting === id ? id : null })
  },

  /** Main said what was wrong with an object's marks file. It stays until it is dismissed or another object is opened. */
  setMarksProblem(m: { objectId: string; message: string }): void {
    if (m.objectId === store.getState().objectId) store.setState({ marksProblem: m.message })
  },

  /** The person has read what was wrong with the marks file. */
  dismissMarksProblem(): void {
    store.setState({ marksProblem: null })
  },

  /**
   * Select these refs and no others; none to clear. `at` says where some of
   * them were clicked; a ref that stays selected keeps where it was clicked
   * unless `at` says anew.
   */
  setSelection(refs: string[], at: Record<string, PickedAt> = NOTHING_PICKED): void {
    const { selection, picked } = store.getState()
    const same = refs.length === selection.length && refs.every((ref, i) => ref === selection[i])
    if (same && Object.keys(at).length === 0) return
    if (refs.length === 0) return store.setState(NO_SELECTION)
    const kept: Record<string, PickedAt> = {}
    for (const ref of refs) {
      const where = at[ref] ?? picked[ref]
      if (where) kept[ref] = where
    }
    store.setState({ selection: same ? selection : [...new Set(refs)], picked: kept })
  },

  /** Add a ref to the selection, clicked at `at`, or take it out if it is there. */
  toggleSelection(ref: string, at?: PickedAt): void {
    const { selection } = store.getState()
    if (selection.includes(ref)) actions.setSelection(selection.filter((r) => r !== ref))
    else actions.setSelection([...selection, ref], at ? { [ref]: at } : NOTHING_PICKED)
  },

  setOrtho(ortho: boolean): void {
    store.setState({ ortho })
  },

  setLockedView(lockedView: ViewName | null): void {
    if (lockedView !== store.getState().lockedView) store.setState({ lockedView })
  },

  /** A session was started in an object, replacing the one it had. */
  setSession(objectId: string, session: SessionView): void {
    store.setState({ sessions: { ...store.getState().sessions, [objectId]: session } })
  },

  /** A session changed status. One that is no longer the session of its object is not followed. */
  applySessionStatus(m: { sessionId: string; status: SessionStatus }): void {
    const { sessions } = store.getState()
    const objectId = Object.keys(sessions).find((id) => sessions[id].sessionId === m.sessionId)
    if (objectId === undefined || sessions[objectId].status === m.status) return
    store.setState({ sessions: { ...sessions, [objectId]: { sessionId: m.sessionId, status: m.status } } })
  }
}

/** The session of the open object that an agent is running in, if any: where a ref can be inserted. */
export function runningSession(s: TornoState): SessionView | undefined {
  const session = s.objectId ? s.sessions[s.objectId] : undefined
  return session && session.status !== 'exited' ? session : undefined
}

/** The parts of the layout shown, in the scene's order. */
export function partsInLayout(s: TornoState, layout = s.layout): Part[] {
  return s.scene ? s.scene.parts.filter((p) => p.layout === layout) : []
}

/** Keys of the parts of a layout that are switched on. */
export function visibleKeys(s: TornoState, layout = s.layout): string[] {
  return partsInLayout(s, layout)
    .filter((p) => s.layers[p.name]?.visible !== false)
    .map((p) => p.key)
}

/**
 * What `<object>/.torno/scene.json` should hold for the open object: the
 * layout, the layers, the section and how each scan is looked at, as the
 * person chose them. Where the
 * agent's `show` has something else on screen, it is the person's choice that
 * is kept.
 */
export function sceneFileOf(s: TornoState): SceneFile {
  const layout = s.shownByAgent?.layout ?? s.layout
  const layers = { ...s.layers }
  for (const [name, visible] of Object.entries(s.shownByAgent?.visible ?? {})) {
    const { visible: _theAgents, ...rest } = layers[name] ?? {}
    const theirs = visible === undefined ? rest : { ...rest, visible }
    if (Object.keys(theirs).length > 0) layers[name] = theirs
    else delete layers[name]
  }
  const section = s.shownByAgent?.section ? s.shownByAgent.section.theirs : s.section
  const scans = { ...s.scanViews }
  for (const [id, theirs] of Object.entries(s.shownByAgent?.scans ?? {})) {
    if (theirs === undefined) delete scans[id]
    else scans[id] = theirs
  }
  return { ...(layout ? { layout } : {}), layers, ...(section ? { section } : {}), ...(Object.keys(scans).length > 0 ? { scans } : {}) }
}

/** Whether two ways of looking at a scan draw it the same: what is left out has its default (on, solid, in its own colours). */
function sameScanView(a: ScanView | undefined, b: ScanView | undefined): boolean {
  return (a?.visible !== false) === (b?.visible !== false) && (a?.opacity ?? 1) === (b?.opacity ?? 1) && (a?.colour ?? 'own') === (b?.colour ?? 'own')
}

/** What the agent has shown, without what was remembered of the scans `gone` says yes to; null when nothing of it is left. */
function withoutScans(shown: TornoState['shownByAgent'], gone: (id: string) => boolean): TornoState['shownByAgent'] {
  if (!shown?.scans || !Object.keys(shown.scans).some(gone)) return shown
  const { scans, ...rest } = shown
  const kept = Object.fromEntries(Object.entries(scans).filter(([id]) => !gone(id)))
  if (Object.keys(kept).length > 0) return { ...rest, scans: kept }
  return rest.layout === undefined && Object.keys(rest.visible).length === 0 && !rest.section ? null : rest
}

/** Whether two sections are the same: both none, or the same plane to the last digit. */
export function samePlane(a: SectionPlane | null, b: SectionPlane | null): boolean {
  if (a === null || b === null) return a === b
  return a.origin.every((c, i) => c === b.origin[i]) && a.normal.every((c, i) => c === b.normal[i])
}

/** What changes with the layout shown: the selection and the note go, and the active mark unless it is of that layout. */
function layoutChange(s: TornoState, layout: string): Partial<TornoState> {
  // A mark is of one layout: the active one does not follow to another.
  const active = s.marks.find((m) => m.id === s.activeMark)
  const activeMark = active && (active.kind === 'region' || active.layout === layout) ? s.activeMark : null
  // A note is written where its mark can be seen: it closes.
  return { layout, ...NO_SELECTION, activeMark, noting: null }
}

/** Whether two scenes hold the same parts: the same keys, each with the same hash. */
function sameParts(a: Scene, b: Scene): boolean {
  if (a.parts.length !== b.parts.length) return false
  const hashes = new Map(a.parts.map((p) => [p.key, p.hash]))
  return b.parts.every((p) => hashes.get(p.key) === p.hash)
}

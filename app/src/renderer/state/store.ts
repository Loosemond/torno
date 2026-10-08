import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { SessionStatus } from '../../shared/bridge'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import type { LayerSettings, SceneFile } from '../../shared/scenefile'
import type { WorkspaceInfo } from '../../shared/workspace'

/** The agent session of an object. Its output is not here: it goes straight into the terminal. */
export interface SessionView {
  sessionId: string
  status: SessionStatus
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
  ortho: boolean
  /** Counts changes of layout and layers made by hand: what the scene file is saved for. */
  edits: number
  /** By object id: the session started there, running or ended. It outlives the object being shown. */
  sessions: Record<string, SessionView>
}

const NO_OBJECT = { objectId: null, build: null, scene: null, revision: 0, layout: '', layers: {} }

export const store = createStore<TornoState>(() => ({
  workspace: null,
  workspaceKnown: false,
  versions: {},
  ...NO_OBJECT,
  ortho: false,
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
    store.setState({ ...NO_OBJECT, objectId, layout: file.layout ?? '', layers: file.layers })
  },

  applyBuild(build: BuildState): void {
    if (build.objectId === store.getState().objectId) store.setState({ build })
  },

  /**
   * A build of the open object succeeded. False when there is nothing new to
   * show: a scene of another object, or the revision already here (main sends
   * the last scene again when an object is opened).
   */
  applyScene(m: { objectId: string; revision: number; scene: Scene }): boolean {
    const s = store.getState()
    if (m.objectId !== s.objectId) return false
    if (s.scene && m.revision === s.revision) return false
    const layout = m.scene.layouts.includes(s.layout) ? s.layout : (m.scene.layouts[0] ?? '')
    const names = new Set(m.scene.parts.map((p) => p.name))
    const kept = Object.entries(s.layers).filter(([name]) => names.has(name))
    const layers = kept.length === Object.keys(s.layers).length ? s.layers : Object.fromEntries(kept)
    store.setState({ scene: m.scene, revision: m.revision, layout, layers })
    return true
  },

  setLayout(layout: string): void {
    const s = store.getState()
    if (layout === s.layout || !s.scene?.layouts.includes(layout)) return
    store.setState({ layout, edits: s.edits + 1 })
  },

  /** Change some settings of one part; the others keep their values. */
  setLayer(name: string, settings: LayerSettings): void {
    const s = store.getState()
    store.setState({ layers: { ...s.layers, [name]: { ...s.layers[name], ...settings } }, edits: s.edits + 1 })
  },

  setOrtho(ortho: boolean): void {
    store.setState({ ortho })
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

/** What `<object>/.torno/scene.json` should hold for the open object. */
export function sceneFileOf(s: TornoState): SceneFile {
  return { ...(s.layout ? { layout: s.layout } : {}), layers: s.layers }
}

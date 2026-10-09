import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BuildState } from '../shared/build'
import type { Described } from '../shared/geometry'
import type { MarkPatch, NewMark, NewRegion, Replacement } from '../shared/marks'
import { type AlignMade, type NewAlignment, type ScanInfo, type ScanUnit, type ScanUp, SCAN_FORMATS, alignmentOf, standingOf } from '../shared/scans'
import type { Scene } from '../shared/scene'
import type { SceneFile } from '../shared/scenefile'
import type { ViewState } from '../shared/view'
import type { ObjectInfo, WorkspaceInfo } from '../shared/workspace'
import { Builds, buildTimeout, watchFolder } from './builds'
import { KernelError, type KernelClient, startKernel } from './kernel/client'
import { toArrayBuffer } from './kernel/frames'
import { forgetViews, reportView, resolveRequest } from './look'
import { type AskedAnchor, type Retrying, asPlaced, asReplaced, checkMarks, followMarks, nearestReply, retrying } from './marks/reanchor'
import { addDimension, dueAfterEdit, remeasure } from './marks/measure'
import { type RegionDeps, addRegion, convertScan, removeMark, repaintRegion, tendRegions } from './marks/regions'
import type { MarkStore } from './marks/store'
import { kernelDir } from './paths'
import { type AlignCheckDeps, checkingAlignments, heldNow, keepChecking, tiedToMoved, uncheckedOn } from './scans/alignCheck'
import { frameOf } from './scans/alignments'
import type { ScanStore } from './scans/store'
import { loadSceneFile, saveSceneFile } from './scenefile'
import type { Sessions } from './sessions/manager'
import { sessionOfWorkspace } from './sessions/status'
import { scanOrder, scanWorkspace } from './workspace'

// Channel names, repeated in src/preload/index.ts.
//   invoke: workspace:current, workspace:pick, workspace:open, workspace:versions,
//           object:open, object:rebuild, object:sceneFile,
//           session:current, session:start, session:stop,
//           marks:list, marks:add, marks:update, marks:remove, marks:replace, marks:problem (also sent to the renderer),
//           marks:dismissProblem, geometry:describe,
//           scans:list, scans:pick, scans:import, scans:convert, scans:rename, scans:remove, scans:align, scans:mesh,
//           scans:problem (also sent to the renderer), scans:dismissProblem, scans:reimport, scans:undoAlign, scans:alignHolds
//   from the renderer: object:saveSceneFile, view:report, view:lookReply, view:showReply, view:highlightReply,
//           view:drawSectionReply, session:write, session:resize, session:insert
//   to the renderer: object:build, object:scene, view:look, view:show, view:highlight, view:drawSection (sent by src/main/look.ts),
//           session:data, session:status, workspace:requested (sent by src/main/index.ts),
//           marks:changed, marks:problem, scans:changed, scans:progress, scans:problem

interface OpenWorkspace {
  info: WorkspaceInfo // as of the newest scan that has ended
  /** Scans overlap (a burst of changes in two folders, an object opened meanwhile): an older one never replaces a newer. */
  scan: () => () => boolean
  /** Has the marks of an object checked against its last build (see `openWorkspace`). */
  reanchor?: Retrying
  /** Has the alignments of an object's scans checked against its last build. */
  alignChecks?: Retrying
  /** How the model is asked where the points of an alignment are. */
  nearest?: AlignCheckDeps['nearest']
  /** Stops the asking again, every 30 s, for alignments that were not checked. */
  stopChecking?: () => void
  kernel: KernelClient
  builds: Builds
  opened: Set<string> // ids of the objects being watched and built
  shown: string | null // the object the window shows: the last one it opened
}

let current: OpenWorkspace | null = null

/** The agent sessions, once `registerIpc` has been given them. They belong to the objects of the open workspace. */
let sessions: Sessions | null = null

/** The marks of the objects of the open workspace, once `registerIpc` has been given them. */
let marks: MarkStore | null = null

/** The scans of the objects of the open workspace, once `registerIpc` has been given them. */
let scans: ScanStore | null = null

/** By object: how many checks of its marks against a build were started, and how many have ended. */
const checks = new Map<string, { started: number; finished: number }>()

/** How many checks of an object's marks against its build were started and have ended: equal when none is under way. For tests. */
export function marksChecks(objectId: string): { started: number; finished: number } {
  return { ...(checks.get(objectId) ?? { started: 0, finished: 0 }) }
}

/**
 * The scans of an object were asked for (a tool, the prompt's line): when an alignment among them was not
 * checked against the last build, it is asked for again. A check that gave up is not given up for good.
 */
export function recheckAlignments(objectId: string, listed: ScanInfo[]): void {
  const last = current?.builds.scene(objectId)
  if (last && uncheckedOn(listed, last.scene.layouts, last.revision)) current?.alignChecks?.(objectId)
}

/** Told where the build of an object stands, each time that changes, once `registerIpc` has been given it. */
let onBuild: ((state: BuildState) => void) | null = null

/** Told that the workspace was left, with what was known of its objects. */
let onWorkspaceClosed: (() => void) | null = null

function broadcast(channel: string, message: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, message)
  }
}

/** Open a workspace: scan it and start a kernel for it. Replaces the one open. */
export async function openWorkspace(root: string): Promise<WorkspaceInfo> {
  const info = await scanWorkspace(resolve(root))
  // Until none is open: another call may have opened one while this one waited.
  while (current) await closeWorkspace()

  const kernel = startKernel({ workspaceRoot: info.root, hasProject: info.hasProject, kernelDir: kernelDir() })
  const builds: Builds = new Builds({
    kernel,
    timeout: buildTimeout(process.env),
    // Which file is an object's model can change with its folder's contents (a
    // first candidate added, the model renamed), so a change there is a reason
    // to choose again before building. The choice is `builds.choice`: an open
    // object keeps its model while that file exists.
    watch: (dir, onChange) =>
      watchFolder(dir, (paths) => {
        void rescan(ws).then(() => {
          if (current !== ws) return
          const obj = ws.info.objects.find((o) => o.dir === dir)
          if (!obj || !builds.update(obj)) onChange(paths)
        })
      })
  })
  const ws: OpenWorkspace = { info, scan: scanOrder(), kernel, builds, opened: new Set(), shown: null }
  builds.on('build', (state) => {
    broadcast('object:build', state)
    onBuild?.(state)
  })
  builds.on('scene', ({ objectId, revision, scene, blob }) =>
    broadcast('object:scene', { objectId, revision, scene, blob: toArrayBuffer(blob) })
  )
  // Every successful build may have renumbered the faces, moved the surfaces or dropped the parts that
  // marks are on: each mark is checked against it, and every dimension is then measured on it. One
  // check at a time per object; a build that succeeds during one is checked after it, and what was
  // found for the build before is dropped. A check that could not say of every mark, or measure
  // every dimension, is tried again after a while (`retrying`).
  // Only a check someone asked for (a mark placed or reopened) may have the object built again to be answered.
  const reanchor = retrying((objectId, restore) => {
    const store = marks
    if (!store) return Promise.resolve(true)
    const counted = checks.get(objectId) ?? { started: 0, finished: 0 }
    checks.set(objectId, counted)
    counted.started += 1
    return checkMarks(
      {
        marks: store,
        query: (id, name, args) => builds.query(id, name, args, { restore }),
        // None once the workspace is left: nothing is asked or written for it any more.
        scene: (id) => (current === ws ? builds.scene(id) : undefined)
      },
      objectId
    ).finally(() => (counted.finished += 1))
  })
  builds.on('scene', ({ objectId }) => reanchor(objectId))
  ws.reanchor = reanchor
  // And every alignment of its scans: whether the model is still under the points it was tied to, and whether
  // torno spreads the layout's parts as it did then. Found and said, never moved or fitted again.
  // A check that could not say is tried again after a while, three times (`retrying`), without ever having the
  // object built again; what it leaves unsaid is
  // not silence: an alignment with no check of the last build says "not checked against rN" wherever it is
  // reported (`standingOf`), and is checked again at the next build, or when the scans are next asked for.
  const nearest: AlignCheckDeps['nearest'] = async (id, layout, anchors: AskedAnchor[]) => nearestReply(await builds.query(id, 'nearest', { layout, anchors }), anchors)
  ws.nearest = nearest
  // A check by itself (after a build, every 30 s, when the scans are listed) never has the object built again:
  // a kernel that let the build go says so, that is said of the alignment, and the next build is waited for.
  // The scans' store is looked up at each run, as the marks' is above: a workspace opened before `registerIpc`
  // was given the scans has its alignments checked once it has been.
  let checking: { of: ScanStore; ask: Retrying } | null = null
  let ended = false
  const alignChecks: Retrying = Object.assign(
    (objectId: string, restore?: boolean): void => {
      const store = scans
      if (!store || ended) return
      if (checking?.of !== store) {
        checking?.ask.cancel()
        checking = { of: store, ask: checkingAlignments({ scans: store, scene: (id) => (current === ws ? builds.scene(id) : undefined), query: (id, name, args, opts) => builds.query(id, name, args, opts) }) }
      }
      checking.ask(objectId, restore)
    },
    {
      cancel(): void {
        ended = true
        checking?.ask.cancel()
      }
    }
  )
  builds.on('scene', ({ objectId }) => alignChecks(objectId))
  ws.alignChecks = alignChecks
  // Three quick retries are not the end of it: for as long as an alignment of an open object was not checked
  // against its last build, the check is asked for again every 30 s, and whenever its scans are listed.
  ws.stopChecking = keepChecking(
    () => [...ws.opened],
    async (objectId) => {
      if (current === ws && scans) recheckAlignments(objectId, await scans.list(objectId))
    }
  )
  current = ws
  return info
}

/**
 * Scan an open workspace again. Objects that are open keep the model they are
 * built from (`Builds.choice`), so the list says what is on screen. A scan
 * that fails leaves what was known.
 */
async function rescan(ws: OpenWorkspace): Promise<void> {
  const newest = ws.scan()
  const scanned = await scanWorkspace(ws.info.root).catch(() => null)
  if (scanned && current === ws && newest()) ws.info = { ...scanned, objects: scanned.objects.map((o) => ws.builds.choice(o)) }
}

export async function closeWorkspace(): Promise<void> {
  const ws = current
  if (!ws) return
  current = null
  forgetViews()
  // A check of its marks that failed is not tried again: its timers would outlive it.
  ws.reanchor?.cancel()
  ws.alignChecks?.cancel()
  ws.stopChecking?.()
  checks.clear()
  // The next workspace may have an object of the same name, or this folder may change while it is closed.
  marks?.forget()
  // And its scans: an import that is still running is stopped by whoever runs it, who is told next.
  scans?.forget()
  onWorkspaceClosed?.()
  // Not waited for: an agent that ignores the hangup is killed two seconds later.
  void sessions?.stopAll()
  for (const id of ws.opened) ws.builds.close(id)
  await ws.kernel.dispose()
}

function requireWorkspace(): OpenWorkspace {
  if (!current) throw new Error('no workspace is open')
  return current
}

/** The open workspace as of the last scan of it, or null when none is open. */
export function openWorkspaceInfo(): WorkspaceInfo | null {
  return current?.info ?? null
}

/** An object of the open workspace as of the last scan. The renderer and the agent name objects, never folders. */
export function findObject(id: string): ObjectInfo | undefined {
  return current?.info.objects.find((o) => o.id === id)
}

/** The object the window shows, which is the one its pictures are of. */
export function openObjectId(): string | null {
  return current?.shown ?? null
}

/** Where the build of an object stands, once the object has been opened. */
export function buildState(id: string): BuildState | undefined {
  return current?.builds.state(id)
}

/** The last successful build of an object. */
export function lastScene(id: string): { revision: number; scene: Scene } | undefined {
  return current?.builds.scene(id)
}

/**
 * A mark as it is kept when it is placed (`asPlaced`): a mark that is no mark
 * is handed on as it came, for the store to refuse.
 */
export function placedMark<M extends NewMark>(mark: M, objectId: string): M {
  const whole = typeof mark === 'object' && mark !== null && typeof mark.layout === 'string'
  try {
    return whole ? asPlaced(mark, lastScene(objectId)) : mark
  } catch {
    return mark
  }
}

/**
 * Ask the kernel about the last successful build of an open object (`Builds.query`): the object is
 * built again when the kernel no longer holds it. Rejects with a KernelError, also when no workspace is open.
 */
export function queryObject<T = unknown>(id: string, name: string, args: object): Promise<T> {
  if (!current) return Promise.reject(new KernelError('no_build', 'no workspace is open'))
  return current.builds.query<T>(id, name, args)
}

/**
 * `onWorkspaceChosen` is told the root of every workspace the person opens
 * from the window, so that it can be opened again at the next start.
 * `sessions` backs the session pane; without it there are no sessions.
 * `marks` backs the marks of the objects; without it there are none.
 * `onBuild` is told where the build of an object stands, each time that changes.
 * `pickFolder` answers "Open folder" in place of the dialog, which tests must
 * never open; `pickFile` answers "Import scan" likewise.
 * `scans` backs the scans of the objects; without it there are none.
 */
export function registerIpc(
  opts: {
    onWorkspaceChosen?: (root: string) => void
    sessions?: Sessions
    marks?: MarkStore
    onBuild?: (state: BuildState) => void
    /** The open workspace was left: object ids mean nothing any more. */
    onWorkspaceClosed?: () => void
    /** Stands in for the folder dialog: the folder to open, or null for none. */
    pickFolder?: () => Promise<string | null>
    scans?: ScanStore
    /** Stands in for the file dialog: the file to import, or null for none. */
    pickFile?: () => Promise<string | null>
  } = {}
): void {
  sessions = opts.sessions ?? null
  sessions?.on('data', (m) => broadcast('session:data', m))
  sessions?.on('status', (m) => broadcast('session:status', m))
  const requireSessions = (): Sessions => {
    if (!sessions) throw new Error('sessions are not available')
    return sessions
  }

  onBuild = opts.onBuild ?? null
  onWorkspaceClosed = opts.onWorkspaceClosed ?? null
  marks = opts.marks ?? null
  marks?.on('changed', (m) => broadcast('marks:changed', m))
  marks?.on('problem', (m) => broadcast('marks:problem', m))
  // A mark added, or reopened, has not been checked against the build there is: no build is on its way to do it.
  if (marks) followMarks(marks, (objectId, restore) => current?.reanchor?.(objectId, restore))
  const requireMarks = (): MarkStore => {
    if (!marks) throw new Error('marks are not available')
    return marks
  }

  const chosen = (info: WorkspaceInfo): WorkspaceInfo => {
    opts.onWorkspaceChosen?.(info.root)
    return info
  }

  ipcMain.handle('workspace:current', () => current?.info ?? null)

  ipcMain.handle('workspace:pick', async (event) => {
    if (opts.pickFolder) {
      const folder = await opts.pickFolder()
      return folder === null ? null : chosen(await openWorkspace(folder))
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Open folder', properties: ['openDirectory', 'createDirectory'] }
    // Where objects usually live, suggested until a workspace has been chosen.
    const usual = join(homedir(), 'objects')
    if (current) options.defaultPath = current.info.root
    else if (existsSync(usual)) options.defaultPath = usual
    const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    if (picked.canceled || picked.filePaths.length === 0) return null
    return chosen(await openWorkspace(picked.filePaths[0]))
  })

  ipcMain.handle('workspace:open', async (_event, root: string) => chosen(await openWorkspace(root)))

  ipcMain.handle('workspace:versions', async () => {
    const ws = requireWorkspace()
    return (await ws.kernel.ready).versions
  })

  ipcMain.handle('object:open', async (event, id: string): Promise<BuildState> => {
    const ws = requireWorkspace()
    // From here on the window shows this object, whatever comes of building it.
    ws.shown = id
    ws.builds.show(id)
    // Scanned afresh: the agent may have created the folder a moment ago.
    const newest = ws.scan()
    const scanned = await scanWorkspace(ws.info.root)
    // The workspace may have been closed or replaced during the scan; its kernel is then gone.
    if (current !== ws) throw new Error(`the workspace ${ws.info.root} was closed`)
    if (newest()) ws.info = { ...scanned, objects: scanned.objects.map((o) => ws.builds.choice(o)) }
    const obj = ws.info.objects.find((o) => o.id === id)
    if (!obj) throw new Error(`no object named ${id} in ${ws.info.root}`)
    const state = ws.builds.open(obj)
    ws.opened.add(id)
    // A renderer that subscribes after a build has missed its scene event.
    const last = ws.builds.scene(id)
    if (last) event.sender.send('object:scene', { objectId: id, ...last, blob: toArrayBuffer(last.blob) })
    return state
  })

  ipcMain.handle('object:rebuild', (_event, id: string) => {
    requireWorkspace().builds.rebuild(id)
  })

  ipcMain.handle('object:sceneFile', (_event, id: string): Promise<SceneFile> => {
    const obj = findObject(id)
    return obj ? loadSceneFile(obj.dir) : Promise.resolve({ layers: {} })
  })

  ipcMain.on('object:saveSceneFile', (_event, id: string, file: SceneFile) => {
    const obj = findObject(id)
    if (!obj) return
    saveSceneFile(obj.dir, file).catch((e) => console.error(`cannot save the scene file of ${id}: ${e.message}`))
  })

  ipcMain.handle('session:current', (_event, objectId: string) => {
    const obj = findObject(objectId)
    const running = sessions?.current(objectId) ?? null
    return {
      running: running && { sessionId: running.sessionId, status: running.status },
      resumable: obj !== undefined && sessions !== null && sessions.resumable(obj)
    }
  })

  ipcMain.handle('session:start', (_event, objectId: string, opts?: { resume?: boolean; cols?: number; rows?: number }) => {
    const obj = findObject(objectId)
    if (!obj) throw new Error(`no object named ${objectId} in the open workspace`)
    return requireSessions().start(obj, { resume: opts?.resume === true, cols: opts?.cols, rows: opts?.rows })
  })

  ipcMain.handle('session:stop', (_event, sessionId: string) => sessions?.stop(String(sessionId)))

  // What a window types or inserts goes only to a session the manager has in a folder of the open
  // workspace: the window names a session, and is not taken at its word.
  const ofThisWorkspace = (sessionId: string): boolean => sessions !== null && sessionOfWorkspace(sessions.objectOf(sessionId), current?.info.root)

  ipcMain.on('session:write', (_event, sessionId: string, data: string) => {
    if (typeof data === 'string' && ofThisWorkspace(String(sessionId))) sessions?.write(String(sessionId), data)
  })

  ipcMain.on('session:insert', (_event, sessionId: string, text: string) => {
    if (typeof text === 'string' && ofThisWorkspace(String(sessionId))) sessions?.insert(String(sessionId), text)
  })

  ipcMain.on('session:resize', (_event, sessionId: string, cols: number, rows: number) => {
    sessions?.resize(String(sessionId), cols, rows)
  })

  // The renderer names the object; the store finds its folder, and rejects an object the workspace does not have.
  ipcMain.handle('marks:list', (_event, objectId: string) => requireMarks().list(String(objectId)))
  // A mark made in the window is the person's. The agent's come through its tools, which call the store themselves.
  // What only main says of a mark is said here: how far its part is spread on the build it was placed on.
  // A dimension is measured as it is kept (`addDimension`): its value is the kernel's, never the window's.
  const measuring = (store: MarkStore) => ({ marks: store, query: queryObject, scene: lastScene })
  ipcMain.handle('marks:add', (_event, objectId: string, mark: NewMark) => {
    const placed = placedMark({ ...mark, author: 'user' }, String(objectId))
    return placed.kind === 'dimension' ? addDimension(measuring(requireMarks()), String(objectId), placed) : requireMarks().add(String(objectId), placed)
  })
  // Whoever resolves a mark from the window is the person.
  ipcMain.handle('marks:update', async (_event, objectId: string, id: string, patch: MarkPatch) => {
    const store = requireMarks()
    const changed = await store.update(String(objectId), String(id), patch, 'user')
    // What a dimension should measure was changed: its verdict is already judged anew from the value it has.
    // One with no value of the last build is measured again, where that can be done now (`dueAfterEdit`).
    if (dueAfterEdit(patch, changed, lastScene(String(objectId))?.revision)) void remeasure(measuring(store), String(objectId), changed)
    return changed
  })
  // With a region goes the mask that held its triangles.
  const regions = (): RegionDeps => ({ marks: requireMarks(), scans: requireScans() })
  ipcMain.handle('marks:remove', (_event, objectId: string, id: string) => (scans ? removeMark(regions(), String(objectId), String(id)) : requireMarks().remove(String(objectId), String(id))))
  // What the person painted on a scan: main works out what it is from the mesh, and writes its triangles beside it.
  ipcMain.handle('marks:addRegion', (_event, objectId: string, region: NewRegion) => addRegion(regions(), String(objectId), region))
  // A region painted again: the same mark, of the triangles sent; main writes them as a new mask and says the numbers anew.
  ipcMain.handle('marks:repaintRegion', (_event, objectId: string, id: string, bits: Uint8Array) => repaintRegion(regions(), String(objectId), String(id), bits))
  ipcMain.handle('marks:replace', async (_event, objectId: string, id: string, placed: Replacement) => {
    const store = requireMarks()
    const layout = (await store.list(String(objectId))).find((m) => m.id === String(id))?.layout
    return store.replace(String(objectId), String(id), layout === undefined ? placed : asReplaced(placed, layout, lastScene(String(objectId))))
  })
  ipcMain.handle('marks:problem', (_event, objectId: string) => requireMarks().problem(String(objectId)))
  ipcMain.handle('marks:dismissProblem', (_event, objectId: string) => requireMarks().dismissProblem(String(objectId)))

  scans = opts.scans ?? null
  scans?.on('changed', (m) => broadcast('scans:changed', m))
  scans?.on('progress', (m) => broadcast('scans:progress', m))
  scans?.on('problem', (m) => broadcast('scans:problem', m))
  const requireScans = (): ScanStore => {
    if (!scans) throw new Error('scans are not available')
    return scans
  }

  /** Has the alignments of an object's scans checked against its last build once something was done to them. */
  const checked = <T>(objectId: string, kept: Promise<T>): Promise<T> =>
    kept.then((info) => {
      // The person did this: the object may be built again for the check.
      current?.alignChecks?.(objectId, true)
      return info
    })
  // As for the marks: the renderer names the object, and the store finds its folder.
  ipcMain.handle('scans:list', async (_event, objectId: string) => {
    const listed = await requireScans().list(String(objectId))
    // The window asks: an alignment that was not checked against the last build is asked about again.
    recheckAlignments(String(objectId), listed)
    // And a region whose scan or whose mask was lost while torno was not looking says so.
    if (marks) void tendRegions(regions(), String(objectId)).catch((e) => console.error(`cannot check the regions of ${String(objectId)} against its scans: ${e instanceof Error ? e.message : String(e)}`))
    return listed
  })
  ipcMain.handle('scans:pick', async (event): Promise<string | null> => {
    if (opts.pickFile) return opts.pickFile()
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Import scan', properties: ['openFile'], filters: [{ name: 'Scans', extensions: SCAN_FORMATS.map((format) => format.slice(1)) }] }
    const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })
  ipcMain.handle('scans:import', (_event, objectId: string, path: string) => requireScans().import(String(objectId), path))
  // Read again, a scan may be another mesh: what the last build makes of its alignments is asked anew.
  // What was painted on it was painted on the mesh it had: of another mesh, or of the same count from another file, its regions are of nothing.
  ipcMain.handle('scans:reimport', async (_event, objectId: string, id: string) => {
    const read = await checked(String(objectId), requireScans().reimport(String(objectId), String(id)))
    if (read.meshChanged || read.sourceChanged) await marks?.orphanRegions(String(objectId), read.scan.id)
    return read
  })
  // Its triangles are the same and are elsewhere: what its regions say of themselves is worked out again from the mesh it has now.
  ipcMain.handle('scans:convert', (_event, objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }) =>
    marks ? convertScan(regions(), String(objectId), String(id), as) : requireScans().convert(String(objectId), String(id), as)
  )
  ipcMain.handle('scans:rename', (_event, objectId: string, id: string, name: string) => requireScans().rename(String(objectId), String(id), name))
  // Its regions go on as marks, with their notes, and say that their scan is gone.
  ipcMain.handle('scans:remove', async (_event, objectId: string, id: string) => {
    await requireScans().remove(String(objectId), String(id))
    await marks?.orphanRegions(String(objectId), String(id))
  })
  ipcMain.handle('scans:problem', (_event, objectId: string) => requireScans().problem(String(objectId)))
  ipcMain.handle('scans:dismissProblem', (_event, objectId: string) => requireScans().dismissProblem(String(objectId)))
  // What only main says of an alignment is said here: how the parts of that layout are spread on the last build,
  // when, and which build that is. An alignment is of the build it was fitted on: one made on another than the
  // last is refused, as a dimension placed on another is. Then it is checked against that build, like every other.
  ipcMain.handle('scans:align', (_event, objectId: string, id: string, layout: string, alignment: NewAlignment | null, made?: AlignMade) => {
    if (alignment === null || alignment === undefined) return requireScans().align(String(objectId), String(id), layout, null)
    const last = lastScene(String(objectId))
    const frame = frameOf(last?.scene, layout)
    if (!last || !frame) throw new Error(`no build of this object has a layout named ${String(layout)}: there is nothing to align the scan to`)
    const revision = Object(made).revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new Error('an alignment says which build it was made on')
    if (revision !== last.revision) throw new Error(`that alignment was made on r${revision}, the build is r${last.revision}: align again`)
    const moved = tiedToMoved(Object(alignment), frame)
    if (moved.length > 0) throw new Error(`torno moved ${moved.join(', ')} for display in ${layout}: align to a part it did not move, or in a layout that places the parts as assembled`)
    const accepted = { rough: Object(made).rough === true, scaled: Object(made).scaled === true }
    return checked(String(objectId), requireScans().align(String(objectId), String(id), layout, { ...Object(alignment), frame, at: new Date().toISOString(), revision }, accepted))
  })
  ipcMain.handle('scans:undoAlign', (_event, objectId: string, id: string, layout: string) => checked(String(objectId), requireScans().undoAlign(String(objectId), String(id), layout)))
  // "Still right": the model as it stands now is what the alignment is held against from here on, and that is asked of the kernel first.
  ipcMain.handle('scans:alignHolds', async (_event, objectId: string, id: string, layout: string) => {
    const ws = requireWorkspace()
    const scan = (await requireScans().list(String(objectId))).find((one) => one.id === String(id))
    const alignment = scan ? alignmentOf(scan, String(layout)) : null
    if (!scan || !alignment) throw new Error(`${String(id)} is not aligned in ${String(layout)}`)
    // The only doubt is that the scan was read again, and the last build's check found the model where it was:
    // there is nothing of the model to hold it against anew, and nothing to ask the kernel, which may be busy.
    const standing = standingOf(scan, String(layout), lastScene(String(objectId))?.revision)
    const check = scan.checks[String(layout)]
    if (alignment.sourceChanged && !standing.unchecked && check && check.off === 0 && check.moved.length === 0) return requireScans().alignmentHolds(String(objectId), String(id), String(layout), null)
    const holds = await heldNow({ scene: (o) => lastScene(o), nearest: ws.nearest! }, String(objectId), String(layout), alignment)
    return checked(String(objectId), requireScans().alignmentHolds(String(objectId), String(id), String(layout), holds))
  })
  // A copy with a buffer of its own, as the blob of a scene is sent.
  ipcMain.handle('scans:mesh', async (_event, objectId: string, id: string) => toArrayBuffer(await requireScans().mesh(String(objectId), String(id))))
  ipcMain.handle('scans:mask', async (_event, objectId: string, id: string, markId: string) => toArrayBuffer(await requireScans().mask(String(objectId), String(id), String(markId))))

  // What the kernel says of a part, a face or an edge of an object's last good build, for what the pointer rests
  // on (`Builds.describe`): never a reason to have the object built again.
  ipcMain.handle('geometry:describe', async (_event, objectId: string, layout: string, ref: string): Promise<Described> => {
    if (typeof layout !== 'string' || typeof ref !== 'string' || !layout || !ref) throw new Error('describe needs a layout and a ref')
    try {
      return await requireWorkspace().builds.describe<Described>(String(objectId), layout, ref)
    } catch (e) {
      // A plain message: the renderer shows it, and a KernelError would cross with its class name in front.
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  })


  ipcMain.on('view:report', (_event, view: ViewState) => {
    if (findObject(view?.objectId)) reportView(view)
  })

  // What the renderer says it did for a request of main's (src/main/look.ts), each on the channel of its kind.
  for (const channel of ['view:lookReply', 'view:showReply', 'view:highlightReply', 'view:drawSectionReply']) {
    ipcMain.on(channel, (_event, id: number, result: object | { error: string }) => resolveRequest(id, result))
  }
}

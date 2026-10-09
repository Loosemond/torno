import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BuildState } from '../shared/build'
import type { Described } from '../shared/geometry'
import type { MarkPatch, NewMark, Replacement } from '../shared/marks'
import type { Scene } from '../shared/scene'
import type { SceneFile } from '../shared/scenefile'
import type { ViewState } from '../shared/view'
import type { ObjectInfo, WorkspaceInfo } from '../shared/workspace'
import { Builds, buildTimeout, watchFolder } from './builds'
import { KernelError, type KernelClient, startKernel } from './kernel/client'
import { toArrayBuffer } from './kernel/frames'
import { forgetViews, reportView, resolveRequest } from './look'
import { coalesced, followMarks, reanchorAll } from './marks/reanchor'
import type { MarkStore } from './marks/store'
import { kernelDir } from './paths'
import { loadSceneFile, saveSceneFile } from './scenefile'
import type { Sessions } from './sessions/manager'
import { sessionOfWorkspace } from './sessions/status'
import { scanOrder, scanWorkspace } from './workspace'

// Channel names, repeated in src/preload/index.ts.
//   invoke: workspace:current, workspace:pick, workspace:open, workspace:versions,
//           object:open, object:rebuild, object:sceneFile,
//           session:current, session:start, session:stop,
//           marks:list, marks:add, marks:update, marks:remove, marks:replace, marks:problem (also sent to the renderer),
//           marks:dismissProblem, geometry:describe
//   from the renderer: object:saveSceneFile, view:report, view:lookReply, view:showReply, view:highlightReply,
//           session:write, session:resize, session:insert
//   to the renderer: object:build, object:scene, view:look, view:show, view:highlight (sent by src/main/look.ts),
//           session:data, session:status, workspace:requested (sent by src/main/index.ts),
//           marks:changed, marks:problem

interface OpenWorkspace {
  info: WorkspaceInfo // as of the newest scan that has ended
  /** Scans overlap (a burst of changes in two folders, an object opened meanwhile): an older one never replaces a newer. */
  scan: () => () => boolean
  /** Has the marks of an object checked against its last build (see `openWorkspace`). */
  reanchor?: (objectId: string) => void
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

/** By object: how many checks of its marks against a build were started, and how many have ended. */
const checks = new Map<string, { started: number; finished: number }>()

/** How many checks of an object's marks against its build were started and have ended: equal when none is under way. For tests. */
export function marksChecks(objectId: string): { started: number; finished: number } {
  return { ...(checks.get(objectId) ?? { started: 0, finished: 0 }) }
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
  // marks are on: each mark is checked against it. One check at a time per object; a build that
  // succeeds during one is checked after it, and what was found for the build before is dropped.
  const reanchor = coalesced((objectId) => {
    const store = marks
    if (!store) return Promise.resolve()
    const counted = checks.get(objectId) ?? { started: 0, finished: 0 }
    checks.set(objectId, counted)
    counted.started += 1
    return reanchorAll(
      {
        marks: store,
        query: (id, name, args) => builds.query(id, name, args),
        // None once the workspace is left: nothing is asked or written for it any more.
        scene: (id) => (current === ws ? builds.scene(id)?.scene : undefined)
      },
      objectId
    ).finally(() => (counted.finished += 1))
  })
  builds.on('scene', ({ objectId }) => reanchor(objectId))
  ws.reanchor = reanchor
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
  checks.clear()
  // The next workspace may have an object of the same name, or this folder may change while it is closed.
  marks?.forget()
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
 * never open.
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
  if (marks) followMarks(marks, (objectId) => current?.reanchor?.(objectId))
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

  // What a window types or inserts goes only to a session the manager has for an object of the open
  // workspace: the window names a session, and is not taken at its word.
  const ofThisWorkspace = (sessionId: string): boolean =>
    sessions !== null && sessionOfWorkspace(sessions.objectOf(sessionId), (id) => findObject(id)?.dir)

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
  ipcMain.handle('marks:add', (_event, objectId: string, mark: NewMark) =>
    requireMarks().add(String(objectId), { ...mark, author: 'user' })
  )
  ipcMain.handle('marks:update', (_event, objectId: string, id: string, patch: MarkPatch) =>
    requireMarks().update(String(objectId), String(id), patch)
  )
  ipcMain.handle('marks:remove', (_event, objectId: string, id: string) => requireMarks().remove(String(objectId), String(id)))
  ipcMain.handle('marks:replace', (_event, objectId: string, id: string, placed: Replacement) =>
    requireMarks().replace(String(objectId), String(id), placed)
  )
  ipcMain.handle('marks:problem', (_event, objectId: string) => requireMarks().problem(String(objectId)))
  ipcMain.handle('marks:dismissProblem', (_event, objectId: string) => requireMarks().dismissProblem(String(objectId)))

  // What the kernel says of a part, a face or an edge of an object's last good build. `Builds.query`
  // has the object built again when the kernel no longer holds it.
  ipcMain.handle('geometry:describe', async (_event, objectId: string, layout: string, ref: string): Promise<Described> => {
    if (typeof layout !== 'string' || typeof ref !== 'string' || !layout || !ref) throw new Error('describe needs a layout and a ref')
    try {
      return await requireWorkspace().builds.query<Described>(String(objectId), 'describe', { ref: `${layout}:${ref}` })
    } catch (e) {
      // A plain message: the renderer shows it, and a KernelError would cross with its class name in front.
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  })

  ipcMain.on('view:report', (_event, view: ViewState) => {
    if (findObject(view?.objectId)) reportView(view)
  })

  // What the renderer says it did for a request of main's (src/main/look.ts), each on the channel of its kind.
  for (const channel of ['view:lookReply', 'view:showReply', 'view:highlightReply']) {
    ipcMain.on(channel, (_event, id: number, result: object | { error: string }) => resolveRequest(id, result))
  }
}

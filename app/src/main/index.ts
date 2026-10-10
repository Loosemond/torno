import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import type { Described } from '../shared/geometry'
import type { SavedView } from '../shared/views'
import { writeFileAtomic } from './atomic'
import { devShortcut } from './devkeys'
import { startHttp } from './http'
import { contextFor } from './context'
import { buildState, closeWorkspace, findObject, lastScene, letGoForTest, marksChecks, openObjectId, openWorkspace, openWorkspaceInfo, openedObjects, placedMark, queryObject, recheckAlignments, registerIpc } from './ipc'
import { cannotStart } from './kernel/client'
import { NoAnswer, latestView, requestHighlight, requestLook, requestSaveView, requestSectionDrawing, requestShow } from './look'
import { addDimensionTold } from './marks/measure'
import type { NearestAnchor } from './marks/reanchor'
import { maskReadsOf, maskStampOf, meshesOf } from './marks/regions'
import { MarkStore } from './marks/store'
import { mountMcp } from './mcp/server'
import { kernelDir } from './paths'
import type { ToolDeps } from './mcp/tools'
import { saveView } from './mcp/views'
import { SYSTEM_PROMPT } from './prompt'
import { quitGate } from './quit'
import { type Importer, commandIn, processImporter } from './scans/importer'
import { ScanStore } from './scans/store'
import { proposing, sceneFileNow, sceneFilesSettled } from './scenefile'
import { claudeAdapter } from './sessions/claude'
import { Sessions } from './sessions/manager'
import { StateFiles } from './statefile'

// Environment switches:
//   TORNO_TEST=1            the window is created hidden and never shown (tests, headless checks)
//   TORNO_WORKSPACE=<path>  workspace to open at start, instead of the one remembered
//   TORNO_CONFIG=<path>     config file to use instead of ~/.config/torno/config.json
//   TORNO_AGENT_CMD=<cmd>   command to run for a session instead of `claude`, split on spaces
//   TORNO_BUILD_TIMEOUT=<s> seconds a build may take before it is stopped (default 600; read in src/main/ipc.ts)
//   TORNO_DEBUG=1           print the workspace opened at start, where the MCP server is, and the command
//                           line and the hooks of every session
const isTest = process.env.TORNO_TEST === '1'
const isDebug = process.env.TORNO_DEBUG === '1'

// A hidden window stops getting frame callbacks from the compositor. Once a
// repaint coincides with input, Chromium then waits a second for each frame, so
// every mouse move in a test takes a second. Without the frame-rate limit it
// keeps drawing at 60 Hz. Never set for a visible window.
if (isTest) app.commandLine.appendSwitch('disable-frame-rate-limit')

// One torno at a time: two would each run an agent in the same folders and
// write the same .torno/ files. A second launch hands the first the folder it
// was given, if any, and exits. Not under test: test runs launch side by side.
const isFirst = isTest || app.requestSingleInstanceLock({ workspace: process.env.TORNO_WORKSPACE ?? null })
if (!isFirst) {
  const handed = process.env.TORNO_WORKSPACE ? `; it was asked to open ${process.env.TORNO_WORKSPACE}` : ''
  console.error(`torno is already running: its window was brought to the front${handed}`)
  app.quit()
}

// torno has no menu. With one, even hidden, a lone press of Alt shows the menu bar on Linux and the
// viewport is resized under the pointer: Alt-drag is how the camera is turned with the Draw tool in hand.
// Text fields keep copy, paste, select all and undo without a menu; the terminal has its own keys.
Menu.setApplicationMenu(null)

// The workspace last opened from the window is remembered in
// ~/.config/torno/config.json and opened again at the next start. A test run
// neither reads nor writes the person's own file: only one it names itself.
const configPath: string | null =
  process.env.TORNO_CONFIG ?? (isTest ? null : join(app.getPath('appData'), 'torno', 'config.json'))

async function rememberedWorkspace(): Promise<string | undefined> {
  if (!configPath) return undefined
  try {
    const config: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    const root = (config as { workspace?: unknown } | null)?.workspace
    return typeof root === 'string' && root ? root : undefined
  } catch {
    return undefined // no file yet, or not one of ours
  }
}

async function rememberWorkspace(root: string): Promise<void> {
  if (!configPath) return
  try {
    await writeFileAtomic(configPath, `${JSON.stringify({ workspace: root }, null, 2)}\n`)
  } catch (e) {
    console.error(`cannot write ${configPath}: ${(e as Error).message}`)
  }
}

// The window's own background, painted before the renderer's first frame.
// Keep equal to --surface in src/renderer/styles/tokens.css.
const SURFACE = { light: '#F1EFEA', dark: '#1A1C1F' }

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'torno',
    backgroundColor: nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  if (!isTest) win.once('ready-to-show', () => win.show())

  // The renderer is a single local page: it opens no windows and goes nowhere
  // else. It may reload itself, which is how the dev server applies a change it
  // cannot hot-swap.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // electron-vite serves the renderer from its dev server under `pnpm dev`.
  // `?test=1` tells the renderer to expose its test hook (window.__tornoTest).
  const devUrl = process.env.ELECTRON_RENDERER_URL
  // What the menu gave a developer: the developer tools wherever the app is not packaged, and reloading
  // under `pnpm dev` only, since in the app itself Ctrl+R is the agent's CLI's own key.
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      const action = devShortcut(input, { reload: devUrl !== undefined })
      if (!action) return
      event.preventDefault()
      if (action === 'reload') win.webContents.reload()
      else win.webContents.toggleDevTools()
    })
  }
  if (!app.isPackaged && devUrl) void win.loadURL(isTest ? `${devUrl}?test=1` : devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), isTest ? { query: { test: '1' } } : undefined)

  return win
}

let sessions: Sessions | null = null

/** The marks of the objects of the open workspace, whose folders are those of the last scan. */
// A region is held against the mesh its scan has whenever the marks are listed (`meshesOf`).
const marks: MarkStore = new MarkStore({ dirOf: (id) => findObject(id)?.dir, meshes: (objectId) => meshesOf(scans)(objectId), maskReads: (objectId, scan, stem) => maskReadsOf(scans)(objectId, scan, stem), maskStamp: (objectId, scan, stem) => maskStampOf(scans)(objectId, scan, stem) })

/** What runs the import process in the open workspace, once a scan was imported there: one at a time, and stopped when it is left. */
let importer: { root: string; run: Importer } | null = null

/**
 * The scans of the objects of the open workspace. A file is read by a process
 * of its own, in the workspace's environment as the kernel is: where no
 * kernel can be started (`cannotStart`), none is, and the import says why.
 */
const scans = new ScanStore({
  dirOf: (id) => findObject(id)?.dir,
  importer: () => {
    const ws = openWorkspaceInfo()
    if (!ws) return 'no workspace is open'
    const reason = cannotStart({ workspaceRoot: ws.root, hasProject: ws.hasProject })
    if (reason !== null) return reason
    const root = ws.root
    // Whether it has a project, and so whether a process may run there, is asked again as each is started (`commandIn`):
    // a pyproject.toml may appear while an import waits. Of this workspace only: once it is left, its importer is stopped for good.
    const hasProject = (): boolean => {
      const now = openWorkspaceInfo()
      return now?.root === root ? now.hasProject : ws.hasProject
    }
    if (importer?.root !== root) importer = { root, run: processImporter(commandIn(root, hasProject, kernelDir()), root) }
    return importer.run
  }
})

/** The window, which is what the agent's tools ask for pictures and ask to show things. */
function theWindow(): Promise<BrowserWindow> {
  const win = BrowserWindow.getAllWindows()[0]
  return win ? Promise.resolve(win) : Promise.reject(new Error('the torno window is closed'))
}

/**
 * The scans of an object, for a tool or for the text attached to a prompt. Someone wants to know: an alignment
 * that was not checked against the last build is asked about again.
 */
async function listedScans(objectId: string): ReturnType<ScanStore['list']> {
  const listed = await scans.list(objectId)
  recheckAlignments(objectId, listed)
  return listed
}

/** The views saved of an object: of its scene file as main last read it or was given it by the window, which writes it. */
function savedViews(objectId: string): Promise<SavedView[]> {
  const obj = findObject(objectId)
  return obj ? sceneFileNow(obj.dir).then((file) => file.views ?? []) : Promise.resolve([])
}

/** What the MCP tools and the text attached to a prompt are made from: the open workspace and the window. */
const toolDeps: ToolDeps = {
  object: findObject,
  build: buildState,
  scene: lastScene,
  // A view reported for an object stays on record after the window has moved on to another.
  view: (id) => (openObjectId() === id ? latestView(id) : undefined),
  openObjectId,
  look(_objectId, req) {
    // The window draws the object it shows, and its answer says which that was.
    return theWindow().then((win) => requestLook(win, req))
  },
  saveImage(objectId, png) {
    const obj = findObject(objectId)
    return obj ? saveView(obj.dir, png) : Promise.reject(new Error(`unknown object: ${objectId}`))
  },
  marks: (objectId) => marks.list(objectId),
  // A mark made through the tools is the agent's, and it knows of it: there is nothing to send it.
  addMark: (objectId, mark) => marks.add(objectId, placedMark({ ...mark, author: 'agent' }, objectId), 'sent'),
  // A dimension is measured as it is kept, as one the person makes is (`addDimension`).
  addDimension: (objectId, mark) => addDimensionTold({ marks, query: queryObject, scene: lastScene }, objectId, placedMark({ ...mark, author: 'agent' }, objectId), 'sent'),
  // Whoever changes a mark through the tools is the agent.
  updateMark: (objectId, id, patch) => marks.update(objectId, id, patch, 'agent'),
  describe: (objectId, layout, ref) => queryObject<Described>(objectId, 'describe', { ref: `${layout}:${ref}` }),
  async nearest(objectId, layout, anchors) {
    const reply = await queryObject<{ anchors?: NearestAnchor[] }>(objectId, 'nearest', { layout, anchors })
    if (!Array.isArray(reply?.anchors) || reply.anchors.length !== anchors.length) throw new Error('the kernel did not answer for each point')
    return reply.anchors
  },
  show(_objectId, req) {
    return theWindow().then((win) => requestShow(win, req))
  },
  highlight(objectId, layout, refs, note) {
    return theWindow().then((win) => requestHighlight(win, { objectId, layout, refs, ...(note ? { note } : {}) }))
  },
  query: queryObject,
  scans: (objectId) => listedScans(objectId),
  scanPaths: (objectId, id) => scans.paths(objectId, id),
  scansBusy: (objectId) => scans.working(objectId),
  sectionDrawing(req) {
    return theWindow().then((win) => requestSectionDrawing(win, req))
  },
  views: savedViews,
  saveView(objectId, req) {
    const obj = findObject(objectId)
    if (!obj) return Promise.reject(new Error(`unknown object: ${objectId}`))
    // The name is the agent's to propose until the window has answered, and the answer waits for the file to be on the disk (`proposing`).
    return proposing(obj.dir, req.name, () => theWindow().then((win) => requestSaveView(win, req)), (e) => e instanceof NoAnswer)
  }
}

/** `<object>/.torno/state.md` of every open object: what an agent without the tools reads instead. */
const stateFiles = new StateFiles({ object: findObject, build: buildState, scene: lastScene, marks: (objectId) => marks.list(objectId), scans: (objectId) => scans.list(objectId), views: savedViews })
marks.on('changed', ({ objectId }) => stateFiles.changed(objectId))
// Where a region is told to be follows its scan's alignment.
scans.on('changed', ({ objectId }) => stateFiles.changed(objectId))
// A mask that did not read for a region is asked for again: what the scans are has changed.
scans.on('changed', ({ objectId }) => marks.scansChanged(objectId))

/**
 * What a test needs of main that it cannot reach through the window. `pickFolder`
 * is what "Open folder" is answered with under test, where no dialog may be
 * shown; `picks` counts how often it was asked. `marks` is the store, through
 * which a test leaves the marks an agent would: the window can only make the
 * person's. `marksChecks` says whether the marks of an object have been
 * checked against its build since something was done to them. `scans` is the
 * store of the scans; `pickFile` is what "Import scan" is answered with, and
 * `filePicks` counts how often it was asked; `pickSave` is what the save dialog of
 * an export is answered with (the path to write, or null), `savePicks` counts
 * how often it was asked and `saveOffered` is the path it would have opened on. `letGo` has an object's status
 * say that the kernel let its build go, which no test's kernel does. `opened`
 * are the objects opened in this run: those that are watched and built.
 */
const testHooks = { requestLook, latestView, marks, marksChecks, opened: openedObjects, letGo: letGoForTest, mcpUrlFor: (_id: string): string => '', pickFolder: null as string | null, picks: 0, scans, pickFile: null as string | null, filePicks: 0, pickSave: null as string | null, savePicks: 0, saveOffered: null as string | null }

/** The folder a second launch was given while there was no window to offer it to, or none that had loaded. */
let requested: string | null = null

/** Offer the window the folder that is held, once it has loaded: before that nothing there listens. */
function offerRequested(win: BrowserWindow): void {
  const send = (): void => {
    if (requested === null || win.isDestroyed()) return
    // Through the window, which asks first if a session there is in the middle of something.
    win.webContents.send('workspace:requested', requested)
    requested = null
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

/** Another torno was started: come to the front, and offer the folder it was given. */
app.on('second-instance', (_event, _argv, _cwd, data) => {
  const root = (data as { workspace?: unknown } | null)?.workspace
  if (typeof root === 'string' && root) requested = root // the last one asked for, if several
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return // still starting: `createWindow` is followed by the offer
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  offerRequested(win)
})

void app.whenReady().then(async () => {
  if (!isFirst) return
  // What the agent's CLI talks to: its hooks, and the MCP server through which it sees what the window shows.
  const http = await startHttp()
  const mcpUrlFor = (id: string): string => http.url(`/mcp/${encodeURIComponent(id)}`)
  mountMcp(http, toolDeps)
  sessions = new Sessions({
    http,
    adapter: claudeAdapter(process.env.TORNO_AGENT_CMD),
    // The marks of an object that cannot be read are not a reason to tell the agent nothing of its build.
    // Nor are scans that cannot be read: they are then not known, which is not the same as there being none.
    contextFor: async (id, opts) => {
      const scans = await listedScans(id).catch(() => undefined)
      return contextFor(toolDeps, id, await marks.list(id).catch(() => []), { ...opts, ...(scans ? { scans } : {}) })
    },
    // The agent has the prompt, and with it the drafts that were listed: they are sent.
    onDelivered: (id, sentMarkIds) => void marks.markSent(id, sentMarkIds).catch((e) => console.error(`cannot mark ${sentMarkIds.join(', ')} of ${id} as sent: ${e.message}`)),
    systemPrompt: SYSTEM_PROMPT,
    mcpUrlFor,
    debug: isDebug
  })
  registerIpc({
    onWorkspaceChosen: (root) => void rememberWorkspace(root),
    sessions,
    marks,
    onBuild: (state) => stateFiles.changed(state.objectId),
    // The saved views are named in the state file.
    onSceneFile: (objectId) => stateFiles.changed(objectId),
    // What was waiting to be written was of objects of the workspace that is left.
    onWorkspaceClosed: () => {
      stateFiles.forget()
      // An import still running there is ended, and its importer with it: its scan is not kept, and its id not given again.
      importer?.run.stop()
      importer = null
    },
    // A folder dialog is a window on the person's desktop: under test there is none.
    pickFolder: isTest
      ? async () => {
          testHooks.picks += 1
          return testHooks.pickFolder
        }
      : undefined,
    scans,
    // Nor a file dialog.
    pickFile: isTest
      ? async () => {
          testHooks.filePicks += 1
          return testHooks.pickFile
        }
      : undefined,
    // Nor a save dialog.
    pickSave: isTest
      ? async (defaultPath) => {
          testHooks.savePicks += 1
          testHooks.saveOffered = defaultPath
          return testHooks.pickSave
        }
      : undefined
  })
  testHooks.mcpUrlFor = mcpUrlFor
  if (isTest) Object.assign(globalThis, { __tornoMain: testHooks })
  if (isDebug) console.error(`[torno] MCP server of an object: ${mcpUrlFor('<object id>')}`)
  const named = process.env.TORNO_WORKSPACE
  const root = named ?? (await rememberedWorkspace())
  if (root) {
    // Before the window exists, so the renderer's first question finds it open.
    const source = named ? 'TORNO_WORKSPACE' : configPath
    await openWorkspace(root)
      .then((info) => isDebug && console.error(`[torno] workspace ${info.root}: ${info.objects.length} objects`))
      .catch((e) => console.error(`${source}: cannot open ${root}: ${e.message}`))
  }
  offerRequested(createWindow())
})

// The kernel also exits by itself when this process, and so its stdin, goes away.
// Sessions are hung up on, and the quit waits until they have gone: one that
// ignores the hangup is killed two seconds later. With none left, the second
// quit goes through.
//
// The first quit also waits for what is still being written of the marks, of
// the scans and of the scene files: the note being typed and the layers just
// changed are handed over by the window as it closes, just before this, and
// are not on the disk yet. All together are given `WRITES_WAIT_MS`, once (`quitGate`):
// the quit that follows is not held for them again, so a write that never
// ends cannot keep the app open.
const WRITES_WAIT_MS = 2000
const writesBeforeQuit = quitGate(WRITES_WAIT_MS)

app.on('will-quit', (event) => {
  void closeWorkspace()
  const waits: Promise<unknown>[] = []
  const written = writesBeforeQuit([marks.settled(), scans.settled(), sceneFilesSettled()])
  if (written) waits.push(written)
  if (sessions && sessions.size > 0) waits.push(sessions.stopAll())
  if (waits.length === 0) return
  event.preventDefault()
  void Promise.allSettled(waits).finally(() => app.quit())
})

// Closing the window ends the app on every platform: sessions do not outlive it.
app.on('window-all-closed', () => app.quit())

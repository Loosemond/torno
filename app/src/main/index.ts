import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { startHttp } from './http'
import { contextFor } from './context'
import { buildState, closeWorkspace, findObject, lastScene, openObjectId, openWorkspace, registerIpc } from './ipc'
import { latestView, requestLook } from './look'
import { mountMcp } from './mcp/server'
import type { ToolDeps } from './mcp/tools'
import { saveView } from './mcp/views'
import { SYSTEM_PROMPT } from './prompt'
import { claudeAdapter } from './sessions/claude'
import { Sessions } from './sessions/manager'

// Environment switches:
//   TORNO_TEST=1            the window is created hidden and never shown (tests, headless checks)
//   TORNO_WORKSPACE=<path>  workspace to open at start, instead of the one remembered
//   TORNO_CONFIG=<path>     config file to use instead of ~/.config/torno/config.json
//   TORNO_AGENT_CMD=<cmd>   command to run for a session instead of `claude`, split on spaces
//   TORNO_DEBUG=1           print where the MCP server is, and the command line of every session
const isTest = process.env.TORNO_TEST === '1'
const isDebug = process.env.TORNO_DEBUG === '1'

// A hidden window stops getting frame callbacks from the compositor. Once a
// repaint coincides with input, Chromium then waits a second for each frame, so
// every mouse move in a test takes a second. Without the frame-rate limit it
// keeps drawing at 60 Hz. Never set for a visible window.
if (isTest) app.commandLine.appendSwitch('disable-frame-rate-limit')

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
    await mkdir(dirname(configPath), { recursive: true })
    const temp = `${configPath}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ workspace: root }, null, 2)}\n`)
    await rename(temp, configPath)
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
    autoHideMenuBar: true,
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
  if (!app.isPackaged && devUrl) void win.loadURL(isTest ? `${devUrl}?test=1` : devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), isTest ? { query: { test: '1' } } : undefined)

  return win
}

let sessions: Sessions | null = null

/** What the MCP tools and the text attached to a prompt are made from: the open workspace and the window. */
const toolDeps: ToolDeps = {
  object: findObject,
  build: buildState,
  scene: lastScene,
  // A view reported for an object stays on record after the window has moved on to another.
  view: (id) => (openObjectId() === id ? latestView(id) : undefined),
  openObjectId,
  look(_objectId, req) {
    // The tool has made sure that the object asked for is the one the window shows.
    const win = BrowserWindow.getAllWindows()[0]
    return win ? requestLook(win, req) : Promise.reject(new Error('the torno window is closed'))
  },
  saveImage(objectId, png) {
    const obj = findObject(objectId)
    return obj ? saveView(obj.dir, png) : Promise.reject(new Error(`unknown object: ${objectId}`))
  }
}

void app.whenReady().then(async () => {
  // What the agent's CLI talks to: its hooks, and the MCP server through which it sees what the window shows.
  const http = await startHttp()
  const mcpUrlFor = (id: string): string => http.url(`/mcp/${encodeURIComponent(id)}`)
  mountMcp(http, toolDeps)
  sessions = new Sessions({
    http,
    adapter: claudeAdapter(process.env.TORNO_AGENT_CMD),
    contextFor: (id) => contextFor(toolDeps, id),
    systemPrompt: SYSTEM_PROMPT,
    mcpUrlFor,
    debug: isDebug
  })
  registerIpc({ onWorkspaceChosen: (root) => void rememberWorkspace(root), sessions })
  // What a test needs of main that it cannot reach through the window.
  if (isTest) Object.assign(globalThis, { __tornoMain: { requestLook, latestView, mcpUrlFor } })
  if (isDebug) console.error(`[torno] MCP server of an object: ${mcpUrlFor('<object id>')}`)
  const named = process.env.TORNO_WORKSPACE
  const root = named ?? (await rememberedWorkspace())
  if (root) {
    // Before the window exists, so the renderer's first question finds it open.
    const source = named ? 'TORNO_WORKSPACE' : configPath
    await openWorkspace(root).catch((e) => console.error(`${source}: cannot open ${root}: ${e.message}`))
  }
  createWindow()
})

// The kernel also exits by itself when this process, and so its stdin, goes away.
// Sessions are hung up on, and the quit waits until they have gone: one that
// ignores the hangup is killed two seconds later. With none left, the second
// quit goes through.
app.on('will-quit', (event) => {
  void closeWorkspace()
  if (!sessions || sessions.size === 0) return
  event.preventDefault()
  void sessions.stopAll().finally(() => app.quit())
})

// Closing the window ends the app on every platform: sessions do not outlive it.
app.on('window-all-closed', () => app.quit())

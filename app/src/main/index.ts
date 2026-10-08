import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { closeWorkspace, openWorkspace, registerIpc } from './ipc'

// Environment switches:
//   TORNO_TEST=1            the window is created hidden and never shown (tests, headless checks)
//   TORNO_WORKSPACE=<path>  workspace to open at start
//   TORNO_AGENT_CMD=<cmd>   agent command for sessions (not read yet: the session task adds it)
const isTest = process.env.TORNO_TEST === '1'

// A hidden window stops getting frame callbacks from the compositor. Once a
// repaint coincides with input, Chromium then waits a second for each frame, so
// every mouse move in a test takes a second. Without the frame-rate limit it
// keeps drawing at 60 Hz. Never set for a visible window.
if (isTest) app.commandLine.appendSwitch('disable-frame-rate-limit')

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
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

void app.whenReady().then(async () => {
  registerIpc()
  const root = process.env.TORNO_WORKSPACE
  if (root) {
    // Before the window exists, so the renderer's first question finds it open.
    await openWorkspace(root).catch((e) => console.error(`TORNO_WORKSPACE: cannot open ${root}: ${e.message}`))
  }
  createWindow()
})

// The kernel also exits by itself when this process, and so its stdin, goes away.
app.on('will-quit', () => void closeWorkspace())

// Closing the window ends the app on every platform: sessions do not outlive it.
app.on('window-all-closed', () => app.quit())

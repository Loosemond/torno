import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BuildState } from '../shared/build'
import type { SceneFile } from '../shared/scenefile'
import type { LookResult, ViewState } from '../shared/view'
import type { ObjectInfo, WorkspaceInfo } from '../shared/workspace'
import { Builds, watchFolder } from './builds'
import { type KernelClient, startKernel } from './kernel/client'
import { toArrayBuffer } from './kernel/frames'
import { forgetViews, reportView, resolveLook } from './look'
import { kernelDir } from './paths'
import { loadSceneFile, saveSceneFile } from './scenefile'
import { scanWorkspace } from './workspace'

// Channel names, repeated in src/preload/index.ts.
//   invoke: workspace:current, workspace:pick, workspace:open, workspace:versions,
//           object:open, object:rebuild, object:sceneFile
//   from the renderer: object:saveSceneFile, view:report, view:lookReply
//   to the renderer: object:build, object:scene, view:look (sent by src/main/look.ts)

interface OpenWorkspace {
  info: WorkspaceInfo // as of the last scan
  kernel: KernelClient
  builds: Builds
  opened: Set<string> // ids of the objects being watched and built
}

let current: OpenWorkspace | null = null

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
    // Which file is an object's model can change with its folder's contents
    // (a second candidate removed, a first one added), so a change there is a
    // reason to choose again before building. The choice is compared with what
    // `builds` holds, not with `ws.info`: another folder's change may have
    // scanned, and replaced that, in the meantime.
    watch: (dir, onChange) =>
      watchFolder(dir, () => {
        void scanWorkspace(ws.info.root)
          .catch(() => null)
          .then((scanned) => {
            if (current !== ws) return
            if (scanned) ws.info = scanned
            const obj = ws.info.objects.find((o) => o.dir === dir)
            if (!obj || !builds.update(obj)) onChange()
          })
      })
  })
  const ws: OpenWorkspace = { info, kernel, builds, opened: new Set() }
  builds.on('build', (state) => broadcast('object:build', state))
  builds.on('scene', ({ objectId, revision, scene, blob }) =>
    broadcast('object:scene', { objectId, revision, scene, blob: toArrayBuffer(blob) })
  )
  current = ws
  return info
}

export async function closeWorkspace(): Promise<void> {
  const ws = current
  if (!ws) return
  current = null
  forgetViews()
  for (const id of ws.opened) ws.builds.close(id)
  await ws.kernel.dispose()
}

function requireWorkspace(): OpenWorkspace {
  if (!current) throw new Error('no workspace is open')
  return current
}

/** An object of the open workspace as of the last scan. The renderer names objects, never folders. */
function findObject(id: string): ObjectInfo | undefined {
  return current?.info.objects.find((o) => o.id === id)
}

/**
 * `onWorkspaceChosen` is told the root of every workspace the person opens
 * from the window, so that it can be opened again at the next start.
 */
export function registerIpc(opts: { onWorkspaceChosen?: (root: string) => void } = {}): void {
  const chosen = (info: WorkspaceInfo): WorkspaceInfo => {
    opts.onWorkspaceChosen?.(info.root)
    return info
  }

  ipcMain.handle('workspace:current', () => current?.info ?? null)

  ipcMain.handle('workspace:pick', async (event) => {
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
    // Scanned afresh: the agent may have created the folder a moment ago.
    const scanned = await scanWorkspace(ws.info.root)
    // The workspace may have been closed or replaced during the scan; its kernel is then gone.
    if (current !== ws) throw new Error(`the workspace ${ws.info.root} was closed`)
    ws.info = scanned
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

  ipcMain.on('view:report', (_event, view: ViewState) => {
    if (findObject(view?.objectId)) reportView(view)
  })

  ipcMain.on('view:lookReply', (_event, id: number, result: LookResult | { error: string }) => resolveLook(id, result))
}

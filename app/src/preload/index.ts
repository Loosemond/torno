import { contextBridge, ipcRenderer } from 'electron'
import type { TornoBridge } from '../shared/bridge'

// Channel names are those listed in src/main/ipc.ts.
function subscribe<T>(channel: string, cb: (message: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, message: T) => cb(message)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: TornoBridge = {
  workspace: {
    current: () => ipcRenderer.invoke('workspace:current'),
    pick: () => ipcRenderer.invoke('workspace:pick'),
    open: (root) => ipcRenderer.invoke('workspace:open', root),
    versions: () => ipcRenderer.invoke('workspace:versions'),
    onRequested: (cb) => subscribe('workspace:requested', cb)
  },
  object: {
    open: (id) => ipcRenderer.invoke('object:open', id),
    rebuild: (id) => ipcRenderer.invoke('object:rebuild', id),
    loadSceneFile: (id) => ipcRenderer.invoke('object:sceneFile', id),
    saveSceneFile: (id, file) => ipcRenderer.send('object:saveSceneFile', id, file),
    onBuild: (cb) => subscribe('object:build', cb),
    onScene: (cb) => subscribe('object:scene', cb)
  },
  view: {
    report: (v) => ipcRenderer.send('view:report', v),
    onLook: (cb) => subscribe('view:look', cb),
    lookReply: (id, result) => ipcRenderer.send('view:lookReply', id, result)
  },
  session: {
    current: (objectId) => ipcRenderer.invoke('session:current', objectId),
    start: (objectId, opts) => ipcRenderer.invoke('session:start', objectId, opts),
    write: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
    stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
    onData: (cb) => subscribe('session:data', cb),
    onStatus: (cb) => subscribe('session:status', cb)
  }
}

contextBridge.exposeInMainWorld('torno', bridge)

import { contextBridge, ipcRenderer } from 'electron'
import type { TornoBridge } from '../shared/bridge'

// Every method of the bridge exists from the first task, so the renderer can be
// written against the full contract. A method throws until the task that backs
// it replaces `notImplemented` with the real IPC call.
function notImplemented(): never {
  throw new Error('not implemented')
}

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
    open: (root) => ipcRenderer.invoke('workspace:open', root)
  },
  object: {
    open: (id) => ipcRenderer.invoke('object:open', id),
    rebuild: (id) => ipcRenderer.invoke('object:rebuild', id),
    onBuild: (cb) => subscribe('object:build', cb),
    onScene: (cb) => subscribe('object:scene', cb)
  },
  view: {
    report: notImplemented,
    onLook: notImplemented,
    lookReply: notImplemented
  },
  session: {
    start: notImplemented,
    write: notImplemented,
    resize: notImplemented,
    stop: notImplemented,
    onData: notImplemented,
    onStatus: notImplemented
  }
}

contextBridge.exposeInMainWorld('torno', bridge)

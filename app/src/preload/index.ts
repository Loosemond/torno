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

/** An invoke whose rejection carries the message main gave, without what Electron puts before it. */
async function invokePlain<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
  }
}

// Declared here and backed by the task that uses them: view.onShow and
// view.onHighlight do nothing yet.
const notYet = (): (() => void) => () => {}

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
    lookReply: (id, result) => ipcRenderer.send('view:lookReply', id, result),
    onShow: notYet,
    onHighlight: notYet
  },
  marks: {
    list: (objectId) => invokePlain('marks:list', objectId),
    add: (objectId, mark) => invokePlain('marks:add', objectId, mark),
    update: (objectId, id, patch) => invokePlain('marks:update', objectId, id, patch),
    remove: (objectId, id) => invokePlain('marks:remove', objectId, id),
    onChanged: (cb) => subscribe('marks:changed', cb),
    onProblem: (cb) => subscribe('marks:problem', cb)
  },
  geometry: {
    describe: (objectId, layout, ref) => invokePlain('geometry:describe', objectId, layout, ref)
  },
  session: {
    current: (objectId) => ipcRenderer.invoke('session:current', objectId),
    start: (objectId, opts) => ipcRenderer.invoke('session:start', objectId, opts),
    write: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
    stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
    onData: (cb) => subscribe('session:data', cb),
    onStatus: (cb) => subscribe('session:status', cb),
    insert: (sessionId, text) => ipcRenderer.send('session:insert', sessionId, text)
  }
}

contextBridge.exposeInMainWorld('torno', bridge)

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { TornoBridge } from '../shared/bridge'
import type { AlignMade, NewAlignment } from '../shared/scans'

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

const bridge: TornoBridge = {
  workspace: {
    current: () => ipcRenderer.invoke('workspace:current'),
    pick: () => ipcRenderer.invoke('workspace:pick'),
    open: (root) => ipcRenderer.invoke('workspace:open', root),
    versions: () => ipcRenderer.invoke('workspace:versions'),
    recent: () => ipcRenderer.invoke('workspace:recent'),
    forget: (root) => ipcRenderer.invoke('workspace:forget', root),
    hasExample: () => ipcRenderer.invoke('workspace:hasExample'),
    openExample: () => ipcRenderer.invoke('workspace:openExample'),
    onRequested: (cb) => subscribe('workspace:requested', cb),
    onCloseAsked: (cb) => subscribe('window:closeAsked', cb),
    answerClose: (close) => ipcRenderer.send('window:closeAnswer', close)
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
    onShow: (cb) => subscribe('view:show', cb),
    showReply: (id, result) => ipcRenderer.send('view:showReply', id, result),
    onHighlight: (cb) => subscribe('view:highlight', cb),
    highlightReply: (id, result) => ipcRenderer.send('view:highlightReply', id, result),
    onDrawSection: (cb) => subscribe('view:drawSection', cb),
    drawSectionReply: (id, result) => ipcRenderer.send('view:drawSectionReply', id, result),
    onSaveView: (cb) => subscribe('view:saveView', cb),
    saveViewReply: (id, result) => ipcRenderer.send('view:saveViewReply', id, result)
  },
  marks: {
    list: (objectId) => invokePlain('marks:list', objectId),
    add: (objectId, mark) => invokePlain('marks:add', objectId, mark),
    addRegion: (objectId, region) => invokePlain('marks:addRegion', objectId, region),
    repaintRegion: (objectId, id, bits) => invokePlain('marks:repaintRegion', objectId, id, bits),
    update: (objectId, id, patch) => invokePlain('marks:update', objectId, id, patch),
    remove: (objectId, id) => invokePlain('marks:remove', objectId, id),
    replace: (objectId, id, placed) => invokePlain('marks:replace', objectId, id, placed),
    onChanged: (cb) => subscribe('marks:changed', cb),
    onProblem: (cb) => subscribe('marks:problem', cb),
    problem: (objectId) => invokePlain('marks:problem', objectId),
    dismissProblem: (objectId) => invokePlain('marks:dismissProblem', objectId)
  },
  scans: {
    list: (objectId) => invokePlain('scans:list', objectId),
    pick: () => invokePlain('scans:pick'),
    pathOf: (file) => webUtils.getPathForFile(file),
    import: (objectId, path) => invokePlain('scans:import', objectId, path),
    reimport: (objectId, id) => invokePlain('scans:reimport', objectId, id),
    convert: (objectId, id, as) => invokePlain('scans:convert', objectId, id, as),
    rename: (objectId, id, name) => invokePlain('scans:rename', objectId, id, name),
    remove: (objectId, id) => invokePlain('scans:remove', objectId, id),
    align: (objectId: string, id: string, layout: string, alignment: NewAlignment | null, made?: AlignMade) => invokePlain('scans:align', objectId, id, layout, alignment, made),
    undoAlign: (objectId, id, layout) => invokePlain('scans:undoAlign', objectId, id, layout),
    alignHolds: (objectId, id, layout) => invokePlain('scans:alignHolds', objectId, id, layout),
    mesh: (objectId, id) => invokePlain('scans:mesh', objectId, id),
    mask: (objectId, id, markId) => invokePlain('scans:mask', objectId, id, markId),
    onChanged: (cb) => subscribe('scans:changed', cb),
    onProgress: (cb) => subscribe('scans:progress', cb),
    onProblem: (cb) => subscribe('scans:problem', cb),
    problem: (objectId) => invokePlain('scans:problem', objectId),
    dismissProblem: (objectId) => invokePlain('scans:dismissProblem', objectId)
  },
  geometry: {
    describe: (objectId, layout, ref) => invokePlain('geometry:describe', objectId, layout, ref)
  },
  show: {
    cards: () => ipcRenderer.invoke('show:cards'),
    thumbnail: (objectId) => ipcRenderer.invoke('show:thumbnail', objectId),
    saveThumbnail: (objectId, revision, png, of) => ipcRenderer.send('show:saveThumbnail', objectId, revision, png, of),
    onChanged: (cb) => subscribe<void>('show:changed', () => cb())
  },
  export: {
    plan: (req) => invokePlain('export:plan', req),
    save: (req) => invokePlain('export:save', req),
    done: () => ipcRenderer.send('export:done')
  },
  session: {
    current: (objectId) => ipcRenderer.invoke('session:current', objectId),
    start: (objectId, opts) => ipcRenderer.invoke('session:start', objectId, opts),
    write: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
    stop: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
    onData: (cb) => subscribe('session:data', cb),
    onStatus: (cb) => subscribe('session:status', cb),
    insert: (sessionId, text) => ipcRenderer.send('session:insert', sessionId, text),
    agents: () => ipcRenderer.invoke('session:agents'),
    chooseAgent: (objectId, agent) => ipcRenderer.invoke('session:chooseAgent', objectId, agent),
    chooseView: (objectId, view) => invokePlain('session:chooseView', objectId, view),
    sendMarks: (sessionId) => ipcRenderer.invoke('session:sendMarks', sessionId),
    onSend: (cb) => subscribe('session:send', cb)
  },
  chat: {
    history: (sessionId) => invokePlain('chat:history', sessionId),
    onItem: (cb) => subscribe('chat:item', cb),
    onMeta: (cb) => subscribe('chat:meta', cb),
    onCapabilities: (cb) => subscribe('chat:capabilities', cb),
    send: (sessionId, prompt) => invokePlain('chat:send', sessionId, prompt),
    answer: (sessionId, requestId, answer) => ipcRenderer.send('chat:answer', sessionId, requestId, answer),
    interrupt: (sessionId) => invokePlain('chat:interrupt', sessionId),
    setModel: (sessionId, model) => invokePlain('chat:setModel', sessionId, model)
  }
}

contextBridge.exposeInMainWorld('torno', bridge)

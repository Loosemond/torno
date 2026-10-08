import { contextBridge } from 'electron'
import type { TornoBridge } from '../shared/bridge'

// Every method of the bridge exists from the first task, so the renderer can be
// written against the full contract. A method throws until the task that backs
// it replaces `notImplemented` with the real IPC call.
function notImplemented(): never {
  throw new Error('not implemented')
}

const bridge: TornoBridge = {
  workspace: {
    current: notImplemented,
    pick: notImplemented,
    open: notImplemented
  },
  object: {
    open: notImplemented,
    rebuild: notImplemented,
    onBuild: notImplemented,
    onScene: notImplemented
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

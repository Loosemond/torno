import type { BrowserWindow } from 'electron'
import type { LookRequest, LookResult, ViewState } from '../shared/view'

// Pictures of the viewport are made by the renderer, which owns the WebGL
// context. Main asks over `view:look` and is answered over `view:lookReply`
// (src/main/ipc.ts passes the answer to `resolveLook`).

interface Waiting {
  resolve: (result: LookResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const waiting = new Map<number, Waiting>()
let nextId = 1

/**
 * Ask a window for a picture of its viewport. Rejects with the renderer's error
 * text (an unknown part or layout, no build yet), or when it does not answer.
 */
export function requestLook(win: BrowserWindow, req: LookRequest, timeoutMs = 10000): Promise<LookResult> {
  if (win.isDestroyed()) return Promise.reject(new Error('the torno window is closed'))
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`the torno window did not answer within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    waiting.set(id, { resolve, reject, timer })
    win.webContents.send('view:look', { id, request: req })
  })
}

/** The renderer's answer to request `id`. One that is late, repeated or malformed is dropped. */
export function resolveLook(id: number, result: LookResult | { error: string }): void {
  const request = waiting.get(id)
  if (!request || typeof result !== 'object' || result === null) return
  waiting.delete(id)
  clearTimeout(request.timer)
  if ('error' in result) request.reject(new Error(String(result.error)))
  else request.resolve(result)
}

const views = new Map<string, ViewState>()

/** What the renderer last said the person is looking at. */
export function reportView(v: ViewState): void {
  views.set(v.objectId, v)
}

/** The camera, layout and visible parts of an object as last shown, if it has been shown. */
export function latestView(objectId: string): ViewState | undefined {
  return views.get(objectId)
}

/** Object ids mean nothing once their workspace is closed. */
export function forgetViews(): void {
  views.clear()
}

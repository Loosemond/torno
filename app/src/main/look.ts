import type { BrowserWindow } from 'electron'
import type { HighlightRequest, HighlightResult, LookRequest, LookResult, ShowRequest, ShowResult, ViewState } from '../shared/view'

// What the agent asks of the window is done by the renderer, which owns the
// viewport: a picture of it (`view:look`), a change of what it shows
// (`view:show`), something pointed out in it (`view:highlight`). Main asks
// over the channel and is answered over `<channel>Reply` (src/main/ipc.ts
// passes each answer to `resolveRequest`).

interface Waiting {
  resolve: (result: never) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const waiting = new Map<number, Waiting>()
let nextId = 1

/** Ask a window to do something, and wait for what it says it did. Rejects with its error text, or when it does not answer. */
function request<T>(win: BrowserWindow, channel: string, req: unknown, timeoutMs: number): Promise<T> {
  if (win.isDestroyed()) return Promise.reject(new Error('the torno window is closed'))
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`the torno window did not answer within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    waiting.set(id, { resolve, reject, timer })
    win.webContents.send(channel, { id, request: req })
  })
}

/**
 * Ask a window for a picture of its viewport. Rejects with the renderer's error
 * text (an unknown part or layout, no build yet), or when it does not answer.
 */
export function requestLook(win: BrowserWindow, req: LookRequest, timeoutMs = 10000): Promise<LookResult> {
  return request(win, 'view:look', req, timeoutMs)
}

/** Ask a window to show an object another way: a view, a layout, some parts. Rejects with the renderer's error text. */
export function requestShow(win: BrowserWindow, req: ShowRequest, timeoutMs = 10000): Promise<ShowResult> {
  return request(win, 'view:show', req, timeoutMs)
}

/** Ask a window to point out refs to the person. Rejects with the renderer's error text. */
export function requestHighlight(win: BrowserWindow, req: HighlightRequest, timeoutMs = 10000): Promise<HighlightResult> {
  return request(win, 'view:highlight', req, timeoutMs)
}

/** The renderer's answer to request `id`. One that is late, repeated or malformed is dropped. */
export function resolveRequest(id: number, result: object | { error: string }): void {
  const asked = waiting.get(id)
  if (!asked || typeof result !== 'object' || result === null) return
  waiting.delete(id)
  clearTimeout(asked.timer)
  if ('error' in result) asked.reject(new Error(String(result.error)))
  else asked.resolve(result as never)
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

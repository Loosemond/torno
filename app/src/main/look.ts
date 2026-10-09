import type { BrowserWindow } from 'electron'
import { type HighlightRequest, type HighlightResult, type LookRequest, type LookResult, type SelectionReport, type ShowRequest, type ShowResult, type ViewState, MAX_SELECTION_REPORTED } from '../shared/view'

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

/**
 * Ask a window to do something, and wait for what it says it did. Rejects with
 * its error text, when it does not answer, and at once when it is closed
 * while the answer is waited for.
 */
function request<T>(win: BrowserWindow, channel: string, req: unknown, timeoutMs: number): Promise<T> {
  if (win.isDestroyed()) return Promise.reject(new Error('the torno window is closed'))
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    const closed = (): void => {
      const asked = waiting.get(id)
      if (!asked) return
      waiting.delete(id)
      clearTimeout(asked.timer)
      reject(new Error('the torno window was closed'))
    }
    const settled = <A extends unknown[]>(settle: (...args: A) => void) => {
      return (...args: A): void => {
        win.removeListener('closed', closed)
        settle(...args)
      }
    }
    const timer = setTimeout(
      settled(() => {
        waiting.delete(id)
        reject(new Error(`the torno window did not answer within ${Math.round(timeoutMs / 1000)} s`))
      }),
      timeoutMs
    )
    waiting.set(id, { resolve: settled(resolve as (result: never) => void), reject: settled(reject), timer })
    win.once('closed', closed)
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

/** The longest line about a selected ref that is kept. */
const MAX_SELECTED_DESCRIPTOR = 200

/**
 * What the renderer last said the person is looking at, and has selected
 * there. The selection goes to the agent with the next prompt, so only what
 * is one is kept of it: a revision, and at most eight refs on one line each.
 */
export function reportView(v: ViewState): void {
  const { selection: said, ...view } = v
  const selection = selectionOf(said)
  views.set(v.objectId, selection ? { ...view, selection } : view)
}

function selectionOf(value: unknown): SelectionReport | null {
  const said = value as { revision?: unknown; refs?: unknown } | null
  if (typeof said !== 'object' || said === null || typeof said.revision !== 'number' || !Array.isArray(said.refs)) return null
  const refs: SelectionReport['refs'] = []
  for (const one of said.refs as Array<{ ref?: unknown; descriptor?: unknown } | null>) {
    if (refs.length === MAX_SELECTION_REPORTED) break
    if (typeof one?.ref !== 'string' || !/^[^\s]{1,200}$/.test(one.ref)) continue
    const descriptor = typeof one.descriptor === 'string' ? one.descriptor.replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTED_DESCRIPTOR) : ''
    refs.push(descriptor ? { ref: one.ref, descriptor } : { ref: one.ref })
  }
  return refs.length > 0 ? { revision: said.revision, refs } : null
}

/** The camera, layout and visible parts of an object as last shown, if it has been shown. */
export function latestView(objectId: string): ViewState | undefined {
  return views.get(objectId)
}

/** Object ids mean nothing once their workspace is closed. */
export function forgetViews(): void {
  views.clear()
}

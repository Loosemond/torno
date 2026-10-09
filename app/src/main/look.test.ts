import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LookResult, ViewState } from '../shared/view'
import { forgetViews, latestView, reportView, requestHighlight, requestLook, requestShow, resolveRequest } from './look'

function fakeWindow(destroyed = false) {
  const sent: Array<{ channel: string; message: { id: number; request: unknown } }> = []
  const listeners = new Set<() => void>()
  const win = {
    isDestroyed: () => destroyed,
    once: (_event: 'closed', cb: () => void) => listeners.add(cb),
    removeListener: (_event: 'closed', cb: () => void) => listeners.delete(cb),
    /** The window is closed: whoever asked to be told is. */
    close: () => [...listeners].forEach((cb) => (listeners.delete(cb), cb())),
    listening: () => listeners.size,
    webContents: { send: (channel: string, message: { id: number; request: unknown }) => sent.push({ channel, message }) }
  } as unknown as BrowserWindow
  return { win: win as BrowserWindow & { close(): void; listening(): number }, sent }
}

const PICTURE: LookResult = { png: new Uint8Array([1, 2, 3]), width: 4, height: 3, caption: 'view iso', objectId: 'bracket', revision: 1, stale: false }

afterEach(() => {
  vi.useRealTimers()
  forgetViews()
})

describe('requestLook', () => {
  it('rejects at once when the window is closed while it waits, and ignores a late reply', async () => {
    vi.useFakeTimers()
    const { win, sent } = fakeWindow()
    const result = requestLook(win, {}, 10000)
    const failed = expect(result).rejects.toThrow('the torno window was closed')
    win.close()
    await failed
    expect(vi.getTimerCount()).toBe(0)
    expect(() => resolveRequest(sent[0].message.id, PICTURE)).not.toThrow()
  })

  it('stops listening for the window to close once it is answered, or has timed out', async () => {
    vi.useFakeTimers()
    const { win, sent } = fakeWindow()
    const answered = requestLook(win, {})
    expect(win.listening()).toBe(1)
    resolveRequest(sent[0].message.id, PICTURE)
    await answered
    expect(win.listening()).toBe(0)
    const late = expect(requestLook(win, {}, 500)).rejects.toThrow('did not answer')
    await vi.advanceTimersByTimeAsync(500)
    await late
    expect(win.listening()).toBe(0)
  })

  it('sends the request to the window and resolves with its reply', async () => {
    const { win, sent } = fakeWindow()
    const result = requestLook(win, { view: 'iso' })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('view:look')
    expect(sent[0].message.request).toEqual({ view: 'iso' })
    resolveRequest(sent[0].message.id, PICTURE)
    await expect(result).resolves.toEqual(PICTURE)
  })

  it("rejects with the renderer's error text", async () => {
    const { win, sent } = fakeWindow()
    const result = requestLook(win, { parts: ['x'] })
    resolveRequest(sent[0].message.id, { error: "unknown part 'x'; parts in layout assembly: base, post" })
    await expect(result).rejects.toThrow("unknown part 'x'; parts in layout assembly: base, post")
  })

  it('answers each of two requests in flight with its own reply', async () => {
    const { win, sent } = fakeWindow()
    const first = requestLook(win, { view: 'front' })
    const second = requestLook(win, { view: 'top' })
    expect(sent[0].message.id).not.toBe(sent[1].message.id)
    resolveRequest(sent[1].message.id, { ...PICTURE, caption: 'view top' })
    resolveRequest(sent[0].message.id, { ...PICTURE, caption: 'view front' })
    expect((await first).caption).toBe('view front')
    expect((await second).caption).toBe('view top')
  })

  it('rejects when the window does not answer in time, and ignores a late reply', async () => {
    vi.useFakeTimers()
    const { win, sent } = fakeWindow()
    const result = requestLook(win, {}, 10000)
    const failed = expect(result).rejects.toThrow('the torno window did not answer within 10 s')
    await vi.advanceTimersByTimeAsync(10000)
    await failed
    expect(() => resolveRequest(sent[0].message.id, PICTURE)).not.toThrow()
  })

  it('rejects at once when the window is gone', async () => {
    const { win, sent } = fakeWindow(true)
    await expect(requestLook(win, {})).rejects.toThrow('the torno window is closed')
    expect(sent).toEqual([])
  })

  it('ignores a reply nobody is waiting for', () => {
    expect(() => resolveRequest(987654, PICTURE)).not.toThrow()
  })
})

describe('requestShow and requestHighlight', () => {
  it('ask the window on their own channels and resolve with what it says it did', async () => {
    const { win, sent } = fakeWindow()
    const shown = requestShow(win, { objectId: 'bracket', view: 'top' })
    const pointed = requestHighlight(win, { objectId: 'bracket', layout: 'assembly', refs: ['base/F1'], note: 'this one?' })
    expect(sent.map((m) => m.channel)).toEqual(['view:show', 'view:highlight'])
    expect(sent[0].message.request).toEqual({ objectId: 'bracket', view: 'top' })
    expect(sent[1].message.request).toEqual({ objectId: 'bracket', layout: 'assembly', refs: ['base/F1'], note: 'this one?' })
    resolveRequest(sent[1].message.id, { objectId: 'bracket', layout: 'assembly', refs: ['base/F1'], revision: 2 })
    resolveRequest(sent[0].message.id, { error: "unknown part 'lid'; parts in layout assembly: base, post" })
    await expect(pointed).resolves.toEqual({ objectId: 'bracket', layout: 'assembly', refs: ['base/F1'], revision: 2 })
    await expect(shown).rejects.toThrow("unknown part 'lid'; parts in layout assembly: base, post")
  })

  it('reject when the window is closed, or does not answer', async () => {
    await expect(requestShow(fakeWindow(true).win, { objectId: 'bracket' })).rejects.toThrow('the torno window is closed')
    vi.useFakeTimers()
    const result = requestHighlight(fakeWindow().win, { objectId: 'bracket', layout: 'assembly', refs: [] })
    const failed = expect(result).rejects.toThrow('the torno window did not answer within 10 s')
    await vi.advanceTimersByTimeAsync(10000)
    await failed
  })
})

describe('latestView', () => {
  const view = (objectId: string, layout: string): ViewState => ({
    objectId,
    layout,
    camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
    visible: [`${layout}:base`]
  })

  it('is the last view reported for the object', () => {
    expect(latestView('bracket')).toBeUndefined()
    reportView(view('bracket', 'assembly'))
    reportView(view('two', 'main'))
    reportView(view('bracket', 'print'))
    expect(latestView('bracket')?.layout).toBe('print')
    expect(latestView('two')?.layout).toBe('main')
  })

  it('is forgotten with the workspace', () => {
    reportView(view('bracket', 'assembly'))
    forgetViews()
    expect(latestView('bracket')).toBeUndefined()
  })
})

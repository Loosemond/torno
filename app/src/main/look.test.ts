import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LookResult, ViewState } from '../shared/view'
import { forgetViews, latestView, reportView, requestLook, resolveLook } from './look'

function fakeWindow(destroyed = false) {
  const sent: Array<{ channel: string; message: { id: number; request: unknown } }> = []
  const win = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, message: { id: number; request: unknown }) => sent.push({ channel, message }) }
  } as unknown as BrowserWindow
  return { win, sent }
}

const PICTURE: LookResult = { png: new Uint8Array([1, 2, 3]), width: 4, height: 3, caption: 'view iso' }

afterEach(() => {
  vi.useRealTimers()
  forgetViews()
})

describe('requestLook', () => {
  it('sends the request to the window and resolves with its reply', async () => {
    const { win, sent } = fakeWindow()
    const result = requestLook(win, { view: 'iso' })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('view:look')
    expect(sent[0].message.request).toEqual({ view: 'iso' })
    resolveLook(sent[0].message.id, PICTURE)
    await expect(result).resolves.toEqual(PICTURE)
  })

  it("rejects with the renderer's error text", async () => {
    const { win, sent } = fakeWindow()
    const result = requestLook(win, { parts: ['x'] })
    resolveLook(sent[0].message.id, { error: "unknown part 'x'; parts in layout assembly: base, post" })
    await expect(result).rejects.toThrow("unknown part 'x'; parts in layout assembly: base, post")
  })

  it('answers each of two requests in flight with its own reply', async () => {
    const { win, sent } = fakeWindow()
    const first = requestLook(win, { view: 'front' })
    const second = requestLook(win, { view: 'top' })
    expect(sent[0].message.id).not.toBe(sent[1].message.id)
    resolveLook(sent[1].message.id, { ...PICTURE, caption: 'view top' })
    resolveLook(sent[0].message.id, { ...PICTURE, caption: 'view front' })
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
    expect(() => resolveLook(sent[0].message.id, PICTURE)).not.toThrow()
  })

  it('rejects at once when the window is gone', async () => {
    const { win, sent } = fakeWindow(true)
    await expect(requestLook(win, {})).rejects.toThrow('the torno window is closed')
    expect(sent).toEqual([])
  })

  it('ignores a reply nobody is waiting for', () => {
    expect(() => resolveLook(987654, PICTURE)).not.toThrow()
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

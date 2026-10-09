import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quitGate } from './quit'

describe('quitGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Whether a wait is over, as of the microtasks run so far. */
  const over = (wait: Promise<void>): (() => boolean) => {
    let done = false
    void wait.then(() => (done = true))
    return () => done
  }

  it('lets the quit through at once when nothing is being written', () => {
    const gate = quitGate(2000)
    expect(gate([null, null])).toBeNull()
    expect(gate([])).toBeNull()
  })

  it('waits for what is being written, and no longer than that takes', async () => {
    const gate = quitGate(2000)
    let written = (): void => {}
    const wait = gate([null, new Promise<void>((resolve) => (written = resolve))])!
    const done = over(wait)
    await vi.advanceTimersByTimeAsync(300)
    expect(done()).toBe(false)
    written()
    await vi.advanceTimersByTimeAsync(0)
    expect(done()).toBe(true)
    // Its timer is not left behind.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for all of it, and takes a write that failed as one that is over', async () => {
    const gate = quitGate(2000)
    let written = (): void => {}
    const done = over(gate([Promise.reject(new Error('disk full')), new Promise<void>((resolve) => (written = resolve))])!)
    await vi.advanceTimersByTimeAsync(100)
    expect(done()).toBe(false)
    written()
    await vi.advanceTimersByTimeAsync(0)
    expect(done()).toBe(true)
  })

  it('gives a write that never ends its time once, and then lets every quit through: the app can always be quit', async () => {
    const gate = quitGate(2000)
    const stuck = new Promise<void>(() => {})
    const done = over(gate([stuck])!)
    await vi.advanceTimersByTimeAsync(1999)
    expect(done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done()).toBe(true)
    // The quit that follows finds the same write still under way.
    expect(gate([stuck])).toBeNull()
    expect(gate([stuck, stuck])).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has waited once also when the writes ended in time: a later quit is not held for others', async () => {
    const gate = quitGate(2000)
    await gate([Promise.resolve()])
    expect(gate([new Promise<void>(() => {})])).toBeNull()
  })
})

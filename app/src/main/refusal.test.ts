import { describe, expect, it, vi } from 'vitest'
import { REFUSED } from '../shared/refusal'
import { Refusal, refusable } from './refusal'

describe('refusable', () => {
  it('resolves a refusal as a tagged value: the handler does not throw, so Electron logs nothing', async () => {
    const handler = refusable(async () => {
      throw new Refusal('angle is measured between two planar faces')
    })
    await expect(handler()).resolves.toEqual({ [REFUSED]: 'angle is measured between two planar faces' })
  })
  it('a refusal thrown synchronously too', async () => {
    const handler = refusable(() => {
      throw new Refusal('End the session first')
    })
    await expect(handler()).resolves.toEqual({ [REFUSED]: 'End the session first' })
  })
  it('anything else still rejects', async () => {
    const handler = refusable(async () => {
      throw new Error('the kernel is gone')
    })
    await expect(handler()).rejects.toThrow('the kernel is gone')
  })
  it('passes the arguments and the value through', async () => {
    const fn = vi.fn((a: number, b: number) => a + b)
    await expect(refusable(fn)(2, 3)).resolves.toBe(5)
    expect(fn).toHaveBeenCalledWith(2, 3)
  })
})

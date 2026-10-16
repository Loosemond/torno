import { REFUSED, type Refused } from '../shared/refusal'

/**
 * An expected refusal of what the person asked (a dimension the kernel will
 * not measure, a change that is not valid): the window says why, and nothing
 * is logged. Anything else thrown in a handler is a failure, and is logged.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/**
 * A handler for `ipcMain.handle` that resolves a `Refusal` as `{ [REFUSED]:
 * message }` instead of throwing it: Electron prints every handler that
 * throws. The preload's `unrefused` throws it again in the window.
 */
export function refusable<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>): (...args: A) => Promise<R | Refused> {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch (e) {
      if (e instanceof Refusal) return { [REFUSED]: e.message }
      throw e
    }
  }
}

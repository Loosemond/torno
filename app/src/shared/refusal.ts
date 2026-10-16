/**
 * How main answers the window when it refuses what the person asked (a
 * `Refusal` in main): as a value under this key, not as a thrown error, which
 * Electron would print on the terminal with its stack. The preload turns it
 * back into an Error with the same message (`unrefused`), so the window sees
 * a rejection as before.
 */
export const REFUSED = '__tornoRefused'

export interface Refused {
  [REFUSED]: string
}

/** Throws the message of a refusal main resolved with; passes anything else through. */
export function unrefused<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>)[REFUSED] === 'string') {
    throw new Error((value as unknown as Refused)[REFUSED])
  }
  return value
}

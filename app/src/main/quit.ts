/**
 * Whether a quit has to wait for what is still being written, and for how
 * long. Each call is one attempt to quit, given what is under way then (null
 * for a store with nothing under way). It answers null when the quit may go
 * through, or a promise to quit again after: resolved once all of it is
 * done, written or failed, and after `limitMs` at the latest.
 *
 * It waits once. Every attempt after the first wait is let through, whatever
 * is under way: a write that never ends must not keep the app from quitting.
 */
export function quitGate(limitMs: number): (writing: ReadonlyArray<Promise<unknown> | null>) => Promise<void> | null {
  let waited = false
  return (writing) => {
    const under = writing.filter((one): one is Promise<unknown> => one !== null)
    if (waited || under.length === 0) return null
    waited = true
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, limitMs)
      void Promise.allSettled(under).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

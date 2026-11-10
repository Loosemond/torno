import type { BuildState } from '../shared/build'

/** How many of an object's last build times are kept: `wait_build` tells them while a build runs. */
const KEPT_TIMES = 3

/**
 * The builds of the open objects as they begin and end, for what waits on one (`wait_build`, `mcp/waitTool.ts`). Fed
 * every `BuildState` main tells (`onBuild` in `index.ts`); it keeps nothing of an object but when its build began and
 * ended and how long its last ones took.
 */
export class BuildWaits {
  private readonly began = new Map<string, number>()
  private readonly ended = new Map<string, number>()
  private readonly times = new Map<string, { revision: number; seconds: number[] }>()
  private readonly status = new Map<string, BuildState['status']>()
  private waiters = new Set<() => void>()

  /** A build began, ended or changed otherwise: everything waiting is woken to look again. */
  changed(state: BuildState, now: number = Date.now()): void {
    const was = this.status.get(state.objectId)
    this.status.set(state.objectId, state.status)
    if (state.status === 'building') this.began.set(state.objectId, state.startedAt ?? now)
    else if ((state.status === 'ok' || state.status === 'failed') && was === 'building') {
      // Only the end of a build: an ended state told again (its parts let go, its marks checked) ends nothing.
      this.ended.set(state.objectId, now)
      const kept = this.times.get(state.objectId)
      if (state.status === 'ok' && state.seconds !== undefined && kept?.revision !== state.revision) {
        this.times.set(state.objectId, { revision: state.revision, seconds: [...(kept?.seconds ?? []), state.seconds].slice(-KEPT_TIMES) })
      }
    }
    const waiting = this.waiters
    this.waiters = new Set()
    for (const wake of waiting) wake()
  }

  /** When the build of an object running now, or the last one, began (ms epoch); undefined before any. */
  beganAt(objectId: string): number | undefined {
    return this.began.get(objectId)
  }

  /** When the last build of an object ended, worked or not (ms epoch); undefined before any. */
  endedAt(objectId: string): number | undefined {
    return this.ended.get(objectId)
  }

  /** How long the last successful builds of an object took, in seconds, the oldest first. */
  lastTimes(objectId: string): number[] {
    return this.times.get(objectId)?.seconds ?? []
  }

  /** Resolves at the next change of any build, at `until` (ms epoch), or when `signal` aborts, whichever comes first. */
  next(until: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        done()
      }
      const timer = setTimeout(wake, Math.max(0, until - Date.now()))
      this.waiters.add(wake)
      if (signal?.aborted) wake()
      else signal?.addEventListener('abort', wake, { once: true })
    })
  }
}

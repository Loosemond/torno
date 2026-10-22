import type { FilletDiagnosis } from './diagnosis'

export type BuildStatus = 'idle' | 'building' | 'ok' | 'failed'
export interface BuildError {
  kind: string
  message: string
  traceback?: string
  output?: string
  /** Why a fillet or a chamfer of build123d failed, found by the worker that failed (`diagnose.py`); `sameAs` of its edges is main's. */
  diagnosis?: FilletDiagnosis
  /** `output` is the stderr of the kernel process that stopped (set by main where it makes that error), not what the model printed. */
  kernelStderr?: true
}
export interface BuildState {
  objectId: string
  status: BuildStatus
  revision: number            // last successful build; 0 if none
  startedAt?: number          // ms epoch, while building
  seconds?: number            // duration of the last finished build
  error?: BuildError          // when failed
  stale: boolean              // true when the parts on screen are older than the latest attempt
  /** The kernel let the last build of this object go to make room for the one running (memory): nothing answers of it until a build lands. */
  letGo?: 'memory'
}

/** The key of "Rebuild", written out: main's sentences name it and do not carry the table of keys (`keys.test.ts` holds it to the table). */
export const REBUILD_KEY = 'Ctrl+Shift+B'
/** How whoever is told that something must be built again is told how: the button is in the status line, whatever the build's state. */
export const REBUILD_HOW = `Press Rebuild in the status line of torno (${REBUILD_KEY}) to build again`

/** What is said, in the status line and to the agent, while the kernel holds no build of an object because it let the last one go to make room; null otherwise. */
export function letGoText(state: Pick<BuildState, 'status' | 'letGo'>): string | null {
  if (state.letGo !== 'memory') return null
  if (state.status === 'building') return 'The last build was let go to make room (memory): tools answer when this one lands.'
  if (state.status === 'failed') return 'The last build was let go to make room (memory) and this one failed: tools answer once the model builds again.'
  // Let go for another object's build, with none of its own on the way: one is started when a tool or the person asks something of it.
  return 'This build was let go to make room (memory): it is built again when something is asked of it.'
}

/** The most of a failed build's error that a line of the chat keeps, in characters. */
export const ERROR_LINE = 300

/**
 * What the build line of the chat shows of a failure: the last line of its traceback, which names the kind
 * (`NameError: name 'WAL' is not defined`), or of its message where it has no traceback; cut to what a line holds.
 */
export function errorLine(error: Pick<BuildError, 'message' | 'traceback'>): string {
  const lastOf = (text: string | undefined): string => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
  const line = lastOf(error.traceback) || lastOf(error.message)
  return line.length > ERROR_LINE ? `${line.slice(0, ERROR_LINE - 1)}…` : line
}

/**
 * Which build a failure is told as: a revision names a build that worked, as the builds count them, so a failure
 * has no number of its own and is "the build after r2" (the one still on show), or "the first build" when none
 * has worked yet. `revision` is `BuildState.revision`.
 */
export function failedAfter(revision: number): string {
  return revision > 0 ? `build after r${revision}` : 'first build'
}

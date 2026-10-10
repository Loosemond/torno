export type BuildStatus = 'idle' | 'building' | 'ok' | 'failed'
export interface BuildError { kind: string; message: string; traceback?: string; output?: string }
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

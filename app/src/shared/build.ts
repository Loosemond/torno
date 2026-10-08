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
}

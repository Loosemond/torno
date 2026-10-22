/**
 * What torno needs before anything can run, as main finds it before it fails (`main/ready.ts`): Claude Code, uv and
 * the Python environment of the kernel. The window words it (`renderer/ui/readiness.ts`); nothing here is a ref
 * or an address, and nothing of the person's Claude Code configuration is read to make it.
 */

/** The kernel of the open workspace: not started (no workspace), starting, up with its versions, or stopped for good. */
export type KernelState =
  | { state: 'none' }
  | { state: 'starting' }
  | { state: 'ready'; versions: Record<string, string> }
  | { state: 'failed'; reason: string }

/** What torno's own environment (`making`) is doing when the person asked for it ("Make it now"): never a workspace's. */
export type Making =
  | { state: 'idle' }
  | { state: 'making'; lines: string[] }
  | { state: 'failed'; reason: string; lines: string[] }

export interface Ready {
  /** The PATH torno looks on, after the login shell's on a Mac. */
  searched: string
  claude: {
    /** The command looked for: `claude`, or what `TORNO_AGENT_CMD` names. */
    command: string
    /** Where it was found; null when it is not on the PATH. */
    path: string | null
    /** From `claude --version`, once asked and answered. */
    version?: string
    /** Set when the version is outside the range torno was checked with. */
    range?: 'older' | 'newer'
    /** The versions torno was checked with, for the line that says `range`. */
    tested?: { min: string; max: string }
    /** From `claude auth status`, once asked and answered. Absent: not known. */
    account?: 'signed-in' | 'signed-out'
    /** The CLI was asked and did not answer (in time, or at all): it may start and leave at once. */
    silent?: boolean
  }
  uv: { path: string | null; version?: string }
  /**
   * The Python environment the kernel of the open workspace runs in: the workspace's own `.venv` when it has a
   * `pyproject.toml` (`workspace`: torno never makes it), else torno's (`torno`: made by uv the first time, about 900 MB).
   */
  environment: { kind: 'torno' | 'workspace'; dir: string; made: boolean }
  /** What the person asked for of torno's own environment. */
  making: Making
  kernel: KernelState
}

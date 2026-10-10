// `id` is the folder name. `hasProject` is true when `<root>/pyproject.toml` exists.
export interface ObjectInfo { id: string; name: string; dir: string; model: string | null; problem?: string }
/** `example`: it is torno's own temporary copy of the example, which is removed when torno quits. */
export interface WorkspaceInfo { root: string; hasProject: boolean; objects: ObjectInfo[]; example?: true }
/** Said in the window under the name of the workspace, for as long as the example is the one open. */
export const EXAMPLE_NOTE = 'A temporary copy: it is removed when torno quits'

/** A folder opened lately, as the first screen lists it. `missing`: it is no longer a folder. */
export interface RecentFolder { root: string; missing: boolean }

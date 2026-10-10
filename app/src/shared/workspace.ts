// `id` is the folder name. `hasProject` is true when `<root>/pyproject.toml` exists.
export interface ObjectInfo { id: string; name: string; dir: string; model: string | null; problem?: string }
export interface WorkspaceInfo { root: string; hasProject: boolean; objects: ObjectInfo[] }
/** A folder opened lately, as the first screen lists it. `missing`: it is no longer a folder. */
export interface RecentFolder { root: string; missing: boolean }

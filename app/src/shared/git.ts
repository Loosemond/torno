/**
 * What git says of a project's sources, read and never written (`main/git.ts`). Paths are from the workspace's
 * folder, with `/`: `box/model.py`, `common/util.py`.
 */
export interface GitState {
  /** The first seven characters of the commit checked out; null in a repository with no commit yet. */
  head: string | null
  /** The branch; null when `HEAD` is detached. */
  branch: string | null
  /** The files of the project (its folder, without `.torno/`) and of `common/` that differ from `HEAD`, or are not tracked. At most `GIT_MOST_FILES`. */
  files: string[]
  /** How many files differ in all (`files` may be fewer). */
  changed: number
}

/** The most file names a state carries. */
export const GIT_MOST_FILES = 30

/** `3 files changed since a1b2c3d`, `No changes since a1b2c3d`, `2 files not committed yet`. */
export function gitSaid(git: GitState): string {
  const files = `${git.changed} ${git.changed === 1 ? 'file' : 'files'}`
  if (git.head === null) return git.changed === 0 ? 'No commit yet' : `${files} not committed yet`
  return git.changed === 0 ? `No changes since ${git.head}` : `${files} changed since ${git.head}`
}

/** The files for a tooltip, one to a line, with how many more there are. */
export function gitFilesSaid(git: GitState): string {
  const more = git.changed - git.files.length
  return [...git.files, ...(more > 0 ? [`and ${more} more`] : [])].join('\n')
}

/**
 * What a build was made from: the hash of the sources it read, and the commit they stood on. Kept with the
 * build in `.torno/builds.jsonl` (`main/buildlog.ts`) and told with a revision.
 */
export interface BuildIdentity {
  /** The first twelve characters of the SHA-256 of the sources. */
  sources: string
  /** The commit checked out when the build landed (seven characters); absent where there is no git, or no commit yet. */
  head?: string
  /** Files differed from `head` when it landed. */
  dirty?: true
}

/** `sources 9f3e1a2b4c5d, on a1b2c3d with changes`: a build's identity in words. */
export function identitySaid(id: BuildIdentity): string {
  const on = id.head === undefined ? '' : `, on ${id.head}${id.dirty ? ' with changes' : ''}`
  return `sources ${id.sources}${on}`
}

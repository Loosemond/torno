import { bytes } from './format'

/**
 * A file or a folder of instructions that Claude Code reads by default for an object (`main/instructions.ts` finds
 * them): by path and size only. torno never reads their text.
 * - `managed`: the organisation's `CLAUDE.md`; `user`: the person's `~/.claude/CLAUDE.md` or `~/.claude/rules/`;
 * - `project`: a `CLAUDE.md`, `.claude/CLAUDE.md` or `.claude/rules/` of the object's folder or one above it;
 * - `local`: a `CLAUDE.local.md`; `agents`: an `AGENTS.md` or `.claude/AGENTS.md`, which Claude Code reads only
 *   when it finds no `CLAUDE.md` or `CLAUDE.local.md` in the folder or above it.
 */
export type InstructionKind = 'managed' | 'user' | 'project' | 'local' | 'agents'

export interface InstructionFile {
  /** Absolute. For a rules folder, the folder. */
  path: string
  /** The path as shown: the home folder as `~`. */
  shown: string
  kind: InstructionKind
  /** A link: reported by its own path and never followed, so it has no size. */
  link?: true
  /** A file's size; for a rules folder, the size of the `.md` files found under it. */
  bytes?: number
  /** A rules folder (`.claude/rules/`): how many `.md` files were counted under it. */
  files?: number
  /** A rules folder: how many links in it were not followed. */
  links?: number
  /** A rules folder where the walk stopped at its cap of entries or depth: the counts are at least these. */
  partial?: true
}

/** A rules folder is shown with its closing slash. */
export const isRules = (file: InstructionFile): boolean => file.files !== undefined

/** The most of a list that is told in words, the rest counted. */
export const MOST_LISTED = 6

/** What a file or folder weighs, as the pane and the prompt say it: `7.1 KB`, `3 files, 2.1 KB`, `a link, not followed`. */
export function weighed(file: InstructionFile): string {
  if (file.link) return 'a link, not followed'
  const size = file.bytes === undefined ? '' : bytes(file.bytes)
  if (!isRules(file)) return size
  const count = file.files ?? 0
  const parts = [`${file.partial ? 'at least ' : ''}${count} ${count === 1 ? 'file' : 'files'}`, ...(count > 0 ? [size] : []), ...(file.links ? [`${file.links} ${file.links === 1 ? 'link' : 'links'} not followed`] : [])]
  return parts.join(', ')
}

/** The path as the pane and the prompt name it: a rules folder with its slash. */
export const named = (file: InstructionFile): string => (isRules(file) && !file.shown.endsWith('/') ? `${file.shown}/` : file.shown)

/**
 * What the agent is told with the first prompt of a session, when Claude Code reads instruction files for the
 * object: which, and which wins for seeing and measuring. Null when there are none.
 */
export function instructionsLine(files: readonly InstructionFile[]): string | null {
  if (files.length === 0) return null
  const listed = files.slice(0, MOST_LISTED).map((file) => `${named(file)} (${weighed(file)})`)
  const more = files.length > MOST_LISTED ? ` and ${files.length - MOST_LISTED} more` : ''
  return `Claude Code loads these instruction files here: ${listed.join(', ')}${more}. What torno's tools say of the build is current: a file that names another viewer, report or export step is about another way of working, so take its advice on how to model, not on how to see the build.`
}

/** What the pane says of them, in a title: what the list is, and what it is not. */
export const READS_TITLE = "The instruction files Claude Code reads by default for this folder: the object's folder and every folder above it, and yours. torno lists their paths and sizes and never reads or changes them. Imports, files Claude Code loads later, and settings that leave files out are not followed. What torno's tools say of the build is current."

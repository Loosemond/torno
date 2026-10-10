import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RecentFolder } from '../shared/workspace'

// The folders opened lately, for the first screen. They are kept in torno's own config file, beside the
// workspace to open at the next start: never in a workspace, and nowhere else.

export const MAX_RECENT = 8

/** What the config file holds: the workspace opened last, and those opened lately, the newest first. */
export interface Config {
  workspace?: string
  recent: string[]
}

/** The folders with one more opened: it comes first, is there once, and the oldest beyond `MAX_RECENT` go. */
export function recentWith(list: readonly string[], root: string): string[] {
  return [root, ...list.filter((one) => one !== root)].slice(0, MAX_RECENT)
}

export function recentWithout(list: readonly string[], root: string): string[] {
  return list.filter((one) => one !== root)
}

/** A config out of whatever the file holds: one written before there was a list has none. */
export function configOf(value: unknown): Config {
  const file = (typeof value === 'object' && value !== null ? value : {}) as { workspace?: unknown; recent?: unknown }
  const recent = Array.isArray(file.recent) ? file.recent.filter((one): one is string => typeof one === 'string' && isAbsolute(one)) : []
  return { ...(typeof file.workspace === 'string' && file.workspace ? { workspace: file.workspace } : {}), recent: [...new Set(recent)].slice(0, MAX_RECENT) }
}

/** The folders as the first screen lists them: one that is no longer a folder is said to be missing, and stays until it is removed. */
export function listed(recent: readonly string[]): Promise<RecentFolder[]> {
  return Promise.all(
    recent.map(async (root) => ({
      root,
      missing: !(await stat(root).then(
        (s) => s.isDirectory(),
        () => false
      ))
    }))
  )
}

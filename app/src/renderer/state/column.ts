/**
 * How the person likes the left column: which of the sections above the marks are folded, and the height the
 * splitter gave the marks (null: their share, what is left under the others). It is the window's, kept in its own
 * storage (`localStorage`), never in the workspace: it is not part of an object. A storage that is not there or
 * refuses leaves the defaults, and a write that fails is let go.
 */

/** The sections that fold. Marks never does. */
export type ColumnSection = 'objects' | 'layers' | 'params' | 'checks' | 'scans'

export interface ColumnPrefs {
  folded: Record<ColumnSection, boolean>
  /** Pixels: the height the marks were given with the splitter, at least `MARKS_FLOOR`; null for their share. */
  marks: number | null
}

/** Objects is a switcher of one row to begin with, and the parameters and the model's checks one row too: the room goes to the marks. */
export const COLUMN_DEFAULT: ColumnPrefs = { folded: { objects: true, layers: false, params: true, checks: true, scans: false }, marks: null }

export const COLUMN_KEY = 'torno.column'

/**
 * The least the marks are given, in pixels: their title, a group's heading and five rows of 30 px. The same as
 * `--marks-floor` in `styles/panels.css`.
 */
export const MARKS_FLOOR = 212

const SECTIONS: readonly ColumnSection[] = ['objects', 'layers', 'params', 'checks', 'scans']

/** The window's storage, or null where there is none to be had. */
export function windowStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readColumn(storage: Pick<Storage, 'getItem'> | null): ColumnPrefs {
  let kept: unknown
  try {
    kept = JSON.parse(storage?.getItem(COLUMN_KEY) ?? 'null')
  } catch {
    return COLUMN_DEFAULT
  }
  if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) return COLUMN_DEFAULT
  const { folded, marks } = kept as { folded?: unknown; marks?: unknown }
  const fold = (typeof folded === 'object' && folded !== null ? folded : {}) as Record<string, unknown>
  return {
    folded: Object.fromEntries(SECTIONS.map((section) => [section, typeof fold[section] === 'boolean' ? fold[section] : COLUMN_DEFAULT.folded[section]])) as ColumnPrefs['folded'],
    marks: typeof marks === 'number' && Number.isFinite(marks) && marks >= MARKS_FLOOR ? Math.round(marks) : null
  }
}

export function writeColumn(storage: Pick<Storage, 'setItem'> | null, prefs: ColumnPrefs): void {
  try {
    storage?.setItem(COLUMN_KEY, JSON.stringify(prefs))
  } catch {
    // A storage that refuses (a private window, blocked site data): the window goes on as it is.
  }
}

/**
 * Whether the list of objects is the switcher: folded, while an object is open or a new one is being made, in a
 * workspace of more than one object. With no object open, on the page of objects, or with one object alone (shown
 * by itself already) the list is whole.
 */
export function switcherShown(s: { folded: boolean; objects: readonly unknown[]; objectId: string | null; page: 'object' | 'objects' | 'new' }): boolean {
  return s.folded && s.objects.length > 1 && (s.page === 'new' || (s.page === 'object' && s.objectId !== null))
}

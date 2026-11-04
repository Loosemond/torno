import type { HistoryEntry, HistoryList } from '../../shared/history'
import { ago } from './chat/ago'

// The words of the history sheet (`HistorySheet.tsx`) that are not markup: pure, so a test holds them.

/** Where the copy of a file of a kept build lies: under `<project>/.torno/history/`, which only the agent reads. */
export const copyPathOf = (list: Pick<HistoryList, 'base'>, entry: Pick<HistoryEntry, 'id'>, file: string): string => `${list.base}/${entry.id}/source/${file}`

/** `h41`, and `r3` beside it for a build made in this run (a revision is of one run alone). */
export function nameOf(list: Pick<HistoryList, 'run'>, entry: Pick<HistoryEntry, 'id' | 'run' | 'revision'>): string {
  return entry.run === list.run ? `${entry.id} · r${entry.revision}` : entry.id
}

/** What a card says of a build besides its change: starred, failing checks, defects, dimensions that failed then. All as of then. */
export function marksOf(entry: HistoryEntry): string[] {
  return [
    ...(entry.failing ? [entry.failing.length === 1 ? '1 check failed' : `${entry.failing.length} checks failed`] : []),
    ...(entry.defects ? [entry.defects.length === 1 ? '1 part with a defect' : `${entry.defects.length} parts with defects`] : []),
    ...(entry.dimensions && entry.dimensions.fail > 0 ? [entry.dimensions.fail === 1 ? '1 dimension failed' : `${entry.dimensions.fail} dimensions failed`] : [])
  ]
}

/** The request put in the message box to go back to a kept build: the agent edits, under the person's permission rules; torno restores nothing. */
export function goBackPrompt(list: HistoryList, entry: HistoryEntry, project: string, now: number = Date.now()): string {
  const when = ago(entry.at, now)
  const made = entry.run === list.run ? `build ${entry.id} (r${entry.revision}), made ${when}` : `build ${entry.id}, made ${when}`
  const files = entry.files.map((file) => copyPathOf(list, entry, file)).join(', ')
  const commit = entry.head && !entry.dirty ? ` Its files are those of commit ${entry.head}.` : ''
  return `Go back to ${made}: ${entry.line}. The Python files it was built from are kept as copies, to read only: ${files}.${commit} Change the files of ${project} to match them, then build and say what you changed. Do not edit the copies.`
}

/** Said under the sheet's buttons when a request cannot be made for a build. */
export const NO_COPY = 'No copy of the sources was kept for this build: they were too large, or changed while they were read.'

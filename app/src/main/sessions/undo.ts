import type { FileChange, TurnChanges } from '../../shared/changes'

// What torno asks of the agent to take a turn back: a prompt in torno's own words with the lines to reverse, worked
// out from the two texts main kept of each file (`snapshots.ts`). Torno writes nothing of the model: the agent does,
// through its own tools and the permission card of each edit, as it would at any request of the person's.

/** The most characters of reversed lines a prompt holds, for all the files together. A file beyond it is named and not listed. */
export const MAX_REVERSE_CHARS = 12_000
/** The lines of what did not change kept on each side of a change, so that the agent finds its place. */
const CONTEXT = 1

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/**
 * The lines that take `after` back to `before`, as one block: the lines `after` has between what the two texts share
 * at their start and at their end, as `-`, and the lines `before` has there, as `+`, with a line of what is shared on
 * each side. Null when the two are the same.
 */
export function reverseBlock(before: string, after: string): string | null {
  if (before === after) return null
  const a = linesOf(after)
  const b = linesOf(before)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1
  const from = Math.max(0, start - CONTEXT)
  const rows = [
    ...a.slice(from, start).map((t) => `  ${t}`),
    ...a.slice(start, a.length - end).map((t) => `- ${t}`),
    ...b.slice(start, b.length - end).map((t) => `+ ${t}`),
    ...a.slice(a.length - end, Math.min(a.length, a.length - end + CONTEXT)).map((t) => `  ${t}`)
  ]
  return `from line ${from + 1}:\n${rows.join('\n')}`
}

/** What one file asks, in a paragraph; `left` is how many characters of lines the prompt may still hold. */
function paragraph(change: FileChange, stale: boolean, left: number): { text: string; used: number } {
  const note = stale ? ' It has been changed again since that turn, so read it as it is now and undo only what the turn did.' : ''
  const none = (text: string): { text: string; used: number } => ({ text: `${text}${note}`, used: 0 })
  if (change.tooLarge) return none(`${change.file}: the turn changed it, and it is too large for torno to have kept its earlier text. Undo it from what you remember of the turn, and say so if you cannot.`)
  if (change.before === null) return none(`${change.file}: the turn made this file. Remove it, or empty it if you cannot remove it.`)
  const block = change.after === null ? `was removed; write it back as it was:\n${change.before}` : reverseBlock(change.before, change.after)
  if (block === null) return none(`${change.file}: no change.`)
  if (block.length > left) return none(`${change.file}: the turn changed it, and the lines are too many to list here. Undo it from what you remember of the turn, and say so if you cannot.`)
  return { text: `${change.file}, ${block}${note}`, used: block.length }
}

/** The names of the files the prompt is about, for the note that says what was asked. */
export const undoFiles = (changes: TurnChanges): string[] => changes.files.map((f) => f.file)

/**
 * The prompt that asks the agent to put the model files back as they were before its last turn. `now` is what each
 * file holds now (null: not there); a file that no longer holds what the turn left is said to have changed since.
 */
export function undoPrompt(changes: TurnChanges, now: Map<string, string | null>): string {
  let left = MAX_REVERSE_CHARS
  const parts = changes.files.map((change) => {
    const stale = !change.tooLarge && now.has(change.file) && now.get(change.file) !== change.after
    const { text, used } = paragraph(change, stale, left)
    left -= used
    return text
  })
  return [
    'Undo your last turn: put the model files back as they were before it. Make the edits yourself, with your own tools (torno does not write the model), let the build run and tell me how it went.',
    'These are the lines to reverse, from what torno read of each file before and after that turn. A line with "-" is in the file now and goes; a line with "+" comes back; a line with two spaces is only there to find the place.',
    parts.join('\n\n')
  ].join('\n\n')
}

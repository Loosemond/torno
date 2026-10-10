import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

// What git is told to pass over among the files torno keeps directly under an object's `.torno/`: one file,
// `<object>/.torno/.gitignore`, and this its one writer. (The folders `.torno/views/` and `.torno/scans/` each
// ignore what is in them with a file of their own, written by whoever makes the folder.)

/** One change at a time per file: a line asked for while another is being added is not lost. */
const turns = new Map<string, Promise<void>>()

/**
 * Has git pass over `lines` (patterns, relative to `<dir>/.torno/`): each that `.torno/.gitignore` does not
 * hold is added at its end, and the file is made when there is none. Nothing that is there is ever removed or
 * rewritten, and a pattern the person negated (`!thumb.png`) is theirs to decide: it is not added against that.
 * With nothing to add, nothing is written.
 */
export function ensureIgnored(dir: string, lines: readonly string[]): Promise<void> {
  const path = join(dir, '.torno', '.gitignore')
  const turn = (turns.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return ''
        throw e
      })
      const held = new Set(text.split(/\r?\n/).map((line) => line.trim()))
      const missing = [...new Set(lines)].filter((line) => !held.has(line) && !held.has(`!${line}`))
      if (missing.length === 0) return
      await writeFileAtomic(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`)
    })
    .finally(() => {
      if (turns.get(path) === turn) turns.delete(path)
    })
  turns.set(path, turn)
  return turn
}

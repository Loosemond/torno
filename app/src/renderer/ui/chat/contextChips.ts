/** What the chips under a prompt say of the context it went with: the build the agent was told of, and the selection. */
export interface ContextChips {
  build: { revision: number; state: 'ok' | 'failed' | 'building' } | undefined
  selection: string[]
}

const MOST_REFS = 6

/**
 * Read from the text itself (`main/context.ts`): its first line says how the build stands (`build ok · r12`,
 * `BUILD FAILED · showing r12`, `building … · showing r12`), the line that begins `Selected:` lists the refs.
 * The marks are not read here: the transcript item names them.
 */
export function contextChips(text: string): ContextChips {
  const first = text.split('\n')[0] ?? ''
  const revision = /\br(\d+)\b/.exec(first)?.[1]
  const state = /· build ok\b/.test(first) ? 'ok' : /BUILD FAILED/.test(first) ? 'failed' : /· building\b/.test(first) ? 'building' : undefined
  const selected = /^Selected: (.*)$/m.exec(text)?.[1] ?? ''
  const refs = [...new Set(selected.match(/[\w.-]+\/[FE]\d+\b/g) ?? [])].slice(0, MOST_REFS)
  return { build: revision !== undefined && state !== undefined ? { revision: Number(revision), state } : undefined, selection: refs }
}

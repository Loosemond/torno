import { readFile } from 'node:fs/promises'
import { type ChatModel, EFFORTS, isEffort, MODEL_ALIASES, MODEL_NAME } from '../../shared/chat'
import { writeFileAtomic } from '../atomic'

// The models a session can be started on, before it has said its own: the list the last chat's CLI offered (its
// `initialize`), kept in torno's own user data (`models.json`, beside the folders opened lately), or Claude Code's
// aliases when none has yet. Never read from Claude Code's settings, and never written there.

/** The most models kept of a list. */
const MOST = 40

/**
 * The models a CLI offered, for the window: those that have a name to be chosen by and could be passed to it
 * (`MODEL_NAME`), each with the efforts it takes when the CLI said (`supportedEffortLevels`; none when it says the
 * model takes no effort), in the order of `EFFORTS`.
 */
export function modelsOf(models: unknown): ChatModel[] {
  const out: ChatModel[] = []
  for (const m of Array.isArray(models) ? models : []) {
    const one = typeof m === 'object' && m !== null ? (m as { value?: unknown; displayName?: unknown; supportsEffort?: unknown; supportedEffortLevels?: unknown; efforts?: unknown }) : null
    if (typeof one?.value !== 'string' || !MODEL_NAME.test(one.value) || out.some((o) => o.value === one.value)) continue
    const levels = Array.isArray(one.supportedEffortLevels) ? one.supportedEffortLevels : Array.isArray(one.efforts) ? one.efforts : one.supportsEffort === false ? [] : null
    const efforts = levels === null ? undefined : EFFORTS.filter((e) => levels.some((l: unknown) => isEffort(l) && l === e))
    const name = typeof one.displayName === 'string' && one.displayName !== '' && !/[\u0000-\u001f\u007f-\u009f]/.test(one.displayName) ? one.displayName.slice(0, 80) : one.value
    out.push({ value: one.value, displayName: name, ...(efforts ? { efforts } : {}) })
    if (out.length >= MOST) break
  }
  return out
}

/** The last list of models a chat's CLI offered: in `file` (written whole, atomically), or, with none, for this run only. */
export class KnownModels {
  private memory: ChatModel[] | null = null

  constructor(private readonly file: string | null) {}

  /** The models to offer before a session: the last list heard, else Claude Code's aliases. */
  async list(): Promise<ChatModel[]> {
    if (this.memory) return this.memory
    if (this.file) {
      try {
        const kept = modelsOf((JSON.parse(await readFile(this.file, 'utf8')) as { models?: unknown }).models)
        if (kept.length > 0) return (this.memory = kept)
      } catch {
        // No file yet, or one that is not ours: the aliases.
      }
    }
    return [...MODEL_ALIASES]
  }

  /** A CLI said which models it offers. Kept when it named any; a write that fails leaves the list of this run. */
  async heard(models: readonly ChatModel[]): Promise<void> {
    if (models.length === 0) return
    const same = this.memory !== null && JSON.stringify(this.memory) === JSON.stringify(models)
    this.memory = [...models]
    if (!this.file || same) return
    await writeFileAtomic(this.file, `${JSON.stringify({ models }, null, 2)}\n`).catch(() => {})
  }
}

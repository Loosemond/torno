// The next useful prompts, offered as chips above the box of the chat. The pure part of `Suggestions.tsx`.
import { fixPrompt } from '../../../shared/build'
import { type ChatItem, TORNO_TOOL_PREFIX } from '../../../shared/chat'

/** The most chips offered at once. */
export const MOST_SUGGESTIONS = 3

/** What a chip puts in the box: never sent by the chip itself. */
export interface Suggestion {
  id: 'fix' | 'review' | 'printable' | 'explain'
  label: string
  text: string
}

export interface SuggestInput {
  /** The latest build failed. */
  buildFailed: boolean
  objectName: string
  /** How many marks are not resolved (drafts, sent), the dimensions that fail or have no value among them. */
  openMarks: number
  layouts: readonly string[]
  /** The items of the conversation, and of the one it resumed. */
  items: readonly ChatItem[]
  /** Whether the CLI said torno's tools are not connected: its prompts are not there to ask for. */
  tornoDisconnected: boolean
}

/** The checks of the print prompt: a turn that made one has looked at printability. */
const PRINT_CHECKS = ['thin', 'overhang', 'mesh', 'bed']

/** Whether the conversation has already checked the print layout, by the prompt or by the tool. */
export function printChecked(items: readonly ChatItem[]): boolean {
  return items.some((item) => {
    if (item.kind === 'user') return item.text.trimStart().startsWith(`/${TORNO_TOOL_PREFIX}printable`)
    if (item.kind !== 'tool' || item.name !== `${TORNO_TOOL_PREFIX}check`) return false
    const kind = (item.input as { kind?: unknown } | null)?.kind
    return typeof kind === 'string' && PRINT_CHECKS.includes(kind)
  })
}

/**
 * The chips to offer, at most three and each only when it applies: the build failed, marks are open, the model has a
 * `print` layout nobody has checked, a conversation not begun. The commands end in a space, as one completed from the
 * list does, for an argument.
 */
export function suggest(input: SuggestInput): Suggestion[] {
  const chips: Suggestion[] = []
  if (input.buildFailed) chips.push({ id: 'fix', label: 'Fix the build', text: fixPrompt(input.objectName) })
  if (!input.tornoDisconnected) {
    if (input.openMarks > 0) chips.push({ id: 'review', label: `Review ${input.openMarks} ${input.openMarks === 1 ? 'mark' : 'marks'}`, text: `/${TORNO_TOOL_PREFIX}review ` })
    if (input.layouts.includes('print') && !printChecked(input.items)) chips.push({ id: 'printable', label: 'Check printability', text: `/${TORNO_TOOL_PREFIX}printable ` })
    if (!input.items.some((i) => i.kind === 'user')) chips.push({ id: 'explain', label: 'Explain this model', text: `/${TORNO_TOOL_PREFIX}explain ` })
  }
  return chips.slice(0, MOST_SUGGESTIONS)
}

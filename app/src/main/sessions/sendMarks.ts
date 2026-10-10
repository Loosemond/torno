/** `<object>/.torno/prompt.md`: what an agent without hooks is told to read by the line "Send marks" puts at its cursor. */
export const PROMPT_FILE = 'prompt.md'

const MOST_NAMED = 8

/** The one line that is pasted: `torno: 2 new marks (M4, M5) and the build status are in .torno/prompt.md. Read it first.` */
export function sendLine(markIds: readonly string[]): string {
  if (markIds.length === 0) return 'torno: the build status and the open marks are in .torno/prompt.md. Read it first.'
  const named = markIds.length > MOST_NAMED ? `${markIds.slice(0, MOST_NAMED).join(', ')} and ${markIds.length - MOST_NAMED} more` : markIds.join(', ')
  return `torno: ${markIds.length} new mark${markIds.length === 1 ? '' : 's'} (${named}) and the build status are in .torno/prompt.md. Read it first.`
}

/** What `.torno/prompt.md` holds: when it was written, then the context. */
export function promptFile(context: string, at: Date): string {
  return `Written ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC by torno, for the prompt that follows it.\n\n${context}\n`
}

const ESC = '\x1b'
const PASTE_MARKS = new Set(['200', '201'])

/** Where a sequence that began at `from` is ended by BEL or by ESC \; -1 when it is not. */
function endOfString(data: string, from: number): number {
  for (let i = from; i < data.length; i += 1) {
    if (data[i] === '\x07') return i + 1
    if (data[i] === ESC && data[i + 1] === '\\') return i + 2
  }
  return -1
}

/**
 * Whether a CSI sequence is one that leaves the agent's input as it was: an
 * answer of the terminal's own to something the agent asked (where the cursor
 * is, what it is, a mode, its size, its keyboard), the focus coming or going,
 * a report of the pointer, or the two ends of a paste. Every key that moves
 * the cursor or changes the line is some other.
 */
function leavesTheLine(params: string, intermediates: string, final: string): boolean {
  if (intermediates === '$') return final === 'y'
  if (intermediates !== '') return false
  switch (final) {
    case 'I':
    case 'O':
      return params === ''
    case 'R':
      return /^\d+;\d+$/.test(params)
    case 'n':
      return /^\d+$/.test(params)
    case 'c':
    case 'u':
      return /^[?>]/.test(params)
    case 't':
      return /^\d+(;\d+)*$/.test(params)
    case 'M':
    case 'm':
      return params.startsWith('<')
    case '~':
      return PASTE_MARKS.has(params)
    default:
      return false
  }
}

/**
 * What became of a line torno put at an agent's cursor, read from one piece
 * of what was written to its terminal afterwards:
 *   - `sent`: an Enter came, and nothing before it that torno cannot follow;
 *   - `kept`: text was typed or pasted beside it, a line was broken in the
 *     prompt (Esc Enter, as Shift+Enter writes it), or the terminal answered
 *     the agent: the line is still there, as far as torno can tell;
 *   - `lost`: anything else. A key that deletes, clears, completes, recalls
 *     another prompt or moves the cursor, or a sequence torno does not know:
 *     the line may no longer be what was put there, and what an Enter then
 *     sends is not known to name the file.
 * The terminal's own answers are told from keys by their form alone.
 */
export function followTyped(data: string): 'kept' | 'sent' | 'lost' {
  let i = 0
  while (i < data.length) {
    const code = data.charCodeAt(i)
    if (data[i] === '\r') return 'sent'
    if (data[i] !== ESC) {
      // A control character is a key of its own: backspace, ^U, ^C, a tab that completes.
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 'lost'
      i += 1
      continue
    }
    const next = data[i + 1]
    if (next === '\r') i += 2
    else if (next === ']' || next === 'P') {
      const end = endOfString(data, i + 2)
      if (end < 0) return 'lost'
      i = end
    } else if (next === '[') {
      const csi = /^([0-9:;<=>?]*)([ -/]*)([@-~])/.exec(data.slice(i + 2))
      if (!csi || !leavesTheLine(csi[1], csi[2], csi[3])) return 'lost'
      i += 2 + csi[0].length
    } else return 'lost'
  }
  return 'kept'
}

/** Whether a piece of what was written to a terminal holds an Enter: a carriage return that Esc does not turn into a new line. */
export function hasEnter(data: string): boolean {
  return /(^|[^\x1b])\r/.test(data)
}

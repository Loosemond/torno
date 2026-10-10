/** `<object>/.torno/prompt.md`: what an agent without hooks is told to read by the line "Send marks" puts at its cursor. */
export const PROMPT_FILE = 'prompt.md'

const MOST_NAMED = 8

/** The one line that is pasted: `torno: 2 new marks (M4, M5) and the build status are in .torno/prompt.md. Read it first.` */
export function sendLine(markIds: readonly string[]): string {
  if (markIds.length === 0) return 'torno: the build status and the open marks are in .torno/prompt.md. Read it first.'
  const named = markIds.length > MOST_NAMED ? `${markIds.slice(0, MOST_NAMED).join(', ')} and ${markIds.length - MOST_NAMED} more` : markIds.join(', ')
  return `torno: ${markIds.length} new mark${markIds.length === 1 ? '' : 's'} (${named}) and the build status are in .torno/prompt.md. Read it first.`
}

/**
 * How a line begins, as it is looked for in what the agent shows: its words up to the first mark it names
 * (`torno: 2 new marks (M4`), or its first words when it names none. Short enough to stand on one row of a
 * terminal, and not what a CLI writes of its own accord about a server called torno.
 */
export function lineHead(line: string): string {
  return /^torno: \d+ new marks? \(M\d+/.exec(line)?.[0] ?? line.slice(0, 23)
}

/** What `.torno/prompt.md` holds: when it was written, then the context. */
export function promptFile(context: string, at: Date): string {
  return `Written ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC by torno, for the prompt that follows it.\n\n${context}\n`
}

/** What the file is made to hold when a session of an agent without hooks starts or ends: one line, so that nothing an earlier session was to be told is read as new. */
export function nothingNew(at: Date): string {
  return `Nothing new from torno as of ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC: no line of its is waiting to be sent. The build and the open marks are in .torno/state.md.\n`
}

const ESC = '\x1b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

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
 * a report of the pointer, or a key that moves along the line and changes
 * nothing (Left, Right, Home, End, with or without a modifier). Up and Down
 * recall another prompt, and every other key changes the line.
 */
function leavesTheLine(params: string, intermediates: string, final: string): boolean {
  if (intermediates === '$') return final === 'y'
  if (intermediates !== '') return false
  switch (final) {
    case 'I':
    case 'O':
      return params === ''
    case 'C':
    case 'D':
    case 'H':
    case 'F':
      return params === '' || /^1;\d+$/.test(params)
    case '~':
      return ['1', '4', '7', '8'].includes(params)
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
    default:
      return false
  }
}

/**
 * What became of a line torno put at an agent's cursor, read from one piece
 * of what was written to its terminal afterwards:
 *   - `sent`: an Enter came, and before it nothing but what leaves the line;
 *   - `kept`: nothing that touches the line. The terminal answered the agent,
 *     the focus came or went, the pointer was reported, or the cursor was
 *     moved along the line (Left, Right, Home, End);
 *   - `lost`: anything else. Text that was typed (an answer to a question the
 *     CLI has up, a word that opens a menu, words added to the line), a paste
 *     (whose line breaks are carriage returns and send nothing), Esc Enter (a
 *     new line), a key that deletes, clears, completes or recalls another
 *     prompt, or a sequence torno does not know: what an Enter then does is
 *     not known to be sending that line.
 * The terminal's own answers are told from keys by their form alone.
 */
export function followTyped(data: string): 'kept' | 'sent' | 'lost' {
  let i = 0
  while (i < data.length) {
    if (data[i] === '\r') return 'sent'
    // Typed, or a control character, which is a key of its own: backspace, ^U, ^C, a tab that completes.
    if (data[i] !== ESC) return 'lost'
    const next = data[i + 1]
    if (next === ']' || next === 'P') {
      const end = endOfString(data, i + 2)
      if (end < 0) return 'lost'
      i = end
    } else if (next === 'O' && 'CDHF'.includes(data[i + 2] ?? ' ')) i += 3
    else if (next === '[' && data[i + 2] === 'M') {
      // The pointer, as a terminal without the SGR form reports it: three bytes follow.
      if (i + 6 > data.length) return 'lost'
      i += 6
    } else if (next === '[') {
      const csi = /^([0-9:;<=>?]*)([ -/]*)([@-~])/.exec(data.slice(i + 2))
      if (!csi || !leavesTheLine(csi[1], csi[2], csi[3])) return 'lost'
      i += 2 + csi[0].length
    } else return 'lost'
  }
  return 'kept'
}

/**
 * Whether a piece of what was written to a terminal holds an Enter: a
 * carriage return that is not a line break inside a paste (also one that
 * does not end in the piece), and that Esc does not turn into a new line.
 */
export function hasEnter(data: string): boolean {
  let outside = ''
  let from = 0
  for (;;) {
    const start = data.indexOf(PASTE_START, from)
    if (start < 0) {
      outside += data.slice(from)
      break
    }
    outside += data.slice(from, start)
    const end = data.indexOf(PASTE_END, start)
    if (end < 0) break
    from = end + PASTE_END.length
  }
  return /(^|[^\x1b])\r/.test(outside)
}

/**
 * Whether what an agent wrote to its terminal shows the line torno put at
 * its cursor: the head of that very line (`lineHead`), once colours, moves
 * and titles are taken out, and not followed by the number of another mark.
 * A prompt shows what is pasted into it; a question that is up in its place
 * (whether the folder is trusted, a permission) does not, and what the CLI
 * says by itself of a server named torno is not that line.
 */
export function lineShown(output: string, line: string): boolean {
  const plain = output
    .replace(/\x1b[\]P][\s\S]*?(\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  const head = lineHead(line)
  for (let at = plain.indexOf(head); at >= 0; at = plain.indexOf(head, at + 1)) {
    // `(M4` is not shown by `(M45`.
    if (!/\d$/.test(head) || !/\d/.test(plain[at + head.length] ?? '')) return true
  }
  return false
}

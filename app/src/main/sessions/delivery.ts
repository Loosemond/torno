import { join } from 'node:path'
import type { AgentId, SendDropped, SendState } from '../../shared/bridge'
import { FOLDER, writeOwn } from '../own'
import type { PromptContext } from '../context'
import { SESSION_FILE, storeConversation } from './resume'
import { followTyped, hasEnter, lineShown, nothingNew, PROMPT_FILE, promptFile, sendLine } from './sendMarks'

/** The most that is kept of what an agent wrote since a line was put at its cursor, to look for that line in. */
const SHOWN_LIMIT = 16 * 1024

/**
 * Makes `<object>/.torno/prompt.md` say that there is nothing new: when a session of an agent without hooks
 * starts, and when it ends. Whatever the file told of before was for another session, and an agent told to
 * read it must not take it for what the person has just made. Not when a line that named the file is dropped
 * (something was typed after it): the person may still send that line by hand, and what the file holds is true.
 */
export function blankPrompt(dir: string): Promise<void> {
  return writeOwn(dir, PROMPT_FILE, nothingNew(new Date()))
}

/** What is kept of a session of an agent without hooks, about what it has been told. */
export interface Told {
  /**
   * The marks told of by the file its line at the cursor names, while that
   * line is there and not sent; null when none is.
   */
  pending: string[] | null
  /** Its conversation has been told nothing by torno yet, so no mark is known there by its number. */
  fresh: boolean
  /** Its conversation is on file, to be resumed. */
  onFile: boolean
  /** The last writing of `.torno/prompt.md` for this session: one at a time, in the order asked. */
  telling: Promise<unknown>
  /** What the agent has written to its terminal since the line was put at its cursor, until the line was seen in it. */
  shown: string
  /** The agent showed the line: it was pasted into a prompt, not into a question that was up in its place. */
  echoed: boolean
  /** The line that was put at its cursor, to be looked for in what it shows. */
  line: string
}

/** A session that has been told nothing yet. `fresh`: its conversation has seen no line of torno's. */
export function untold(fresh: boolean, onFile: boolean): Told {
  return { pending: null, fresh, onFile, telling: Promise.resolve(), shown: '', echoed: false, line: '' }
}

/** A session, as much of it as telling its agent needs. */
export interface ToldSession extends Told {
  id: string
  object: { id: string; dir: string }
  conversationId: string
  adapter: { id: AgentId; toolName(tool: string): string }
}

/**
 * How an agent that posts no hooks is told what a hook would have carried,
 * and when what it was told counts as sent: a file, a line that names it put
 * at the agent's cursor, and the Enter that sends that line.
 */
export class Delivery<S extends ToldSession = ToldSession> {
  constructor(
    private readonly host: {
      contextFor: (objectId: string, opts: { fresh: boolean; toolName: (tool: string) => string }) => PromptContext | Promise<PromptContext>
      onDelivered?: (objectId: string, sentMarkIds: string[]) => void
      /** Whether the session is still there and has not been hung up on. */
      live(s: S): boolean
      /** Put text at its cursor as a paste, not sent. */
      insert(s: S, text: string): void
      /** What became of the line, how many marks its file tells of, and why it was dropped when it was. */
      said(s: S, state: SendState, marks: number, why?: SendDropped): void
    }
  ) {}

  /**
   * What was written to the terminal of an agent without hooks is all torno
   * knows of what it was asked. An Enter says the person sent something: the
   * conversation is one to resume. And of a line torno put at its cursor it
   * says what became of it (`followTyped`). The marks its file tells of are
   * delivered by an Enter only when all of this holds since the paste: the
   * agent showed the line (`output`: it was at a prompt), and nothing was
   * typed or pasted after it. Otherwise the line is dropped: nothing is
   * delivered, and why is said. The file stays as it was written: the line
   * may still be sent with what was typed after it, and it names the file.
   */
  typed(s: S, data: string): void {
    if (!s.onFile && hasEnter(data)) {
      s.onFile = true
      this.onFile(s, false)
    }
    if (s.pending === null) return
    const became = followTyped(data)
    if (became === 'kept') return
    const marks = s.pending
    s.pending = null
    if (became === 'sent' && s.echoed) {
      s.fresh = false
      // From now on this conversation knows the marks it was told of, also when it is resumed.
      this.onFile(s, true)
      if (marks.length > 0) this.host.onDelivered?.(s.object.id, marks)
      return this.host.said(s, 'sent', marks.length)
    }
    this.host.said(s, 'dropped', marks.length, became === 'sent' ? 'absent' : 'typed')
  }

  /**
   * Something that is not a key of the person's and not torno's own line was put at the agent's cursor (the
   * selection's "Insert", a paste from the app): what an Enter then sends is not the line as it was. As when
   * something is typed after it, the line is dropped and the marks it told of stay drafts.
   */
  inserted(s: S): void {
    if (s.pending === null) return
    const marks = s.pending
    s.pending = null
    this.host.said(s, 'dropped', marks.length, 'typed')
  }

  /** What the agent wrote to its terminal: while a line waits at its cursor, where that line is looked for. */
  output(s: S, data: string): void {
    if (s.pending === null || s.echoed) return
    s.shown = (s.shown + data).slice(-SHOWN_LIMIT)
    if (lineShown(s.shown, s.line)) {
      s.echoed = true
      s.shown = ''
    }
  }

  /** The session has gone. A line that was never sent went with it: the marks are drafts still, and the file says nothing of them. */
  ended(s: S): Promise<void> {
    s.pending = null
    const blanked = s.telling.catch(() => {}).then(() => blankPrompt(s.object.dir)).catch((e) => console.error(`cannot write ${join(s.object.dir, FOLDER, PROMPT_FILE)}: ${e instanceof Error ? e.message : String(e)}`))
    s.telling = blanked
    return blanked
  }

  private onFile(s: S, told: boolean): void {
    storeConversation(s.object.dir, s.adapter.id, s.conversationId, { told }).catch((e) => console.error(`cannot write ${join(s.object.dir, FOLDER, SESSION_FILE)}: ${(e as Error).message}`))
  }

  /**
   * Writes what a hook would have carried with the agent's next prompt to
   * `<object>/.torno/prompt.md` and puts one line that names the file at its
   * cursor, not sent. The marks the file tells of for the first time are
   * answered, and are delivered (`onDelivered`) by the Enter that sends the
   * line. While a line is already there, nothing more is put in: the file and
   * the marks it stands for are replaced.
   */
  send(s: S): Promise<{ marks: string[]; line: string }> {
    return this.tell(s, true).then((told) => told!)
  }

  /**
   * What is told of the session's object changed: its marks, or its build.
   * While a line waits at the cursor of its agent, the file that line names
   * is written again, so that what an Enter then sends for is what is so.
   */
  changed(s: S): void {
    if (s.pending !== null) this.tell(s, false).catch((e) => console.error(`cannot write ${join(s.object.dir, FOLDER, PROMPT_FILE)} again: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Write the file of a session and, when `asked`, put its line at the cursor. Null when there was nothing to do. */
  private tell(s: S, asked: boolean): Promise<{ marks: string[]; line: string } | null> {
    const told = s.telling
      .catch(() => {})
      .then(async () => {
        // Sent or lost while this waited its turn: the file is of a prompt that has gone.
        if (!asked && s.pending === null) return null
        const { text, sentMarkIds } = await this.host.contextFor(s.object.id, { fresh: s.fresh, toolName: s.adapter.toolName })
        if (!text) {
          if (asked) throw new Error('Nothing to send: nothing has been built here yet')
          return null
        }
        await writeOwn(s.object.dir, PROMPT_FILE, promptFile(text, new Date()))
        if (!this.host.live(s)) {
          if (asked) throw new Error('This session has ended')
          return null
        }
        if (!asked && s.pending === null) return null
        const line = sendLine(sentMarkIds)
        // The line that is there names the file, whatever it holds by now. A new one is looked for in what the agent writes from here on.
        if (s.pending === null) {
          s.shown = ''
          s.echoed = false
          // Waiting before it is put in: what the agent shows of it is then of a line that waits.
          s.pending = sentMarkIds
          s.line = line
          this.host.insert(s, line)
        }
        s.pending = sentMarkIds
        this.host.said(s, 'waiting', sentMarkIds.length)
        return { marks: sentMarkIds, line }
      })
    s.telling = told
    return told
  }
}

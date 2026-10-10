import { join } from 'node:path'
import type { AgentId, SendState } from '../../shared/bridge'
import { writeFileAtomic } from '../atomic'
import type { PromptContext } from '../context'
import { SESSION_FILE, storeConversation } from './resume'
import { followTyped, hasEnter, PROMPT_FILE, promptFile, sendLine } from './sendMarks'

const FOLDER = '.torno'

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
      /** What became of the line, and how many marks its file tells of. */
      said(s: S, state: SendState, marks: number): void
    }
  ) {}

  /**
   * What was written to the terminal of an agent without hooks is all torno
   * knows of what it was asked. An Enter says the person sent something: the
   * conversation is one to resume. And of a line torno put at its cursor it
   * says what became of it: sent by an Enter while it was still as put there,
   * and then the marks its file tells of are delivered; or possibly changed
   * first, and then they are not.
   */
  typed(s: S, data: string): void {
    if (!s.onFile && hasEnter(data)) {
      s.onFile = true
      try {
        storeConversation(s.object.dir, s.adapter.id, s.conversationId)
      } catch (e) {
        console.error(`cannot write ${join(s.object.dir, FOLDER, SESSION_FILE)}: ${(e as Error).message}`)
      }
    }
    if (s.pending === null) return
    const became = followTyped(data)
    if (became === 'kept') return
    const marks = s.pending
    s.pending = null
    if (became === 'sent') {
      s.fresh = false
      if (marks.length > 0) this.host.onDelivered?.(s.object.id, marks)
    }
    this.host.said(s, became === 'sent' ? 'sent' : 'dropped', marks.length)
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
        await writeFileAtomic(join(s.object.dir, FOLDER, PROMPT_FILE), promptFile(text, new Date()))
        if (!this.host.live(s)) {
          if (asked) throw new Error('This session has ended')
          return null
        }
        if (!asked && s.pending === null) return null
        const line = sendLine(sentMarkIds)
        // The line that is there names the file, whatever it holds by now.
        if (s.pending === null) this.host.insert(s, line)
        s.pending = sentMarkIds
        this.host.said(s, 'waiting', sentMarkIds.length)
        return { marks: sentMarkIds, line }
      })
    s.telling = told
    return told
  }
}

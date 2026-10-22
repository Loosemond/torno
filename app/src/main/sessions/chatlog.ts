import { constants } from 'node:fs'
import { lstat, mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatImage, ChatItem } from '../../shared/chat'
import { writeFileAtomic } from '../atomic'
import { ensureIgnored } from '../ignored'
import { ownTorno } from '../own'

// `<object>/.torno/chat/<conversation>.jsonl`: what a chat session said, one item to a line, as each item became
// final. Text only: the data of a picture is never written. The folder is ignored by git (it is the person's
// conversation, not the object's) and held to the rule of every folder under `.torno` (`ownTorno`).

const FOLDER = 'chat'
/** A conversation's id as the agent names it; anything else would be a path. */
const CONVERSATION = /^[A-Za-z0-9_-]{1,100}$/
/** Of a file larger than this only the end is read: the last items are all that is shown. */
const READ_TAIL_BYTES = 16 * 1024 * 1024

/** A log larger than this is cut when a session starts on it (`trimLog`), to its last `KEEP_LINES` lines. */
const TRIM_OVER_BYTES = 5 * 1024 * 1024
const KEEP_LINES = 2000

/** One change at a time per file, so that lines of one call are not mixed with those of another. */
const turns = new Map<string, Promise<void>>()

const nameOf = (conversationId: string): string => {
  if (!CONVERSATION.test(conversationId)) throw new Error(`not a conversation: ${conversationId.slice(0, 40)}`)
  return `${conversationId}.jsonl`
}

const withoutData = (images: ChatImage[]): ChatImage[] => images.map(({ data: _data, ...rest }) => rest)

/** The item as it is written: its pictures without their data. */
function written(item: ChatItem): ChatItem {
  if (item.kind === 'user' || item.kind === 'tool') return { ...item, images: withoutData(item.images) }
  return item
}

/**
 * Appends the items to the conversation's file. `redact` is applied to each line before it is written (an address
 * the agent was given must not reach a file). Rejects, writing nothing, when `.torno/chat` is a link or a file.
 */
export async function appendItems(dir: string, conversationId: string, items: readonly ChatItem[], redact: (text: string) => string = (text) => text): Promise<void> {
  const name = nameOf(conversationId)
  if (items.length === 0) return
  const lines = items.map((item) => `${redact(JSON.stringify(written(item)))}\n`).join('')
  const path = join(dir, '.torno', FOLDER, name)
  const turn = (turns.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const folder = await ownTorno(dir, FOLDER)
      await ensureIgnored(dir, [`${FOLDER}/`])
      await mkdir(folder, { recursive: true })
      // `ensureIgnored` made `.torno`; whoever made `chat` just now made a real folder.
      await ownTorno(dir, FOLDER)
      // Not through a link in the place of the file: `ownTorno` held the folder, not the file.
      const handle = await open(join(folder, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644)
      try {
        await handle.write(lines)
      } finally {
        await handle.close()
      }
    })
    .finally(() => {
      if (turns.get(path) === turn) turns.delete(path)
    })
  turns.set(path, turn)
  await turn
}

/** The last `limit` items of a conversation's file. A line that is not an item is skipped; no file, or one torno may not read, is no items. */
export async function readLog(dir: string, conversationId: string, limit = 500): Promise<ChatItem[]> {
  if (!CONVERSATION.test(conversationId)) return []
  let text: string
  try {
    const folder = await ownTorno(dir, FOLDER)
    text = await readTail(join(folder, nameOf(conversationId)))
  } catch {
    return []
  }
  const items: ChatItem[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const item: unknown = JSON.parse(line)
      if (typeof item === 'object' && item !== null && !Array.isArray(item) && typeof (item as { kind?: unknown }).kind === 'string' && typeof (item as { id?: unknown }).id === 'string') items.push(known(item as ChatItem))
    } catch {
      // A line cut short by a crash.
    }
  }
  return items.slice(-limit)
}

/** An item as read back, without what the window would act on and torno never wrote: a note's `action` other than `terminal`. */
function known(item: ChatItem): ChatItem {
  if (item.kind !== 'note' || !('action' in item) || item.action === 'terminal') return item
  const { action: _action, ...rest } = item
  return rest
}

async function readTail(path: string): Promise<string> {
  const { size } = await stat(path)
  const handle = await open(path, 'r')
  try {
    const length = Math.min(size, READ_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    // The first line of a tail is cut.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/**
 * At the start of a session on a conversation: a log over 5 MB is cut to its last 2,000 lines, whole, written
 * through a temp file beside it and renamed over it (so a reader or a crash sees the old log or the new one). It does
 * nothing for a log that is small, one that is not there, or one that is a link. Resolves true when it cut.
 */
export async function trimLog(dir: string, conversationId: string, overBytes = TRIM_OVER_BYTES, keep = KEEP_LINES): Promise<boolean> {
  if (!CONVERSATION.test(conversationId)) return false
  const path = join(dir, '.torno', FOLDER, nameOf(conversationId))
  const turn = (turns.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const folder = await ownTorno(dir, FOLDER)
      const file = join(folder, nameOf(conversationId))
      const info = await lstat(file)
      if (!info.isFile() || info.size <= overBytes) return false
      const lines = (await readTail(file)).split('\n').filter((line) => line.trim() !== '')
      await writeFileAtomic(file, `${lines.slice(-keep).join('\n')}\n`)
      return true
    })
    .catch(() => false)
  const done = turn.then(() => undefined)
  turns.set(path, done)
  void done.finally(() => {
    if (turns.get(path) === done) turns.delete(path)
  })
  return turn
}

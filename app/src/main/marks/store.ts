import type { Anchor, AnchorState, Mark, MarkPatch, MarksFile, NewMark } from '../../shared/marks'
import { loadMarksFile, sanitiseMark, saveMarksFile } from './file'

interface MarkEvents {
  /** The marks of an object changed: the whole list, as it now is. */
  changed: { objectId: string; marks: Mark[] }
  /** Something about an object's marks file the person should know, as a sentence. Said once. */
  problem: { objectId: string; message: string }
}

/** What a patch may change of any mark, and of a shape only. */
const COMMON_KEYS = ['note', 'status', 'resolvedNote'] as const
const SHAPE_KEYS = ['intent', 'position', 'rotation', 'size', 'shape'] as const

/**
 * The marks of the objects of the open workspace, and the only writer of their
 * `.torno/marks.json`. An object's marks are read once and then kept in
 * memory; what is done to them is done one thing at a time per object, each
 * change written before it is told. Every method rejects for an object whose
 * folder is not known.
 */
export class MarkStore {
  /** By object folder: the marks file as last read or written. */
  private files = new Map<string, MarksFile>()
  /** By object folder: the last thing asked of its marks, which the next waits for. */
  private turns = new Map<string, Promise<unknown>>()
  /** Counts `forget`: what was read before one is not kept after it. */
  private epoch = 0
  private listeners: { [E in keyof MarkEvents]: Array<(m: MarkEvents[E]) => void> } = { changed: [], problem: [] }

  constructor(private deps: { dirOf(objectId: string): string | undefined; now?(): Date }) {}

  on<E extends keyof MarkEvents>(event: E, cb: (m: MarkEvents[E]) => void): void {
    this.listeners[event].push(cb)
  }

  /** Forget what was read, as when the workspace is left. Files are read again when next asked for. */
  forget(): void {
    this.epoch += 1
    this.files.clear()
  }

  list(objectId: string): Promise<Mark[]> {
    return this.turn(objectId, (file) => structuredClone(file.marks))
  }

  add(objectId: string, mark: NewMark): Promise<Mark> {
    return this.change(objectId, (file) => {
      const added = sanitiseMark({ ...mark, id: `M${file.next}`, status: 'draft', anchorState: 'ok', createdAt: this.now().toISOString() })
      if (!added) throw new Error('that is not a mark: its kind is unknown, or a field is missing or not a finite number')
      file.next += 1
      file.marks.push(added)
      return added
    })
  }

  update(objectId: string, id: string, patch: MarkPatch): Promise<Mark> {
    return this.change(objectId, (file) => {
      const at = indexOf(file, id)
      const mark = file.marks[at]
      // What crosses from the window is whatever it sent: a patch that is no object changes nothing.
      const asked: MarkPatch = typeof patch === 'object' && patch !== null ? patch : {}
      const given = (keys: readonly (keyof MarkPatch)[]) => keys.filter((key) => asked[key] !== undefined)
      const forShape = given(SHAPE_KEYS)
      if (mark.kind !== 'shape' && forShape.length > 0) throw new Error(`${id} is a ${mark.kind}, not a shape: it has no ${forShape.join(', ')}`)
      // Forward, to resolved from anywhere, or back to draft when asked: all but sending a resolved mark again.
      if (mark.status === 'resolved' && asked.status === 'sent') throw new Error(`${id} is resolved: reopen it as a draft before it is sent again`)
      const changed = sanitiseMark({ ...mark, ...Object.fromEntries([...given(COMMON_KEYS), ...forShape].map((key) => [key, asked[key]])) })
      if (!changed) throw new Error(`that is not a valid change to ${id}`)
      file.marks[at] = changed
      return changed
    })
  }

  remove(objectId: string, id: string): Promise<void> {
    return this.change(objectId, (file) => {
      file.marks.splice(indexOf(file, id), 1)
    })
  }

  /**
   * Replaces anchors and anchor states in one write; ids not listed are
   * untouched. `anchors` are in the order of `markAnchors`. An id that is not
   * there is passed over: the mark may have been removed while a build ran.
   * A mark given no anchor keeps the one it has.
   */
  reanchor(objectId: string, changes: Array<{ id: string; anchors: Anchor[]; anchorState: AnchorState }>): Promise<void> {
    return this.change(objectId, (file) => {
      let any = false
      for (const { id, anchors, anchorState } of changes) {
        const at = file.marks.findIndex((m) => m.id === id)
        if (at < 0) continue
        const mark = file.marks[at]
        const anchor = anchors[0] ? { [mark.kind === 'arrow' ? 'from' : 'anchor']: anchors[0] } : {}
        const moved = sanitiseMark({ ...mark, ...anchor, anchorState })
        if (!moved) continue
        file.marks[at] = moved
        any = true
      }
      return any ? undefined : UNCHANGED
    }).then(() => {})
  }

  /** Turns every draft of the object into sent; returns the marks that changed. */
  markSent(objectId: string): Promise<Mark[]> {
    return this.change(objectId, (file) => {
      const drafts = file.marks.filter((m) => m.status === 'draft')
      for (const mark of drafts) mark.status = 'sent'
      return drafts.length > 0 ? drafts : UNCHANGED
    }).then((sent) => (sent === UNCHANGED ? [] : sent))
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * Change the marks of an object: `edit` is given a copy of the file to
   * change. The copy is written, then kept, then told; an `edit` that throws,
   * or a write that fails, leaves the marks as they were. An `edit` that
   * returns UNCHANGED writes and tells nothing.
   */
  private change<T>(objectId: string, edit: (file: MarksFile) => T): Promise<T> {
    return this.turn(objectId, async (current, dir, epoch) => {
      const file = structuredClone(current)
      const result = edit(file)
      if (result === UNCHANGED) return result
      await saveMarksFile(dir, file)
      // Told only to the workspace it was asked in: the write of one that has been left lands, and is not broadcast.
      if (epoch === this.epoch) {
        this.files.set(dir, file)
        this.emit('changed', { objectId, marks: structuredClone(file.marks) })
      }
      return structuredClone(result)
    })
  }

  /** Do one thing with the marks file of an object, after whatever was asked of it before. */
  private turn<T>(objectId: string, task: (file: MarksFile, dir: string, epoch: number) => T | Promise<T>): Promise<T> {
    const dir = this.deps.dirOf(objectId)
    if (dir === undefined) return Promise.reject(new Error(`no object named ${objectId} in the open workspace`))
    // As of the asking: the workspace may be left while this waits its turn.
    const epoch = this.epoch
    const turn = (this.turns.get(dir) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let file = this.files.get(dir)
        if (!file) {
          const loaded = await loadMarksFile(dir, () => this.now())
          file = loaded.file
          if (epoch === this.epoch) {
            this.files.set(dir, file)
            if (loaded.problem) this.emit('problem', { objectId, message: loaded.problem })
          }
        }
        return task(file, dir, epoch)
      })
      .finally(() => {
        if (this.turns.get(dir) === turn) this.turns.delete(dir)
      })
    this.turns.set(dir, turn)
    return turn
  }

  private emit<E extends keyof MarkEvents>(event: E, message: MarkEvents[E]): void {
    for (const cb of this.listeners[event]) cb(message)
  }
}

/** What an edit returns when it changed nothing. */
const UNCHANGED = Symbol('unchanged')

/** Where a mark is in its file; an id that is not there is an error that names the ones that are. */
function indexOf(file: MarksFile, id: string): number {
  const at = file.marks.findIndex((m) => m.id === id)
  if (at < 0) throw new Error(`no mark ${id}; marks: ${file.marks.map((m) => m.id).join(', ') || 'none'}`)
  return at
}

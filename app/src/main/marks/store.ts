import { isDeepStrictEqual } from 'node:util'
import { type Anchor, type AnchorState, type Mark, type MarkPatch, type MarksFile, type NewMark, type Replacement, type Vec3, MAIN_ONLY_KEYS, markAnchors, translated } from '../../shared/marks'
import { loadMarksFile, sanitiseMark, saveMarksFile } from './file'

/** What a check of a mark against a build found (`reanchorAll`), for `MarkStore.reanchor` to write. */
export interface Reanchored {
  id: string
  /**
   * The anchors the mark had when it was judged, in the order of `markAnchors`.
   * When the mark's are no longer these (it was put somewhere else meanwhile),
   * the entry is passed over: it says nothing of where the mark is now.
   */
  judged: Anchor[]
  /** Its anchors as the build leaves them, in the same order. A mark given none keeps the one it has. */
  anchors: Anchor[]
  anchorState: AnchorState
  /**
   * How far the part it is on was moved by the spread of its layout since the
   * mark was last checked: everything the mark holds in that frame moves with
   * it (`translated`). `anchors` are already there.
   */
  shift?: Vec3
  /** The revision of the build it was checked against. */
  checkedRevision?: number
}

interface MarkEvents {
  /** The marks of an object changed: the whole list, as it now is. */
  changed: { objectId: string; marks: Mark[] }
  /** Something about an object's marks file the person should know, as a sentence. Said once; `problem()` answers it afterwards. */
  problem: { objectId: string; message: string }
  /**
   * Marks whose anchors nothing has checked against the last build: those just
   * added, those reopened, which were passed over while they were resolved,
   * and those put somewhere else, which carry what their placer saw.
   * Told after the `changed` of the same change.
   */
  unchecked: { objectId: string; ids: string[] }
}

/** What a patch may change of any mark, and of a shape only. */
const COMMON_KEYS = ['note', 'status', 'resolvedNote'] as const
const SHAPE_KEYS = ['intent', 'position', 'rotation', 'size', 'shape'] as const
/** What a mark says to the agent, of what a patch may change: a change to any of it is news. */
const CONTENT_KEYS = ['note', ...SHAPE_KEYS] as const

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
  /**
   * By object folder: what was last found wrong with its marks file, until the
   * person dismisses it. Kept across `forget`: it is a fact about the folder,
   * whichever workspace was open when it was found.
   */
  private problems = new Map<string, string>()
  /** Counts `forget`: what was read before one is not kept after it. */
  private epoch = 0
  private listeners: { [E in keyof MarkEvents]: Array<(m: MarkEvents[E]) => void> } = { changed: [], problem: [], unchecked: [] }

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

  /**
   * What is wrong with the marks file of an object, as a sentence, or null. It
   * is told once as a `problem` event, to whoever listens then; this is for
   * whoever did not, and answers the same until `dismissProblem`.
   */
  problem(objectId: string): Promise<string | null> {
    return this.turn(objectId, (_file, dir) => this.problems.get(dir) ?? null)
  }

  /** The person has read what was wrong with the marks file of an object. */
  dismissProblem(objectId: string): Promise<void> {
    return this.turn(objectId, (_file, dir) => {
      this.problems.delete(dir)
    })
  }

  /**
   * Keeps a new mark, as a draft: what the agent is yet to be told. One the
   * agent made itself is added as `sent`, since there is nothing to tell.
   */
  add(objectId: string, mark: NewMark, status: 'draft' | 'sent' = 'draft'): Promise<Mark> {
    return this.change(objectId, (file) => {
      // What main alone says is not taken from whoever made the mark.
      const given = Object.fromEntries(Object.entries(Object(mark) as object).filter(([key]) => !(MAIN_ONLY_KEYS as readonly string[]).includes(key)))
      const added = sanitiseMark({ ...given, id: `M${file.next}`, status, anchorState: 'ok', createdAt: this.now().toISOString() })
      if (!added) throw new Error('that is not a mark: its kind is unknown, or a field is missing or not a finite number')
      file.next += 1
      file.marks.push(added)
      return added
    })
  }

  /**
   * Changes the note, the status or, of a shape, what it is. `by` is who asks:
   * a mark that becomes resolved says who resolved it.
   *
   * A mark of the person's that the agent was sent, and whose note or shape
   * is changed without the patch naming a status, is a draft again: the next
   * prompt carries it once more, as changed. A mark that is no longer
   * resolved forgets who resolved it. `acknowledged` can only be set, and only
   * on a mark the agent resolved.
   */
  update(objectId: string, id: string, patch: MarkPatch, by: 'user' | 'agent' = 'user'): Promise<Mark> {
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
      const said = changed as unknown as Record<string, unknown>
      const before = mark as unknown as Record<string, unknown>
      // What the agent was told of it no longer holds: it is told again.
      if (asked.status === undefined && mark.status === 'sent' && mark.author === 'user' && CONTENT_KEYS.some((key) => !isDeepStrictEqual(said[key], before[key]))) {
        changed.status = 'draft'
      }
      if (changed.status !== 'resolved') {
        delete changed.resolvedBy
        delete changed.acknowledged
      } else if (mark.status !== 'resolved') {
        changed.resolvedBy = by === 'agent' ? 'agent' : 'user'
        delete changed.acknowledged
      }
      if (asked.acknowledged !== undefined) {
        if (asked.acknowledged !== true || changed.status !== 'resolved' || changed.resolvedBy !== 'agent') throw new Error(`${id} was not resolved by the agent: there is nothing to acknowledge`)
        changed.acknowledged = true
      }
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
   * Puts a pin, a pick or an arrow somewhere else: the same mark, with its
   * number and its note, tied to the anchor given, as of that build and from
   * that view. An arrow starts there and keeps its length and direction. A
   * pick is of what the anchor names: the part again if it was of a part, else
   * that face or edge. The mark is taken to be on its surface until the check
   * that follows (`unchecked`) has said. One the agent had been sent is a
   * draft again: what it was told of the mark no longer holds. Strokes and
   * shapes are not moved this way, nor a resolved mark, nor a mark of the
   * agent's: where that is, is what the agent said.
   */
  replace(objectId: string, id: string, placed: Replacement): Promise<Mark> {
    return this.change(
      objectId,
      (file) => {
        const at = indexOf(file, id)
        const mark = file.marks[at]
        if (mark.kind !== 'pin' && mark.kind !== 'pick' && mark.kind !== 'arrow') throw new Error(`${id} is a ${mark.kind}: only a pin, a pick or an arrow is put somewhere else`)
        if (mark.author !== 'user') throw new Error(`${id} is the agent's mark: it is not put somewhere else`)
        if (mark.status === 'resolved') throw new Error(`${id} is resolved: reopen it first`)
        const anchor = (placed as Replacement | null)?.anchor
        if (typeof anchor !== 'object' || anchor === null || typeof anchor.part !== 'string') throw new Error(`${id} was not put on a part`)
        // Nothing has checked it where it now is.
        const common = { anchorState: 'ok', status: 'draft', revision: placed.revision, camera: placed.camera, checkedRevision: undefined } as const
        let moved: Mark | null
        if (mark.kind === 'arrow') {
          const by = mark.to.map((c, i) => c - mark.from.point[i])
          moved = sanitiseMark({ ...mark, ...common, from: anchor, to: by.map((c, i) => c + anchor.point?.[i]) })
        } else if (mark.kind === 'pick') {
          const whole = mark.target === 'part'
          const target = whole ? 'part' : /\/E\d+$/.test(anchor.ref ?? '') ? 'edge' : 'face'
          // The kernel's line was of the face or edge clicked: of the whole part the check says anew.
          const { descriptor: _ofWhatWasClicked, ...bare } = anchor
          moved = sanitiseMark({ ...mark, ...common, target, anchor: whole ? { ...bare, ref: anchor.part } : anchor })
        } else {
          moved = sanitiseMark({ ...mark, ...common, anchor })
        }
        if (!moved) throw new Error(`${id} cannot be put there: a point, a revision or a camera is missing or not a finite number`)
        file.marks[at] = moved
        return moved
      },
      [id]
    )
  }

  /**
   * Writes what a check of the marks against a build found, in one write; ids
   * not listed are untouched. An id that is not there is passed over: the
   * mark may have been removed while the check ran. So is a mark whose
   * anchors are no longer the ones that were judged: it was put somewhere
   * else meanwhile, and the check that follows that is of where it is now.
   * A mark given no anchor keeps the one it has.
   */
  reanchor(objectId: string, changes: Reanchored[]): Promise<void> {
    return this.change(objectId, (file) => {
      let any = false
      for (const { id, judged, anchors, anchorState, shift, checkedRevision } of changes) {
        const at = file.marks.findIndex((m) => m.id === id)
        if (at < 0) continue
        const mark = file.marks[at]
        if (!isDeepStrictEqual(markAnchors(mark), judged)) continue
        // Whatever else the mark holds is moved from where it is now: a shape may have been dragged meanwhile.
        const where = shift && anchors[0] ? translated(mark, shift) : mark
        const anchor = anchors[0] ? { [mark.kind === 'arrow' ? 'from' : 'anchor']: anchors[0] } : {}
        const moved = sanitiseMark({ ...where, ...anchor, anchorState, ...(checkedRevision === undefined ? {} : { checkedRevision }) })
        if (!moved) continue
        file.marks[at] = moved
        any = true
      }
      return any ? undefined : UNCHANGED
    }).then(() => {})
  }

  /**
   * Turns the drafts of the object into sent, in one write: all of them, or
   * those of `ids` only. Returns the marks that changed. An id that is not
   * there, or not a draft any more, is passed over.
   */
  markSent(objectId: string, ids?: readonly string[]): Promise<Mark[]> {
    return this.change(objectId, (file) => {
      const drafts = file.marks.filter((m) => m.status === 'draft' && (ids === undefined || ids.includes(m.id)))
      for (const mark of drafts) {
        mark.status = 'sent'
        mark.sentBefore = true
      }
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
   * returns UNCHANGED writes and tells nothing. `moved` are marks the edit
   * tied to other geometry: they are told as unchecked, like those added.
   */
  private change<T>(objectId: string, edit: (file: MarksFile) => T, moved: readonly string[] = []): Promise<T> {
    return this.turn(objectId, async (current, dir, epoch) => {
      const file = structuredClone(current)
      const result = edit(file)
      if (result === UNCHANGED) return result
      await saveMarksFile(dir, file)
      // Told only to the workspace it was asked in: the write of one that has been left lands, and is not broadcast.
      if (epoch === this.epoch) {
        this.files.set(dir, file)
        this.emit('changed', { objectId, marks: structuredClone(file.marks) })
        const was = new Map(current.marks.map((m) => [m.id, m.status]))
        const unchecked = file.marks.filter((m) => m.status !== 'resolved' && ((was.get(m.id) ?? 'resolved') === 'resolved' || moved.includes(m.id))).map((m) => m.id)
        if (unchecked.length > 0) this.emit('unchecked', { objectId, ids: unchecked })
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
          // Which build a mark was checked against is of the run that checked it: revisions count anew in
          // this one, and a number read from the file would pass for one of them.
          for (const mark of file.marks) delete mark.checkedRevision
          if (loaded.problem) this.problems.set(dir, loaded.problem)
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

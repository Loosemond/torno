import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionStatus } from '../../shared/bridge'
import type { BuildState } from '../../shared/build'
import { standingOf, unmetDimensions } from '../../shared/dimension'
import type { DimensionMark, Mark } from '../../shared/marks'
import type { ObjectCard, ThumbnailOf } from '../../shared/show'
import type { ObjectInfo } from '../../shared/workspace'
import { writeFileAtomic } from '../atomic'
import { sanitiseMarksFile } from '../marks/file'

// The cards of the page of objects, and the picture each has on file. A card is read, never made: nothing here
// builds an object, starts a worker, opens a session or loads a scan, and of an object not opened in this run
// nothing is written or set aside either.

const FOLDER = '.torno'
export const THUMB_PNG = 'thumb.png'
export const THUMB_JSON = 'thumb.json'
/** The most a picture may weigh. One of 480 × 360 is some 20 KB; the worst there is, noise in every pixel, 700 KB. */
export const THUMB_MAX_BYTES = 512 * 1024
const THUMB_WIDTH = 480
const THUMB_HEIGHT = 360
/** The longest first line of a build's error a card carries. */
const MAX_ERROR = 200

export interface CardDeps {
  objects(): ObjectInfo[]
  opened(objectId: string): boolean
  build(objectId: string): BuildState | undefined
  /** The marks of an object opened in this run, from the store. */
  marks(objectId: string): Promise<Mark[]>
  session(objectId: string): SessionStatus | null
  /** Rejects when there is none. */
  readFile(path: string): Promise<string>
  /** Null when there is none. */
  mtimeMs(path: string): Promise<number | null>
}

/** One card per object of the workspace, in the list's order. */
export function cardsOf(deps: CardDeps): Promise<ObjectCard[]> {
  return Promise.all(deps.objects().map((obj) => cardOf(deps, obj)))
}

async function cardOf(deps: CardDeps, obj: ObjectInfo): Promise<ObjectCard> {
  const opened = deps.opened(obj.id)
  const state = opened ? deps.build(obj.id) : undefined
  // Of an object opened here the store has the marks, checked against its build. Of another, what its file
  // says is read and nothing more: the store would set a file it cannot read aside, and that is a write.
  const marks = opened ? await deps.marks(obj.id).catch(() => null) : await deps.readFile(join(obj.dir, FOLDER, 'marks.json')).then(peekMarks, (e: unknown) => (isMissing(e) ? [] : null))
  const meta = await deps.readFile(join(obj.dir, FOLDER, THUMB_JSON)).then((text) => JSON.parse(text) as unknown).catch(() => null)
  let thumb = thumbOf(meta, obj.model === null ? null : await deps.mtimeMs(join(obj.dir, obj.model)).catch(() => null))
  // A picture of what another file made is behind, whenever that one was last saved.
  if (thumb && (meta as { model?: unknown }).model !== obj.model) thumb = { ...thumb, behind: true }

  const card: ObjectCard = { id: obj.id, name: obj.name, opened, thumb, marks: marks && { open: marks.filter((m) => m.status !== 'resolved').length, drafts: marks.filter((m) => m.status === 'draft').length }, dimensions: null, session: deps.session(obj.id) }
  if (obj.problem !== undefined) card.problem = obj.problem
  if (state) {
    card.build = { status: state.status, revision: state.revision, stale: state.stale }
    if (state.letGo) card.build.letGo = state.letGo
    if (state.error) card.build.error = firstLine(state.error.message)
  }
  if (!marks) return card
  const open = marks.filter((m): m is DimensionMark => m.kind === 'dimension' && m.status !== 'resolved')
  if (state && state.revision > 0) {
    // As the status line counts them: against the last build of this run, and by no other.
    const unmet = unmetDimensions(marks, state.revision)
    card.dimensions = { failing: unmet.failing.length, unmeasured: unmet.unmeasured.length, passing: open.filter((m) => standingOf(m, state.revision) === 'pass').length }
  } else if (open.length > 0) {
    card.lastRun = { dimensions: open.length, failed: open.filter((m) => m.verdict === 'fail').length }
  }
  return card
}

function firstLine(message: string): string {
  return (message.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, MAX_ERROR)
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The marks of a folder as its file has them, read and nothing else: no file is set aside, nothing is written. Null when it cannot be read as one. */
export function peekMarks(text: string): Mark[] | null {
  try {
    return sanitiseMarksFile(JSON.parse(text))?.marks ?? null
  } catch {
    return null
  }
}

/** What a `thumb.json` says, against the model file as it is now. Null for what is not one. */
export function thumbOf(meta: unknown, modelMtimeMs: number | null): ObjectCard['thumb'] {
  const said = meta as { at?: unknown; layout?: unknown; modelMtimeMs?: unknown; cut?: unknown; apart?: unknown; hidden?: unknown } | null
  if (typeof said !== 'object' || said === null || typeof said.at !== 'string' || typeof said.layout !== 'string' || said.layout === '') return null
  const made = typeof said.modelMtimeMs === 'number' ? said.modelMtimeMs : null
  const thumb: NonNullable<ObjectCard['thumb']> = { at: said.at.slice(0, 40), layout: said.layout.slice(0, 100), behind: made === null || modelMtimeMs === null || modelMtimeMs > made }
  if (said.cut === true) thumb.cut = true
  if (said.apart === true) thumb.apart = true
  if (typeof said.hidden === 'number' && Number.isSafeInteger(said.hidden) && said.hidden > 0) thumb.hidden = said.hidden
  return thumb
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Why bytes the window handed over are not kept as a picture, or null: a PNG, 480 × 360, at most `THUMB_MAX_BYTES`. */
export function thumbnailRefusal(png: Uint8Array): string | null {
  if (!(png instanceof Uint8Array)) return 'not a PNG'
  if (png.length > THUMB_MAX_BYTES) return 'a picture of more than 512 KB'
  if (png.length < 24 || PNG_HEAD.some((byte, i) => png[i] !== byte)) return 'not a PNG'
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return header.getUint32(16) === THUMB_WIDTH && header.getUint32(20) === THUMB_HEIGHT ? null : 'not a 480 × 360 picture'
}

/**
 * Keeps a picture of an object and what it is of: `<dir>/.torno/thumb.png`, then `thumb.json`, each whole or not
 * at all. The first time, git is told to pass over the two (they change with every build); a `.gitignore`
 * that is there already is the person's and is left as it is.
 */
export async function saveThumbnail(dir: string, png: Uint8Array, of: ThumbnailOf & { model: string; modelMtimeMs: number | null }, now: Date): Promise<void> {
  await writeFileAtomic(join(dir, FOLDER, THUMB_PNG), png)
  const meta: Record<string, unknown> = { at: now.toISOString(), layout: of.layout, parts: of.parts, model: of.model, modelMtimeMs: of.modelMtimeMs }
  if (of.cut) meta.cut = true
  if (of.apart) meta.apart = true
  if (of.hidden) meta.hidden = of.hidden
  await writeFileAtomic(join(dir, FOLDER, THUMB_JSON), `${JSON.stringify(meta)}\n`)
  await writeFile(join(dir, FOLDER, '.gitignore'), `${THUMB_PNG}\n${THUMB_JSON}\n`, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
}

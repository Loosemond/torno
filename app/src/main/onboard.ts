import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { OnboardDraft, Onboarded } from '../shared/bridge'
import { number } from '../shared/format'
import { moduleName } from '../shared/objectName'
import type { Scene } from '../shared/scene'
import { SCAN_FORMATS } from '../shared/scans'
import type { ObjectInfo } from '../shared/workspace'
import { FOLDER } from './own'
import { MOST, oneLine } from './objects/create'
import { THUMB_MAX_BYTES, THUMB_PNG } from './show/cards'
import type { Sessions } from './sessions/manager'
import type { PromptBlock } from './sessions/stream'
import { type ImageBytes, checkedImage } from './images'
// The rule of a picture main attaches (`images.ts`), named here too, where it was first.
export { type ImageBytes, MAX_EDGE, MAX_IMAGE_BYTES, checkedImage } from './images'

// The first prompt of a new object and the call that sends it. The window made the object (`objects:create`) and
// opened it; this imports its scans, starts its chat session, and tells the agent, in one prompt, all that the
// person gave. What the window sends is checked again here, and a picture that is not what it says is left out.

/** The most pictures one prompt carries: photos and doodles first, then the pictures of the objects referred to. */
export const MOST_IMAGES = 6
const MOST_PARTS_NAMED = 8
const MAX_DESCRIPTION = 20_000
const REFERENCE_FILE = /^reference\/(photo|doodle)-[1-9][0-9]*\.(png|jpg|jpeg|webp)$/

/** The picture an object has on file for its card, or none: a plain file under a plain `.torno`, a PNG within the card's size. */
export async function readThumb(dir: string): Promise<ImageBytes | undefined> {
  try {
    const folder = await lstat(join(dir, FOLDER))
    if (!folder.isDirectory()) return undefined
    const path = join(dir, FOLDER, THUMB_PNG)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > THUMB_MAX_BYTES) return undefined
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const bytes = Buffer.alloc(THUMB_MAX_BYTES + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      return checkedImage(new Uint8Array(bytes.subarray(0, bytesRead))) ?? undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * What an object is, as far as its last build in this run says: its parts and the box of the first layout, with
 * whether the kernel says the box is exact. The numbers are the kernel's, written as every number told is.
 */
export function objectSummary(scene: Pick<Scene, 'layouts' | 'parts'> | undefined): string {
  if (!scene) return 'not built in this run'
  const layout = scene.layouts[0]
  const parts = scene.parts.filter((p) => layout === undefined || p.layout === layout)
  if (parts.length === 0) return 'built, with no parts'
  const names = parts.slice(0, MOST_PARTS_NAMED).map((p) => p.name).join(', ')
  const more = parts.length > MOST_PARTS_NAMED ? ` and ${parts.length - MOST_PARTS_NAMED} more` : ''
  const size = [0, 1, 2].map((axis) => Math.max(...parts.map((p) => p.bbox.max[axis])) - Math.min(...parts.map((p) => p.bbox.min[axis])))
  const exact = parts.every((p) => p.bboxExact === true)
  return `${parts.length} ${parts.length === 1 ? 'part' : 'parts'}: ${names}${more}; box ${size.map(number).join(' x ')} mm, ${exact ? 'exact' : 'approximate'}`
}

export interface PromptInput {
  name: string
  description: string
  /** Photos, then doodles. `image` is none for a picture that cannot be attached. */
  items: Array<{ file: string; note: string; image?: ImageBytes }>
  /** `id` is none for a scan that could not be imported, and `problem` says why. */
  scans: Array<{ id: string | null; file: string; note: string; problem?: string }>
  objects: Array<{ name: string; summary: string; note: string; thumb?: ImageBytes }>
}

const imageBlock = (image: ImageBytes): PromptBlock => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.bytes).toString('base64') } })

const CLAUDE_TOOL = (tool: string): string => `mcp__torno__${tool}`

/**
 * The first prompt of a new object: the text, then the pictures it says are attached, at most 6 in all, each after a line of text that names it
 * ("Picture 2: reference/doodle-1.png (the person's doodle): <note>"): the CLI gives the model no file name for an image. `held` is
 * the same text for a prompt that is not sent with its pictures (the composer holds it): each picture is named by
 * its file and says it is not attached, and a referred object's picture by the file it is in.
 */
export function onboardPrompt(input: PromptInput, toolName: (tool: string) => string = CLAUDE_TOOL): { text: string; held: string; blocks: PromptBlock[] } {
  const images: Array<{ image: ImageBytes; caption: (n: number) => string }> = []
  const said = (note: string): string => oneLine(note, 'note')
  /** The number of the picture when it fits in the prompt (it is attached then), else none. */
  const attach = (image: ImageBytes | undefined, what: string, note: string): number | null => {
    if (!image || images.length >= MOST_IMAGES) return null
    const line = said(note)
    images.push({ image, caption: (n) => `Picture ${n}: ${what}${line === '' ? '' : `: ${line}`}` })
    return images.length
  }
  const attached = input.items.map((item) => attach(item.image, `${item.file} (the person's ${item.file.startsWith('reference/doodle') ? 'doodle' : 'photo'})`, item.note))
  const pictured = input.objects.map((other) => (other.thumb ? attach(other.thumb, `../${said(other.name)}/ as torno last drew it (its thumbnail)`, other.note) : null))
  const compose = (held: boolean): string => {
    const lines: string[] = []
    input.items.forEach((item, i) => {
      const tail = attached[i] !== null && !held ? ` (attached: picture ${attached[i]})` : ` (not attached: read ${item.file})`
      lines.push(`- ${item.file}${said(item.note) === '' ? '' : `: ${said(item.note)}`}${tail}`)
    })
    for (const scan of input.scans) {
      const note = said(scan.note)
      const file = said(scan.file)
      const named = scan.id === null ? `Scan "${file}"` : `Scan ${scan.id} "${file}"`
      const after =
        scan.id === null
          ? `It could not be imported (${said(scan.problem ?? 'for a reason torno did not get')}); the file is the person's to give again.`
          : `It is imported into this object and is not aligned: the person aligns it in torno, and ${toolName('scan_clash')} and ${toolName('scan_deviation')} need that. Read it with ${toolName('scans')} and ${toolName('scan_section')}.`
      lines.push(`- ${named}${note === '' ? '.' : `: ${note}.`} ${after}`)
    }
    input.objects.forEach((other, i) => {
      const name = said(other.name)
      const picture = !other.thumb ? '' : held ? `; its picture: ../${name}/.torno/thumb.png` : pictured[i] !== null ? `; its picture is attached: picture ${pictured[i]}` : '; its picture is not attached'
      const note = said(other.note)
      lines.push(`- ../${name}/ (another object of this workspace: ${other.summary}${picture})${note === '' ? '' : `: ${note}`}`)
    })
    return [
      `This is a new object, ${input.name}, made in torno just now. What it is, in the person's words:`,
      '',
      input.description.trim(),
      '',
      ...(lines.length > 0 ? ['What they gave (all of it is also in brief.md; files are in reference/):', ...lines, ''] : []),
      `${moduleName(input.name)}.py is torno's placeholder (a 20 mm cube). Read brief.md, look at what was given, ask what you need to know, then replace the placeholder with the real model.`
    ].join('\n')
  }
  const text = compose(false)
  return { text, held: compose(true), blocks: [{ type: 'text', text }, ...images.flatMap((p, i): PromptBlock[] => [{ type: 'text', text: p.caption(i + 1) }, imageBlock(p.image)])] }
}

export interface OnboardDeps {
  /** An object of the open workspace. */
  object(id: string): ObjectInfo | undefined
  /** Whether the object has a chat or terminal session, or one starting. */
  running(objectId: string): boolean
  /** Imports a file as a scan of the object (`scans:import`); rejects with a reason. */
  importScan(objectId: string, path: string): Promise<{ id: string; name: string }>
  /** Starts the session of the object's agent; rejects with why it cannot. */
  start(obj: ObjectInfo): Promise<{ sessionId: string; view: string }>
  prompt(sessionId: string, blocks: PromptBlock[]): void
  /** Resolves once the session's CLI has taken the prompt up, or with why it ended without; none when this cannot be known. */
  began?(sessionId: string): Promise<{ began: true } | { began: false; why: string }>
  /** The last good build of an object in this run. */
  scene(objectId: string): Pick<Scene, 'layouts' | 'parts'> | undefined
}

/** Whether an object has a session, or one is starting there. */
export function sessionRunning(sessions: Pick<Sessions, 'current' | 'isStarting'> | null, objectId: string): boolean {
  return sessions !== null && (sessions.current(objectId) !== null || sessions.isStarting(objectId))
}

/** The objects being onboarded now: one call at a time per object, from the check to the end. */
const onboarding = new Set<string>()

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300)

/** The draft held to what it may be; throws a plain reason. */
async function checked(deps: OnboardDeps, obj: ObjectInfo, draft: OnboardDraft): Promise<void> {
  if (typeof draft !== 'object' || draft === null) throw new Error('No draft to onboard.')
  if (typeof draft.description !== 'string' || draft.description.length > MAX_DESCRIPTION) throw new Error('The description is not text of at most 20,000 characters.')
  const lists = { items: MOST.photos + MOST.doodles, scans: MOST.scans, objects: MOST.objects }
  for (const kind of ['items', 'scans', 'objects'] as const) {
    if (!Array.isArray(draft[kind])) throw new Error(`The ${kind} are not a list.`)
    if (draft[kind].length > lists[kind]) throw new Error(`At most ${lists[kind]} ${kind}.`)
  }
  for (const item of draft.items) {
    if (typeof item?.file !== 'string' || !REFERENCE_FILE.test(item.file)) throw new Error('A photo or a doodle is a file of reference/ that torno made.')
    oneLine(item.note, 'photo or doodle')
    if (typeof item.note !== 'string') throw new Error('The note of a photo or a doodle is not text.')
    const stat = await lstat(join(obj.dir, item.file)).catch(() => null)
    if (!stat?.isFile()) throw new Error(`${item.file} is not there.`)
  }
  for (const scan of draft.scans) {
    if (typeof scan?.path !== 'string' || !isAbsolute(scan.path) || !(SCAN_FORMATS as readonly string[]).includes(extname(scan.path).toLowerCase())) throw new Error(`A scan is a ${SCAN_FORMATS.join(', ')} file given by its path.`)
    // One line of the prompt: a control character, a line break above all, could write lines of its own.
    if (/\p{Cc}/u.test(scan.path)) throw new Error('The path of a scan has a control character or a line break in it.')
    if (typeof scan.note !== 'string') throw new Error('The note of a scan is not text.')
    oneLine(scan.note, 'scan')
  }
  for (const other of draft.objects) {
    if (typeof other?.id !== 'string' || deps.object(other.id) === undefined) throw new Error(`There is no object ${JSON.stringify(other?.id)} in this workspace.`)
    if (other.id === obj.id) throw new Error('An object cannot refer to itself.')
    if (typeof other.note !== 'string') throw new Error('The note of an object is not text.')
    oneLine(other.note, 'object')
  }
  for (const [kind, keys] of [['file', draft.items.map((i) => i.file)], ['scan', draft.scans.map((s) => s.path)], ['object', draft.objects.map((o) => o.id)]] as const) {
    if (new Set(keys).size !== keys.length) throw new Error(`The same ${kind} is given twice.`)
  }
}

/**
 * Onboards a new object: imports the scans of the draft, starts its session and sends the first prompt. Rejects, doing
 * nothing, for an object that is not of the workspace, one with a session already, and a draft that is not what it
 * may be. A scan that cannot be imported, a picture that cannot be attached and a session that cannot be started do not
 * reject: the text says of the first two, and the answer has the prompt and the reason for the third.
 */
export async function onboardObject(deps: OnboardDeps, objectId: string, draft: OnboardDraft): Promise<Onboarded> {
  const obj = deps.object(objectId)
  if (!obj) throw new Error(`There is no object ${JSON.stringify(objectId)} in the open workspace.`)
  if (onboarding.has(obj.id)) throw new Error(`${obj.id} is being onboarded already.`)
  if (deps.running(obj.id)) throw new Error(`${obj.id} has a session already.`)
  onboarding.add(obj.id)
  try {
    return await onboarded(deps, obj, draft)
  } finally {
    onboarding.delete(obj.id)
  }
}

async function onboarded(deps: OnboardDeps, obj: ObjectInfo, draft: OnboardDraft): Promise<Onboarded> {
  await checked(deps, obj, draft)

  const scans: PromptInput['scans'] = []
  for (const scan of draft.scans) {
    const file = basename(scan.path)
    try {
      const imported = await deps.importScan(obj.id, scan.path)
      scans.push({ id: imported.id, file, note: scan.note })
    } catch (e) {
      scans.push({ id: null, file, note: scan.note, problem: firstLine(e) })
    }
  }
  const objects: PromptInput['objects'] = []
  for (const other of draft.objects) {
    const found = deps.object(other.id)!
    const thumb = await readThumb(found.dir)
    objects.push({ name: found.id, summary: objectSummary(deps.scene(found.id)), note: other.note, ...(thumb ? { thumb } : {}) })
  }
  const { text, held, blocks } = onboardPrompt({
    name: obj.id,
    description: draft.description,
    items: draft.items.map((item) => ({ file: item.file, note: item.note, image: checkedImage(item.image) ?? undefined })),
    scans,
    objects
  })

  let started: { sessionId: string; view: string }
  try {
    started = await deps.start(obj)
  } catch (e) {
    return { sessionId: null, prompt: text, held, problem: firstLine(e) }
  }
  if (started.view !== 'chat') return { sessionId: started.sessionId, prompt: text, held, problem: "This agent has no chat to send the first prompt to; it is held, for the person to paste." }
  try {
    deps.prompt(started.sessionId, blocks)
  } catch (e) {
    return { sessionId: started.sessionId, prompt: text, held, problem: firstLine(e) }
  }
  // A CLI that is signed out, or too old for a flag, starts and leaves: the prompt it never took is held, with the reason.
  const began = await deps.began?.(started.sessionId)
  if (began && !began.began) return { sessionId: started.sessionId, prompt: text, held, problem: began.why }
  return { sessionId: started.sessionId, prompt: text, held }
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { type ExplodeState, NO_EXPLODE, explodeOf, sameExplode } from '../shared/explode'
import { MIN_SCAN_OPACITY, type ScanView } from '../shared/scans'
import type { LayerSettings, SceneFile } from '../shared/scenefile'
import { sectionOf } from '../shared/view'
import { type SavedView, findView, savedViewsOf } from '../shared/views'

export type { LayerSettings, SceneFile }

const FOLDER = '.torno'
const NAME = 'scene.json'

/**
 * The scene file of each folder as main last read it or was given it to save. `scene.json` is the window's to
 * write: main never changes one of its own accord, and answers from here what it is asked of the saved views.
 */
const known = new Map<string, SceneFile>()

/** By folder, the names (in lower case) under which main has asked the window to keep a view of the agent's, and waits for its answer. */
const asked = new Map<string, Set<string>>()

/**
 * How the object in `dir` was last looked at, read from the disk once what is being written is on it. A file
 * that is missing, unreadable or not what this version writes gives the defaults; it is left as it is.
 */
export async function loadSceneFile(dir: string): Promise<SceneFile> {
  await sceneFilesSettled()
  let file: SceneFile
  try {
    file = clean(JSON.parse(await readFile(join(dir, FOLDER, NAME), 'utf8')))
  } catch {
    file = { layers: {} }
  }
  known.set(dir, file)
  return file
}

/** The scene file of a folder as main last read it or was given it to save: what `scene`, `look` and `show` answer from. Reads the disk the first time. */
export function sceneFileNow(dir: string): Promise<SceneFile> {
  const file = known.get(dir)
  return file ? Promise.resolve(file) : loadSceneFile(dir)
}

/** Folders mean nothing once their workspace is closed, and their files may change meanwhile. */
export function forgetSceneFiles(): void {
  known.clear()
  asked.clear()
}

/**
 * Main is asking the window to keep a view of the agent's under a name: until what is returned is called, a scene
 * file given for that folder may say of the view of that name that it is the agent's, and proposed.
 */
export function proposalAsked(dir: string, name: string): () => void {
  const wanted = name.trim().toLowerCase()
  const names = asked.get(dir) ?? new Set<string>()
  asked.set(dir, names.add(wanted))
  return () => void names.delete(wanted)
}

/**
 * The views of a file the window gives, with whose each is as main knows it. That a view is the agent's, and that
 * it is still only proposed, are main's alone to say: a view is the agent's when main asked the window to keep it
 * for the agent, or when the file already said so of that view (by its name, or by the moment it was saved when it
 * was given another name); and proposed likewise, so that one the person kept is never proposed again. Anything
 * else the window calls the agent's is the person's.
 */
function owned(views: SavedView[], before: readonly SavedView[], proposing: ReadonlySet<string>): SavedView[] {
  return views.map((view) => {
    if (view.author === 'user') return view
    const was = findView(before, view.name) ?? before.find((one) => one.author === 'agent' && one.at !== '' && one.at === view.at)
    const wanted = proposing.has(view.name.toLowerCase())
    const { proposed: _said, ...rest } = view
    if (!wanted && was?.author !== 'agent') return { ...rest, author: 'user' as const }
    return wanted || was?.proposed ? view : rest
  })
}

/** The saves that are not on the disk yet. */
const saving = new Set<Promise<void>>()

/** Writes `<dir>/.torno/scene.json`, creating the folder. Readers see the old file or the new one, never half of one. */
export function saveSceneFile(dir: string, f: SceneFile): Promise<void> {
  const file = clean(f)
  if (file.views) file.views = owned(file.views, known.get(dir)?.views ?? [], asked.get(dir) ?? new Set())
  known.set(dir, file)
  const save = writeFileAtomic(join(dir, FOLDER, NAME), `${JSON.stringify(file, null, 2)}\n`)
  saving.add(save)
  const over = (): void => void saving.delete(save)
  save.then(over, over)
  return save
}

/**
 * Null when no scene file is being written; else a promise that resolves
 * once every save asked for so far is done, written or failed. For whoever
 * must not go before it is on the disk: the app, when it quits.
 */
export function sceneFilesSettled(): Promise<void> | null {
  if (saving.size === 0) return null
  const wait = async (): Promise<void> => {
    while (saving.size > 0) await Promise.allSettled([...saving])
  }
  return wait()
}

/** Keeps what a scene file may hold, whatever it was given. */
function clean(value: unknown): SceneFile {
  const file: SceneFile = { layers: {} }
  if (!isRecord(value)) return file
  if (typeof value.layout === 'string') file.layout = value.layout
  // A plane, its normal a unit vector, or nothing: a section that is not one is no section.
  const section = sectionOf(value.section)
  if (section) file.section = section
  const scans = scanViews(value.scans)
  if (scans) file.scans = scans
  const explode = explodes(value.explode)
  if (explode) file.explode = explode
  // Each that is a view: a broken one is lost alone.
  const views = savedViewsOf(value.views)
  if (views.length > 0) file.views = views
  if (!isRecord(value.layers)) return file
  for (const [name, raw] of Object.entries(value.layers)) {
    if (!isRecord(raw)) continue
    const layer: LayerSettings = {}
    if (typeof raw.visible === 'boolean') layer.visible = raw.visible
    if (typeof raw.color === 'string') layer.color = raw.color
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) layer.opacity = Math.min(Math.max(raw.opacity, 0), 1)
    if (Object.keys(layer).length > 0) file.layers[name] = layer
  }
  return file
}

/** How each scan is looked at, by scan id; undefined when nothing is said of any. A scan is never thinned to nothing. */
function scanViews(value: unknown): Record<string, ScanView> | undefined {
  if (!isRecord(value)) return undefined
  const scans: Record<string, ScanView> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!/^S\d+$/.test(id) || !isRecord(raw)) continue
    const view: ScanView = {}
    if (typeof raw.visible === 'boolean') view.visible = raw.visible
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) view.opacity = Math.min(Math.max(raw.opacity, MIN_SCAN_OPACITY), 1)
    if (raw.colour === 'own' || raw.colour === 'plain') view.colour = raw.colour
    if (Object.keys(view).length > 0) scans[id] = view
  }
  return Object.keys(scans).length > 0 ? scans : undefined
}

/** The longest name of a layout an explode is kept under. */
const MAX_LAYOUT_NAME = 100

/** How each layout is drawn apart, by layout name; undefined when nothing is said of any. One that says what is so anyway (`NO_EXPLODE`) is left out. */
function explodes(value: unknown): Record<string, ExplodeState> | undefined {
  if (!isRecord(value)) return undefined
  const kept: Record<string, ExplodeState> = {}
  for (const [layout, raw] of Object.entries(value)) {
    const explode = layout.length <= MAX_LAYOUT_NAME ? explodeOf(raw) : null
    if (explode && !sameExplode(explode, NO_EXPLODE)) kept[layout] = explode
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

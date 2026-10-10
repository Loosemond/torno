import { type ExplodePart, type ExplodeState, explodeOf, explodeText, isExploded, nothingApart } from './explode'
import { MIN_SCAN_OPACITY } from './scans'
import { type Camera, type SectionPlane, sectionOf } from './view'

// A saved view: how an object was looked at, kept under a name in its scene file. View state only: applying one
// changes no geometry, no mark and no measurement, and starts no build.

export interface SavedView {
  /** 1 to 40 characters, one line, unique in the object whatever the case; never `current` or the name of a standard view. */
  name: string
  author: 'user' | 'agent'
  /** The agent's, and the person has not kept it yet. Only ever true, only on an agent's. */
  proposed?: true
  /** Why the agent proposes it, one line, at most 200 characters. */
  note?: string
  layout: string
  camera: Camera
  /** Names of the parts switched off: a part the model gains later is in the view, as it is on screen. */
  hidden: string[]
  /** One or the other, never both: a section is never drawn exploded. */
  section?: SectionPlane
  explode?: ExplodeState
  /** By scan id, how each scan is shown: only `visible` (on, when left out) and `opacity` (solid, when left out). */
  scans?: Record<string, { visible?: boolean; opacity?: number }>
  /** ISO time it was saved. */
  at: string
}

export const MAX_VIEWS = 24
export const MAX_VIEW_NAME = 40
export const MAX_VIEW_NOTE = 200
/** The most views of the agent's that wait to be kept or discarded: one more drops the oldest of them. */
export const MAX_PROPOSALS = 12
/** Said of a view asked with both a section and an explode: which to drop. */
export const VIEW_NOT_BOTH = 'a view holds a section or an explode, not both: a section is not drawn exploded. Leave out explode to keep the cut, or section to keep the parts apart'
export const RESERVED_VIEW_NAMES = ['current', 'iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const

/** A view out of whatever a file holds, or null: a name that is one, an author, a layout, a camera whose position is not its target. With both a section and an explode the section is kept. */
export function savedViewOf(value: unknown): SavedView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const said = value as Record<string, unknown>
  const name = typeof said.name === 'string' ? cleanViewName(said.name) : ''
  if (viewNameShape(name) !== null) return null
  if (said.author !== 'user' && said.author !== 'agent') return null
  // A layout and a part are named to the agent in lines of their own: neither is more than a line.
  if (typeof said.layout !== 'string' || said.layout === '' || said.layout.length > 100 || CONTROL.test(said.layout)) return null
  const camera = cameraOfFile(said.camera)
  if (!camera) return null
  const view: SavedView = { name, author: said.author, layout: said.layout, camera, hidden: [], at: typeof said.at === 'string' ? said.at.slice(0, 40) : '' }
  if (Array.isArray(said.hidden)) view.hidden = [...new Set(said.hidden.filter((part): part is string => typeof part === 'string' && part.length > 0 && part.length <= 200 && !CONTROL.test(part)))].slice(0, 256)
  if (said.author === 'agent' && said.proposed === true) view.proposed = true
  if (typeof said.note === 'string') {
    const note = said.note.replace(/\s+/g, ' ').trim().slice(0, MAX_VIEW_NOTE)
    if (note) view.note = note
  }
  const section = sectionOf(said.section)
  const explode = explodeOf(said.explode)
  if (section) view.section = section
  else if (isExploded(explode)) view.explode = explode
  if (typeof said.scans === 'object' && said.scans !== null && !Array.isArray(said.scans)) {
    const scans: NonNullable<SavedView['scans']> = {}
    for (const [id, raw] of Object.entries(said.scans as Record<string, unknown>)) {
      if (!/^S[1-9]\d{0,14}$/.test(id) || typeof raw !== 'object' || raw === null) continue
      const { visible, opacity } = raw as { visible?: unknown; opacity?: unknown }
      const shown: { visible?: boolean; opacity?: number } = {}
      if (typeof visible === 'boolean') shown.visible = visible
      if (typeof opacity === 'number' && Number.isFinite(opacity)) shown.opacity = Math.min(Math.max(opacity, MIN_SCAN_OPACITY), 1)
      if (Object.keys(shown).length > 0) scans[id] = shown
    }
    if (Object.keys(scans).length > 0) view.scans = scans
  }
  return view
}

/** A control character: what makes a text more than one line, or none of it. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** Characters that do not show, and those that turn the direction a line is read in. */
const UNSEEN = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\u3164\ufeff\uffa0]/g

/** A name as it is kept: without what does not show or turns its reading, and with no space at its ends. A name of nothing that shows is no name. */
export function cleanViewName(name: string): string {
  return name.replace(UNSEEN, '').trim()
}

/** Why a text is no name for a view, or null: the shape of it only, not whether it is taken. */
function viewNameShape(name: string): string | null {
  if (name === '') return 'A view needs a name'
  if (name.length > MAX_VIEW_NAME) return `A name has at most ${MAX_VIEW_NAME} characters`
  if (CONTROL.test(name)) return 'A name is one line'
  if ((RESERVED_VIEW_NAMES as readonly string[]).includes(name.toLowerCase())) return `"${name}" is a standard view: choose another name`
  return null
}

/** The furthest a camera may be, on any axis: what the kernel takes of a coordinate, in mm. */
const MAX_COORDINATE = 1e9
/** What a zoom is kept within. */
const ZOOM = { least: 0.001, most: 1000 }

/** A camera out of a file: position, target and up as three finite numbers each, none beyond `MAX_COORDINATE`, a lens of 1 to 120 degrees, a zoom above 0, kept within `ZOOM`, and a position that is not its target. */
function cameraOfFile(value: unknown): Camera | null {
  const said = value as Partial<Record<keyof Camera, unknown>> | null
  if (typeof said !== 'object' || said === null) return null
  const triple = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE) ? [v[0], v[1], v[2]] : null)
  const position = triple(said.position)
  const target = triple(said.target)
  const up = triple(said.up)
  if (!position || !target || !up || position.every((c, i) => c === target[i]) || up.every((c) => c === 0)) return null
  const fov = typeof said.fov === 'number' && said.fov >= 1 && said.fov <= 120 ? said.fov : 35
  const zoom = typeof said.zoom === 'number' && Number.isFinite(said.zoom) && said.zoom > 0 ? Math.min(Math.max(said.zoom, ZOOM.least), ZOOM.most) : 1
  return { position, target, up, ortho: said.ortho === true, fov, zoom }
}

/**
 * The views of a file: each that is one, the first of each name; `MAX_VIEWS` at most of the person's (those
 * they made or kept), and `MAX_PROPOSALS` of the agent's that wait: a proposal takes no place of theirs.
 */
export function savedViewsOf(value: unknown): SavedView[] {
  const views: SavedView[] = []
  if (!Array.isArray(value)) return views
  let [own, waiting] = [0, 0]
  // A file may hold anything: no more of it is looked at than could be views twice over.
  for (const raw of value.slice(0, 4 * (MAX_VIEWS + MAX_PROPOSALS))) {
    const view = savedViewOf(raw)
    if (!view || findView(views, view.name)) continue
    if (view.proposed ? waiting++ < MAX_PROPOSALS : own++ < MAX_VIEWS) views.push(view)
  }
  return views
}

/** The view of a name, whatever the case it is written in. */
export function findView(views: readonly SavedView[], name: string): SavedView | undefined {
  const wanted = cleanViewName(name).toLowerCase()
  return views.find((view) => view.name.toLowerCase() === wanted)
}

/**
 * Why a view cannot be saved under a name by `author`, as a sentence, or null. The person may save over any view;
 * the agent only over its own that is still proposed. With `renaming`, the name of a view of the person's that is
 * given this one instead: it may not be that of another view.
 */
export function viewNameRefusal(name: string, views: readonly SavedView[], author: 'user' | 'agent', renaming?: string): string | null {
  const shape = viewNameShape(cleanViewName(name))
  if (shape !== null) return shape
  const there = findView(views, name)
  if (renaming !== undefined) return there && there !== findView(views, renaming) ? `There is a view named "${there.name}" already` : null
  if (author === 'agent' && there?.author === 'user') return `the user has a view named "${there.name}": choose another name`
  if (author === 'agent' && there && !there.proposed) return `the user kept the view "${there.name}": choose another name`
  // One more of the person's than there may be, also in place of a proposal, which is none of theirs. The agent is
  // never told so: its proposals have a count of their own, and one more of them drops the oldest (`proposalToDrop`).
  if (author === 'user' && (!there || there.proposed) && ownViews(views) >= MAX_VIEWS) return TOO_MANY_VIEWS
  return null
}

/** Said to the person who would have one more view than there may be. */
export const TOO_MANY_VIEWS = `There are ${MAX_VIEWS} views: remove one first`

/** How many views are the person's: those they made, and those of the agent's they kept. */
export function ownViews(views: readonly SavedView[]): number {
  return views.filter((view) => !view.proposed).length
}

/**
 * The name of the proposal that goes when the agent proposes a view under `name`: the oldest of those the person
 * has neither kept nor discarded, once there are `MAX_PROPOSALS` of them. Null when none goes: there is room, or
 * the new one takes the place of its namesake.
 */
export function proposalToDrop(views: readonly SavedView[], name: string): string | null {
  if (findView(views, name)?.proposed) return null
  const waiting = views.filter((view) => view.proposed)
  if (waiting.length < MAX_PROPOSALS) return null
  return waiting.reduce((oldest, view) => (view.at < oldest.at ? view : oldest)).name
}

/** A view as `scene` lists it: whose it is, of which layout, and what it holds. */
export function viewSummary(view: SavedView): { name: string; by: 'user' | 'agent'; proposed?: true; layout: string; exploded?: true; section?: true; hidden?: number; note?: string } {
  return {
    name: view.name,
    by: view.author,
    ...(view.proposed ? { proposed: true as const } : {}),
    layout: view.layout,
    ...(view.section ? { section: true as const } : {}),
    ...(view.explode ? { exploded: true as const } : {}),
    ...(view.hidden.length > 0 ? { hidden: view.hidden.length } : {}),
    ...(view.note ? { note: view.note } : {})
  }
}

/** What a view holds, in a few words: `layout assembly · exploded 60 % from the centre · 1 part hidden`. */
export function holdsText(view: SavedView): string {
  return [`layout ${view.layout}`, view.section ? 'section' : view.explode ? explodeText(view.explode) : '', view.hidden.length > 0 ? `${view.hidden.length} ${view.hidden.length === 1 ? 'part' : 'parts'} hidden` : ''].filter(Boolean).join(' · ')
}

/** What a view names that is no longer there: its layout, parts it hides, scans it shows or hides; and why its explode can no longer be drawn, or null. */
export interface ViewGone { layout: boolean; parts: string[]; scans: string[]; explode: 'one part' | 'shared centre' | null }

/**
 * What of a view is gone, against what there is: the layouts of the build, the names of the parts in the view's
 * layout, and the object's scans by id (left out when they are not known: nothing is then said of them). With
 * its layout gone a view cannot be applied, and nothing else is said of it; a part or a scan that is gone is
 * passed over when it is. With `boxes`, the parts of the view's layout as the build has them: an explode the view
 * holds that would draw nothing apart of them (`nothingApart`) is passed over too.
 */
export function viewGone(view: SavedView, has: { layouts: readonly string[]; parts: readonly string[]; scans?: readonly string[]; boxes?: readonly ExplodePart[] }): ViewGone {
  if (!has.layouts.includes(view.layout)) return { layout: true, parts: [], scans: [], explode: null }
  return {
    layout: false,
    parts: view.hidden.filter((name) => !has.parts.includes(name)),
    scans: has.scans ? Object.keys(view.scans ?? {}).filter((id) => !has.scans!.includes(id)) : [],
    explode: view.explode && has.boxes ? nothingApart(view.explode, has.boxes) : null
  }
}

/** `2 parts gone`, `1 part and 1 scan gone`, `not drawn apart`, `1 part gone, not drawn apart`, `layout gone`; '' when nothing is. */
export function goneText(gone: ViewGone): string {
  if (gone.layout) return 'layout gone'
  const counted = (n: number, one: string): string => (n === 0 ? '' : `${n} ${one}${n === 1 ? '' : 's'}`)
  const what = [counted(gone.parts.length, 'part'), counted(gone.scans.length, 'scan')].filter(Boolean)
  return [what.length === 0 ? '' : `${what.join(' and ')} gone`, gone.explode ? 'not drawn apart' : ''].filter(Boolean).join(', ')
}

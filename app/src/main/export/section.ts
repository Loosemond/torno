import { type BuildIdentity, identitySaid } from '../../shared/git'
import type { Sectioned } from '../../shared/geometry'
import type { Mark } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import type { ViewState } from '../../shared/view'
import type { ObjectInfo } from '../../shared/workspace'
import { isMoved } from '../marks/spread'
import { SECTION_DEFLECTION } from '../mcp/readTools'
import { NOT_BUILT, NO_OBJECT } from './build'
import { NEW_BUILD } from './model'
import { type SectionSvg, sectionSvg } from './sectionSvg'

// A drawing of the section on screen, for someone who will make the part (`export:saveSection`): main asks the
// kernel for the outlines of the plane the window reports, within `SECTION_DEFLECTION`, and lays them out as an
// SVG at true scale (`sectionSvg`). It is made from the last good build of this run, like every export.

export const NO_SECTION = 'There is no section on screen: cut the project first (the Section tool, X)'
export const NOTHING_CUT = 'The section cuts nothing, so there is nothing to draw'

export interface SectionDeps {
  object(objectId: string): ObjectInfo | undefined
  last(objectId: string): { revision: number; scene: Scene } | undefined
  /** What the window last reported of the object, if it shows it. */
  view(objectId: string): ViewState | undefined
  marks(objectId: string): Promise<Mark[]>
  query<T>(objectId: string, name: string, args: Record<string, unknown>): Promise<T>
  now(): Date
  /** What the build of this revision was made from (sources hash, commit, changes), when torno knows it. */
  identity?(objectId: string, revision: number): BuildIdentity | undefined
}

export interface SectionFile extends SectionSvg {
  objectId: string
  name: string
  revision: number
}

/** The drawing of the section the window shows, of the last good build. Throws a sentence for the window. */
export async function makeSectionDrawing(deps: SectionDeps, objectId: string): Promise<SectionFile> {
  const obj = deps.object(objectId)
  if (!obj) throw new Error(NO_OBJECT)
  const last = deps.last(objectId)
  if (!last) throw new Error(NOT_BUILT)
  const view = deps.view(objectId)
  if (!view?.section) throw new Error(NO_SECTION)
  const { scene, revision } = last
  const layout = view.layout
  if (!scene.layouts.includes(layout)) throw new Error(`There is no layout ${layout} in the last build`)
  // The parts that are on: all of them unless some are switched off, as the section on screen shows them.
  const inLayout = scene.parts.filter((part) => part.layout === layout)
  const on = inLayout.filter((part) => view.visible.includes(part.key))
  const parts = on.length > 0 && on.length < inLayout.length ? on.map((part) => part.name) : undefined
  const { origin, normal } = view.section
  const cut = await deps.query<Sectioned>(objectId, 'section', { layout, plane: { origin, normal }, ...(parts ? { parts } : {}), deflection: SECTION_DEFLECTION })
  if (!Array.isArray(cut?.parts) || !cut.plane) throw new Error('The kernel did not answer with a section')
  if (deps.last(objectId)?.revision !== revision) throw new Error(NEW_BUILD)
  if (!cut.bounds) throw new Error(NOTHING_CUT)
  const spread = cut.parts.some((part) => isMoved(inLayout.find((one) => one.name === part.part)))
  const marks = (await deps.marks(objectId)).filter((mark) => mark.kind === 'dimension')
  const identity = deps.identity?.(objectId, revision)
  const drawn = sectionSvg(cut, { object: obj.name, layout, revision, date: deps.now(), marks, spread, ...(identity ? { source: identitySaid(identity) } : {}) })
  return { ...drawn, objectId, name: obj.name, revision }
}

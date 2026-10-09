import * as THREE from 'three'
import type { Mark, Vec3 } from '../../../shared/marks'
import { mmPerPx, place, project, type Placed, type Size } from './labels'
import { build, dispose, markPoints, rescale, setActive, type MarkColours } from './markObjects'

/**
 * A mark as it is while the pointer is still making it: a pin where it was
 * clicked, an arrow being dragged, a stroke being drawn (its points in the
 * object frame, wherever it is drawn). Drawn like the person's marks, fainter,
 * and with no number: it is not a mark until main has kept it.
 */
export type Draft = { kind: 'pin'; point: Vec3; normal: Vec3 | null } | { kind: 'arrow'; from: Vec3; to: Vec3 } | { kind: 'stroke'; points: Vec3[] }

/** How much of a mark's colour a draft has. */
const DRAFT_OPACITY = 0.7

interface Entry {
  mark: Mark
  /** What the mark looked like when its objects were made. */
  drawnAs: string
  object: THREE.Object3D
}

/**
 * The marks drawn in the viewport: every mark that is not resolved has its
 * objects here, made once and made again only when the mark itself changes;
 * those of one layout are shown at a time. What is sized in pixels is brought
 * in line with a view by `update`, for the screen and for a picture alike.
 */
export class MarkLayer {
  /** Add this to the scene. */
  readonly group = new THREE.Group()
  private readonly entries = new Map<string, Entry>()
  private colours: MarkColours
  private layout: string | null = null
  private active: string | null = null
  private draft: { is: Draft; object: THREE.Object3D } | null = null

  constructor(colours: MarkColours) {
    this.colours = colours
    this.group.name = 'marks'
  }

  /** The colours changed, as with the colour scheme: everything is made again. */
  setColours(colours: MarkColours): void {
    if (colours.user === this.colours.user && colours.agent === this.colours.agent && colours.reference === this.colours.reference) return
    this.colours = colours
    const marks = [...this.entries.values()].map((e) => e.mark)
    const draft = this.draft?.is ?? null
    this.clear()
    this.setMarks(marks)
    this.setDraft(draft)
  }

  /** What the pointer is making, or null for nothing. Made anew on every call: it changes with every move of a drag. */
  setDraft(draft: Draft | null): void {
    if (this.draft) {
      this.group.remove(this.draft.object)
      dispose(this.draft.object)
      this.draft = null
    }
    if (!draft) return
    const object = build(asMark(draft), this.colours, 1)
    object.name = 'draft'
    object.traverse((child) => {
      const material = (child as THREE.Mesh).material as THREE.Material | undefined
      if (material) material.opacity *= DRAFT_OPACITY
    })
    this.draft = { is: draft, object }
    this.group.add(object)
  }

  /** Whether the draft is drawn: it is not in a picture for the agent. */
  showDraft(shown: boolean): void {
    if (this.draft) this.draft.object.visible = shown
  }

  /** The marks of the object, of every layout. Resolved ones are not drawn. */
  setMarks(marks: Mark[]): void {
    const seen = new Set<string>()
    for (const mark of marks) {
      if (mark.status === 'resolved') continue
      seen.add(mark.id)
      const drawnAs = drawnAsOf(mark)
      let entry = this.entries.get(mark.id)
      if (entry && entry.drawnAs === drawnAs) {
        entry.mark = mark
        continue
      }
      if (entry) this.drop(entry)
      entry = { mark, drawnAs, object: build(mark, this.colours, 1) }
      entry.object.visible = mark.layout === this.layout
      setActive(entry.object, mark.id === this.active)
      this.entries.set(mark.id, entry)
      this.group.add(entry.object)
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue
      this.drop(entry)
      this.entries.delete(id)
    }
  }

  /** Shows the marks of one layout and no others; null for none. */
  show(layout: string | null): void {
    this.layout = layout
    for (const entry of this.entries.values()) entry.object.visible = entry.mark.layout === layout
  }

  /** The mark being worked on, or null. */
  setActive(id: string | null): void {
    if (id === this.active) return
    for (const key of [this.active, id]) {
      const entry = key === null ? undefined : this.entries.get(key)
      if (entry) setActive(entry.object, key === id)
    }
    this.active = id
  }

  get activeId(): string | null {
    return this.active
  }

  /** Sizes what is measured in pixels for a view: `camera` with its matrices up to date, `size` in pixels, `unit` pixels to a nominal one. */
  update(camera: THREE.Camera, size: Size, unit = 1): void {
    const scale = (at: THREE.Vector3): number => mmPerPx(camera, at, size.height)
    for (const entry of this.entries.values()) if (entry.object.visible) rescale(entry.object, scale, unit)
    if (this.draft?.object.visible) rescale(this.draft.object, scale, unit)
  }

  /** The labels of a layout's marks in a view, each with a chip that covers no other. */
  labels(layout: string, camera: THREE.Camera, size: Size, unit: number, chip: (text: string) => { w: number; h: number }): Placed[] {
    return place(project(this.marksOf(layout), camera, size, unit), chip, size, unit)
  }

  /**
   * The faces, edges and parts a layout's pick marks are on, by who made the
   * mark: what is tinted for them. A pick that drifted or lost its part gives
   * none: it keeps the ref it was placed on, which in the build on show may
   * name other geometry, or none. It is still drawn at its point, with its label.
   */
  pickRefs(layout: string): { user: string[]; agent: string[] } {
    const refs = { user: [] as string[], agent: [] as string[] }
    for (const mark of this.marksOf(layout)) if (mark.kind === 'pick' && mark.anchorState === 'ok' && mark.anchor.ref) refs[mark.author].push(mark.anchor.ref)
    return refs
  }

  /** Grows a sphere to hold everything drawn of a layout's marks, and the draft. */
  extend(sphere: THREE.Sphere, layout: string): THREE.Sphere {
    const point = new THREE.Vector3()
    for (const mark of this.marksOf(layout)) for (const p of markPoints(mark)) sphere.expandByPoint(point.fromArray(p))
    if (this.draft) for (const p of markPoints(asMark(this.draft.is))) sphere.expandByPoint(point.fromArray(p))
    return sphere
  }

  /** A mark of a layout, among those drawn. */
  markOf(layout: string, id: string): Mark | undefined {
    const mark = this.entries.get(id)?.mark
    return mark?.layout === layout ? mark : undefined
  }

  dispose(): void {
    this.setDraft(null)
    this.clear()
  }

  /** In the order of their numbers, so that a label keeps its place as others come and go after it. */
  private marksOf(layout: string): Mark[] {
    return [...this.entries.values()].map((e) => e.mark).filter((m) => m.layout === layout).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  }

  private clear(): void {
    for (const entry of this.entries.values()) this.drop(entry)
    this.entries.clear()
  }

  private drop(entry: Entry): void {
    this.group.remove(entry.object)
    dispose(entry.object)
  }
}

/** Everything of a mark that changes how it is drawn, as one string: a note or a status does not. */
function drawnAsOf(mark: Mark): string {
  const { note: _note, status: _status, resolvedNote: _resolvedNote, createdAt: _createdAt, camera: _camera, revision: _revision, ...drawn } = mark
  return JSON.stringify(drawn)
}

/** A draft in the form the drawing code takes: the person's mark, as far as it is drawn. */
function asMark(draft: Draft): Mark {
  const base = { id: 'draft', author: 'user', note: '', status: 'draft', anchorState: 'ok', layout: '', revision: 0, camera: NO_CAMERA, createdAt: '' } as const
  switch (draft.kind) {
    case 'pin':
      return { ...base, kind: 'pin', anchor: { point: draft.point, ...(draft.normal ? { normal: draft.normal } : {}) } }
    case 'arrow':
      return { ...base, kind: 'arrow', from: { point: draft.from }, to: draft.to }
    case 'stroke':
      return { ...base, kind: 'stroke', space: 'surface', anchor: { point: draft.points[0] ?? [0, 0, 0] }, points: draft.points }
  }
}

const NO_CAMERA = { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 } satisfies Mark['camera']

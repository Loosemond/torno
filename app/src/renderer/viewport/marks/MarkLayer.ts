import * as THREE from 'three'
import type { Mark } from '../../../shared/marks'
import { mmPerPx, place, project, type Placed, type Size } from './labels'
import { build, dispose, markPoints, rescale, setActive, type MarkColours } from './markObjects'

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

  constructor(colours: MarkColours) {
    this.colours = colours
    this.group.name = 'marks'
  }

  /** The colours changed, as with the colour scheme: everything is made again. */
  setColours(colours: MarkColours): void {
    if (colours.user === this.colours.user && colours.agent === this.colours.agent && colours.reference === this.colours.reference) return
    this.colours = colours
    const marks = [...this.entries.values()].map((e) => e.mark)
    this.clear()
    this.setMarks(marks)
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
  }

  /** The labels of a layout's marks in a view, each with a chip that covers no other. */
  labels(layout: string, camera: THREE.Camera, size: Size, unit: number, chip: (text: string) => { w: number; h: number }): Placed[] {
    return place(project(this.marksOf(layout), camera, size, unit), chip, size, unit)
  }

  /** The faces, edges and parts a layout's pick marks are on, by who made the mark. */
  pickRefs(layout: string): { user: string[]; agent: string[] } {
    const refs = { user: [] as string[], agent: [] as string[] }
    for (const mark of this.marksOf(layout)) if (mark.kind === 'pick' && mark.anchor.ref) refs[mark.author].push(mark.anchor.ref)
    return refs
  }

  /** Grows a sphere to hold everything drawn of a layout's marks. */
  extend(sphere: THREE.Sphere, layout: string): THREE.Sphere {
    const point = new THREE.Vector3()
    for (const mark of this.marksOf(layout)) for (const p of markPoints(mark)) sphere.expandByPoint(point.fromArray(p))
    return sphere
  }

  dispose(): void {
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

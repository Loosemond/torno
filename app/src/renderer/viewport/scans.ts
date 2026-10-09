import * as THREE from 'three'
import { IDENTITY, alignmentOf, type ScanInfo, type ScanTransform, type ScanView } from '../../shared/scans'
import { STALE_FADE, mix } from './palette'
import { buildScan, disposeScan, fadeOwn, placeScan, type BuiltScan } from './scanMesh'

export interface ScanLayerState {
  id: string
  loaded: boolean
  /** Its tree is there: it can be picked. */
  ready: boolean
  triangles: number
  aligned: boolean
  visible: boolean
  opacity: number
  transform: ScanTransform
}

/** The least a scan is thinned to: under it, it could not be found again. */
export const MIN_SCAN_OPACITY = 0.05
/** From here up a scan is drawn solid: it writes depth, and what is behind it is hidden. */
const SOLID_FROM = 0.95

interface Entry {
  info: ScanInfo
  /** Null until its mesh has come. */
  built: BuiltScan | null
}

/**
 * The scans of the object on show: surroundings the parts are looked at in.
 * Each is one mesh, drawn where its alignment for the layout shown puts it,
 * or where it was imported when it has none there. They are cut open by a
 * section and never capped: a scan is a surface, with no inside to show.
 */
export class ScanLayer {
  readonly group = new THREE.Group()
  private entries: Entry[] = []
  private layout = ''
  /** How each is looked at, by id. Kept for a scan whose mesh, or whose record, has yet to come. */
  private readonly views = new Map<string, ScanView>()
  private look = { plain: '#B4AFA5', surface: '#F1EFEA' }
  private stale = false
  private planes: THREE.Plane[] | null = null
  /** While a picture is drawn: the scans it draws, and the layout it is of. */
  private pictured: { ids: ReadonlySet<string>; layout: string } | null = null

  constructor(private readonly redraw: () => void) {}

  /** The scans of the object on show, and the layout shown: which there are and where each stands. Their meshes come by `load`. */
  set(scans: ScanInfo[], layout: string): void {
    const had = new Map(this.entries.map((entry) => [entry.info.id, entry]))
    this.layout = layout
    this.entries = scans.map((info) => {
      const entry = had.get(info.id)
      had.delete(info.id)
      // The mesh is that of one record: converted to another unit, written to another file, or gone from the disk, it is not what was built.
      if (entry?.built && (info.meshState !== 'ok' || meshOf(info) !== meshOf(entry.info))) {
        disposeScan(entry.built)
        entry.built = null
      }
      return { info, built: entry?.built ?? null }
    })
    for (const gone of had.values()) if (gone.built) disposeScan(gone.built)
    this.arrange()
  }

  /** The scans there are whose mesh has not come and can (`meshState: 'ok'`). */
  wanting(): string[] {
    return this.entries.filter((entry) => !entry.built && entry.info.meshState === 'ok').map((entry) => entry.info.id)
  }

  /** The mesh of a scan, as `mesh.bin` holds it. Nothing for a scan that is not there or has its mesh; throws for bytes that are no scan. */
  load(id: string, blob: ArrayBuffer): void {
    const entry = this.entries.find((e) => e.info.id === id)
    if (!entry || entry.built) return
    entry.built = buildScan(id, blob)
    this.arrange()
  }

  /** How a scan is looked at; what is left out keeps its value. */
  setView(id: string, view: ScanView): void {
    this.views.set(id, { ...this.views.get(id), ...view })
    const entry = this.entries.find((e) => e.info.id === id)
    if (entry) this.apply(entry)
    this.redraw()
  }

  /** The colour of a scan drawn plain and the background, and whether the parts are stale: the scans fade with them. */
  setLook(look: { plain: string; surface: string }, stale: boolean): void {
    this.look = look
    this.stale = stale
    for (const entry of this.entries) this.apply(entry)
    this.redraw()
  }

  /** What every scan is clipped by: the planes of a section, or null for none. */
  setClipping(planes: THREE.Plane[] | null): void {
    this.planes = planes
    for (const entry of this.entries) this.apply(entry)
  }

  /**
   * For a picture: only these are drawn (none for null), each as it is on
   * screen, but where the picture's layout puts it when that is another.
   * Returns what puts the screen back. Throws, having changed nothing, for an
   * id that is no scan of the object.
   */
  showOnly(ids: string[] | null, layout = this.layout): () => void {
    const unknown = (ids ?? []).find((id) => !this.entries.some((entry) => entry.info.id === id))
    if (unknown !== undefined) throw new Error(`no scan ${unknown}; scans: ${this.entries.map((entry) => entry.info.id).join(', ') || 'none'}`)
    this.pictured = { ids: new Set(ids ?? []), layout }
    for (const entry of this.entries) this.apply(entry)
    return () => {
      this.pictured = null
      for (const entry of this.entries) this.apply(entry)
    }
  }

  /** The scans whose mesh is there, and of each whether it is drawn and how thin. */
  shown(): Array<{ id: string; visible: boolean; opacity: number }> {
    return this.entries.filter((entry) => entry.built).map((entry) => ({ id: entry.info.id, visible: entry.built!.group.visible, opacity: this.opacityOf(entry) }))
  }

  /** A box round what is drawn of them, in the object frame; null when nothing is. */
  box(): THREE.Box3 | null {
    const all = new THREE.Box3()
    const one = new THREE.Box3()
    for (const { built } of this.entries) {
      if (!built?.group.visible || !built.mesh.geometry.boundingBox) continue
      all.union(one.copy(built.mesh.geometry.boundingBox).applyMatrix4(built.group.matrix))
    }
    return all.isEmpty() ? null : all
  }

  state(): ScanLayerState[] {
    return this.entries.map((entry) => {
      const { info, built } = entry
      const alignment = alignmentOf(info, this.layout)
      return {
        id: info.id,
        loaded: built !== null,
        ready: false,
        triangles: built?.triangles ?? info.imported.triangles,
        aligned: alignment !== null,
        visible: this.views.get(info.id)?.visible !== false,
        opacity: this.opacityOf(entry),
        transform: alignment?.transform ?? IDENTITY
      }
    })
  }

  dispose(): void {
    for (const { built } of this.entries) if (built) disposeScan(built)
    this.entries = []
    this.group.clear()
  }

  /** Has the group hold the scans built, in their order, each as it is to be drawn. */
  private arrange(): void {
    this.group.clear()
    for (const entry of this.entries) {
      if (entry.built) this.group.add(entry.built.group)
      this.apply(entry)
    }
    this.redraw()
  }

  private opacityOf(entry: Entry): number {
    const opacity = this.views.get(entry.info.id)?.opacity
    return typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(Math.max(opacity, MIN_SCAN_OPACITY), 1) : 1
  }

  /** Brings what is drawn of one scan in line with its alignment, how it is looked at, the theme and the section. */
  private apply(entry: Entry): void {
    const { info, built } = entry
    if (!built) return
    const view = this.views.get(info.id)
    placeScan(built, alignmentOf(info, this.pictured?.layout ?? this.layout)?.transform ?? IDENTITY)

    const material = view?.colour !== 'plain' && built.own ? built.own : built.plain
    built.mesh.material = material
    built.plain.color.set(this.stale ? mix(toHex(this.look.plain), toHex(this.look.surface), STALE_FADE) : this.look.plain)
    fadeOwn(built, this.look.surface, this.stale ? STALE_FADE : 0)

    const opacity = this.opacityOf(entry)
    const transparent = opacity < SOLID_FROM
    for (const each of [built.plain, built.own]) {
      if (!each) continue
      if (each.transparent !== transparent) each.needsUpdate = true
      each.transparent = transparent
      each.opacity = opacity
      each.depthWrite = !transparent
      each.clippingPlanes = this.planes
    }
    built.group.visible = this.pictured ? this.pictured.ids.has(info.id) : view?.visible !== false
  }
}

/**
 * What says which mesh a scan's record is of: when it was imported or converted, how, and the file main keeps it in.
 * The window never reads that file itself: a record that says otherwise is a reason to ask main for the bytes again.
 */
export function meshOf(info: ScanInfo): string {
  const { at, unit, up, vertices, triangles } = info.imported
  return [at, unit, up, vertices, triangles, info.imported.mesh ?? ''].join('|')
}

/** Any CSS colour as #RRGGBB. */
function toHex(color: string): string {
  return `#${new THREE.Color(color).getHexString()}`
}

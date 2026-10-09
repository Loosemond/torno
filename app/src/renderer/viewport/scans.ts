import * as THREE from 'three'
import { type MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'
import type { Vec3 } from '../../shared/marks'
import { IDENTITY, MIN_SCAN_OPACITY, alignmentOf, staleText, type ScanInfo, type ScanTransform, type ScanView } from '../../shared/scans'
import { STALE_FADE, mix } from './palette'
import { buildScanBvh } from './scanBvh'
import { buildScan, disposeScan, fadeOwn, placeScan, type BuiltScan } from './scanMesh'

export interface ScanLayerState {
  id: string
  loaded: boolean
  /** Its tree is there: it can be picked. */
  ready: boolean
  /** Where that tree was made: in a worker, or on the window's own thread; null until it is there. */
  how: 'worker' | 'main' | null
  triangles: number
  aligned: boolean
  visible: boolean
  opacity: number
  transform: ScanTransform
}

/** What is drawn of a scan, and what must be said of it with a picture: whether it is aligned in the layout drawn, and why that may no longer hold. */
export interface ShownScan { id: string; visible: boolean; opacity: number; aligned: boolean; stale: string | null }

/**
 * What a pointer is on, of a scan. `point` and `normal` are in the object frame of the layout shown; `local` is
 * the same point in the scan's own frame. The normal looks towards the eye. `triangle` is its number in the
 * scan's mesh file, and `distance` is along the ray from where it starts, in millimetres of the object frame.
 */
export interface ScanHit { scan: string; triangle: number; point: Vec3; local: Vec3; normal: Vec3; distance: number }

/** A ray as a pointer event has it (`ViewportPointer.ray`), for `ScanLayer.pick`. */
export function rayOf(ray: { origin: Vec3; direction: Vec3 }): THREE.Ray {
  return new THREE.Ray(new THREE.Vector3().fromArray(ray.origin), new THREE.Vector3().fromArray(ray.direction))
}

/** How many times the size of the parts the camera reaches for a scan. */
export const SCAN_REACH = 200

/**
 * A sphere the camera's near and far are set by, grown to hold the scans
 * drawn (`box`), but no further than `SCAN_REACH` times the sphere round the
 * parts: a scan read a thousand times too large would take the near plane
 * past the parts, and they would not be seen. `extent` is changed and returned.
 */
export function reaching(extent: THREE.Sphere, box: THREE.Box3 | null, parts: THREE.Sphere): THREE.Sphere {
  if (!box) return extent
  const all = extent.clone().union(box.getBoundingSphere(new THREE.Sphere()))
  const most = parts.radius * SCAN_REACH
  if (all.radius <= most) return extent.copy(all)
  // Round the parts, as far as that; what else is drawn (marks, the plane of a section) stays inside.
  const round = new THREE.Sphere(parts.center.clone(), most)
  return extent.copy(round.union(extent.clone()))
}
/**
 * A scan takes the pick from a part only when it is nearer than the part by more than this, in millimetres:
 * where the two lie in one surface the part is the one drawn (the scan is pushed back in depth), so it is the one picked.
 */
export const SCAN_BEHIND_MM = 0.01
/** From here up a scan is drawn solid: it writes depth, and what is behind it is hidden. */
const SOLID_FROM = 0.95

interface Entry {
  info: ScanInfo
  /** Null until its mesh has come. */
  built: BuiltScan | null
  /** The bounds tree of that mesh, and how it was made; null until it is there. */
  tree: { tree: MeshBVH; how: 'worker' | 'main' } | null
}

/** A coordinate as it is told: to the millionth of a micrometre, and never -0. */
const rounded = (c: number): number => Math.round(c * 1e9) / 1e9 + 0
const roundedAll = (v: THREE.Vector3): Vec3 => [rounded(v.x), rounded(v.y), rounded(v.z)]

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
  /** Who waits for the tree of a scan, by id (`whenReady`). */
  private readonly waiting = new Map<string, Array<() => void>>()

  constructor(private readonly redraw: () => void) {}

  /** The scans of the object on show, and the layout shown: which there are and where each stands. Their meshes come by `load`. */
  set(scans: ScanInfo[], layout: string): void {
    const had = new Map(this.entries.map((entry) => [entry.info.id, entry]))
    this.layout = layout
    this.entries = scans.map((info) => {
      const entry = had.get(info.id)
      had.delete(info.id)
      // The mesh is that of one record: converted to another unit, written to another file, or gone from the disk, it is not what was built.
      if (entry?.built && (info.meshState !== 'ok' || meshOf(info) !== meshOf(entry.info))) this.letGo(entry)
      return { info, built: entry?.built ?? null, tree: entry?.tree ?? null }
    })
    for (const gone of had.values()) this.letGo(gone)
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
    const built = buildScan(id, blob)
    entry.built = built
    this.arrange()
    // Drawn at once; it can be pointed at when its tree is there, which a worker makes meanwhile.
    buildScanBvh(built.mesh.geometry).then(
      (made) => {
        // Let go of meanwhile (removed, converted): the tree is of a mesh that is no longer drawn.
        const now = this.entries.find((e) => e.built === built)
        if (!now) return
        built.mesh.geometry.boundsTree = made.tree
        built.mesh.raycast = acceleratedRaycast
        now.tree = made
        this.told(id)
        this.redraw()
      },
      // No tree can be made of it: it is drawn, and cannot be pointed at.
      () => this.told(id)
    )
  }

  /** Resolves once the scan's tree is there, or it has been let go of (removed, or its mesh replaced or gone); at once for a scan that is not there. */
  whenReady(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.info.id === id)
    if (!entry || entry.tree) return Promise.resolve()
    return new Promise((resolve) => this.waiting.set(id, [...(this.waiting.get(id) ?? []), resolve]))
  }

  /** A scan's tree and how it was made; null until it is there. */
  tree(id: string): { tree: MeshBVH; how: 'worker' | 'main'; built: BuiltScan } | null {
    const entry = this.entries.find((e) => e.info.id === id)
    return entry?.built && entry.tree ? { ...entry.tree, built: entry.built } : null
  }

  /**
   * The first thing a ray meets of the scans drawn whose trees are there, from either side; nothing further
   * along it than `within`. With a section (`keeps`: what it keeps is on the plane's positive side), the first
   * the plane keeps. The ray is in the object frame, its direction of length one.
   */
  pick(ray: THREE.Ray, keeps: THREE.Plane | null, within = Infinity): ScanHit | null {
    let best: ScanHit | null = null
    for (const { info, built, tree } of this.entries) {
      if (!built || !tree || !built.group.visible) continue
      // In the scan's own frame, where its tree is. A scan that was scaled stretches distances: they are taken again in the object frame.
      const { matrix } = built.group
      localRay.copy(ray).applyMatrix4(inverse.copy(matrix).invert())
      const hits = keeps ? tree.tree.raycast(localRay, THREE.DoubleSide).sort((a, b) => a.distance - b.distance) : [tree.tree.raycastFirst(localRay, THREE.DoubleSide)]
      for (const hit of hits) {
        if (!hit) break
        point.copy(hit.point).applyMatrix4(matrix)
        if (keeps && keeps.distanceToPoint(point) < 0) continue
        const distance = point.distanceTo(ray.origin)
        if (distance <= within && (!best || distance < best.distance)) {
          normal.copy(hit.face?.normal ?? ray.direction).transformDirection(matrix)
          if (normal.dot(ray.direction) > 0) normal.negate()
          best = { scan: info.id, triangle: hit.faceIndex ?? -1, point: roundedAll(point), local: roundedAll(hit.point), normal: roundedAll(normal), distance: rounded(distance) }
        }
        break
      }
    }
    return best
  }

  /** Whether a scan is drawn thin enough for what is behind it to be seen through it. */
  seenThrough(id: string): boolean {
    const entry = this.entries.find((e) => e.info.id === id)
    return entry !== undefined && this.opacityOf(entry) < SOLID_FROM
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

  /**
   * The scans whose mesh is there, and of each whether it is drawn, how thin,
   * and whether it is aligned in the layout drawn: the one on screen, or a
   * picture's while one is made.
   */
  shown(): ShownScan[] {
    const layout = this.pictured?.layout ?? this.layout
    return this.entries
      .filter((entry) => entry.built)
      .map((entry) => {
        const aligned = alignmentOf(entry.info, layout) !== null
        return { id: entry.info.id, visible: entry.built!.group.visible, opacity: this.opacityOf(entry), aligned, stale: aligned ? staleText(entry.info.checks[layout]) : null }
      })
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
        ready: entry.tree !== null,
        how: entry.tree?.how ?? null,
        triangles: built?.triangles ?? info.imported.triangles,
        aligned: alignment !== null,
        visible: this.views.get(info.id)?.visible !== false,
        opacity: this.opacityOf(entry),
        transform: alignment?.transform ?? IDENTITY
      }
    })
  }

  dispose(): void {
    for (const entry of this.entries) this.letGo(entry)
    this.entries = []
    this.group.clear()
  }

  /** Lets go of a scan's mesh and of its tree: whoever waited for the tree waits no longer. */
  private letGo(entry: Entry): void {
    if (entry.built) {
      entry.built.mesh.geometry.boundsTree = undefined
      disposeScan(entry.built)
    }
    entry.built = null
    entry.tree = null
    this.told(entry.info.id)
  }

  /** Tells whoever waited for a scan's tree. */
  private told(id: string): void {
    const waiting = this.waiting.get(id)
    this.waiting.delete(id)
    for (const resolve of waiting ?? []) resolve()
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

const localRay = new THREE.Ray()
const inverse = new THREE.Matrix4()
const point = new THREE.Vector3()
const normal = new THREE.Vector3()

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

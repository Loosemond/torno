import * as THREE from 'three'
import { type MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'
import type { Vec3 } from '../../shared/marks'
import { apply as applyTransform } from '../../shared/align'
import { IDENTITY, MIN_SCAN_OPACITY, alignmentOf, standingOf, type ScanInfo, type ScanTransform, type ScanView } from '../../shared/scans'
import { tenth } from '../../shared/format'
import { STALE_FADE, mix } from '../../shared/palette'
import { buildScanBvh } from './scanBvh'
import { SCAN_OFFSET_FACTOR, buildScan, depthOnly, disposeScan, dropBorrowed, fadeOwn, placeScan, type BuiltScan } from './scanMesh'
import { ScanTints } from './scanTints'

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
  /** Where it is drawn: where its alignment for the layout shown puts it, or where it is drawn for now (`preview`). */
  transform: ScanTransform
  /** Some of it is outside what the camera is given to reach, which is no further than `SCAN_REACH` times the parts' sphere: the far plane cuts it (`beyondReach`). */
  clipped: boolean
}

/**
 * What is drawn of a scan, and what must be said of it with a picture: whether it is aligned in the layout
 * drawn, what that rests on (`basis`), why it may no longer hold or was not checked against the build on show
 * (`stale`; `waiting` when that is all it says), why its fit is rough, and what else is to be known of it
 * (`note`). As `standingOf` says them. `clipped` when not all of it is drawn: it reaches further than the camera
 * does for a scan (`beyondReach`).
 */
export interface ShownScan { id: string; visible: boolean; opacity: number; aligned: boolean; stale: string | null; rough: string | null; basis: string | null; note: string | null; waiting: boolean; clipped?: true }

/** Makes the bounds tree of a scan's geometry; `stop` says the mesh was let go of meanwhile (`buildScanBvh`). */
export type TreeBuilder = (geometry: THREE.BufferGeometry, stop: AbortSignal) => Promise<{ tree: MeshBVH; how: 'worker' | 'main' }>

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
/** How solid a scan coloured by its distance to a part is drawn where it is beyond the range: the part behind it stays in sight. */
export const FAR_OPACITY = 0.35
/** The scan points inside a part are drawn after everything else, over it. */
const INSIDE_LAST = 3

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
  if (!(all.radius > most)) return extent.copy(all)
  // Round the parts, as far as that; what else is drawn (marks, the plane of a section) stays inside.
  const round = new THREE.Sphere(parts.center.clone(), most)
  return extent.copy(round.union(extent.clone()))
}

/**
 * Whether some of a box of a scan is outside what the camera is given to reach (`reach`: the sphere its near
 * and far are set by, which `reaching` holds to `SCAN_REACH` times the parts): the far plane cuts it.
 */
export function beyondReach(box: THREE.Box3, reach: THREE.Sphere): boolean {
  const most = reach.radius * (1 + 1e-9) + 1e-6
  const corner = new THREE.Vector3()
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) if (corner.set(x, y, z).distanceTo(reach.center) > most) return true
  return false
}

/**
 * A scan takes the pick from a part only when it is nearer than the part by more than this, in millimetres,
 * and by more than it is drawn pushed back there (`drawnBehind`): where the two lie in one surface the part is
 * the one drawn, so it is the one picked.
 */
export const SCAN_BEHIND_MM = 0.01

/**
 * How far along a ray a scan is drawn behind where it is, in millimetres: the scan's materials are pushed
 * back in depth by `SCAN_OFFSET_FACTOR` pixels' worth of the surface's own slope (`polygonOffset`), so that a
 * part lying in it is the one seen. Head on that is next to nothing; at a slant it is `factor × mm per pixel ×
 * tan` of the angle between the ray and the surface's normal. `normal` and `direction` are of length one.
 */
export function drawnBehind(normal: Vec3, direction: Vec3, mmPerPixel: number): number {
  const along = Math.abs(normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2])
  const slope = along > 1e-6 ? Math.sqrt(Math.max(1 - along * along, 0)) / along : 1e6
  return SCAN_BEHIND_MM + SCAN_OFFSET_FACTOR * mmPerPixel * slope
}
/** From here up a scan is drawn solid: it writes depth, and what is behind it is hidden. */
const SOLID_FROM = 0.95

interface Entry {
  info: ScanInfo
  /** Null until its mesh has come. */
  built: BuiltScan | null
  /** The bounds tree of that mesh, and how it was made; null until it is there. */
  tree: { tree: MeshBVH; how: 'worker' | 'main' } | null
  /** Says to whoever makes that tree that the mesh was let go of. */
  stop?: AbortController
  /** What lays its depth down first while it is drawn seen through (`depthOnly`). */
  depth?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
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
  /** The build on show, 0 for none: what an alignment's check is held against. */
  private revision = 0
  /** How each is looked at, by id. Kept for a scan whose mesh, or whose record, has yet to come. */
  private readonly views = new Map<string, ScanView>()
  private look = { plain: '#B4AFA5', surface: '#F1EFEA' }
  private stale = false
  private planes: THREE.Plane[] | null = null
  /** While a picture is drawn: the scans it draws, and the layout it is of. */
  private pictured: { ids: ReadonlySet<string>; layout: string } | null = null
  /** Who waits for the tree of a scan, by id (`whenReady`). */
  private readonly waiting = new Map<string, Array<() => void>>()
  /** Where a scan is drawn for now instead of where main has it, by id (`preview`). */
  private readonly previews = new Map<string, ScanTransform>()
  private accent = '#1D46B8'
  /** The scan a picture draws in colours of its own, if one is: a mesh over the scan's own positions and triangles, in the scan's group. */
  private coloured: { scan: string; meshes: Array<THREE.Mesh<THREE.BufferGeometry, THREE.Material>>; own: THREE.Mesh; depth: boolean } | null = null
  /** The patch of a scan that is tinted, if one is: a mesh over the scan's own positions, in the scan's group. */
  private tint: { scan: string; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; index: Uint32Array } | null = null

  /** What is laid over the scans: the regions kept, and the set being painted. */
  readonly tints: ScanTints

  constructor(
    private readonly redraw: () => void,
    private readonly build: TreeBuilder = (geometry, stop) => buildScanBvh(geometry, undefined, stop)
  ) {
    this.tints = new ScanTints(redraw, (id) => this.built(id))
  }

  /** The scans of the object on show, the layout shown and the build on show: which there are and where each stands. Their meshes come by `load`. */
  set(scans: ScanInfo[], layout: string, revision = this.revision): void {
    const had = new Map(this.entries.map((entry) => [entry.info.id, entry]))
    this.layout = layout
    this.revision = revision
    this.entries = scans.map((info) => {
      const entry = had.get(info.id)
      had.delete(info.id)
      // The mesh is that of one record: converted to another unit, written to another file, or gone from the disk, it is not what was built.
      if (entry?.built && (info.meshState !== 'ok' || meshOf(info) !== meshOf(entry.info))) this.letGo(entry)
      return { info, built: entry?.built ?? null, tree: entry?.tree ?? null, stop: entry?.stop }
    })
    for (const gone of had.values()) {
      this.letGo(gone)
      this.previews.delete(gone.info.id)
    }
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
    entry.stop = new AbortController()
    this.arrange()
    // Let go of meanwhile (removed, converted): what comes of its tree is of a mesh that is no longer drawn, and says nothing of the one that is.
    const still = (): Entry | undefined => this.entries.find((e) => e.built === built)
    // Drawn at once; it can be pointed at when its tree is there, which a worker makes meanwhile.
    this.build(built.mesh.geometry, entry.stop.signal).then(
      (made) => {
        const now = still()
        if (!now) return
        built.mesh.geometry.boundsTree = made.tree
        built.mesh.raycast = acceleratedRaycast
        now.tree = made
        this.told(id)
        this.redraw()
      },
      // No tree can be made of it: it is drawn, and cannot be pointed at.
      () => {
        if (still()) this.told(id)
      }
    )
  }

  /**
   * Resolves once the scan's tree is there, or it has been let go of (removed, or its mesh replaced or gone);
   * at once for a scan that is not there, or whose mesh cannot come (`meshState: 'missing'`).
   */
  whenReady(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.info.id === id)
    if (!entry || entry.tree || entry.info.meshState !== 'ok') return Promise.resolve()
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
   * the plane keeps. The ray is in the object frame, its direction of length one. With `solid`, only of the
   * scans drawn solid: one that is seen through is passed through, whichever is in front.
   */
  pick(ray: THREE.Ray, keeps: THREE.Plane | null, within = Infinity, solid = false): ScanHit | null {
    let best: ScanHit | null = null
    for (const entry of this.entries) {
      const { info, built, tree } = entry
      if (!built || !tree || !built.group.visible || (solid && this.opacityOf(entry) < SOLID_FROM)) continue
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

  /**
   * Whether a scan stands in front of what a ray meets `reach` millimetres along it, so that this is not what is
   * seen there: a scan drawn solid (one that is seen through hides nothing, and takes no pick), nearer than that
   * by more than it is drawn pushed back (`drawnBehind`). `mmPerPixel` is what a pixel is at a point of the object.
   */
  blocks(ray: THREE.Ray, keeps: THREE.Plane | null, reach: number, mmPerPixel: (at: Vec3) => number): boolean {
    return this.blocker(ray, keeps, reach, mmPerPixel) !== null
  }

  /** The scan that `blocks`, by its id; null when none does. */
  blocker(ray: THREE.Ray, keeps: THREE.Plane | null, reach: number, mmPerPixel: (at: Vec3) => number): string | null {
    const hit = this.pick(ray, keeps, reach, true)
    return hit !== null && hit.distance < reach - drawnBehind(hit.normal, ray.direction.toArray(), mmPerPixel(hit.point)) ? hit.scan : null
  }

  /** Draws a scan somewhere else for now (a fit not yet applied, a drag); null draws it where main has it. Never in a picture. */
  preview(id: string, transform: ScanTransform | null): void {
    if (transform) this.previews.set(id, transform)
    else if (!this.previews.delete(id)) return
    const entry = this.entries.find((e) => e.info.id === id)
    if (entry) this.apply(entry)
    this.redraw()
  }

  /** Where a scan is drawn in the layout shown: for now (`preview`), by its alignment, or as imported. Null for a scan that is not there. */
  placed(id: string): ScanTransform | null {
    const entry = this.entries.find((e) => e.info.id === id)
    return entry ? (this.previews.get(id) ?? alignmentOf(entry.info, this.layout)?.transform ?? IDENTITY) : null
  }

  /**
   * Where a scan stands in a layout: where it is drawn for now when that is the layout on screen, else by its
   * alignment there, or as imported. Null for a scan that is not there or whose mesh has not come.
   */
  placedIn(id: string, layout: string): ScanTransform | null {
    const entry = this.entries.find((e) => e.info.id === id)
    if (!entry?.built) return null
    return (layout === this.layout && !this.pictured ? this.previews.get(id) : undefined) ?? alignmentOf(entry.info, layout)?.transform ?? IDENTITY
  }

  /** Whether a scan is drawn on screen: its mesh has come and it is switched on. */
  drawn(id: string): boolean {
    const entry = this.entries.find((e) => e.info.id === id)
    return entry?.built != null && this.views.get(id)?.visible !== false
  }

  /**
   * The triangles of a scan within `radius` mm of a hit whose normals are within `degrees` (25) of the hit's:
   * their middles in the object frame, as the scan is drawn, and their areas in mm² there. With `tint` they are
   * tinted over the scan; without, or for no hit, the tint is taken away. Null for no hit, or a scan with no tree.
   */
  patch(hit: ScanHit | null, radius: number, opts: { degrees?: number; tint?: boolean } = {}): { points: Vec3[]; weights: number[] } | null {
    const found = hit && this.tree(hit.scan)
    if (!hit || !found) {
      this.untint()
      return null
    }
    const { tree, built } = found
    const { matrix } = built.group
    // In the scan's own frame, where its tree is: the radius and the areas are of the object frame, which a scale stretches.
    const scale = built.group.scale.x
    const sphere = new THREE.Sphere(new THREE.Vector3().fromArray(hit.local), radius / scale)
    const facing = new THREE.Vector3().fromArray(hit.normal).transformDirection(inverse.copy(matrix).invert())
    const least = Math.cos(THREE.MathUtils.degToRad(opts.degrees ?? 25))
    const points: Vec3[] = []
    const weights: number[] = []
    const triangles: number[] = []
    tree.shapecast({
      intersectsBounds: (box) => box.intersectsSphere(sphere),
      intersectsTriangle: (triangle, index) => {
        triangle.getMidpoint(point)
        // From either side: a scan's triangles do not all wind one way.
        if (!sphere.containsPoint(point) || Math.abs(triangle.getNormal(normal).dot(facing)) < least) return false
        points.push(roundedAll(point.applyMatrix4(matrix)))
        weights.push(triangle.getArea() * scale * scale)
        triangles.push(index)
        return false
      }
    })
    if (opts.tint) this.tinted(hit.scan, built, triangles)
    else this.untint()
    return { points, weights }
  }

  /** Tints some triangles of a scan: one mesh over the scan's own positions, with an index of its own. Never a second copy of the scan. */
  private tinted(scan: string, built: BuiltScan, triangles: number[]): void {
    if (this.tint && this.tint.scan !== scan) this.untint()
    const of = built.mesh.geometry.index!.array
    let tint = this.tint
    if (!tint || tint.index.length < 3 * triangles.length) {
      this.untint()
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', built.mesh.geometry.getAttribute('position'))
      const index = new Uint32Array(Math.max(3 * triangles.length * 2, 3072))
      geometry.setIndex(new THREE.BufferAttribute(index, 1))
      // Over the scan's own surface, which is drawn pushed back: nearer by a hair, and never in the depth buffer.
      const material = new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, clippingPlanes: this.planes })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 1
      tint = this.tint = { scan, mesh, index }
    }
    triangles.forEach((triangle, n) => tint.index.set([of[3 * triangle], of[3 * triangle + 1], of[3 * triangle + 2]], 3 * n))
    tint.mesh.geometry.index!.needsUpdate = true
    tint.mesh.geometry.setDrawRange(0, 3 * triangles.length)
    tint.mesh.visible = this.pictured === null
    if (tint.mesh.parent !== built.group) built.group.add(tint.mesh)
    this.redraw()
  }

  private untint(): void {
    if (!this.tint) return
    this.tint.mesh.removeFromParent()
    // Its positions are the scan's own, and stay.
    this.tint.mesh.geometry.deleteAttribute('position')
    this.tint.mesh.geometry.dispose()
    this.tint.mesh.material.dispose()
    this.tint = null
    this.redraw()
  }

  /** The mesh of a scan as it was built; null for a scan that is not there, or whose mesh has not come. */
  built(id: string): BuiltScan | null {
    return this.entries.find((e) => e.info.id === id)?.built ?? null
  }

  /**
   * Draws a scan in the colours given, r g b for each vertex in linear light (0 to 65535), until it is called with
   * null: for one picture. By meshes and materials of their own over the scan's own positions and triangles:
   * neither the scan's own colours nor the shader they are drawn through (`BuiltScan.own`) are touched.
   *
   * The colours are lit, flat shaded as the plain scan is: without that a scan is one even field and nothing
   * of its shape is read. So a pixel is the colour of its vertices only about: darker where the surface turns
   * from the light. With `of`, what the colours stand for: a vertex in `of.far` (beyond the range) is drawn
   * seen through (`FAR_OPACITY`), nearest layer only, so that the part it is measured to stays in sight behind
   * it; the triangles with a vertex in `of.inside` (inside the part, where the part's own surface hides them)
   * are drawn once more over everything. Null puts the scan back as it was. Throws for a scan that is not
   * there, whose mesh has not come, or for colours that are not one a vertex.
   */
  colourFor(id: string, colours: Uint16Array | null, of?: { far: readonly number[]; inside: readonly number[] | null }): void {
    if (this.coloured) {
      const { meshes, own } = this.coloured
      // Their positions and their triangles are the scan's own, and stay: only what was made here is freed.
      for (const mesh of meshes) dropBorrowed(mesh)
      own.visible = true
      this.coloured = null
      const was = this.entries.find((e) => e.built?.mesh === own)
      if (was) this.apply(was)
    }
    if (colours === null) return
    const entry = this.entries.find((e) => e.info.id === id)
    if (!entry) throw new Error(`no scan ${id}; scans: ${this.entries.map((e) => e.info.id).join(', ') || 'none'}`)
    const built = entry.built
    if (!built) throw new Error(`${id}'s mesh has not come to the window yet: look again in a moment`)
    if (colours.length !== built.vertices * 3) throw new Error(`${id} has ${built.vertices} vertices, and ${colours.length / 3} colours were given`)
    const is = (v: number, colour: readonly number[]): boolean => colours[3 * v] === colour[0] && colours[3 * v + 1] === colour[1] && colours[3 * v + 2] === colour[2]
    // r g b and how solid, a vertex.
    const rgba = new Uint16Array(built.vertices * 4)
    const thin = Math.round(FAR_OPACITY * 65535)
    let seenThrough = false
    for (let v = 0; v < built.vertices; v++) {
      rgba.set(colours.subarray(3 * v, 3 * v + 3), 4 * v)
      const far = of !== undefined && is(v, of.far)
      rgba[4 * v + 3] = far ? thin : 65535
      seenThrough ||= far
    }
    const own = built.mesh.geometry
    const borrowed = (index: THREE.BufferAttribute | null): THREE.BufferGeometry => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', own.getAttribute('position'))
      geometry.setIndex(index)
      geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4, true))
      geometry.boundingBox = own.boundingBox
      geometry.boundingSphere = own.boundingSphere
      return geometry
    }
    const surface = { vertexColors: true, toneMapped: false, side: THREE.DoubleSide, clippingPlanes: this.planes } as const
    const material = new THREE.MeshStandardMaterial({ ...surface, flatShading: true, roughness: 0.9, metalness: 0, transparent: seenThrough, depthWrite: !seenThrough, polygonOffset: true, polygonOffsetFactor: SCAN_OFFSET_FACTOR, polygonOffsetUnits: 2 })
    const mesh = new THREE.Mesh(borrowed(own.index), material)
    mesh.name = 'scan-coloured'
    const meshes: Array<THREE.Mesh<THREE.BufferGeometry, THREE.Material>> = [mesh]
    if (seenThrough) meshes.push(depthOnly(own, this.planes))
    // What is inside the part is behind the part's own surface: drawn once more, over it, or it would never be seen.
    const index = own.index!.array
    const inside: number[] = []
    if (of?.inside) for (let t = 0; t < index.length; t += 3) if (is(index[t], of.inside) || is(index[t + 1], of.inside) || is(index[t + 2], of.inside)) inside.push(index[t], index[t + 1], index[t + 2])
    if (inside.length > 0) {
      const over = new THREE.Mesh(borrowed(new THREE.BufferAttribute(Uint32Array.from(inside), 1)), new THREE.MeshBasicMaterial({ ...surface, depthTest: false, depthWrite: false, transparent: true }))
      over.name = 'scan-inside'
      over.renderOrder = INSIDE_LAST
      over.frustumCulled = false
      meshes.push(over)
    }
    for (const each of meshes) each.raycast = () => {}
    built.mesh.visible = false
    built.group.add(...meshes)
    this.coloured = { scan: id, meshes, own: built.mesh, depth: seenThrough }
    // The scan's own depth pass, if it is drawn thin on screen, is not this picture's.
    this.apply(entry)
  }

  /** How a scan is looked at; what is left out keeps its value. */
  setView(id: string, view: ScanView): void {
    this.views.set(id, { ...this.views.get(id), ...view })
    const entry = this.entries.find((e) => e.info.id === id)
    if (entry) this.apply(entry)
    this.redraw()
  }

  /** The colour of a scan drawn plain, the background, the colour a patch is tinted in and those of the marks (its regions are marks), and whether the parts are stale: the scans fade with them. */
  setLook(look: { plain: string; surface: string; accent?: string; marks?: { user: string; agent: string } }, stale: boolean): void {
    this.look = look
    if (look.marks) this.tints.setColours(look.marks)
    this.accent = look.accent ?? this.accent
    this.tint?.mesh.material.color.set(this.accent)
    this.stale = stale
    for (const entry of this.entries) this.apply(entry)
    this.redraw()
  }

  /** What every scan is clipped by: the planes of a section, or null for none. */
  setClipping(planes: THREE.Plane[] | null): void {
    this.planes = planes
    if (this.tint) this.tint.mesh.material.clippingPlanes = planes
    for (const mesh of this.coloured?.meshes ?? []) mesh.material.clippingPlanes = planes
    this.tints.setClipping(planes)
    for (const entry of this.entries) this.apply(entry)
  }

  /**
   * For a picture: only these are drawn (none for null), each as it is on
   * screen, but where the picture's layout puts it when that is another.
   * Returns what puts the screen back. Throws, having changed nothing, for an
   * id that is no scan of the object. The regions are tinted on the scans
   * drawn unless `regions` is false (a picture without marks);
   * the set being painted is in no picture.
   */
  showOnly(ids: string[] | null, layout = this.layout, regions = true): () => void {
    const unknown = (ids ?? []).find((id) => !this.entries.some((entry) => entry.info.id === id))
    if (unknown !== undefined) throw new Error(`no scan ${unknown}; scans: ${this.entries.map((entry) => entry.info.id).join(', ') || 'none'}`)
    this.pictured = { ids: new Set(ids ?? []), layout }
    for (const entry of this.entries) this.apply(entry)
    if (this.tint) this.tint.mesh.visible = false
    this.tints.show({ regions })
    return () => {
      this.pictured = null
      for (const entry of this.entries) this.apply(entry)
      if (this.tint) this.tint.mesh.visible = true
      this.tints.show()
    }
  }

  /**
   * The scans whose mesh is there, and of each whether it is drawn, how thin,
   * and whether it is aligned in the layout drawn: the one on screen, or a
   * picture's while one is made.
   */
  shown(reach?: THREE.Sphere): ShownScan[] {
    const layout = this.pictured?.layout ?? this.layout
    return this.entries
      .filter((entry) => entry.built)
      .map((entry) => {
        // For a caption, which the agent reads: a fit's figures to a tenth of a millimetre, as main tells them.
        const { aligned, stale, rough, basis, note, waiting } = standingOf(entry.info, layout, this.revision, tenth)
        return { id: entry.info.id, visible: entry.built!.group.visible, opacity: this.opacityOf(entry), aligned, stale, rough, basis, note, waiting, ...(this.cutShort(entry, reach) ? { clipped: true as const } : {}) }
      })
  }

  /** Whether a scan that is drawn reaches out of the sphere the camera is given for what it draws (`beyondReach`). Not without that sphere. */
  private cutShort(entry: Entry, reach?: THREE.Sphere): boolean {
    const box = entry.built?.group.visible ? entry.built.mesh.geometry.boundingBox : null
    return reach !== undefined && !!box && beyondReach(box.clone().applyMatrix4(entry.built!.group.matrix), reach)
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

  /**
   * A box round where some scans stand in a layout (by the alignment main has for it, or as imported), in the
   * object frame: those of `ids` whose mesh has come; null when none has. For what is fitted to them before
   * they are drawn there (a picture of another layout).
   */
  boxIn(ids: readonly string[], layout: string): THREE.Box3 | null {
    const all = new THREE.Box3()
    const corner = new THREE.Vector3()
    for (const { info, built } of this.entries) {
      const box = built?.mesh.geometry.boundingBox
      if (!box || !ids.includes(info.id)) continue
      const transform = alignmentOf(info, layout)?.transform ?? IDENTITY
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) all.expandByPoint(corner.fromArray(applyTransform(transform, [x, y, z])))
    }
    return all.isEmpty() ? null : all
  }

  state(reach?: THREE.Sphere): ScanLayerState[] {
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
        transform: this.previews.get(info.id) ?? alignment?.transform ?? IDENTITY,
        clipped: this.cutShort(entry, reach)
      }
    })
  }

  dispose(): void {
    for (const entry of this.entries) this.letGo(entry)
    this.entries = []
    this.tints.dispose()
    this.group.clear()
  }

  /** Lets go of a scan's mesh and of its tree: whoever waited for the tree waits no longer. */
  private letGo(entry: Entry): void {
    entry.stop?.abort()
    entry.stop = undefined
    if (entry.built) {
      if (entry.depth) dropBorrowed(entry.depth)
      entry.depth = undefined
      if (this.tint?.scan === entry.info.id) this.untint()
      if (this.coloured?.scan === entry.info.id) this.colourFor(entry.info.id, null)
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
    // After the meshes: a region is drawn over the mesh its scan has now.
    this.tints.sync()
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
    // A picture draws a scan where main has it, in the picture's layout: never where it is drawn for now.
    placeScan(built, (this.pictured ? undefined : this.previews.get(info.id)) ?? alignmentOf(info, this.pictured?.layout ?? this.layout)?.transform ?? IDENTITY)

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
    // Seen through, its depth is laid down first (`depthOnly`): only its nearest layer is blended. Not while a
    // picture draws it in colours of its own, which bring their own.
    const depthFirst = transparent && this.coloured?.own !== built.mesh
    if (depthFirst && !entry.depth) {
      entry.depth = depthOnly(built.mesh.geometry, this.planes)
      built.group.add(entry.depth)
    } else if (!depthFirst && entry.depth) {
      dropBorrowed(entry.depth)
      entry.depth = undefined
    }
    if (entry.depth) entry.depth.material.clippingPlanes = this.planes
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

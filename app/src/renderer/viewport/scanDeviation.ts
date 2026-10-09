import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import type { BuiltPart } from './partMesh'
import type { BuiltScan } from './scanMesh'

// A scan coloured by how far it is from a part, for one picture: a look for the eye, worked out from the two meshes
// as they are drawn. No number is told from it: the numbers of a scan against a part are the kernel's
// (`scan_deviation`).

/** A colour as three shares, 0 to 1, in sRGB: as a token of the stylesheet says it. */
export type Rgb = [number, number, number]

/** The colour of a scan vertex `distance` mm from a part: `near` at 0, `far` at `range` and beyond, `inside` when it is in the part. */
export function deviationColour(distance: number, inside: boolean, range: number, colours: { near: Rgb; far: Rgb; inside: Rgb }): Rgb {
  if (inside) return colours.inside
  const share = range > 0 ? Math.min(Math.max(distance / range, 0), 1) : 1
  return colours.near.map((c, i) => c + (colours.far[i] - c) * share) as Rgb
}

/**
 * The most scan vertices near a part that a picture colours, and the longest working them out may take: it is done
 * on the window's own thread, which draws nothing and answers no pointer meanwhile.
 */
export const MAX_COLOURED = 60_000
export const TIME_LIMIT_MS = 1500
/** Every how many vertices the clock is looked at. */
const CLOCK_EVERY = 2000

/** Linear light of an sRGB share: what three.js takes a vertex colour to be. */
export function linearOf(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const stored = (rgb: Rgb): Rgb => rgb.map((c) => Math.round(linearOf(c) * 65535)) as Rgb
/** A colour as `deviationColours` writes it for a vertex: by it a vertex beyond the range, or inside the part, is known again. */
export const storedColour = stored

/**
 * Colours for every vertex of a scan by its distance to a part's mesh, where the two are drawn (each by its
 * group's place), as a `color` attribute's array: linear light, 0 to 65535, so that what is drawn at a vertex is
 * exactly the colour `deviationColour` gives. A vertex outside the part's box grown by `range` has `far` without
 * being measured. One is inside when the part is a solid and a ray from it along the part's own +Z crosses the
 * part's mesh an odd number of times. Throws, with what to do, when more than `limits.most` vertices are within the
 * grown box, when working them out takes longer than `TIME_LIMIT_MS` (`limits.now` is the clock), and for a part
 * with no mesh to measure to.
 */
export function deviationColours(scan: BuiltScan, part: Pick<BuiltPart, 'group' | 'mesh' | 'solid'>, range: number, colours: { near: Rgb; far: Rgb; inside: Rgb }, limits: { most?: number; now?: () => number } = {}): Uint16Array {
  const most = limits.most ?? MAX_COLOURED
  const now = limits.now ?? (() => performance.now())
  const positions = scan.mesh.geometry.getAttribute('position')
  const out = new Uint16Array(positions.count * 3)
  const far = stored(colours.far)
  for (let v = 0; v < positions.count; v++) out.set(far, 3 * v)
  const geometry = part.mesh.geometry
  const tree = geometry.boundsTree as MeshBVH | undefined
  // With nothing to measure to, every vertex would be drawn as far away, under a caption that says otherwise.
  if (!tree) throw new Error('the part has no mesh to measure to: nothing was coloured')
  // Into the part's own frame, where its tree is. Parts are placed and turned, never scaled: distances there are millimetres.
  scan.group.updateMatrix()
  part.group.updateMatrix()
  const toPart = new THREE.Matrix4().copy(part.group.matrix).invert().multiply(scan.group.matrix)
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const reach = geometry.boundingBox!.clone().expandByScalar(range)
  const near: number[] = []
  const point = new THREE.Vector3()
  for (let v = 0; v < positions.count; v++) {
    if (reach.containsPoint(point.fromBufferAttribute(positions, v).applyMatrix4(toPart))) near.push(v)
  }
  if (near.length > most) throw new Error(`${near.length.toLocaleString('en-US')} points of ${scan.id} are within ${range} mm of the part, more than the ${most.toLocaleString('en-US')} a picture colours: ask for a smaller range`)
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1))
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }
  const started = now()
  for (const [done, v] of near.entries()) {
    if (done > 0 && done % CLOCK_EVERY === 0 && now() - started > TIME_LIMIT_MS) {
      throw new Error(`colouring ${scan.id} by its distance to the part took more than ${TIME_LIMIT_MS / 1000} s (${done.toLocaleString('en-US')} of ${near.length.toLocaleString('en-US')} points done): ask for a smaller range`)
    }
    point.fromBufferAttribute(positions, v).applyMatrix4(toPart)
    const distance = tree.closestPointToPoint(point, target)?.distance ?? Infinity
    let inside = false
    if (part.solid && geometry.boundingBox!.containsPoint(point)) {
      ray.origin.copy(point)
      // A ray through an edge two triangles share meets both in one place: counted once.
      const crossings = tree.raycast(ray, THREE.DoubleSide).map((hit) => hit.distance).sort((a, b) => a - b)
      let count = 0
      crossings.forEach((at, i) => {
        if (i === 0 || at - crossings[i - 1] > 1e-6) count += 1
      })
      inside = count % 2 === 1
    }
    out.set(stored(deviationColour(distance, inside, range, colours)), 3 * v)
  }
  return out
}

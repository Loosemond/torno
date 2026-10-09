import * as THREE from 'three'
import { parseScanMesh, type ScanTransform } from '../../shared/scans'

export interface BuiltScan {
  id: string
  /** Placed by the scan's transform for the layout shown. Add this to the scene. */
  group: THREE.Group
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>
  /** Unlit, in the scan's own colours, a step greyer (`OWN_SATURATION`); null for a scan that has none. */
  own: THREE.MeshBasicMaterial | null
  /** Lit, flat shaded, in `--scan-plain`. */
  plain: THREE.MeshStandardMaterial
  vertices: number
  triangles: number
}

/** What both materials of a scan share: seen from either side, and pushed back so that a part lying in the scan's surface wins the depth test. */
const SURFACE = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 } as const

/** Linear light, 0 to 65535, of each sRGB byte. */
const LINEAR = Uint16Array.from({ length: 256 }, (_, byte) => {
  const c = byte / 255
  return Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 65535)
})

/** sRGB bytes r g b a per vertex as linear r g b per vertex, 0 to 65535: what three.js takes vertex colours to be. */
export function linearColours(rgba: Uint8Array): Uint16Array {
  const count = Math.floor(rgba.length / 4)
  const out = new Uint16Array(count * 3)
  for (let v = 0, from = 0, to = 0; v < count; v++, from += 4, to += 3) {
    out[to] = LINEAR[rgba[from]]
    out[to + 1] = LINEAR[rgba[from + 1]]
    out[to + 2] = LINEAR[rgba[from + 2]]
  }
  return out
}

/**
 * The three.js objects of one scan. The geometry owns copies of the positions
 * and the triangles, in the file's order, so the blob can be released. No
 * bounds tree: `scanBvh.ts` makes it. Throws what `parseScanMesh` does of
 * bytes that are no scan.
 *
 * There are no normals: the plain material is flat shaded, which takes its
 * normal from the surface as it is drawn, and a scan's own colours are unlit.
 */
export function buildScan(id: string, blob: ArrayBuffer): BuiltScan {
  const parsed = parseScanMesh(blob)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(parsed.vertices.slice(), 3))
  geometry.setIndex(new THREE.BufferAttribute(parsed.triangles.slice(), 1))
  if (parsed.colours) geometry.setAttribute('color', new THREE.BufferAttribute(linearColours(parsed.colours), 3, true))
  // Once, here: what is drawn of it and what the camera must reach are read from these.
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const plain = new THREE.MeshStandardMaterial({ ...SURFACE, flatShading: true, roughness: 0.9, metalness: 0 })
  const own = parsed.colours ? fading(new THREE.MeshBasicMaterial({ ...SURFACE, vertexColors: true })) : null
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometry, own ?? plain)
  const group = new THREE.Group()
  group.add(mesh)
  return { id, group, mesh, own, plain, vertices: parsed.vertices.length / 3, triangles: parsed.triangles.length / 3 }
}

/** Stands a scan where its transform says: p' = s · R(q) · p + t. */
export function placeScan(built: BuiltScan, transform: ScanTransform): void {
  built.group.position.fromArray(transform.t)
  built.group.quaternion.fromArray(transform.q)
  built.group.scale.setScalar(transform.s)
  built.group.updateMatrix()
}

export function disposeScan(built: BuiltScan): void {
  built.group.removeFromParent()
  built.mesh.geometry.dispose()
  built.own?.dispose()
  built.plain.dispose()
}

interface Fade { to: { value: THREE.Color }; by: { value: number } }

/**
 * How much of its colourfulness a scan keeps when drawn in its own colours. A
 * scan is the surroundings: a red cable in it is not to be louder than the
 * part, whose colours are the muted ones of the palette.
 */
export const OWN_SATURATION = 0.65

/**
 * Has a material of vertex colours draw them a step greyer, and take them
 * towards one colour by a share, as the parts' colours are taken towards the
 * background while they are stale. `material.color` could only darken them,
 * which on a light background is the wrong way.
 */
function fading(material: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  const fade: Fade = { to: { value: new THREE.Color() }, by: { value: 0 } }
  material.userData.fade = fade
  material.onBeforeCompile = (shader) => {
    shader.uniforms.fadeTo = fade.to
    shader.uniforms.fadeBy = fade.by
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 fadeTo;\nuniform float fadeBy;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, ${OWN_SATURATION.toFixed(2)});
        diffuseColor.rgb = mix(diffuseColor.rgb, fadeTo, fadeBy);`
      )
  }
  return material
}

/** Takes a scan's own colours towards `to` by the share `by`, 0 for as they are. */
export function fadeOwn(built: BuiltScan, to: string, by: number): void {
  const fade = built.own?.userData.fade as Fade | undefined
  if (!fade) return
  fade.to.value.set(to)
  fade.by.value = by
}

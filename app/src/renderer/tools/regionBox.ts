import * as THREE from 'three'
import type { Camera } from '../../shared/view'
import type { ViewportPointer } from '../viewport/Viewport'

// The box of the Region tool: what a rectangle dragged on the screen goes round, and the rectangle itself.

/**
 * The four planes round what a rectangle of the screen shows, between two opposite corners of it, each given
 * as the ray the pointer looks along there: in the frame the rays are in, each plane's normal pointing inwards.
 * Null for corners with no rectangle between them.
 */
export function boxPlanes(camera: Pick<Camera, 'position' | 'target' | 'up' | 'ortho'>, from: ViewportPointer['ray'], to: ViewportPointer['ray']): THREE.Plane[] | null {
  const forward = new THREE.Vector3().fromArray(camera.target).sub(new THREE.Vector3().fromArray(camera.position)).normalize()
  const right = forward.clone().cross(new THREE.Vector3().fromArray(camera.up)).normalize()
  const up = right.clone().cross(forward)
  const [oA, oC] = [new THREE.Vector3().fromArray(from.origin), new THREE.Vector3().fromArray(to.origin)]
  const [dA, dC] = [new THREE.Vector3().fromArray(from.direction), new THREE.Vector3().fromArray(to.direction)]
  let corners: Array<{ origin: THREE.Vector3; direction: THREE.Vector3 }>
  if (camera.ortho) {
    // The rays are parallel: the other two corners are the first moved across, or up.
    const across = oC.clone().sub(oA)
    const [x, y] = [across.dot(right), across.dot(up)]
    if (Math.abs(x) < 1e-9 || Math.abs(y) < 1e-9) return null
    corners = [oA.clone(), oA.clone().addScaledVector(up, y), oC.clone(), oA.clone().addScaledVector(right, x)].map((origin) => ({ origin, direction: dA }))
  } else {
    // The rays leave one point: each corner is a direction, by how far it leans right and up.
    const lean = (d: THREE.Vector3): [number, number] => [d.dot(right) / d.dot(forward), d.dot(up) / d.dot(forward)]
    const [[xA, yA], [xC, yC]] = [lean(dA), lean(dC)]
    if (!(Math.abs(xA - xC) > 1e-12 && Math.abs(yA - yC) > 1e-12)) return null
    corners = [[xA, yA], [xA, yC], [xC, yC], [xC, yA]].map(([x, y]) => ({ origin: oA, direction: forward.clone().addScaledVector(right, x).addScaledVector(up, y).normalize() }))
  }
  const inside = corners.reduce((sum, corner) => sum.add(corner.origin).add(corner.direction), new THREE.Vector3()).multiplyScalar(0.25)
  return corners.map((corner, n) => {
    const next = corners[(n + 1) % 4]
    const normal = corner.direction.clone().cross(next.origin.clone().add(next.direction).sub(corner.origin)).normalize()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, corner.origin)
    return plane.distanceToPoint(inside) < 0 ? plane.negate() : plane
  })
}

/** The rectangle a box is dragged as: a `div` over the canvas, the DOM's own. */
export function boxOutline(canvas: HTMLCanvasElement | undefined): { set(from: [number, number], to: [number, number]): void; remove(): void } {
  const parent = canvas?.parentElement
  if (!parent || typeof document === 'undefined') return { set: () => {}, remove: () => {} }
  const outline = document.createElement('div')
  outline.className = 'region-box'
  parent.append(outline)
  return {
    set(from, to) {
      const rect = parent.getBoundingClientRect()
      outline.style.left = `${Math.min(from[0], to[0]) - rect.left}px`
      outline.style.top = `${Math.min(from[1], to[1]) - rect.top}px`
      outline.style.width = `${Math.abs(to[0] - from[0])}px`
      outline.style.height = `${Math.abs(to[1] - from[1])}px`
    },
    remove: () => outline.remove()
  }
}

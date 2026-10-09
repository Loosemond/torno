import * as THREE from 'three'
import { gridStep } from './views'

/**
 * The grid under some parts, on the lowest z of their box: the ends of its lines, two points a line, and a
 * sphere around the parts and the grid.
 */
export function groundOf(box: { min: number[]; max: number[] }): { points: number[]; extent: THREE.Sphere } {
  const [x0, y0, z] = box.min
  const [x1, y1, z1] = box.max
  const size = Math.max(x1 - x0, y1 - y0) || z1 - z || 10
  const step = gridStep(size)
  const pad = Math.max(size / 2, step * 2)
  const left = Math.floor((x0 - pad) / step) * step
  const right = Math.ceil((x1 + pad) / step) * step
  const near = Math.floor((y0 - pad) / step) * step
  const far = Math.ceil((y1 + pad) / step) * step

  const points: number[] = []
  for (let i = 0, n = Math.round((right - left) / step); i <= n; i++) {
    const x = left + i * step
    points.push(x, near, z, x, far, z)
  }
  for (let i = 0, n = Math.round((far - near) / step); i <= n; i++) {
    const y = near + i * step
    points.push(left, y, z, right, y, z)
  }
  const all = new THREE.Box3(new THREE.Vector3(left, near, z), new THREE.Vector3(right, far, Math.max(z1, z)))
  return { points, extent: all.getBoundingSphere(new THREE.Sphere()) }
}

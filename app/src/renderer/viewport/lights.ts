import * as THREE from 'three'

// The light the parts are drawn in, on screen and in every picture: a sky from +Z, and a key light that rides on
// the camera, so that no side of a part goes black.

/** The two lights of a scene of parts. Add both, and the key light's target, to the scene. */
export function makeLights(): { sky: THREE.HemisphereLight; key: THREE.DirectionalLight } {
  const sky = new THREE.HemisphereLight(0xffffff, 0xc8c4bc, 1.5)
  sky.position.set(0, 0, 1)
  return { sky, key: new THREE.DirectionalLight(0xffffff, 2.1) }
}

/** Aims the key light at what a camera looks at: from behind the viewer, above and to the left. */
export function aimKeyLight(key: THREE.DirectionalLight, camera: THREE.Camera, target: THREE.Vector3): void {
  camera.updateMatrixWorld()
  const m = camera.matrixWorld.elements
  key.position.set(target.x + m[8] + 0.55 * m[4] - 0.4 * m[0], target.y + m[9] + 0.55 * m[5] - 0.4 * m[1], target.z + m[10] + 0.55 * m[6] - 0.4 * m[2])
  key.target.position.copy(target)
  key.target.updateMatrixWorld()
}

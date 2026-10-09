import type * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

const inWorker = (): Worker => new Worker(new URL('./scanBvh.worker.ts', import.meta.url), { type: 'module' })

/** What the worker answers with: the tree's buffers (`MeshBVH.serialize`, less the triangles), or why it made none. */
interface Answer { version?: number; roots?: ArrayBuffer[]; indirectBuffer?: Uint32Array; error?: string }

/**
 * A bounds tree for a scan's geometry: indirect, so the triangles keep the file's order. Built in a worker
 * where one can be made (it is given copies of the positions and the triangles, so the scan is drawn
 * meanwhile), in place where none can (vitest) or when the worker fails. `how` says which. The worker is let
 * go of with its answer, and the copies with it. Rejects for a geometry no tree can be made of.
 */
export function buildScanBvh(
  geometry: THREE.BufferGeometry,
  makeWorker: (() => Worker) | null = typeof Worker === 'undefined' ? null : inWorker
): Promise<{ tree: MeshBVH; how: 'worker' | 'main' }> {
  const here = (): { tree: MeshBVH; how: 'main' } => ({ tree: new MeshBVH(geometry, { indirect: true }), how: 'main' })
  if (!makeWorker) return Promise.resolve().then(here)
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    let answered = false
    const done = (make: () => { tree: MeshBVH; how: 'worker' | 'main' }): void => {
      if (answered) return
      answered = true
      worker?.terminate()
      try {
        resolve(make())
      } catch (e) {
        reject(e)
      }
    }
    try {
      worker = makeWorker()
      // A worker that cannot be started, or fails, is no reason for a scan that cannot be pointed at.
      worker.onerror = () => done(here)
      worker.onmessage = ({ data }: MessageEvent<Answer>) => {
        const { version, roots, indirectBuffer } = data
        if (!roots || !indirectBuffer) return done(here)
        // The triangles are the geometry's own, untouched: the tree looks them up through its indirect buffer.
        done(() => ({ tree: MeshBVH.deserialize({ version, roots, index: null, indirectBuffer } as never, geometry, { setIndex: false }), how: 'worker' }))
      }
      const position = (geometry.getAttribute('position').array as Float32Array).slice()
      const index = (geometry.index!.array as Uint32Array).slice()
      worker.postMessage({ position, index }, [position.buffer, index.buffer])
    } catch {
      done(here)
    }
  })
}

import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { grid, meshBin } from '../../test/scanFixtures'
import { buildScanBvh } from './scanBvh'
import { buildScan } from './scanMesh'

const sheet = (): THREE.BufferGeometry => buildScan('S1', meshBin(grid(20, 1, (x, y) => 0.1 * x * y))).mesh.geometry
const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))

interface Posted { message: { position: Float32Array; index: Uint32Array }; transfer: Transferable[] }

/** A worker as the window has them, played here: `answer` is what the code in it would do with what it was sent. */
function played(answer: (posted: Posted, worker: Worker) => void): { make: () => Worker; posted: Posted[]; terminated: number } {
  const seen = {
    posted: [] as Posted[],
    terminated: 0,
    make: (): Worker => {
      const worker = {
        onmessage: null,
        onerror: null,
        terminate: () => void (seen.terminated += 1),
        postMessage: (message: Posted['message'], transfer: Transferable[]) => {
          const posted = { message, transfer }
          seen.posted.push(posted)
          queueMicrotask(() => answer(posted, worker as unknown as Worker))
        }
      }
      return worker as unknown as Worker
    }
  }
  return seen
}

/** What `scanBvh.worker.ts` does with what it is sent. */
function built({ message }: Posted): unknown {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(message.position, 3))
  geometry.setIndex(new THREE.BufferAttribute(message.index, 1))
  const made = MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false })
  return { version: (made as { version?: number }).version, roots: made.roots, indirectBuffer: made.indirectBuffer }
}

describe('buildScanBvh', () => {
  it('builds in place where no worker can be made, leaving the triangles in the order of the file', async () => {
    const geometry = sheet()
    const index = (geometry.index!.array as Uint32Array).slice()
    const { tree, how } = await buildScanBvh(geometry, null)
    expect(how).toBe('main')
    expect(geometry.index!.array).toEqual(index)
    const hit = tree.raycastFirst(down(0.25, 0.1), THREE.DoubleSide)!
    // Row 9, column 9 of the 19 × 19 cells, two triangles each: the first of the cell holds (0.25, 0.1).
    expect(hit.faceIndex).toBe((9 * 19 + 9) * 2)
  })

  it('has a worker make the tree from copies, takes its buffers, and lets the worker go', async () => {
    const geometry = sheet()
    const position = geometry.getAttribute('position').array
    const index = geometry.index!.array
    const worker = played((posted, w) => w.onmessage!({ data: built(posted) } as MessageEvent))
    const { tree, how } = await buildScanBvh(geometry, worker.make)
    expect(how).toBe('worker')
    expect(worker.terminated).toBe(1)
    // Copies were sent, and handed over rather than copied again; the geometry kept its own.
    const [{ message, transfer }] = worker.posted
    expect(message.position).not.toBe(position)
    expect(message.position).toEqual(position)
    expect(message.index).toEqual(index)
    expect(transfer).toEqual([message.position.buffer, message.index.buffer])
    expect(geometry.getAttribute('position').array).toBe(position)
    expect(geometry.index!.array).toBe(index)
    // The tree answers as one built here does.
    const here = new MeshBVH(sheet(), { indirect: true })
    for (const [x, y] of [[0.25, 0.1], [-7.3, 4.2], [8.9, -8.9], [40, 0]]) {
      const [a, b] = [tree.raycastFirst(down(x, y), THREE.DoubleSide), here.raycastFirst(down(x, y), THREE.DoubleSide)]
      expect(a?.faceIndex).toBe(b?.faceIndex)
      expect(a?.point.toArray()).toEqual(b?.point.toArray())
    }
  })

  it('builds in place when the worker fails, says an error or cannot be started', async () => {
    const failing = played((_posted, w) => w.onerror!(new Event('error') as ErrorEvent))
    expect((await buildScanBvh(sheet(), failing.make)).how).toBe('main')
    expect(failing.terminated).toBe(1)
    const refusing = played((_posted, w) => w.onmessage!({ data: { error: 'out of memory' } } as MessageEvent))
    expect((await buildScanBvh(sheet(), refusing.make)).how).toBe('main')
    expect(refusing.terminated).toBe(1)
    const none = await buildScanBvh(sheet(), () => {
      throw new Error('no workers here')
    })
    expect(none.how).toBe('main')
    expect(none.tree.raycastFirst(down(0.25, 0.1), THREE.DoubleSide)).not.toBeNull()
  })

  it('rejects, rather than never answer, of a mesh no tree can be made of', async () => {
    const empty = new THREE.BufferGeometry()
    await expect(buildScanBvh(empty, null)).rejects.toThrow()
    const failing = played((_posted, w) => w.onerror!(new Event('error') as ErrorEvent))
    await expect(buildScanBvh(empty, failing.make)).rejects.toThrow()
  })
})

import { BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

// Builds the bounds tree of one scan off the window's thread. It is given copies of the positions
// and the triangles, and sends back the tree's own buffers: the scan is drawn meanwhile. The copies
// go when the window lets this worker go, which it does on the answer.
self.onmessage = ({ data }: MessageEvent<{ position: Float32Array; index: Uint32Array }>) => {
  try {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.position, 3))
    geometry.setIndex(new BufferAttribute(data.index, 1))
    // The tree's buffers as they are: they are handed over, not copied, and the triangles are not sent back.
    const made = MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false })
    const send = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }
    send.postMessage({ version: (made as { version?: number }).version, roots: made.roots, indirectBuffer: made.indirectBuffer }, [...made.roots, made.indirectBuffer!.buffer])
  } catch (e) {
    ;(self as unknown as { postMessage(message: unknown): void }).postMessage({ error: e instanceof Error ? e.message : String(e) })
  }
}

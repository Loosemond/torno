import type { ScanInfo } from '../../shared/scans'
import { meshOf } from '../viewport/scans'

/**
 * Which meshes of an object's scans the window has asked main for, so that each is asked for once: by the scan
 * and by what its record says of its mesh (converted or read again, it is another, and is asked for again).
 *
 * - A scan main says has no mesh is not asked for, and what was asked of it is forgotten: when its mesh is
 *   back, unchanged, it is fetched and drawn again.
 * - A fetch that failed is not tried again at every change of the view: only once main has told of the scans
 *   anew (`told`), which it does when a file is found gone or back.
 */
export class MeshAsks {
  private readonly asked = new Set<string>()
  private readonly failed = new Set<string>()

  /** What a scan's mesh is asked for by. */
  key(scan: ScanInfo): string {
    return `${scan.id} ${meshOf(scan)}`
  }

  /** Whether the mesh of a scan the viewport wants is to be asked of main now; it then counts as asked. */
  due(scan: ScanInfo): boolean {
    const key = this.key(scan)
    if (scan.meshState !== 'ok') {
      this.asked.delete(key)
      return false
    }
    if (this.asked.has(key) || this.failed.has(key)) return false
    this.asked.add(key)
    return true
  }

  /** The fetch of a scan's mesh failed. */
  fail(scan: ScanInfo): void {
    const key = this.key(scan)
    this.asked.delete(key)
    this.failed.add(key)
  }

  /** Main told of the scans anew: a fetch that failed may be tried again. */
  told(): void {
    this.failed.clear()
  }

  /** Another object: nothing was asked of its scans. */
  clear(): void {
    this.asked.clear()
    this.failed.clear()
  }
}

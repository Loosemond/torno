import { SCAN_FORMATS } from '../../shared/scans'
import { actions, store } from '../state/store'

/** Said at the pointer when what was dropped on the view holds no scan. */
export const NOT_A_SCAN = 'torno reads .glb, .gltf, .obj, .ply and .stl scans'

/** Of the files dropped, the first torno reads as a scan: its index, or -1. */
export function droppedScan(files: ArrayLike<{ name: string }>): number {
  for (let n = 0; n < files.length; n++) {
    const name = files[n].name.toLowerCase()
    if (SCAN_FORMATS.some((ending) => name.endsWith(ending))) return n
  }
  return -1
}

/**
 * Has main import a file into an object as a scan. Why it came to nothing is
 * for the Scans panel to say, while that object is still the open one.
 */
export function importScan(objectId: string, path: string): void {
  actions.setScansRefused(null)
  window.torno.scans.import(objectId, path).catch((e: unknown) => {
    if (store.getState().objectId === objectId) actions.setScansRefused(e instanceof Error ? e.message : String(e))
  })
}

/** Said at the pointer of a dropped file the system gives no path for. */
export const NO_PATH = 'That file has no place on the disk'

import type { Mark } from '../../shared/marks'
import { maskBits } from '../../shared/scans'
import { store, type TornoState } from '../state/store'
import type { KeptRegion } from '../viewport/scanTints'
import { meshOf } from '../viewport/scans'
import type { Viewport } from '../viewport/Viewport'

// The regions kept, as the window draws them: each a tint on its scan, from the bits of its mask.

/** The regions to tint: those of the object on show that are open and still of their scan's mesh, each with the bits of its mask once main has given them. */
function regionsOf(s: TornoState): Array<{ mark: Extract<Mark, { kind: 'region' }>; key: string; triangles: number }> {
  const wanted: ReturnType<typeof regionsOf> = []
  for (const mark of s.marks) {
    if (mark.kind !== 'region' || mark.status === 'resolved' || mark.anchorState === 'orphaned') continue
    const scan = s.scans.find((one) => one.id === mark.scan)
    // By the mesh its scan has: read again, the scan has another, and the mark says so once main has looked.
    if (scan && scan.meshState === 'ok') wanted.push({ mark, key: `${s.objectId} ${mark.id} ${meshOf(scan)}`, triangles: scan.imported.triangles })
  }
  return wanted
}

/**
 * Has a viewport tint the regions kept on their scans: each from the bits of its mask, asked of main once,
 * when the mark first appears (and again for another mesh of its scan). A mask that is gone, or is of another
 * mesh, tints nothing: main says of the mark that it is orphaned. Returns what undoes it.
 */
export function tintRegions(viewport: Pick<Viewport, 'setRegions'>): () => void {
  /** By mark and mesh: the bits main gave, or that they were asked for (null), or that they are no region of that mesh (false). */
  const bits = new Map<string, Uint8Array | null | false>()
  let told: KeptRegion[] = []
  const tell = (s: TornoState): void => {
    const wanted = regionsOf(s)
    const now: KeptRegion[] = []
    for (const { mark, key, triangles } of wanted) {
      const have = bits.get(key)
      if (have) now.push({ id: mark.id, scan: mark.scan, layout: mark.layout, author: mark.author, bits: have })
      if (have !== undefined || !s.objectId) continue
      bits.set(key, null)
      window.torno.scans.mask(s.objectId, mark.scan, mark.id).then(
        (file) => {
          try {
            bits.set(key, maskBits(new Uint8Array(file), triangles).slice())
          } catch {
            bits.set(key, false)
          }
          tell(store.getState())
        },
        // Gone from the disk: main says so of the mark when it next looks. Not asked again for this mesh.
        () => void bits.set(key, false)
      )
    }
    for (const key of bits.keys()) if (!wanted.some((one) => one.key === key)) bits.delete(key)
    if (now.length === told.length && now.every((region, n) => region.id === told[n].id && region.bits === told[n].bits && region.layout === told[n].layout && region.author === told[n].author)) return
    told = now
    viewport.setRegions(now)
  }
  tell(store.getState())
  const off = store.subscribe((s, prev) => {
    if (s.marks !== prev.marks || s.scans !== prev.scans || s.objectId !== prev.objectId) tell(s)
  })
  return () => {
    off()
    viewport.setRegions([])
  }
}

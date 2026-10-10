import type { Scene } from '../../shared/scene'
import type { Viewport } from '../viewport/Viewport'
import { store } from './store'

// The pictures on the cards of the page of objects are made here, and only here: when a build of an object
// opened in this run lands, the window draws it small and off screen, and hands main the PNG to keep. No object
// is opened for a picture and no build is ever started for one: an object not built in this run keeps the
// picture it has on file, or has none.

type Landed = { objectId: string; revision: number; scene: Scene; blob: ArrayBuffer }

const idle = (run: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: 2000 })
  else setTimeout(run, 0)
}

/**
 * Has a thumbnail made of every build main tells the window of (`object.onScene`: each build of each object
 * opened in this run, with its meshes, whether or not it is the one on show), one at a time, when the window
 * has nothing else to do. Of an object only its latest build is drawn; one sent again as it was is passed over.
 * It is drawn as the object was last looked at, as its scene file has it (a read). Returns what undoes it.
 */
export function connectThumbs(viewport: Pick<Viewport, 'thumbnail'>): () => void {
  const waiting = new Map<string, Landed>()
  const made = new Map<string, number>()
  let busy = false
  let live = true

  const next = async (): Promise<void> => {
    const [objectId, landed] = waiting.entries().next().value ?? []
    if (!live || objectId === undefined || landed === undefined) {
      busy = false
      return
    }
    waiting.delete(objectId)
    try {
      const root = store.getState().workspace?.root
      const view = await window.torno.object.loadSceneFile(objectId).catch(() => undefined)
      // The workspace was left meanwhile: its objects' names mean nothing in the next one.
      if (live && store.getState().workspace?.root === root) {
        const picture = await viewport.thumbnail(landed.scene, landed.blob, view)
        if (picture && live) {
          const { png, ...of } = picture
          window.torno.show.saveThumbnail(objectId, landed.revision, png, of)
          made.set(objectId, landed.revision)
        }
      }
    } catch (e) {
      // A card without its picture says so; nothing else depends on one.
      console.error(`no picture of ${objectId} was made: ${e instanceof Error ? e.message : String(e)}`)
    }
    idle(() => void next())
  }

  const offScene = window.torno.object.onScene((m) => {
    if (made.get(m.objectId) === m.revision) return
    waiting.set(m.objectId, m)
    if (busy) return
    busy = true
    idle(() => void next())
  })
  // Revisions count from 1 in every workspace, and ids repeat between them.
  const offStore = store.subscribe((s, prev) => {
    if (s.workspace?.root === prev.workspace?.root) return
    waiting.clear()
    made.clear()
  })
  return () => {
    live = false
    waiting.clear()
    offScene()
    offStore()
  }
}

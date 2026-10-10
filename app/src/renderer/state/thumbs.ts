import type { Scene } from '../../shared/scene'
import type { ThumbnailOf } from '../../shared/show'
import type { ThumbnailView } from '../../shared/thumbnail'
import type { Viewport } from '../viewport/Viewport'
import { store } from './store'

// The pictures on the cards of the page of objects are made here, and only here: when a build of an object
// opened in this run lands, the window draws it small and off screen, and hands main the PNG to keep. No object
// is opened for a picture and no build is ever started for one: an object not built in this run keeps the
// picture it has on file, or has none.

/** A build as main tells the window of it (`object.onScene`). */
export type Landed = { objectId: string; revision: number; scene: Scene; blob: ArrayBuffer }

/** What the thumbnailer asks of the window around it. */
export interface ThumbDeps {
  /** How an object was last looked at: its scene file, as main has it (a read). */
  loadSceneFile(objectId: string): Promise<ThumbnailView | undefined>
  /** Hands main the picture of a build. */
  save(objectId: string, revision: number, png: Uint8Array, of: ThumbnailOf): void
  /** Runs something when the window has nothing else to do. */
  idle(run: () => void): void
  /** The workspace that is open. */
  root(): string | undefined
}

const ofTheWindow = (): ThumbDeps => ({
  loadSceneFile: (objectId) => window.torno.object.loadSceneFile(objectId),
  save: (objectId, revision, png, of) => window.torno.show.saveThumbnail(objectId, revision, png, of),
  idle: (run) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: 2000 })
    else setTimeout(run, 0)
  },
  root: () => store.getState().workspace?.root
})

/**
 * Has a thumbnail made of every build it is told of (`landed`), one at a time, when the window has nothing else
 * to do. It subscribes to nothing: whoever hears of the builds (the viewport's own handler of `object.onScene`,
 * which carries each build of each object opened in this run, on show or not) hands the message on, so the
 * meshes cross from main once, not once for the view and once more for the picture. Of an object only its
 * latest build is drawn, and one sent again as it was is passed over; a build is held only until its picture is
 * drawn. It is drawn as the object was last looked at, as its scene file has it. `stop` ends it.
 */
export function connectThumbs(viewport: Pick<Viewport, 'thumbnail'>, deps: ThumbDeps = ofTheWindow()): { landed(m: Landed): void; stop(): void; /** How many builds wait for their picture. */ waiting(): number } {
  const waiting = new Map<string, Landed>()
  const made = new Map<string, number>()
  let root = deps.root()
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
      const of = deps.root()
      const view = await deps.loadSceneFile(objectId).catch(() => undefined)
      // The workspace was left meanwhile: its objects' names mean nothing in the next one.
      if (live && deps.root() === of) {
        const picture = await viewport.thumbnail(landed.scene, landed.blob, view)
        if (picture && live && deps.root() === of) {
          const { png, ...what } = picture
          deps.save(objectId, landed.revision, png, what)
          made.set(objectId, landed.revision)
        }
      }
    } catch (e) {
      // A card without its picture says so; nothing else depends on one.
      console.error(`no picture of ${objectId} was made: ${e instanceof Error ? e.message : String(e)}`)
    }
    deps.idle(() => void next())
  }

  return {
    landed(m) {
      if (!live) return
      // Revisions count from 1 in every workspace, and ids repeat between them.
      if (deps.root() !== root) {
        root = deps.root()
        waiting.clear()
        made.clear()
      }
      if (made.get(m.objectId) === m.revision || waiting.get(m.objectId)?.revision === m.revision) return
      waiting.set(m.objectId, m)
      if (busy) return
      busy = true
      deps.idle(() => void next())
    },
    stop() {
      live = false
      waiting.clear()
    },
    waiting: () => waiting.size
  }
}

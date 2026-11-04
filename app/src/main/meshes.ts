import type { Scene } from '../shared/scene'

// The meshes of the builds of this run, kept in memory for "see an earlier build over the current" (#56): a ghost of
// a kept build is drawn from them. Never written to disk. Within a budget of bytes for all the objects: the oldest
// build is let go first, and the newest build of an object is never let go (it is the one on show). A build older than
// what the budget holds has no ghost, and the history says so.

/** The most bytes of meshes kept, for every object together (the newest build of each object not counted against it). */
export const MESH_BUDGET_BYTES = 64 * 1024 * 1024

export interface HeldMesh {
  scene: Scene
  blob: Buffer
}

export class RecentMeshes {
  /** In the order they were kept. */
  private readonly held: Array<{ objectId: string; revision: number; mesh: HeldMesh }> = []

  constructor(private readonly budget: number = MESH_BUDGET_BYTES) {}

  /** Keeps the build that landed, and lets go of the oldest while the budget is passed. */
  keep(objectId: string, revision: number, mesh: HeldMesh): void {
    const at = this.held.findIndex((h) => h.objectId === objectId && h.revision === revision)
    if (at >= 0) this.held.splice(at, 1)
    this.held.push({ objectId, revision, mesh })
    // The newest of each object stays whatever it weighs: the others are counted against the budget.
    const newest = (h: { objectId: string; revision: number }): boolean => !this.held.some((o) => o.objectId === h.objectId && o.revision > h.revision)
    let total = this.held.filter((h) => !newest(h)).reduce((sum, h) => sum + h.mesh.blob.length, 0)
    for (const h of [...this.held]) {
      if (total <= this.budget) break
      if (newest(h)) continue
      this.held.splice(this.held.indexOf(h), 1)
      total -= h.mesh.blob.length
    }
  }

  /** The mesh of a build of this run, or undefined when it was let go. */
  get(objectId: string, revision: number): HeldMesh | undefined {
    return this.held.find((h) => h.objectId === objectId && h.revision === revision)?.mesh
  }

  /** The revisions of an object that have a mesh. */
  revisions(objectId: string): number[] {
    return this.held.filter((h) => h.objectId === objectId).map((h) => h.revision)
  }

  /** An object was closed. */
  forget(objectId: string): void {
    for (let i = this.held.length - 1; i >= 0; i--) if (this.held[i].objectId === objectId) this.held.splice(i, 1)
  }

  /** Bytes held, for a test. */
  get bytes(): number {
    return this.held.reduce((sum, h) => sum + h.mesh.blob.length, 0)
  }
}

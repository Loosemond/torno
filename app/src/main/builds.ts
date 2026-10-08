import { dirname, join, relative, sep } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { BuildError, BuildState } from '../shared/build'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import type { KernelClient } from './kernel/client'

const DEBOUNCE_MS = 300
const IGNORED_FOLDERS = new Set(['out', '.torno', '__pycache__'])

/**
 * Watch a folder and call `onChange` once per burst of changes, 300 ms after
 * the last one. Ignores `out/`, `.torno/`, `__pycache__/` and dotfiles. The
 * folder need not exist yet. Returns a function that stops the watch.
 */
export function watchFolder(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  const watcher = chokidarWatch(dir, {
    ignoreInitial: true,
    ignored: (path) =>
      relative(dir, path)
        .split(sep)
        .some((part) => IGNORED_FOLDERS.has(part) || (part.startsWith('.') && part !== '..'))
  })
  watcher.on('all', () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, DEBOUNCE_MS)
  })
  // A watch that fails (the folder became unreadable) just reports nothing more.
  watcher.on('error', () => {})
  return () => {
    clearTimeout(timer)
    void watcher.close()
  }
}

type SceneMessage = { objectId: string; revision: number; scene: Scene; blob: Buffer }
type LastGood = { revision: number; scene: Scene; blob: Buffer }

interface Entry {
  obj: ObjectInfo
  state: BuildState
  lastGood?: LastGood
  attempt: number // counts builds started; a result for an older attempt is dropped
  startedAt: number
  unwatch: Array<() => void>
}

/**
 * Build state of the open objects. Each is built when opened and again when
 * its folder, or the workspace's `common/`, changes.
 *
 * The kernel runs one build at a time: starting one cancels the one running.
 * For the same object that is what a save mid-build wants. A build displaced by
 * another object's is started again once the kernel is free.
 */
export class Builds {
  private readonly kernel: KernelClient
  private readonly watch: (dir: string, onChange: () => void) => () => void
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly buildListeners: Array<(s: BuildState) => void> = []
  private readonly sceneListeners: Array<(m: SceneMessage) => void> = []
  private running: string | null = null // the object the kernel is building
  private readonly displaced = new Set<string>()

  constructor(deps: {
    kernel: KernelClient
    watch: (dir: string, onChange: () => void) => () => void
    now?: () => number
  }) {
    this.kernel = deps.kernel
    this.watch = deps.watch
    this.now = deps.now ?? Date.now
    this.kernel.onExit(() => this.kernelStopped())
  }

  /**
   * Start watching and building an object. For one that is already open this
   * returns its state, building again only if its model has changed.
   */
  open(obj: ObjectInfo): BuildState {
    let entry = this.entries.get(obj.id)
    if (entry) {
      if (entry.obj.model === obj.model && entry.obj.problem === obj.problem) return entry.state
      entry.obj = obj
    } else {
      entry = {
        obj,
        state: { objectId: obj.id, status: 'idle', revision: 0, stale: false },
        attempt: 0,
        startedAt: 0,
        unwatch: []
      }
      this.entries.set(obj.id, entry)
      const rebuild = () => this.rebuild(obj.id)
      entry.unwatch.push(this.watch(obj.dir, rebuild), this.watch(join(dirname(obj.dir), 'common'), rebuild))
    }
    this.start(entry)
    return entry.state
  }

  rebuild(objectId: string): void {
    const entry = this.entries.get(objectId)
    if (entry) this.start(entry)
  }

  close(objectId: string): void {
    const entry = this.entries.get(objectId)
    if (!entry) return
    this.entries.delete(objectId)
    this.displaced.delete(objectId)
    for (const unwatch of entry.unwatch) unwatch()
    this.abandon(objectId)
  }

  state(objectId: string): BuildState | undefined {
    return this.entries.get(objectId)?.state
  }

  /** The last successful build, whatever has happened since. */
  scene(objectId: string): LastGood | undefined {
    return this.entries.get(objectId)?.lastGood
  }

  on(event: 'build', cb: (s: BuildState) => void): void
  on(event: 'scene', cb: (m: SceneMessage) => void): void
  on(event: 'build' | 'scene', cb: ((s: BuildState) => void) | ((m: SceneMessage) => void)): void {
    if (event === 'build') this.buildListeners.push(cb as (s: BuildState) => void)
    else this.sceneListeners.push(cb as (m: SceneMessage) => void)
  }

  private start(entry: Entry): void {
    const { obj } = entry
    const id = obj.id
    const attempt = ++entry.attempt
    const revision = entry.state.revision
    this.displaced.delete(id)

    if (obj.model === null) {
      const message = obj.problem ?? `no model file in ${obj.dir}`
      this.set(entry, { objectId: id, status: 'failed', revision, error: { kind: 'no_model', message }, stale: revision > 0 })
      this.abandon(id)
      return
    }

    entry.startedAt = this.now()
    this.set(entry, { objectId: id, status: 'building', revision, startedAt: entry.startedAt, stale: revision > 0 })
    this.running = id
    void this.kernel.build(obj.dir, obj.model).then((result) => {
      const current = this.entries.get(id) === entry && entry.attempt === attempt
      if (current && this.running === id) this.running = null
      if (current) {
        if (result.ok) this.succeeded(entry, result.scene, result.blob)
        else if (result.error.kind === 'cancelled') this.displaced.add(id) // by another object's build
        else this.failed(entry, result.error)
      }
      // Otherwise a newer build of this object replaced this one, or the object
      // was closed: whatever the result says, it is not shown.
      this.startDisplaced()
    })
  }

  private succeeded(entry: Entry, scene: Scene, blob: Buffer): void {
    const id = entry.obj.id
    const revision = entry.state.revision + 1
    entry.lastGood = { revision, scene, blob }
    this.set(entry, { objectId: id, status: 'ok', revision, seconds: scene.seconds, stale: false })
    for (const cb of this.sceneListeners) cb({ objectId: id, revision, scene, blob })
  }

  private failed(entry: Entry, error: BuildError): void {
    const revision = entry.state.revision
    const seconds = (this.now() - entry.startedAt) / 1000
    this.set(entry, { objectId: entry.obj.id, status: 'failed', revision, seconds, error, stale: revision > 0 })
  }

  private set(entry: Entry, state: BuildState): void {
    entry.state = state
    for (const cb of this.buildListeners) cb(state)
  }

  /** Stop the kernel's build if it is this object's, and let a displaced one run. */
  private abandon(objectId: string): void {
    if (this.running !== objectId) return
    this.running = null
    this.kernel.cancel()
    this.startDisplaced()
  }

  private startDisplaced(): void {
    if (this.running !== null) return
    for (const id of this.displaced) {
      this.displaced.delete(id)
      const entry = this.entries.get(id)
      if (entry) {
        this.start(entry)
        return
      }
    }
  }

  /** The kernel is gone and was not restarted. A later rebuild asks it to start again. */
  private kernelStopped(): void {
    this.running = null
    this.displaced.clear()
    const tail = this.kernel.stderrTail()
    for (const entry of this.entries.values()) {
      entry.attempt += 1 // nothing still on its way is shown
      const revision = entry.state.revision
      const error: BuildError = { kind: 'crash', message: 'kernel stopped', output: tail }
      this.set(entry, { objectId: entry.obj.id, status: 'failed', revision, error, stale: revision > 0 })
    }
  }
}

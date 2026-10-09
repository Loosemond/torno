import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { BuildError, BuildState } from '../shared/build'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { type KernelClient, KernelError } from './kernel/client'

const DEBOUNCE_MS = 300
// torno's own folder, and where models and tools keep what they make: exports,
// caches, environments. A model may write there while it builds.
const IGNORED_FOLDERS = new Set(['out', '.torno', '__pycache__', 'cache', 'build', 'dist', 'node_modules', '.venv', '.git'])

/** Told the files that changed in a burst, as absolute paths. */
export type OnChange = (paths: string[]) => void

/**
 * Watch a folder and call `onChange` once per burst of changes, 300 ms after
 * the last one, with the paths that changed. Ignores dotfiles and the folders
 * named `out`, `.torno`, `__pycache__`, `cache`, `build`, `dist`,
 * `node_modules`, `.venv` and `.git`, at any depth. The folder need not exist
 * yet. Returns a function that stops the watch.
 */
export function watchFolder(dir: string, onChange: OnChange): () => void {
  let timer: NodeJS.Timeout | undefined
  let changed = new Set<string>()
  const watcher = chokidarWatch(dir, {
    ignoreInitial: true,
    ignored: (path) =>
      relative(dir, path)
        .split(sep)
        .some((part) => IGNORED_FOLDERS.has(part) || (part.startsWith('.') && part !== '..'))
  })
  watcher.on('all', (_event, path) => {
    changed.add(path)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const paths = [...changed]
      changed = new Set()
      onChange(paths)
    }, DEBOUNCE_MS)
  })
  // A watch that fails (the folder became unreadable) just reports nothing more.
  watcher.on('error', () => {})
  return () => {
    clearTimeout(timer)
    void watcher.close()
  }
}

/**
 * The build timeout the person asked for in TORNO_BUILD_TIMEOUT, in seconds.
 * Undefined when it is unset or not a positive number: the kernel's default
 * then holds.
 */
export function buildTimeout(env: Record<string, string | undefined>): number | undefined {
  const text = env.TORNO_BUILD_TIMEOUT?.trim()
  if (!text) return undefined
  const seconds = Number(text)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

type SceneMessage = { objectId: string; revision: number; scene: Scene; blob: Buffer }
type LastGood = { revision: number; scene: Scene; blob: Buffer }

interface Entry {
  obj: ObjectInfo
  state: BuildState
  lastGood?: LastGood
  attempt: number // counts builds started; a result for an older attempt is dropped
  startedAt: number
  /** Something other than Python changed while it was building: build once more when that build ends. */
  changedMeanwhile: boolean
  unwatch: Array<() => void>
  /** Queries waiting for the next build to end, because the kernel no longer holds the last one (see `query`). */
  rebuilt?: { promise: Promise<void>; resolve: () => void; reject: (e: KernelError) => void }
}

/**
 * Build state of the open objects. Each is built when opened and again when
 * its folder, or the workspace's `common/`, changes.
 *
 * The kernel runs one build at a time: starting one cancels the one running.
 * For the same object that is what a save of its Python mid-build wants. Any
 * other file changing mid-build may be the model's own doing (a cache, an
 * export), so that build is left to finish and one more follows it. A build
 * displaced by another object's is started again once the kernel is free, the
 * object shown in the window first.
 */
export class Builds {
  private readonly kernel: KernelClient
  private readonly watch: (dir: string, onChange: OnChange) => () => void
  private readonly now: () => number
  private readonly exists: (path: string) => boolean
  private readonly timeout: number | undefined
  private readonly entries = new Map<string, Entry>()
  private readonly buildListeners: Array<(s: BuildState) => void> = []
  private readonly sceneListeners: Array<(m: SceneMessage) => void> = []
  private running: string | null = null // the object the kernel is building
  private readonly displaced = new Set<string>()
  private shown: string | null = null

  constructor(deps: {
    kernel: KernelClient
    watch: (dir: string, onChange: OnChange) => () => void
    now?: () => number
    exists?: (path: string) => boolean
    /** Seconds a build may take; the kernel's default when left out. */
    timeout?: number
  }) {
    this.kernel = deps.kernel
    this.watch = deps.watch
    this.now = deps.now ?? Date.now
    this.exists = deps.exists ?? existsSync
    this.timeout = deps.timeout
    this.kernel.onExit(() => this.kernelStopped())
  }

  /** The object the window shows from now on: of those waiting for the kernel, it is built first. */
  show(objectId: string | null): void {
    this.shown = objectId
  }

  /**
   * Start watching and building an object. For one that is already open this
   * returns its state, building again only if its model has changed.
   */
  open(obj: ObjectInfo): BuildState {
    let entry = this.entries.get(obj.id)
    if (entry) {
      this.update(obj)
      return entry.state
    } else {
      entry = {
        obj,
        state: { objectId: obj.id, status: 'idle', revision: 0, stale: false },
        attempt: 0,
        startedAt: 0,
        changedMeanwhile: false,
        unwatch: []
      }
      this.entries.set(obj.id, entry)
      const changed: OnChange = (paths) => this.changed(obj.id, paths)
      entry.unwatch.push(this.watch(obj.dir, changed), this.watch(join(dirname(obj.dir), 'common'), changed))
    }
    this.start(entry)
    return entry.state
  }

  /**
   * An object as it is built here, given what a fresh scan says of it. While
   * the model file held for an open object still exists, it stays the model,
   * whatever else has appeared in the folder: a scratch script beside it does
   * not make the object ambiguous. Otherwise the scan's choice stands.
   */
  choice(scanned: ObjectInfo): ObjectInfo {
    const held = this.entries.get(scanned.id)?.obj
    if (!held || held.model === null || held.model === scanned.model) return scanned
    return this.exists(join(held.dir, held.model)) ? held : scanned
  }

  /**
   * Take a fresh scan of an open object. If its model is now another than the
   * one held here (see `choice`), build with the new one and return true.
   */
  update(scanned: ObjectInfo): boolean {
    const entry = this.entries.get(scanned.id)
    const obj = this.choice(scanned)
    if (!entry || (entry.obj.model === obj.model && entry.obj.problem === obj.problem)) return false
    entry.obj = obj
    this.start(entry)
    return true
  }

  /**
   * Files of an open object, or of `common/`, changed. A build under way is
   * started again only for Python; anything else waits for it to end.
   */
  changed(objectId: string, paths: string[] = []): void {
    const entry = this.entries.get(objectId)
    if (!entry) return
    const building = entry.state.status === 'building'
    if (building && paths.length > 0 && !paths.some((path) => path.endsWith('.py'))) entry.changedMeanwhile = true
    else this.start(entry)
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
    this.settleRebuilt(entry, new KernelError('no_build', `${objectId} was closed, so there is nothing to ask about`))
    this.abandon(objectId)
  }

  state(objectId: string): BuildState | undefined {
    return this.entries.get(objectId)?.state
  }

  /** The last successful build, whatever has happened since. */
  scene(objectId: string): LastGood | undefined {
    return this.entries.get(objectId)?.lastGood
  }

  /**
   * Ask the kernel about the last successful build of an open object. Rejects
   * with a KernelError: `no_build` when the object has not been built
   * successfully yet (or is not open), or whatever kind the kernel answers with.
   *
   * The kernel keeps the builds of a few objects only, and none across a
   * restart. When it no longer holds this one, the object is built again and
   * the kernel asked once more; if that build fails, the rejection is its
   * error. The build takes its turn: it never stops one that is running, and
   * queries that wait at the same time share it.
   */
  async query<T = unknown>(objectId: string, name: string, args: object): Promise<T> {
    const entry = this.entries.get(objectId)
    if (!entry?.lastGood) {
      const message = `${objectId} has not been built successfully yet, so there is nothing to ask about`
      throw new KernelError('no_build', message)
    }
    try {
      return await this.kernel.query<T>(entry.obj.dir, name, args)
    } catch (e) {
      const gone = e instanceof KernelError && e.kind === 'no_build'
      if (!gone || this.entries.get(objectId) !== entry) throw e
    }
    await this.builtAgain(entry)
    return this.kernel.query<T>(entry.obj.dir, name, args)
  }

  /** Resolves when the next build of an object succeeds, starting one if none is on its way; rejects with its error. */
  private builtAgain(entry: Entry): Promise<void> {
    if (!entry.rebuilt) {
      let resolve!: () => void
      let reject!: (e: KernelError) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      entry.rebuilt = { promise, resolve, reject }
      // A build of this object that is running, or waiting for its turn, will do.
      if (entry.state.status !== 'building') {
        if (this.running === null) this.start(entry)
        else this.displaced.add(entry.obj.id) // started when the kernel is free
      }
    }
    return entry.rebuilt.promise
  }

  private settleRebuilt(entry: Entry, error?: KernelError): void {
    const waiting = entry.rebuilt
    if (!waiting) return
    entry.rebuilt = undefined
    if (error) waiting.reject(error)
    else waiting.resolve()
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
    entry.changedMeanwhile = false // this build sees whatever changed

    if (obj.model === null) {
      const message = obj.problem ?? `no model file in ${obj.dir}`
      this.set(entry, { objectId: id, status: 'failed', revision, error: { kind: 'no_model', message }, stale: revision > 0 })
      this.abandon(id)
      return
    }

    entry.startedAt = this.now()
    this.set(entry, { objectId: id, status: 'building', revision, startedAt: entry.startedAt, stale: revision > 0 })
    this.running = id
    const opts = this.timeout === undefined ? undefined : { timeout: this.timeout }
    void this.kernel.build(obj.dir, obj.model, opts).then((result) => {
      const current = this.entries.get(id) === entry && entry.attempt === attempt
      if (current && this.running === id) this.running = null
      if (current) {
        // Cancelled while another object holds the kernel: displaced by that
        // build, and started again after it. Cancelled otherwise (the kernel was
        // shut down, or refused): a failure. Starting it again from here could
        // loop without ever yielding, since such a reply need not be a round trip.
        const displaced = !result.ok && result.error.kind === 'cancelled' && this.running !== null
        const again = entry.changedMeanwhile
        if (result.ok) this.succeeded(entry, result.scene, result.blob)
        else if (displaced) this.displaced.add(id)
        else this.failed(entry, result.error)
        // A listener may have closed the object, or started it again, by now.
        if (again && !displaced && this.entries.get(id) === entry && entry.attempt === attempt) this.start(entry)
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
    if (state.status === 'ok') this.settleRebuilt(entry)
    else if (state.status === 'failed') this.settleRebuilt(entry, new KernelError(state.error?.kind ?? 'exception', state.error?.message ?? 'the build failed'))
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
    const waiting = [...this.displaced]
    if (this.shown !== null && this.displaced.has(this.shown)) waiting.unshift(this.shown)
    for (const id of waiting) {
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

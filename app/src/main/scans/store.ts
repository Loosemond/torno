import { mkdir, readFile, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Vec3 } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { type AlignmentCheck, type Scan, type ScanAlignment, type ScanInfo, type ScanUnit, type ScanUp, type ScansFile, SCAN_FORMATS, UNIT_MM } from '../../shared/scans'
import { SCAN_ID, loadScansFile, sanitiseAlignment, sanitiseScan, saveScansFile, scanName } from './file'
import type { ImportReply, Importer } from './importer'

interface ScanEvents {
  /** The scans of an object changed, or what was found of them: the whole list, as it now is. */
  changed: { objectId: string; scans: ScanInfo[] }
  /** Where the import of a file stands: the stage the process names, and null once it has ended, whichever way. */
  progress: { objectId: string; name: string; stage: string | null }
  /** Something about an object's scans file the person should know, as a sentence: it was set aside. Said once. */
  problem: { objectId: string; message: string }
}

/** Whose scans something is asked of: the object as it was named, its folder then, and the workspace it was asked in. */
interface Place { objectId: string; dir: string; epoch: number }

const LEFT = 'the workspace was closed'

/**
 * The scans of the objects of the open workspace: the only writer of their
 * `.torno/scans.json` and of what is under `.torno/scans/`. An object's
 * scans are read once and then kept in memory; what is done to them is done
 * one thing at a time per object, each change written before it is told.
 * Every method rejects for an object whose folder is not known.
 *
 * A scan is `<object>/.torno/scans/<id>/mesh.bin`, written by the import
 * process. Its source is where the person has it: it is read by that
 * process, and by nothing here but `stat`.
 */
export class ScanStore {
  /** By object folder: the scans file as last read or written. */
  private files = new Map<string, ScansFile>()
  /** By object folder: the last thing asked of its scans, which the next waits for. */
  private turns = new Map<string, Promise<unknown>>()
  /** By object folder, then scan: what the last check of each alignment found. Of this run: never written. */
  private checks = new Map<string, Map<string, Record<string, AlignmentCheck>>>()
  /** The imports under way: an import holds its object's turn only to take its id and to be kept. */
  private imports = new Set<Promise<unknown>>()
  /** Counts `forget`: what was read before one is not kept after it. */
  private epoch = 0
  private listeners: { [E in keyof ScanEvents]: Array<(m: ScanEvents[E]) => void> } = { changed: [], progress: [], problem: [] }

  constructor(private deps: { dirOf(objectId: string): string | undefined; importer(): Importer | string /* why none can run */; now?(): Date; stat?: typeof statFile }) {}

  on<E extends keyof ScanEvents>(event: E, cb: (m: ScanEvents[E]) => void): void {
    this.listeners[event].push(cb)
  }

  /** Forget what was read, as when the workspace is left. Files are read again when next asked for. */
  forget(): void {
    this.epoch += 1
    this.files.clear()
    this.checks.clear()
  }

  /**
   * Null when nothing asked of the scans is still under way; else a promise
   * that resolves once all of it is done, written or failed. For whoever
   * must not go before it is on the disk: the app, when it quits.
   */
  settled(): Promise<void> | null {
    const under = (): Promise<unknown>[] => [...this.turns.values(), ...this.imports]
    if (under().length === 0) return null
    const wait = async (): Promise<void> => {
      while (under().length > 0) await Promise.allSettled(under())
    }
    return wait()
  }

  list(objectId: string): Promise<ScanInfo[]> {
    return this.turn(this.place(objectId), (file, dir) => this.told(dir, file))
  }

  /**
   * Imports a file as a scan of the object: the import process reads it and
   * writes `.torno/scans/<id>/mesh.bin`; the file itself is not touched,
   * and is remembered by its path, size, time and hash.
   *
   * What cannot be imported is refused before anything is written. The id is
   * taken, and written as taken, before the process is started: an import
   * that fails leaves its id unused, and it is never given again. The
   * object's other scans can be listed and changed while the process runs.
   */
  import(objectId: string, source: string): Promise<ScanInfo> {
    let run: Promise<ScanInfo>
    try {
      run = this.importing(this.place(objectId), source)
    } catch (e) {
      return Promise.reject(e)
    }
    this.imports.add(run)
    void run.catch(() => {}).finally(() => this.imports.delete(run))
    return run
  }

  private async importing(place: Place, given: string): Promise<ScanInfo> {
    const { dir, epoch } = place
    const taken = await this.turn(place, async (file) => {
      if (typeof given !== 'string' || !isAbsolute(given)) throw new Error('give the whole path of the file')
      const source = resolve(given)
      const formats: readonly string[] = SCAN_FORMATS
      if (!formats.includes(extname(source).toLowerCase())) throw new Error(`${basename(source)} is not a scan torno reads: ${formats.slice(0, -1).join(', ')} or ${formats.at(-1)}`)
      if (isWithin(join(dir, '.torno'), source)) throw new Error(`${basename(source)} is in this object's .torno folder, where torno keeps its own files: import it from somewhere else`)
      const importer = this.importer(epoch)
      const id = `S${file.next}`
      // Taken before the process is started, and for good: were the import to fail, or torno to stop, the id is not given again.
      const next: ScansFile = { ...file, next: file.next + 1 }
      await saveScansFile(dir, next)
      this.keep(place, next)
      return { id, source, importer }
    })

    const { id, source, importer } = taken
    const name = basename(source)
    const folder = scanFolder(dir, id)
    try {
      await mkdir(folder, { recursive: true })
      // A mesh is tens of megabytes, and can be made again from its source: what else is in .torno/ is safe to commit.
      await writeFile(join(dir, '.torno', 'scans', '.gitignore'), 'mesh.bin\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      let reply: ImportReply
      try {
        reply = await importer.import(source, join(folder, MESH), {}, (stage) => this.progress(place, name, stage))
      } finally {
        this.progress(place, name, null)
      }
      const stats = await this.stat(source).catch(() => null)
      // The reply is the word of a process: only what makes a whole scan is kept.
      const scan = sanitiseScan({
        id,
        name,
        source: { path: source, bytes: reply.source?.bytes, mtimeMs: stats?.mtimeMs ?? 0, sha256: reply.source?.sha256 },
        imported: { ...reply, reduced: reply.reduced ?? undefined, at: this.now().toISOString() },
        alignments: {}
      })
      if (!scan) throw new Error(`the import of ${name} did not say what it wrote: nothing was kept`)
      return await this.change(place, (file) => {
        file.scans.push(scan)
        return scan
      }).then((kept) => this.infoOf(dir, kept))
    } catch (e) {
      // Only ever the folder made above for this id.
      await rm(folder, { recursive: true, force: true }).catch(() => {})
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Has the scan's mesh written again as if its source had been read with
   * another unit and up axis; the source is not needed. A scan of another
   * size, or turned otherwise, is aligned to nothing: its alignments are
   * dropped. Asked for the unit and the axis it has, nothing is rewritten
   * and its alignments stay: they are then the person's choice, no longer
   * assumed.
   */
  convert(objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo> {
    const place = this.place(objectId)
    const { dir, epoch } = place
    return this.change(place, async (file) => {
      const at = indexOf(file, id)
      const scan = file.scans[at]
      const to = { unit: as?.unit, up: as?.up }
      if (!Object.hasOwn(UNIT_MM, to.unit) || (to.up !== 'y' && to.up !== 'z')) throw new Error('a scan is in mm, cm, m or in, with y or z up')
      const from = { unit: scan.imported.unit, up: scan.imported.up }
      if (from.unit === to.unit && from.up === to.up) {
        scan.imported.assumed = { unit: false, up: false }
        return scan
      }
      const mesh = join(scanFolder(dir, scan.id), MESH)
      if (!(await this.isFile(mesh))) throw new Error(await this.meshGone(scan, mesh))
      const importer = this.importer(epoch)
      let reply: ImportReply
      try {
        reply = await importer.convert(mesh, from, to)
      } catch (e) {
        // A process that was killed as it wrote leaves its temp file beside the mesh.
        await removeTemps(scanFolder(dir, scan.id))
        throw e
      }
      const { colours, vertices, triangles, reduced } = scan.imported
      const converted = sanitiseScan({
        ...scan,
        imported: { ...to, assumed: { unit: false, up: false }, bbox: reply.bbox, area: reply.area, colours, vertices, triangles, reduced, at: this.now().toISOString() },
        alignments: {}
      })
      if (!converted) throw new Error(`the conversion of ${scan.id} did not say what it wrote`)
      file.scans[at] = converted
      this.checks.get(dir)?.delete(scan.id)
      return converted
    }).then((scan) => this.infoOf(dir, scan))
  }

  rename(objectId: string, id: string, name: string): Promise<ScanInfo> {
    const place = this.place(objectId)
    return this.change(place, (file) => {
      const scan = file.scans[indexOf(file, id)]
      const named = typeof name === 'string' ? scanName(name) : ''
      if (named === '') throw new Error('a scan needs a name')
      scan.name = named
      return scan
    }).then((scan) => this.infoOf(place.dir, scan))
  }

  /** Forgets the scan and deletes its folder under `.torno/scans/`: its mesh, and whatever was kept beside it. Its source is not touched. */
  remove(objectId: string, id: string): Promise<void> {
    const place = this.place(objectId)
    return this.change(
      place,
      (file) => {
        const [scan] = file.scans.splice(indexOf(file, id), 1)
        this.checks.get(place.dir)?.delete(scan.id)
        return scan
      },
      // Once it is no longer in the file. Only ever that folder: its name is the id, which is `S` and digits.
      (scan) => rm(scanFolder(place.dir, scan.id), { recursive: true, force: true }).catch((e) => console.error(`cannot delete the files of ${scan.id}: ${e.message}`))
    ).then(() => {})
  }

  /**
   * Keeps where the scan is in a layout, or with null that it is aligned to
   * nothing there. What the last check found of that layout is forgotten:
   * it was of the alignment before.
   */
  align(objectId: string, id: string, layout: string, alignment: ScanAlignment | null): Promise<ScanInfo> {
    const place = this.place(objectId)
    return this.change(place, (file) => {
      const scan = file.scans[indexOf(file, id)]
      if (typeof layout !== 'string' || layout === '') throw new Error('a scan is aligned in a layout: name it')
      const others = Object.entries(scan.alignments).filter(([name]) => name !== layout)
      if (alignment === null) {
        scan.alignments = Object.fromEntries(others)
      } else {
        const kept = sanitiseAlignment(alignment)
        if (!kept) throw new Error('that is not an alignment: its transform, its steps, its frame or its time is missing, or a number is not finite')
        scan.alignments = Object.fromEntries([...others, [layout, kept]])
      }
      const checks = this.checks.get(place.dir)?.get(scan.id)
      if (checks) delete checks[layout]
      return scan
    }).then((scan) => this.infoOf(place.dir, scan))
  }

  /**
   * What a check of the alignments found (Task 5): kept in memory, told with
   * the scans. A scan that is no longer there, or no longer aligned in that
   * layout, is passed over: it changed while the check ran.
   */
  checked(objectId: string, id: string, layout: string, check: AlignmentCheck | null): Promise<void> {
    const place = this.place(objectId)
    const { dir, epoch } = place
    return this.turn(place, async (file) => {
      const scan = file.scans.find((s) => s.id === id)
      if (!scan || epoch !== this.epoch) return
      const ofObject = this.checks.get(dir) ?? new Map<string, Record<string, AlignmentCheck>>()
      const ofScan = ofObject.get(scan.id) ?? {}
      if (check === null) {
        if (!Object.hasOwn(ofScan, layout)) return
        delete ofScan[layout]
      } else {
        if (!Object.hasOwn(scan.alignments, layout)) return
        Object.defineProperty(ofScan, layout, { value: structuredClone(check), enumerable: true, writable: true, configurable: true })
      }
      this.checks.set(dir, ofObject.set(scan.id, ofScan))
      const scans = await this.told(dir, file)
      if (epoch === this.epoch) this.emit('changed', { objectId, scans })
    })
  }

  /** The bytes of the scan's `mesh.bin`. Rejects saying where it was looked for and where to import it from again. */
  mesh(objectId: string, id: string): Promise<Buffer> {
    return this.turn(this.place(objectId), async (file, dir) => {
      const scan = file.scans[indexOf(file, id)]
      const path = join(scanFolder(dir, scan.id), MESH)
      try {
        return await readFile(path)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') throw e
        throw new Error(await this.meshGone(scan, path))
      }
    })
  }

  /** Where a scan's files are: for the kernel, which is given paths and never looks for files. */
  paths(objectId: string, id: string): { mesh: string; mask(markId: string): string } | undefined {
    const dir = this.deps.dirOf(objectId)
    if (dir === undefined || typeof id !== 'string' || !SCAN_ID.test(id)) return undefined
    const folder = scanFolder(dir, id)
    return {
      mesh: join(folder, MESH),
      mask(markId) {
        if (typeof markId !== 'string' || !/^M[1-9]\d{0,14}$/.test(markId)) throw new RangeError(`${markId} is no mark: a region's file is named by its mark`)
        return join(folder, `${markId}.mask`)
      }
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private get stat(): typeof statFile {
    return this.deps.stat ?? statFile
  }

  private async isFile(path: string): Promise<boolean> {
    return (await this.stat(path).catch(() => null))?.isFile() === true
  }

  /** The importer of the workspace something was asked in, which must still be the one open: another's would run in another folder. */
  private importer(epoch: number): Importer {
    if (epoch !== this.epoch) throw new Error(LEFT)
    const importer = this.deps.importer()
    if (typeof importer === 'string') throw new Error(importer)
    return importer
  }

  private async meshGone(scan: Scan, path: string): Promise<string> {
    const source = await this.isFile(scan.source.path)
    return `${scan.id}'s mesh is gone from ${path}. Import it again from ${scan.source.path}${source ? '' : ', which is missing too'}`
  }

  /** A scan as it is told: with whether its source is still the file that was read, and whether its mesh is there. */
  private async infoOf(dir: string, scan: Scan): Promise<ScanInfo> {
    const [source, mesh] = await Promise.all([this.stat(scan.source.path).catch(() => null), this.isFile(join(scanFolder(dir, scan.id), MESH))])
    // By its size and its time: the hash is not taken again, which would read the whole file at every listing.
    const sourceState = !source?.isFile() ? 'missing' : source.size !== scan.source.bytes || source.mtimeMs !== scan.source.mtimeMs ? 'changed' : 'present'
    return { ...structuredClone(scan), sourceState, meshState: mesh ? 'ok' : 'missing', checks: structuredClone(this.checks.get(dir)?.get(scan.id) ?? {}) }
  }

  private told(dir: string, file: ScansFile): Promise<ScanInfo[]> {
    return Promise.all(file.scans.map((scan) => this.infoOf(dir, scan)))
  }

  private progress({ objectId, epoch }: Place, name: string, stage: string | null): void {
    if (epoch === this.epoch) this.emit('progress', { objectId, name, stage })
  }

  /** The file as it now is on the disk, for the workspace it was written in: one that was left meanwhile reads it again. */
  private keep({ dir, epoch }: Place, file: ScansFile): void {
    if (epoch === this.epoch) this.files.set(dir, file)
    else this.files.delete(dir)
  }

  /**
   * Change the scans of an object: `edit` is given a copy of the file to
   * change, and returns the scan it changed. The copy is written, then kept,
   * then told; an `edit` that throws, or a write that fails, leaves the
   * scans as they were. `then` is done once it is written, before it is told.
   */
  private change(place: Place, edit: (file: ScansFile) => Scan | Promise<Scan>, then?: (scan: Scan) => Promise<void>): Promise<Scan> {
    return this.turn(place, async (current, dir) => {
      const file = structuredClone(current)
      const scan = await edit(file)
      await saveScansFile(dir, file)
      this.keep(place, file)
      await then?.(scan)
      // Told only to the workspace it was asked in: the write of one that has been left lands, and is not broadcast.
      const scans = await this.told(dir, file)
      if (place.epoch === this.epoch) this.emit('changed', { objectId: place.objectId, scans })
      return structuredClone(scan)
    })
  }

  /** The object's folder as of the asking: the workspace may be left, and another opened, while what is asked waits its turn. */
  private place(objectId: string): Place {
    const dir = this.deps.dirOf(objectId)
    if (dir === undefined) throw new Error(`no object named ${objectId} in the open workspace`)
    return { objectId, dir, epoch: this.epoch }
  }

  /** Do one thing with the scans file of an object, after whatever was asked of it before. */
  private turn<T>({ objectId, dir, epoch }: Place, task: (file: ScansFile, dir: string) => T | Promise<T>): Promise<T> {
    const turn = (this.turns.get(dir) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // What is kept is of the workspace that is open: one asked in a workspace since left reads the file itself.
        let file = epoch === this.epoch ? this.files.get(dir) : undefined
        if (!file) {
          const loaded = await loadScansFile(dir, () => this.now())
          file = loaded.file
          if (epoch === this.epoch) {
            this.files.set(dir, file)
            if (loaded.problem) this.emit('problem', { objectId, message: loaded.problem })
          }
        }
        return task(file, dir)
      })
      .finally(() => {
        if (this.turns.get(dir) === turn) this.turns.delete(dir)
      })
    this.turns.set(dir, turn)
    return turn
  }

  private emit<E extends keyof ScanEvents>(event: E, message: ScanEvents[E]): void {
    for (const cb of this.listeners[event]) cb(message)
  }
}

const MESH = 'mesh.bin'

/**
 * How far each part of a layout was spread for display on a build
 * (`Part.arranged`), zeros for a part that was not moved: what an alignment
 * made on that build records as its `frame`. Null when the build has no part
 * in that layout, or there is no build.
 */
export function frameOf(scene: Scene | undefined, layout: string): Record<string, Vec3> | null {
  const parts = scene?.parts.filter((part) => part.layout === layout) ?? []
  return parts.length > 0 ? Object.fromEntries(parts.map((part): [string, Vec3] => [part.name, part.arranged ? [...part.arranged] : [0, 0, 0]])) : null
}

/** `<object>/.torno/scans/<id>/`: all that is ever written or deleted for a scan. The id is checked here, whoever gave it. */
function scanFolder(dir: string, id: string): string {
  if (!SCAN_ID.test(id)) throw new RangeError(`${id} is no scan id`)
  return join(dir, '.torno', 'scans', id)
}

/** Whether `path` is `folder` or under it. */
function isWithin(folder: string, path: string): boolean {
  const from = relative(folder, path)
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

/** Deletes the temp files the import process leaves beside a mesh when it is killed as it writes (`scanfile.write_bin`). */
async function removeTemps(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[])
  await Promise.all(names.filter((name) => /^mesh\.bin\.\d+\.tmp$/.test(name)).map((name) => rm(join(folder, name), { force: true }).catch(() => {})))
}

/** Where a scan is in its file; an id that is not there is an error that names the ones that are. */
function indexOf(file: ScansFile, id: string): number {
  const at = file.scans.findIndex((s) => s.id === id)
  if (at < 0) throw new Error(`no scan ${id}; scans: ${file.scans.map((s) => s.id).join(', ') || 'none'}`)
  return at
}

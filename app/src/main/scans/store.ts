import { copyFile, mkdir, readFile, realpath, rm, stat as statFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Vec3 } from '../../shared/marks'
import type { Scene } from '../../shared/scene'
import { number } from '../../shared/format'
import { type AlignmentCheck, type Reimported, type Scan, type ScanAlignment, type ScanInfo, type ScanUnit, type ScanUp, type ScansFile, SCAN_FORMATS, UNIT_MM, alignmentOf } from '../../shared/scans'
import { loadScansFile, sanitiseAlignment, sanitiseScan, saveScansFile, scanName } from './file'
import type { ImportReply, Importer } from './importer'
import { IMPORTING, MESH, freshMeshName, ignoreMeshes, meshName, removeMesh, scanFolder, sweep } from './meshfiles'

interface ScanEvents {
  /** The scans of an object changed, or what was found of them: the whole list, as it now is. */
  changed: { objectId: string; scans: ScanInfo[] }
  /** Where the import of a file stands: the stage the process names, and null once it has ended, whichever way. */
  progress: { objectId: string; name: string; stage: string | null }
  /** Something about an object's scans file the person should know, as a sentence: it was set aside. Said once; `problem()` answers it afterwards. */
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
 * A scan is one mesh file in `<object>/.torno/scans/<id>/`, written by the
 * import process: `mesh.bin`, or the file its record names once it was
 * converted (`meshfiles.ts`). Its source is where the person has it: it is
 * read by that process, and by nothing here but `stat`.
 *
 * What takes a process (an import, a conversion) holds its object's turn
 * only to begin and to be kept: the scans are answered for meanwhile.
 */
export class ScanStore {
  /** By object folder: the scans file as last read or written. */
  private files = new Map<string, ScansFile>()
  /** By object folder: the last thing asked of its scans, which the next waits for. */
  private turns = new Map<string, Promise<unknown>>()
  /** By object folder, then scan: what the last check of each alignment found. Of this run: never written. */
  private checks = new Map<string, Map<string, Record<string, AlignmentCheck>>>()
  /** The imports and the conversions under way. */
  private runs = new Set<Promise<unknown>>()
  /** By object folder: the ids whose folder an import or a conversion under way is writing in. Kept across `forget`: the process is not ended by it. */
  private busy = new Map<string, Set<string>>()
  /**
   * By object folder: what was last found wrong with its scans file, until the
   * person dismisses it. Kept across `forget`: it is a fact about the folder,
   * whichever workspace was open when it was found.
   */
  private problems = new Map<string, string>()
  /** Counts `forget`: what was read before one is not kept after it. */
  private epoch = 0
  private listeners: { [E in keyof ScanEvents]: Array<(m: ScanEvents[E]) => void> } = { changed: [], progress: [], problem: [] }

  constructor(private deps: { dirOf(objectId: string): string | undefined; importer(): Importer | string /* why none can run */; now?(): Date; stat?: typeof statFile; /** The number in the name of a new mesh: drawn at random unless a test gives it. */ meshNumber?(): number }) {}

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
    const under = (): Promise<unknown>[] => [...this.turns.values(), ...this.runs]
    if (under().length === 0) return null
    const wait = async (): Promise<void> => {
      while (under().length > 0) await Promise.allSettled(under())
    }
    return wait()
  }

  list(objectId: string): Promise<ScanInfo[]> {
    return this.of(objectId, (place) => this.turn(place, (file, dir) => this.told(dir, file)))
  }

  /**
   * What is wrong with the scans file of an object, as a sentence, or null. It
   * is told once as a `problem` event, to whoever listens then; this is for
   * whoever did not, and answers the same until `dismissProblem`.
   */
  problem(objectId: string): Promise<string | null> {
    return this.of(objectId, (place) => this.turn(place, (_file, dir) => this.problems.get(dir) ?? null))
  }

  /** The person has read what was wrong with the scans file of an object. */
  dismissProblem(objectId: string): Promise<void> {
    return this.of(objectId, (place) =>
      this.turn(place, (_file, dir) => {
        this.problems.delete(dir)
      })
    )
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
    return this.of(objectId, (place) => this.running(this.importing(place, source)))
  }

  private async importing(place: Place, given: string): Promise<ScanInfo> {
    const { dir, epoch } = place
    const busy = this.busyIn(dir)
    const taken = await this.turn(place, async (file) => {
      const source = await sourceOf(dir, given)
      const importer = this.importer(epoch)
      const id = `S${file.next}`
      // Taken before the process is started, and for good: were the import to fail, or torno to stop, the id is not given again.
      const next: ScansFile = { ...file, next: file.next + 1 }
      await saveScansFile(dir, next)
      this.keep(place, next)
      busy.add(id)
      return { id, source, importer }
    })

    const { id, source, importer } = taken
    const name = basename(source)
    const folder = scanFolder(dir, id)
    let made = false
    let committed = false
    try {
      await ignoreMeshes(dir)
      // A folder of that name is another scan's, whatever the file says: it is not written in, and not deleted below.
      await mkdir(folder)
      made = true
      await writeFile(join(folder, IMPORTING), `${source}\n`)
      // As it is before it is read: one that is rewritten while it is read has changed since.
      const stats = await this.stat(source).catch(() => null)
      let reply: ImportReply
      // Asked again, on the very line that starts the process: the workspace may have been left while the folder was made,
      // and whoever stops its importer has been and gone.
      if (epoch !== this.epoch) throw new Error(LEFT)
      try {
        reply = await importer.import(source, join(folder, MESH), {}, (stage) => this.progress(place, name, stage))
      } finally {
        this.progress(place, name, null)
      }
      // The reply is the word of a process: only what makes a whole scan is kept.
      const scan = sanitiseScan({
        id,
        name,
        source: { path: source, bytes: reply.source?.bytes, mtimeMs: stats?.mtimeMs ?? 0, sha256: reply.source?.sha256 },
        imported: { ...reply, reduced: reply.reduced ?? undefined, mesh: undefined, at: this.now().toISOString() },
        alignments: {}
      })
      if (!scan) throw new Error(`the import of ${name} did not say what it wrote: nothing was kept`)
      const kept = await this.change(
        place,
        (file) => {
          file.scans.push(scan)
          return scan
        },
        // It is a scan now: its folder is no longer that of an import under way, and whatever fails from here on, it is kept.
        () => {
          committed = true
          return rm(join(folder, IMPORTING), { force: true }).catch(() => {})
        }
      )
      return await this.infoOf(dir, kept)
    } catch (e) {
      // Only ever the folder made above for this id, and never once it is a scan's.
      if (made && !committed) await rm(folder, { recursive: true, force: true }).catch(() => {})
      throw new Error(e instanceof Error ? e.message : String(e))
    } finally {
      busy.delete(id)
    }
  }

  /**
   * Has the scan's mesh written again as if its source had been read with
   * another unit and up axis; the source is not needed. A scan of another
   * size, or turned otherwise, is aligned to nothing: its alignments are
   * dropped. Asked for the unit and the axis it has, nothing is rewritten
   * and its alignments stay: they are then the person's choice, no longer
   * assumed.
   *
   * The mesh it has is never written over: a copy is converted, under the
   * next name, and the one write of `scans.json` that names it is what makes
   * it the scan's. Only then is the old file deleted. Stopped anywhere, the
   * record and the mesh it names agree, and what is left over is cleared
   * away when the scans are next read (`sweep`).
   */
  convert(objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo> {
    return this.of(objectId, (place) => this.running(this.converting(place, id, as)))
  }

  private async converting(place: Place, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo> {
    const { dir, epoch } = place
    const busy = this.busyIn(dir)
    const to = { unit: as?.unit, up: as?.up }
    const begun = await this.turn(place, async (file) => {
      const scan = file.scans[indexOf(file, id)]
      if (!Object.hasOwn(UNIT_MM, to.unit) || (to.up !== 'y' && to.up !== 'z')) throw new Error('a scan is in mm, cm, m or in, with y or z up')
      if (busy.has(scan.id)) throw new Error(`${scan.id} is being converted or imported again already`)
      const from = { unit: scan.imported.unit, up: scan.imported.up }
      if (from.unit === to.unit && from.up === to.up) return null
      const folder = scanFolder(dir, scan.id)
      const old = meshName(scan)
      if (!(await this.isFile(join(folder, old)))) throw new Error(await this.meshGone(scan, join(folder, old)))
      const importer = this.importer(epoch)
      busy.add(scan.id)
      return { importer, from, folder, old, fresh: await freshMeshName(folder, this.deps.meshNumber) }
    })
    if (begun === null) {
      const same = await this.change(place, (file) => {
        const scan = file.scans[indexOf(file, id)]
        scan.imported.assumed = { unit: false, up: false }
        return scan
      })
      return this.infoOf(dir, same)
    }

    const { importer, from, folder, old, fresh } = begun
    let committed = false
    try {
      await ignoreMeshes(dir)
      await copyFile(join(folder, old), join(folder, fresh))
      if (epoch !== this.epoch) throw new Error(LEFT)
      const reply = await importer.convert(join(folder, fresh), from, to)
      const kept = await this.change(
        place,
        (file) => {
          const at = file.scans.findIndex((s) => s.id === id)
          if (at < 0) throw new Error(`${id} was removed while it was being converted`)
          // The scan as it now is: what was done to it meanwhile is kept, but where it was aligned.
          const scan = file.scans[at]
          const converted = sanitiseScan({ ...scan, imported: { ...scan.imported, ...to, assumed: { unit: false, up: false }, bbox: reply.bbox, area: reply.area, at: this.now().toISOString(), mesh: fresh }, alignments: {} })
          if (!converted) throw new Error(`the conversion of ${id} did not say what it wrote`)
          file.scans[at] = converted
          this.checks.get(dir)?.delete(id)
          return converted
        },
        // The record names the new mesh: the old one is nobody's, and whatever fails from here on, the new one is the scan's.
        () => {
          committed = true
          return removeMesh(folder, old)
        }
      )
      return await this.infoOf(dir, kept)
    } catch (e) {
      // The record still names the mesh it had, which nothing wrote in.
      if (!committed) await removeMesh(folder, fresh)
      throw new Error(e instanceof Error ? e.message : String(e))
    } finally {
      busy.delete(id)
    }
  }

  /**
   * Reads the scan's source again, into the id it has: for a scan whose mesh
   * is not there (a clone: meshes are not committed) or whose source was
   * changed. In the unit and with the up axis the scan has, so that where it
   * was aligned still holds; its name and its alignments stay. As a
   * conversion, the new mesh is another file, and the write of `scans.json`
   * that names it is what makes it the scan's.
   *
   * A source that is another file than was read before, or a mesh of other
   * counts, is said in the answer, and what was checked of the alignments is
   * forgotten. Refused when the source is not there.
   */
  reimport(objectId: string, id: string): Promise<Reimported> {
    return this.of(objectId, (place) => this.running(this.reimporting(place, id)))
  }

  private async reimporting(place: Place, id: string): Promise<Reimported> {
    const { dir, epoch } = place
    const busy = this.busyIn(dir)
    const begun = await this.turn(place, async (file) => {
      const scan = file.scans[indexOf(file, id)]
      if (busy.has(scan.id)) throw new Error(`${scan.id} is being converted or imported again already`)
      // What the record says its source is, is what a file says: it is read only if it would have been the first time.
      await sourceOf(dir, scan.source.path)
      // As it is before it is read, as for a first import.
      const stats = await this.stat(scan.source.path).catch(() => null)
      if (!stats?.isFile()) throw new Error(`${scan.id} cannot be imported again: its source ${scan.source.path} is missing`)
      const importer = this.importer(epoch)
      busy.add(scan.id)
      return { importer, was: structuredClone(scan), mtimeMs: stats.mtimeMs }
    })

    const { importer, was, mtimeMs } = begun
    const folder = scanFolder(dir, was.id)
    const old = meshName(was)
    const name = basename(was.source.path)
    let fresh: string | null = null
    let committed = false
    try {
      await ignoreMeshes(dir)
      // The scan's own folder, there or not: its id is in the file.
      await mkdir(folder, { recursive: true })
      const mesh = (fresh = await freshMeshName(folder, this.deps.meshNumber))
      if (epoch !== this.epoch) throw new Error(LEFT)
      let reply: ImportReply
      try {
        reply = await importer.import(was.source.path, join(folder, mesh), { unit: was.imported.unit, up: was.imported.up }, (stage) => this.progress(place, name, stage))
      } finally {
        this.progress(place, name, null)
      }
      let sourceChanged = false
      let meshChanged = false
      const kept = await this.change(
        place,
        (file) => {
          const at = file.scans.findIndex((s) => s.id === id)
          if (at < 0) throw new Error(`${id} was removed while it was being imported again`)
          // The scan as it now is: its name and where it is aligned are kept.
          const scan = file.scans[at]
          const { unit, up, assumed } = scan.imported
          const again = sanitiseScan({
            ...scan,
            source: { path: scan.source.path, bytes: reply.source?.bytes, mtimeMs, sha256: reply.source?.sha256 },
            imported: { ...reply, reduced: reply.reduced ?? undefined, unit, up, assumed, mesh, at: this.now().toISOString() }
          })
          if (!again) throw new Error(`the import of ${name} did not say what it wrote: ${id} is as it was`)
          sourceChanged = again.source.sha256 !== scan.source.sha256
          // Of another file than the one each was aligned with: said with the scan until it is aligned again, or said to hold.
          if (sourceChanged) for (const alignment of Object.values(again.alignments)) alignment.sourceChanged = true
          meshChanged = again.imported.vertices !== scan.imported.vertices || again.imported.triangles !== scan.imported.triangles
          file.scans[at] = again
          // Of another mesh than the one they were checked with.
          if (sourceChanged || meshChanged) this.checks.get(dir)?.delete(id)
          return again
        },
        () => {
          committed = true
          return removeMesh(folder, old)
        }
      )
      return { scan: await this.infoOf(dir, kept), sourceChanged, meshChanged }
    } catch (e) {
      if (!committed && fresh !== null) await removeMesh(folder, fresh)
      // Its folder went with it, and what the process then says is of a folder that is not there.
      if (!committed && (await this.isGone(place, id))) throw new Error(`${id} was removed while it was being imported again`)
      throw new Error(e instanceof Error ? e.message : String(e))
    } finally {
      busy.delete(id)
    }
  }

  rename(objectId: string, id: string, name: string): Promise<ScanInfo> {
    return this.of(objectId, (place) => this.renaming(place, id, name))
  }

  private renaming(place: Place, id: string, name: string): Promise<ScanInfo> {
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
    return this.of(objectId, (place) => this.removing(place, id))
  }

  private removing(place: Place, id: string): Promise<void> {
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
   *
   * What follows from the transform and the pairs is worked out here, never
   * taken: residuals, rms, whether the scan was scaled, why it is rough
   * (`sanitiseAlignment`). An alignment that is rough, or that changes the
   * scan's size, is kept only with the person's yes to that (`accepted`).
   * The alignment it takes the place of is kept with it, for one `undoAlign`;
   * `before` and `sourceChanged` are never a caller's to say.
   */
  align(objectId: string, id: string, layout: string, alignment: ScanAlignment | null, accepted: { rough?: boolean; scaled?: boolean } = {}): Promise<ScanInfo> {
    return this.of(objectId, (place) => this.aligning(place, id, layout, alignment, accepted))
  }

  private aligning(place: Place, id: string, layout: string, alignment: ScanAlignment | null, accepted: { rough?: boolean; scaled?: boolean }): Promise<ScanInfo> {
    return this.inLayout(place, id, layout, (scan, others) => {
      if (alignment === null) {
        scan.alignments = Object.fromEntries(others)
        return
      }
      const kept = sanitiseAlignment({ ...Object(alignment), before: undefined, sourceChanged: undefined })
      if (!kept) throw new Error('that is not an alignment: its transform, its steps, its frame or its time is missing, or a number is not finite')
      if (kept.scaled && accepted.scaled !== true) throw new Error(`this alignment changes the size of the scan (× ${number(kept.transform.s)}): it is kept only when that scale was chosen`)
      if (kept.rough !== undefined && accepted.rough !== true) throw new Error(`this alignment is rough (${kept.rough}): it is kept only once that is accepted`)
      const was = alignmentOf(scan, layout)
      kept.before = was ? withoutBefore(was) : null
      scan.alignments = Object.fromEntries([...others, [layout, kept]])
    })
  }

  /**
   * Puts back the alignment the scan had in a layout before the last one was
   * kept, as it was: its frame, its time and what it was made of. One step
   * back: what is put back has nothing before it. Rejects when there is
   * nothing to go back to.
   */
  undoAlign(objectId: string, id: string, layout: string): Promise<ScanInfo> {
    return this.of(objectId, (place) =>
      this.inLayout(place, id, layout, (scan, others) => {
        const now = alignmentOf(scan, layout)
        if (!now) throw new Error(`${scan.id} is not aligned in ${layout}: there is nothing to undo`)
        if (now.before === undefined) throw new Error(`${scan.id} has no alignment in ${layout} before this one: there is nothing to undo`)
        scan.alignments = Object.fromEntries(now.before === null ? others : [...others, [layout, structuredClone(now.before)]])
      })
    )
  }

  /** The person says an alignment still holds though the scan was read again from a changed source: it is no longer said to be in doubt for that. */
  alignmentHolds(objectId: string, id: string, layout: string): Promise<ScanInfo> {
    return this.of(objectId, (place) =>
      this.change(place, (file) => {
        const scan = file.scans[indexOf(file, id)]
        const now = alignmentOf(scan, layout)
        if (!now) throw new Error(`${scan.id} is not aligned in ${String(layout)}`)
        delete now.sourceChanged
        return scan
      }).then((scan) => this.infoOf(place.dir, scan))
    )
  }

  /** Changes the alignment of a scan in one layout (`edit` is given the scan and its alignments in the others), and forgets what was checked of it there. */
  private inLayout(place: Place, id: string, layout: string, edit: (scan: Scan, others: Array<[string, ScanAlignment]>) => void): Promise<ScanInfo> {
    return this.change(place, (file) => {
      const scan = file.scans[indexOf(file, id)]
      if (typeof layout !== 'string' || layout === '') throw new Error('a scan is aligned in a layout: name it')
      edit(scan, Object.entries(scan.alignments).filter(([name]) => name !== layout))
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
    return this.of(objectId, (place) => this.checking(place, id, layout, check))
  }

  private checking(place: Place, id: string, layout: string, check: AlignmentCheck | null): Promise<void> {
    const { objectId, dir, epoch } = place
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

  /** The bytes of the scan's mesh. Rejects saying where it was looked for and where to import it from again. */
  mesh(objectId: string, id: string): Promise<Buffer> {
    return this.of(objectId, (place) =>
      this.turn(place, async (file, dir) => {
        const scan = file.scans[indexOf(file, id)]
        const path = join(scanFolder(dir, scan.id), meshName(scan))
        try {
          return await readFile(path)
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') throw e
          throw new Error(await this.meshGone(scan, path))
        }
      })
    )
  }

  /**
   * Where a scan's files are: for the kernel, which is given paths and never
   * looks for files. Which file is its mesh is in its record, so this is of
   * the scans as last read or written: undefined for a scan that is not
   * among them, and until the object's scans were read since the workspace
   * was opened. Whoever asks awaits `list` first, and then has the answer
   * for as long as the workspace is open, whatever is written meanwhile.
   */
  paths(objectId: string, id: string): { mesh: string; mask(markId: string): string } | undefined {
    const dir = this.deps.dirOf(objectId)
    const scan = dir === undefined ? undefined : this.files.get(dir)?.scans.find((s) => s.id === id)
    if (dir === undefined || !scan) return undefined
    const folder = scanFolder(dir, scan.id)
    return {
      mesh: join(folder, meshName(scan)),
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
    const [source, mesh] = await Promise.all([this.stat(scan.source.path).catch(() => null), this.isFile(join(scanFolder(dir, scan.id), meshName(scan)))])
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

  /**
   * The file as it was just written: kept for the workspace that is open.
   * A write asked in a workspace since left is kept too where the open one
   * has read that folder: it is what is on the disk now, and what was kept
   * is not.
   */
  private keep({ dir, epoch }: Place, file: ScansFile): void {
    if (epoch === this.epoch || this.files.has(dir)) this.files.set(dir, file)
  }

  /** Whether a scan is no longer among its object's. */
  private isGone(place: Place, id: string): Promise<boolean> {
    return this.turn(place, (file) => !file.scans.some((scan) => scan.id === id)).catch(() => false)
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

  /**
   * Something asked of an object's scans, in the object's folder as of the
   * asking: the workspace may be left, and another opened, while what is
   * asked waits its turn. Rejects for an object whose folder is not known.
   */
  private of<T>(objectId: string, ask: (place: Place) => Promise<T>): Promise<T> {
    const dir = this.deps.dirOf(objectId)
    if (dir === undefined) return Promise.reject(new Error(`no object named ${objectId} in the open workspace`))
    return ask({ objectId, dir, epoch: this.epoch })
  }

  /** Something that takes a process: `settled()` waits for it too. */
  private running<T>(run: Promise<T>): Promise<T> {
    this.runs.add(run)
    void run.catch(() => {}).finally(() => this.runs.delete(run))
    return run
  }

  private busyIn(dir: string): Set<string> {
    const busy = this.busy.get(dir) ?? new Set<string>()
    this.busy.set(dir, busy)
    return busy
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
          if (loaded.problem) this.problems.set(dir, loaded.problem)
          if (epoch === this.epoch) {
            this.files.set(dir, file)
            // What torno left when it was stopped in the middle of something. Not beside a file that was set aside:
            // what is in the folders is then all there is of its scans.
            if (loaded.problem) this.emit('problem', { objectId, message: loaded.problem })
            else await sweep(dir, file.scans, this.busyIn(dir)).catch(() => {})
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

  /** Each listener by itself: one that fails keeps nothing from the others, and undoes nothing of what it was told. */
  private emit<E extends keyof ScanEvents>(event: E, message: ScanEvents[E]): void {
    for (const cb of this.listeners[event]) {
      try {
        cb(message)
      } catch (e) {
        console.error(`a listener to the scans' ${event} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}

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

/** An alignment as it is kept for an undo: without what was before it. */
function withoutBefore(alignment: ScanAlignment): Omit<ScanAlignment, 'before'> {
  const { before: _dropped, ...rest } = structuredClone(alignment)
  return rest
}

/** Whether `path` is `folder` or under it. */
function isWithin(folder: string, path: string): boolean {
  const from = relative(folder, path)
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

/**
 * A file that may be read as a scan of the object in `dir`, as a whole path:
 * what the person gave, or what a record says its source is. Throws saying
 * why it is none.
 */
async function sourceOf(dir: string, given: unknown): Promise<string> {
  if (typeof given !== 'string' || !isAbsolute(given)) throw new Error('give the whole path of the file')
  const source = resolve(given)
  const formats: readonly string[] = SCAN_FORMATS
  if (!formats.includes(extname(source).toLowerCase())) throw new Error(`${basename(source)} is not a scan torno reads: ${formats.slice(0, -1).join(', ')} or ${formats.at(-1)}`)
  // By where the file is, whatever name led to it.
  if (isWithin(await real(join(dir, '.torno')), await real(source))) throw new Error(`${basename(source)} is in this object's .torno folder, where torno keeps its own files: import it from somewhere else`)
  return source
}

/** Where a path leads, through whatever links: the path itself when nothing is there. */
const real = (path: string): Promise<string> => realpath(path).catch(() => path)

/** Where a scan is in its file; an id that is not there is an error that names the ones that are. */
function indexOf(file: ScansFile, id: string): number {
  const at = file.scans.findIndex((s) => s.id === id)
  if (at < 0) throw new Error(`no scan ${id}; scans: ${file.scans.map((s) => s.id).join(', ') || 'none'}`)
  return at
}

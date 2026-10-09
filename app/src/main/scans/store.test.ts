import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Scan, type ScanAlignment, type ScanInfo, basisOf } from '../../shared/scans'
import { box, meshBin, stl } from '../../test/scanFixtures'
import type { ImportReply, Importer } from './importer'
import type { Scene } from '../../shared/scene'
import { sanitiseAlignment, sanitiseScan } from './file'
import { MESH_NAME } from './meshfiles'
import { ScanStore, frameOf } from './store'

let root: string
let dir: string
let source: string
let ran: Array<{ what: string; args: unknown[] }>
let fails: string | null

const REPLY: ImportReply = { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, reduced: null, source: { bytes: 684, sha256: 'ab'.repeat(32) } }
/** The person's yes to an alignment that is rough: one placed by hand is. */
const YES = { rough: true }
const ALIGNED: ScanAlignment = { transform: { t: [1, 2, 3], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { base: [0, 0, 0] }, at: '2026-10-10T09:00:00.000Z' }

/** Stands in for the import process: writes a mesh.bin where it is told to, unless it is to fail. */
const importer: Importer = {
  async import(from, out, opts, onStage) {
    ran.push({ what: 'import', args: [from, out, opts] })
    onStage?.('reading')
    if (fails) throw new Error(fails)
    writeFileSync(out, Buffer.from(meshBin(box())))
    return REPLY
  },
  async convert(mesh, from, to) {
    ran.push({ what: 'convert', args: [mesh, from, to] })
    return { ...REPLY, unit: to.unit, up: to.up, assumed: { unit: false, up: false }, bbox: { min: [-200, -150, -25], max: [200, 150, 25] }, source: undefined }
  },
  stop() {}
}
/** A store whose converted meshes are numbered 1, 2, …: in the app the number is drawn at random (tested below). */
const store = (give: Importer | string = importer): ScanStore => {
  let meshes = 0
  return new ScanStore({ dirOf: (id) => (id === 'bracket' ? dir : undefined), importer: () => give, now: () => new Date('2026-10-10T09:00:00.000Z'), meshNumber: () => ++meshes })
}
const file = (): { next: number; scans: ScanInfo[] } => JSON.parse(readFileSync(join(dir, '.torno', 'scans.json'), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-scans-'))
  dir = join(root, 'bracket')
  mkdirSync(dir)
  mkdirSync(join(root, 'downloads'))
  source = join(root, 'downloads', 'Box.STL')
  writeFileSync(source, stl(box()))
  ran = []
  fails = null
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ScanStore', () => {
  it('imports a scan into .torno/scans/S1, and records its source without touching it', async () => {
    const before = readFileSync(source)
    const scan = await store().import('bracket', source)
    expect(scan).toMatchObject({ id: 'S1', name: 'Box.STL', source: { path: source, bytes: 684, sha256: 'ab'.repeat(32) }, imported: { unit: 'mm', triangles: 12 }, alignments: {}, sourceState: 'present', meshState: 'ok' })
    expect(ran[0].args[1]).toBe(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect(file()).toMatchObject({ next: 2, scans: [{ id: 'S1' }] })
    expect(readFileSync(join(dir, '.torno', 'scans', '.gitignore'), 'utf8')).toBe('mesh*.bin\n')
    expect(readFileSync(source).equals(before)).toBe(true)
    expect(readdirSync(join(root, 'downloads'))).toEqual(['Box.STL'])
    // Nothing of the object's folder but .torno was written.
    expect(readdirSync(dir)).toEqual(['.torno'])
  })

  it('never gives an id twice: not after a removal, not after an import that failed', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.remove('bracket', 'S1')
    expect(existsSync(join(dir, '.torno', 'scans', 'S1'))).toBe(false)
    fails = 'Box.STL could not be read: bad header'
    await expect(scans.import('bracket', source)).rejects.toThrow('Box.STL could not be read: bad header')
    expect(existsSync(join(dir, '.torno', 'scans', 'S2'))).toBe(false)
    fails = null
    expect((await scans.import('bracket', source)).id).toBe('S3')
    expect(file().next).toBe(4)
    // And a store that reads the file afresh goes on from there.
    expect((await store().import('bracket', source)).id).toBe('S4')
  })

  it('refuses what is no scan file, and a workspace no process may run in', async () => {
    await expect(store().import('bracket', 'relative.stl')).rejects.toThrow('give the whole path of the file')
    await expect(store().import('bracket', join(root, 'downloads', 'part.3mf'))).rejects.toThrow('part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl')
    await expect(store('This workspace has a pyproject.toml but no .venv. Run `uv sync` in /ws once, then reopen it.').import('bracket', source)).rejects.toThrow('no .venv')
    await expect(store().import('nothing', source)).rejects.toThrow('no object named nothing')
    expect(existsSync(join(dir, '.torno'))).toBe(false)
  })

  it('goes on working when the source is moved, and says so', async () => {
    const scans = store()
    await scans.import('bracket', source)
    rmSync(source)
    const [scan] = await scans.list('bracket')
    expect(scan).toMatchObject({ sourceState: 'missing', meshState: 'ok' })
    expect((await scans.mesh('bracket', 'S1')).byteLength).toBe(64 + 96 + 144)
  })

  it('says when the source has changed since', async () => {
    const scans = store()
    await scans.import('bracket', source)
    utimesSync(source, new Date('2027-01-01'), new Date('2027-01-01'))
    expect((await scans.list('bracket'))[0].sourceState).toBe('changed')
  })

  it('says what to do when the mesh is gone, and that the source is too', async () => {
    const scans = store()
    await scans.import('bracket', source)
    rmSync(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect((await scans.list('bracket'))[0].meshState).toBe('missing')
    await expect(scans.mesh('bracket', 'S1')).rejects.toThrow(`S1's mesh is gone from ${join(dir, '.torno', 'scans', 'S1', 'mesh.bin')}. Import it again from ${source}`)
    rmSync(source)
    await expect(scans.mesh('bracket', 'S1')).rejects.toThrow(`Import it again from ${source}, which is missing too`)
    await expect(scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })).rejects.toThrow("S1's mesh is gone")
  })

  it('keeps a transform for each layout, and drops them all when the unit is changed', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)
    await scans.align('bracket', 'S1', 'print', { ...ALIGNED, transform: { t: [9, 9, 9], q: [0, 0, 0, 2], s: 1 } }, YES)
    expect(file().scans[0].alignments.print.transform.q).toEqual([0, 0, 0, 1])
    expect(Object.keys((await scans.align('bracket', 'S1', 'print', null)).alignments)).toEqual(['assembly'])
    const converted = await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    expect(converted).toMatchObject({ imported: { unit: 'cm', assumed: { unit: false, up: false }, colours: 'none', bbox: { max: [200, 150, 25] } }, alignments: {} })
    expect(ran.at(-1)).toEqual({ what: 'convert', args: [join(dir, '.torno', 'scans', 'S1', 'mesh.1.bin'), { unit: 'mm', up: 'z' }, { unit: 'cm', up: 'z' }] })
  })

  it('tells each change once it is written, and the stages of an import', async () => {
    const scans = store()
    const told: string[] = []
    scans.on('changed', (m) => told.push(`${m.objectId}: ${m.scans.map((s) => s.id).join(' ')}`))
    scans.on('progress', (m) => told.push(`${m.name}: ${m.stage}`))
    await scans.import('bracket', source)
    await scans.rename('bracket', 'S1', '  engine bay  ')
    expect(told).toEqual(['Box.STL: reading', 'Box.STL: null', 'bracket: S1', 'bracket: S1'])
    expect(file().scans[0].name).toBe('engine bay')
    await expect(scans.rename('bracket', 'S1', ' ')).rejects.toThrow('a scan needs a name')
    await expect(scans.rename('bracket', 'S9', 'x')).rejects.toThrow('no scan S9; scans: S1')
  })

  it('sets a file that is no scans file aside and starts past every id it held', async () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', 'scans.json'), '{"next": 3, "scans": [{"id": "S7", ')
    expect(await store().list('bracket')).toEqual([])
    expect(readdirSync(join(dir, '.torno')).some((name) => name.startsWith('scans.json.corrupt-'))).toBe(true)
    expect((await store().import('bracket', source)).id).toBe('S8')
  })

  // Beyond the brief's tests: what the store does that those do not pin.

  it('refuses a file of its own folder, before anything is written', async () => {
    mkdirSync(join(dir, '.torno', 'scans', 'S1'), { recursive: true })
    const own = join(dir, '.torno', 'scans', 'S1', 'copy.stl')
    writeFileSync(own, stl(box()))
    await expect(store().import('bracket', own)).rejects.toThrow("copy.stl is in this object's .torno folder")
    expect(ran).toEqual([])
    expect(existsSync(join(dir, '.torno', 'scans.json'))).toBe(false)
  })

  it('answers for the other scans while a file is being imported', async () => {
    let finish!: () => void
    let begun!: () => void
    const running = new Promise<void>((resolve) => (begun = resolve))
    const slow: Importer = {
      ...importer,
      async import(from, out, opts, onStage) {
        await new Promise<void>((resolve) => {
          finish = resolve
          begun()
        })
        return importer.import(from, out, opts, onStage)
      }
    }
    const scans = store(slow)
    const pending = scans.import('bracket', source)
    await running
    expect(await scans.list('bracket')).toEqual([])
    // The id is taken, and on the disk, before the process has said anything.
    expect(file()).toEqual({ next: 2, scans: [] })
    expect(scans.settled()).not.toBeNull()
    finish()
    expect((await pending).id).toBe('S1')
    await scans.settled()
    expect(scans.settled()).toBeNull()
  })

  it('keeps nothing of an import whose answer is no scan', async () => {
    const odd: Importer = { ...importer, import: async (from, out, opts, onStage) => ({ ...(await importer.import(from, out, opts, onStage)), bbox: { min: [0, 0, Number.NaN], max: [1, 1, 1] } }) }
    await expect(store(odd).import('bracket', source)).rejects.toThrow('the import of Box.STL did not say what it wrote')
    expect(existsSync(join(dir, '.torno', 'scans', 'S1'))).toBe(false)
    expect(file()).toEqual({ next: 2, scans: [] })
  })

  it('starts no process for a workspace that was left, and tells nothing of one', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const told: string[] = []
    scans.on('changed', (m) => told.push(m.objectId))
    const renamed = scans.rename('bracket', 'S1', 'kept')
    const converted = scans.convert('bracket', 'S1', { unit: 'm', up: 'z' })
    scans.forget()
    await renamed
    await expect(converted).rejects.toThrow('the workspace was closed')
    expect(ran.filter((r) => r.what === 'convert')).toEqual([])
    expect(told).toEqual([])
    // What was written for the workspace that was left is what the next reading finds.
    expect((await scans.list('bracket'))[0].name).toBe('kept')
  })

  it('takes the unit and the axis a scan has as chosen, and leaves its alignments', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)
    const same = await scans.convert('bracket', 'S1', { unit: 'mm', up: 'z' })
    expect(same.imported.assumed).toEqual({ unit: false, up: false })
    expect(Object.keys(same.alignments)).toEqual(['assembly'])
    expect(ran.filter((r) => r.what === 'convert')).toEqual([])
    await expect(scans.convert('bracket', 'S1', { unit: 'ft' as 'mm', up: 'z' })).rejects.toThrow('a scan is in mm, cm, m or in')
  })

  it('tells what a check of an alignment found with the scans, and never writes it', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)
    const told: ScanInfo[][] = []
    scans.on('changed', (m) => told.push(m.scans))
    const check = { revision: 3, of: 4, off: 1, worst: 2.5, moved: [] }
    await scans.checked('bracket', 'S1', 'assembly', check)
    // Of a layout it is not aligned in, and of a scan that is gone, nothing is kept.
    await scans.checked('bracket', 'S1', 'print', check)
    await scans.checked('bracket', 'S9', 'assembly', check)
    expect(told).toHaveLength(1)
    expect(told[0][0].checks).toEqual({ assembly: check })
    expect(JSON.stringify(file())).not.toContain('checks')
    // Aligned anew, it has not been checked.
    expect((await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)).checks).toEqual({})
    await scans.checked('bracket', 'S1', 'assembly', check)
    scans.forget()
    expect((await scans.list('bracket'))[0].checks).toEqual({})
  })

  it('refuses an alignment that is none, and keeps only what one has', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await expect(scans.align('bracket', 'S1', '', ALIGNED)).rejects.toThrow('name it')
    await expect(scans.align('bracket', 'S1', 'assembly', { ...ALIGNED, transform: { ...ALIGNED.transform, s: 0 } })).rejects.toThrow('that is not an alignment')
    await expect(scans.align('bracket', 'S1', 'assembly', { ...ALIGNED, steps: [] })).rejects.toThrow('that is not an alignment')
    const pairs = Array.from({ length: 70 }, (_, n) => ({ scan: [n, 0, 0] as [number, number, number], model: [n, 1, 0] as [number, number, number], residual: 1 }))
    const kept = await scans.align('bracket', 'S1', '__proto__', { ...ALIGNED, transform: { t: [0, 0, 0], q: [0, 0, 0, -2], s: 1 }, pairs: pairs.slice(0, 64), extra: 1 } as ScanAlignment, YES)
    expect(Object.keys(kept.alignments)).toEqual(['__proto__'])
    const alignment = file().scans[0].alignments['__proto__']
    expect(alignment.transform.q).toEqual([0, 0, 0, 1])
    expect(alignment.pairs).toHaveLength(64)
    expect(alignment).not.toHaveProperty('extra')
    // A turn that is none (all zeros) is no alignment: it is not taken for no turn.
    await expect(scans.align('bracket', 'S1', 'assembly', { ...ALIGNED, transform: { t: [0, 0, 0], q: [0, 0, 0, 0], s: 1 } }, YES)).rejects.toThrow('that is not an alignment')
  })

  it('works out the residuals of an alignment itself, whatever it is told', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const told = { ...ALIGNED, steps: ['pairs' as const], rms: 0, scaled: false, transform: { t: [0, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], s: 2 },
      pairs: [{ scan: [1, 0, 0] as [number, number, number], model: [2, 0, 3] as [number, number, number], residual: 0 }, { scan: [0, 1, 0] as [number, number, number], model: [0, 2, 0] as [number, number, number], residual: 99 }] }
    const kept = (await scans.align('bracket', 'S1', 'print', told, { rough: true, scaled: true })).alignments.print
    expect(kept.pairs!.map((p) => p.residual)).toEqual([3, 0])
    expect(kept.rms).toBeCloseTo(Math.sqrt(4.5), 9)
    expect(kept.scaled).toBe(true)
  })

  // Task 5, the controller's rulings.
  const pair = (scan: [number, number, number], model: [number, number, number]) => ({ scan, model, residual: 0 })
  const FITTED: ScanAlignment = { ...ALIGNED, steps: ['pairs'], transform: { t: [5, 0, 1], q: [0, 0, 0, 1], s: 1 }, pairs: [pair([0, 0, 0], [5, 0, 1]), pair([10, 0, 0], [15, 0, 1]), pair([0, 10, 0], [5, 10, 1])] }

  it('keeps a rough alignment only with the person’s yes, and says why it is rough', async () => {
    const scans = store()
    await scans.import('bracket', source)
    // Fix round 1 (R-basis): rough is a doubtful fit of pairs. Two pairs are one.
    const two = { ...FITTED, pairs: FITTED.pairs!.slice(0, 2) }
    await expect(scans.align('bracket', 'S1', 'assembly', two)).rejects.toThrow('this alignment is rough (it has 2 pairs of points: it takes three that are not in a line to fix a scan): it is kept only once that is accepted')
    expect(file().scans[0].alignments).toEqual({})
    // A fit of three pairs that are not in a line needs no yes, and is not rough; the caller's word for it counts for nothing.
    const sound = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, rough: 'so they say' })).alignments.assembly
    expect(sound).not.toHaveProperty('rough')
    // What it rests on is worked out from its steps and its pairs wherever it is said, and is in no file (fix round 2, m7).
    expect(basisOf(sound)).toEqual({ basis: 'pairs', movedByHand: false })
    expect(sound).not.toHaveProperty('basis')
    const rough = (await scans.align('bracket', 'S1', 'print', two, YES)).alignments.print
    expect(rough.rough).toBe('it has 2 pairs of points: it takes three that are not in a line to fix a scan')
    expect(file().scans[0].alignments.print.rough).toBe(rough.rough)
  })

  it('keeps a scan placed by hand, or by its floor alone, without a yes: it is said as what it is', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const byHand = (await scans.align('bracket', 'S1', 'assembly', ALIGNED)).alignments.assembly
    expect(basisOf(byHand)).toEqual({ basis: 'hand', movedByHand: false })
    expect(byHand).not.toHaveProperty('rough')
    const floor = (await scans.align('bracket', 'S1', 'print', { ...ALIGNED, steps: ['floor'], rms: 0.4, floor: { point: [0, 0, 0] } })).alignments.print
    expect(floor).toMatchObject({ rms: 0.4 })
    expect(basisOf(floor)).toEqual({ basis: 'floor', movedByHand: false })
    expect(floor).not.toHaveProperty('rough')
    // A fit moved by hand afterwards says so.
    await scans.align('bracket', 'S1', 'print', FITTED)
    const moved = (await scans.align('bracket', 'S1', 'print', { ...FITTED, steps: ['pairs', 'nudge'], transform: { ...FITTED.transform, t: [5, 0, 30] } })).alignments.print
    expect(basisOf(moved)).toEqual({ basis: 'pairs', movedByHand: true })
  })

  it('keeps a scale other than one only when the person chose to keep it', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const scaled = { ...FITTED, transform: { ...FITTED.transform, s: 1.02 }, pairs: FITTED.pairs!.map((p) => ({ ...p, model: [5 + 1.02 * p.scan[0], 1.02 * p.scan[1], 1] as [number, number, number] })) }
    await expect(scans.align('bracket', 'S1', 'assembly', scaled)).rejects.toThrow('this alignment changes the size of the scan (× 1.02): it is kept only when that scale was chosen')
    expect((await scans.align('bracket', 'S1', 'assembly', scaled, { scaled: true })).alignments.assembly).toMatchObject({ scaled: true, transform: { s: 1.02 } })
  })

  it('keeps the alignment before the last for one undo, and nothing of it from a caller', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await expect(scans.undoAlign('bracket', 'S1', 'assembly')).rejects.toThrow('S1 is not aligned in assembly: there is nothing to undo')
    const first = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, before: FITTED, sourceChanged: true })).alignments.assembly
    // The first there is: before it the scan was not aligned, and that is what an undo goes back to.
    expect(first.before).toBeNull()
    expect(first).not.toHaveProperty('sourceChanged')
    const second = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, steps: ['pairs', 'nudge'], transform: { ...FITTED.transform, t: [5, 0, 2] } })).alignments.assembly
    expect(second.before).toMatchObject({ steps: ['pairs'], transform: { t: [5, 0, 1] } })
    expect(second.before).not.toHaveProperty('before')
    const told: ScanInfo[][] = []
    scans.on('changed', (m) => told.push(m.scans))
    await scans.checked('bracket', 'S1', 'assembly', { revision: 3, of: 3, off: 0, worst: 0, moved: [] })
    const undone = await scans.undoAlign('bracket', 'S1', 'assembly')
    expect(undone.alignments.assembly).toMatchObject({ steps: ['pairs'], transform: { t: [5, 0, 1] } })
    // One step back and no further; what was checked was of the alignment that is gone.
    expect(undone.alignments.assembly).not.toHaveProperty('before')
    expect(undone.checks).toEqual({})
    expect(file().scans[0].alignments.assembly.transform.t).toEqual([5, 0, 1])
    await expect(scans.undoAlign('bracket', 'S1', 'assembly')).rejects.toThrow('there is nothing to undo')
    // Back from the first alignment is not aligned.
    await scans.align('bracket', 'S1', 'print', FITTED)
    expect((await scans.undoAlign('bracket', 'S1', 'print')).alignments).not.toHaveProperty('print')
  })

  it('marks every alignment of a scan read again from a changed source, until it is aligned again or said to hold', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', FITTED)
    await scans.align('bracket', 'S1', 'print', FITTED)
    // Read again from the same file: nothing is in doubt.
    expect((await scans.reimport('bracket', 'S1')).scan.alignments.assembly).not.toHaveProperty('sourceChanged')
    const changed: Importer = { ...importer, import: async (...args) => ({ ...(await importer.import(...args)), source: { bytes: 684, sha256: 'cd'.repeat(32) } }) }
    const later = store(changed)
    const again = await later.reimport('bracket', 'S1')
    expect(again.sourceChanged).toBe(true)
    expect(again.scan.alignments).toMatchObject({ assembly: { sourceChanged: true }, print: { sourceChanged: true } })
    // It is in the file: it is still said after torno was closed.
    expect(file().scans[0].alignments.print.sourceChanged).toBe(true)
    expect((await store().list('bracket'))[0].alignments.assembly.sourceChanged).toBe(true)
    // Aligned again in one layout, said to hold in the other.
    expect((await later.align('bracket', 'S1', 'assembly', FITTED)).alignments.assembly).not.toHaveProperty('sourceChanged')
    const held = await later.alignmentHolds('bracket', 'S1', 'print', { revision: 5, frame: { base: [0, 0, 0] }, held: [] })
    expect(held.alignments.print).not.toHaveProperty('sourceChanged')
    expect(file().scans[0].alignments.print).not.toHaveProperty('sourceChanged')
    await expect(later.alignmentHolds('bracket', 'S1', 'nowhere', { revision: 5, frame: {}, held: [] })).rejects.toThrow('S1 is not aligned in nowhere')
    // Fix round 2: with nothing of the model to hold it against (the last check found it in place), only the doubt of the source goes: no confirmation, the check kept.
    await later.reimport('bracket', 'S1')
    await later.align('bracket', 'S1', 'assembly', FITTED)
    const other: Importer = { ...importer, import: async (...args) => ({ ...(await importer.import(...args)), source: { bytes: 684, sha256: 'ef'.repeat(32) } }) }
    const third = store(other)
    await third.reimport('bracket', 'S1')
    const check = { revision: 5, of: 0, off: 0, worst: 0, moved: [] }
    await third.checked('bracket', 'S1', 'assembly', check)
    const plain = await third.alignmentHolds('bracket', 'S1', 'assembly', null)
    expect(plain.alignments.assembly).not.toHaveProperty('sourceChanged')
    expect(plain.alignments.assembly).not.toHaveProperty('confirmed')
    expect(plain.checks).toEqual({ assembly: check })
  })

  // Fix round 1 (R-check).
  it('keeps what the last build found of an alignment when the scan is read again: that is of the model, not of the mesh', async () => {
    let other = false
    const scans = store({ ...importer, import: async (...args) => ({ ...(await importer.import(...args)), ...(other ? { source: { bytes: 684, sha256: 'cd'.repeat(32) } } : {}) }) })
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', FITTED)
    const check = { revision: 3, of: 3, off: 2, worst: 6.2, moved: [] }
    await scans.checked('bracket', 'S1', 'assembly', check)
    other = true
    const again = await scans.reimport('bracket', 'S1')
    expect(again.sourceChanged).toBe(true)
    expect(again.scan.checks).toEqual({ assembly: check })
  })

  it('marks the alignment before too when the source changed: an undo does not bring back one that says nothing of it', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', FITTED)
    await scans.align('bracket', 'S1', 'assembly', { ...FITTED, steps: ['pairs', 'nudge'], transform: { ...FITTED.transform, t: [5, 0, 2] } })
    const changed: Importer = { ...importer, import: async (...args) => ({ ...(await importer.import(...args)), source: { bytes: 684, sha256: 'cd'.repeat(32) } }) }
    const later = store(changed)
    expect((await later.reimport('bracket', 'S1')).scan.alignments.assembly).toMatchObject({ sourceChanged: true, before: { sourceChanged: true } })
    const undone = await later.undoAlign('bracket', 'S1', 'assembly')
    expect(undone.alignments.assembly).toMatchObject({ steps: ['pairs'], sourceChanged: true })
  })

  it('records that the person said an alignment still holds, against the model as it then was, and forgets it when it is aligned anew', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', { ...FITTED, frame: { base: [0, 0, 0], lid: [45, 0, 0] } })
    const held = await scans.alignmentHolds('bracket', 'S1', 'assembly', { revision: 7, frame: { base: [0, 0, 0], lid: [50, 0, 0] }, held: [[0, 0, 0], [0, 0, 6.2], null] })
    const kept = held.alignments.assembly
    expect(kept.confirmed).toEqual({ revision: 7, at: '2026-10-10T09:00:00.000Z', held: [[0, 0, 0], [0, 0, 6.2], null] })
    // The layout as torno spreads it now is what later builds are held against.
    expect(kept.frame).toEqual({ base: [0, 0, 0], lid: [50, 0, 0] })
    expect(file().scans[0].alignments.assembly.confirmed).toEqual(kept.confirmed)
    // Which build it was is of this run only.
    expect((await store().list('bracket'))[0].alignments.assembly.confirmed).toEqual({ at: '2026-10-10T09:00:00.000Z', held: [[0, 0, 0], [0, 0, 6.2], null] })
    // A caller cannot say it was confirmed; and fitted anew, it is not.
    const anew = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, confirmed: { revision: 9, at: 'x', held: [] } })).alignments.assembly
    expect(anew).not.toHaveProperty('confirmed')
    // Moved by hand, with the points it is tied to where they were: what was confirmed of the model is still so (fix round 2, m4).
    await scans.alignmentHolds('bracket', 'S1', 'assembly', { revision: 8, frame: { base: [0, 0, 0] }, held: [[1, 2, 3]] })
    const nudged = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, steps: ['pairs', 'nudge'], transform: { ...FITTED.transform, t: [5, 0, 2] } })).alignments.assembly
    expect(nudged.confirmed).toMatchObject({ revision: 8, held: [[1, 2, 3]] })
    // With a model end put on a part, it is tied to another point: that was never confirmed.
    const tied = { ...FITTED, steps: ['pairs', 'nudge'] as ScanAlignment['steps'], pairs: FITTED.pairs!.map((p, n) => (n === 0 ? { ...p, part: 'base' } : p)) }
    expect((await scans.align('bracket', 'S1', 'assembly', tied, YES)).alignments.assembly).not.toHaveProperty('confirmed')
    // What was confirmed is what an undo goes back to.
    expect((await scans.undoAlign('bracket', 'S1', 'assembly')).alignments.assembly.confirmed).toMatchObject({ held: [[1, 2, 3]] })
  })

  // Fix round 2 (C): how well the pairs were fitted is one number, where a hand left them is another.
  it('judges a fit of pairs by how well it fitted, through every move by hand after it: a nudge does not launder a rough fit', async () => {
    const scans = store()
    await scans.import('bracket', source)
    // Fitted 40 mm off its pairs: rough, and kept only on a yes.
    const off = { ...FITTED, transform: { ...FITTED.transform, t: [5, 0, 41] as [number, number, number] } }
    await expect(scans.align('bracket', 'S1', 'assembly', off)).rejects.toThrow('its pairs of points are left 40 mm apart (rms): more than 5 mm')
    // The same, said to have been moved by hand: there is no fit behind it that main knows of, so it is judged as it stands.
    await expect(scans.align('bracket', 'S1', 'assembly', { ...off, steps: ['pairs', 'nudge'] })).rejects.toThrow('its pairs of points are left 40 mm apart (rms): more than 5 mm')
    const kept = (await scans.align('bracket', 'S1', 'assembly', off, YES)).alignments.assembly
    expect(kept.fitRms).toBeCloseTo(40, 9)
    // Nudged: the fit is as rough as it was, wherever the hand puts it, and what the caller says of the fit counts for nothing.
    const nudged = { ...off, steps: ['pairs', 'nudge'] as ScanAlignment['steps'], transform: FITTED.transform, fitRms: 0 }
    await expect(scans.align('bracket', 'S1', 'assembly', nudged)).rejects.toThrow('this alignment is rough')
    const moved = (await scans.align('bracket', 'S1', 'assembly', nudged, YES)).alignments.assembly
    expect(moved.fitRms).toBeCloseTo(40, 9)
    expect(moved.rms).toBeCloseTo(0, 9)
    expect(moved.rough).toBe('its pairs of points were fitted 40 mm apart (rms): more than 5 mm')
    // A good fit moved 20 mm by hand is not rough: it fitted well, and is said to have been moved.
    await scans.align('bracket', 'S1', 'print', FITTED)
    const far = (await scans.align('bracket', 'S1', 'print', { ...FITTED, steps: ['pairs', 'typed'], transform: { ...FITTED.transform, t: [5, 0, 21] } })).alignments.print
    expect(far).not.toHaveProperty('rough')
    expect(far.fitRms).toBeCloseTo(0, 9)
    expect(far.rms).toBeCloseTo(20, 9)
    // With other pairs than those that were fitted, what was fitted says nothing.
    const others = { ...FITTED, steps: ['pairs', 'typed'] as ScanAlignment['steps'], transform: { ...FITTED.transform, t: [5, 0, 21] as [number, number, number] }, pairs: FITTED.pairs!.map((p) => ({ ...p, model: [p.model[0], p.model[1], 2] as [number, number, number] })) }
    await expect(scans.align('bracket', 'S1', 'print', others)).rejects.toThrow('this alignment is rough')
  })

  // Fix round 2 (m3).
  it('keeps nothing a check found of an alignment that was confirmed or made anew while the check ran', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const judged = (await scans.align('bracket', 'S1', 'assembly', FITTED)).alignments.assembly
    const check = { revision: 3, of: 3, off: 2, worst: 6.2, moved: [] }
    // "Still right" lands while the check is in flight: its verdict is of the alignment as it was held before.
    await scans.alignmentHolds('bracket', 'S1', 'assembly', { revision: 3, frame: { base: [0, 0, 0] }, held: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] })
    await scans.checked('bracket', 'S1', 'assembly', check, judged)
    expect((await scans.list('bracket'))[0].checks).toEqual({})
    // Judged as it now is: kept.
    const now = (await scans.list('bracket'))[0].alignments.assembly
    await scans.checked('bracket', 'S1', 'assembly', check, now)
    expect((await scans.list('bracket'))[0].checks).toEqual({ assembly: check })
  })

  it('keeps no more pairs than an alignment has room for, and refuses rather than keep a fit of more with the first of them', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const many = Array.from({ length: 65 }, (_, n) => pair([n, n % 7, 0], [n + 5, n % 7, 1]))
    await expect(scans.align('bracket', 'S1', 'assembly', { ...FITTED, pairs: many })).rejects.toThrow('an alignment keeps 64 pairs at most: this one has 65')
  })

  it('keeps the build an alignment was made on for this run only, and a turn written one way', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const kept = (await scans.align('bracket', 'S1', 'assembly', { ...FITTED, revision: 4, transform: { ...FITTED.transform, q: [0, 0, 0, -3] } })).alignments.assembly
    expect(kept.revision).toBe(4)
    expect(kept.transform.q).toEqual([0, 0, 0, 1])
    // Revisions count from 1 in every run: what the file says of one is dropped when it is read.
    expect((await store().list('bracket'))[0].alignments.assembly).not.toHaveProperty('revision')
  })

  it('says where the files of a scan it has read are, and of nothing that is no scan or no mark', async () => {
    const scans = store()
    // Not before the scans were read: which file is a scan's mesh is in its record.
    expect(scans.paths('bracket', 'S1')).toBeUndefined()
    await scans.import('bracket', source)
    const paths = scans.paths('bracket', 'S1')!
    expect(paths.mesh).toBe(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect(paths.mask('M7')).toBe(join(dir, '.torno', 'scans', 'S1', 'M7.mask'))
    expect(() => paths.mask('../M7')).toThrow('is no mark')
    expect(scans.paths('bracket', 'S2')).toBeUndefined()
    expect(scans.paths('bracket', '../S1')).toBeUndefined()
    expect(scans.paths('nothing', 'S1')).toBeUndefined()
  })

  it('leaves out of a file the scans that are none, and gives none of their ids again', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const kept = file()
    writeFileSync(join(dir, '.torno', 'scans.json'), JSON.stringify({ next: 2, scans: [...kept.scans, { ...kept.scans[0], id: 'S5', imported: { ...kept.scans[0].imported, unit: 'furlong' } }] }))
    const problems: string[] = []
    const fresh = store()
    fresh.on('problem', (m) => problems.push(m.message))
    expect((await fresh.list('bracket')).map((s) => s.id)).toEqual(['S1'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('scans.json.dropped-')
    expect(file().next).toBe(6)
  })
})

// What the review of this store found (task-2-review.md), each as the scenario it was shown by.
describe('ScanStore, after its review', () => {
  const scansDir = (): string => join(dir, '.torno', 'scans')
  const jsonPath = (): string => join(dir, '.torno', 'scans.json')
  /** An importer whose runs wait to be let go: `release()` lets the one waiting go on. */
  function held(what: 'import' | 'convert'): { importer: Importer; begun: Promise<void>; release(): void } {
    let release!: () => void
    let begin!: () => void
    const begun = new Promise<void>((resolve) => (begin = resolve))
    const wait = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve
        begin()
      })
    const slow: Importer = {
      ...importer,
      async import(from, out, opts, onStage) {
        if (what === 'import') await wait()
        return importer.import(from, out, opts, onStage)
      },
      async convert(mesh, from, to) {
        if (what === 'convert') await wait()
        return importer.convert(mesh, from, to)
      }
    }
    return { importer: slow, begun, release: () => release() }
  }

  // I1
  it('gives no id again when the scans file is lost while a scan folder is there', async () => {
    await store().import('bracket', source)
    writeFileSync(join(scansDir(), 'S1', 'M7.mask'), 'a region')
    const mesh = readFileSync(join(scansDir(), 'S1', 'mesh.bin'))
    rmSync(jsonPath())
    // Nothing is written for a file that is not there.
    expect(await store().list('bracket')).toEqual([])
    expect(existsSync(jsonPath())).toBe(false)
    fails = 'Box.STL could not be read'
    await expect(store().import('bracket', source)).rejects.toThrow('could not be read')
    fails = null
    expect((await store().import('bracket', source)).id).toBe('S3')
    // What was there is as it was: the folder of an id is never another scan's.
    expect(readdirSync(join(scansDir(), 'S1')).sort()).toEqual(['M7.mask', 'mesh.bin'])
    expect(readFileSync(join(scansDir(), 'S1', 'mesh.bin')).equals(mesh)).toBe(true)
  })

  it('gives no id again after an empty scans file, nor one a folder has that the file knows nothing of', async () => {
    await store().import('bracket', source)
    writeFileSync(jsonPath(), '')
    expect((await store().import('bracket', source)).id).toBe('S2')
    // A file from before S7 was imported: checked out again, with its mesh still on the disk.
    mkdirSync(join(scansDir(), 'S7'))
    writeFileSync(join(scansDir(), 'S7', 'mesh.bin'), 'kept')
    expect((await store().import('bracket', source)).id).toBe('S8')
    expect(readFileSync(join(scansDir(), 'S7', 'mesh.bin'), 'utf8')).toBe('kept')
  })

  // I2
  it('converts a copy of the mesh, and names it in the record before the old one goes', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const seen: string[][] = []
    scans.on('changed', () => seen.push(readdirSync(join(scansDir(), 'S1')).sort()))
    const converted = await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    expect(converted.imported.mesh).toBe('mesh.1.bin')
    expect(converted.meshState).toBe('ok')
    expect(file().scans[0].imported).toMatchObject({ unit: 'cm', mesh: 'mesh.1.bin' })
    expect(seen).toEqual([['mesh.1.bin']])
    expect(scans.paths('bracket', 'S1')!.mesh).toBe(join(scansDir(), 'S1', 'mesh.1.bin'))
    expect((await scans.mesh('bracket', 'S1')).byteLength).toBe(64 + 96 + 144)
    expect((await scans.convert('bracket', 'S1', { unit: 'm', up: 'z' })).imported.mesh).toBe('mesh.2.bin')
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.2.bin'])
  })

  it('leaves the mesh and its record as they were when a conversion fails, however far it got', async () => {
    const scans = store({
      ...importer,
      async convert(mesh) {
        // As a process killed after it wrote: the file it was given is of the new unit, and its temp file is left.
        writeFileSync(mesh, 'of the new unit')
        writeFileSync(`${mesh}.4242.tmp`, 'half')
        throw new Error('the import was stopped: the workspace was closed')
      }
    })
    await scans.import('bracket', source)
    const before = { record: file(), mesh: readFileSync(join(scansDir(), 'S1', 'mesh.bin')) }
    await expect(scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })).rejects.toThrow('was stopped')
    expect(file()).toEqual(before.record)
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.bin'])
    expect(readFileSync(join(scansDir(), 'S1', 'mesh.bin')).equals(before.mesh)).toBe(true)
  })

  it('clears away, when the scans are first read, the meshes no record names', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    // torno was killed in a conversion: before the record named the new mesh, and after, before the old one went.
    for (const name of ['mesh.bin', 'mesh.2.bin', 'mesh.2.bin.4242.tmp', 'importing', 'notes.txt']) writeFileSync(join(scansDir(), 'S1', name), 'left over')
    expect((await store().list('bracket'))[0].meshState).toBe('ok')
    expect(readdirSync(join(scansDir(), 'S1')).sort()).toEqual(['mesh.1.bin', 'notes.txt'])
  })

  // I3
  it('starts no import once its workspace was left, even in the moment before the process', async () => {
    let scans!: ScanStore
    // Left just after the importer was asked for: nothing of the import runs yet, so nothing is there to stop.
    scans = new ScanStore({ dirOf: () => dir, importer: () => (setImmediate(() => scans.forget()), slowToStart) })
    const slowToStart: Importer = importer
    // The folder is made on the disk before the process is started: the workspace is left meanwhile.
    await expect(scans.import('bracket', source)).rejects.toThrow('the workspace was closed')
    expect(ran).toEqual([])
    expect(existsSync(join(scansDir(), 'S1'))).toBe(false)
  })

  // I4
  it('keeps what was wrong with a scans file until it is dismissed, and says where the meshes are', async () => {
    await store().import('bracket', source)
    writeFileSync(jsonPath(), '{"next": 2, "scans": [{"id": "S1", ')
    const scans = store()
    const told: string[] = []
    scans.on('problem', (m) => told.push(m.message))
    expect(await scans.list('bracket')).toEqual([])
    expect(told).toHaveLength(1)
    expect(await scans.problem('bracket')).toBe(told[0])
    expect(told[0]).toContain('scans.json.corrupt-')
    expect(told[0]).toContain('still in .torno/scans/')
    // The meshes are what is left to recover from: none is cleared away.
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.bin'])
    scans.forget()
    expect(await scans.problem('bracket')).toBe(told[0])
    await scans.dismissProblem('bracket')
    expect(await scans.problem('bracket')).toBeNull()
    expect(told).toHaveLength(1)
  })

  // I5
  it('answers for the scans of an object while one of them waits to be converted', async () => {
    const slow = held('convert')
    const scans = store(slow.importer)
    await scans.import('bracket', source)
    const converting = scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    await slow.begun
    expect((await scans.list('bracket')).map((s) => s.imported.unit)).toEqual(['mm'])
    expect((await scans.mesh('bracket', 'S1')).byteLength).toBe(64 + 96 + 144)
    expect((await scans.rename('bracket', 'S1', 'engine bay')).name).toBe('engine bay')
    await expect(scans.convert('bracket', 'S1', { unit: 'm', up: 'z' })).rejects.toThrow('S1 is being converted or imported again already')
    expect(scans.settled()).not.toBeNull()
    slow.release()
    // What was done to it meanwhile is kept.
    expect(await converting).toMatchObject({ name: 'engine bay', imported: { unit: 'cm', mesh: 'mesh.1.bin' } })
  })

  it('says which scans have their files written right now: one being converted, and one whose first import has its number and is no scan yet', async () => {
    const slow = held('convert')
    const scans = store(slow.importer)
    await scans.import('bracket', source)
    expect(scans.working('bracket')).toEqual([])
    const converting = scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    await slow.begun
    expect(scans.working('bracket')).toEqual(['S1'])
    expect(scans.working('no such')).toEqual([])
    slow.release()
    await converting
    expect(scans.working('bracket')).toEqual([])
    const first = held('import')
    const other = store(first.importer)
    const importing = other.import('bracket', source)
    await first.begun
    expect(other.working('bracket')).toEqual(['S2'])
    expect((await other.list('bracket')).map((scan) => scan.id)).toEqual(['S1'])
    first.release()
    await importing
    expect(other.working('bracket')).toEqual([])
  })

  it('keeps nothing of a conversion whose scan was removed meanwhile', async () => {
    const slow = held('convert')
    const scans = store(slow.importer)
    await scans.import('bracket', source)
    const converting = scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    await slow.begun
    await scans.remove('bracket', 'S1')
    slow.release()
    await expect(converting).rejects.toThrow('S1 was removed while it was being converted')
    expect(existsSync(join(scansDir(), 'S1'))).toBe(false)
    expect(file()).toEqual({ next: 2, scans: [] })
  })

  // M2
  it('clears away the folder of an id that was given and has no scan, but never one that holds a region', async () => {
    const scans = store()
    await scans.import('bracket', source)
    fails = 'no'
    await expect(scans.import('bracket', source)).rejects.toThrow('no')
    await expect(scans.import('bracket', source)).rejects.toThrow('no')
    fails = null
    // As after torno was killed in two imports: S2 with a whole mesh, S3 with a region someone kept there.
    for (const id of ['S2', 'S3']) {
      mkdirSync(join(scansDir(), id))
      for (const name of ['importing', 'mesh.bin', 'mesh.bin.4242.tmp']) writeFileSync(join(scansDir(), id, name), 'left over')
    }
    writeFileSync(join(scansDir(), 'S3', 'M4.mask'), 'a region')
    // And a folder with no sign of an import: what is left of a scan whose record was lost.
    mkdirSync(join(scansDir(), 'S7'))
    writeFileSync(join(scansDir(), 'S7', 'mesh.bin'), 'a mesh')
    await store().list('bracket')
    expect(readdirSync(scansDir()).sort()).toEqual(['.gitignore', 'S1', 'S3', 'S7'])
    expect(readdirSync(join(scansDir(), 'S3')).sort()).toEqual(['M4.mask', 'importing', 'mesh.bin'])
    expect(readdirSync(join(scansDir(), 'S7'))).toEqual(['mesh.bin'])
  })

  it('leaves the folder of an import that is under way when the scans are read again', async () => {
    const slow = held('import')
    const scans = store(slow.importer)
    const importing = scans.import('bracket', source)
    await slow.begun
    writeFileSync(join(scansDir(), 'S1', 'mesh.bin.4242.tmp'), 'being written')
    scans.forget()
    await scans.list('bracket')
    expect(readdirSync(join(scansDir(), 'S1')).sort()).toEqual(['importing', 'mesh.bin.4242.tmp'])
    slow.release()
    await importing.catch(() => {})
  })

  // M5
  it('records the source as it was before it was read: one rewritten meanwhile has changed', async () => {
    const scans = store({
      ...importer,
      async import(from, out, opts, onStage) {
        utimesSync(from, new Date('2027-01-01'), new Date('2027-01-01'))
        return importer.import(from, out, opts, onStage)
      }
    })
    expect((await scans.import('bracket', source)).sourceState).toBe('changed')
  })

  // M9
  it('refuses a file of its own folder that is reached by another name', async () => {
    await store().import('bracket', source)
    const link = join(root, 'downloads', 'link.stl')
    symlinkSync(join(scansDir(), 'S1', 'mesh.bin'), link)
    await expect(store().import('bracket', link)).rejects.toThrow("link.stl is in this object's .torno folder")
  })

  it('rejects, and does not throw, for an object the workspace has not', async () => {
    const scans = store()
    for (const ask of [() => scans.list('nothing'), () => scans.rename('nothing', 'S1', 'x'), () => scans.remove('nothing', 'S1'), () => scans.convert('nothing', 'S1', { unit: 'm', up: 'z' }), () => scans.align('nothing', 'S1', 'print', null), () => scans.checked('nothing', 'S1', 'print', null), () => scans.mesh('nothing', 'S1'), () => scans.problem('nothing')]) {
      let asked!: Promise<unknown>
      expect(() => (asked = ask())).not.toThrow()
      await expect(asked).rejects.toThrow('no object named nothing in the open workspace')
    }
  })

  // The addendum: a scan is imported again into its own id.
  it('reads a scan again from its source into the same id, as on a clone that has no mesh', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.rename('bracket', 'S1', 'engine bay')
    await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)
    await scans.checked('bracket', 'S1', 'assembly', { revision: 3, of: 4, off: 0, worst: 0.1, moved: [] })
    rmSync(join(scansDir(), 'S1'), { recursive: true })
    expect((await scans.list('bracket'))[0].meshState).toBe('missing')
    const told: string[] = []
    scans.on('progress', (m) => told.push(`${m.name}: ${m.stage}`))
    const again = await scans.reimport('bracket', 'S1')
    expect(again).toMatchObject({ sourceChanged: false, meshChanged: false, scan: { id: 'S1', name: 'engine bay', meshState: 'ok', sourceState: 'present', imported: { mesh: 'mesh.1.bin', unit: 'mm', assumed: { unit: true, up: true } } } })
    expect(Object.keys(again.scan.alignments)).toEqual(['assembly'])
    expect(Object.keys(again.scan.checks)).toEqual(['assembly'])
    // In the unit and with the axis it has: where it was aligned still holds.
    expect(ran.at(-1)).toEqual({ what: 'import', args: [source, join(scansDir(), 'S1', 'mesh.1.bin'), { unit: 'mm', up: 'z' }] })
    expect(told).toEqual(['Box.STL: reading', 'Box.STL: null'])
    expect(file()).toMatchObject({ next: 2, scans: [{ id: 'S1', imported: { mesh: 'mesh.1.bin' } }] })
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.1.bin'])
    expect((await scans.mesh('bracket', 'S1')).byteLength).toBe(64 + 96 + 144)
  })

  it('says when the source is another file than the one that was read, and has its alignments looked at again', async () => {
    const other: Importer = { ...importer, import: async (from, out, opts, onStage) => ({ ...(await importer.import(from, out, opts, onStage)), triangles: 14, source: { bytes: 684, sha256: 'cd'.repeat(32) } }) }
    const scans = store()
    await scans.import('bracket', source)
    await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    await scans.align('bracket', 'S1', 'assembly', ALIGNED, YES)
    await scans.checked('bracket', 'S1', 'assembly', { revision: 3, of: 4, off: 0, worst: 0.1, moved: [] })
    scans.forget()
    const later = store(other)
    await later.list('bracket')
    await later.checked('bracket', 'S1', 'assembly', { revision: 3, of: 4, off: 0, worst: 0.1, moved: [] })
    const again = await later.reimport('bracket', 'S1')
    expect(again).toMatchObject({ sourceChanged: true, meshChanged: true, scan: { id: 'S1', source: { sha256: 'cd'.repeat(32) }, imported: { unit: 'cm', triangles: 14, mesh: 'mesh.2.bin', assumed: { unit: false, up: false } }, checks: {} } })
    expect(Object.keys(again.scan.alignments)).toEqual(['assembly'])
    expect(ran.at(-1)!.args[2]).toEqual({ unit: 'cm', up: 'z' })
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.2.bin'])
  })

  it('imports nothing again without the source, and leaves the scan as it was when the import fails', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const before = { record: file(), mesh: readFileSync(join(scansDir(), 'S1', 'mesh.bin')) }
    fails = 'Box.STL could not be read: bad header'
    await expect(scans.reimport('bracket', 'S1')).rejects.toThrow('Box.STL could not be read: bad header')
    fails = null
    expect(file()).toEqual(before.record)
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.bin'])
    expect(readFileSync(join(scansDir(), 'S1', 'mesh.bin')).equals(before.mesh)).toBe(true)
    await expect(scans.reimport('bracket', 'S9')).rejects.toThrow('no scan S9; scans: S1')
    rmSync(source)
    const runs = ran.length
    await expect(scans.reimport('bracket', 'S1')).rejects.toThrow(`S1 cannot be imported again: its source ${source} is missing`)
    expect(ran).toHaveLength(runs)
  })

  // M10
  it('has a change on the disk before it tells it', async () => {
    const scans = store()
    const onDisk: string[] = []
    scans.on('changed', (m) => onDisk.push(`${m.scans.map((s) => s.name).join()} / ${file().scans.map((s) => s.name).join()}`))
    await scans.import('bracket', source)
    await scans.rename('bracket', 'S1', 'engine bay')
    await scans.remove('bracket', 'S1')
    expect(onDisk).toEqual(['Box.STL / Box.STL', 'engine bay / engine bay', ' / '])
  })
})

// What the second review found: each as the scenario it was shown by.
describe('ScanStore, after its second review', () => {
  const scansDir = (): string => join(dir, '.torno', 'scans')
  const jsonPath = (): string => join(dir, '.torno', 'scans.json')
  const failing = (): never => {
    throw new Error('a listener that fails')
  }

  // N1
  it('deletes no mesh a record does not name while the one it names is not there', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const older = readFileSync(jsonPath())
    await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    // The scans file of before the conversion is put back: it names mesh.bin, which is gone.
    writeFileSync(jsonPath(), older)
    writeFileSync(join(scansDir(), 'S1', 'mesh.1.bin.4242.tmp'), 'half')
    expect((await store().list('bracket'))[0].meshState).toBe('missing')
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.1.bin'])
  })

  // N2
  it('keeps what was committed when something fails after it', async () => {
    const complaints = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const scans = store()
      scans.on('changed', failing)
      const told: string[] = []
      scans.on('changed', (m) => told.push(m.scans.map((s) => s.imported.unit).join()))
      expect((await scans.import('bracket', source)).id).toBe('S1')
      expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.bin'])
      expect((await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })).imported.mesh).toBe('mesh.1.bin')
      expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.1.bin'])
      expect((await scans.reimport('bracket', 'S1')).scan.imported.mesh).toBe('mesh.2.bin')
      expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.2.bin'])
      expect((await store().list('bracket'))[0]).toMatchObject({ meshState: 'ok', imported: { unit: 'cm', mesh: 'mesh.2.bin' } })
      // A listener that fails keeps nothing from the others, and is said.
      expect(told).toEqual(['mm', 'cm', 'cm'])
      expect(complaints).toHaveBeenCalledTimes(3)
    } finally {
      complaints.mockRestore()
    }
  })

  // N3
  it('clears nothing away through a link: not a scan folder that is one, not a file that is one', async () => {
    const scans = store()
    await scans.import('bracket', source)
    fails = 'no'
    await expect(scans.import('bracket', source)).rejects.toThrow('no')
    fails = null
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    for (const name of ['importing', 'mesh.bin', 'mesh.5.bin', 'mesh.bin.4242.tmp']) writeFileSync(join(elsewhere, name), 'not torno\'s')
    // S2 was given and has no scan: a link of that name, with the marker of an import behind it.
    symlinkSync(elsewhere, join(scansDir(), 'S2'))
    symlinkSync(join(elsewhere, 'mesh.5.bin'), join(scansDir(), 'S1', 'mesh.5.bin'))
    await store().list('bracket')
    expect(readdirSync(elsewhere).sort()).toEqual(['importing', 'mesh.5.bin', 'mesh.bin', 'mesh.bin.4242.tmp'])
    expect(readdirSync(scansDir()).sort()).toEqual(['.gitignore', 'S1', 'S2'])
  })

  // N4
  it('reads again only a source it would have read the first time', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const kept = file()
    for (const [path, why] of [['relative/Box.STL', 'give the whole path of the file'], ['/etc/passwd', 'passwd is not a scan torno reads'], [join(scansDir(), 'S1', 'x.stl'), "is in this object's .torno folder"]] as const) {
      writeFileSync(jsonPath(), JSON.stringify({ ...kept, scans: [{ ...kept.scans[0], source: { ...kept.scans[0].source, path } }] }))
      const runs = ran.length
      await expect(store().reimport('bracket', 'S1')).rejects.toThrow(why)
      expect(ran).toHaveLength(runs)
    }
  })

  // N5
  it('names a new mesh as no process from before can have been told to', async () => {
    const names = new Set<string>()
    for (let n = 0; n < 4; n++) {
      const scans = new ScanStore({ dirOf: () => dir, importer: () => importer })
      const id = (await scans.import('bracket', source)).id
      const name = (await scans.convert('bracket', id, { unit: 'cm', up: 'z' })).imported.mesh!
      expect(name).toMatch(MESH_NAME)
      names.add(name)
    }
    expect(names.size).toBeGreaterThan(1)
    expect(names.has('mesh.1.bin')).toBe(false)
  })

  it('takes no name that is in the folder already, and clears away a mesh written late under an old one', async () => {
    const scans = store()
    await scans.import('bracket', source)
    writeFileSync(join(scansDir(), 'S1', 'mesh.1.bin'), 'of a process from before')
    expect((await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })).imported.mesh).toBe('mesh.2.bin')
    // That process ends at last, and puts its file where it was told to.
    writeFileSync(join(scansDir(), 'S1', 'mesh.1.bin'), 'late')
    await store().list('bracket')
    expect(readdirSync(join(scansDir(), 'S1'))).toEqual(['mesh.2.bin'])
  })

  // N6
  it('says where the files of a scan are after a write of a workspace that was left', async () => {
    let release!: () => void
    let begin!: () => void
    const begun = new Promise<void>((resolve) => (begin = resolve))
    const scans = store({
      ...importer,
      async import(from, out, opts, onStage) {
        await new Promise<void>((resolve) => {
          release = resolve
          begin()
        })
        return importer.import(from, out, opts, onStage)
      }
    })
    const importing = scans.import('bracket', source)
    await begun
    scans.forget()
    expect(await scans.list('bracket')).toEqual([])
    release()
    await importing
    expect(scans.paths('bracket', 'S1')?.mesh).toBe(join(scansDir(), 'S1', 'mesh.bin'))
  })

  it('says that a scan was removed while it was read again, in those words', async () => {
    let release!: () => void
    let begin!: () => void
    const begun = new Promise<void>((resolve) => (begin = resolve))
    let hold = false
    const scans = store({
      ...importer,
      async import(from, out, opts, onStage) {
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve
            begin()
          })
        }
        return importer.import(from, out, opts, onStage)
      }
    })
    await scans.import('bracket', source)
    hold = true
    const again = scans.reimport('bracket', 'S1')
    await begun
    await scans.remove('bracket', 'S1')
    release()
    await expect(again).rejects.toThrow('S1 was removed while it was being imported again')
    expect(existsSync(join(scansDir(), 'S1', 'mesh.1.bin'))).toBe(false)
  })
})

// M6
describe('what a scans file keeps', () => {
  const scan = (): Scan => ({
    id: 'S1',
    name: 'Box.STL',
    source: { path: '/dl/Box.STL', bytes: 684, mtimeMs: 1, sha256: 'ab'.repeat(32) },
    imported: { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, at: '2026-10-10T09:00:00.000Z' },
    alignments: {}
  })

  it('is a scan whose numbers can be what they say, in a file named as torno names a mesh', () => {
    expect(sanitiseScan(scan())).toEqual(scan())
    expect(sanitiseScan({ ...scan(), source: { ...scan().source, sha256: 'not a hash' } })).toBeNull()
    expect(sanitiseScan({ ...scan(), imported: { ...scan().imported, area: -1 } })).toBeNull()
    expect(sanitiseScan({ ...scan(), imported: { ...scan().imported, bbox: { min: [0, 0, 1], max: [1, 1, 0] } } })).toBeNull()
    expect(sanitiseScan({ ...scan(), imported: { ...scan().imported, mesh: 'mesh.3.bin' } })?.imported.mesh).toBe('mesh.3.bin')
    expect(sanitiseScan({ ...scan(), imported: { ...scan().imported, mesh: 'mesh.bin' } })?.imported).not.toHaveProperty('mesh')
    expect(sanitiseScan({ ...scan(), imported: { ...scan().imported, mesh: '../S2/mesh.bin' } })).toBeNull()
  })

  it('is an alignment no longer, no further and no wordier than one can be', () => {
    const steps = Array.from({ length: 20 }, (_, n) => (n < 19 ? 'nudge' : 'typed'))
    const long = 'p'.repeat(500)
    const kept = sanitiseAlignment({ ...ALIGNED, steps, pairs: [{ scan: [0, 0, 0], model: [1, 1, 1], part: long, residual: 0 }], floor: { part: long, point: [0, 0, 0] } })!
    expect(kept.steps).toEqual([...Array.from({ length: 7 }, () => 'nudge'), 'typed'])
    expect(kept.pairs![0]).not.toHaveProperty('part')
    expect(kept.floor).toEqual({ point: [0, 0, 0] })
    expect(sanitiseAlignment({ ...ALIGNED, transform: { ...ALIGNED.transform, t: [0, 2e9, 0] } })).toBeNull()
  })
})

describe('frameOf', () => {
  it('is how far each part of the layout was spread, and nothing of a layout the build has not', () => {
    const part = (layout: string, name: string, arranged?: [number, number, number]) => ({ layout, name, ...(arranged ? { arranged } : {}) })
    const scene = { parts: [part('print', 'tub'), part('print', 'lid', [277.361, 0, 0]), part('assembly', 'tub')] } as unknown as Scene
    expect(frameOf(scene, 'print')).toEqual({ tub: [0, 0, 0], lid: [277.361, 0, 0] })
    expect(frameOf(scene, 'main')).toBeNull()
    expect(frameOf(undefined, 'print')).toBeNull()
  })
})

describe('the masks of regions', () => {
  const folder = (): string => join(dir, '.torno', 'scans', 'S1')
  const bits = (...triangles: number[]): Uint8Array => {
    const made = new Uint8Array(2)
    for (const t of triangles) made[t >> 3] |= 1 << (t & 7)
    return made
  }

  it('writes a region as <scan>/<mark>.mask, the header and a bit a triangle, and reads it back', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.writeMask('bracket', 'S1', 'M7', bits(0, 9, 11))
    const written = readFileSync(join(folder(), 'M7.mask'))
    expect(written.subarray(0, 8).toString('ascii')).toBe('TORNOMSK')
    expect([written.readUInt32LE(8), written.readUInt32LE(12)]).toEqual([1, 12])
    expect([...written.subarray(16)]).toEqual([0b00000001, 0b00001010])
    expect((await scans.mask('bracket', 'S1', 'M7')).equals(written)).toBe(true)
    // No temp file is left beside it.
    expect(readdirSync(folder()).sort()).toEqual(['M7.mask', 'mesh.bin'])
    // Written anew each time: another file, which is what tells the kernel that it changed.
    const first = statSync(join(folder(), 'M7.mask')).ino
    await scans.writeMask('bracket', 'S1', 'M7', bits(1))
    expect(statSync(join(folder(), 'M7.mask')).ino).not.toBe(first)
  })

  it('refuses bits that do not fit the mesh, a triangle past its last, a name that is no mark and a scan that is not there', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await expect(scans.writeMask('bracket', 'S1', 'M7', new Uint8Array(3))).rejects.toThrow('M7 has 3 bytes of triangles, and S1 has 12 triangles: 2 bytes')
    await expect(scans.writeMask('bracket', 'S1', 'M7', bits(12))).rejects.toThrow('M7 names a triangle past the last of S1, which has 12')
    await expect(scans.writeMask('bracket', 'S1', '../M7', bits(1))).rejects.toThrow('../M7 is no mark')
    await expect(scans.writeMask('bracket', 'S9', 'M7', bits(1))).rejects.toThrow('no scan S9; scans: S1')
    await expect(scans.mask('bracket', 'S1', 'M8')).rejects.toThrow('M8 has no triangles on the disk: its file is gone from')
    await expect(scans.mask('bracket', 'S1', '../../scans')).rejects.toThrow('is no mark')
    expect(readdirSync(folder())).toEqual(['mesh.bin'])
    // Nothing is written into the folder of a scan that is gone.
    await scans.remove('bracket', 'S1')
    await expect(scans.writeMask('bracket', 'S1', 'M7', bits(1))).rejects.toThrow('no scan S1')
    expect(existsSync(folder())).toBe(false)
  })

  it('removes the mask of one region only, and all of them with their scan', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.writeMask('bracket', 'S1', 'M7', bits(0))
    await scans.writeMask('bracket', 'S1', 'M8', bits(1))
    await scans.removeMask('bracket', 'S1', 'M7')
    expect(readdirSync(folder()).sort()).toEqual(['M8.mask', 'mesh.bin'])
    // One that is not there, or of a scan that is gone, is nothing to remove.
    await scans.removeMask('bracket', 'S1', 'M7')
    await scans.removeMask('bracket', 'S9', 'M7')
    await scans.remove('bracket', 'S1')
    expect(existsSync(folder())).toBe(false)
  })

  it('keeps the masks through a conversion: the triangles are the same', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.writeMask('bracket', 'S1', 'M7', bits(0, 5))
    await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    expect([...(await scans.mask('bracket', 'S1', 'M7')).subarray(16)]).toEqual([0b00100001, 0])
  })
})

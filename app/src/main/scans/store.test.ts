import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanAlignment, ScanInfo } from '../../shared/scans'
import { box, meshBin, stl } from '../../test/scanFixtures'
import type { ImportReply, Importer } from './importer'
import type { Scene } from '../../shared/scene'
import { ScanStore, frameOf } from './store'

let root: string
let dir: string
let source: string
let ran: Array<{ what: string; args: unknown[] }>
let fails: string | null

const REPLY: ImportReply = { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, reduced: null, source: { bytes: 684, sha256: 'ab'.repeat(32) } }
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
const store = (give: Importer | string = importer): ScanStore => new ScanStore({ dirOf: (id) => (id === 'bracket' ? dir : undefined), importer: () => give, now: () => new Date('2026-10-10T09:00:00.000Z') })
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
    expect(readFileSync(join(dir, '.torno', 'scans', '.gitignore'), 'utf8')).toBe('mesh.bin\n')
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
    await scans.align('bracket', 'S1', 'assembly', ALIGNED)
    await scans.align('bracket', 'S1', 'print', { ...ALIGNED, transform: { t: [9, 9, 9], q: [0, 0, 0, 2], s: 1 } })
    expect(file().scans[0].alignments.print.transform.q).toEqual([0, 0, 0, 1])
    expect(Object.keys((await scans.align('bracket', 'S1', 'print', null)).alignments)).toEqual(['assembly'])
    const converted = await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    expect(converted).toMatchObject({ imported: { unit: 'cm', assumed: { unit: false, up: false }, colours: 'none', bbox: { max: [200, 150, 25] } }, alignments: {} })
    expect(ran.at(-1)).toEqual({ what: 'convert', args: [join(dir, '.torno', 'scans', 'S1', 'mesh.bin'), { unit: 'mm', up: 'z' }, { unit: 'cm', up: 'z' }] })
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
    await scans.align('bracket', 'S1', 'assembly', ALIGNED)
    const same = await scans.convert('bracket', 'S1', { unit: 'mm', up: 'z' })
    expect(same.imported.assumed).toEqual({ unit: false, up: false })
    expect(Object.keys(same.alignments)).toEqual(['assembly'])
    expect(ran.filter((r) => r.what === 'convert')).toEqual([])
    await expect(scans.convert('bracket', 'S1', { unit: 'ft' as 'mm', up: 'z' })).rejects.toThrow('a scan is in mm, cm, m or in')
  })

  it('tells what a check of an alignment found with the scans, and never writes it', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', ALIGNED)
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
    expect((await scans.align('bracket', 'S1', 'assembly', ALIGNED)).checks).toEqual({})
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
    const kept = await scans.align('bracket', 'S1', '__proto__', { ...ALIGNED, transform: { t: [0, 0, 0], q: [0, 0, 0, 0], s: 1 }, pairs, extra: 1 } as ScanAlignment)
    expect(Object.keys(kept.alignments)).toEqual(['__proto__'])
    const alignment = file().scans[0].alignments['__proto__']
    expect(alignment.transform.q).toEqual([0, 0, 0, 1])
    expect(alignment.pairs).toHaveLength(64)
    expect(alignment).not.toHaveProperty('extra')
  })

  it('says where the files of a scan are, and of nothing that is no scan or no mark', () => {
    const paths = store().paths('bracket', 'S2')!
    expect(paths.mesh).toBe(join(dir, '.torno', 'scans', 'S2', 'mesh.bin'))
    expect(paths.mask('M7')).toBe(join(dir, '.torno', 'scans', 'S2', 'M7.mask'))
    expect(() => paths.mask('../M7')).toThrow('is no mark')
    expect(store().paths('bracket', '../S2')).toBeUndefined()
    expect(store().paths('nothing', 'S2')).toBeUndefined()
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

describe('frameOf', () => {
  it('is how far each part of the layout was spread, and nothing of a layout the build has not', () => {
    const part = (layout: string, name: string, arranged?: [number, number, number]) => ({ layout, name, ...(arranged ? { arranged } : {}) })
    const scene = { parts: [part('print', 'tub'), part('print', 'lid', [277.361, 0, 0]), part('assembly', 'tub')] } as unknown as Scene
    expect(frameOf(scene, 'print')).toEqual({ tub: [0, 0, 0], lid: [277.361, 0, 0] })
    expect(frameOf(scene, 'main')).toBeNull()
    expect(frameOf(undefined, 'print')).toBeNull()
  })
})

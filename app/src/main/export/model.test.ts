import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Part, Scene } from '../../shared/scene'
import type { SceneFile } from '../../shared/scenefile'
import { ONE_OBJECT } from './build'
import { type FileCheck, type MadeFile, type ModelDeps, FAILED_CHECK, NEW_BUILD, NOT_SOLID, NO_PARTS, ONE_PART, checkModelFile, makeModelFile, modelArgs } from './model'
import { writeExport } from './save'

const root = mkdtempSync(join(tmpdir(), 'torno-export-model-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const part = (layout: string, name: string, extra: Partial<Part> = {}): Part =>
  ({ key: `${layout}:${name}`, name, layout, loc: { t: [0, 0, 0], q: [0, 0, 0, 1] }, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, volume: 1, solids: 1, faceCount: 6, edgeCount: 12, triangleCount: 12, valid: true, hash: name, mesh: {} as Part['mesh'], ...extra }) as Part

/** `tub`, `lid` and a `label` that is a face, in an assembly; `tub` and `lid` on the bed; `tub` and `lid` grouped as `box`. */
const SCENE: Scene = {
  model: 'hollow.py',
  layouts: ['assembly', 'print'],
  parts: [part('assembly', 'tub'), part('assembly', 'lid'), part('assembly', 'label', { solids: 0, volume: 0 }), part('print', 'tub'), part('print', 'lid', { arranged: [60, 0, 0] })],
  groups: [{ name: 'box', parts: ['tub', 'lid'] }],
  seconds: 0.1,
  output: ''
}

/** Deps of an object `hollow` at `revision`, whose kernel answers `export` with `bytes` and `export_check` with `check`; every query is kept. */
function deps(opts: { file?: SceneFile; bytes?: Buffer; check?: Partial<FileCheck>; revision?: number; onCheck?: () => void } = {}) {
  const asked: Array<{ name: string; args: Record<string, unknown>; blob?: boolean }> = []
  const state = { revision: opts.revision ?? 4 }
  const bytes = opts.bytes ?? Buffer.from('solid-ish bytes')
  const d: ModelDeps = {
    object: (id) => (id === 'hollow' ? { id: 'hollow', name: 'hollow', dir: '/ws/hollow', model: 'hollow.py' } : undefined) as ReturnType<ModelDeps['object']>,
    last: (id) => (id === 'hollow' ? { revision: state.revision, scene: SCENE } : undefined),
    sceneFile: async () => opts.file ?? { layers: {} },
    query: async <T,>(_id: string, name: string, args: object, o?: { blob?: boolean }): Promise<T> => {
      asked.push({ name, args: args as Record<string, unknown>, blob: o?.blob })
      if (name === 'export') {
        const a = args as { format: MadeFile['format']; layout: string; parts: string[]; tolerance?: number; angle?: number }
        const made: MadeFile = { format: a.format, layout: a.layout, parts: a.parts.map((n) => ({ name: n, solids: 1, volume: 1, volumeExact: true, triangles: 10 })), bytes: bytes.length, ...(a.format === 'step' ? {} : { triangles: 10 * a.parts.length, tolerance: a.tolerance, angle: a.angle }) }
        return { result: made, blob: bytes } as T
      }
      opts.onCheck?.()
      const path = (args as { path: string }).path
      // The worker reads the file it is given: it is whole when it is asked.
      expect(readFileSync(path)).toEqual(bytes)
      return { passed: true, problems: [], objects: [{ name: 'tub', solids: 1 }, { name: 'lid', solids: 1 }], triangles: 20, volumeDeviation: 0.04, ...opts.check } as T
    }
  }
  return { d, asked, state }
}

describe('the arguments of a file of the model', () => {
  it('a 3MF is of the bed unless asked, of every part switched on, in the colours torno draws them, at the print tolerance', async () => {
    const { d } = deps({ file: { layers: { lid: { color: '#123456' }, tub: { visible: false } } } })
    const { objectId, args } = await modelArgs(d, { objects: ['hollow'], marks: false, scans: [], format: '3mf' })
    expect(objectId).toBe('hollow')
    expect(args).toMatchObject({ format: '3mf', layout: 'print', parts: ['lid'], tolerance: 0.01, angle: 5, name: 'hollow' })
    expect((args.colors as Record<string, string>).lid).toBe('#123456')
  })

  it('a STEP is of the assembly unless asked, with what has no solid too, and no tolerance', async () => {
    const { args } = await modelArgs(deps().d, { objects: ['hollow'], marks: false, scans: [], format: 'step' })
    expect(args).toMatchObject({ format: 'step', layout: 'assembly', parts: ['tub', 'lid', 'label'] })
    expect(args).not.toHaveProperty('tolerance')
  })

  it('takes a group for its parts, and what the sheet asks of the tolerance', async () => {
    const { args } = await modelArgs(deps().d, { objects: ['hollow'], marks: false, scans: [], format: '3mf', layout: 'assembly', parts: ['box'], tolerance: 0.05, angle: 10 })
    expect(args).toMatchObject({ layout: 'assembly', parts: ['tub', 'lid'], tolerance: 0.05, angle: 10 })
  })

  it('refuses what cannot be one file: several objects, no part, several parts of an STL, a part with no solid in a mesh', async () => {
    const { d } = deps()
    const asked = { objects: ['hollow'], marks: false, scans: [] }
    await expect(modelArgs(d, { ...asked, objects: ['hollow', 'other'], format: 'step' })).rejects.toThrow(ONE_OBJECT)
    await expect(modelArgs(d, { ...asked, format: 'step', parts: [] })).rejects.toThrow(NO_PARTS)
    await expect(modelArgs(d, { ...asked, format: 'stl', layout: 'assembly', parts: ['tub', 'lid'] })).rejects.toThrow(ONE_PART)
    await expect(modelArgs(d, { ...asked, format: '3mf', layout: 'assembly', parts: ['label'] })).rejects.toThrow(NOT_SOLID)
    await expect(modelArgs(d, { ...asked, format: 'stl', layout: 'assembly', parts: ['nothing'] })).rejects.toThrow('There is no nothing in assembly')
    await expect(modelArgs(d, { ...asked, format: 'stl', layout: 'nowhere', parts: ['tub'] })).rejects.toThrow('not in the build')
  })
})

describe('making and checking the file', () => {
  it('asks the kernel for the bytes, writes them, has that file read back, and only then gives it the name', async () => {
    const { d, asked } = deps()
    const file = await makeModelFile(d, { objects: ['hollow'], marks: false, scans: [], format: '3mf' })
    expect(asked[0]).toMatchObject({ name: 'export', blob: true })
    expect(file.revision).toBe(4)
    const path = join(root, 'plate.3mf')
    let checked
    await writeExport(path, file.bytes, async (beside) => {
      expect(beside.startsWith(`${path}.`) && beside.endsWith('.tmp')).toBe(true)
      expect(existsSync(path)).toBe(false)
      checked = await checkModelFile(d, file, beside)
    })
    expect(asked[1]).toMatchObject({ name: 'export_check', args: { format: '3mf', layout: 'print', parts: ['tub', 'lid'], tolerance: 0.01 } })
    expect(checked).toEqual({ format: '3mf', layout: 'print', parts: ['tub', 'lid'], triangles: 20, tolerance: 0.01, angle: 5, volumeDeviation: 0.04 })
    expect(readFileSync(path)).toEqual(file.bytes)
    expect(readdirSync(root).filter((name) => name.startsWith('plate'))).toEqual(['plate.3mf'])
  })

  it('a file that fails its check is not named, says why, and leaves nothing behind', async () => {
    const { d } = deps({ check: { passed: false, problems: ['lid: 12 sides of its triangles are of no other triangle: it is not closed'] } })
    const file = await makeModelFile(d, { objects: ['hollow'], marks: false, scans: [], format: 'stl', layout: 'print', parts: ['lid'] })
    const path = join(root, 'lid.stl')
    await expect(writeExport(path, file.bytes, async (beside) => void (await checkModelFile(d, file, beside)))).rejects.toThrow(`${FAILED_CHECK}: lid: 12 sides`)
    expect(readdirSync(root).filter((name) => name.startsWith('lid'))).toEqual([])
    // Nor is the file that had the name touched.
    writeFileSync(path, 'kept')
    await expect(writeExport(path, file.bytes, async (beside) => void (await checkModelFile(d, file, beside)))).rejects.toThrow(FAILED_CHECK)
    expect(readFileSync(path, 'utf8')).toBe('kept')
    expect(readdirSync(root).filter((name) => name.startsWith('lid'))).toEqual(['lid.stl'])
  })

  it('a build that lands while the file is checked has it fail: the shapes are no longer the file\'s', async () => {
    const holder: { state?: { revision: number } } = {}
    const { d, state } = deps({ onCheck: () => void (holder.state!.revision = 5) })
    holder.state = state
    const file = await makeModelFile(d, { objects: ['hollow'], marks: false, scans: [], format: 'step' })
    const path = join(root, 'whole.step')
    await expect(writeExport(path, file.bytes, async (beside) => void (await checkModelFile(d, file, beside)))).rejects.toThrow(NEW_BUILD)
    expect(readdirSync(root).filter((name) => name.startsWith('whole'))).toEqual([])
  })
})

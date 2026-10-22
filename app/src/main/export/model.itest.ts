import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Scene } from '../../shared/scene'
import { type RunningKernel, startKernel } from '../kernel/client'
import { type FileCheck, type ModelDeps, FAILED_CHECK, checkModelFile, makeModelFile } from './model'
import { writeExport } from './save'

// A file of the model made by the real kernel, written as `export:save` writes it, read back by the worker that made
// it and checked before it takes its name. On a copy of the fixtures; the files go to a folder of the test's own.
const KERNEL_DIR = resolve(__dirname, '../../../../kernel')

let root: string
let out: string
let kernel: RunningKernel
let scene: Scene

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-export-kernel-'))
  out = mkdtempSync(join(realpathSync(tmpdir()), 'torno-export-out-'))
  cpSync(join(KERNEL_DIR, 'tests/fixtures/ws'), root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  const built = await kernel.build(join(root, 'bracket'), 'bracket.py')
  if (!built.ok) throw new Error(`${built.error.kind}: ${built.error.message}`)
  scene = built.scene
}, 120_000)

afterAll(async () => {
  await kernel?.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
})

const deps = (): ModelDeps => ({
  object: (id) => (id === 'bracket' ? { id, name: 'bracket', dir: join(root, 'bracket'), model: 'bracket.py' } : undefined) as ReturnType<ModelDeps['object']>,
  last: (id) => (id === 'bracket' ? { revision: 1, scene } : undefined),
  sceneFile: async () => ({ layers: {} }),
  query: (_id, name, args, opts) => kernel.query(join(root, 'bracket'), name, args, opts)
})

describe('a file of the model, by the real kernel', () => {
  it('a 3MF of the bed is made, read back, checked and named', async () => {
    const d = deps()
    const file = await makeModelFile(d, { objects: ['bracket'], marks: false, scans: [], format: '3mf' })
    expect(file.bytes.subarray(0, 2).toString()).toBe('PK')
    expect(file.made).toMatchObject({ format: '3mf', layout: 'print', parts: [{ name: 'base' }, { name: 'post' }], tolerance: 0.01, angle: 5 })
    const path = join(out, 'bracket.3mf')
    let checked
    await writeExport(path, file.bytes, async (beside) => void (checked = await checkModelFile(d, file, beside)))
    expect(checked).toMatchObject({ format: '3mf', layout: 'print', parts: ['base', 'post'], triangles: file.made.triangles })
    expect(checked!.volumeDeviation).toBeGreaterThan(0)
    expect(checked!.volumeDeviation).toBeLessThan(0.5)
    expect(readdirSync(out)).toEqual(['bracket.3mf'])
  }, 60_000)

  it('a STEP of the assembly reads back with its solids and their volumes', async () => {
    const d = deps()
    const file = await makeModelFile(d, { objects: ['bracket'], marks: false, scans: [], format: 'step' })
    expect(file.bytes.subarray(0, 13).toString()).toBe('ISO-10303-21;')
    const path = join(out, 'bracket.step')
    let checked
    await writeExport(path, file.bytes, async (beside) => void (checked = await checkModelFile(d, file, beside)))
    expect(checked).toMatchObject({ format: 'step', layout: 'assembly', parts: ['base', 'post'], solids: 2 })
    expect(readFileSync(path)).toEqual(file.bytes)
  }, 60_000)

  it('a file cut short fails its check: it is not named, nothing is left, and the person is told why', async () => {
    const d = deps()
    const file = await makeModelFile(d, { objects: ['bracket'], marks: false, scans: [], format: 'stl', layout: 'assembly', parts: ['post'] })
    const short = { ...file, bytes: file.bytes.subarray(0, file.bytes.length - 50) }
    const path = join(out, 'post.stl')
    await expect(writeExport(path, short.bytes, async (beside) => void (await checkModelFile(d, short, beside)))).rejects.toThrow(`${FAILED_CHECK}: the file says it has`)
    expect(readdirSync(out).filter((name) => name.startsWith('post'))).toEqual([])
    // The same bytes whole pass.
    await writeExport(path, file.bytes, async (beside) => void (await checkModelFile(d, file, beside)))
    expect(readdirSync(out).filter((name) => name.startsWith('post'))).toEqual(['post.stl'])
    // And the worker reads only the path it is given.
    writeFileSync(join(out, 'garbage.stl'), 'solid nothing')
    const said = await kernel.query<FileCheck>(join(root, 'bracket'), 'export_check', { ...file.args, path: join(out, 'garbage.stl') })
    expect(said.passed).toBe(false)
  }, 60_000)
})

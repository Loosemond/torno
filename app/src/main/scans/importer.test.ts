import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanCommand } from '../kernel/client'
import { processImporter, replyOf } from './importer'

describe('the import process', () => {
  it('is the kernel package with its scans extra, in the environment of the workspace and never synced', () => {
    expect(scanCommand({ workspaceRoot: '/ws', hasProject: true, kernelDir: '/torno/kernel' }, ['import', '/a.stl', '/out.bin'])).toEqual(
      ['uv', 'run', '--no-sync', '--project', '/ws', '--with-editable', '/torno/kernel[scans]', 'python', '-m', 'torno_kernel.scans', 'import', '/a.stl', '/out.bin'])
    expect(scanCommand({ workspaceRoot: '/ws', hasProject: false, kernelDir: '/torno/kernel' }, ['convert', '/m.bin'])).toEqual(
      ['uv', 'run', '--project', '/torno/kernel', '--extra', 'scans', 'python', '-m', 'torno_kernel.scans', 'convert', '/m.bin'])
  })

  it('answers with the last line it wrote, or rejects with its own words', () => {
    expect(replyOf('noise\n{"ok": true, "unit": "mm", "triangles": 12}\n', 0, '')).toMatchObject({ unit: 'mm', triangles: 12 })
    expect(() => replyOf('{"ok": false, "error": {"kind": "no_triangles", "message": "cloud.ply has no triangles"}}\n', 1, '')).toThrow('cloud.ply has no triangles')
    expect(() => replyOf('', 2, 'error: No solution found when resolving `--with` dependencies\n  trimesh was not found in the cache')).toThrow(/the import could not be started: .*trimesh was not found in the cache/s)
    expect(() => replyOf('Traceback…', null, '')).toThrow('the import process ended without an answer')
  })

  it('stops a process that takes too long, and one whose workspace is left', async () => {
    const hang = processImporter(() => ['node', '-e', 'setInterval(() => {}, 1000)'], process.cwd(), 200)
    await expect(hang.import('/a.stl', '/out.bin', {})).rejects.toThrow('was stopped')
    const left = processImporter(() => ['node', '-e', 'setInterval(() => {}, 1000)'], process.cwd())
    const pending = left.import('/a.stl', '/out.bin', {})
    setTimeout(() => left.stop(), 100)
    await expect(pending).rejects.toThrow('the import was stopped: the workspace was closed')
  })

  it('hands on each stage the process names on stderr', async () => {
    const script = "console.error('stage: reading'); console.error('stage: writing'); console.log(JSON.stringify({ ok: true, unit: 'mm', up: 'z', triangles: 12 }))"
    const stages: string[] = []
    await processImporter(() => ['node', '-e', script], process.cwd()).import('/a.stl', '/out.bin', {}, (stage) => stages.push(stage))
    expect(stages).toEqual(['reading', 'writing'])
  })

  // Beyond the brief's tests.

  it('ends what the process started with it: nothing is written once it was given up on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'torno-importer-'))
    try {
      // As `uv` and its Python: a process whose child goes on to write a file.
      const child = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(join(dir, 'late'))}, 'x'), 500)`
      const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
      await expect(processImporter(() => [process.execPath, '-e', parent], dir, 200).import('/a.stl', '/out.bin', {})).rejects.toThrow('the import took more than 0.2 s and was stopped')
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(existsSync(join(dir, 'late'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs one at a time, and starts nothing that was asked for before the workspace was left', async () => {
    const started: string[] = []
    const answer = "setTimeout(() => console.log(JSON.stringify({ ok: true, unit: 'mm' })), 150)"
    const one = processImporter((args) => (started.push(args[0]), ['node', '-e', answer]), process.cwd())
    const first = one.import('/a.stl', '/out.bin', {})
    const second = one.convert('/m.bin', { unit: 'mm', up: 'z' }, { unit: 'm', up: 'z' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(started).toEqual(['import'])
    await first
    await second
    expect(started).toEqual(['import', 'convert'])

    const left = processImporter((args) => (started.push(`left ${args[0]}`), ['node', '-e', 'setInterval(() => {}, 1000)']), process.cwd())
    const running = left.import('/a.stl', '/out.bin', {})
    const waiting = left.import('/b.stl', '/out.bin', {})
    setTimeout(() => left.stop(), 100)
    await expect(running).rejects.toThrow('the workspace was closed')
    await expect(waiting).rejects.toThrow('the workspace was closed')
    expect(started.filter((s) => s.startsWith('left'))).toEqual(['left import'])
  })

  it('says that the command could not be run at all', async () => {
    await expect(processImporter(() => ['torno-no-such-command'], process.cwd()).import('/a.stl', '/out.bin', {})).rejects.toThrow('the import could not be started: could not run torno-no-such-command')
  })
})

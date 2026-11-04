import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BuildState } from '../shared/build'
import { Builds } from './builds'
import { type RunningKernel, startKernel } from './kernel/client'
import { forgetParamFiles, overrideValues, reconcile, resetOverrides, setOverride } from './paramsfile'

// The person's overrides of Params and the agent's trial, against the real kernel.

const KERNEL_DIR = resolve(__dirname, '../../../kernel')
const model = (wall: number): string =>
  [
    'from dataclasses import dataclass, field',
    'from build123d import Box',
    '',
    '@dataclass(frozen=True)',
    'class Params:',
    `    wall: float = field(default=${wall}, metadata={"min": 1, "max": 5})`,
    '    lid: bool = True',
    '',
    'def assembly(p):',
    '    return {"block": Box(10, 10, p.wall * (2 if p.lid else 1))}',
    ''
  ].join('\n')

let root: string
let dir: string
let kernel: RunningKernel
let builds: Builds

const next = (): Promise<BuildState> =>
  new Promise((done) => {
    const seen = builds.state('block')?.revision ?? 0
    builds.on('build', (state) => {
      if (state.objectId === 'block' && state.status === 'ok' && state.revision > seen) done(state)
    })
  })
const height = (): number => {
  const part = builds.scene('block')!.scene.parts[0]
  return part.bbox.max[2] - part.bbox.min[2]
}

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-params-'))
  dir = join(root, 'block')
  mkdirSync(dir)
  writeFileSync(join(dir, 'block.py'), model(2))
  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  builds = new Builds({ kernel, watch: () => () => {}, overrides: { values: overrideValues, reconcile } })
  const first = next()
  builds.open({ id: 'block', name: 'block', dir, model: 'block.py' })
  await first
}, 60_000)

afterAll(async () => {
  await kernel.dispose()
  rmSync(root, { recursive: true, force: true })
  forgetParamFiles()
})

describe('values the person tries', () => {
  it('build the model with them, say so in the scene, and the file is never written', async () => {
    expect(height()).toBeCloseTo(4)
    await setOverride(dir, 'wall', 3, 2)
    const built = next()
    builds.changed('block')
    await built
    expect(height()).toBeCloseTo(6)
    const scene = builds.scene('block')!.scene
    expect(scene.params!.find((p) => p.name === 'wall')).toMatchObject({ default: 2, value: 3, editable: 'float', metadata: { min: 1, max: 5 } })
    expect(scene.overrides).toEqual({ applied: { wall: 3 }, dropped: [] })
    expect(readFileSync(join(dir, 'block.py'), 'utf8')).toBe(model(2))
  })

  it('are let go of when the file changes that default, and the model is built again with the file’s', async () => {
    const built = next()
    writeFileSync(join(dir, 'block.py'), model(2.5))
    builds.changed('block', [join(dir, 'block.py')])
    await built
    // The first build used 3 over the new default 2.5; the file wins, so another follows.
    await new Promise<void>((done) => {
      const check = (): void => (Math.abs(height() - 5) < 0.01 ? done() : void setTimeout(check, 50))
      check()
    })
    expect(overrideValues(dir)).toEqual({})
    expect(builds.scene('block')!.scene.overrides!.dropped[0].name).toBe('wall')
    expect(height()).toBeCloseTo(5)
  })
})

describe('a trial', () => {
  it('builds with other values, answers there, and changes neither the live build nor the person’s values', async () => {
    await resetOverrides(dir)
    const before = builds.scene('block')!.revision
    const tried = await builds.trial('block', { lid: false }, [{ name: 'measure', args: { kind: 'bbox', layout: 'assembly', a: { ref: 'assembly:block' } } }])
    expect(tried).toMatchObject({ ok: true })
    if (!tried.ok) return
    expect(tried.scene.overrides!.applied).toEqual({ lid: false })
    const answer = tried.answers[0]
    expect(answer.ok && (answer.result as { size: number[] }).size[2]).toBeCloseTo(2.5)
    expect(builds.scene('block')!.revision).toBe(before)
    expect(overrideValues(dir)).toEqual({})
    // The live worker still answers for the build before.
    const live = await builds.query<{ size: number[] }>('block', 'measure', { kind: 'bbox', layout: 'assembly', a: { ref: 'assembly:block' } })
    expect(live.size[2]).toBeCloseTo(5)
  })

  it('says why a model does not build with the values, and what a type that is wrong is dropped as', async () => {
    const dropped = await builds.trial('block', { wall: 'thick' as never }, [])
    expect(dropped.ok).toBe(true)
    expect(dropped.ok ? dropped.scene.overrides!.dropped[0].reason : '').toMatch(/wall is a float/)
  })
})

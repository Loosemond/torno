import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import { Builds } from '../builds'
import { type RunningKernel, startKernel } from '../kernel/client'
import { featuresTool } from './featureTools'
import type { ToolDeps } from './tools'

const KERNEL_DIR = resolve(__dirname, '../../../../kernel')

// `features` through the real kernel and a real build: the tool asks the live worker of the last good build.

const MODEL = [
  'from build123d import *',
  'plate = Box(60, 40, 8)',
  'for x in (-20, 20):',
  '    for y in (-12, 12):',
  '        plate -= Pos(x, y, 0) * Cylinder(1.7, 8)',
  'plate -= Cylinder(1.7, 8) + Pos(0, 0, 2) * Cylinder(5, 4)',
  'plate += Pos(20, 0, 8) * Cylinder(4, 8)',
  ''
].join('\n')

let root: string
let kernel: RunningKernel
let builds: Builds

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-features-'))
  const dir = join(root, 'plate')
  mkdirSync(dir)
  writeFileSync(join(dir, 'plate.py'), MODEL)
  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  builds = new Builds({ kernel, watch: () => () => {} })
  const first = new Promise<BuildState>((done) => {
    builds.on('build', (state) => {
      if (state.objectId === 'plate' && state.status !== 'building') done(state)
    })
  })
  builds.open({ id: 'plate', name: 'plate', dir, model: 'plate.py' })
  expect(await first).toMatchObject({ status: 'ok', revision: 1 })
}, 60_000)

afterAll(async () => {
  await kernel.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('features, against the real kernel', () => {
  it('finds the holes and the boss of a built part, exact, with refs that describe takes', async () => {
    const deps = {
      object: (id: string) => (id === 'plate' ? { id, name: id, dir: join(root, 'plate'), model: 'plate.py' } : undefined),
      build: (id: string) => builds.state(id),
      scene: (id: string) => builds.scene(id),
      view: () => undefined,
      openObjectId: () => null,
      query: (id: string, name: string, args: object) => builds.query(id, name, args)
    } as unknown as ToolDeps
    const result = await featuresTool(deps, 'plate', { part: 'plate' })
    expect(result.isError).toBeUndefined()
    const said = JSON.parse((result.content[0] as { text: string }).text)
    expect(said).toMatchObject({ layout: 'main', revision: 1, part: 'plate', holeCount: 5, bossCount: 1, exact: true, complete: true })
    // Five ⌀3.4 holes through the plate, the one in the middle counterbored from the top; a boss stands on the top.
    expect(said.holes.filter((h: { diameter: number }) => h.diameter === 3.4)).toHaveLength(5)
    expect(said.holes.filter((h: { shape: string }) => h.shape === 'counterbore')).toHaveLength(1)
    expect(said.bosses[0]).toMatchObject({ diameter: 8, height: 8, exact: true })
    expect(said.reading).toContain('4 × ⌀3.4 through, 8 long, along Z')
    const wall = await builds.describe<{ type: string; radius: number }>('plate', 'main', said.holes[0].faces[0])
    expect(wall).toMatchObject({ type: 'cylinder', radius: 1.7 })
    // The answer is kept for as long as the worker holds the build: the second is the first.
    const again = JSON.parse(((await featuresTool(deps, 'plate', { part: 'plate', kinds: ['hole'] })).content[0] as { text: string }).text)
    expect(again.holes).toEqual(said.holes)
    expect(again.bosses).toBeUndefined()
  }, 60_000)
})

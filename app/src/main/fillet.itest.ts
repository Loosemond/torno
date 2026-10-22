import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BuildState } from '../shared/build'
import { diagnosisText } from '../shared/diagnosis'
import { Builds } from './builds'
import { type RunningKernel, startKernel } from './kernel/client'
import { tryFilletTool } from './mcp/readTools'
import type { ToolDeps } from './mcp/tools'

const KERNEL_DIR = resolve(__dirname, '../../../kernel')

/** A plate with a pocket 4 mm deep from the top, its walls 4 mm thick; `fillet` is what is done to the edges round the top of its walls. */
const plate = (fillet: string): string =>
  [
    'from build123d import *',
    'plate = Box(20, 20, 5) - Pos(0, 0, 1) * Box(12, 12, 4)',
    'top = plate.edges().filter_by(Axis.Z, reverse=True).group_by(Axis.Z)[-1]',
    fillet,
    ''
  ].join('\n')

let root: string
let dir: string
let kernel: RunningKernel
let builds: Builds

/** The next state of the plate that is not a build under way. */
function ended(): Promise<BuildState> {
  return new Promise((done) => {
    builds.on('build', (state) => {
      if (state.objectId === 'plate' && state.status !== 'building') done(state)
    })
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-fillet-'))
  dir = join(root, 'plate')
  mkdirSync(dir)
  writeFileSync(join(dir, 'plate.py'), plate('plate = plate'))
  kernel = startKernel({ workspaceRoot: root, hasProject: false, kernelDir: KERNEL_DIR })
  builds = new Builds({ kernel, watch: () => () => {} })
  const first = ended()
  builds.open({ id: 'plate', name: 'plate', dir, model: 'plate.py' })
  expect(await first).toMatchObject({ status: 'ok', revision: 1 })
}, 60_000)

afterAll(async () => {
  await kernel.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('a fillet that fails in a build', () => {
  it('says why, naming the edges that are exactly edges of the last good build by their refs, as of that build', async () => {
    // r1 is the plate as it is before the fillet: the edges filleted are its own.
    writeFileSync(join(dir, 'plate.py'), plate('plate = fillet(top, 3)'))
    const next = ended()
    builds.rebuild('plate')
    const failed = await next
    expect(failed.status).toBe('failed')
    const diagnosis = failed.error?.diagnosis
    expect(diagnosis).toMatchObject({ operation: 'fillet', size: 3, frame: 'local', edgeCount: 8, complete: true, alone: { failing: [] } })
    expect(diagnosis!.pairs!.failing).toHaveLength(4)
    expect(diagnosis!.together!.worksUpTo).toBeGreaterThanOrEqual(1.99)
    expect(diagnosis!.together!.worksUpTo).toBeLessThan(2)
    // Every edge told is one of r1: each is named by its ref there.
    for (const edge of diagnosis!.edges) {
      expect(edge.sameAs).toMatchObject({ layout: 'main', revision: 1 })
      expect(edge.sameAs!.ref).toMatch(/^plate\/E\d+$/)
      const described = await builds.describe<{ length: number }>('plate', 'main', edge.sameAs!.ref)
      expect(described.length).toBeCloseTo(edge.length!, 9)
    }
    expect(diagnosisText(diagnosis!)).toMatch(/, which is plate\/E\d+ of r1 \(layout main\)/)

    // try_fillet, on r1, of the edges by those refs: it agrees.
    const refs = diagnosis!.edges.map((edge) => edge.sameAs!.ref)
    const deps = {
      object: (id: string) => (id === 'plate' ? { id, name: id, dir, model: 'plate.py' } : undefined),
      build: (id: string) => builds.state(id),
      scene: (id: string) => builds.scene(id),
      view: () => undefined,
      openObjectId: () => null,
      query: (id: string, name: string, args: object) => builds.query(id, name, args)
    } as unknown as ToolDeps
    const textOf = (result: Awaited<ReturnType<typeof tryFilletTool>>): string => (result.content[0] as { text: string }).text
    const tried = JSON.parse(textOf(await tryFilletTool(deps, 'plate', { part: 'plate', edges: refs, radius: 3 })))
    expect(tried).toMatchObject({ layout: 'main', revision: 1, stale: expect.stringContaining('the latest build failed'), part: 'plate', works: false, frame: 'object', alone: { failing: [] } })
    expect(tried.together.worksUpTo).toBe(diagnosis!.together!.worksUpTo)
    expect(tried.pairs.failing.map((p: { edges: string[] }) => p.edges.sort().join(' ')).sort()).toEqual(
      diagnosis!.pairs!.failing.map((p) => p.edges.map((i) => diagnosis!.edges.find((e) => e.index === i)!.sameAs!.ref).sort().join(' ')).sort()
    )
    expect(tried.reading).toMatch(/^Tried on r1 and thrown away, nothing changed: fillet R3 of 8 edges: each works alone; 4 pairs of adjacent edges fail \(plate\/E/)
    const works = JSON.parse(textOf(await tryFilletTool(deps, 'plate', { part: 'plate', edges: refs, radius: tried.together.worksUpTo })))
    expect(works).toMatchObject({ works: true })
  }, 60_000)

  it('names no edge by a ref when the shape filleted is not where the last good build has it', async () => {
    writeFileSync(join(dir, 'plate.py'), plate('plate = Pos(0, 0, 0.5) * plate\nplate = fillet(plate.edges().group_by(Axis.Z)[-1], 3)'))
    const next = ended()
    builds.rebuild('plate')
    const failed = await next
    expect(failed.error?.diagnosis?.edges.length).toBeGreaterThan(0)
    expect(failed.error!.diagnosis!.edges.every((edge) => edge.sameAs === undefined)).toBe(true)
  }, 60_000)
})

import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import { BuildWaits } from '../buildWaits'
import type { ToolDeps } from './tools'
import { waitBuildTool } from './waitTool'

const ok = (revision: number, seconds?: number): BuildState => ({ objectId: 'lid', status: 'ok', revision, stale: false, ...(seconds === undefined ? {} : { seconds }) })
const building = (revision: number): BuildState => ({ objectId: 'lid', status: 'building', revision, startedAt: Date.now(), stale: true })
const failed = (revision: number): BuildState => ({ objectId: 'lid', status: 'failed', revision, error: { kind: 'exception', message: 'NameError: x' }, stale: true })

/** A project whose build a test moves along with `land`, and what `wait_build` answers from. */
function project(first: BuildState | undefined, timing = { progressMs: 1000, graceMs: 150 }) {
  let state = first
  const waits = new BuildWaits()
  if (first) waits.changed(first)
  const answered: number[] = []
  const deps = {
    object: (id: string) => (id === 'lid' ? { id: 'lid', name: 'lid', dir: '/w/lid', model: 'lid.py' } : undefined),
    build: () => state,
    buildWaits: waits,
    buildAnswer: async (_id: string, until: number) => {
      answered.push(until)
      return { text: state?.status === 'failed' ? `BUILD FAILED\n${state.error?.message}` : `r${state?.revision} ok`, sentMarkIds: [] }
    },
    waitTiming: timing
  } as unknown as ToolDeps
  const land = (next: BuildState): void => {
    state = next
    waits.changed(next)
  }
  return { deps, land, waits, answered }
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((b) => b.text ?? '').join('')
const later = (ms: number, then: () => void): void => void setTimeout(then, ms)

describe('wait_build', () => {
  it('waits for the build running and answers as an edit is answered', async () => {
    const { deps, land } = project(building(4))
    later(50, () => land(ok(5, 12)))
    expect(text(await waitBuildTool(deps, 'lid', {}))).toBe('r5 ok')
  })

  it('answers with the error of a build that failed', async () => {
    const { deps, land } = project(ok(4))
    later(30, () => land(building(4)))
    later(80, () => land(failed(4)))
    expect(text(await waitBuildTool(deps, 'lid', {}))).toBe('BUILD FAILED\nNameError: x')
  })

  it('with after, answers at once a build that already ended after that revision, and waits for one that has not', async () => {
    const { deps, land } = project(ok(7))
    const started = Date.now()
    expect(text(await waitBuildTool(deps, 'lid', { after: 6 }))).toBe('r7 ok')
    expect(Date.now() - started).toBeLessThan(100)
    // r7 is not after 7: it waits past the grace a call without after has, until a build lands.
    later(300, () => land(building(7)))
    later(350, () => land(ok(8)))
    expect(text(await waitBuildTool(deps, 'lid', { after: 7 }))).toBe('r8 ok')
  })

  it('with after, answers at once a build after that revision that failed', async () => {
    const { deps } = project(failed(7))
    expect(text(await waitBuildTool(deps, 'lid', { after: 7 }))).toBe('BUILD FAILED\nNameError: x')
  })

  it('says no build is running when none begins within the grace, with the last build', async () => {
    const { deps } = project(ok(3))
    const said = text(await waitBuildTool(deps, 'lid', {}))
    expect(said).toMatch(/^No build is running, and none began within 0 s: a save of the project's sources starts one\. The last build, as an edit is told of it:\nr3 ok$/)
  })

  it('takes a state told again for no build: only a build that ends ends the wait', async () => {
    const { deps, land } = project(ok(3))
    later(30, () => land(ok(3)))
    const said = text(await waitBuildTool(deps, 'lid', { after: 3, timeout: 1 }))
    expect(said).toBe('The build is not begun after 1 s. Call wait_build again with after: 3 to keep waiting.')
  })

  it('says the build is still running at its timeout, for how long, and how long the last builds took', async () => {
    const { deps, land } = project(ok(1))
    land(building(1))
    land(ok(2, 41.6))
    land(building(2))
    land(ok(3, 95.2))
    land(building(3))
    const said = text(await waitBuildTool(deps, 'lid', { timeout: 1 }))
    expect(said).toBe('The build is still running (r4, for 1 s; the last builds took 42 s, 95 s). Call wait_build again with after: 3 to keep waiting.')
  })

  it('tells its client every progress interval that it is alive', async () => {
    const { deps, land } = project(building(1), { progressMs: 40, graceMs: 150 })
    const beats: string[] = []
    later(230, () => land(ok(2)))
    await waitBuildTool(deps, 'lid', {}, { progress: async (n, message) => void beats.push(`${n} ${message}`) })
    expect(beats.length).toBeGreaterThanOrEqual(4)
    expect(beats[0]).toBe('1 waiting for the build')
  })

  it('ends when its client gives the call up', async () => {
    const { deps } = project(building(1))
    const giving = new AbortController()
    later(50, () => giving.abort())
    const result = await waitBuildTool(deps, 'lid', {}, { signal: giving.signal })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('the wait was given up')
  })

  it('refuses what it cannot wait for, saying why', async () => {
    const { deps } = project(ok(1))
    expect(text(await waitBuildTool(deps, 'lid', { after: -1 }))).toMatch(/^after is a revision/)
    expect(text(await waitBuildTool(deps, 'lid', { after: 2.5 }))).toMatch(/^after is a revision/)
    expect(text(await waitBuildTool(deps, 'lid', { timeout: 0 }))).toBe('timeout is seconds, 1 to 600')
    expect(text(await waitBuildTool(deps, 'lid', { timeout: 601 }))).toBe('timeout is seconds, 1 to 600')
    expect(text(await waitBuildTool(deps, 'nope', {}))).toBe('no project nope in this workspace')
    expect(text(await waitBuildTool(project(undefined).deps, 'lid', {}))).toBe('lid is not open in the torno window: nothing builds it')
    expect(text(await waitBuildTool({ ...deps, buildWaits: undefined }, 'lid', {}))).toBe('wait_build is not available here: call scene for the build status')
  })
})

describe('BuildWaits', () => {
  it('counts the end of a build once, and keeps the times of the last three that worked', () => {
    const waits = new BuildWaits()
    for (const [revision, seconds] of [[1, 10], [2, 20], [3, 30], [4, 40]] as const) {
      waits.changed(building(revision - 1), 1000 * revision)
      waits.changed(ok(revision, seconds), 1000 * revision + 500)
      waits.changed(ok(revision, seconds), 1000 * revision + 900)
    }
    expect(waits.lastTimes('lid')).toEqual([20, 30, 40])
    expect(waits.endedAt('lid')).toBe(4500)
    expect(waits.beganAt('lid')).toBeGreaterThan(0)
  })
})

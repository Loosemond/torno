import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BuildError, BuildState } from '../shared/build'
import type { Scene } from '../shared/scene'
import type { ObjectInfo } from '../shared/workspace'
import { Builds, watchFolder } from './builds'
import type { KernelClient } from './kernel/client'

type BuildResult = { ok: true; scene: Scene; blob: Buffer } | { ok: false; error: BuildError }

function sceneOf(model: string, seconds = 0.5): Scene {
  return { model, layouts: ['assembly'], parts: [], seconds, output: '' }
}

/** A kernel whose builds finish when the test says so. Like the real one, a new build cancels the one running. */
class FakeKernel implements KernelClient {
  ready = Promise.resolve({ versions: {} })
  calls: Array<{ dir: string; model: string; settle: (r: BuildResult) => void; settled: boolean }> = []
  cancels = 0
  tail = ''
  private exitCbs: Array<(code: number | null) => void> = []

  build(dir: string, model: string, opts?: { onStarted?: () => void }): Promise<BuildResult> {
    const running = this.calls.at(-1)
    if (running && !running.settled) running.settle({ ok: false, error: { kind: 'cancelled', message: 'replaced' } })
    return new Promise((resolve) => {
      const call = {
        dir,
        model,
        settled: false,
        settle: (r: BuildResult) => {
          call.settled = true
          resolve(r)
        }
      }
      this.calls.push(call)
      opts?.onStarted?.()
    })
  }
  succeed(index: number, seconds = 0.5): void {
    const call = this.calls[index]
    call.settle({ ok: true, scene: sceneOf(call.model, seconds), blob: Buffer.from([index]) })
  }
  fail(index: number, error: BuildError): void {
    this.calls[index].settle({ ok: false, error })
  }
  query<T>(): Promise<T> {
    return Promise.reject(new Error('not used'))
  }
  cancel(): void {
    this.cancels += 1
    const running = this.calls.at(-1)
    if (running && !running.settled) running.settle({ ok: false, error: { kind: 'cancelled', message: 'by request' } })
  }
  dispose(): Promise<void> {
    return Promise.resolve()
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb)
  }
  stderrTail(): string {
    return this.tail
  }
  stop(code: number | null): void {
    for (const cb of this.exitCbs) cb(code)
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const bracket: ObjectInfo = { id: 'bracket', name: 'bracket', dir: '/ws/bracket', model: 'bracket.py' }
const gear: ObjectInfo = { id: 'gear', name: 'gear', dir: '/ws/gear', model: 'gear.py' }

function setup() {
  const kernel = new FakeKernel()
  const watched = new Map<string, () => void>()
  let clock = 1000
  const builds = new Builds({
    kernel,
    watch: (dir, onChange) => {
      watched.set(dir, onChange)
      return () => watched.delete(dir)
    },
    now: () => clock
  })
  const states: BuildState[] = []
  const scenes: Array<{ objectId: string; revision: number; scene: Scene; blob: Buffer }> = []
  builds.on('build', (s) => states.push(s))
  builds.on('scene', (m) => scenes.push(m))
  return { kernel, watched, builds, states, scenes, advance: (ms: number) => (clock += ms) }
}

describe('Builds', () => {
  it('starts a build as soon as an object is opened', () => {
    const { kernel, builds, states } = setup()
    const state = builds.open(bracket)
    expect(state).toEqual({ objectId: 'bracket', status: 'building', revision: 0, startedAt: 1000, stale: false })
    expect(kernel.calls).toMatchObject([{ dir: '/ws/bracket', model: 'bracket.py' }])
    expect(states).toEqual([state])
    expect(builds.state('bracket')).toEqual(state)
    expect(builds.scene('bracket')).toBeUndefined()
  })

  it('goes to ok with the next revision and emits the scene when a build succeeds', async () => {
    const { kernel, builds, states, scenes } = setup()
    builds.open(bracket)
    kernel.succeed(0, 1.25)
    await flush()
    expect(builds.state('bracket')).toEqual({ objectId: 'bracket', status: 'ok', revision: 1, seconds: 1.25, stale: false })
    expect(states.map((s) => s.status)).toEqual(['building', 'ok'])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]).toMatchObject({ objectId: 'bracket', revision: 1, scene: { model: 'bracket.py' } })
    expect(builds.scene('bracket')).toEqual({ revision: 1, scene: scenes[0].scene, blob: scenes[0].blob })
  })

  it('goes to failed with the error when the first build fails, with nothing stale on screen', async () => {
    const { kernel, builds, advance } = setup()
    builds.open(bracket)
    advance(2000)
    kernel.fail(0, { kind: 'exception', message: 'boom', traceback: 'tb' })
    await flush()
    expect(builds.state('bracket')).toEqual({
      objectId: 'bracket',
      status: 'failed',
      revision: 0,
      seconds: 2,
      error: { kind: 'exception', message: 'boom', traceback: 'tb' },
      stale: false
    })
  })

  it('keeps the revision and marks it stale while rebuilding after a success', async () => {
    const { kernel, builds, advance } = setup()
    builds.open(bracket)
    kernel.succeed(0)
    await flush()
    advance(500)
    builds.rebuild('bracket')
    expect(builds.state('bracket')).toEqual({ objectId: 'bracket', status: 'building', revision: 1, startedAt: 1500, stale: true })
    kernel.succeed(1)
    await flush()
    expect(builds.state('bracket')).toMatchObject({ status: 'ok', revision: 2, stale: false })
    expect(builds.scene('bracket')?.revision).toBe(2)
  })

  it('keeps the last good scene, marked stale, when a build fails after a success', async () => {
    const { kernel, builds, scenes } = setup()
    builds.open(bracket)
    kernel.succeed(0)
    await flush()
    builds.rebuild('bracket')
    kernel.fail(1, { kind: 'crash', message: 'the build process was killed by SIGSEGV' })
    await flush()
    expect(builds.state('bracket')).toMatchObject({ status: 'failed', revision: 1, stale: true, error: { kind: 'crash' } })
    expect(builds.scene('bracket')?.revision).toBe(1)
    expect(scenes).toHaveLength(1)

    // The next save builds normally.
    builds.rebuild('bracket')
    kernel.succeed(2)
    await flush()
    expect(builds.state('bracket')).toEqual({ objectId: 'bracket', status: 'ok', revision: 2, seconds: 0.5, stale: false })
  })

  it('rebuilds when the object folder or the common folder changes', () => {
    const { kernel, builds, watched } = setup()
    builds.open(bracket)
    expect([...watched.keys()]).toEqual(['/ws/bracket', '/ws/common'])
    watched.get('/ws/bracket')!()
    watched.get('/ws/common')!()
    expect(kernel.calls).toHaveLength(3)
  })

  it('shows only the second build when a change arrives mid-build', async () => {
    const { kernel, builds, watched, states, scenes } = setup()
    builds.open(bracket)
    watched.get('/ws/bracket')!() // the kernel cancels build 0
    await flush()
    expect(builds.state('bracket')?.status).toBe('building')
    kernel.succeed(1)
    await flush()
    expect(kernel.calls).toHaveLength(2)
    expect(scenes).toHaveLength(1)
    expect(scenes[0].blob).toEqual(Buffer.from([1]))
    expect(states.map((s) => s.status)).toEqual(['building', 'building', 'ok'])
    expect(builds.state('bracket')?.revision).toBe(1)
  })

  it('ignores the result of a build that a newer one has replaced, whatever it says', async () => {
    const { kernel, builds, scenes } = setup()
    builds.open(bracket)
    const old = kernel.calls[0]
    builds.rebuild('bracket')
    // The old build's success was already on its way when the new one was requested.
    old.settle({ ok: true, scene: sceneOf('old'), blob: Buffer.from([9]) })
    await flush()
    expect(scenes).toHaveLength(0)
    expect(builds.state('bracket')).toMatchObject({ status: 'building', revision: 0 })
  })

  it('fails an object with no model without calling the kernel', () => {
    const { kernel, builds, watched, states } = setup()
    const two: ObjectInfo = { id: 'two', name: 'two', dir: '/ws/two', model: null, problem: 'more than one model file in /ws/two: a.py, b.py' }
    const state = builds.open(two)
    expect(state).toEqual({
      objectId: 'two',
      status: 'failed',
      revision: 0,
      error: { kind: 'no_model', message: 'more than one model file in /ws/two: a.py, b.py' },
      stale: false
    })
    expect(states).toEqual([state])
    watched.get('/ws/two')!()
    builds.rebuild('two')
    expect(kernel.calls).toHaveLength(0)
  })

  it('builds again with the new model when an open object is opened with different info', async () => {
    const { kernel, builds } = setup()
    builds.open({ ...bracket, model: null, problem: 'no model file in /ws/bracket' })
    expect(builds.open(bracket).status).toBe('building')
    expect(kernel.calls).toMatchObject([{ model: 'bracket.py' }])
    // Opening it again unchanged neither rebuilds nor watches twice.
    kernel.succeed(0)
    await flush()
    expect(builds.open(bracket).status).toBe('ok')
    expect(kernel.calls).toHaveLength(1)
  })

  it('stops watching and reporting an object once it is closed', async () => {
    const { kernel, builds, watched, states, scenes } = setup()
    builds.open(bracket)
    builds.close('bracket')
    expect(watched.size).toBe(0)
    expect(kernel.cancels).toBe(1)
    await flush()
    expect(builds.state('bracket')).toBeUndefined()
    expect(builds.scene('bracket')).toBeUndefined()
    expect(states.map((s) => s.status)).toEqual(['building'])
    expect(scenes).toHaveLength(0)
    builds.rebuild('bracket')
    expect(kernel.calls).toHaveLength(1)
  })

  it('does not cancel another object\'s build when closing one that is not building', async () => {
    const { kernel, builds } = setup()
    builds.open(bracket)
    kernel.succeed(0)
    await flush()
    builds.open(gear)
    builds.close('bracket')
    expect(kernel.cancels).toBe(0)
  })

  it('rebuilds an object whose build another object displaced, once the kernel is free', async () => {
    const { kernel, builds, scenes } = setup()
    builds.open(bracket)
    builds.open(gear) // the kernel runs one build at a time: bracket's is cancelled
    await flush()
    expect(kernel.calls.map((c) => c.model)).toEqual(['bracket.py', 'gear.py'])
    expect(builds.state('bracket')?.status).toBe('building')
    kernel.succeed(1)
    await flush()
    expect(kernel.calls.map((c) => c.model)).toEqual(['bracket.py', 'gear.py', 'bracket.py'])
    expect(builds.state('gear')?.status).toBe('ok')
    kernel.succeed(2)
    await flush()
    expect(builds.state('bracket')).toMatchObject({ status: 'ok', revision: 1 })
    expect(scenes.map((s) => s.objectId)).toEqual(['gear', 'bracket'])
  })

  it('fails every open object with the stderr tail when the kernel stops for good', async () => {
    const { kernel, builds } = setup()
    builds.open(bracket)
    kernel.succeed(0)
    await flush()
    builds.open(gear)
    kernel.fail(1, { kind: 'crash', message: 'the kernel exited' })
    await flush()
    kernel.tail = 'ModuleNotFoundError: build123d'
    kernel.stop(1)
    const error = { kind: 'crash', message: 'kernel stopped', output: 'ModuleNotFoundError: build123d' }
    expect(builds.state('bracket')).toMatchObject({ status: 'failed', revision: 1, stale: true, error })
    expect(builds.state('gear')).toMatchObject({ status: 'failed', revision: 0, stale: false, error })
    expect(builds.scene('bracket')?.revision).toBe(1)
  })
})

describe('watchFolder', () => {
  let dir: string
  let stop: (() => void) | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'torno-watch-'))
    mkdirSync(join(dir, 'obj', 'out'), { recursive: true })
    mkdirSync(join(dir, 'obj', '.torno'))
    mkdirSync(join(dir, 'obj', '__pycache__'))
    writeFileSync(join(dir, 'obj', 'model.py'), 'x = 1\n')
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  async function watching(path: string): Promise<{ changes: () => number }> {
    let count = 0
    stop = watchFolder(path, () => (count += 1))
    await sleep(150) // let the watcher settle on what is already there
    return { changes: () => count }
  }

  it('reports a burst of saves once, after the debounce', async () => {
    const { changes } = await watching(join(dir, 'obj'))
    writeFileSync(join(dir, 'obj', 'model.py'), 'x = 2\n')
    await sleep(100)
    writeFileSync(join(dir, 'obj', 'model.py'), 'x = 3\n')
    writeFileSync(join(dir, 'obj', 'notes.txt'), 'hello')
    await sleep(200)
    expect(changes()).toBe(0) // still inside the 300 ms after the last change
    await sleep(400)
    expect(changes()).toBe(1)
  })

  it('ignores out/, .torno/, __pycache__/ and dotfiles', async () => {
    const { changes } = await watching(join(dir, 'obj'))
    writeFileSync(join(dir, 'obj', 'out', 'part.step'), 'a')
    writeFileSync(join(dir, 'obj', '.torno', 'state.json'), '{}')
    writeFileSync(join(dir, 'obj', '__pycache__', 'model.cpython-312.pyc'), 'b')
    writeFileSync(join(dir, 'obj', '.model.py.swp'), 'c')
    await sleep(600)
    expect(changes()).toBe(0)
  })

  it('picks up a folder that appears after watching began', async () => {
    const { changes } = await watching(join(dir, 'common'))
    mkdirSync(join(dir, 'common'))
    writeFileSync(join(dir, 'common', 'screws.py'), 'M3 = 3\n')
    await sleep(700)
    expect(changes()).toBe(1)
  })

  it('reports nothing after it is stopped', async () => {
    const { changes } = await watching(join(dir, 'obj'))
    writeFileSync(join(dir, 'obj', 'model.py'), 'x = 4\n')
    stop!()
    await sleep(500)
    expect(changes()).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Part, Scene } from '../../shared/scene'
import { Expectations, expectTool } from './expectTools'
import type { ToolDeps } from './tools'
import { sceneTool } from './viewTools'

const part = (name: string, more: Partial<Part> = {}): Part =>
  ({ key: `main:${name}`, name, layout: 'main', bbox: { min: [0, 0, 0], max: [40, 30, 5] }, bboxExact: true, volume: 6000, volumeExact: true, faceCount: 6, edgeCount: 12, valid: true, hash: name, ...more }) as Part
const sceneOf = (parts: Part[]): Scene => ({ model: 'm.py', layouts: ['main'], parts, seconds: 1, output: '' }) as Scene

function world(first: Part[]) {
  const state = { revision: 1, scene: sceneOf(first) }
  const store = new Expectations()
  const deps = {
    object: () => ({ id: 'o', name: 'o', dir: '/ws/o', model: 'm.py' }),
    build: (): BuildState => ({ objectId: 'o', status: 'ok', revision: state.revision, seconds: 1, stale: false }),
    scene: () => ({ revision: state.revision, scene: state.scene }),
    view: () => undefined,
    openObjectId: () => 'o',
    marks: async () => [],
    describe: async () => ({ kind: 'face' }),
    query: async () => ({ kind: 'diameter', value: 6.4, unit: 'mm', how: 'cylinder', exact: true }),
    expectations: store
  } as unknown as ToolDeps
  return {
    deps,
    store,
    build: (parts: Part[]) => {
      state.revision++
      state.scene = sceneOf(parts)
    }
  }
}
const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content[0].text ?? ''

describe('expect', () => {
  it('meets a change of volume, faces and size, and says unchanged parts held', async () => {
    const w = world([part('plate'), part('lid')])
    const r = expectTool(w.deps, 'o', { checks: [{ part: 'plate', volume: { change: -1200, tolerance: 50 }, faces: { change: 2 }, size: { change: [0, 0, 0] } }, { unchanged: ['lid'] }], note: 'drill' })
    expect(r.isError).toBeUndefined()
    w.build([part('plate', { volume: 4800, faceCount: 8, hash: 'b' }), part('lid')])
    const line = await w.store.settle(w.deps, 'o')
    expect(line).toContain('all 4 met')
    expect(line).toContain('drill')
    expect(await w.store.settle(w.deps, 'o')).toBeUndefined()
  })

  it('says what was missed with the numbers, and ≈ for a number that is not exact', async () => {
    const w = world([part('plate', { volumeExact: false }), part('lid')])
    expectTool(w.deps, 'o', { checks: [{ part: 'plate', volume: { change: -1200, tolerance: 50 } }, { unchanged: ['lid'] }] })
    w.build([part('plate', { volume: 5170, volumeExact: false, hash: 'b' }), part('lid', { volume: 5000, hash: 'c' })])
    const line = (await w.store.settle(w.deps, 'o'))!
    expect(line).toContain('0 met, 2 not')
    expect(line).toContain('plate volume ≈ −830 mm³, expected −1200 ± 50')
    expect(line).toContain('lid changed')
    expect(w.store.last('o')?.met).toBe(0)
    expect(text(sceneTool(w.deps, 'o'))).toContain('"notMet"')
  })

  it('measures a check against the new build', async () => {
    const w = world([part('plate')])
    expectTool(w.deps, 'o', { checks: [{ measure: { kind: 'diameter', a: 'plate/F3' }, expected: 6.4 }] })
    w.build([part('plate', { hash: 'b' })])
    expect(await w.store.settle(w.deps, 'o')).toContain('all 1 met')
  })

  it('says a ref moved when its part changed its face count, and does not measure it', async () => {
    const w = world([part('plate')])
    let asked = 0
    ;(w.deps as { query: unknown }).query = async () => {
      asked++
      return { kind: 'diameter', value: 6.4, unit: 'mm', how: 'x', exact: true }
    }
    expectTool(w.deps, 'o', { checks: [{ measure: { kind: 'diameter', a: 'plate/F3' }, expected: 6.4 }] })
    w.build([part('plate', { faceCount: 8, hash: 'b' })])
    const line = (await w.store.settle(w.deps, 'o'))!
    expect(line).toContain('plate/F3 moved')
    expect(asked).toBe(0)
  })

  it('waits for a build newer than the one it was made on, and refuses what is malformed', async () => {
    const w = world([part('plate')])
    expectTool(w.deps, 'o', { checks: [{ unchanged: ['plate'] }] })
    expect(await w.store.settle(w.deps, 'o')).toBeUndefined()
    expect(text(expectTool(w.deps, 'o', { checks: [{ part: 'nope', volume: { change: 1 } }] }))).toContain("no part 'nope'")
    expect(text(expectTool(w.deps, 'o', { checks: [{ part: 'plate', volume: { change: 1, value: 2 } }] }))).toContain('either value or change')
    expect(text(expectTool(w.deps, 'o', { checks: [] }))).toContain('1 to 20')
    expect(text(expectTool(w.deps, 'o', { checks: [{ part: 'plate', volyme: {} } as never] }))).toContain('volyme')
  })
})

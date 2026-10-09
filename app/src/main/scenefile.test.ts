import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_SCAN_OPACITY } from '../shared/scans'
import { loadSceneFile, saveSceneFile, sceneFilesSettled, type SceneFile } from './scenefile'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torno-scenefile-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scene file', () => {
  it('round trips, creating .torno/ on demand', async () => {
    const file: SceneFile = { layout: 'print', layers: { post: { visible: false }, base: { color: '#112233', opacity: 0.4 } } }
    await saveSceneFile(dir, file)
    expect(await loadSceneFile(dir)).toEqual(file)
    // Nothing is left behind by the atomic write, and nothing is written outside .torno/.
    expect(readdirSync(dir)).toEqual(['.torno'])
    expect(readdirSync(join(dir, '.torno'))).toEqual(['scene.json'])
  })

  it('a later save replaces an earlier one', async () => {
    await saveSceneFile(dir, { layout: 'print', layers: { post: { visible: false } } })
    await saveSceneFile(dir, { layers: {} })
    expect(await loadSceneFile(dir)).toEqual({ layers: {} })
  })

  it('says what is still being written, for whoever must not leave before it is on the disk', async () => {
    expect(sceneFilesSettled()).toBeNull()
    // Asked and not waited for, as by a window that is closing.
    void saveSceneFile(dir, { layers: { post: { visible: false } } })
    void saveSceneFile(join(dir, 'file-not-folder', '\0'), { layers: {} }).catch(() => {})
    const settled = sceneFilesSettled()
    expect(settled).not.toBeNull()
    expect(readdirSync(dir)).toEqual([])
    await settled
    expect(await loadSceneFile(dir)).toEqual({ layers: { post: { visible: false } } })
    expect(sceneFilesSettled()).toBeNull()
  })

  it('a missing file gives defaults', async () => {
    expect(await loadSceneFile(dir)).toEqual({ layers: {} })
    expect(readdirSync(dir)).toEqual([])
  })

  it('a corrupt file gives defaults and is not overwritten until the next save', async () => {
    const path = join(dir, '.torno', 'scene.json')
    mkdirSync(join(dir, '.torno'))
    writeFileSync(path, '{"layers": {"post"')
    expect(await loadSceneFile(dir)).toEqual({ layers: {} })
    expect(readFileSync(path, 'utf8')).toBe('{"layers": {"post"')
    await saveSceneFile(dir, { layers: { post: { visible: false } } })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ layers: { post: { visible: false } } })
  })

  it('drops what is not a layer setting', async () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(
      join(dir, '.torno', 'scene.json'),
      JSON.stringify({ layout: 7, layers: { post: { visible: 'no', opacity: 3, color: '#abc', extra: 1 }, base: null }, views: [] })
    )
    expect(await loadSceneFile(dir)).toEqual({ layers: { post: { color: '#abc', opacity: 1 } } })
  })

  it('gives defaults when the file holds something other than an object', async () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', 'scene.json'), '[1, 2]')
    expect(await loadSceneFile(dir)).toEqual({ layers: {} })
  })

  it('keeps a section that is a plane, its normal a unit vector, and drops one that is not', async () => {
    await saveSceneFile(dir, { layers: {}, section: { origin: [0, 0, 12.5], normal: [0, 0, 2] } })
    expect(await loadSceneFile(dir)).toEqual({ layers: {}, section: { origin: [0, 0, 12.5], normal: [0, 0, 1] } })
    await saveSceneFile(dir, { layers: {}, section: null })
    expect(JSON.parse(readFileSync(join(dir, '.torno', 'scene.json'), 'utf8'))).toEqual({ layers: {} })
    for (const not of [{ origin: [0, 0, 1], normal: [0, 0, 0] }, { origin: [0, 0, null], normal: [0, 0, 1] }, { origin: [0, 0], normal: [0, 0, 1] }, 'z', 4]) {
      writeFileSync(join(dir, '.torno', 'scene.json'), JSON.stringify({ layout: 'print', layers: {}, section: not }))
      expect(await loadSceneFile(dir)).toEqual({ layout: 'print', layers: {} })
    }
  })
  it('keeps how each scan is looked at, by its id, and drops what is none', async () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', 'scene.json'), JSON.stringify({ scans: { S1: { visible: false, opacity: 7, colour: 'own' }, lid: { visible: false }, S2: { colour: 'rainbow' } } }))
    expect(await loadSceneFile(dir)).toEqual({ layers: {}, scans: { S1: { visible: false, opacity: 1, colour: 'own' } } })
    // A scan thinned to nothing could not be found again: the least is 5 %.
    await saveSceneFile(dir, { layers: {}, scans: { S3: { opacity: 0 }, S4: {} } })
    expect(await loadSceneFile(dir)).toEqual({ layers: {}, scans: { S3: { opacity: MIN_SCAN_OPACITY } } })
    expect(MIN_SCAN_OPACITY).toBe(0.05)
    for (const not of [[], 'S1', null, { S1: 4 }]) {
      writeFileSync(join(dir, '.torno', 'scene.json'), JSON.stringify({ scans: not }))
      expect(await loadSceneFile(dir)).toEqual({ layers: {} })
    }
  })

  it('keeps how each layout is drawn apart, within its ranges, and drops what is none', async () => {
    await saveSceneFile(dir, { layers: {}, explode: { assembly: { amount: 0.4, axis: 'z' }, print: { amount: 0 }, bad: 'x', also: { amount: 9, scale: 9 } } } as unknown as SceneFile)
    expect(await loadSceneFile(dir)).toEqual({ layers: {}, explode: { assembly: { amount: 0.4, scale: 1, axis: 'z' }, also: { amount: 1, scale: 4, axis: 'centre' } } })
    // Together, but with a scale and an axis of its own: kept for when it is drawn apart again.
    await saveSceneFile(dir, { layers: {}, explode: { assembly: { amount: 0, scale: 2, axis: 'x' }, ['l'.repeat(101)]: { amount: 1, scale: 1, axis: 'x' } } })
    expect(await loadSceneFile(dir)).toEqual({ layers: {}, explode: { assembly: { amount: 0, scale: 2, axis: 'x' } } })
    for (const not of [[], 'half', null, 3, { assembly: { amount: 0 } }]) {
      writeFileSync(join(dir, '.torno', 'scene.json'), JSON.stringify({ explode: not }))
      expect(await loadSceneFile(dir)).toEqual({ layers: {} })
    }
  })
})

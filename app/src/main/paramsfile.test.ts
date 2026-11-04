import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Param, Scene } from '../shared/scene'
import { forgetParamFiles, overrideValues, overridesOf, reconcile, resetOverrides, setOverride } from './paramsfile'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torno-params-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetParamFiles()
})

const field = (name: string, def: unknown, over: Partial<Param> = {}): Param => ({
  name,
  type: typeof def === 'boolean' ? 'bool' : 'float',
  default: def,
  value: def,
  literal: true,
  editable: typeof def === 'boolean' ? 'bool' : 'float',
  doc: null,
  ...over
})

const sceneOf = (params: Param[], overrides?: Scene['overrides']): Scene => ({ model: 'm.py', layouts: ['assembly'], parts: [], seconds: 1, output: '', params, ...(overrides ? { overrides } : {}) })
const filed = () => JSON.parse(readFileSync(join(dir, '.torno', 'params.json'), 'utf8'))

describe('the overrides file', () => {
  it('holds a value with the default the file had, in .torno/ only, and git passes over it', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    expect(filed()).toEqual({ overrides: { wall: { value: 2.4, default: 2 } } })
    expect(overrideValues(dir)).toEqual({ wall: 2.4 })
    expect(readdirSync(dir)).toEqual(['.torno'])
    expect(readFileSync(join(dir, '.torno', '.gitignore'), 'utf8')).toContain('params.json')
  })

  it('is read again from the disk by a new run', async () => {
    await setOverride(dir, 'lid', false, true)
    forgetParamFiles()
    expect(overrideValues(dir)).toEqual({ lid: false })
  })

  it('refuses what is no value or no field name, and writes nothing', async () => {
    await expect(setOverride(dir, 'wall', Number.NaN, 2)).rejects.toThrow(/must be a number/)
    await expect(setOverride(dir, 'wall', { a: 1 }, 2)).rejects.toThrow(/must be a number/)
    await expect(setOverride(dir, '../x', 1, 2)).rejects.toThrow(/not the name/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reads a broken or foreign file as none', () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', 'params.json'), '{"overrides": {"wall": 3, "ok": {"value": 1, "default": 0}, "bad name": {"value": 1}}}')
    expect(overrideValues(dir)).toEqual({ ok: 1 })
    forgetParamFiles()
    writeFileSync(join(dir, '.torno', 'params.json'), 'nope')
    expect(overrideValues(dir)).toEqual({})
  })

  it('resets one field or all', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    await setOverride(dir, 'lip', 3, 2)
    await resetOverrides(dir, 'wall')
    expect(overrideValues(dir)).toEqual({ lip: 3 })
    await resetOverrides(dir)
    expect(filed()).toEqual({ overrides: {} })
  })

  it('goes back to what it was when the write fails', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    rmSync(join(dir, '.torno'), { recursive: true })
    writeFileSync(join(dir, '.torno'), 'a file where the folder was')
    await expect(setOverride(dir, 'wall', 3, 2)).rejects.toThrow()
    expect(overrideValues(dir)).toEqual({ wall: 2.4 })
  })
})

describe('reconcile', () => {
  it('keeps an override the build took, and tells the scene which', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    const scene = sceneOf([field('wall', 2, { value: 2.4 })], { applied: { wall: 2.4 }, dropped: [] })
    expect(await reconcile(dir, scene)).toEqual({ stale: false })
    expect(overrideValues(dir)).toEqual({ wall: 2.4 })
    expect(scene.overrides).toEqual({ applied: { wall: 2.4 }, dropped: [] })
  })

  it('drops an override when the file changed that default: the file wins, and the build is to be made again', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    const scene = sceneOf([field('wall', 2.2, { value: 2.4 })])
    expect(await reconcile(dir, scene)).toEqual({ stale: true })
    expect(overrideValues(dir)).toEqual({})
    expect(scene.overrides?.dropped).toEqual([{ name: 'wall', reason: "the file's default is now 2.2, not 2; the file wins" }])
    expect(overridesOf(dir).dropped).toHaveLength(1)
    // It stays said until the person says anything of that field.
    expect(await reconcile(dir, sceneOf([field('wall', 2.2)]))).toEqual({ stale: false })
    expect(overridesOf(dir).dropped).toHaveLength(1)
    await setOverride(dir, 'wall', 3, 2.2)
    expect(overridesOf(dir).dropped).toEqual([])
  })

  it('drops one equal to the default without a word, and needs no new build', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    const scene = sceneOf([field('wall', 2.4, { value: 2.4 })])
    // The file now says 2.4 itself, so its default differs from what was recorded: that is a change of the file.
    expect((await reconcile(dir, scene)).stale).toBe(true)
    await setOverride(dir, 'lip', 2, 2)
    const same = sceneOf([field('lip', 2, { value: 2 })])
    expect(await reconcile(dir, same)).toEqual({ stale: false })
    expect(overrideValues(dir)).toEqual({})
    expect(same.overrides?.dropped.map((d) => d.name)).toEqual(['wall'])
  })

  it('drops a field the model no longer offers, or the kernel refused, with the reason', async () => {
    await setOverride(dir, 'gone', 1, 1)
    await setOverride(dir, 'ribs', 2.5, 3)
    const scene = sceneOf([field('ribs', 3, { type: 'int', editable: 'int' })], { applied: {}, dropped: [{ name: 'ribs', reason: 'ribs is an int; 2.5 is not a whole number' }] })
    expect(await reconcile(dir, scene)).toEqual({ stale: true })
    expect(scene.overrides?.dropped).toEqual([
      { name: 'gone', reason: 'the model no longer offers gone' },
      { name: 'ribs', reason: 'ribs is an int; 2.5 is not a whole number' }
    ])
    expect(overrideValues(dir)).toEqual({})
  })

  it('does nothing against a kernel that does not read Params', async () => {
    await setOverride(dir, 'wall', 2.4, 2)
    expect(await reconcile(dir, { ...sceneOf([]), params: undefined })).toEqual({ stale: false })
    expect(overrideValues(dir)).toEqual({ wall: 2.4 })
  })
})

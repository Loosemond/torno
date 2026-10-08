import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSceneFile, saveSceneFile, type SceneFile } from './scenefile'

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
})

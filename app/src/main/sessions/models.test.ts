import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_ALIASES } from '../../shared/chat'
import { KnownModels, modelsOf } from './models'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-models-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('modelsOf', () => {
  it('keeps what can be chosen and passed, with the efforts the CLI says each takes', () => {
    expect(
      modelsOf([
        { value: 'default', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'high', 'bogus'] },
        { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
        { value: 'sonnet' },
        { value: '--bare', displayName: 'Not one' },
        { value: 'haiku', displayName: 'Again' },
        'opus',
        null
      ])
    ).toEqual([
      { value: 'default', displayName: 'Default (recommended)', efforts: ['low', 'high', 'max'] },
      { value: 'haiku', displayName: 'Haiku', efforts: [] },
      { value: 'sonnet', displayName: 'sonnet' }
    ])
  })

  it('is none of what is not a list', () => {
    expect(modelsOf(undefined)).toEqual([])
    expect(modelsOf({ value: 'opus' })).toEqual([])
  })
})

describe('the models known before a session', () => {
  it('are Claude Code\'s aliases until a CLI has said its own, then those, kept in the file', async () => {
    const file = join(temp(), 'models.json')
    const known = new KnownModels(file)
    expect(await known.list()).toEqual(MODEL_ALIASES)
    await known.heard([{ value: 'opus', displayName: 'Opus 5.5', efforts: ['low', 'max'] }])
    expect(await known.list()).toEqual([{ value: 'opus', displayName: 'Opus 5.5', efforts: ['low', 'max'] }])
    expect(await new KnownModels(file).list()).toEqual([{ value: 'opus', displayName: 'Opus 5.5', efforts: ['low', 'max'] }])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ models: [{ value: 'opus', displayName: 'Opus 5.5', efforts: ['low', 'max'] }] })
  })

  it('keep the last list for an empty one, and the aliases for a file that is not theirs', async () => {
    const file = join(temp(), 'models.json')
    writeFileSync(file, 'not json')
    const known = new KnownModels(file)
    expect(await known.list()).toEqual(MODEL_ALIASES)
    await known.heard([{ value: 'sonnet', displayName: 'Sonnet' }])
    await known.heard([])
    expect(await known.list()).toEqual([{ value: 'sonnet', displayName: 'Sonnet' }])
  })

  it('are of this run alone with no file', async () => {
    const known = new KnownModels(null)
    await known.heard([{ value: 'sonnet', displayName: 'Sonnet' }])
    expect(await known.list()).toEqual([{ value: 'sonnet', displayName: 'Sonnet' }])
    expect(await new KnownModels(null).list()).toEqual(MODEL_ALIASES)
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanWorkspace } from './workspace'

const FIXTURES = resolve(__dirname, '../../../kernel/tests/fixtures/ws')

describe('scanWorkspace on the fixture workspace', () => {
  it('lists every folder that holds a .py file, sorted by name, and skips the rest', async () => {
    const info = await scanWorkspace(FIXTURES)
    expect(info.root).toBe(FIXTURES)
    expect(info.hasProject).toBe(false)
    expect(info.objects.map((o) => o.id)).toEqual(
      ['bracket', 'broken', 'chatty', 'crash', 'exits', 'noscene', 'plain', 'slow', 'two']
    )
  })

  it('names the one model file, leaving test files out', async () => {
    const { objects } = await scanWorkspace(FIXTURES)
    const bracket = objects.find((o) => o.id === 'bracket')
    expect(bracket).toEqual({ id: 'bracket', name: 'bracket', dir: join(FIXTURES, 'bracket'), model: 'bracket.py' })
  })

  it('leaves the model null and names both files when there are two candidates', async () => {
    const { objects } = await scanWorkspace(FIXTURES)
    const two = objects.find((o) => o.id === 'two')!
    expect(two.model).toBeNull()
    expect(two.problem).toBe(`more than one model file in ${join(FIXTURES, 'two')}: a.py, b.py`)
  })
})

describe('scanWorkspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'torno-ws-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function object(name: string, files: string[]): void {
    mkdirSync(join(root, name), { recursive: true })
    for (const file of files) writeFileSync(join(root, name, file), '')
  }

  it('skips hidden, private and reserved folders, and files at the top level', async () => {
    writeFileSync(join(root, 'pyproject.toml'), '')
    writeFileSync(join(root, 'loose.py'), '')
    for (const name of ['.hidden', '_private', 'common', 'tests', 'out']) object(name, ['m.py'])
    object('gear', ['gear.py'])
    object('onlytests', ['test_x.py', 'x_test.py', 'conftest.py'])
    mkdirSync(join(root, 'nested', 'deep.py'), { recursive: true })

    const info = await scanWorkspace(root)
    expect(info.hasProject).toBe(true)
    expect(info.objects.map((o) => o.id)).toEqual(['gear', 'onlytests'])
    expect(info.objects[0].model).toBe('gear.py')
    expect(info.objects[1].model).toBeNull()
    expect(info.objects[1].problem).toBe(`no model file in ${join(root, 'onlytests')}`)
  })

  it('rejects a root that is not a folder', async () => {
    await expect(scanWorkspace(join(root, 'missing'))).rejects.toThrow(/missing/)
  })
})

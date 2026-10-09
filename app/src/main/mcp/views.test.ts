import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveView } from './views'

let dir: string
const numbers = () =>
  readdirSync(join(dir, '.torno', 'views'))
    .map((name) => Number(name.replace('.png', '')))
    .sort((a, b) => a - b)

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-views-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('saveView', () => {
  it('writes .torno/views/<n>.png, numbered on from the last, and returns the path', async () => {
    expect(await saveView(dir, new Uint8Array([1, 2, 3]))).toBe(join(dir, '.torno', 'views', '1.png'))
    expect(await saveView(dir, new Uint8Array([4]))).toBe(join(dir, '.torno', 'views', '2.png'))
    expect([...readFileSync(join(dir, '.torno', 'views', '1.png'))]).toEqual([1, 2, 3])
    expect(readdirSync(join(dir, '.torno', 'views'))).toEqual(['1.png', '2.png'])
  })

  it('keeps the newest 20', async () => {
    for (let i = 1; i <= 23; i += 1) await saveView(dir, new Uint8Array([i]))
    expect(numbers()).toEqual(Array.from({ length: 20 }, (_, i) => i + 4))
    expect([...readFileSync(join(dir, '.torno', 'views', '23.png'))]).toEqual([23])
  })

  it('gives pictures saved at the same time a number each', async () => {
    const paths = await Promise.all(Array.from({ length: 5 }, (_, i) => saveView(dir, new Uint8Array([i]))))
    expect(new Set(paths).size).toBe(5)
    expect(numbers()).toEqual([1, 2, 3, 4, 5])
  })
})

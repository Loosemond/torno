import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { defaultExportPath, htmlPath, prepareExports, writeExport } from './save'

const root = mkdtempSync(join(tmpdir(), 'torno-export-save-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('names the file after the object and its build, in a folder of torno\'s own', () => {
  expect(defaultExportPath('/ws/hollow', 'hollow', 12)).toBe('/ws/hollow/.torno/exports/hollow-r12.html')
  expect(defaultExportPath('/ws/hollow', 'ws')).toBe('/ws/hollow/.torno/exports/ws.html')
  expect(htmlPath('/tmp/a')).toBe('/tmp/a.html')
  expect(htmlPath('/tmp/a.HTML')).toBe('/tmp/a.HTML')
  expect(htmlPath('/tmp/a.htm')).toBe('/tmp/a.htm')
})

it('makes the folder the dialog opens in, has git pass over it, and touches nothing else of the object', async () => {
  const dir = join(root, 'hollow')
  mkdirSync(join(dir, '.torno'), { recursive: true })
  writeFileSync(join(dir, 'hollow.py'), '')
  writeFileSync(join(dir, '.torno', '.gitignore'), 'thumb.png\n')
  expect(await prepareExports(dir)).toBe(join(dir, '.torno', 'exports'))
  await prepareExports(dir)
  expect(readFileSync(join(dir, '.torno', '.gitignore'), 'utf8')).toBe('thumb.png\nexports/\n')
  expect(readdirSync(join(dir, '.torno', 'exports'))).toEqual([])
  expect(readdirSync(dir).sort()).toEqual(['.torno', 'hollow.py'])
})

it('writes the one file it was told to, and makes no folder and no other file for it', async () => {
  const out = join(root, 'out')
  mkdirSync(out)
  await writeExport(join(out, 'a.html'), '<!doctype html>one')
  await writeExport(join(out, 'a.html'), '<!doctype html>two')
  expect(readFileSync(join(out, 'a.html'), 'utf8')).toBe('<!doctype html>two')
  expect(readdirSync(out)).toEqual(['a.html'])
  await expect(writeExport(join(out, 'not', 'there', 'a.html'), 'x')).rejects.toThrow('ENOENT')
  expect(existsSync(join(out, 'not'))).toBe(false)
  await expect(writeExport('a.html', 'x')).rejects.toThrow('no whole path')
  expect(existsSync('a.html')).toBe(false)
})

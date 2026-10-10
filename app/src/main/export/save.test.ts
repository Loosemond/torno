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
  // A write that cannot be finished leaves the file that was there, whole, and nothing beside it.
  mkdirSync(join(out, 'taken.html'))
  writeFileSync(join(out, 'taken.html', 'inside'), 'kept')
  await expect(writeExport(join(out, 'taken.html'), 'x')).rejects.toThrow()
  expect(readdirSync(out).sort()).toEqual(['a.html', 'taken.html'])
  expect(readFileSync(join(out, 'taken.html', 'inside'), 'utf8')).toBe('kept')
  rmSync(join(out, 'taken.html'), { recursive: true })
  // The file beside it that the page is written into first has a name of that write alone: what a crash of a torno with this pid left there is not in its way, and is not touched.
  const beside = `${join(out, 'a.html')}.${process.pid}.tmp`
  writeFileSync(beside, 'left by a crash')
  await writeExport(join(out, 'a.html'), '<!doctype html>three')
  expect(readFileSync(join(out, 'a.html'), 'utf8')).toBe('<!doctype html>three')
  expect(readFileSync(beside, 'utf8')).toBe('left by a crash')
  expect(readdirSync(out).sort()).toEqual(['a.html', `a.html.${process.pid}.tmp`])
  rmSync(beside)
  await expect(writeExport(join(out, 'not', 'there', 'a.html'), 'x')).rejects.toThrow('ENOENT')
  expect(existsSync(join(out, 'not'))).toBe(false)
  await expect(writeExport('a.html', 'x')).rejects.toThrow('no whole path')
  expect(existsSync('a.html')).toBe(false)
})

// Final review M16: the test above passed with the page written straight to the chosen path. This one does not.
it('leaves the file that was there whole when the write fails midway, and nothing beside it', async () => {
  const out = join(root, 'midway')
  mkdirSync(out)
  await writeExport(join(out, 'a.html'), '<!doctype html>kept')
  // What cannot be written as a file's contents fails after the file to write into was opened.
  await expect(writeExport(join(out, 'a.html'), 12 as unknown as string)).rejects.toThrow()
  expect(readFileSync(join(out, 'a.html'), 'utf8')).toBe('<!doctype html>kept')
  expect(readdirSync(out)).toEqual(['a.html'])
})

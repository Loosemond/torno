import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { QUIT_MID_EXPORT, defaultExportPath, exportPath, exportsUnderWay, prepareExports, stopExports, writeExport } from './save'

const root = mkdtempSync(join(tmpdir(), 'torno-export-save-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('names the file after the object and its build, in a folder of torno\'s own', () => {
  expect(defaultExportPath('/ws/hollow', 'hollow', 12)).toBe('/ws/hollow/.torno/exports/hollow-r12.html')
  expect(defaultExportPath('/ws/hollow', 'ws')).toBe('/ws/hollow/.torno/exports/ws.html')
  expect(defaultExportPath('/ws/hollow', 'hollow', 12, '3mf')).toBe('/ws/hollow/.torno/exports/hollow-r12.3mf')
  expect(defaultExportPath('/ws/hollow', 'hollow-lid', 12, 'stl')).toBe('/ws/hollow/.torno/exports/hollow-lid-r12.stl')
  expect(defaultExportPath('/ws/hollow', 'hollow', 3, 'step')).toBe('/ws/hollow/.torno/exports/hollow-r3.step')
  expect(exportPath('/tmp/a', 'html')).toBe('/tmp/a.html')
  expect(exportPath('/tmp/a.HTML', 'html')).toBe('/tmp/a.HTML')
  expect(exportPath('/tmp/a.htm', 'html')).toBe('/tmp/a.htm')
  // Each format by its own extension: one of another format's is a name like any other.
  expect(exportPath('/tmp/a', 'step')).toBe('/tmp/a.step')
  expect(exportPath('/tmp/a.STP', 'step')).toBe('/tmp/a.STP')
  expect(exportPath('/tmp/a.stl', 'step')).toBe('/tmp/a.stl.step')
  expect(exportPath('/tmp/a.Stl', 'stl')).toBe('/tmp/a.Stl')
  expect(exportPath('/tmp/plate', '3mf')).toBe('/tmp/plate.3mf')
  expect(exportPath('/tmp/plate.html', '3mf')).toBe('/tmp/plate.html.3mf')
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

it('gives a file its name only once its check has passed, and leaves nothing when the check fails', async () => {
  const out = join(root, 'checked')
  mkdirSync(out)
  const bytes = Uint8Array.from([1, 2, 3, 4])
  let seen: string | null = null
  await writeExport(join(out, 'a.stl'), bytes, async (beside) => {
    // The file the check is given is whole and closed, beside the chosen one, which is not there yet.
    seen = beside
    expect(readFileSync(beside)).toEqual(Buffer.from(bytes))
    expect(readdirSync(out)).toEqual([beside.slice(out.length + 1)])
  })
  expect(seen).toMatch(/a\.stl\.[0-9a-f]{12}\.tmp$/)
  expect(readdirSync(out)).toEqual(['a.stl'])
  // A check that fails: no file under the chosen name, no .tmp, and what had the name before is as it was.
  await expect(writeExport(join(out, 'b.3mf'), bytes, async () => { throw new Error('not closed') })).rejects.toThrow('not closed')
  expect(readdirSync(out)).toEqual(['a.stl'])
  await expect(writeExport(join(out, 'a.stl'), Uint8Array.from([9]), async () => { throw new Error('not closed') })).rejects.toThrow('not closed')
  expect(readFileSync(join(out, 'a.stl'))).toEqual(Buffer.from(bytes))
  expect(readdirSync(out)).toEqual(['a.stl'])
})

it('gives up a write torno quits in the middle of, and is waited for until what it made is gone', async () => {
  const out = join(root, 'quitting')
  mkdirSync(out)
  expect(exportsUnderWay()).toBeNull()
  let checking = (): void => {}
  const asked = new Promise<void>((resolve) => (checking = resolve))
  // A check that never ends, as a kernel busy for minutes would be.
  const writing = writeExport(join(out, 'plate.3mf'), Uint8Array.from([1, 2, 3]), () => {
    checking()
    return new Promise<void>(() => {})
  })
  await asked
  expect(readdirSync(out)).toHaveLength(1)
  const waited = exportsUnderWay()
  expect(waited).not.toBeNull()
  stopExports()
  await expect(writing).rejects.toThrow(QUIT_MID_EXPORT)
  await waited
  // Nothing under the chosen name, nothing beside it, and nothing left to wait for.
  expect(readdirSync(out)).toEqual([])
  expect(exportsUnderWay()).toBeNull()
})

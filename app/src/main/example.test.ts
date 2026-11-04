import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadMarksFile } from './marks/file'
import { loadSceneFile } from './scenefile'
import { EXAMPLE_MARKER, EXAMPLE_OBJECTS, copiedOfExample, copyExample, exampleSource, removeExample, sweepExamples } from './example'

const made: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-example-test-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The repository's own example, which the app carries. */
const resources = resolve(__dirname, '../../resources/example')

/** A stand-in for the example's source: each project with its model, the marks and views, and what Python left. */
function stand(root: string): string {
  const source = join(root, 'example')
  for (const name of EXAMPLE_OBJECTS) {
    mkdirSync(join(source, name, '__pycache__'), { recursive: true })
    writeFileSync(join(source, name, `${name}.py`), `# ${name}\n`)
    writeFileSync(join(source, name, 'brief.md'), `# ${name}\n`)
    writeFileSync(join(source, name, '__pycache__', 'x.pyc'), 'x')
    mkdirSync(join(source, name, '.torno'))
    writeFileSync(join(source, name, '.torno', 'marks.json'), '{"next":1,"marks":[]}')
    writeFileSync(join(source, name, '.torno', 'scene.json'), '{"layers":{}}')
    writeFileSync(join(source, name, '.torno', 'thumb.png'), 'png')
    writeFileSync(join(source, name, '.DS_Store'), '')
  }
  return source
}

it('has an example in the repository: the project, its brief, its marks and its views', () => {
  expect(exampleSource(resolve(__dirname, '../..'), false)).toBe(resources)
  const files = readdirSync(join(resources, 'enclosure'), { recursive: true })
    .map(String)
    .filter((file) => !file.includes('__pycache__'))
    .sort()
  expect(files).toEqual(['.torno', '.torno/marks.json', '.torno/scene.json', 'brief.md', 'enclosure.py'])
  expect(JSON.parse(readFileSync(join(resources, 'enclosure', '.torno', 'marks.json'), 'utf8')).marks).toHaveLength(3)
  expect(JSON.parse(readFileSync(join(resources, 'enclosure', '.torno', 'scene.json'), 'utf8')).views).toHaveLength(2)
})

it('has marks and views that torno reads whole: three marks, one a dimension that fails, and two views', async () => {
  const copy = await copyExample(resources, temp())
  const project = join(copy, 'enclosure')
  const { file, problem } = await loadMarksFile(project)
  expect(problem).toBeUndefined()
  expect(file.marks.map((m) => [m.id, m.kind, m.status])).toEqual([['M1', 'pin', 'draft'], ['M2', 'arrow', 'draft'], ['M3', 'dimension', 'draft']])
  expect(file.marks[2]).toMatchObject({ expected: 0.2, tolerance: 0.05 })
  expect((await loadSceneFile(project)).views?.map((v) => v.name)).toEqual(['Lid fit', 'Cable side'])
  // Nothing was set aside or written beside them.
  expect(readdirSync(join(project, '.torno')).sort()).toEqual(['marks.json', 'scene.json'])
})

it('copies of a project of the example what it is made of: its marks and views too, not what Python or torno left', () => {
  const project = join('/x', 'enclosure')
  for (const kept of ['enclosure.py', 'brief.md', '.torno', '.torno/marks.json', '.torno/scene.json']) expect(copiedOfExample(project, join(project, kept)), kept).toBe(true)
  expect(copiedOfExample(project, project)).toBe(true)
  for (const left of ['__pycache__', '__pycache__/x.pyc', '.DS_Store', '.git', '.venv', 'tools/__pycache__']) expect(copiedOfExample(project, join(project, left)), left).toBe(false)
})

it('offers the example from the repository and from the resources of a packaged app, and copies it without touching it', async () => {
  const repo = temp()
  const source = stand(repo)
  expect(exampleSource(join(repo, 'elsewhere', 'app'), false)).toBeNull()
  // A packaged app carries the project in its resources, and has none without it.
  expect(exampleSource(join(repo, 'app'), true, join(repo, 'Resources'))).toBeNull()
  cpSync(source, join(repo, 'Resources', 'example'), { recursive: true })
  expect(exampleSource(join(repo, 'elsewhere', 'app'), true, join(repo, 'Resources'))).toBe(join(repo, 'Resources', 'example'))
  rmSync(join(repo, 'Resources', 'example', 'enclosure'), { recursive: true })
  expect(exampleSource(join(repo, 'app'), true, join(repo, 'Resources'))).toBeNull()

  const into = temp()
  const before = readdirSync(source, { recursive: true }).sort()
  const copy = await copyExample(source, into)
  expect(copy.startsWith(join(into, 'torno-example-'))).toBe(true)
  expect(readdirSync(copy).sort()).toEqual([EXAMPLE_MARKER, ...EXAMPLE_OBJECTS].sort())
  // Its marker says whose it is: the torno that made it.
  expect(JSON.parse(readFileSync(join(copy, EXAMPLE_MARKER), 'utf8'))).toMatchObject({ torno: 'example', pid: process.pid })
  expect(readdirSync(join(copy, 'enclosure'), { recursive: true }).map(String).sort()).toEqual(['.torno', '.torno/marks.json', '.torno/scene.json', 'brief.md', 'enclosure.py'])
  expect(readdirSync(source, { recursive: true }).sort()).toEqual(before)
  // Each asking is a copy of its own.
  expect(await copyExample(source, into)).not.toBe(copy)
})

it('sweeps the copies a crash left: only folders its own marker names, of a torno that is gone, and never through a link', async () => {
  const repo = temp()
  const ws = stand(repo)
  const into = temp()
  const mine = await copyExample(ws, into)
  const left = await copyExample(ws, into)
  // As a torno that crashed left it: its process is gone. (No process has this pid: it is above what the kernel gives.)
  writeFileSync(join(left, EXAMPLE_MARKER), JSON.stringify({ torno: 'example', pid: 2 ** 22 + 1, at: '2026-10-09T10:00:00.000Z' }))
  // A folder that only has the name; one whose marker is not torno's; a link of that name to a folder that is someone's.
  const named = join(into, 'torno-example-notmine')
  mkdirSync(join(named, 'work'), { recursive: true })
  const other = join(into, 'torno-example-other')
  mkdirSync(other)
  writeFileSync(join(other, EXAMPLE_MARKER), '{"torno": "something else", "pid": 4194305}')
  const theirs = temp()
  writeFileSync(join(theirs, EXAMPLE_MARKER), JSON.stringify({ torno: 'example', pid: 2 ** 22 + 1 }))
  writeFileSync(join(theirs, 'kept.txt'), 'kept')
  symlinkSync(theirs, join(into, 'torno-example-link'))
  expect(await sweepExamples(into)).toEqual([left])
  expect(existsSync(left)).toBe(false)
  // The one of a torno that still runs (this process) stays, and so does everything that is not a copy of torno's own.
  expect(existsSync(mine)).toBe(true)
  expect(existsSync(join(named, 'work'))).toBe(true)
  expect(existsSync(other)).toBe(true)
  expect(readFileSync(join(theirs, 'kept.txt'), 'utf8')).toBe('kept')
  // At the end of a run its own copy goes: only a folder with the marker, never whatever a path names.
  await removeExample(mine)
  expect(existsSync(mine)).toBe(false)
  await removeExample(named)
  await removeExample(join(into, 'torno-example-link'))
  expect(existsSync(join(named, 'work'))).toBe(true)
  expect(readFileSync(join(theirs, 'kept.txt'), 'utf8')).toBe('kept')
  // A temporary folder that is not there is nothing to sweep.
  expect(await sweepExamples(join(into, 'nowhere'))).toEqual([])
})

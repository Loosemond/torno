import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareExports } from './export/save'
import { ensureIgnored } from './ignored'
import { saveMarksFile } from './marks/file'
import { saveView } from './mcp/views'
import { FOLDER, onNotOwn, ownTorno, writeOwn } from './own'
import { saveScansFile } from './scans/file'
import { saveSceneFile } from './scenefile'
import { writeChoice } from './sessions/choice'
import { storeConversation } from './sessions/resume'
import { saveThumbnail } from './show/cards'
import { StateFiles } from './statefile'

let root: string
let obj: string

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-own-'))
  obj = join(root, 'ws', 'lid')
  mkdirSync(obj, { recursive: true })
})
afterEach(() => {
  onNotOwn(null)
  rmSync(root, { recursive: true, force: true })
})

const PNG = new Uint8Array([137, 80, 78, 71])
const OF = { layout: 'assembly', parts: 1, model: 'lid.py', sourcesMtimeMs: 1 }

/** Every writer of main that puts something under `<object>/.torno/`, by what it writes. */
const WRITERS: Record<string, (dir: string) => Promise<unknown>> = {
  'marks.json': (dir) => saveMarksFile(dir, { next: 1, marks: [] }),
  'scans.json': (dir) => saveScansFile(dir, { next: 1, scans: [] }),
  'scene.json': (dir) => saveSceneFile(dir, { layers: {} }),
  'agent.json': (dir) => writeChoice(dir, 'terminal'),
  'session.json': (dir) => storeConversation(dir, '11111111-1111-4111-8111-111111111111'),
  'thumb.png': (dir) => saveThumbnail(dir, PNG, OF, new Date()),
  '.gitignore': (dir) => ensureIgnored(dir, ['thumb.png']),
  'exports/': (dir) => prepareExports(dir),
  'views/': (dir) => saveView(dir, PNG),
  'state.md': (dir) =>
    new StateFiles({ object: () => ({ id: 'lid', name: 'lid', dir, model: 'lid.py' }), build: () => ({ objectId: 'lid', status: 'ok', revision: 1, seconds: 1 }) as never, scene: () => undefined, marks: async () => [] }).write('lid')
}

describe('ownTorno', () => {
  it('answers with the folder when there is none yet, and when it is a real folder', async () => {
    expect(await ownTorno(obj)).toBe(join(obj, FOLDER))
    expect(existsSync(join(obj, FOLDER))).toBe(false)
    mkdirSync(join(obj, FOLDER))
    expect(await ownTorno(obj)).toBe(join(obj, FOLDER))
  })

  it('refuses a link in its place, and a file, with a plain reason', async () => {
    symlinkSync('..', join(obj, FOLDER))
    await expect(ownTorno(obj)).rejects.toThrow(`${join(obj, FOLDER)} is a link, not a folder of torno's own inside the object: torno writes nothing there. Put a real folder in its place.`)
    rmSync(join(obj, FOLDER))
    writeFileSync(join(obj, FOLDER), '')
    await expect(ownTorno(obj)).rejects.toThrow(`${join(obj, FOLDER)} is a file, not a folder: torno writes nothing there. Remove it.`)
  })

  it('tells of a folder once, whoever was refused there and however often', async () => {
    const told: Array<[string, string]> = []
    onNotOwn((dir, message) => told.push([dir, message]))
    symlinkSync('..', join(obj, FOLDER))
    await expect(writeOwn(obj, 'a.json', '{}')).rejects.toThrow('is a link')
    await expect(writeOwn(obj, 'b.json', '{}')).rejects.toThrow('is a link')
    await expect(ownTorno(obj)).rejects.toThrow('is a link')
    expect(told).toEqual([[obj, expect.stringContaining('is a link')]])
  })
})

describe('what git is told to pass over', () => {
  const ignored = (): string[] => readFileSync(join(obj, FOLDER, '.gitignore'), 'utf8').split('\n').filter(Boolean)
  it('is what changes with every build or session: the state file and the session file among them', async () => {
    await WRITERS['state.md'](obj)
    expect(ignored()).toEqual(['state.md'])
    await WRITERS['session.json'](obj)
    await WRITERS['thumb.png'](obj)
    await WRITERS['exports/'](obj)
    await WRITERS['views/'](obj)
    expect(ignored()).toEqual(['state.md', 'session.json', 'thumb.png', 'thumb.json', 'exports/', 'views/'])
  })

  it('is never what travels with the object: its marks, its scene, its scans and its choice of view', async () => {
    for (const name of ['marks.json', 'scene.json', 'scans.json', 'agent.json']) await WRITERS[name](obj)
    expect(existsSync(join(obj, FOLDER, '.gitignore'))).toBe(false)
  })
})

describe('a linked .torno', () => {
  for (const [what, write] of Object.entries(WRITERS)) {
    it(`takes no ${what} with it: nothing is written where the link leads`, async () => {
      // `.torno -> ..`: whatever were written "inside" it would land in the workspace's own folder.
      symlinkSync('..', join(obj, FOLDER))
      const before = readdirSync(join(root, 'ws')).sort()
      await expect(write(obj)).rejects.toThrow('is a link')
      expect(readdirSync(join(root, 'ws')).sort()).toEqual(before)
      expect(readdirSync(obj)).toEqual([FOLDER])
    })

    it(`is no bar to ${what} in a folder of the object's own`, async () => {
      await write(obj)
      expect(readdirSync(join(obj, FOLDER)).some((name) => name === what.replace('/', '') || what === 'thumb.png')).toBe(true)
    })
  }
})

// Re-review m11: the scans had a guard of their own for the same rule, which told no one.
describe('the scans\' guard', () => {
  it('is the one rule: a linked .torno is refused in the same words, and the window is told', async () => {
    const { ownFolders } = await import('./scans/meshfiles')
    const told: string[] = []
    onNotOwn((_dir, message) => told.push(message))
    symlinkSync('..', join(obj, FOLDER))
    await expect(ownFolders(obj)).rejects.toThrow('is a link, not a folder of torno\'s own inside the object')
    await expect(ownFolders(obj, 'S1')).rejects.toThrow('is a link')
    expect(told).toHaveLength(1)
  })

  it('still refuses a link deeper down, where the scans are kept, by the same rule: the window is told of it', async () => {
    const { ownFolders } = await import('./scans/meshfiles')
    const told: Array<[string, string, string | null]> = []
    onNotOwn((dir, message, inside) => told.push([dir, message, inside]))
    mkdirSync(join(obj, FOLDER))
    symlinkSync('..', join(obj, FOLDER, 'scans'))
    const words = `${join(obj, FOLDER, 'scans')} is a link, not a folder of torno's own inside the object: torno writes nothing there and deletes nothing through it. Take the link away.`
    await expect(ownFolders(obj)).rejects.toThrow(words)
    await expect(ownFolders(obj, 'S1')).rejects.toThrow(words)
    expect(told).toEqual([[obj, words, 'scans']])
  })

  it('and one in the place of a scan\'s own folder', async () => {
    const { ownFolders } = await import('./scans/meshfiles')
    mkdirSync(join(obj, FOLDER, 'scans'), { recursive: true })
    symlinkSync('..', join(obj, FOLDER, 'scans', 'S1'))
    await ownFolders(obj)
    await expect(ownFolders(obj, 'S1')).rejects.toThrow(`${join(obj, FOLDER, 'scans', 'S1')} is a link, not a folder of torno's own inside the object`)
  })
})

// Re-review m11, its second half: a folder under `.torno` may be a link of its own, where `.torno` is a real folder.
describe('a link in the place of one of torno\'s folders under .torno', () => {
  const linked = (name: string, into = 'elsewhere'): string => {
    const target = join(root, into)
    mkdirSync(target, { recursive: true })
    mkdirSync(join(obj, FOLDER), { recursive: true })
    symlinkSync(target, join(obj, FOLDER, name))
    return target
  }
  const WORDS = (name: string): string => `${join(obj, FOLDER, name)} is a link, not a folder of torno's own inside the object: torno writes nothing there and deletes nothing through it. Take the link away.`

  it('is refused by ownTorno, which answers with the folder when it is a real one or not there yet', async () => {
    expect(await ownTorno(obj, 'views')).toBe(join(obj, FOLDER, 'views'))
    expect(existsSync(join(obj, FOLDER))).toBe(false)
    linked('views')
    await expect(ownTorno(obj, 'views')).rejects.toThrow(WORDS('views'))
    // `.torno` itself is still torno's own, and so are the folders beside the link.
    expect(await ownTorno(obj)).toBe(join(obj, FOLDER))
    expect(await ownTorno(obj, 'exports')).toBe(join(obj, FOLDER, 'exports'))
    writeFileSync(join(obj, FOLDER, 'exports'), '')
    await expect(ownTorno(obj, 'exports')).rejects.toThrow(`${join(obj, FOLDER, 'exports')} is a file, not a folder: torno writes nothing there. Remove it.`)
  })

  it('.torno/views: no picture is written where it leads, none there is deleted, and the window is told once', async () => {
    const target = linked('views')
    // Twenty-five pictures of someone else's, numbered as torno numbers its own: the oldest would be cleared away.
    for (let n = 1; n <= 25; n++) writeFileSync(join(target, `${n}.png`), 'theirs')
    const told: Array<[string, string, string | null]> = []
    onNotOwn((dir, message, inside) => told.push([dir, message, inside]))
    await expect(saveView(obj, PNG)).rejects.toThrow(WORDS('views'))
    await expect(saveView(obj, PNG)).rejects.toThrow(WORDS('views'))
    expect(readdirSync(target)).toHaveLength(25)
    expect(told).toEqual([[obj, WORDS('views'), 'views']])
    // Nothing was written beside it either: not a line for git about a folder that is not torno's.
    expect(readdirSync(join(obj, FOLDER))).toEqual(['views'])
  })

  it('.torno/exports: the folder is not made ready where it leads, and the window is told once', async () => {
    const target = linked('exports')
    const told: string[] = []
    onNotOwn((_dir, message) => told.push(message))
    await expect(prepareExports(obj)).rejects.toThrow(WORDS('exports'))
    await expect(prepareExports(obj)).rejects.toThrow(WORDS('exports'))
    expect(readdirSync(target)).toEqual([])
    expect(readdirSync(join(obj, FOLDER))).toEqual(['exports'])
    expect(told).toEqual([WORDS('exports')])
  })

  it('.torno/scans: nothing is made ready, and nothing swept, where it leads', async () => {
    const { ignoreMeshes, sweep } = await import('./scans/meshfiles')
    const target = linked('scans')
    // What an import that never ended leaves, which a sweep takes away in a folder of torno's own.
    mkdirSync(join(target, 'S1'))
    writeFileSync(join(target, 'S1', 'importing'), 'x\n')
    const told: string[] = []
    onNotOwn((_dir, message) => told.push(message))
    await expect(ignoreMeshes(obj)).rejects.toThrow(WORDS('scans'))
    await sweep(obj, [], new Set())
    expect(readdirSync(target)).toEqual(['S1'])
    expect(readdirSync(join(target, 'S1'))).toEqual(['importing'])
    expect(told).toEqual([WORDS('scans')])
  })

  it('each folder is told of by itself: one refusal does not silence another', async () => {
    linked('views')
    linked('exports', 'other')
    const told: Array<string | null> = []
    onNotOwn((_dir, _message, inside) => told.push(inside))
    await expect(saveView(obj, PNG)).rejects.toThrow('is a link')
    await expect(prepareExports(obj)).rejects.toThrow('is a link')
    await expect(saveView(obj, PNG)).rejects.toThrow('is a link')
    expect(told).toEqual(['views', 'exports'])
  })
})

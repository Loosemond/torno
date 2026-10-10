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
import { saveAgentChoice } from './sessions/choice'
import { blankPrompt } from './sessions/delivery'
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
  'agent.json': (dir) => saveAgentChoice(dir, 'copilot'),
  'prompt.md': (dir) => blankPrompt(dir),
  'session.json': (dir) => storeConversation(dir, 'claude', '11111111-1111-4111-8111-111111111111'),
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
  it('is what changes with every build, session or send: the state file and the session file among them', async () => {
    await WRITERS['state.md'](obj)
    expect(ignored()).toEqual(['state.md'])
    await WRITERS['session.json'](obj)
    await WRITERS['thumb.png'](obj)
    await WRITERS['exports/'](obj)
    await WRITERS['views/'](obj)
    expect(ignored()).toEqual(['state.md', 'session.json', 'thumb.png', 'thumb.json', 'exports/', 'views/'])
  })

  it('is never what travels with the object: its marks, its scene, its scans and its choice of agent', async () => {
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

  it('still refuses a link deeper down, where the scans are kept', async () => {
    const { ownFolders } = await import('./scans/meshfiles')
    mkdirSync(join(obj, FOLDER))
    symlinkSync('..', join(obj, FOLDER, 'scans'))
    await expect(ownFolders(obj)).rejects.toThrow('is a link: torno writes only inside the object\'s own folder')
  })
})

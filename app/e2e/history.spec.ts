import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import { openListed } from './objects'

// The builds kept of a project (#56): the strip in the window, the source of a build read only, and the request to
// go back to one, which is put in the message box and never sent; torno writes no file of the project for it.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

const model = () => join(root, 'hollow', 'hollow.py')
const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const dock = () => page.locator('[data-region="session"]')
const sheet = () => page.getByRole('dialog', { name: 'History of builds' })

async function builtRevision(revision: number): Promise<void> {
  await expect.poll(async () => { const s = await state(); return s.build?.status === 'ok' && s.build.revision }, { timeout: 30_000 }).toBe(revision)
}

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-history-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

test('three builds are three cards in the strip, newest first, with what changed in each', async () => {
  await openListed(page, 'hollow')
  await builtRevision(1)
  const source = readFileSync(model(), 'utf8')
  writeFileSync(model(), source.replace('wall: float = 2', 'wall: float = 3'))
  await builtRevision(2)
  writeFileSync(model(), source.replace('wall: float = 2', 'wall: float = 4'))
  await builtRevision(3)

  await page.getByRole('button', { name: 'History' }).click()
  await expect(sheet()).toBeVisible()
  const cards = sheet().locator('.history-card')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('r3')
  await expect(cards.nth(2)).toContainText('first build kept')
  await expect(cards.nth(0)).toContainText('tub, lid changed')
  // The pictures the window drew of the builds come with them, as they are made.
  await expect.poll(() => sheet().locator('.history-thumb img').count(), { timeout: 15_000 }).toBeGreaterThan(0)
  // They are under .torno/history/ and nowhere else, and git is told to pass over them.
  expect(existsSync(join(root, 'hollow', '.torno', 'history', 'index.json'))).toBe(true)
  expect(readFileSync(join(root, 'hollow', '.torno', '.gitignore'), 'utf8').split('\n')).toContain('history/')
})

test('the source of an earlier build is read only, as it was', async () => {
  const cards = sheet().locator('.history-card')
  await cards.nth(2).click()
  await sheet().getByRole('button', { name: 'Show the source' }).click()
  const pre = sheet().locator('[data-part="source"] pre')
  await expect(pre).toContainText('wall: float = 2')
  await expect(pre).not.toContainText('wall: float = 4')
  // Nothing in the sheet edits it.
  await expect(sheet().locator('textarea, input')).toHaveCount(0)
})

test('asking the agent to go back starts a session with the request in its box, naming the copies, and sends nothing', async () => {
  await sheet().locator('.history-card').nth(2).click()
  const id = await sheet().locator('.history-card').nth(2).getAttribute('data-build')
  const before = readFileSync(model(), 'utf8')
  await sheet().getByRole('button', { name: 'Ask the agent to go back to this build' }).click()
  const box = dock().locator('[data-chat-composer]')
  const copy = join(root, 'hollow', '.torno', 'history', id!, 'source', 'hollow', 'hollow.py')
  await expect(box).toHaveValue(new RegExp(`Go back to build ${id}.*${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*Do not edit the copies\\.`), { timeout: 30_000 })
  await expect(dock().locator('.chat-user')).toHaveCount(0)
  // torno put nothing back itself.
  expect(readFileSync(model(), 'utf8')).toBe(before)
  expect(readFileSync(copy, 'utf8')).toContain('wall: float = 2')
})

test('a star keeps a build, and the sheet says so', async () => {
  const card = sheet().locator('.history-card').nth(2)
  await card.click()
  await sheet().getByRole('button', { name: 'Star', exact: true }).click()
  await expect(card).toContainText('★')
  await expect(sheet().getByRole('button', { name: 'Unstar' })).toBeVisible()
  const index = JSON.parse(readFileSync(join(root, 'hollow', '.torno', 'history', 'index.json'), 'utf8'))
  expect(index.entries.filter((e: { starred?: boolean }) => e.starred)).toHaveLength(1)
})

test('an earlier build of this run is drawn over the current one, for looking only, and goes when it is put away', async () => {
  const keys = () => page.evaluate(() => window.__tornoTest!.earlier())
  expect(await keys()).toEqual([])
  const card = sheet().locator('.history-card').nth(2)
  await card.click()
  const show = sheet().getByRole('button', { name: 'Show over the current build' })
  await expect(show).toBeEnabled()
  const before = readFileSync(model(), 'utf8')
  await show.click()
  await expect.poll(keys).toEqual(['assembly:tub', 'assembly:lid'])
  await expect(page.locator('.status-compare')).toContainText('Showing h')
  // Looking changes nothing: not the model, not the build.
  expect(readFileSync(model(), 'utf8')).toBe(before)
  expect((await state()).build?.revision).toBe(3)
  await sheet().getByRole('button', { name: 'Close' }).click()
  await page.locator('.status-compare').click()
  await expect.poll(keys).toEqual([])
  await expect(page.locator('.status-compare')).toHaveCount(0)
})

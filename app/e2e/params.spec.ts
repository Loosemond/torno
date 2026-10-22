import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import { openListed } from './objects'

// The model's Params in the left column, read only: a row for each field with its default in the monospace face and
// its comment as written, a default worked out in the model said so, and a click that puts `Params.<name>` at the
// cursor of the session's box. The model is written into the test's own copy of the fixtures (the fixtures are
// never touched): a commented field, a comment above, an expression default, an int and a long float.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-params-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  const model = join(root, 'hollow', 'hollow.py')
  const source = readFileSync(model, 'utf8')
  const fields = [
    '    side: float = 40  # Outer width, mm',
    '    wall: float = 2',
    '    # Room left round the post',
    '    gap: float = 0.123456',
    '    inner: float = 40 - 2 * 2  # Worked out from side and wall',
    '    ribs: int = 4'
  ].join('\n')
  const written = source.replace(/    side: float = 40\n    wall: float = 2\n/, `${fields}\n`)
  expect(written).not.toBe(source)
  writeFileSync(model, written)
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const section = () => page.locator('.left .params')
const dock = () => page.locator('[data-region="session"]')
const composer = () => dock().locator('[data-chat-composer]')

async function open(name: string): Promise<void> {
  await openListed(page, name)
  await expect.poll(async () => { const s = await state(); return s.objectId === name && s.build?.status }, { timeout: 30_000 }).toBe('ok')
}

test('a model with no Params has no section', async () => {
  await open('plain')
  await expect(page.locator('.left .layers')).toBeVisible()
  await expect(section()).toHaveCount(0)
})

test('the section is under the layers, folded to its title with the count, and opens to a row for each field', async () => {
  await open('hollow')
  await expect(section()).toBeVisible()
  const order = await page.locator('.left > section').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  expect(order.indexOf('Parameters')).toBe(order.indexOf('Layers') + 1)
  const title = section().getByRole('button', { name: 'Parameters', exact: true })
  await expect(title).toHaveAttribute('aria-expanded', 'false')
  await expect(title.locator('.section-said')).toHaveText('5')
  await expect(section().locator('[data-param]')).toHaveCount(0)
  await title.click()
  await expect(title).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => section().locator('[data-param]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-param')))).toEqual(['side', 'wall', 'gap', 'inner', 'ribs'])
})

test('a row has the name and the value in the monospace face, the comment as written, and says a default is worked out in the model', async () => {
  const row = (name: string) => section().locator(`[data-param="${name}"]`)
  await expect(row('side').locator('.param-value')).toHaveText('40')
  await expect(row('side').locator('.param-doc')).toHaveText('Outer width, mm')
  // A comment above the field is the field's, a field with none shows none.
  await expect(row('gap').locator('.param-doc')).toHaveText('Room left round the post')
  await expect(row('wall').locator('.param-doc')).toHaveCount(0)
  await expect(row('ribs').locator('.param-value')).toHaveText('4')
  // Four digits at most, the whole value in the title.
  await expect(row('gap').locator('.param-value')).toHaveText('0.1235')
  await expect(row('gap').locator('.param-value')).toHaveAttribute('title', '0.123456')
  // An expression is worked out in the model, and its value is still shown.
  await expect(row('inner').locator('.param-worked')).toHaveText('worked out in the model')
  await expect(row('inner').locator('.param-value')).toHaveText('36')
  await expect(row('side').locator('.param-worked')).toHaveCount(0)
  // The face of the numbers, the one of the layers' names.
  const face = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily)
  expect(await face('.left .param-value')).toBe(await face('.left .layer-row .row-name'))
  expect(await face('.left .param-name')).toBe(await face('.left .layer-row .row-name'))
  expect(await face('.left .param-doc')).not.toBe(await face('.left .param-value'))
})

test('with no session running the rows are text, and say why', async () => {
  await expect(section().locator('button.param-button')).toHaveCount(0)
  await expect(section().locator('[data-param="wall"] .param-button')).toHaveAttribute('aria-description', 'Start a session to put Params.wall in its prompt')
})

test('with a session, a click puts Params.<name> at the cursor of the box and sends nothing', async () => {
  await dock().getByRole('button', { name: 'New session' }).click()
  await expect(dock().locator('.chat')).toBeVisible()
  await expect(composer()).toBeFocused()
  await composer().fill('make')
  const wall = section().getByRole('button', { name: 'Params.wall', exact: true })
  await expect(wall).toHaveAttribute('aria-description', "Put Params.wall in the session's prompt")
  await wall.click()
  await expect(composer()).toHaveValue('make Params.wall ')
  await expect(composer()).toBeFocused()
  await page.keyboard.type('2.4')
  await expect(composer()).toHaveValue('make Params.wall 2.4')
  await expect(dock().locator('.chat-user')).toHaveCount(0)
  // Nothing was written: the model is as it was.
  expect(readFileSync(join(root, 'hollow', 'hollow.py'), 'utf8')).toContain('wall: float = 2\n')
})

test('a fold is the window\'s: it is kept when another object is opened', async () => {
  const title = section().getByRole('button', { name: 'Parameters', exact: true })
  await title.click()
  await expect(section().locator('[data-param]')).toHaveCount(0)
  await open('plain')
  await open('hollow')
  await expect(section().getByRole('button', { name: 'Parameters', exact: true })).toHaveAttribute('aria-expanded', 'false')
})

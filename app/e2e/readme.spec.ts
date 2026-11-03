import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import { openListed } from './objects'

// The pictures of the README (docs/images/README.md): the window in the states it describes, one hidden launch
// each, written to <TORNO_README_SHOTS>/<shot>.png with a <shot>.json beside it holding the boxes of the regions
// the README crops to. Skipped unless TORNO_README_SHOTS is set: it is not a test of anything.
//
// The window is hidden (TORNO_TEST=1), as app/e2e/CLAUDE.md asks of every launch, and webContents.capturePage()
// gives one picture a launch. The agent is the stand-in: the chat it shows is what torno really rendered of a
// scripted turn, with one cosmetic edit, said where it is made: the person's prompt is the stand-in's script, so
// the text of that one bubble is replaced by the words a person would have typed before the capture.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
const out = process.env.TORNO_README_SHOTS ?? ''
const SIZE: [number, number] = [1600, 1000]

type Theme = 'light' | 'dark'
type Main = { pickSave: string | null }
const temp = (name: string): string => mkdtempSync(join(realpathSync(tmpdir()), `torno-readme-${name}-`))

const CAMERA = { position: [120, -90, 60], target: [0, 0, 6], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

/** A copy of the fixtures in which `hollow` carries the marks of the walk-through: a pin, two dimensions that pass and one that fails. */
function workspace(): string {
  const root = join(temp('ws'), 'parts')
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') && !/\/(broken|chatty|crash|exits|makers|morph|noscene|plain|slow|two)(\/|$)/.test(source) })
  mkdirSync(join(root, 'hollow', '.torno'), { recursive: true })
  const base = { author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, camera: CAMERA, createdAt: '2026-10-09T20:00:00.000Z' }
  writeFileSync(
    join(root, 'hollow', '.torno', 'marks.json'),
    JSON.stringify({
      next: 5,
      marks: [
        { ...base, id: 'M1', kind: 'pin', status: 'draft', note: 'too thin here', anchor: { point: [20, 0, 20], normal: [1, 0, 0], part: 'tub' } },
        { ...base, id: 'M2', kind: 'dimension', note: 'outer width', measure: 'distance', a: { point: [-20, 0, 10], normal: [-1, 0, 0], part: 'tub' }, b: { point: [20, 0, 10], normal: [1, 0, 0], part: 'tub' }, expected: 40 },
        { ...base, id: 'M3', kind: 'dimension', note: 'height with the lid', measure: 'distance', a: { point: [0, 0, 0], normal: [0, 0, -1], part: 'tub' }, b: { point: [0, 0, 40], normal: [0, 0, 1], part: 'lid' }, expected: 40 },
        { ...base, id: 'M4', kind: 'dimension', note: 'wall', measure: 'thickness', a: { point: [-20, 0, 20], normal: [-1, 0, 0], part: 'tub' }, expected: 3 }
      ]
    })
  )
  return root
}

/** Starts torno hidden, in a theme, at the README's size, with a home of its own so that nothing of the person's is listed. */
async function start(theme: Theme, env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const home = temp('home')
  const app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, HOME: home, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, FAKE_AGENT_INIT: JSON.stringify({ model: 'claude-opus-5-5' }), ...env } })
  await app.evaluate(({ nativeTheme }, theme) => void (nativeTheme.themeSource = theme), theme)
  const page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: theme })
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), SIZE)
  return { app, page }
}

const state = (page: Page): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())

async function open(page: Page, id: string, status = 'ok'): Promise<void> {
  await openListed(page, id)
  await expect.poll(async () => ((await state(page)).objectId === id ? (await state(page)).build?.status : null), { timeout: 90_000 }).toBe(status)
  if (status === 'ok') await expect.poll(async () => (await state(page)).scene !== null).toBe(true)
}

/** The boxes of the window's regions, in px of the picture, for the crops the README wants. */
async function boxes(page: Page): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  const found: Record<string, { x: number; y: number; width: number; height: number }> = {}
  for (const region of ['left', 'viewport', 'session']) {
    const box = (await page.locator(`[data-region="${region}"]`).count()) > 0 ? await page.locator(`[data-region="${region}"]`).first().boundingBox() : null
    if (box) found[region] = box
  }
  return found
}

/** The whole window as it is drawn, once: fonts loaded, a frame drawn, the focus shown as in a window in use. */
async function capture(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  await page.waitForTimeout(400)
  const regions = await boxes(page)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${name}.png`), Buffer.from(png, 'base64'))
  writeFileSync(join(out, `${name}.json`), JSON.stringify(regions))
}

/** Types a script for the stand-in as one prompt and sends it. */
async function prompt(page: Page, lines: string[]): Promise<void> {
  const box = page.locator('[data-chat-composer]')
  await expect(box).toBeFocused()
  for (const [n, line] of lines.entries()) {
    if (n > 0) await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(line)
  }
  await page.keyboard.press('Enter')
}

/** The one cosmetic edit: the person's prompt bubble shows the words a person typed, not the stand-in's script. */
async function wording(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const bubble = document.querySelector('.chat-user-text')
    if (bubble) bubble.textContent = text
  }, text)
}

const SHOTS = ['hero', 'hero-dark', 'marks', 'chat', 'section', 'objects', 'first-screen'] as const

for (const shot of SHOTS) {
  test(`README picture: ${shot}`, async () => {
    test.skip(!out, 'TORNO_README_SHOTS is not set')
    test.setTimeout(240_000)
    const theme: Theme = shot === 'hero-dark' ? 'dark' : 'light'
    const root = workspace()
    const env: Record<string, string> = shot === 'first-screen' ? {} : { TORNO_WORKSPACE: root }
    const { app, page } = await start(theme, env)
    try {
      if (shot === 'first-screen') {
        await expect(page.locator('.ready')).toBeVisible()
        await page.waitForTimeout(800)
      } else {
        await page.waitForSelector('[data-region="left"]')
        await open(page, 'hollow')
      }
      if (shot === 'hero' || shot === 'hero-dark') {
        // A conversation about the marks: the pin goes with the prompt, the agent looks, measures on the B-rep and answers.
        await page.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
        await prompt(page, [
          'say You marked three things on the tub. **M1** is a pin on the outer wall, "too thin here". **M2**, the outer width, passes at 40 mm. **M4**, the wall, fails: 2 mm against the 3 mm you asked for. Let me look at M1 and measure it.',
          'tool mcp__torno__look {"view":"iso"}',
          'tool mcp__torno__measure {"kind":"thickness","a":{"ref":"tub/F5","point":[20,0,20]}}',
          'say The wall at **M1** is 2 mm, measured on the solid, not the mesh. `wall` in `hollow.py` is the one parameter behind it. I will raise it to 3 mm and rebuild, and M4 should pass on the next build.'
        ])
        await expect(page.locator('.chat-turn')).toContainText('Pulled from torno: look, 1 picture', { timeout: 60_000 })
        await expect(page.locator('.chat-item[data-kind="user"]').last()).toHaveAttribute('data-state', 'sent', { timeout: 60_000 })
        await expect.poll(async () => page.locator('.chat-text').count(), { timeout: 60_000 }).toBeGreaterThan(1)
        await wording(page, 'What did I mark? Is the wall at M1 thick enough to print?')
        await page.locator('.mark-row[data-mark="M4"]').click()
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      } else if (shot === 'marks') {
        // The view and the Marks list, the session pane away: a pin with its note open, a dimension that passes, one that fails.
        await page.getByRole('button', { name: 'Hide session', exact: true }).click()
        await page.waitForTimeout(400)
        const at = (await page.evaluate(() => window.__tornoTest!.markScreen('M4')))!
        const view = (await page.locator('[data-region="viewport"] canvas').first().boundingBox())!
        await page.mouse.move(view.x + at.x * view.width, view.y + at.y * view.height)
        await expect(page.locator('.pick-readout')).toContainText('under')
      } else if (shot === 'chat') {
        // The agent's turn: the prompt with the marks torno added opened to its text, look with its picture, an edit and its build.
        await page.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
        await prompt(page, [
          'say The tub wall at **M1** is 2 mm, thinner than the 3 mm of **M4**. Looking at it:',
          'tool mcp__torno__look {"view":"iso"}',
          'tool mcp__torno__measure {"kind":"thickness","a":{"ref":"tub/F5","point":[20,0,20]}}',
          'say 2 mm on the solid. I will set `wall` to 3 mm and rebuild.',
          'edit hollow.py "wall: float = 2" "wall: float = 3"',
          'say Built: the wall is 3 mm and M4 passes.'
        ])
        await expect(page.locator('.chat-turn')).toContainText('Pulled from torno: look, 1 picture', { timeout: 60_000 })
        await expect(page.locator('.chat-build').first()).toContainText('Built r2', { timeout: 90_000 })
        await expect.poll(async () => page.locator('.chat-text').count(), { timeout: 60_000 }).toBeGreaterThan(2)
        await wording(page, 'The wall at M1 is too thin. Make it 3 mm.')
        await page.locator('.chat-added').first().getByRole('button', { name: 'Show text' }).click()
      } else if (shot === 'section') {
        await page.getByRole('button', { name: 'Hide session', exact: true }).click()
        await page.keyboard.press('x')
        await page.getByRole('button', { name: 'Cut across Y' }).click()
        await expect.poll(async () => (await state(page)).section !== null).toBe(true)
        await page.waitForTimeout(600)
      } else if (shot === 'objects') {
        // The page of objects, each built once so that its card has a picture.
        for (const id of ['bracket', 'measures', 'gauge', 'spread', 'grouped']) await open(page, id)
        await open(page, 'hollow')
        await page.locator('[data-region="viewport"] canvas').first().click({ position: { x: 5, y: 5 } })
        await page.keyboard.press('w')
        await expect(page.locator('.card[data-object="hollow"] img')).toHaveJSProperty('naturalWidth', 480, { timeout: 60_000 })
        await page.waitForTimeout(600)
        await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0) el.scrollTop = 0 }))
      }
      await capture(app, page, shot)
    } finally {
      await app.close()
    }
  })
}

test('README picture: export, the page in a browser', async () => {
  test.skip(!out, 'TORNO_README_SHOTS is not set')
  test.setTimeout(240_000)
  const root = workspace()
  const { app, page } = await start('light', { TORNO_WORKSPACE: root })
  const file = join(root, 'hollow.html')
  try {
    await page.waitForSelector('[data-region="left"]')
    await open(page, 'hollow')
    await app.evaluate((_electron, to) => void ((globalThis as unknown as { __tornoMain: Main }).__tornoMain.pickSave = to), file)
    await page.getByRole('button', { name: 'Export…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Export' })
    await expect(sheet).toContainText('hollow')
    await sheet.getByRole('checkbox', { name: /Include marks and their notes/ }).check()
    await sheet.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByText(`Saved to ${file}`)).toBeVisible({ timeout: 60_000 })
  } finally {
    await app.close()
  }
  // The exported file, in a browser of Playwright's own (headless, never a window on the desktop): the viewer draws, then the shot.
  const browser = await chromium.launch()
  try {
    const tab = await browser.newPage({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 1 })
    await tab.goto(`file://${file}`)
    await tab.waitForSelector('canvas')
    await tab.waitForTimeout(2500)
    mkdirSync(out, { recursive: true })
    await tab.screenshot({ path: join(out, 'export.png') })
  } finally {
    await browser.close()
  }
})

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import { SESSION_HEADER } from '../src/main/http'
import { openListed } from './objects'

// The frames of the README's recording of the loop (docs/images/demo.gif and demo.mp4): a person pins the wall of
// hollow with "too thin here", asks for 3 mm, the agent looks, edits the model, the part rebuilds and the dimension
// "wall" turns from failing to passing. Never part of the suite: skipped unless TORNO_DEMO names the folder the frames
// are written to (`<TORNO_DEMO>/frame-NN.png`). Remade with docs/images/demo-frames/make.sh.
//
// The window is hidden (TORNO_TEST=1) and the agent is the stand-in (app/test/fake-agent.mjs): no real CLI is run.
// webContents.capturePage() gives one image a launch, so each frame is a launch of its own, driven from the start to
// its moment. The prompt the stand-in is sent is its script; the one cosmetic edit of a frame is that, once the turn
// is drawn, the text of the person's prompt bubble is set to the words a person would have typed (`naturalPrompt`).
// Everything else on screen is what torno drew.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
const W = 1600
const H = 1000

type Vec3 = [number, number, number]
const CAMERA = { position: [120, -90, 60], target: [0, 0, 6], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
/** Where the person pins the wall: the outer face of the tub at +X. */
const PIN_AT: Vec3 = [20, 9, 27]
const VIEW = { position: [75, -85, 60], target: [4, 0, 16], up: [0, 0, 1], ortho: false, fov: 35 }
const PROJECTS = ['bracket', 'gauge', 'grouped', 'hollow', 'measures', 'plain', 'spread']
const PROMPT = 'The wall at M2 is too thin. Make it 3 mm.'

/** A copy of the fixtures in which hollow has the person's dimension "wall", 3 mm expected (the model has 2). */
function workspace(): { root: string; home: string } {
  const top = mkdtempSync(join(realpathSync(tmpdir()), 'torno-demo-'))
  // A home of its own, so that no file of the person's (their ~/.claude/CLAUDE.md) is listed in the session pane.
  const home = join(top, 'home')
  mkdirSync(home)
  const root = join(top, 'workshop')
  // The projects that build and look like parts: not the fixtures made to fail.
  for (const name of PROJECTS) cpSync(join(fixtures, name), join(root, name), { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  mkdirSync(join(root, 'hollow', '.torno'), { recursive: true })
  const base = { author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, camera: CAMERA, createdAt: '2026-10-09T20:00:00.000Z' }
  writeFileSync(
    join(root, 'hollow', '.torno', 'marks.json'),
    JSON.stringify({ next: 2, marks: [{ ...base, id: 'M1', kind: 'dimension', note: 'wall', measure: 'thickness', a: { point: [20, 9, 12], normal: [1, 0, 0], part: 'tub' }, expected: 3 }] })
  )
  return { root: top, home }
}

async function start(root: string, home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, FAKE_AGENT_INIT: JSON.stringify({ model: 'claude-opus-5-5' }), TORNO_WORKSPACE: join(root, 'workshop'), HOME: home } })
  await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'light'))
  const page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: 'light' })
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H])
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([W, H])
  // No red underline of the spell checker under "M2" in the box.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.setSpellCheckerEnabled(false))
  return { app, page }
}

async function mcp(app: ElectronApplication): Promise<Client> {
  const { url, token } = await app.evaluate((_electron) => (globalThis as unknown as { __tornoMain: { mcpFor(id: string): { url: string; token: string } } }).__tornoMain.mcpFor('hollow'))
  const client = new Client({ name: 'torno-demo', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { [SESSION_HEADER]: token } } }))
  return client
}

const state = (page: Page): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const canvas = (page: Page) => page.locator('[data-region="viewport"] canvas').first()
const dock = (page: Page) => page.locator('[data-region="session"]')

async function capture(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  const dir = resolve(process.env.TORNO_DEMO!)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.png`), Buffer.from(png, 'base64'))
}

async function pointAt(page: Page, point: Vec3): Promise<[number, number]> {
  const [fx, fy] = await page.evaluate((at) => window.__tornoTest!.project(at), point)
  const box = (await canvas(page).boundingBox())!
  return [box.x + fx * box.width, box.y + fy * box.height]
}

/** The one cosmetic edit: the person's prompt bubble says what a person would have typed, M2 as the chip torno drew for it. */
async function naturalPrompt(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const bubble = document.querySelector('.chat-user .chat-user-text')!
    const chip = document.querySelector('.chat-added .ref-chip[data-ref="M2"]')?.cloneNode(true)
    const [before, after] = text.split('M2')
    bubble.replaceChildren(document.createTextNode(before), ...(chip ? [chip] : [document.createTextNode('M2')]), document.createTextNode(after))
  }, PROMPT)
}

/** What the stand-in does, in the order it does it; each frame of the agent's turn sends the script up to its step. */
function script(ref: string, upTo: 'look' | 'edit' | 'all'): string {
  const lines = [
    'say Looking at **M2** and the dimension **M1** first.',
    'tool mcp__torno__look {"view":"iso","section":{"origin":[0,0,0],"normal":[0,-1,0]}}',
    `tool mcp__torno__measure {"kind":"thickness","a":{"ref":"${ref}","point":[${PIN_AT.join(',')}]}}`,
    'say The tub wall is 2 mm, and M1 expects 3. It is the `wall` parameter of `hollow.py`.'
  ]
  if (upTo !== 'look') lines.push('edit hollow.py "wall: float = 2" "wall: float = 3"')
  if (upTo === 'all') lines.push('tool mcp__torno__resolve_mark {"id":"M2","note":"wall is 3 mm now"}', 'say Done: `wall` is 3 mm, r2 built, and **M1** passes.')
  return lines.join('\n')
}

/** The moments of the recording, in order; each is a launch driven from the start to it. */
const FRAMES = ['open', 'pin', 'pinned', 'compose', 'look', 'edit', 'done', 'passes'] as const
type Frame = (typeof FRAMES)[number]
const past = (frame: Frame, step: Frame): boolean => FRAMES.indexOf(frame) > FRAMES.indexOf(step)

for (const [n, frame] of FRAMES.entries()) {
  test(`demo frame ${n + 1}: ${frame}`, async () => {
    test.skip(!process.env.TORNO_DEMO, 'TORNO_DEMO is not set')
    test.setTimeout(180_000)
    const { root, home } = workspace()
    const { app, page } = await start(root, home)
    const row = (id: string) => page.locator(`.mark-row[data-mark="${id}"]`)
    try {
      await page.waitForSelector('[data-region="left"]')
      await openListed(page, 'hollow')
      await expect.poll(async () => ((await state(page)).objectId === 'hollow' ? (await state(page)).build?.status : null), { timeout: 60_000 }).toBe('ok')
      await expect.poll(async () => (await state(page)).scene !== null).toBe(true)
      await expect(row('M1').locator('.mark-value')).toHaveAttribute('data-verdict', 'fail', { timeout: 30_000 })
      // The tub cut in half across Y, the front half taken away: its walls are seen in section.
      await page.keyboard.press('x')
      await page.getByRole('button', { name: 'Cut across Y' }).click()
      await expect.poll(async () => (await state(page)).section !== null).toBe(true)
      // The camera a person would turn to, to see the cut wall and the outside of it: put there as the show tool does.
      const client = await mcp(app)
      const shown = await client.callTool({ name: 'show', arguments: { view: VIEW } })
      expect(shown.isError === true).toBe(false)
      await client.close()
      await page.waitForTimeout(800)

      if (past(frame, 'open')) {
        // The pin, with its note being written.
        await page.keyboard.press('p')
        const [x, y] = await pointAt(page, PIN_AT)
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.up()
        await expect(page.locator('.note-card textarea')).toBeFocused()
        await page.keyboard.type('too thin here')
      }
      if (past(frame, 'pin')) {
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await state(page)).marks.find((m) => m.id === 'M2')?.status).toBe('draft')
        await page.keyboard.press('Escape')
      }
      if (frame === 'pinned') {
        // The dimension's row opened: what it says of the wall.
        await row('M1').click()
        await expect(row('M1').locator('.dimension-verdict')).toHaveText('Fails: 1 under')
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(W / 2, H - 40)
      }
      if (past(frame, 'pinned')) {
        await dock(page).getByRole('button', { name: 'New session' }).click()
        await expect(page.locator('[data-chat-composer]')).toBeFocused()
      }
      if (frame === 'compose') await page.keyboard.type(PROMPT)
      if (past(frame, 'compose')) {
        const pin = (await state(page)).marks.find((m) => m.id === 'M2') as unknown as { anchor: { ref: string } }
        await page.locator('[data-chat-composer]').fill(script(pin.anchor.ref, frame === 'look' ? 'look' : frame === 'edit' ? 'edit' : 'all'))
        await page.keyboard.press('Enter')
        await expect(page.locator('.chat-turn')).toBeVisible({ timeout: 60_000 })
      }
      if (past(frame, 'look')) {
        await expect(page.locator('.chat-build').first()).toContainText('Built r2 · ok', { timeout: 60_000 })
        await expect(row('M1').locator('.mark-value')).toHaveAttribute('data-verdict', 'pass', { timeout: 30_000 })
        await expect.poll(async () => (await state(page)).scene !== null && (await state(page)).build?.revision === 2).toBe(true)
        await page.waitForTimeout(800)
      }
      if (frame === 'edit') {
        // The edit opened to its lines.
        await page.locator('.chat-tool', { hasText: 'Edit hollow.py' }).locator('.chat-tool-line').click()
        await expect(page.locator('.chat-tool .diff')).toBeVisible()
      }
      if (frame === 'passes') {
        await row('M1').click()
        await expect(row('M1').locator('.dimension-verdict')).toHaveText('Passes')
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        // What the agent resolved, opened: M2 with its line.
        await page.getByRole('button', { name: 'Review' }).click()
        await page.mouse.move(W / 2, H - 40)
      }
      if (past(frame, 'compose')) await naturalPrompt(page)
      await capture(app, page, `frame-${String(n + 1).padStart(2, '0')}`)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

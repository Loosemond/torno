import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { Camera } from '../src/shared/view'

// Saved views, through the window and through the agent's tools: the view on screen is kept under a name in the
// object's scene file, put back with a click, drawn and shown by name for the agent, which proposes its own.
// The agent in the session pane is the stand-in.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
/** Where a picture of a saved view is left for whoever wants to look at one: outside the workspace. */
const pictures = process.env.TORNO_E2E_PICTURES

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page
const clients: Client[] = []

type Content = Array<{ type: string; text?: string; data?: string }>

const CAMERA: Camera = { position: [120, -90, 60], target: [0, 0, 6], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-views-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  // A scene file as a hand or a merge may leave it: a view of a layout the model has not, one that hides a part
  // and shows a scan the object has not, and one that is no view.
  mkdirSync(join(root, 'bracket', '.torno'), { recursive: true })
  writeFileSync(
    join(root, 'bracket', '.torno', 'scene.json'),
    JSON.stringify({
      layers: {},
      views: [
        { name: 'Old bed', author: 'user', layout: 'bed', camera: CAMERA, hidden: [], at: '2026-10-09T21:14:03.000Z' },
        { name: 'No clip', author: 'user', layout: 'assembly', camera: CAMERA, hidden: ['post', 'clip'], scans: { S7: { visible: true } }, at: '2026-10-09T21:15:03.000Z' },
        { name: 'broken', layout: 'assembly' }
      ]
    })
  )
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await page.emulateMedia({ colorScheme: 'light' })
  await open('hollow')
})

test.afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const camera = (): Promise<Camera> => page.evaluate(() => window.__tornoTest!.camera())
const sceneFile = (id: string): { views?: Array<Record<string, unknown>>; layers: Record<string, { visible?: boolean }>; explode?: unknown; section?: unknown; layout?: string } => JSON.parse(readFileSync(join(root, id, '.torno', 'scene.json'), 'utf8'))
const chip = (name: string) => page.locator(`.view-chip[data-view="${name}"]`)
const field = () => page.getByRole('textbox', { name: 'Name of the view' })
const edits = async (): Promise<number> => (await state()).edits
const slider = () => page.getByRole('slider', { name: 'Explode' })
/** The button that switches a part on and off: pressed while the part is shown. */
const layerButton = (part: string) => page.locator(`.layer-row[data-layer="${part}"]`).getByRole('button', { name: `Show ${part}` })
/** Draws the parts of the layout shown so far apart, in per cent, by the slider of the explode bar. */
async function explodeTo(percent: number): Promise<void> {
  // The bar is there while the parts are apart; together, its button opens it.
  if (!(await slider().isVisible())) await page.getByRole('toolbar', { name: 'View' }).getByRole('button', { name: /^Explode/ }).click()
  await slider().fill(String(percent))
  await expect.poll(async () => (await state()).explode.assembly?.amount ?? 0).toBe(percent / 100)
}

async function open(id: string): Promise<void> {
  await page.getByRole('button', { name: id, exact: true }).click()
  await expect.poll(async () => ((await state()).objectId === id ? (await state()).build?.status : null), { timeout: 30_000 }).toBe('ok')
  await expect.poll(async () => (await state()).scene !== null).toBe(true)
}

async function clientFor(id: string): Promise<Client> {
  const url = await app.evaluate((_electron, object) => (globalThis as unknown as { __tornoMain: { mcpUrlFor(id: string): string } }).__tornoMain.mcpUrlFor(object), id)
  const client = new Client({ name: 'torno-e2e', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; content: Content; text: string }> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Content
  return { isError: result.isError === true, content, text: content.find((block) => block.type === 'text')?.text ?? '' }
}
const caption = (result: { text: string }): string => result.text.split('\n')[0]

/** Where the camera is once it has come to rest. */
async function rested(): Promise<Camera> {
  let last = await camera()
  await expect
    .poll(async () => {
      const before = last
      await page.waitForTimeout(80)
      last = await camera()
      return Math.hypot(...last.position.map((c, i) => c - before.position[i]))
    })
    .toBe(0)
  // The window is told 150 ms after the camera stops (`onCameraSettled`).
  await page.waitForTimeout(250)
  return last
}

test('a view is saved under a name, survives a restart of the window\'s state, and is applied with a click', async () => {
  // With nothing saved the strip is the way to save one.
  await expect(page.getByRole('toolbar', { name: 'Saved views' })).toBeVisible()
  await expect(page.locator('.view-chip[data-view]')).toHaveCount(0)

  await explodeTo(40)
  await page.keyboard.press('3')
  const saved = await rested()
  await page.getByRole('button', { name: 'Save view' }).click()
  await expect(field()).toBeFocused()
  await field().fill('Apart')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(chip('Apart')).toBeVisible()
  await expect(field()).toHaveCount(0)
  // It is the one that is on.
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => existsSync(join(root, 'hollow', '.torno', 'scene.json')) && sceneFile('hollow').views?.[0]?.name).toBe('Apart')
  expect(sceneFile('hollow').views![0]).toMatchObject({ name: 'Apart', author: 'user', layout: 'assembly', hidden: [], explode: { amount: 0.4, scale: 1, axis: 'centre' } })
  expect(sceneFile('hollow').views![0].proposed).toBeUndefined()

  // Looked at another way, it is no longer on.
  await explodeTo(0)
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('1')
  await rested()
  await open('plain')
  await expect(page.locator('.view-chip[data-view]')).toHaveCount(0)
  await open('hollow')
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'false')
  await chip('Apart').click()
  await expect.poll(async () => (await state()).explode.assembly?.amount).toBe(0.4)
  const back = await rested()
  for (let i = 0; i < 3; i++) expect(back.position[i]).toBeCloseTo(saved.position[i], 3)
  expect(back.ortho).toBe(saved.ortho)
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'true')
  // Turned by hand, the view is no longer the one that is on; nothing of it is lost.
  await page.keyboard.press('1')
  await rested()
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'false')

  // A standard view's name is refused where it is typed.
  await page.getByRole('button', { name: 'Save view' }).click()
  await field().fill('top')
  await page.keyboard.press('Enter')
  await expect(page.getByText('"top" is a standard view: choose another name')).toBeVisible()
  // The name of a view there is: it would take its place, and the button says so.
  await field().fill('apart')
  await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(field()).toHaveCount(0)
  expect((await state()).views.map((view) => view.name)).toEqual(['Apart'])
})

test('a chip is a button for the keyboard, and its actions rename it, update it and delete it only when asked twice', async () => {
  await chip('Apart').focus()
  await page.keyboard.press('Enter')
  await expect(chip('Apart')).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Actions for Apart' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(field()).toHaveValue('Apart')
  await field().fill('Lid off 40')
  await page.keyboard.press('Enter')
  await expect(chip('Lid off 40')).toBeVisible()
  await expect(chip('Apart')).toHaveCount(0)
  // As written, and its number in the face of numbers.
  await expect(chip('Lid off 40').locator('.view-name')).toHaveText('Lid off 40')
  await expect(chip('Lid off 40').locator('.num')).toHaveText('40')
  await expect.poll(() => sceneFile('hollow').views?.[0]?.name).toBe('Lid off 40')

  // Updated to what is on screen: the lid switched off, the parts together.
  await explodeTo(0)
  await layerButton('lid').click()
  await expect.poll(async () => (await state()).layers.lid?.visible).toBe(false)
  await page.getByRole('button', { name: 'Actions for Lid off 40' }).click()
  await page.getByRole('menuitem', { name: 'Update to what is on screen' }).click()
  await expect.poll(() => sceneFile('hollow').views?.[0]?.hidden).toEqual(['lid'])
  expect(sceneFile('hollow').views![0].explode).toBeUndefined()
  await expect(chip('Lid off 40')).toHaveAttribute('title', 'layout assembly · 1 part hidden')

  // Deleting asks; Cancel leaves it.
  await page.getByRole('button', { name: 'Actions for Lid off 40' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Delete "Lid off 40"?')
  expect((await state()).views).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(chip('Lid off 40')).toBeVisible()
  await page.getByRole('button', { name: 'Actions for Lid off 40' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect(chip('Lid off 40')).toHaveCount(0)
  await expect.poll(() => sceneFile('hollow').views).toBeUndefined()

  // Left for the tests that follow: the lid back on, the parts apart, and that kept as "Apart".
  await layerButton('lid').click()
  await expect.poll(async () => (await state()).layers.lid?.visible).not.toBe(false)
  await explodeTo(40)
  await page.getByRole('button', { name: 'Save view' }).click()
  await field().fill('Apart')
  await page.keyboard.press('Enter')
  await expect(chip('Apart')).toBeVisible()
})

test('the agent lists the views, draws one by name, and proposes one the person keeps', async () => {
  const hollow = await clientFor('hollow')
  expect((await hollow.listTools()).tools.map((tool) => tool.name)).toContain('save_view')
  await expect.poll(async () => JSON.parse((await call(hollow, 'scene')).text).views).toEqual([{ name: 'Apart', by: 'user', layout: 'assembly', exploded: true }])

  // The picture is of the view, whatever is on screen: the parts together there, and seen from elsewhere.
  await explodeTo(0)
  await page.keyboard.press('1')
  const before = await rested()
  const look = await call(hollow, 'look', { view: 'apart' })
  expect(look.isError).toBe(false)
  expect(caption(look)).toMatch(/^view "Apart" · layout assembly · parts tub, lid · exploded 40 % from the centre \(the parts are drawn apart for display: every position, ref and number told is of the parts as assembled\) · /)
  expect((await camera()).position).toEqual(before.position)
  expect((await state()).explode.assembly?.amount).toBe(0)
  if (pictures) {
    mkdirSync(pictures, { recursive: true })
    writeFileSync(join(pictures, 'view-apart.png'), Buffer.from(look.content.find((block) => block.type === 'image')!.data!, 'base64'))
    writeFileSync(join(pictures, 'view-captions.txt'), `${look.text}\n`)
  }
  expect((await call(hollow, 'look', { view: 'a part' })).text).toBe('no view "a part": the saved views are "Apart"; or current, iso, front, back, left, right, top, bottom, or a camera')

  const changes = await edits()
  const proposed = await call(hollow, 'save_view', { name: 'Tub alone', view: 'front', parts: ['tub'], note: 'the wall' })
  expect(proposed.isError).toBe(false)
  expect(proposed.text).toMatch(/^saved "Tub alone" as a view you propose: layout assembly, parts tub, orthographic\. The user sees it in their views, marked proposed, until they keep or discard it\.\nrevision r\d+$/)
  if (pictures) writeFileSync(join(pictures, 'view-captions.txt'), `${look.text}\n\n${proposed.text}\n\n${(await call(hollow, 'scene')).text}\n`)
  await expect(chip('Tub alone')).toContainText('proposed')
  await expect(page.locator('.view-item[data-proposed]')).toHaveCount(1)
  // At once in what scene lists, and on the disk.
  expect(JSON.parse((await call(hollow, 'scene')).text).views[1]).toEqual({ name: 'Tub alone', by: 'agent', proposed: true, layout: 'assembly', hidden: 1, note: 'the wall' })
  await expect.poll(() => sceneFile('hollow').views?.[1]).toMatchObject({ name: 'Tub alone', author: 'agent', proposed: true, hidden: ['lid'], note: 'the wall' })
  // Whose a view is cannot be said by the agent, nor may it take the name of one of the person's.
  expect((await call(hollow, 'save_view', { name: 'Mine now', author: 'user' })).text).toContain('save_view takes no "author"')
  expect((await call(hollow, 'save_view', { name: 'APART' })).text).toBe('the user has a view named "Apart": choose another name (their views: "Apart")')
  expect((await call(hollow, 'save_view', { name: 'Both', section: { axis: 'z', at: 3 }, explode: 0.5 })).text).toMatch(/^a view holds a section or an explode, not both/)
  // Its own proposal it may replace.
  expect((await call(hollow, 'save_view', { name: 'tub alone', view: 'front', parts: ['tub'], note: 'the wall' })).text).toContain('in place of your earlier proposal of that name')
  expect((await state()).views.map((view) => view.name)).toEqual(['Apart', 'tub alone'])

  // Proposing changed nothing on screen.
  expect((await state()).layers.lid?.visible).not.toBe(false)
  expect((await state()).shownByAgent).toBeNull()

  await page.getByRole('button', { name: 'Keep tub alone' }).click()
  await expect(chip('tub alone')).not.toContainText('proposed')
  await expect(page.getByRole('button', { name: 'Actions for tub alone' })).toBeVisible()
  await expect.poll(() => sceneFile('hollow').views?.[1]?.proposed).toBeUndefined()
  expect(sceneFile('hollow').views![1].author).toBe('agent')
  // Kept, it is the person's: the agent cannot take its place.
  await expect.poll(async () => (await call(hollow, 'save_view', { name: 'Tub alone' })).text).toBe('the user kept the view "tub alone": choose another name (their views: "Apart", "tub alone")')

  // Showing it puts it on screen, for now: the file goes on saying what the person had.
  const shown = await call(hollow, 'show', { view: 'Tub alone' })
  expect(caption(shown)).toMatch(/^view "tub alone" · layout assembly · parts tub · orthographic$/)
  expect((await state()).layers.lid?.visible).toBe(false)
  expect((await state()).shownByAgent).not.toBeNull()
  expect(sceneFile('hollow').layers.lid?.visible).not.toBe(false)
  // Proposing, keeping and showing were no edit of how the person looks at the object but the two that changed the views.
  expect(await edits()).toBe(changes + 3)
  // The person clicks their own view: the screen is theirs again.
  await chip('Apart').click()
  await expect.poll(async () => (await state()).shownByAgent).toBeNull()
  expect((await state()).layers.lid?.visible).not.toBe(false)
  await expect.poll(async () => (await state()).explode.assembly?.amount).toBe(0.4)
})

test('a view that no longer fits the model stays, says so, and is applied without what is gone', async () => {
  await open('bracket')
  // The broken one is lost alone.
  await expect(page.locator('.view-chip[data-view]')).toHaveCount(2)
  await expect(chip('Old bed')).toHaveAttribute('aria-disabled', 'true')
  await expect(chip('Old bed')).toHaveAttribute('title', 'Layout bed is no longer in the model')
  await expect(chip('Old bed')).toContainText('layout gone')
  await expect(chip('No clip')).toContainText('1 part and 1 scan gone')
  await expect(chip('No clip')).toHaveAttribute('title', 'layout assembly · 2 parts hidden · clip, S7 are no longer there: passed over')

  const before = await state()
  // Pressed all the same (Playwright waits for a button that is not disabled): nothing comes of it.
  await chip('Old bed').click({ force: true })
  expect((await state()).edits).toBe(before.edits)
  await chip('No clip').click()
  await expect.poll(async () => (await state()).layers.post?.visible).toBe(false)
  expect(Object.keys((await state()).layers)).toEqual(['post'])
  expect((await state()).scanViews).toEqual({})
  await expect(chip('No clip')).toHaveAttribute('aria-pressed', 'true')
  // No build was started for it, and the marks are as they were.
  expect((await state()).revision).toBe(before.revision)
  expect((await state()).marks).toEqual(before.marks)

  const bracket = await clientFor('bracket')
  await page.keyboard.press('1')
  await rested()
  const look = await call(bracket, 'look', { view: 'no CLIP' })
  expect(caption(look)).toMatch(/^view "No clip" · layout assembly · parts base · .* · passed over, of the view "No clip": the part clip, which layout assembly no longer has; the scan S7, which is gone$/)
  expect((await call(bracket, 'look', { view: 'Old bed' })).text).toBe('the view "Old bed" is of layout bed, which the model no longer has (layouts: assembly, print)')
  expect((await call(bracket, 'show', { view: 'Old bed' })).text).toBe('the view "Old bed" is of layout bed, which the model no longer has (layouts: assembly, print)')
  expect(JSON.parse((await call(bracket, 'scene')).text).views).toEqual([
    { name: 'Old bed', by: 'user', layout: 'bed' },
    { name: 'No clip', by: 'user', layout: 'assembly', hidden: 2 }
  ])
  // The state file names them, with what is gone.
  await expect.poll(() => (existsSync(join(root, 'bracket', '.torno', 'state.md')) ? readFileSync(join(root, 'bracket', '.torno', 'state.md'), 'utf8') : ''), { timeout: 10_000 }).toContain('Saved views: "Old bed" (of layout bed, which the model no longer has), "No clip" (hides clip, which layout assembly no longer has).')
})

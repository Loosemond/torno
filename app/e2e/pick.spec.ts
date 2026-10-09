import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { Hit } from '../src/renderer/viewport/picking'
import type { Camera } from '../src/shared/view'

// Pointing at the parts: what is under the pointer, selecting it, what the
// kernel says of it, and putting its ref in the agent's prompt.
//
// The window is hidden. Picks are aimed through window.__tornoTest.project and
// read through .pickAt and .state; the few real pointer events are sent with
// page.mouse, which works on a hidden window. The agent is the stand-in.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
const STALE = 'Rebuilding: picks wait for the new build'

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

function copyFixtures(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-pick-'))
  cpSync(fixtures, dir, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  return dir
}

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
function launch(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, ...env } })
}

test.beforeAll(async () => {
  root = copyFixtures()
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

type Vec3 = [number, number, number]
const state = (p: Page = page): Promise<TornoState> => p.evaluate(() => window.__tornoTest!.state())
const camera = (p: Page = page): Promise<Camera> => p.evaluate(() => window.__tornoTest!.camera())
const termText = (p: Page = page): Promise<string> => p.evaluate(() => window.__tornoTerm!.text())
const readout = (p: Page = page) => p.locator('.pick-readout')
const chips = (p: Page = page) => p.locator('.selection-chip')

/** What is picked where a point of the object frame is drawn. */
function pickOver(point: Vec3, opts?: { edges?: boolean }, p: Page = page): Promise<Hit | null> {
  return p.evaluate(([at, o]) => {
    const [fx, fy] = window.__tornoTest!.project(at)
    return window.__tornoTest!.pickAt(fx, fy, o)
  }, [point, opts] as const)
}

/** Where a point of the object frame is drawn, in the page's pixels. */
async function pageXY(point: Vec3, p: Page = page): Promise<[number, number]> {
  const [fx, fy] = await p.evaluate((at) => window.__tornoTest!.project(at), point)
  const box = (await p.locator('.viewport-canvas canvas').first().boundingBox())!
  return [box.x + fx * box.width, box.y + fy * box.height]
}

async function clickOver(point: Vec3, opts: { shift?: boolean } = {}, p: Page = page): Promise<void> {
  const [x, y] = await pageXY(point, p)
  await p.mouse.move(x, y)
  if (opts.shift) await p.keyboard.down('Shift')
  await p.mouse.down()
  await p.mouse.up()
  if (opts.shift) await p.keyboard.up('Shift')
}

/** Open the bracket and look at it from above. Its base is 40 × 30 × 5 about the origin; its post stands on the middle, to z = 22.5. */
async function openFromAbove(p: Page = page): Promise<void> {
  await p.getByRole('button', { name: 'bracket', exact: true }).click()
  await expect.poll(async () => (await state(p)).build?.status, { timeout: 20_000 }).toBe('ok')
  await p.getByRole('button', { name: 'Top', exact: true }).click()
  await expect
    .poll(async () => {
      const c = await camera(p)
      return Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1]) < 0.01 * Math.abs(c.position[2] - c.target[2])
    })
    .toBe(true)
}

const ON_BASE: Vec3 = [14, 9, 2.5] // on the top of the base, clear of the post
const ON_POST: Vec3 = [0, 0, 22.5] // the middle of the top of the post, and above the middle of the base
const model = () => join(root, 'bracket', 'bracket.py')

test('the palette shows the five tools; only select can be chosen yet', async () => {
  await openFromAbove()
  const tools = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button')
  await expect(tools).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('title', 'Select (V)')
  for (const name of ['Pin', 'Arrow', 'Draw', 'Shape']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  // Their keys do nothing until they can be chosen.
  await page.keyboard.press('p')
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('a pick names the face under the point, in the object frame', async () => {
  const base = (await pickOver(ON_BASE))!
  expect(base).toMatchObject({ partKey: 'assembly:base', part: 'base', kind: 'face' })
  expect(base.ref).toMatch(/^base\/F\d+$/)
  expect(base.ref).toBe(`base/F${base.index}`)
  for (const [i, c] of [0, 0, 1].entries()) expect(base.normal![i]).toBeCloseTo(c, 5)
  for (const [i, c] of ON_BASE.entries()) expect(base.point[i]).toBeCloseTo(c, 2)

  // Above the middle of the base stands the post: its top is what is hit there.
  const post = (await pickOver(ON_POST))!
  expect(post).toMatchObject({ part: 'post', kind: 'face' })
  expect(post.normal![2]).toBeCloseTo(1, 5)
  expect(post.point[2]).toBeCloseTo(22.5, 2)

  // The face is the one the kernel means by that ref.
  const said = await page.evaluate((ref) => window.torno.geometry.describe('bracket', 'assembly', ref), base.ref)
  expect(said).toMatchObject({ kind: 'face', ref: `assembly:${base.ref}`, type: 'plane' })
  expect(said.descriptor).toBe('plane, normal +Z, z = 2.5, 1200 mm²')
})

test('an edge within reach wins over the face under it, unless only faces are asked for', async () => {
  // The long edge of the top of the base at x = 20; 0.3 mm inside it is a few pixels at most.
  const edge = (await pickOver([19.7, 9, 2.5]))!
  expect(edge).toMatchObject({ part: 'base', kind: 'edge', normal: null })
  expect(edge.ref).toBe(`base/E${edge.index}`)
  expect(edge.point[0]).toBeCloseTo(20, 2)
  expect(edge.point[2]).toBeCloseTo(2.5, 2)
  const said = await page.evaluate((ref) => window.torno.geometry.describe('bracket', 'assembly', ref), edge.ref)
  expect(said).toMatchObject({ kind: 'edge', type: 'line', length: 30 })
  expect(said.descriptor).toBe('line, 30 mm')

  expect(await pickOver([19.7, 9, 2.5], { edges: false })).toMatchObject({ part: 'base', kind: 'face' })
  // Nothing beside the parts.
  expect(await page.evaluate(() => window.__tornoTest!.pickAt(0.01, 0.01))).toBeNull()
})

test('a hidden part is never picked; a see-through one is picked like any other', async () => {
  await page.getByRole('button', { name: 'Show post' }).click()
  await expect.poll(async () => (await state()).layers.post?.visible).toBe(false)
  const through = (await pickOver(ON_POST))!
  expect(through).toMatchObject({ part: 'base', kind: 'face' })
  expect(through.point[2]).toBeCloseTo(2.5, 2)
  // Nowhere on the canvas: not its faces, not its edges.
  const parts = await page.evaluate(() => {
    const found = new Set<string>()
    for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) found.add(window.__tornoTest!.pickAt(i / 24, j / 24)?.part ?? 'nothing')
    return [...found].sort()
  })
  expect(parts).toEqual(['base', 'nothing'])

  await page.getByRole('button', { name: 'Show post' }).click()
  await page.getByLabel('Opacity of post').fill('0.2')
  await expect.poll(async () => (await state()).layers.post).toMatchObject({ visible: true, opacity: 0.2 })
  expect(await pickOver(ON_POST)).toMatchObject({ part: 'post', kind: 'face' })
  await page.getByLabel('Opacity of post').fill('1')
})

test('the pointer is told what it is on, and a click selects it', async () => {
  const hit = (await pickOver(ON_BASE))!
  const [x, y] = await pageXY(ON_BASE)
  await page.mouse.move(x, y)
  await expect(readout()).toBeVisible()
  await expect(readout().locator('.pick-readout-ref')).toHaveText(hit.ref)
  // Once the pointer has rested, the kernel's line.
  await expect(readout().locator('.pick-readout-detail')).toHaveText('plane, normal +Z, z = 2.5, 1200 mm²')
  expect((await state()).selection).toEqual([])

  await page.mouse.down()
  await page.mouse.up()
  await expect.poll(async () => (await state()).selection).toEqual([hit.ref])
  await expect(chips()).toHaveCount(1)
  await expect(chips().locator('.selection-ref')).toHaveText(hit.ref)
  await expect(chips().locator('.selection-descriptor')).toContainText('plane')
  await expect(chips().locator('.selection-descriptor')).toHaveText('plane, normal +Z, z = 2.5, 1200 mm²')
})

test('Shift adds to the selection, and takes out; Escape and a click on nothing clear it', async () => {
  const base = (await pickOver(ON_BASE))!
  const post = (await pickOver(ON_POST))!
  await clickOver(ON_POST, { shift: true })
  await expect.poll(async () => (await state()).selection).toEqual([base.ref, post.ref])
  await expect(chips().locator('.selection-ref')).toHaveText([base.ref, post.ref])
  await expect(chips().nth(1).locator('.selection-descriptor')).toContainText('plane, normal +Z, z = 22.5')
  await clickOver(ON_POST, { shift: true })
  await expect.poll(async () => (await state()).selection).toEqual([base.ref])

  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state()).selection).toEqual([])
  await expect(page.locator('.selection')).toHaveCount(0)

  await clickOver(ON_POST)
  await expect.poll(async () => (await state()).selection).toEqual([post.ref])
  // Off the parts, in a corner of the canvas.
  const box = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width - 12, box.y + box.height - 60)
  await expect(readout()).toBeHidden()
  await page.mouse.down()
  await page.mouse.up()
  await expect.poll(async () => (await state()).selection).toEqual([])
})

test('a drag turns the camera and selects nothing', async () => {
  const before = await camera()
  const [x, y] = await pageXY(ON_BASE)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 40, y + 10)
  await page.mouse.up()
  await expect.poll(async () => (await camera()).position).not.toEqual(before.position)
  expect((await state()).selection).toEqual([])
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await expect.poll(async () => Math.abs((await camera()).position[0]) + Math.abs((await camera()).position[1])).toBeLessThan(0.05)
})

test('Insert puts the selected refs in the prompt of the running session, and does not send them', async () => {
  const base = (await pickOver(ON_BASE))!
  const post = (await pickOver(ON_POST))!
  await clickOver(ON_BASE)
  await clickOver(ON_POST, { shift: true })
  await expect.poll(async () => (await state()).selection).toEqual([base.ref, post.ref])

  // No session yet: nowhere to put them.
  const insert = page.getByRole('button', { name: 'Insert', exact: true })
  await expect(insert).toBeDisabled()
  await expect(insert).toHaveAttribute('title', 'Start a session to put the selection in its prompt')

  await page.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
  await expect.poll(termText).toContain('READY')
  await expect(insert).toBeEnabled()
  await insert.click()
  const pasted = `${base.ref} ${post.ref}`
  await expect.poll(termText).toContain(pasted)
  // Nothing was sent: the agent echoes a line only when it gets one.
  expect(await termText()).not.toContain('> ')
  // What is typed next goes after them, and Enter sends the lot as one paste.
  await page.keyboard.type(' is too thin')
  await page.keyboard.press('Enter')
  await expect.poll(termText).toContain(`> \\e[200~${pasted}\\e[201~ is too thin`)
  // The selection is still there to be used again.
  expect((await state()).selection).toEqual([base.ref, post.ref])
})

test('on a stale build nothing is picked, and the pointer is told why; the new build empties the selection', async () => {
  const before = await state()
  expect(before.selection).toHaveLength(2)
  const source = readFileSync(model(), 'utf8')
  appendFileSync(model(), '\nthis is not python(\n')
  await expect.poll(async () => (await state()).build, { timeout: 20_000 }).toMatchObject({ status: 'failed', stale: true, revision: before.revision })

  const [x, y] = await pageXY([-14, -9, 2.5])
  await page.mouse.move(x, y)
  await expect(readout()).toHaveText(STALE)
  await page.mouse.down()
  await page.mouse.up()
  // Off the parts there is nothing to refuse, and a click there clears nothing either.
  const box = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width - 12, box.y + box.height - 60)
  await expect(readout()).toBeHidden()
  await page.mouse.down()
  await page.mouse.up()
  expect((await state()).selection).toEqual(before.selection)

  writeFileSync(model(), source)
  await expect.poll(async () => (await state()).build, { timeout: 20_000 }).toMatchObject({ status: 'ok', stale: false, revision: before.revision + 1 })
  expect((await state()).selection).toEqual([])
  await expect(page.locator('.selection')).toHaveCount(0)

  // And picking works again, on the new build.
  await clickOver(ON_BASE)
  await expect.poll(async () => (await state()).selection).toHaveLength(1)
  await expect(readout()).not.toHaveText(STALE)
})

test('the selection is of the layout shown: another layout empties it', async () => {
  expect((await state()).selection).toHaveLength(1)
  await page.getByRole('button', { name: 'print', exact: true }).click()
  await expect.poll(async () => (await state()).layout).toBe('print')
  expect((await state()).selection).toEqual([])
})

// Set TORNO_SHOTS=<dir> to write pick-light.png and pick-dark.png there: the
// window with a face selected and an edge beside it. Each picture needs its own
// launch: on a hidden window capturePage() delivers one image and hangs on the
// next call, and page.screenshot() never returns.
for (const scheme of ['light', 'dark'] as const) {
  test(`screenshot of a selection, ${scheme}`, async () => {
    const dir = process.env.TORNO_SHOTS
    test.skip(!dir, 'TORNO_SHOTS is not set')
    test.setTimeout(120_000)
    mkdirSync(dir!, { recursive: true })
    const shotRoot = copyFixtures()
    const shotApp = await launch({ TORNO_WORKSPACE: shotRoot })
    try {
      const shotPage = await shotApp.firstWindow()
      await shotPage.emulateMedia({ colorScheme: scheme })
      await shotPage.getByRole('button', { name: 'bracket', exact: true }).click()
      await expect.poll(async () => (await state(shotPage)).build?.status, { timeout: 90_000 }).toBe('ok')
      await shotPage.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
      await expect.poll(() => termText(shotPage)).toContain('READY')
      await clickOver(ON_BASE, {}, shotPage)
      await clickOver([20, 0, 2.5], { shift: true }, shotPage)
      await expect(chips(shotPage)).toHaveCount(2)
      await expect(chips(shotPage).nth(1).locator('.selection-descriptor')).not.toBeEmpty()
      // Rest on the post, so the hover and its readout are in the picture.
      const [x, y] = await pageXY([0, -4, 14], shotPage)
      await shotPage.mouse.move(x, y)
      await expect(readout(shotPage).locator('.pick-readout-detail')).not.toBeEmpty()
      await shotPage.evaluate(async () => {
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      })
      const png = await shotApp.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
        return image.toPNG().toString('base64')
      })
      writeFileSync(join(dir!, `pick-${scheme}.png`), Buffer.from(png, 'base64'))
    } finally {
      await shotApp.close()
      rmSync(shotRoot, { recursive: true, force: true })
    }
  })
}

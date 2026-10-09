import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { ScanLayerState } from '../src/renderer/viewport/scans'
import { apply } from '../src/shared/align'
import { box, grid, moved, stl } from '../src/test/scanFixtures'

// Aligning a scan: by pairs of points, by typed values, by its floor, and what a later build makes of it.
//
// The window is hidden. Nothing here is the owner's scan: every one is made by this file, in a temporary copy
// of the fixtures. Marks of the brief's own tests are kept; what the controller's rulings changed is said where it is.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
function launch(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, ...env } })
}

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-align-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (p: Page = page): Promise<TornoState> => p.evaluate(() => window.__tornoTest!.state())
const scans = (p: Page = page): Promise<ScanLayerState[]> => p.evaluate(() => window.__tornoTest!.scans())
const row = (id: string, p: Page = page) => p.locator(`.scan-row[data-scan="${id}"]`)
const pickFile = (path: string | null) => app.evaluate((_electron, path) => void ((globalThis as unknown as { __tornoMain: { pickFile: string | null } }).__tornoMain.pickFile = path), path)

async function open(name: string, p: Page = page): Promise<void> {
  await p.getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => ((await state(p)).objectId === name ? (await state(p)).build?.status : null), { timeout: 90_000 }).toBe('ok')
  await expect.poll(async () => (await state(p)).scene !== null).toBe(true)
}

type Vec3 = [number, number, number]
// The bracket's base is a box 40 × 30 × 5 round the origin. Its twin, turned 30° and moved: a "scan" of the base.
const TWIN = stl(moved(box([40, 30, 5]), 30, [30, 20, 12]))
const where = (p: Vec3): Vec3 => [Math.cos(Math.PI / 6) * p[0] - Math.sin(Math.PI / 6) * p[1] + 30, Math.sin(Math.PI / 6) * p[0] + Math.cos(Math.PI / 6) * p[1] + 20, p[2] + 12]
// Four points of the base's top, and where each is on the twin. Seen from above the twin covers part of the
// base: the first point, the one that is clicked on the base itself, is clear of it.
const ON_TOP: Vec3[] = [[-15, -10, 2.5], [15, 10, 2.5], [-15, 10, 2.5], [12, -8, 2.5]]
const bar = (p: Page = page) => p.locator('.alignbar')

/** Clicks where a point of the scan's own frame is drawn. */
async function clickScan(local: Vec3): Promise<void> {
  const [fx, fy] = await page.evaluate((local) => window.__tornoTest!.projectScan('S1', local), local)
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.click(canvas.x + fx * canvas.width, canvas.y + fy * canvas.height)
}
async function clickModel(point: Vec3): Promise<void> {
  const [fx, fy] = await page.evaluate((point) => window.__tornoTest!.project(point), point)
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.click(canvas.x + fx * canvas.width, canvas.y + fy * canvas.height)
}
/** Zooms out until every point given is well inside the canvas. */
async function frame(points: Vec3[]): Promise<void> {
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  for (let tries = 0; tries < 12; tries++) {
    const drawn = await page.evaluate((points) => points.map((p) => window.__tornoTest!.project(p)), points)
    if (drawn.every(([x, y]) => x > 0.08 && x < 0.92 && y > 0.08 && y < 0.92)) return
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(150)
  }
  throw new Error('the points never came into view')
}
const alignment = async (layout: string) => (await state()).scans[0].alignments[layout]

test('three pairs and a fourth bring a displaced scan onto the model, and say how well', async () => {
  await open('bracket')
  const file = join(root, 'twin.stl')
  writeFileSync(file, TWIN)
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  // From above, so that the tops of both are what is clicked.
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await frame([...ON_TOP, ...ON_TOP.map(where)])
  await page.keyboard.press('l')
  await expect(bar()).toBeVisible()
  await bar().getByRole('button', { name: 'Pairs' }).click()
  for (const [n, point] of ON_TOP.entries()) {
    await clickScan(where(point))
    if (n === 0) await clickModel(point)   // the first model end is clicked on the part
    else {
      for (const [axis, value] of (['x', 'y', 'z'] as const).map((axis, i) => [axis, point[i]] as const)) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
      await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
    }
  }
  await expect(bar()).toContainText(/rms 0(\.\d+)? mm/)
  // Nothing is kept until it is applied; the scan is already drawn where the fit puts it.
  expect(await alignment('assembly')).toBeUndefined()
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1').locator('.chip[data-state="aligned"]')).toHaveText('aligned')
  const kept = await alignment('assembly')
  expect(kept).toMatchObject({ steps: ['pairs'], frame: { base: [0, 0, 0], post: [0, 0, 0] }, pairs: [{ part: 'base' }, {}, {}, {}] })
  expect(kept.rms!).toBeLessThan(0.5)
  // Where the scan's own points now are: on the base, within what a click can be off by.
  for (const point of ON_TOP) {
    const now = apply(kept.transform, where(point))
    expect(Math.hypot(now[0] - point[0], now[1] - point[1], now[2] - point[2])).toBeLessThan(0.6)
  }
  expect(JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scans.json'), 'utf8')).scans[0].alignments.assembly.steps).toEqual(['pairs'])
  // In the other layout it is not aligned.
  await page.getByRole('button', { name: 'print', exact: true }).click()
  await expect(row('S1').locator('.chip[data-state="unaligned"]')).toHaveText('not aligned here')
  expect((await scans())[0].aligned).toBe(false)
})

test('typed values move it, and clearing leaves it where it was imported', async () => {
  await page.getByRole('button', { name: 'assembly', exact: true }).click()
  await bar().getByRole('button', { name: 'Nudge' }).click()
  const before = (await alignment('assembly')).transform.t
  await bar().getByRole('textbox', { name: 'Z', exact: true }).fill(String(before[2] + 4))
  await bar().getByRole('textbox', { name: 'Z', exact: true }).press('Enter')
  await expect.poll(async () => (await alignment('assembly')).steps).toEqual(['pairs', 'typed'])
  expect((await alignment('assembly')).transform.t[2]).toBeCloseTo(before[2] + 4, 6)
  // Its pairs are kept, and main says how far off they now are: 4 mm each.
  expect((await alignment('assembly')).pairs!.every((p) => Math.abs(p.residual - 4) < 0.6)).toBe(true)
  await bar().getByRole('button', { name: 'Clear' }).click()
  await page.getByRole('button', { name: 'Clear', exact: true }).last().click()
  await expect.poll(async () => (await state()).scans[0].alignments).toEqual({})
  expect((await scans())[0].transform).toEqual({ t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 })
})

test('a tilted floor is laid flat on the ground, and says that is all it is', async () => {
  await open('hollow')
  const file = join(root, 'tilted.stl')
  // A sheet 29 mm square that rises a millimetre in ten along X, 60 mm up.
  writeFileSync(file, stl(grid(30, 1, (x) => 60 + 0.1 * x)))
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await frame([[0, 0, 60], [14, 14, 61.4], [-14, -14, 58.6]])
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Floor' }).click()
  await clickScan([0.5, 0.5, 60.05])
  await expect(bar()).toContainText(/plane rms 0(\.\d+)? mm over \d+ triangles/)
  await bar().getByRole('button', { name: 'Apply' }).click()
  // Changed from the brief (the controller's ruling R-honest): a floor alone is a rough alignment, kept only once the person says so.
  await expect(bar().getByRole('alertdialog', { name: 'Keep a rough alignment?' })).toContainText('A floor alone says how the scan stands, not where it is on that floor. Keep it as a rough alignment?')
  expect(await alignment('assembly')).toBeUndefined()
  await bar().getByRole('button', { name: 'Keep as rough' }).click()
  await expect.poll(async () => (await alignment('assembly'))?.steps).toEqual(['floor'])
  const kept = await alignment('assembly')
  expect(kept.rough).toBe('a floor alone says how the scan stands, not where it is on that floor')
  await expect(row('S1').locator('.chip[data-state="rough"]')).toHaveText('rough alignment')
  for (const local of [[0.5, 0.5, 60.05], [14.5, -14.5, 61.45], [-14.5, 14.5, 58.55]] as Vec3[]) expect(Math.abs(apply(kept.transform, local)[2])).toBeLessThan(1e-3)
  await expect(bar()).toContainText('by floor only')
})

test('an alignment says so when a build moves the model from under it', async () => {
  await open('spread')
  const file = join(root, 'lid twin.stl')
  // The lid of the spread fixture is 20 × 20 × 2; where torno puts it is read from the scene.
  const lid = (await state()).scene!.parts.find((p) => p.name === 'lid')!
  const centre: Vec3 = [(lid.bbox.min[0] + lid.bbox.max[0]) / 2, 0, 1]
  writeFileSync(file, stl(moved(box([20, 20, 2]), 0, [centre[0], 40, 1])))
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  const top: Vec3[] = [[6, 6, 2], [-6, 6, 2], [-6, -6, 2]]
  const onLid = top.map(([x, y, z]) => [centre[0] + x, y, z] as Vec3)
  const onTwin = top.map(([x, y, z]) => [centre[0] + x, 40 + y, z] as Vec3)
  await frame([...onLid, ...onTwin])
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Pairs' }).click()
  // The lid is a part torno moved: a model end on it is refused, and said.
  await clickScan(onTwin[0])
  await clickModel(onLid[0])
  await expect(page.locator('.pick-readout')).toContainText('torno moved lid for display here')
  // So it is tied to the tray, which stays, with typed ends; then the tray is made wider.
  for (const [n, [x, y]] of ([[6, 6], [-6, 6], [-6, -6]] as const).entries()) {
    if (n > 0) await clickScan(onTwin[n])
    for (const [axis, value] of [['x', x], ['y', y], ['z', 4]] as const) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
    await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
  }
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1').locator('.chip[data-state="aligned"]')).toBeVisible()
  await expect.poll(async () => (await state()).scans[0].checks.print).toMatchObject({ of: 0, off: 0, moved: [] })
  writeFileSync(join(root, 'spread', 'width.txt'), '40\n')
  await expect.poll(async () => (await state()).scans[0].checks.print?.moved, { timeout: 60_000 }).toEqual(['lid'])
  await expect(row('S1').locator('.chip[data-state="stale"]')).toHaveText('check alignment')
  await expect(row('S1').locator('.chip[data-state="stale"]')).toHaveAttribute('title', 'torno has moved lid for display since it was aligned: check the alignment')
  // Nothing was re-fitted.
  expect((await alignment('print')).steps).toEqual(['pairs'])
})

// Beyond the brief's tests: the controller's rulings on a wrong unit, on what is rough, and on stepping back.
test('a fit that says the unit is wrong offers the change in one click, keeps no scale unasked, and the last alignment can be undone', async () => {
  await open('bracket')
  // The twin read as centimetres: ten times too large, as a scan in the wrong unit arrives.
  await page.evaluate(() => window.torno.scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' }))
  await expect.poll(async () => (await state()).scans[0].imported.unit).toBe('cm')
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  await page.getByRole('button', { name: 'assembly', exact: true }).click()
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  const big = (p: Vec3): Vec3 => where(p).map((c) => 10 * c) as Vec3
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  for (let tries = 0; ; tries++) {
    const drawn = await page.evaluate((points) => points.map((p) => window.__tornoTest!.project(p)), ON_TOP.map(big))
    if (drawn.every(([x, y]) => x > 0.08 && x < 0.92 && y > 0.08 && y < 0.92)) break
    if (tries === 30) throw new Error('the points never came into view')
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(150)
  }
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Pairs' }).click()
  for (const [n, point] of ON_TOP.slice(0, 3).entries()) {
    await clickScan(big(point))
    for (const [axis, value] of (['x', 'y', 'z'] as const).map((axis, i) => [axis, point[i]] as const)) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
    await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
  }
  await expect(bar().locator('[data-part="size"]')).toContainText('These points fit 10 × smaller: this scan looks like it is in mm, and was imported as cm.')
  // As it is, the fit leaves the pairs far apart: it would be kept only as a rough one, and only on a yes.
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(bar().getByRole('alertdialog', { name: 'Keep a rough alignment?' })).toContainText(/Its pairs of points are left \d+(\.\d+)? mm apart \(rms\): more than 5 mm/)
  await bar().getByRole('button', { name: 'Not yet' }).click()
  expect(await alignment('assembly')).toBeUndefined()
  // One click reads the scan in the unit the fit names; the pairs in hand stand, and now fit.
  await bar().getByRole('button', { name: 'Read it as mm' }).click()
  await expect.poll(async () => (await state()).scans[0].imported.unit).toBe('mm')
  await expect(bar()).toContainText(/rms 0(\.\d+)? mm/)
  await expect(bar().locator('[data-part="size"]')).toHaveCount(0)
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1').locator('.chip[data-state="aligned"]')).toHaveText('aligned')
  const kept = await alignment('assembly')
  expect(kept.transform.s).toBe(1)
  expect(kept).not.toHaveProperty('scaled')
  expect(kept.revision).toBe((await state()).revision)
  for (const point of ON_TOP.slice(0, 3)) {
    const now = apply(kept.transform, where(point))
    expect(Math.hypot(now[0] - point[0], now[1] - point[1], now[2] - point[2])).toBeLessThan(0.6)
  }

  // Moved by typed values, and that undone: the fit of the pairs is back, and there is nothing more to undo.
  await bar().getByRole('button', { name: 'Nudge' }).click()
  await bar().getByRole('textbox', { name: 'Z', exact: true }).fill(String(kept.transform.t[2] + 3))
  await bar().getByRole('textbox', { name: 'Z', exact: true }).press('Enter')
  await expect.poll(async () => (await alignment('assembly')).steps).toEqual(['pairs', 'typed'])
  await bar().getByRole('button', { name: 'Undo typed values' }).click()
  await expect.poll(async () => (await alignment('assembly')).steps).toEqual(['pairs'])
  expect((await alignment('assembly')).transform.t[2]).toBeCloseTo(kept.transform.t[2], 9)
  await expect(bar().getByRole('button', { name: 'Undo' })).toBeDisabled()
})

test('Escape steps back one pick, and only then puts the tool down; two pairs are kept only as a rough alignment, on a yes', async () => {
  await bar().getByRole('button', { name: 'Pairs' }).click()
  await expect(bar().locator('.alignbar-next')).toHaveText('Click a point on the scan')
  // Where the scan is drawn now: on the base.
  await clickScan(where(ON_TOP[0]))
  await expect(bar().locator('.align-pair')).toHaveCount(1)
  await expect(bar().locator('.alignbar-next')).toHaveText('Now the same point on the model, or type it')
  await page.keyboard.press('Escape')
  await expect(bar().locator('.align-pair')).toHaveCount(0)
  await expect(bar()).toBeVisible()

  for (const [n, point] of ON_TOP.slice(0, 2).entries()) {
    await clickScan(where(point))
    for (const [axis, value] of (['x', 'y', 'z'] as const).map((axis, i) => [axis, point[i] + (axis === 'z' ? 1 : 0)] as const)) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
    await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
  }
  await expect(bar().locator('.alignbar-next')).toHaveText('Click another point on the scan: 2 of 3 pairs')
  await expect(bar().getByRole('button', { name: 'Apply' })).toBeDisabled()
  const before = await alignment('assembly')
  await bar().getByRole('button', { name: 'Keep it rough…' }).click()
  await expect(bar().getByRole('alertdialog', { name: 'Keep a rough alignment?' })).toContainText('It has 2 pairs of points: it takes three that are not in a line to fix a scan.')
  // Nothing is kept on the click that asks.
  expect(await alignment('assembly')).toEqual(before)
  await bar().getByRole('button', { name: 'Keep as rough' }).click()
  await expect(row('S1').locator('.chip[data-state="rough"]')).toHaveText('rough alignment')
  await expect(row('S1').locator('.scan-said')).toContainText('it has 2 pairs of points')
  const rough = await alignment('assembly')
  expect(rough.steps).toEqual(['pairs'])
  expect(rough.pairs).toHaveLength(2)
  expect(rough.transform.t[2]).toBeCloseTo(before.transform.t[2] + 1, 3)
  // A picture says so too.
  const caption = await page.evaluate(async () => (await window.__tornoTest!.look({ view: 'iso', size: 128 })).caption)
  expect(caption).toContain('scans S1 (aligned roughly in assembly: it has 2 pairs of points: it takes three that are not in a line to fix a scan)')

  // With nothing in hand, Escape puts the tool down.
  await page.keyboard.press('Escape')
  await expect(bar()).toHaveCount(0)
  expect((await state()).scans[0].alignments.assembly.steps).toEqual(['pairs'])
})

test('by hand, the gizmo is on the scan: a drag of a handle draws it as dragged, and it is kept once, on release', async () => {
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Nudge' }).click()
  const canvas = page.locator('.viewport-canvas canvas').first()
  await expect(canvas).toHaveAttribute('data-gizmo', 'translate')
  const before = await alignment('assembly')
  // The handles are at the middle of the scan's box, where that now stands.
  const pivot = apply(before.transform, [30, 20, 12])
  const box = (await canvas.boundingBox())!
  const at = async (p: Vec3): Promise<[number, number]> => {
    const [fx, fy] = await page.evaluate((p) => window.__tornoTest!.project(p), p)
    return [box.x + fx * box.width, box.y + fy * box.height]
  }
  const [x0, y0] = await at(pivot)
  const [x1, y1] = await at([pivot[0] + 10, pivot[1], pivot[2]])
  const length = Math.hypot(x1 - x0, y1 - y0)
  const [ux, uy] = [(x1 - x0) / length, (y1 - y0) / length]
  // On the arrow along X, some way from its foot.
  await page.mouse.move(x0 + ux * 40, y0 + uy * 40)
  await page.mouse.move(x0 + ux * 45, y0 + uy * 45)
  await expect(canvas).toHaveAttribute('data-gizmo-axis', 'X')
  await page.mouse.down()
  await page.mouse.move(x0 + ux * 55, y0 + uy * 55, { steps: 3 })
  await page.mouse.move(x0 + ux * 45 + ux * (length / 10) * 3, y0 + uy * 45 + uy * (length / 10) * 3, { steps: 3 })
  // Drawn as dragged, 3 mm along X; main has been told nothing yet.
  const dragged = (await scans())[0].transform.t
  expect(dragged[0] - before.transform.t[0]).toBeGreaterThan(2)
  expect(dragged[0] - before.transform.t[0]).toBeLessThan(4)
  expect((await alignment('assembly')).transform.t).toEqual(before.transform.t)
  await page.mouse.up()
  // It was rough already (two pairs): moved by hand, it is kept without being asked about again.
  await expect.poll(async () => (await alignment('assembly')).steps).toEqual(['pairs', 'nudge'])
  const kept = await alignment('assembly')
  expect(kept.transform.t[0]).toBeCloseTo(dragged[0], 6)
  expect(kept.transform.t[1]).toBeCloseTo(before.transform.t[1], 6)
  expect(kept.transform.t[2]).toBeCloseTo(before.transform.t[2], 6)
  expect(kept.pairs).toHaveLength(2)
  // And it stays where it was let go.
  await expect.poll(async () => (await scans())[0].transform.t[0]).toBeCloseTo(kept.transform.t[0], 6)
  // R turns it; T is no key of a scan's.
  await page.keyboard.press('r')
  await expect(canvas).toHaveAttribute('data-gizmo', 'rotate')
  await page.keyboard.press('t')
  await expect(canvas).toHaveAttribute('data-gizmo', 'rotate')
  // The tool put down, the gizmo goes.
  await page.keyboard.press('Escape')
  await expect(bar()).toHaveCount(0)
  await expect(canvas).not.toHaveAttribute('data-gizmo', /.+/)
})

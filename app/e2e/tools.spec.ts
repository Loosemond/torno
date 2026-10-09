import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { Hit } from '../src/renderer/viewport/picking'
import type { ArrowMark, MarksFile, PickMark, PinMark, StrokeMark } from '../src/shared/marks'
import type { Camera } from '../src/shared/view'

// The tools that leave marks with the pointer: pin, arrow, a note on the
// selection, and draw; and the note that opens beside a mark just made.
//
// The window is hidden. The pointer is aimed through window.__tornoTest.project
// and moved with page.mouse, which works on a hidden window; what was made is
// read from the object's marks.json and from .state.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
const FAILED = 'The last build failed: picks wait for a build that works'

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

function copyFixtures(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-tools-'))
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
const marksOnDisk = (): MarksFile => {
  try {
    return JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'marks.json'), 'utf8'))
  } catch {
    return { next: 1, marks: [] }
  }
}
const readout = (p: Page = page) => p.locator('.pick-readout')
const card = (p: Page = page) => p.locator('.note-card')
const field = (p: Page = page) => p.locator('.note-card textarea')
const tool = (name: string, p: Page = page) => p.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true })
const canvas = (p: Page = page) => p.locator('.viewport-canvas canvas').first()
const length = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function pickOver(point: Vec3, p: Page = page): Promise<Hit | null> {
  return p.evaluate((at) => {
    const [fx, fy] = window.__tornoTest!.project(at)
    return window.__tornoTest!.pickAt(fx, fy)
  }, point)
}

/** Where a point of the object frame is drawn, in the page's pixels. */
async function pageXY(point: Vec3, p: Page = page): Promise<[number, number]> {
  const [fx, fy] = await p.evaluate((at) => window.__tornoTest!.project(at), point)
  const box = (await canvas(p).boundingBox())!
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

/** Press where one point is drawn, drag to where another is, and let go unless told to hold. */
async function dragOver(from: Vec3, to: Vec3, opts: { hold?: boolean } = {}, p: Page = page): Promise<void> {
  const [x0, y0] = await pageXY(from, p)
  const [x1, y1] = await pageXY(to, p)
  await p.mouse.move(x0, y0)
  await p.mouse.down()
  await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2)
  await p.mouse.move(x1, y1)
  if (!opts.hold) await p.mouse.up()
}

/** Press where the first point is drawn and draw through the others, one move each; let go unless told to hold. */
async function strokeOver(points: Vec3[], opts: { hold?: boolean } = {}, p: Page = page): Promise<void> {
  const at: [number, number][] = []
  for (const point of points) at.push(await pageXY(point, p))
  await p.mouse.move(...at[0])
  await p.mouse.down()
  for (const [x, y] of at.slice(1)) await p.mouse.move(x, y)
  if (!opts.hold) await p.mouse.up()
}

const lockOf = (view: string, p: Page = page) => p.locator(`.viewbar [data-view="${view}"]`)

/** Open the bracket and look at it from above. Its base is 40 × 30 × 5 about the origin; its post stands on the middle, to z = 22.5. */
async function openFromAbove(p: Page = page): Promise<void> {
  await p.getByRole('button', { name: 'bracket', exact: true }).click()
  await expect.poll(async () => (await state(p)).build?.status, { timeout: 30_000 }).toBe('ok')
  await fromAbove(p)
}

async function fromAbove(p: Page = page): Promise<void> {
  await p.getByRole('button', { name: 'Top', exact: true }).click()
  await expect
    .poll(async () => {
      const c = await camera(p)
      return Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1]) < 0.01 * Math.abs(c.position[2] - c.target[2])
    })
    .toBe(true)
}

/** The box of the note and, in the same pixels, where a point of the object is drawn. */
async function noteAndPoint(point: Vec3): Promise<{ box: { x: number; y: number; width: number; height: number }; at: [number, number] }> {
  return { box: (await card().boundingBox())!, at: await pageXY(point) }
}

const inside = (box: { x: number; y: number; width: number; height: number }, [x, y]: [number, number], pad = 0): boolean =>
  x >= box.x - pad && x <= box.x + box.width + pad && y >= box.y - pad && y <= box.y + box.height + pad

const ON_BASE: Vec3 = [14, 9, 2.5] // on the top of the base, clear of the post
const ON_POST: Vec3 = [0, 0, 22.5] // the middle of the top of the post
const model = () => join(root, 'bracket', 'bracket.py')

test('P takes the pin tool; a click on the part leaves a pin and opens its note beside it', async () => {
  await openFromAbove()
  await expect(tool('Pin')).toBeEnabled()
  await expect(tool('Arrow')).toBeEnabled()
  await page.keyboard.press('p')
  await expect(tool('Pin')).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas()).toHaveCSS('cursor', 'crosshair')

  // Beside the parts: nothing.
  const box = (await canvas().boundingBox())!
  await page.mouse.move(box.x + box.width - 12, box.y + box.height - 60)
  await page.mouse.down()
  await page.mouse.up()

  const hit = (await pickOver(ON_BASE))!
  await clickOver(ON_BASE)
  await expect(card()).toBeVisible()
  await expect(card().locator('.mark-chip')).toHaveText('M1')
  await expect(card().locator('.note-ref')).toHaveText(hit.ref)
  await expect(card().locator('.note-detail')).toHaveText('plane, normal +Z, z = 2.5, 1200 mm²')
  await expect(field()).toBeFocused()
  await expect(field()).toHaveAttribute('placeholder', 'What should change here?')
  await expect(field()).toHaveAttribute('maxlength', '2000')
  expect(marksOnDisk().marks).toHaveLength(1)
  expect((await state()).activeMark).toBe('M1')

  // The note is beside the pin, not on it, and inside the viewport.
  const { box: note, at } = await noteAndPoint(ON_BASE)
  expect(inside(note, at, 6)).toBe(false)
  expect(note.x).toBeGreaterThanOrEqual(box.x)
  expect(note.x + note.width).toBeLessThanOrEqual(box.x + box.width)

  // Typing in it is typing: the keys of the tools and the views do nothing.
  const before = await camera()
  await page.keyboard.type('add a rib here, 1 mm thick, V-shaped')
  await expect(tool('Pin')).toHaveAttribute('aria-pressed', 'true')
  expect(await camera()).toEqual(before)
  await page.keyboard.press('Enter')
  await expect(card()).toHaveCount(0)

  await expect.poll(() => marksOnDisk().marks[0]?.note).toBe('add a rib here, 1 mm thick, V-shaped')
  const s = await state()
  const pin = marksOnDisk().marks[0] as PinMark
  expect(pin).toMatchObject({ id: 'M1', kind: 'pin', author: 'user', status: 'draft', anchorState: 'ok', layout: 'assembly', revision: s.revision })
  expect(pin.anchor).toMatchObject({ part: 'base', ref: hit.ref, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' })
  expect(pin.anchor.ref).toMatch(/^base\/F\d+$/)
  for (const [i, c] of ON_BASE.entries()) expect(pin.anchor.point[i]).toBeCloseTo(c, 1)
  for (const [i, c] of [0, 0, 1].entries()) expect(pin.anchor.normal![i]).toBeCloseTo(c, 5)
  for (const [i, c] of before.position.entries()) expect(pin.camera.position[i]).toBeCloseTo(c, 3)
  await expect(page.locator('.mark-row[data-mark="M1"] .mark-note')).toHaveText('add a rib here, 1 mm thick, V-shaped')
})

test('the tool stays in hand: the next click is the next pin; Escape leaves its note empty', async () => {
  await expect(tool('Pin')).toHaveAttribute('aria-pressed', 'true')
  await clickOver([-14, -9, 2.5])
  await expect(card().locator('.mark-chip')).toHaveText('M2')
  await expect(field()).toBeFocused()
  await page.keyboard.type('not kept')
  await page.keyboard.press('Escape')
  await expect(card()).toHaveCount(0)
  // The mark is kept, with the note it had; the tool is still the pin.
  expect(marksOnDisk().marks.map((m) => [m.id, m.note])).toEqual([['M1', 'add a rib here, 1 mm thick, V-shaped'], ['M2', '']])
  await expect(tool('Pin')).toHaveAttribute('aria-pressed', 'true')
  expect((await state()).activeMark).toBe('M2')
})

test('the note follows its mark when the camera moves, and a press elsewhere keeps what was written', async () => {
  await clickOver(ON_POST)
  await expect(card().locator('.mark-chip')).toHaveText('M3')
  await expect(field()).toBeFocused()
  const first = (await card().boundingBox())!
  await page.keyboard.type('shorter')
  // Shift+Enter is a new line, not the end.
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('by 2 mm')
  await expect(field()).toHaveValue('shorter\nby 2 mm')

  // Zoom in about a corner of the base: the post, and its note, move on screen.
  const before = await camera()
  const [x, y] = await pageXY([-18, -13, 2.5])
  await page.mouse.move(x, y)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await camera()).position).not.toEqual(before.position)
  await expect
    .poll(async () => {
      const now = (await card().boundingBox())!
      return Math.hypot(now.x - first.x, now.y - first.y)
    })
    .toBeGreaterThan(5)
  const { box, at } = await noteAndPoint(ON_POST)
  expect(inside(box, at, 6)).toBe(false)
  await expect(field()).toHaveValue('shorter\nby 2 mm')
  // The view bar is pressed, which is not the note: the note is saved and closed.
  await fromAbove()
  await expect(card()).toHaveCount(0)
  await expect.poll(() => marksOnDisk().marks[2]?.note).toBe('shorter\nby 2 mm')
})

test('the delete button of the note takes the mark away', async () => {
  await clickOver([14, -9, 2.5])
  await expect(card().locator('.mark-chip')).toHaveText('M4')
  await card().getByRole('button', { name: 'Delete mark M4' }).click()
  await expect(card()).toHaveCount(0)
  await expect.poll(() => marksOnDisk().marks.map((m) => m.id)).toEqual(['M1', 'M2', 'M3'])
  await expect(page.locator('.mark-row')).toHaveCount(3)
})

test('A takes the arrow tool; a drag from the part leaves an arrow of the length dragged', async () => {
  await page.keyboard.press('a')
  await expect(tool('Arrow')).toHaveAttribute('aria-pressed', 'true')
  const from: Vec3 = [14, 9, 2.5]
  const to: Vec3 = [-12, -4, 2.5] // seen from above, the plane that faces the camera is the top of the base
  const hit = (await pickOver(from))!
  const view = await camera()
  await dragOver(from, to, { hold: true })
  // While it is dragged: its length and its vector, and the camera stays put.
  const wanted = length(from, to)
  await expect(readout()).toBeVisible()
  const said = (await readout().locator('.pick-readout-ref').textContent())!
  expect(said).toMatch(/^\d+\.\d mm$/)
  expect(Math.abs(Number.parseFloat(said) - wanted) / wanted).toBeLessThan(0.05)
  await expect(readout().locator('.pick-readout-detail')).toHaveText(/^-2\d\.\d, -1\d\.\d, -?0\.\d$/)
  expect(marksOnDisk().marks).toHaveLength(3)
  await page.mouse.up()

  await expect(card().locator('.mark-chip')).toHaveText('M5')
  await expect(readout()).toBeHidden()
  expect(await camera()).toEqual(view)
  const arrow = marksOnDisk().marks.find((m) => m.id === 'M5') as ArrowMark
  expect(arrow).toMatchObject({ kind: 'arrow', author: 'user', layout: 'assembly', from: { part: 'base', ref: hit.ref, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' } })
  for (const [i, c] of from.entries()) expect(arrow.from.point[i]).toBeCloseTo(c, 1)
  expect(Math.abs(length(arrow.from.point, arrow.to) - wanted) / wanted).toBeLessThan(0.05)
  expect(length(arrow.to, to)).toBeLessThan(0.05 * wanted)
  // Its note says how long it is, and Enter with nothing written leaves it at that.
  await expect(card().locator('.note-ref')).toHaveText(`${length(arrow.from.point, arrow.to).toFixed(1)} mm`)
  await expect(field()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(card()).toHaveCount(0)
})

test('with Shift the arrow runs along an axis; a drag of a pixel or two is no arrow', async () => {
  const from: Vec3 = [14, -9, 2.5]
  await page.keyboard.down('Shift')
  await dragOver(from, [-10, -7, 2.5]) // 5° off -X
  await page.keyboard.up('Shift')
  await expect(card().locator('.mark-chip')).toHaveText('M6')
  const arrow = marksOnDisk().marks.find((m) => m.id === 'M6') as ArrowMark
  expect(arrow.to[1]).toBeCloseTo(arrow.from.point[1], 6)
  expect(arrow.to[2]).toBeCloseTo(arrow.from.point[2], 6)
  expect(arrow.to[0]).toBeLessThan(-8)
  await page.keyboard.press('Escape') // the note
  await expect(card()).toHaveCount(0)

  const [x, y] = await pageXY([-14, 9, 2.5])
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 2, y + 1)
  await page.mouse.up()
  await page.mouse.move(x + 30, y)
  await expect(readout()).toBeVisible() // the tool has gone on: it names what is under the pointer again
  expect(marksOnDisk().marks.map((m) => m.id)).toEqual(['M1', 'M2', 'M3', 'M5', 'M6'])
  await expect(card()).toHaveCount(0)
})

test('Escape drops an arrow that is being dragged, then puts the tool down for Select; so does V', async () => {
  await dragOver([14, 9, 2.5], [-12, 9, 2.5], { hold: true })
  await expect(readout()).toBeVisible()
  const view = await camera()
  await page.keyboard.press('Escape')
  await expect(readout()).toBeHidden()
  await expect(tool('Arrow')).toHaveAttribute('aria-pressed', 'true')
  // The rest of the drag is nobody's: it draws nothing and does not turn the camera.
  const [x, y] = await pageXY([-12, -9, 2.5])
  await page.mouse.move(x, y)
  await page.mouse.up()
  expect(await camera()).toEqual(view)
  await expect(readout()).toBeHidden()
  expect(marksOnDisk().marks).toHaveLength(5)

  await page.keyboard.press('Escape')
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas()).toHaveCSS('cursor', 'default')
  await page.keyboard.press('p')
  await expect(tool('Pin')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('v')
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true')
  expect((await state()).selection).toEqual([])
})

test('Note on the selection leaves a pick on each ref, where it was clicked, and opens the first', async () => {
  const face = (await pickOver(ON_BASE))!
  const edgeAt: Vec3 = [19.7, 9, 2.5] // within reach of the long edge of the base at x = 20
  const edge = (await pickOver(edgeAt))!
  expect(edge.kind).toBe('edge')
  await clickOver(ON_BASE)
  await clickOver(edgeAt, { shift: true })
  await expect.poll(async () => (await state()).selection).toEqual([face.ref, edge.ref])
  const note = page.getByRole('group', { name: 'Selection' }).getByRole('button', { name: 'Note', exact: true })
  await expect(note).toBeEnabled()
  await note.click()

  await expect(card().locator('.mark-chip')).toHaveText('M7')
  await expect(field()).toBeFocused()
  await expect.poll(async () => (await state()).selection).toEqual([])
  const [onFace, onEdge] = marksOnDisk().marks.slice(-2) as PickMark[]
  expect(onFace).toMatchObject({ id: 'M7', kind: 'pick', target: 'face', author: 'user', anchor: { part: 'base', ref: face.ref, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' } })
  expect(onEdge).toMatchObject({ id: 'M8', kind: 'pick', target: 'edge', author: 'user', anchor: { part: 'base', ref: edge.ref, descriptor: 'line, 30 mm' } })
  for (const [i, c] of ON_BASE.entries()) expect(onFace.anchor.point[i]).toBeCloseTo(c, 1)
  expect(onEdge.anchor.point[0]).toBeCloseTo(20, 1)
  expect(onEdge.anchor.point[1]).toBeCloseTo(9, 0)
  expect(onEdge.anchor.normal).toBeUndefined()
  await page.keyboard.type('these two')
  await page.keyboard.press('Enter')
  await expect.poll(() => marksOnDisk().marks.find((m) => m.id === 'M7')?.note).toBe('these two')
})

test('the note closes when another layout is shown', async () => {
  await page.keyboard.press('p')
  await clickOver([-14, 9, 2.5])
  await expect(card().locator('.mark-chip')).toHaveText('M9')
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await page.keyboard.press('Escape') // nothing is being typed: the tool is put down, the note stays
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(card()).toBeVisible()
  await page.getByRole('button', { name: 'print', exact: true }).click()
  await expect.poll(async () => (await state()).layout).toBe('print')
  await expect(card()).toHaveCount(0)
  await page.getByRole('button', { name: 'assembly', exact: true }).click()
  await expect.poll(async () => (await state()).layout).toBe('assembly')
  await expect(card()).toHaveCount(0)
})

test('on a stale build the tools leave nothing, and the pointer is told why', async () => {
  const before = marksOnDisk().marks.length
  const source = readFileSync(model(), 'utf8')
  appendFileSync(model(), '\nthis is not python(\n')
  await expect.poll(async () => (await state()).build, { timeout: 20_000 }).toMatchObject({ status: 'failed', stale: true })

  await page.keyboard.press('p')
  await clickOver(ON_BASE)
  await expect(readout()).toHaveText(FAILED)
  await page.keyboard.press('a')
  await dragOver(ON_BASE, [-12, 9, 2.5])
  await expect(readout()).toHaveText(FAILED)
  // The drag was not taken by the tool: nothing is drawn, nothing is kept.
  await expect(card()).toHaveCount(0)
  expect(marksOnDisk().marks).toHaveLength(before)

  writeFileSync(model(), source)
  await expect.poll(async () => (await state()).build, { timeout: 20_000 }).toMatchObject({ status: 'ok', stale: false })
  await page.keyboard.press('v')
})

test('an orthographic standard view is locked, and says so on its button; turning it or perspective unlocks it', async () => {
  expect((await state()).lockedView).toBeNull() // from above, but in perspective
  await expect(lockOf('top')).not.toHaveAttribute('data-locked')
  await page.getByRole('button', { name: 'Ortho', exact: true }).click()
  await expect.poll(async () => (await state()).lockedView).toBe('top')
  await expect(lockOf('top')).toHaveAttribute('data-locked', '')
  await expect(lockOf('top').locator('svg')).toBeVisible()

  await page.keyboard.press('2')
  await expect.poll(async () => (await state()).lockedView).toBe('front')
  await expect(lockOf('front')).toHaveAttribute('data-locked', '')
  await expect(lockOf('top')).not.toHaveAttribute('data-locked')

  // Zooming keeps it.
  const before = await camera()
  const box = (await canvas().boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4)
  await page.mouse.wheel(0, -200)
  await expect.poll(async () => (await camera()).zoom).toBeGreaterThan(before.zoom)
  await page.waitForTimeout(250) // the camera comes to rest, and says where
  expect((await state()).lockedView).toBe('front')

  // A drag beside the part turns the camera: no lock.
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 80)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 60, box.y + box.height - 80)
  await page.mouse.up()
  await expect.poll(async () => (await state()).lockedView).toBeNull()
  await expect(lockOf('front')).not.toHaveAttribute('data-locked')

  // One of the views behind the chevron: the lock is on the chevron's button, and in the menu.
  const more = page.getByRole('button', { name: /^More views/ })
  await more.click()
  await page.getByRole('menuitem', { name: 'Back' }).click()
  await expect.poll(async () => (await state()).lockedView).toBe('back')
  await expect(more).toHaveAttribute('data-locked', '')
  await expect(more).toHaveAccessibleName('More views: locked on back')
})

test('D takes the draw tool; on the locked front view a stroke beside the part is a profile on XZ, in millimetres', async () => {
  await expect(tool('Draw')).toBeEnabled()
  await page.keyboard.press('2')
  await expect.poll(async () => (await state()).lockedView).toBe('front')
  await page.keyboard.press('d')
  await expect(tool('Draw')).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas()).toHaveCSS('cursor', 'crosshair')

  // Beside the post and above the base: three segments, 10 mm wide and 14 mm high, on the plane y = 0.
  const path: Vec3[] = [[8, 0, 6], [18, 0, 10], [8, 0, 16], [18, 0, 20]]
  for (const point of path) expect(await pickOver(point)).toBeNull()
  const view = await camera()
  const before = marksOnDisk().marks.length
  await strokeOver(path, { hold: true })
  // While it is drawn: the plane, and how large the drawing is on it; nothing is kept yet, and the camera stays put.
  await expect(readout().locator('.pick-readout-ref')).toHaveText('XZ at y = 0.0')
  await expect(readout().locator('.pick-readout-detail')).toHaveText(/^\d+\.\d × \d+\.\d mm$/)
  expect(marksOnDisk().marks).toHaveLength(before)
  await page.mouse.up()

  await expect(card()).toBeVisible()
  await expect(field()).toBeFocused()
  await expect(readout()).toBeHidden()
  expect(await camera()).toEqual(view)
  const stroke = marksOnDisk().marks.at(-1) as StrokeMark
  expect(marksOnDisk().marks).toHaveLength(before + 1)
  expect(stroke).toMatchObject({ kind: 'stroke', space: 'plane', author: 'user', status: 'draft', layout: 'assembly', plane: { x: [1, 0, 0], y: [0, 0, 1] } })
  expect(stroke.plane!.label).toMatch(/^XZ at y = -?\d+\.\d$/)
  expect(stroke.plane!.label).toBe('XZ at y = 0.0')
  expect(stroke.points).toBeUndefined()
  expect(stroke.anchor.part).toBeUndefined()
  // Millimetres on the plane, from its origin: the extents are those of the drag.
  const us = stroke.points2d!.map((p) => p[0])
  const vs = stroke.points2d!.map((p) => p[1])
  expect(stroke.points2d).toHaveLength(4)
  expect(Math.abs(Math.max(...us) - Math.min(...us) - 10) / 10).toBeLessThan(0.05)
  expect(Math.abs(Math.max(...vs) - Math.min(...vs) - 14) / 14).toBeLessThan(0.05)
  // And they are where they were drawn: origin + u·x + v·y.
  for (const [i, [u, v]] of stroke.points2d!.entries()) {
    expect(stroke.plane!.origin[0] + u).toBeCloseTo(path[i][0], 0)
    expect(stroke.plane!.origin[2] + v).toBeCloseTo(path[i][2], 0)
  }
  expect(stroke.plane!.origin[1]).toBeCloseTo(0, 6)
  for (const [i, c] of path[0].entries()) expect(stroke.anchor.point[i]).toBeCloseTo(c, 0)

  // The note is at the stroke's first point, and says which plane and how large.
  await expect(card().locator('.note-ref')).toHaveText('XZ at y = 0.0')
  await expect(card().locator('.note-detail')).toHaveText(/^\d+\.\d × \d+\.\d mm$/)
  const { box: note, at } = await noteAndPoint(path[0])
  expect(inside(note, at, 6)).toBe(false)
  expect(inside(note, at, 140)).toBe(true)
  await page.keyboard.type('this profile, 3 mm thick')
  await page.keyboard.press('Enter')
  await expect.poll(() => marksOnDisk().marks.at(-1)?.note).toBe('this profile, 3 mm thick')
  await expect(page.locator(`.mark-row[data-mark="${stroke.id}"] .mark-kind`)).toHaveAttribute('aria-label', 'Stroke')
})

test('while a stroke is drawn the wheel still zooms, the view stays locked, and Escape drops the stroke', async () => {
  const before = marksOnDisk().marks.length
  const view = await camera()
  await strokeOver([[8, 0, 6], [14, 0, 12]], { hold: true })
  await expect(readout()).toBeVisible()
  await page.mouse.wheel(0, -200)
  await expect.poll(async () => (await camera()).zoom).toBeGreaterThan(view.zoom)
  // Zoomed, not turned.
  expect((await page.evaluate(() => window.__tornoTest!.camera().up))).toEqual(view.up)
  await page.keyboard.press('Escape')
  await expect(readout()).toBeHidden()
  await expect(tool('Draw')).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.up()
  await expect(card()).toHaveCount(0)
  expect(marksOnDisk().marks).toHaveLength(before)
  await expect.poll(async () => (await state()).lockedView).toBe('front')
})

test('on a free view a stroke across the top of the base lies on the surface', async () => {
  await page.keyboard.press('1') // iso: not a view to lock on
  await expect.poll(async () => (await state()).lockedView).toBeNull()
  await expect(tool('Draw')).toHaveAttribute('aria-pressed', 'true')
  const before = marksOnDisk().marks.length
  const path: Vec3[] = [[15, 11, 2.5], [10, 0, 2.5], [16, -6, 2.5], [12, -12, 2.5]]
  const hit = (await pickOver(path[0]))!
  expect(hit.part).toBe('base')
  await strokeOver(path)
  await expect(card()).toBeVisible()
  const stroke = marksOnDisk().marks.at(-1) as StrokeMark
  expect(marksOnDisk().marks).toHaveLength(before + 1)
  expect(stroke).toMatchObject({ kind: 'stroke', space: 'surface', author: 'user', anchor: { part: 'base', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' } })
  expect(stroke.plane).toBeUndefined()
  expect(stroke.points2d).toBeUndefined()
  expect(stroke.points).toHaveLength(4)
  for (const point of stroke.points!) expect(Math.abs(point[2] - 2.5)).toBeLessThan(0.01)
  for (const [i, point] of stroke.points!.entries()) expect(length(point, path[i])).toBeLessThan(0.6)
  expect(stroke.anchor.point).toEqual(stroke.points![0])
  await page.keyboard.press('Escape') // the note
  await expect(card()).toHaveCount(0)

  // A press beside the part is no stroke: it turns the camera as ever.
  const view = await camera()
  const box = (await canvas().boundingBox())!
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 80)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 70, box.y + box.height - 80)
  await page.mouse.up()
  expect((await camera()).position).not.toEqual(view.position)
  expect(marksOnDisk().marks).toHaveLength(before + 1)
  await page.keyboard.press('v')
})

// Set TORNO_SHOTS=<dir> to write tool-pin-light.png, tool-arrow-light.png,
// tool-draw-light.png and their -dark twins there: the note open on a fresh
// pin, an arrow being dragged with its readout, and a profile being drawn on
// the locked front view. Each picture needs its own launch: on a hidden
// window capturePage() delivers one image and hangs on the next call, and
// page.screenshot() never returns.
for (const shot of ['pin-light', 'pin-dark', 'arrow-light', 'arrow-dark', 'draw-light', 'draw-dark'] as const) {
  test(`screenshot of the tools, ${shot}`, async () => {
    const dir = process.env.TORNO_SHOTS
    test.skip(!dir, 'TORNO_SHOTS is not set')
    test.setTimeout(120_000)
    mkdirSync(dir!, { recursive: true })
    const shotRoot = copyFixtures()
    const shotApp = await launch({ TORNO_WORKSPACE: shotRoot })
    try {
      const shotPage = await shotApp.firstWindow()
      await shotPage.emulateMedia({ colorScheme: shot.endsWith('dark') ? 'dark' : 'light' })
      await shotPage.getByRole('button', { name: 'bracket', exact: true }).click()
      await expect.poll(async () => (await state(shotPage)).build?.status, { timeout: 90_000 }).toBe('ok')
      if (shot.startsWith('pin')) {
        await shotPage.keyboard.press('p')
        await clickOver([-13, -9, 2.5], {}, shotPage)
        await expect(field(shotPage)).toBeFocused()
        await shotPage.keyboard.type('too thin under the post')
        await shotPage.keyboard.press('Enter')
        await clickOver([0, -4, 14], {}, shotPage)
        await expect(card(shotPage).locator('.mark-chip')).toHaveText('M2')
        await expect(field(shotPage)).toBeFocused()
      } else if (shot.startsWith('draw')) {
        await shotPage.keyboard.press('o')
        await shotPage.keyboard.press('2')
        await expect.poll(async () => (await state(shotPage)).lockedView).toBe('front')
        await shotPage.keyboard.press('d')
        // A gusset between the base and the post, drawn by hand: not quite straight.
        const profile: Vec3[] = [[17, 0, 2.6], [16.2, 0, 4.4], [14.1, 0, 7.2], [11.8, 0, 10.5], [9.2, 0, 13.4], [7.1, 0, 16.6], [5.2, 0, 19.3], [4.1, 0, 20.4]]
        await strokeOver(profile, { hold: true }, shotPage)
        await expect(readout(shotPage)).toBeVisible()
      } else {
        await shotPage.keyboard.press('a')
        await dragOver([0, -4, 16], [14, -15, 16], { hold: true }, shotPage)
        await expect(readout(shotPage)).toBeVisible()
      }
      await shotPage.evaluate(async () => {
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      })
      const png = await shotApp.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
        return image.toPNG().toString('base64')
      })
      writeFileSync(join(dir!, `tool-${shot}.png`), Buffer.from(png, 'base64'))
    } finally {
      await shotApp.close()
      rmSync(shotRoot, { recursive: true, force: true })
    }
  })
}

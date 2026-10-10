import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { ObjectCard } from '../src/shared/show'

// The page of objects: a card for each object of the workspace, with the picture the window drew of its last
// build, how it stands and what is open on it. Nothing is built for a card. The window is hidden throughout.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

function copyFixtures(name: string): string {
  const made = mkdtempSync(join(realpathSync(tmpdir()), name))
  cpSync(fixtures, made, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  return made
}

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
const launch = (workspace: string): Promise<ElectronApplication> => electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: workspace } })

test.beforeAll(async () => {
  root = copyFixtures('torno-e2e-show-')
  // bracket was last looked at with its post switched off and cut across: its picture is of that.
  mkdirSync(join(root, 'bracket', '.torno'), { recursive: true })
  writeFileSync(join(root, 'bracket', '.torno', 'scene.json'), JSON.stringify({ layout: 'assembly', layers: { post: { visible: false } }, section: { origin: [0, 0, 0], normal: [0, 1, 0] } }))
  app = await launch(root)
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await page.emulateMedia({ colorScheme: 'light' })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (p: Page = page): Promise<TornoState> => p.evaluate(() => window.__tornoTest!.state())
const opened = (a: ElectronApplication = app): Promise<string[]> => a.evaluate(() => (globalThis as unknown as { __tornoMain: { opened(): string[] } }).__tornoMain.opened())
const card = (id: string, p: Page = page) => p.locator(`.card[data-object="${id}"]`)
const thumb = (id: string, file = 'thumb.png'): string => join(root, id, '.torno', file)
const meta = (id: string): Record<string, unknown> => JSON.parse(readFileSync(thumb(id, 'thumb.json'), 'utf8'))
const focusedCard = (p: Page = page): Promise<string | null> => p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.object ?? null)
/** The alpha of a pixel of the picture a card shows, at fractions of its width and height. */
const alphaAt = (id: string, fx: number, fy: number): Promise<number> =>
  card(id).locator('img').evaluate((img: HTMLImageElement, [x, y]) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data[3]
  }, [fx, fy])

test('the page of objects shows a card each, builds nothing, and opens one with a click', async () => {
  // A workspace of several objects starts on the page.
  expect((await state()).page).toBe('objects')
  await expect(page.locator('.card')).toHaveCount((await state()).workspace!.objects.length)
  await expect(page.getByRole('region', { name: /^Objects of torno-e2e-show-/ })).toBeVisible()
  await expect(card('hollow')).toContainText('Not opened in this run')
  await expect(card('hollow')).toContainText('No picture yet')
  // One that cannot be built says why, as the list does.
  await expect(card('two')).toContainText('more than one model file')
  // Looking at the page built nothing, and wrote nothing.
  expect(await opened()).toEqual([])
  expect(existsSync(join(root, 'hollow', '.torno'))).toBe(false)
  await card('hollow').click()
  await expect.poll(async () => (await state()).build?.status).toBe('ok')
  expect((await state()).page).toBe('object')
  // Its picture is made from that build, without anything more being asked of the kernel.
  await expect.poll(() => existsSync(thumb('hollow'))).toBe(true)
  const bytes = readFileSync(thumb('hollow'))
  expect([...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([480, 360])
  await expect.poll(() => existsSync(thumb('hollow', 'thumb.json'))).toBe(true)
  expect(meta('hollow')).toMatchObject({ layout: 'assembly', parts: 2, model: 'hollow.py' })
  expect(meta('hollow')).not.toHaveProperty('cut')
  // Git passes over the two: they change with every build.
  expect(readFileSync(thumb('hollow', '.gitignore'), 'utf8')).toBe('thumb.png\nthumb.json\n')
  // Nothing of it outside .torno.
  expect(readdirSync(join(root, 'hollow')).sort()).toEqual(['.torno', 'hollow.py'])
  await page.getByRole('button', { name: 'All objects' }).click()
  await expect(card('hollow')).toContainText('Built, r1')
  await expect(card('hollow')).toHaveAttribute('aria-current', 'true')
  await expect(card('hollow').locator('img')).toHaveJSProperty('naturalWidth', 480)
  // Parts on a clear ground: the card's own surface shows round them, in either theme.
  expect(await alphaAt('hollow', 0.01, 0.01)).toBe(0)
  expect(await alphaAt('hollow', 0.5, 0.5)).toBe(255)
  // The 3D view is under the page as it was, and takes nothing meanwhile.
  await expect(page.locator('.viewport-pane')).toHaveAttribute('inert', '')
  expect((await state()).objectId).toBe('hollow')
})

test('a card says when its picture is older than the model, and a second object gets its picture while the first is shown', async () => {
  await card('plain').click()
  await expect.poll(async () => (await state()).build?.status).toBe('ok')
  await expect.poll(() => existsSync(thumb('plain'))).toBe(true)
  // hollow is still watched: saved again, it is built and pictured while plain is on screen.
  const before = statSync(thumb('hollow')).mtimeMs
  appendFileSync(join(root, 'hollow', 'hollow.py'), '\n# touched\n')
  await expect.poll(() => statSync(thumb('hollow')).mtimeMs, { timeout: 20_000 }).toBeGreaterThan(before)
  expect((await state()).objectId).toBe('plain')
  // A picture older than its model says so.
  await expect.poll(() => meta('hollow').modelMtimeMs).toBe(statSync(join(root, 'hollow', 'hollow.py')).mtimeMs)
  writeFileSync(thumb('hollow', 'thumb.json'), JSON.stringify({ ...meta('hollow'), modelMtimeMs: 1 }))
  await page.getByRole('button', { name: 'All objects' }).click()
  await expect(card('hollow')).toContainText('The model has changed since')
  await expect(card('plain')).not.toContainText('The model has changed since')
})

test('a picture is of the object as it was last looked at, and says what it leaves out', async () => {
  await card('bracket').click()
  await expect.poll(async () => (await state()).build?.status).toBe('ok')
  await expect.poll(() => existsSync(thumb('bracket', 'thumb.json'))).toBe(true)
  expect(meta('bracket')).toMatchObject({ layout: 'assembly', parts: 1, cut: true, hidden: 1, model: 'bracket.py' })
  await page.keyboard.press('w')
  await expect(card('bracket')).toContainText('cut by its section, 1 part left out')
  await expect(card('bracket').locator('img')).toHaveJSProperty('naturalWidth', 480)
})

test('a picture costs a few milliseconds, and leaves the view as it was', async () => {
  await page.keyboard.press('Escape')
  expect(await state()).toMatchObject({ page: 'object', objectId: 'bracket' })
  /** A picture of the view through the `look` path, as a number that is another for another picture. */
  const looked = (): Promise<number> =>
    page.evaluate(async () => {
      const { png } = await window.__tornoTest!.look({ view: 'iso', size: 320, marks: false })
      let hash = 2166136261
      for (const byte of png) hash = Math.imul(hash ^ byte, 16777619) >>> 0
      return hash
    })
  const before = await looked()
  const timed = await page.evaluate(() => window.__tornoTest!.timeThumbnail(20))
  console.log(`[show] a thumbnail of bracket: mean ${timed.meanMs.toFixed(1)} ms, worst ${timed.worstMs.toFixed(1)} ms, ${(timed.bytes / 1024).toFixed(1)} KB`)
  expect(timed.bytes).toBeGreaterThan(1000)
  expect(timed.meanMs).toBeLessThan(100)
  // The same picture of the view as before: its target, its ground and its cut are as they were.
  expect(await looked()).toBe(before)
  await page.keyboard.press('w')
})

test('the keys go from card to card, filter by name, open, and go back; none of them reaches a tool', async () => {
  // W brought the page up over bracket, whose card has the focus.
  expect((await state()).page).toBe('objects')
  await expect.poll(() => focusedCard()).toBe('bracket')
  const ids = (await state()).workspace!.objects.map((o) => o.id)
  await page.keyboard.press('ArrowRight')
  expect(await focusedCard()).toBe(ids[1])
  await page.keyboard.press('ArrowLeft')
  expect(await focusedCard()).toBe('bracket')
  const columns = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('.card')]
    return cards.filter((one) => one.offsetTop === cards[0].offsetTop).length
  })
  await page.keyboard.press('ArrowDown')
  expect(await focusedCard()).toBe(ids[columns])
  await page.keyboard.press('End')
  expect(await focusedCard()).toBe(ids[ids.length - 1])
  await page.keyboard.press('Home')
  // A letter goes into the filter: P is the Pin tool's key in the view, and is no tool's here.
  await page.keyboard.type('pl')
  const field = page.getByRole('textbox', { name: 'Filter the objects by name' })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('pl')
  await expect(page.locator('.card')).toHaveCount(1)
  await expect(page.locator('.show-count')).toHaveText(`1 of ${ids.length} in ${root.split('/').pop()}`)
  // Enter opens the first that is left.
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).objectId).toBe('plain')
  expect((await state()).page).toBe('object')
  await expect(page.locator('.viewport-pane')).not.toHaveAttribute('inert')
  await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: /^Pin/ })).toHaveAttribute('aria-pressed', 'false')
  // And back: W, then a name that is nobody's, Escape to see them all, Escape to the object.
  await page.keyboard.press('w')
  await expect(page.locator('.card')).toHaveCount(ids.length)
  await expect.poll(() => focusedCard()).toBe('plain')
  await page.keyboard.press('/')
  await expect(field).toBeFocused()
  await page.keyboard.type('zzz')
  await expect(page.locator('.show-none')).toContainText('No object is named like zzz')
  await page.keyboard.press('Escape')
  await expect(page.locator('.card')).toHaveCount(ids.length)
  expect((await state()).page).toBe('objects')
  await page.keyboard.press('Escape')
  expect(await state()).toMatchObject({ page: 'object', objectId: 'plain' })
})

test('main keeps a picture only of the last build of an object opened here, and only bytes that are one', async () => {
  const revision = (await state()).revision
  const kept = () => readFileSync(thumb('plain'))
  const before = kept()
  const result = await page.evaluate(async (rev) => {
    const png = new Uint8Array((await window.torno.show.thumbnail('plain'))!)
    const of = { layout: 'main', parts: 1 }
    // One that is kept: of the last build of an object opened here.
    window.torno.show.saveThumbnail('plain', rev, png, { ...of, layout: 'kept' })
    // Then: of an object not opened in this run; of another build than the last; no PNG; a PNG of another size;
    // one that is too heavy; of no layout; of an object that is no object of the workspace.
    window.torno.show.saveThumbnail('gauge', rev, png, of)
    window.torno.show.saveThumbnail('plain', rev + 1, png, { ...of, layout: 'another build' })
    window.torno.show.saveThumbnail('plain', rev, new Uint8Array(4000), { ...of, layout: 'no png' })
    const wide = png.slice()
    new DataView(wide.buffer).setUint32(16, 4000)
    window.torno.show.saveThumbnail('plain', rev, wide, { ...of, layout: 'too wide' })
    const heavy = new Uint8Array(600 * 1024)
    heavy.set(png)
    window.torno.show.saveThumbnail('plain', rev, heavy, { ...of, layout: 'too heavy' })
    window.torno.show.saveThumbnail('plain', rev, png, { layout: '', parts: 1 })
    window.torno.show.saveThumbnail('../plain', rev, png, { ...of, layout: 'elsewhere' })
    return { asked: await window.torno.show.thumbnail('gauge'), elsewhere: await window.torno.show.thumbnail('../plain') }
  }, revision)
  expect(result).toEqual({ asked: null, elsewhere: null })
  await expect.poll(() => meta('plain').layout).toBe('kept')
  // Each of the others was looked at before that one was on file, and a write takes a few milliseconds: none follows.
  await page.waitForTimeout(400)
  expect(meta('plain').layout).toBe('kept')
  expect(kept().equals(before)).toBe(true)
  expect(existsSync(join(root, 'gauge', '.torno'))).toBe(false)
  expect(await opened()).toEqual(['hollow', 'plain', 'bracket'])
})

test('a card counts what is open on an object from its file, and gives no verdict of a build it has not seen', async () => {
  // gauge was never opened in this run. Its marks are read from its file, which is left as it is.
  const camera = { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }
  const pin = (id: string, status: string) => ({ id, kind: 'pin', author: 'user', note: 'here', status, anchorState: 'ok', layout: 'main', revision: 1, camera, createdAt: '2026-10-08T21:00:00.000Z', anchor: { point: [0, 0, 0] } })
  const file = JSON.stringify({ next: 4, marks: [pin('M1', 'draft'), pin('M2', 'resolved'), { ...pin('M3', 'sent'), kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0] }, b: { point: [0, 0, 6] }, value: 6, expected: 8, anchor: undefined }] })
  mkdirSync(join(root, 'gauge', '.torno'), { recursive: true })
  writeFileSync(join(root, 'gauge', '.torno', 'marks.json'), file)
  // A file that is no marks file is said, and neither set aside nor rewritten.
  mkdirSync(join(root, 'morph', '.torno'), { recursive: true })
  writeFileSync(join(root, 'morph', '.torno', 'marks.json'), '{ not json')
  await page.keyboard.press('w')
  const cards = (): Promise<ObjectCard[]> => page.evaluate(() => window.torno.show.cards())
  await expect.poll(async () => (await cards()).find((c) => c.id === 'gauge')).toMatchObject({ opened: false, marks: { open: 2, drafts: 1 }, dimensions: null, lastRun: { dimensions: 1, failed: 1 } })
  expect((await cards()).find((c) => c.id === 'morph')).toMatchObject({ opened: false, marks: null })
  // The page asks again when something a card says changes; a file changed by hand is seen at the next asking.
  await page.keyboard.press('Escape')
  await page.keyboard.press('w')
  await expect(card('gauge')).toContainText('2 open marks')
  await expect(card('gauge')).toContainText('1 not sent yet')
  await expect(card('gauge')).toContainText('1 dimension failed as of its last run')
  await expect(card('gauge').locator('.card-chip[data-tone="fail"], .card-chip[data-tone="ok"]')).toHaveCount(0)
  await expect(card('morph')).toContainText('Marks could not be read')
  expect(readFileSync(join(root, 'gauge', '.torno', 'marks.json'), 'utf8')).toBe(file)
  expect(readdirSync(join(root, 'morph', '.torno'))).toEqual(['marks.json'])
  expect(await opened()).toEqual(['hollow', 'plain', 'bracket'])
  await page.keyboard.press('Escape')
})

test('a build that fails wins over the picture, which stays and is dimmed', async () => {
  appendFileSync(join(root, 'plain', 'plain.py'), '\nraise ValueError("too thin")\n')
  await expect.poll(async () => (await state()).build?.status, { timeout: 20_000 }).toBe('failed')
  await page.keyboard.press('w')
  await expect(card('plain')).toContainText('Failed: too thin')
  await expect(card('plain').locator('[data-part="build"]')).toHaveAttribute('data-tone', 'fail')
  await expect(card('plain')).toContainText('of the last build that worked')
  await expect(card('plain').locator('.card-picture')).toHaveAttribute('data-dimmed', '')
  await page.keyboard.press('Escape')
})

// Forty objects, none opened: what the page costs when it is the face of a full workspace. Thirty have a picture
// on file. Nothing is built, and only the pictures of the cards in view, or near it, are asked for.
test('with forty objects the page is there at once, builds nothing, and asks for the pictures in view only', async () => {
  test.setTimeout(90_000)
  const many = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-show-many-'))
  const picture = readFileSync(thumb('hollow'))
  const names = Array.from({ length: 40 }, (_, i) => `part-${String(i + 1).padStart(2, '0')}`)
  for (const [i, name] of names.entries()) {
    mkdirSync(join(many, name, '.torno'), { recursive: true })
    writeFileSync(join(many, name, `${name.replace('-', '_')}.py`), readFileSync(join(fixtures, 'plain', 'plain.py')))
    if (i % 4 !== 3) {
      writeFileSync(join(many, name, '.torno', 'thumb.png'), picture)
      writeFileSync(join(many, name, '.torno', 'thumb.json'), JSON.stringify({ at: '2026-10-08T21:14:03.000Z', layout: 'assembly', parts: 2, model: `${name.replace('-', '_')}.py`, modelMtimeMs: i % 8 === 0 ? 1 : Date.now() + 60_000 }))
    }
  }
  const manyApp = await launch(many)
  try {
    const manyPage = await manyApp.firstWindow()
    const started = Date.now()
    await expect(manyPage.locator('.card')).toHaveCount(40)
    const shownAfter = Date.now() - started
    const timed = await manyPage.evaluate(async () => {
      const times: number[] = []
      for (let i = 0; i < 10; i++) {
        const before = performance.now()
        await window.torno.show.cards()
        times.push(performance.now() - before)
      }
      times.sort((a, b) => a - b)
      return { median: times[5], worst: times[9] }
    })
    // Pictures: those of the cards in view have come; those far below have not been asked for.
    await expect(manyPage.locator('.card[data-object="part-01"] img')).toHaveJSProperty('naturalWidth', 480)
    const first = await manyPage.locator('.card img').count()
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(20)
    await expect(manyPage.locator('.card[data-object="part-38"] img')).toHaveCount(0)
    await expect(manyPage.locator('.card[data-object="part-01"]')).toContainText('The model has changed since')
    await expect(manyPage.locator('.card[data-object="part-04"]')).toContainText('No picture yet')
    // Brought into view by the keys, the last ones get theirs.
    await manyPage.keyboard.press('End')
    await expect(manyPage.locator('.card[data-object="part-38"] img')).toHaveJSProperty('naturalWidth', 480)
    const atEnd = await manyPage.locator('.card img').count()
    expect(await opened(manyApp)).toEqual([])
    for (const name of names) expect(readdirSync(join(many, name, '.torno')).sort()).toEqual(names.indexOf(name) % 4 !== 3 ? ['thumb.json', 'thumb.png'] : [])
    console.log(`[show] 40 objects: cards on the page ${shownAfter} ms after the window; show.cards() median ${timed.median.toFixed(1)} ms, worst ${timed.worst.toFixed(1)} ms; pictures asked for at first ${first} of 30, after End ${atEnd}`)
    expect(timed.median).toBeLessThan(250)
  } finally {
    await manyApp.close()
    rmSync(many, { recursive: true, force: true })
  }
})

// Set TORNO_SHOTS=<dir> to write show-light.png, show-dark.png, show-empty-light.png and show-empty-dark.png there:
// the page over a workspace whose objects stand in every way a card can say, and over one with no object. Each
// picture needs its own launch: on a hidden window capturePage() delivers one image and hangs on the next call,
// and page.screenshot() never returns.
for (const shot of ['light', 'dark', 'empty-light', 'empty-dark'] as const) {
  test(`screenshot of the page of objects, ${shot}`, async () => {
    const dir = process.env.TORNO_SHOTS
    test.skip(!dir, 'TORNO_SHOTS is not set')
    test.setTimeout(120_000)
    mkdirSync(dir!, { recursive: true })
    const empty = shot.startsWith('empty')
    const shotRoot = empty ? mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-show-empty-')) : copyFixtures('torno-e2e-show-shot-')
    if (!empty) {
      mkdirSync(join(shotRoot, 'bracket', '.torno'), { recursive: true })
      writeFileSync(join(shotRoot, 'bracket', '.torno', 'scene.json'), JSON.stringify({ layout: 'assembly', layers: {}, explode: { assembly: { amount: 0.5, scale: 1, axis: 'z' } } }))
      mkdirSync(join(shotRoot, 'measures', '.torno'), { recursive: true })
      writeFileSync(join(shotRoot, 'measures', '.torno', 'scene.json'), JSON.stringify({ layers: {}, section: { origin: [0, 0, 0], normal: [0, -1, 0] } }))
    }
    const shotApp = await launch(shotRoot)
    try {
      const shotPage = await shotApp.firstWindow()
      await shotPage.waitForSelector('[data-region="left"]')
      await shotPage.emulateMedia({ colorScheme: shot.endsWith('dark') ? 'dark' : 'light' })
      // A hidden window is not the one in use, and draws no focus: the page is told it is, so that the card in focus shows as it would.
      const devtools = await shotPage.context().newCDPSession(shotPage)
      await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const made = (id: string): string => join(shotRoot, id, '.torno', 'thumb.json')
      const open = async (id: string): Promise<void> => {
        await shotPage.locator(`.card[data-object="${id}"]`).click()
        await expect.poll(async () => (await state(shotPage)).build?.status, { timeout: 60_000 }).toBe('ok')
        await expect.poll(() => existsSync(made(id))).toBe(true)
        await shotPage.keyboard.press('w')
      }
      if (!empty) {
        for (const id of ['hollow', 'bracket', 'measures', 'spread', 'gauge', 'plain']) await open(id)
        // gauge and spread as a run before left them: pictures on file, the model of one saved since, marks in their files.
        const camera = { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }
        const pin = (id: string, status: string) => ({ id, kind: 'pin', author: 'user', note: 'here', status, anchorState: 'ok', layout: 'main', revision: 1, camera, createdAt: '2026-10-08T21:00:00.000Z', anchor: { point: [0, 0, 0] } })
        for (const [from, to] of [['gauge', 'morph'], ['spread', 'makers']] as const) {
          mkdirSync(join(shotRoot, to, '.torno'), { recursive: true })
          cpSync(join(shotRoot, from, '.torno', 'thumb.png'), join(shotRoot, to, '.torno', 'thumb.png'))
          writeFileSync(made(to), JSON.stringify({ ...JSON.parse(readFileSync(made(from), 'utf8')), at: '2026-10-02T09:41:00.000Z', model: `${to}.py`, modelMtimeMs: to === 'morph' ? 1 : Date.now() + 60_000 }))
        }
        writeFileSync(join(shotRoot, 'makers', '.torno', 'marks.json'), JSON.stringify({ next: 5, marks: [pin('M1', 'draft'), pin('M2', 'sent'), { ...pin('M3', 'sent'), kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0] }, b: { point: [0, 0, 6] }, value: 6, expected: 8, anchor: undefined }, { ...pin('M4', 'sent'), kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0] }, b: { point: [0, 0, 8] }, value: 8, expected: 8, anchor: undefined }] }))
        // On hollow: a pin of the person's, not sent yet.
        await shotPage.evaluate(() => window.torno.marks.add('hollow', { kind: 'pin', author: 'user', layout: 'assembly', revision: 1, camera: window.__tornoTest!.camera(), note: 'too thin here', anchor: { point: [20, 0, 20], part: 'tub' } }))
        // plain built, and then stopped building.
        appendFileSync(join(shotRoot, 'plain', 'plain.py'), '\nraise ValueError("the plate is thinner than its fillet")\n')
        await shotPage.locator('.object-row', { hasText: 'plain' }).click()
        await expect.poll(async () => (await state(shotPage)).build?.status, { timeout: 30_000 }).toBe('failed')
        await shotPage.locator('.object-row', { hasText: 'hollow' }).click()
        await expect.poll(async () => (await state(shotPage)).objectId).toBe('hollow')
        await shotPage.keyboard.press('w')
        await expect(shotPage.locator('.card[data-object="plain"]')).toContainText('Failed')
        await expect(shotPage.locator('.card[data-object="morph"] img')).toHaveJSProperty('naturalWidth', 480)
        await expect(shotPage.locator('.card[data-object="hollow"] img')).toHaveJSProperty('naturalWidth', 480)
        // Wide enough for four cards to a row: the session is put away for the picture.
        await shotPage.getByRole('button', { name: 'Hide session' }).click()
        // The focus on a card of the first row, and the page at its top.
        await shotPage.keyboard.press('Home')
        await shotPage.keyboard.press('ArrowRight')
        await shotPage.locator('.show').evaluate((el) => el.scrollTo(0, 0))
      } else {
        await expect(shotPage.locator('.show-empty')).toBeVisible()
      }
      await shotPage.evaluate(async () => {
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      })
      const png = await shotApp.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
        return image.toPNG().toString('base64')
      })
      writeFileSync(join(dir!, `show-${shot}.png`), Buffer.from(png, 'base64'))
      // The pictures themselves, as they are on file, for whoever wants to look at one.
      if (!empty) for (const id of ['hollow', 'bracket', 'measures', 'spread']) cpSync(join(shotRoot, id, '.torno', 'thumb.png'), join(dir!, `thumb-${id}.png`))
    } finally {
      await shotApp.close()
      rmSync(shotRoot, { recursive: true, force: true })
    }
  })
}

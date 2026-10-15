import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { TornoExport } from '../src/export/viewer/main'
import { type ExportData, SCAN_WARNING } from '../src/shared/exportdata'
import type { Mark } from '../src/shared/marks'
import { box, stl } from '../src/test/scanFixtures'

// Export: one HTML file of an object, or of several, that opens by itself. The file is written where the save
// dialog says (under test, where `__tornoMain.pickSave` says: no dialog is ever shown), and is then opened in a
// second window that is never shown, with every request but the file itself refused and counted.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let outDir: string
let app: ElectronApplication
let page: Page

/** A note that would be markup, were it ever written as markup. */
const HOSTILE = '<img src=x onerror="window.__pwned=1"> lid sits proud </script><script>window.__pwned=2</script>'
const camera = { position: [120, -90, 60], target: [0, 0, 19], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }

/** A copy of the fixtures in which `hollow` was looked at before: a view of the person's, one the agent proposed, and marks. */
function workspace(name: string): string {
  const made = mkdtempSync(join(realpathSync(tmpdir()), name))
  cpSync(fixtures, made, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  mkdirSync(join(made, 'hollow', '.torno'), { recursive: true })
  writeFileSync(
    join(made, 'hollow', '.torno', 'scene.json'),
    JSON.stringify({
      layout: 'assembly',
      layers: {},
      views: [
        { name: 'Lid off', author: 'user', layout: 'assembly', camera, hidden: [], explode: { amount: 0.5, scale: 1, axis: 'z' }, at: '2026-10-09T21:14:03.000Z' },
        { name: 'Agent idea', author: 'agent', proposed: true, note: 'why the agent proposed it', layout: 'assembly', camera, hidden: ['lid'], at: '2026-10-09T21:20:44.000Z' }
      ]
    })
  )
  const base = { author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, camera, createdAt: '2026-10-09T20:00:00.000Z' }
  writeFileSync(
    join(made, 'hollow', '.torno', 'marks.json'),
    JSON.stringify({
      next: 5,
      marks: [
        { ...base, id: 'M1', kind: 'pin', note: HOSTILE, anchor: { point: [0, 0, 40], normal: [0, 0, 1], part: 'lid' } },
        // Across the tub, between its two outer walls: 40 mm.
        { ...base, id: 'M2', kind: 'dimension', note: 'outer width', measure: 'distance', a: { point: [-20, 0, 10], normal: [-1, 0, 0], part: 'tub' }, b: { point: [20, 0, 10], normal: [1, 0, 0], part: 'tub' }, expected: 40 },
        // One that is settled, and one the agent was never sent.
        { ...base, id: 'M3', kind: 'pin', status: 'resolved', resolvedBy: 'user', note: 'settled long ago', anchor: { point: [20, 0, 20], normal: [1, 0, 0], part: 'tub' } },
        { ...base, id: 'M4', kind: 'pin', status: 'draft', note: 'not sent yet', anchor: { point: [0, -20, 20], normal: [0, -1, 0], part: 'tub' } }
      ]
    })
  )
  return made
}

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
const launch = (folder: string): Promise<ElectronApplication> => electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: folder } })

test.beforeAll(async () => {
  root = workspace('torno-e2e-export-')
  outDir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-export-out-'))
  app = await launch(root)
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

const state = (p: Page = page): Promise<TornoState> => p.evaluate(() => window.__tornoTest!.state())
type MainHooks = { pickSave: string | null; savePicks: number; saveOffered: string | null; replace: boolean; replaceAsked: number }
const setSave = (path: string | null, a: ElectronApplication = app): Promise<void> => a.evaluate((_e, to) => void ((globalThis as unknown as { __tornoMain: MainHooks }).__tornoMain.pickSave = to), path)
const hooks = (a: ElectronApplication = app): Promise<MainHooks> => a.evaluate(() => ({ ...(globalThis as unknown as { __tornoMain: MainHooks }).__tornoMain }) as MainHooks).then(({ pickSave, savePicks, saveOffered, replace, replaceAsked }) => ({ pickSave, savePicks, saveOffered, replace, replaceAsked }))
const sheet = (p: Page = page) => p.getByRole('dialog', { name: 'Export' })

async function open(id: string, p: Page = page): Promise<void> {
  if ((await state(p)).page === 'objects') await p.locator(`.card[data-object="${id}"]`).click()
  else await p.getByRole('button', { name: id, exact: true }).click()
  await expect.poll(async () => (await state(p)).build?.status, { timeout: 60_000 }).toBe('ok')
  expect((await state(p)).objectId).toBe(id)
}

/** Opens an exported file in a second window that is never shown, with the network refused, and gives a way to ask its page things. */
async function openExport(file: string, a: ElectronApplication = app, size: [number, number] = [900, 700], webgl = true) {
  const id = await a.evaluate(
    async ({ BrowserWindow, session }, [path, width, height, gl]) => {
      const requests: string[] = []
      const own = session.fromPartition(`export-check-${Date.now()}`)
      own.webRequest.onBeforeRequest((details, done) => {
        const itself = details.url.startsWith('file://') || details.url.startsWith('data:') || details.url.startsWith('blob:') || details.url.startsWith('devtools:')
        if (!itself) requests.push(details.url)
        done({ cancel: !itself })
      })
      const win = new BrowserWindow({ show: false, width: width as number, height: height as number, webPreferences: { session: own, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, webgl: gl as boolean } })
      await win.loadFile(path as string)
      ;(globalThis as unknown as { __exportRequests: string[] }).__exportRequests = requests
      return win.id
    },
    [file, size[0], size[1], webgl] as const
  )
  const ask = <T>(js: string): Promise<T> => a.evaluate(({ BrowserWindow }, [win, code]) => BrowserWindow.fromId(win as number)!.webContents.executeJavaScript(code as string), [id, js] as const) as Promise<T>
  const close = () => a.evaluate(({ BrowserWindow }, win) => BrowserWindow.fromId(win)!.destroy(), id)
  const visible = () => a.evaluate(({ BrowserWindow }, win) => BrowserWindow.fromId(win)!.isVisible(), id)
  const requests = () => a.evaluate(() => (globalThis as unknown as { __exportRequests: string[] }).__exportRequests)
  /** One picture of the window: only one is ever delivered per launch. */
  const capture = () => a.evaluate(async ({ BrowserWindow }, win) => (await BrowserWindow.fromId(win)!.webContents.capturePage()).toPNG().toString('base64'), id)
  const ready = () => expect.poll(() => ask<boolean>('typeof window.__tornoExport === "object"'), { timeout: 20_000 }).toBe(true)
  const pageState = () => ask<ReturnType<TornoExport['state']>>('window.__tornoExport.state()')
  return { ask, close, visible, requests, capture, ready, pageState }
}

/** The data an exported page holds. */
const dataOf = (html: string): ExportData => JSON.parse(/<script type="application\/json" id="torno-data">(.*?)<\/script>/s.exec(html)![1])

/** Nothing of this machine is in a file: not the workspace, not the home folder, not the person's name, no address at all. */
function expectNothingOfHere(html: string, folder: string = root): void {
  expect(html).not.toContain(folder)
  expect(html).not.toContain(homedir())
  expect(html).not.toContain(tmpdir())
  expect(html.toLowerCase()).not.toContain(`/${userInfo().username.toLowerCase()}/`)
  expect(html).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\Users/)
  expect(html).not.toMatch(/https?:\/\//)
  expect(html).not.toContain('hollow.py')
}

test('an object is exported to the path that was chosen, and the file opens by itself and answers its controls', async () => {
  await open('hollow')
  // Its dimension is measured on this build before anything is exported.
  await expect.poll(async () => ((await page.evaluate(() => window.torno.marks.list('hollow'))) as Mark[]).find((m) => m.id === 'M2')).toMatchObject({ value: 40, measuredRevision: 1, verdict: 'pass' })
  const out = join(outDir, 'hollow.html')
  await setSave(out)
  await page.getByRole('button', { name: 'Export…' }).click()
  await expect(sheet()).toContainText('about')
  // What would go is said before anything is written: the object, its one view (the proposal is not the person's), and its marks, which are not ticked.
  await expect(sheet()).toContainText('r1 · 2 parts · 1 saved view')
  // Its marks, with how many are drafts; the resolved one is named apart, and cannot be ticked without the marks.
  await expect(sheet()).toContainText('2 marks and 1 dimension, 1 of them a draft the agent has not been sent')
  await expect(sheet()).toContainText('1 resolved mark, with its note: left out')
  await expect(sheet().getByRole('checkbox', { name: /Include resolved marks/ })).toBeDisabled()
  // The sheet is the one thing to answer while it is up: Tab stays in it.
  await expect(sheet()).toHaveAttribute('aria-modal', 'true')
  for (let n = 0; n < 12; n++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null)).toBe('Export')
  }
  await expect(sheet().getByRole('checkbox', { name: /^hollow/ })).toBeChecked()
  await expect(sheet().getByRole('checkbox', { name: /Include marks and their notes/ })).not.toBeChecked()
  // An object with no build of this run cannot be ticked: it is named, with what would make it exportable.
  await expect(sheet().getByRole('checkbox')).toHaveCount(3)
  await expect(sheet().locator('.export-cannot')).toContainText(/^Open it first: torno exports the last build of this run: bracket, .*plain/)
  expect((await hooks()).savePicks).toBe(0)
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
  // The dialog would have opened in a folder of torno's own, which git passes over; the file went only where it was asked to.
  expect(await hooks()).toMatchObject({ savePicks: 1, saveOffered: join(root, 'hollow', '.torno', 'exports', 'hollow-r1.html') })
  expect(readFileSync(join(root, 'hollow', '.torno', '.gitignore'), 'utf8').split('\n')).toContain('exports/')
  expect(readdirSync(join(root, 'hollow', '.torno', 'exports'))).toEqual([])
  expect(readdirSync(dirname(out))).toEqual(['hollow.html'])
  expect(readdirSync(join(root, 'hollow')).sort()).toEqual(['.torno', 'hollow.py'])
  const html = readFileSync(out, 'utf8')
  // For a look at the file in another browser, by hand: TORNO_KEEP_EXPORT=<dir> keeps a copy there.
  if (process.env.TORNO_KEEP_EXPORT) cpSync(out, join(process.env.TORNO_KEEP_EXPORT, 'hollow.html'))
  expect(html.length).toBeLessThan(2_000_000)
  expectNothingOfHere(html)
  // Neither a note (marks were not ticked) nor the view the agent proposed and nobody kept.
  for (const kept of ['lid sits proud', 'outer width', 'settled long ago', 'not sent yet', 'Agent idea', 'why the agent proposed it', '__pwned']) expect(html).not.toContain(kept)
  // Its policy names its one script and its one style by their hashes: nothing else can run in it.
  expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-[A-Za-z0-9+\/]{43}='; style-src 'sha256-[A-Za-z0-9+\/]{43}='; font-src data:; base-uri 'none'; form-action 'none'">/)

  const file = await openExport(out)
  try {
    expect(await file.visible()).toBe(false)
    await file.ready()
    expect(await file.pageState()).toMatchObject({ object: 'hollow', layout: 'assembly', parts: [{ name: 'tub', visible: true }, { name: 'lid', visible: true }], marks: false, labels: [], views: ['Lid off'], section: null })
    const ground = await file.ask<number[]>('window.__tornoExport.ground()')
    const centre = await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')
    expect(centre.slice(0, 3)).not.toEqual(ground)
    // The page looks at its own canvas: the parts are on it, and it says nothing of them.
    expect(await file.ask<string | null>('window.__tornoExport.undrawn()')).toBeNull()
    // Switched off, nothing is drawn there.
    await file.ask('window.__tornoExport.setPart("tub", false); window.__tornoExport.setPart("lid", false)')
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')).slice(0, 3)).toEqual(ground)
    // Which is what the page would say of a view with nothing in it, had it not been the person's own doing.
    expect(await file.ask<string | null>('window.__tornoExport.undrawn()')).toBe('a frame was drawn, and nothing of the parts is in it')
    await file.ask('window.__tornoExport.setPart("tub", true); window.__tornoExport.setPart("lid", true)')
    // Exploded, the lid is drawn somewhere else; a section puts the parts together again.
    const home = (await file.pageState()).camera
    await file.ask('window.__tornoExport.setExplode(1, "z")')
    const apart = await file.pageState()
    expect(apart.parts.find((p) => p.name === 'lid')!.offset[2]).toBeGreaterThan(1)
    // The lid would be out of sight above: the parts are framed anew, as in torno.
    expect(apart.camera.position).not.toEqual(home.position)
    expect(await file.ask<string>('document.getElementById("said").textContent')).toBe('Parts drawn apart for display')
    await file.ask('window.__tornoExport.setSection("z", 0.5)')
    const cut = await file.pageState()
    expect(cut.explode.amount).toBe(0)
    expect(cut.section).toEqual({ origin: [0, 0, 20], normal: [0, 0, 1] })
    expect(cut.parts.every((p) => p.offset.every((c) => c === 0))).toBe(true)
    expect(await file.ask<string>('document.getElementById("said").textContent')).toBe('Cut open for display')
    // Together again, the camera is back where it was before the parts were framed apart: nobody moved it since.
    for (let i = 0; i < 3; i++) expect(cut.camera.position[i]).toBeCloseTo(home.position[i], 6)
    expect(cut.camera.zoom).toBeCloseTo(home.zoom, 9)
    // "Fit" frames them as they are together.
    await file.ask('[...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Fit").click()')
    // Cut at half its height, the lid is in the half taken away, and the tub is open: its inside is drawn, in another tone than its outside.
    const inside = await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')
    expect(inside.slice(0, 3)).not.toEqual(ground)
    // And apart again, the section is gone: never both.
    await file.ask('window.__tornoExport.setExplode(0.4)')
    expect((await file.pageState()).section).toBeNull()
    // The view the person saved: its explode, and its name on the chip that is pressed.
    expect(await file.ask<boolean>('window.__tornoExport.applyView("Lid off")')).toBe(true)
    expect(await file.pageState()).toMatchObject({ view: 'Lid off', explode: { amount: 0.5, axis: 'z' }, section: null })
    expect(await file.ask<string | null>('document.querySelector(".viewchip[aria-pressed=true]")?.textContent ?? null')).toBe('Lid off')
    expect(await file.ask<boolean>('window.__tornoExport.applyView("Agent idea")')).toBe(false)
    // It looks from the side the view was saved from. Where it was saved the lid, drawn apart, would now be out of
    // sight (along z the parts go up from the lowest): the page frames the parts anew, without turning (re-review m5).
    const saved = (await file.pageState()).camera
    expect(saved.ortho).toBe(false)
    expect((await file.pageState()).leaves).toBe(false)
    const way = (camera: { position: number[]; target: number[] }): number[] => {
      const d = camera.position.map((c, i) => c - camera.target[i])
      const length = Math.hypot(...d)
      return d.map((c) => c / length)
    }
    way(saved).forEach((c, i) => expect(c).toBeCloseTo(way({ position: [120, -90, 60], target: [0, 0, 19] })[i], 6))
    // The view takes the keys when it has the focus: the arrows turn it about what it looks at.
    await file.ask('document.getElementById("view").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))')
    const turned = (await file.pageState()).camera
    turned.target.forEach((c, i) => expect(c).toBeCloseTo(saved.target[i], 6))
    expect(turned.position[0]).not.toBeCloseTo(120, 1)
    const reach = (camera: { position: number[]; target: number[] }): number => Math.hypot(...camera.position.map((c, i) => c - camera.target[i]))
    expect(reach(turned)).toBeCloseTo(reach(saved), 3)
    // The theme is the system's until one is chosen by hand in the footer, and the system's again when asked.
    expect(await file.pageState()).toMatchObject({ themeChoice: 'system' })
    expect(await file.ask<string[]>('[...document.querySelectorAll("#foot .themes button")].map((b) => b.textContent + ":" + b.getAttribute("aria-pressed"))')).toEqual(['System:true', 'Light:false', 'Dark:false'])
    await file.ask('document.querySelector("#foot .themes button[data-theme=dark]").click()')
    expect(await file.pageState()).toMatchObject({ theme: 'dark', themeChoice: 'dark' })
    const night = await file.ask<number[]>('window.__tornoExport.ground()')
    await file.ask('window.__tornoExport.setTheme("light")')
    expect(await file.pageState()).toMatchObject({ theme: 'light', themeChoice: 'light' })
    expect(await file.ask<number[]>('window.__tornoExport.ground()')).not.toEqual(night)
    await file.ask('window.__tornoExport.setTheme("system")')
    expect(await file.pageState()).toMatchObject({ themeChoice: 'system' })
    expect(await file.ask<string | null>('document.documentElement.getAttribute("data-theme")')).toBeNull()
    // A slider is read out as what it is.
    expect(await file.ask<string>('document.querySelector("[data-k=explode]").getAttribute("aria-valuetext")')).toBe('50 %')
    // An inline handler, were one ever written into the page, would not run: the policy names the one script by its hash.
    expect(await file.ask<unknown>('(() => { const b = document.createElement("button"); b.setAttribute("onclick", "window.__handled = 1"); document.body.append(b); b.click(); b.remove(); return window.__handled })()')).toBeUndefined()
    const added = await file.ask<unknown>('new Promise((done) => { const s = document.createElement("script"); s.textContent = "window.__added = 1"; document.body.append(s); setTimeout(() => done(window.__added), 50) })')
    expect(added).toBeUndefined()
    // Every control is a native one the keyboard reaches, and each has a name.
    expect(await file.ask<number>('[...document.querySelectorAll("#panel button, #panel input")].filter((c) => c.tabIndex < 0 || !(c.textContent || c.getAttribute("aria-label") || c.closest("label")?.textContent)).length')).toBe(0)
    expect(await file.ask<number>('document.getElementById("view").tabIndex')).toBe(0)
    // What it is, and what it is not, in its footer.
    expect(await file.ask<string>('document.querySelector("#foot .made").textContent')).toMatch(/^Made with torno · hollow · r1 · \d{1,2} \w{3} \d{4}$/)
    expect(await file.ask<string>('document.querySelector("#foot details").textContent')).toContain('Nothing on this page is measured from it')
    // Its own policy refuses a request before one is made, and evaluating text as code.
    expect(await file.ask<string>('fetch("https://example.invalid/x").then(() => "fetched", () => "refused")')).toBe('refused')
    expect(await file.ask<string>('(() => { try { return String(eval("1 + 1")) } catch (e) { return "refused" } })()')).toBe('refused')
    // It asked for nothing but itself.
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
})

test('marks are in the file only when ticked, as torno measured them, and a note is text whatever it holds', async () => {
  const out = join(outDir, 'with-marks')                     // the dialog answered without the ending
  await setSave(out)
  await sheet().getByRole('checkbox', { name: /Include marks and their notes/ }).check()
  await expect(sheet().getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${out}.html`)).toBeVisible()
  expect(readdirSync(outDir).sort()).toEqual(['hollow.html', 'with-marks.html'])
  const html = readFileSync(`${out}.html`, 'utf8')
  expectNothingOfHere(html)
  expect(html).toContain('lid sits proud')
  // The page has its two scripts and no more, whatever the note says.
  expect(html.match(/<script/gi)).toHaveLength(2)
  expect(html.match(/<\/script/gi)).toHaveLength(2)

  const file = await openExport(`${out}.html`)
  try {
    await file.ready()
    // The draft goes with the marks; the resolved one was not ticked, and is nowhere in the file.
    expect(await file.pageState()).toMatchObject({ marks: true, labels: ['M1', 'M2', 'M4'] })
    // Final fix wave: a mark's lines are drawn over the canvas, each over a casing in the panel's colour, 2 px wider, so that they read on any part.
    const lines = await file.ask<Array<{ name: string; mark: string; width: string; stroke: string; points: number }>>(
      `[...document.querySelectorAll('#overlay svg.mark-lines polyline')].map((line) => ({ name: line.getAttribute('class'), mark: line.dataset.mark, width: getComputedStyle(line).strokeWidth, stroke: getComputedStyle(line).stroke, points: (line.getAttribute('points') || '').trim().split(' ').filter(Boolean).length }))`
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length % 2).toBe(0)
    for (let i = 0; i < lines.length; i += 2) {
      expect([lines[i].name, lines[i + 1].name, lines[i].mark === lines[i + 1].mark]).toEqual(['mark-casing', 'mark-line', true])
      expect(parseFloat(lines[i].width) - parseFloat(lines[i + 1].width)).toBe(2)
      expect(lines[i].stroke).not.toBe(lines[i + 1].stroke)
      expect(lines[i].points).toBeGreaterThanOrEqual(2)
    }
    expect(html).toContain('not sent yet')
    expect(html).not.toContain('settled long ago')
    // The note is there to read, and is nothing but text.
    expect(await file.ask<string>('document.querySelector(".mark .note").textContent')).toBe(HOSTILE)
    expect(await file.ask<number>('document.querySelectorAll("#panel img, #overlay img, script").length')).toBe(2)
    expect(await file.ask<unknown>('window.__pwned')).toBeUndefined()
    // The dimension says what torno measured on the build exported, and that the page measured nothing.
    const row = await file.ask<string>('[...document.querySelectorAll(".mark")].find((m) => m.textContent.startsWith("M2")).textContent')
    expect(row).toContain('40 mm')
    expect(row).toContain('✓ passes')
    expect(row).toContain('should be 40 ± 0.05 mm')
    expect(await file.ask<string>('document.getElementById("panel").textContent')).toMatch(/A value is as torno measured it on the exact geometry of r1, exported \d{1,2} \w{3} \d{4}\. This page measures nothing\./)
    expect(await file.ask<string>('document.querySelector(".chip[data-mark=M2]").textContent')).toBe('M240 mm✓')
    // Drawn apart, a mark goes with its part; with its part switched off it is not drawn.
    await file.ask('window.__tornoExport.setPart("lid", false)')
    expect((await file.pageState()).labels).toEqual(['M2', 'M4'])
    // A dimension's line has an end at each of its points, and its label does not lie on another.
    expect(await file.ask<number>('document.querySelectorAll("#overlay .dot").length')).toBe(3)
    const boxes = await file.ask<Array<{ x: number; y: number; w: number; h: number }>>('[...document.querySelectorAll("#overlay .chip:not([hidden])")].map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })')
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
    await file.ask('window.__tornoExport.setMarks(false)')
    expect((await file.pageState()).labels).toEqual([])
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
})

test('a cancelled dialog writes nothing, and a folder that is not there is said, not made', async () => {
  await setSave(null)
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(sheet().getByText('Nothing was saved')).toBeVisible()
  // A name without its ending that would land on a file the dialog never asked about: torno asks, and a no keeps the file.
  const was = readFileSync(join(outDir, 'hollow.html'), 'utf8')
  await setSave(join(outDir, 'hollow'))
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(sheet().getByText('Nothing was saved')).toBeVisible()
  expect((await hooks()).replaceAsked).toBe(1)
  expect(readFileSync(join(outDir, 'hollow.html'), 'utf8')).toBe(was)
  await app.evaluate(() => void ((globalThis as unknown as { __tornoMain: { replace: boolean } }).__tornoMain.replace = true))
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${join(outDir, 'hollow.html')}`)).toBeVisible()
  expect((await hooks()).replaceAsked).toBe(2)
  expect(readFileSync(join(outDir, 'hollow.html'), 'utf8')).not.toBe(was)
  await setSave(join(outDir, 'not', 'there', 'x.html'))
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(sheet()).toContainText('ENOENT')
  expect(readdirSync(outDir).sort()).toEqual(['hollow.html', 'with-marks.html'])
  expect(readdirSync(join(root, 'hollow', '.torno', 'exports'))).toEqual([])
  // Escape puts the sheet away, and the view under it is as it was.
  await page.keyboard.press('Escape')
  await expect(sheet()).toHaveCount(0)
  expect((await state()).page).toBe('object')
})

test('several objects go into one file from the page of objects, each unpacked when it is first shown', async () => {
  await open('bracket')
  await page.getByRole('button', { name: 'All objects' }).click()
  await expect.poll(async () => (await state()).page).toBe('objects')
  const out = join(outDir, 'both.html')
  await setSave(out)
  await page.getByRole('button', { name: 'Export…' }).click()
  // Every object with a build of this run is ticked; the others say what would make them exportable.
  await expect(sheet().getByRole('checkbox', { name: /^bracket/ })).toBeChecked()
  await expect(sheet().getByRole('checkbox', { name: /^hollow/ })).toBeChecked()
  await expect(sheet().getByRole('checkbox')).toHaveCount(4)
  await expect(sheet().locator('.export-cannot')).toContainText('plain')
  await expect(sheet().locator('.export-cannot')).not.toContainText('hollow')
  await expect(sheet()).toContainText('about')
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
  // For several, the name the dialog would have offered is the workspace's.
  expect((await hooks()).saveOffered).toBe(join(root, 'bracket', '.torno', 'exports', `${root.split('/').pop()}.html`))
  const html = readFileSync(out, 'utf8')
  expectNothingOfHere(html.replaceAll(root.split('/').pop()!, ''))
  expect(html).not.toContain(root)

  const file = await openExport(out)
  try {
    await file.ready()
    expect((await file.pageState()).object).toBe('bracket')
    expect(await file.ask<string[]>('[...document.querySelectorAll(".objects .object .name")].map((n) => n.textContent)')).toEqual(['bracket', 'hollow'])
    // The other layout of the first.
    await file.ask('window.__tornoExport.setLayout("print")')
    expect((await file.pageState()).layout).toBe('print')
    const ground = await file.ask<number[]>('window.__tornoExport.ground()')
    // The second is unpacked when it is asked for, and drawn.
    await file.ask('window.__tornoExport.setObject("hollow")')
    expect(await file.pageState()).toMatchObject({ object: 'hollow', layout: 'assembly', parts: [{ name: 'tub' }, { name: 'lid' }] })
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')).slice(0, 3)).not.toEqual(ground)
    expect(await file.ask<string>('document.querySelector("#foot .made").textContent')).toContain('· hollow ·')
    // And by its button in the list, back to the first, as it was left.
    await file.ask('[...document.querySelectorAll(".objects .object")][0].click()')
    await expect.poll(async () => (await file.pageState()).object).toBe('bracket')
    expect((await file.pageState()).layout).toBe('print')
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
  await page.keyboard.press('Escape')
})

test('a scan is in the file only when ticked, without where it came from, and the page says what it is', async () => {
  await open('hollow')
  // A plate under the tub, imported from a folder of this machine and placed in the assembly.
  const source = join(outDir, 'garage-scan.stl')
  writeFileSync(source, stl(box([120, 120, 2], [0, 0, -3])))
  await page.evaluate((path) => window.torno.scans.import('hollow', path), source)
  await app.evaluate(() => (globalThis as unknown as { __tornoMain: { scans: { align(...args: unknown[]): Promise<unknown> } } }).__tornoMain.scans.align('hollow', 'S1', 'assembly', { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { tub: [0, 0, 0], lid: [0, 0, 0] }, at: new Date().toISOString() }))
  await page.getByRole('button', { name: 'Export…' }).click()
  // It is offered, with what a scan may show, and is not ticked.
  await expect(sheet()).toContainText(SCAN_WARNING)
  const tick = sheet().getByRole('checkbox', { name: /S1 garage-scan\.stl/ })
  await expect(tick).not.toBeChecked()
  const without = join(outDir, 'no-scan.html')
  await setSave(without)
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${without}`)).toBeVisible()
  const bare = readFileSync(without, 'utf8')
  for (const kept of ['garage-scan', 'reducedFrom']) expect(bare).not.toContain(kept)
  expect(dataOf(bare).objects[0].scans).toBeUndefined()
  // Ticked, it is in the file by its number and its name, and nothing says where it was read from.
  await tick.check()
  const out = join(outDir, 'scan.html')
  await setSave(out)
  await expect(sheet().getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
  const html = readFileSync(out, 'utf8')
  expect(dataOf(html).objects[0].scans).toMatchObject([{ id: 'S1', name: 'garage-scan.stl', triangles: 12, reducedFrom: 12, colours: false, placed: { assembly: { t: [0, 0, 0], s: 1 } } }])
  expectNothingOfHere(html)
  for (const kept of ['sha256', 'mtimeMs', '"source"']) expect(JSON.stringify(dataOf(html))).not.toContain(kept)

  const file = await openExport(out)
  try {
    await file.ready()
    expect((await file.pageState()).scans).toEqual([{ id: 'S1', visible: true, opacity: 1 }])
    expect(await file.ask<string>('document.getElementById("panel").textContent')).toContain('A scan here is a reduced copy, and nothing of it is exact.')
    const ground = await file.ask<number[]>('window.__tornoExport.ground()')
    // With the parts away, the plate is what is drawn; switched off, nothing is.
    await file.ask('window.__tornoExport.setPart("tub", false); window.__tornoExport.setPart("lid", false)')
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.5, 0.6)')).slice(0, 3)).not.toEqual(ground)
    await file.ask('document.querySelector("[data-k=\\"scan:S1\\"]").click()')
    expect((await file.pageState()).scans).toEqual([{ id: 'S1', visible: false, opacity: 1 }])
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.5, 0.6)')).slice(0, 3)).toEqual(ground)
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
  await page.keyboard.press('Escape')
})

test('a part switched off and a mark that is resolved stay here unless they are ticked', async () => {
  // The lid is switched off in torno.
  await page.locator('[data-region="left"]').getByRole('button', { name: 'Show lid' }).click()
  await page.getByRole('button', { name: 'Export…' }).click()
  await expect(sheet()).toContainText('r1 · 1 part ·')
  await expect(sheet()).toContainText('1 part is switched off here: left out of the file, with the marks on it')
  // By its bytes: what is said of it is to a tenth of a megabyte, which a lid of twelve triangles does not move.
  const size = (): Promise<string | null> => sheet().locator('.export-size').getAttribute('data-bytes')
  const bare = await size()
  expect(Number(bare)).toBeGreaterThan(100_000)
  const out = join(outDir, 'tub-only.html')
  await setSave(out)
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
  const only = dataOf(readFileSync(out, 'utf8')).objects[0]
  expect(only.parts.map((p) => p.name)).toEqual(['tub'])
  expect(Object.keys(only.meshes)).toHaveLength(1)
  // Ticked, it goes, switched off; and the resolved mark with the marks. What the sheet says follows each tick.
  await sheet().getByRole('checkbox', { name: /Include parts that are switched off/ }).check()
  await expect(sheet()).toContainText('r1 · 2 parts ·')
  await expect(sheet()).toContainText('in the file, switched off, for whoever opens it to switch on')
  await sheet().getByRole('checkbox', { name: /Include marks and their notes/ }).check()
  await sheet().getByRole('checkbox', { name: /Include resolved marks/ }).check()
  await expect(sheet()).toContainText('3 marks and 1 dimension')
  await expect(sheet()).toContainText('1 resolved mark, with its note: in the file')
  await expect.poll(size).not.toBe(bare)
  const all = join(outDir, 'all.html')
  await setSave(all)
  await expect(sheet().getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await sheet().getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText(`Saved to ${all}`)).toBeVisible()
  const whole = dataOf(readFileSync(all, 'utf8')).objects[0]
  expect(whole.parts.map((p) => [p.name, p.visible])).toEqual([['tub', true], ['lid', false]])
  expect(whole.marks!.map((m) => [m.id, m.status])).toEqual([['M1', 'sent'], ['M2', 'sent'], ['M3', 'resolved'], ['M4', 'draft']])

  const file = await openExport(all)
  try {
    await file.ready()
    expect((await file.pageState()).parts).toMatchObject([{ name: 'tub', visible: true }, { name: 'lid', visible: false }])
    // The resolved mark is in the list, said to be resolved; on the part it is labelled only when asked.
    expect(await file.pageState()).toMatchObject({ labels: ['M2', 'M4'], resolved: false })
    expect(await file.ask<string>('[...document.querySelectorAll(".mark")].find((m) => m.textContent.startsWith("M3")).textContent')).toContain('resolved')
    await file.ask('window.__tornoExport.setPart("lid", true); document.querySelector("[data-k=resolved]").click()')
    expect(await file.pageState()).toMatchObject({ labels: ['M1', 'M2', 'M3', 'M4'], resolved: true })
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
  await page.keyboard.press('Escape')
  await page.locator('[data-region="left"]').getByRole('button', { name: 'Show lid' }).click()
})

test('parts named like what every object has are parts like any other, and a file that cannot be unpacked says so', async () => {
  const html = readFileSync(join(outDir, 'all.html'), 'utf8')
  const data = dataOf(html)
  // As a model might name them: the data is the file's own, and the page must not trip on it.
  const renamed = JSON.stringify(data).replace(/</g, '\\u003c').replaceAll('"tub"', '"constructor"').replaceAll('"lid"', '"__proto__"').replaceAll('"assembly"', '"toString"')
  const withData = (json: string): string => html.replace(/(<script type="application\/json" id="torno-data">)(.*?)(<\/script>)/s, (_all, open: string, _was: string, close: string) => `${open}${json}${close}`)
  const odd = join(outDir, 'odd-names.html')
  writeFileSync(odd, withData(renamed))
  const file = await openExport(odd)
  try {
    await file.ready()
    expect(await file.pageState()).toMatchObject({ layout: 'toString', parts: [{ name: 'constructor', visible: true, offset: [0, 0, 0] }, { name: '__proto__', visible: false, offset: [0, 0, 0] }] })
    const ground = await file.ask<number[]>('window.__tornoExport.ground()')
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')).slice(0, 3)).not.toEqual(ground)
    await file.ask('window.__tornoExport.setPart("__proto__", true); window.__tornoExport.setExplode(1, "z")')
    const apart = await file.pageState()
    expect(apart.parts.find((p) => p.name === '__proto__')!.offset[2]).toBeGreaterThan(1)
    // Along z upward from the lowest part, which stays where it is: nothing is drawn under the ground.
    expect(apart.parts.find((p) => p.name === 'constructor')!.offset[2]).toBe(0)
    expect(apart.labels).toEqual(['M1', 'M2', 'M4'])
    // Drawn apart, no part is out of the view: the page frames them anew when one would be (re-review m5), by torno's own rule.
    expect(apart.leaves).toBe(false)
    await file.ask('window.__tornoExport.setExplode(1, "z")')
    expect((await file.pageState()).leaves).toBe(false)
    expect(await file.ask<string>('document.getElementById("said").textContent')).toBe('Parts drawn apart for display')
    expect(await file.ask<string[]>('[...document.querySelectorAll(".parts .name")].map((n) => n.textContent)')).toEqual(['constructor', '__proto__'])
  } finally {
    await file.close()
  }
  // A mesh that is not what its header says: the page says what is wrong, and does not go on saying it is unpacking.
  const broken = join(outDir, 'broken.html')
  const [hash] = Object.keys(data.objects[0].meshes)
  data.objects[0].meshes[hash].vertices += 1
  writeFileSync(broken, withData(JSON.stringify(data).replace(/</g, '\\u003c')))
  const bad = await openExport(broken)
  try {
    await expect.poll(() => bad.ask<string>('document.getElementById("said")?.textContent ?? ""')).toMatch(/^The parts of hollow could not be shown: \d+ bytes were expected, \d+ came$/)
    expect(await bad.ask<boolean>('document.getElementById("said").hidden')).toBe(false)
    // What it said stays said: the look at the canvas that would have followed the unpacking says nothing over it.
    const why = await bad.ask<string>('document.getElementById("said").textContent')
    await new Promise((r) => setTimeout(r, 3400))
    expect(await bad.ask<string>('document.getElementById("said").textContent')).toBe(why)
  } finally {
    await bad.close()
  }
})

test('one object is exported from its card on the page of objects', async () => {
  await page.getByRole('button', { name: 'All objects' }).click()
  await expect.poll(async () => (await state()).page).toBe('objects')
  // Only an object with a build of this run has the action; it is there for the keyboard as for the pointer.
  await expect(page.getByRole('button', { name: 'Export plain to one HTML file' })).toHaveCount(0)
  await page.locator('.card[data-object="hollow"]').hover()
  await page.getByRole('button', { name: 'Export hollow to one HTML file' }).click()
  await expect(sheet().getByRole('checkbox', { name: /^hollow/ })).toBeChecked()
  await expect(sheet().getByRole('checkbox', { name: /^bracket/ })).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(sheet()).toHaveCount(0)
  expect((await state()).page).toBe('objects')
})

// Seen in headless Firefox: the controls and the labels, no parts, and not a word. The page looks at its canvas
// three seconds after it began to unpack an object, and says so when nothing of the parts is on it.
test('a page whose parts cannot be drawn says so in place of them, and says nothing while they can', async () => {
  const file = await openExport(join(outDir, 'both.html'))
  try {
    await file.ready()
    // Looked at, and found drawn: nothing is said.
    await new Promise((r) => setTimeout(r, 3400))
    expect(await file.ask<boolean>('document.getElementById("said").hidden')).toBe(true)
    // The browser takes the page's 3D drawing away, as a driver that fails does; then another object is asked for.
    await file.ask('document.getElementById("view").getContext("webgl2").getExtension("WEBGL_lose_context").loseContext()')
    await file.ask('window.__tornoExport.setObject("hollow")')
    await expect
      .poll(() => file.ask<string>('document.getElementById("said").textContent'), { timeout: 8000 })
      .toBe('The parts cannot be drawn here: the browser took its 3D drawing away from this page. Open the file in a current Chrome, Edge, Firefox or Safari, with hardware acceleration switched on.')
    expect(await file.ask<boolean>('document.getElementById("said").hidden')).toBe(false)
  } finally {
    await file.close()
  }
})

test('a browser that gives the page no WebGL is told so in words, and nothing breaks', async () => {
  const file = await openExport(join(outDir, 'hollow.html'), app, [900, 700], false)
  try {
    await expect.poll(() => file.ask<string | null>('document.querySelector(".message")?.textContent ?? null')).toMatch(/^This browser cannot draw the parts here: it gives the page no WebGL 2\./)
    // The message alone: no empty column of controls beside it.
    expect(await file.ask<string[]>('["panel", "view", "overlay"].map((id) => getComputedStyle(document.getElementById(id)).display)')).toEqual(['none', 'none', 'none'])
    expect(await file.ask<string>('typeof window.__tornoExport')).toBe('undefined')
    expect(await file.requests()).toEqual([])
  } finally {
    await file.close()
  }
})

// Set TORNO_SHOTS=<dir> to write export-light.png, export-dark.png, export-narrow.png, export-cut.png and
// export-sheet.png there: an exported file of `hollow` with its marks, its saved view applied (the lid drawn
// apart), open in the second hidden window, also 420 px wide with its drawer up, and cut; and the sheet over the view. Each picture needs its own launch: on a hidden window capturePage() delivers one image
// and hangs on the next call, and page.screenshot() never returns.
for (const shot of ['light', 'dark', 'narrow', 'cut', 'sheet'] as const) {
  test(`screenshot of an exported page, ${shot}`, async () => {
    const dir = process.env.TORNO_SHOTS
    test.skip(!dir, 'TORNO_SHOTS is not set')
    test.setTimeout(120_000)
    mkdirSync(dir!, { recursive: true })
    const shotRoot = workspace('torno-e2e-export-shot-')
    const shotOut = mkdtempSync(join(realpathSync(tmpdir()), 'torno-export-shot-out-'))
    const shotApp = await launch(shotRoot)
    try {
      const shotPage = await shotApp.firstWindow()
      await shotPage.waitForSelector('[data-region="left"]')
      await shotPage.emulateMedia({ colorScheme: 'light' })
      await open('hollow', shotPage)
      await expect.poll(async () => ((await shotPage.evaluate(() => window.torno.marks.list('hollow'))) as Mark[]).find((m) => m.id === 'M2')).toMatchObject({ measuredRevision: 1 })
      // A mark of the agent's beside the person's two.
      await shotApp.evaluate(
        (_e, c) => (globalThis as unknown as { __tornoMain: { marks: { add(id: string, mark: unknown): Promise<unknown> } } }).__tornoMain.marks.add('hollow', { kind: 'pin', author: 'agent', note: 'The post could be 2 mm shorter', layout: 'assembly', revision: 1, camera: c, anchor: { point: [20, 5, 30], normal: [1, 0, 0], part: 'tub' } }),
        camera
      )
      const out = join(shotOut, 'hollow.html')
      await setSave(out, shotApp)
      await shotPage.getByRole('button', { name: 'Export…' }).click()
      await shotPage.getByRole('dialog', { name: 'Export' }).getByRole('checkbox', { name: /Include marks and their notes/ }).check()
      await expect(shotPage.getByRole('dialog', { name: 'Export' })).toContainText('about')
      if (shot === 'sheet') {
        await shotPage.waitForTimeout(600)
        const png = await shotApp.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
        writeFileSync(join(dir!, 'export-sheet.png'), Buffer.from(png, 'base64'))
        return
      }
      await shotPage.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export', exact: true }).click()
      await expect(shotPage.getByText(`Saved to ${out}`)).toBeVisible()
      expect(existsSync(out)).toBe(true)
      const file = await openExport(out, shotApp, shot === 'narrow' ? [420, 760] : [1280, 800])
      await file.ready()
      if (shot === 'dark') await file.ask('window.__tornoExport.setTheme("dark")')
      else await file.ask('window.__tornoExport.setTheme("light")')
      await file.ask('window.__tornoExport.applyView("Lid off")')
      if (shot === 'cut') await file.ask('window.__tornoExport.setSection("y", 0.45)')
      if (shot === 'narrow') await file.ask('document.getElementById("drawer").click()')
      await file.ask('window.__tornoExport.pixel(0.5, 0.5)')
      // What was set is on the glass before the one picture is taken.
      await file.ask('new Promise((done) => { setTimeout(done, 1500); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200))) })')
      writeFileSync(join(dir!, `export-${shot}.png`), Buffer.from(await file.capture(), 'base64'))
      // The file itself, to look at by hand.
      writeFileSync(join(dir!, 'hollow.html'), readFileSync(out))
    } finally {
      await shotApp.close()
      rmSync(shotRoot, { recursive: true, force: true })
      rmSync(shotOut, { recursive: true, force: true })
    }
  })
}

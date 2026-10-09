import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { LookRequest, ViewState } from '../src/shared/view'
import { box, stl } from '../src/test/scanFixtures'
import type { ScanLayerState } from '../src/renderer/viewport/scans'

// A scan on screen: imported from the panel with the real import process, drawn with the parts, switched and
// thinned from its row, cut open by the section, named in pictures, and kept in scene.json as it was looked at.
//
// The window is hidden. Pictures come from window.__tornoTest.look; nothing here is the owner's scan.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

function copyFixtures(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-scan-'))
  cpSync(fixtures, dir, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  return dir
}

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
function launch(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, ...env } })
}

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (p: Page = page): Promise<TornoState> => p.evaluate(() => window.__tornoTest!.state())

async function open(name: string, p: Page = page): Promise<void> {
  await p.getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => ((await state(p)).objectId === name ? (await state(p)).build?.status : null), { timeout: 90_000 }).toBe('ok')
  await expect.poll(async () => (await state(p)).scene !== null).toBe(true)
}

// A scan made here: a plate 60 × 50 × 2 under the bracket's base, so that every view of the parts has it in frame.
const PLATE = stl(box([60, 50, 2], [0, 0, -10]))
let scanFile: string

const scans = (p: Page = page): Promise<ScanLayerState[]> => p.evaluate(() => window.__tornoTest!.scans())
const row = (id: string, p: Page = page) => p.locator(`.scan-row[data-scan="${id}"]`)
const pickFile = (path: string | null) => app.evaluate((_electron, path) => void ((globalThis as unknown as { __tornoMain: { pickFile: string | null } }).__tornoMain.pickFile = path), path)
const picture = (request: LookRequest, p: Page = page) =>
  p.evaluate(async (request) => {
    const made = await window.__tornoTest!.look(request)
    return { caption: made.caption, sum: made.png.reduce((a, b) => (a * 31 + b) % 1_000_000_007, 7) }
  }, request)
const scansFile = () => JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scans.json'), 'utf8'))

test.beforeAll(async () => {
  root = copyFixtures()
  scanFile = join(root, 'plate under.stl')   // outside every object folder, with a space in its name
  writeFileSync(scanFile, PLATE)
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
})

test('a scan is imported from the panel, drawn, and said in millimetres', async () => {
  await expect(page.getByRole('region', { name: 'Scans' })).toContainText('Drop a scan on the view, or import one.')
  await pickFile(scanFile)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect(row('S1')).toContainText('plate under.stl')
  await expect(row('S1')).toContainText('60 × 50 × 2 mm, from mm, Z up (assumed)')
  await expect(row('S1').locator('.chip[data-state="unaligned"]')).toHaveText('not aligned here')
  await expect.poll(async () => (await scans())[0]).toMatchObject({ id: 'S1', loaded: true, triangles: 12, aligned: false, visible: true, opacity: 1 })
  expect((await state()).scans[0]).toMatchObject({ id: 'S1', sourceState: 'present', meshState: 'ok', source: { path: scanFile } })
  expect(scansFile()).toMatchObject({ next: 2, scans: [{ id: 'S1', source: { path: scanFile, bytes: PLATE.length } }] })
  expect(readFileSync(scanFile).equals(PLATE)).toBe(true)
  // Only .torno was written in the object's folder.
  expect(existsSync(join(root, 'bracket', '.torno', 'scans', 'S1', 'mesh.bin'))).toBe(true)
  expect(await app.evaluate(() => (globalThis as unknown as { __tornoMain: { filePicks: number } }).__tornoMain.filePicks)).toBe(1)
})

test('a picture has the scan unless it is asked without, and says which', async () => {
  const withScan = await picture({ view: 'iso', size: 256 })
  const without = await picture({ view: 'iso', size: 256, scans: false })
  expect(withScan.caption).toContain(' · scans S1 · ')
  expect(without.caption).not.toContain('scans')
  expect(withScan.sum).not.toBe(without.sum)
  await expect(picture({ view: 'iso', size: 256, scans: ['S9'] })).rejects.toThrow('no scan S9; scans: S1')
})

test('opacity and the eye are kept in scene.json as the person set them, and are there again after a restart', async () => {
  await row('S1').getByRole('slider', { name: 'Opacity of S1' }).fill('0.6')
  await expect.poll(async () => (await scans())[0].opacity).toBe(0.6)
  expect((await picture({ view: 'iso', size: 256 })).caption).toContain('scans S1 at 60 %')
  await row('S1').getByRole('button', { name: 'Show S1' }).click()
  await expect.poll(async () => (await scans())[0].visible).toBe(false)
  expect((await picture({ view: 'iso', size: 256 })).caption).not.toContain('scans')
  // The file is written half a second after the last change: until then there may be none.
  const saved = (): unknown => {
    const path = join(root, 'bracket', '.torno', 'scene.json')
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).scans : undefined
  }
  await expect.poll(saved).toEqual({ S1: { visible: false, opacity: 0.6 } })
  await app.close()
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
  await expect.poll(async () => (await scans())[0]).toMatchObject({ id: 'S1', loaded: true, visible: false, opacity: 0.6 })
  await row('S1').getByRole('button', { name: 'Show S1' }).click()
})

test('the section cuts a scan open, and what the view tells main names it', async () => {
  const whole = await picture({ view: 'front', size: 256, section: null })
  const cut = await picture({ view: 'front', size: 256, section: { origin: [0, 0, 0], normal: [0, -1, 0] } })
  expect(cut.sum).not.toBe(whole.sum)
  const view = await app.evaluate(() => (globalThis as unknown as { __tornoMain: { latestView(objectId: string): ViewState | undefined } }).__tornoMain.latestView('bracket'))
  expect(view?.scans).toEqual([{ id: 'S1', visible: true, opacity: 0.6 }])
})

test('a unit that was assumed wrongly is changed on the row, without the source', async () => {
  rmSync(scanFile)
  await page.reload()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
  await expect(row('S1').locator('.chip[data-state="source-missing"]')).toHaveText('source missing')
  await row('S1').getByText('More').click()
  await row('S1').getByRole('combobox', { name: 'Unit of S1' }).selectOption('cm')
  await row('S1').getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1')).toContainText('600 × 500 × 20 mm, from cm, Z up')
  // Both were chosen by pressing Apply: neither is assumed any more.
  await expect.poll(async () => (await state()).scans[0].imported.assumed).toEqual({ unit: false, up: false })
  await expect(row('S1')).not.toContainText('assumed')
})

test('a file that is no scan is said to be none, and a scan is removed with its folder only', async () => {
  const other = join(root, 'part.3mf')
  writeFileSync(other, '')
  await pickFile(other)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect(page.getByRole('region', { name: 'Scans' })).toContainText('part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl')
  await row('S1').getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
  await expect(row('S1')).toHaveCount(0)
  expect(existsSync(join(root, 'bracket', '.torno', 'scans', 'S1'))).toBe(false)
  expect(scansFile()).toMatchObject({ next: 2, scans: [] })
  expect(existsSync(other)).toBe(true)
})

// Beyond the brief's tests.

/** A file dropped on the view, as the page can make one: with a name, and no place on the disk. */
const drop = (name: string, p: Page = page) =>
  p.evaluate((name) => {
    const pane = document.querySelector('.viewport-pane')!
    const box = pane.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['solid'], name))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 80, clientY: box.top + 80 })
    pane.dispatchEvent(over)
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 80, clientY: box.top + 80 }))
    return { taken: over.defaultPrevented, effect: dataTransfer.dropEffect }
  }, name)

test('what is dropped on the view that is no scan, or has no file behind it, is said at the pointer', async () => {
  expect(await drop('notes.txt')).toMatchObject({ taken: true })
  await expect(page.locator('.pick-readout')).toHaveText('torno reads .glb, .gltf, .obj, .ply and .stl scans')
  await drop('Plate.STL')
  await expect(page.locator('.pick-readout')).toHaveText('That file has no place on the disk')
  // A drag of something that is no file is none of the view's.
  const text = await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'lid')
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
    document.querySelector('.viewport-pane')!.dispatchEvent(over)
    return over.defaultPrevented
  })
  expect(text).toBe(false)
  expect((await state()).scans).toEqual([])
})

test('a scan with colours of its own is drawn in them, or plain, as its row says', async () => {
  // The plate again, each corner in a colour: an ASCII PLY, as a scanner's app writes one.
  const { vertices, triangles } = box([60, 50, 2], [0, 0, -10])
  const lines = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 12', 'property list uchar int vertex_indices', 'end_header']
  for (let v = 0; v < 8; v++) lines.push(`${vertices.slice(3 * v, 3 * v + 3).join(' ')} ${v % 2 ? 200 : 40} ${v % 4 < 2 ? 180 : 60} ${v < 4 ? 160 : 30}`)
  for (let t = 0; t < 12; t++) lines.push(`3 ${triangles.slice(3 * t, 3 * t + 3).join(' ')}`)
  const coloured = join(root, 'plate.ply')
  writeFileSync(coloured, `${lines.join('\n')}\n`)

  await pickFile(coloured)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect(row('S2')).toContainText('plate.ply')
  await expect.poll(async () => (await scans())[0]).toMatchObject({ id: 'S2', loaded: true, triangles: 12 })
  expect((await state()).scans[0].imported.colours).toBe('vertex')
  await row('S2').getByText('More').click()
  await expect(row('S2').getByRole('button', { name: 'Own colours' })).toHaveAttribute('aria-pressed', 'true')
  const own = await picture({ view: 'bottom', size: 256, marks: false })
  await row('S2').getByRole('button', { name: 'Plain' }).click()
  await expect(row('S2').getByRole('button', { name: 'Plain' })).toHaveAttribute('aria-pressed', 'true')
  const plain = await picture({ view: 'bottom', size: 256, marks: false })
  expect(plain.sum).not.toBe(own.sum)
  await expect.poll(() => JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scene.json'), 'utf8')).scans.S2).toEqual({ colour: 'plain' })
})

test('a scan whose mesh is gone says so, is not drawn, and has its source read again as a new scan', async () => {
  rmSync(join(root, 'bracket', '.torno', 'scans', 'S2', 'mesh.bin'))
  await page.reload()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
  await expect(row('S2').locator('.chip[data-state="mesh-missing"]')).toHaveText('mesh missing')
  expect((await scans())[0]).toMatchObject({ id: 'S2', loaded: false })
  expect((await picture({ view: 'iso', size: 256 })).caption).not.toContain('scans')
  await row('S2').getByText('More').click()
  await row('S2').getByRole('button', { name: 'Import again' }).click()
  await expect(row('S3')).toContainText('plate.ply')
  await expect.poll(async () => (await scans())[1]).toMatchObject({ id: 'S3', loaded: true })
  expect((await picture({ view: 'iso', size: 256 })).caption).toContain(' · scans S3 · ')
})

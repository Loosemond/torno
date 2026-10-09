import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'
import type { Anchor, Mark, MarksFile, PinMark } from '../src/shared/marks'

// Marks across rebuilds (review focus 1): a mark stays at its point; after every
// build its ref is that of the face now there, and it says so when the surface
// moved away or its part is gone.
//
// The model is the fixture `morph`, which builds what `variant.txt` beside it
// says: `a`, a plate 5 mm thick with a post on it; `b`, the plate 8 mm thick,
// its top 3 mm higher and chamfered, and no post. The marks are added through
// window.torno.marks at what window.__tornoTest.pickAt finds under a point of
// the canvas, so that nothing here depends on the tools that place them.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-reanchor-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

type Vec3 = [number, number, number]
const ON_TOP: Vec3 = [14, 9, 2.5] // on the top of the plate of variant a, clear of the post
const ON_POST: Vec3 = [0, 0, 22.5] // the middle of the top of the post

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const marks = (): Promise<PinMark[]> => page.evaluate(() => window.torno.marks.list('morph')) as Promise<PinMark[]>
const marksOnDisk = (): MarksFile => JSON.parse(readFileSync(join(root, 'morph', '.torno', 'marks.json'), 'utf8'))
const row = (id: string) => page.locator(`.mark-row[data-mark="${id}"]`)
const describe = (ref: string) => page.evaluate((r) => window.torno.geometry.describe('morph', 'main', r), ref)

/** Build the other variant, and wait for the marks to have been checked against it. */
async function switchTo(variant: 'a' | 'b', revision: number, states: Array<Mark['anchorState']>): Promise<void> {
  writeFileSync(join(root, 'morph', 'variant.txt'), `${variant}\n`)
  await expect.poll(async () => (await state()).build, { timeout: 30_000 }).toMatchObject({ status: 'ok', revision, stale: false })
  await expect.poll(async () => (await marks()).map((m) => m.anchorState), { timeout: 15_000 }).toEqual(states)
}

/** A pin of the person's where the part is drawn at `point`: what is under it there is its anchor. */
async function pinAt(point: Vec3, note: string): Promise<PinMark> {
  const added = await page.evaluate(
    ([at, text]) => {
      const hooks = window.__tornoTest!
      const [fx, fy] = hooks.project(at)
      const hit = hooks.pickAt(fx, fy)
      if (!hit) throw new Error(`nothing is drawn at ${at.join(', ')}`)
      const anchor = { point: hit.point, part: hit.part, ref: hit.ref, ...(hit.normal ? { normal: hit.normal } : {}) }
      const { layout, revision } = hooks.state()
      return window.torno.marks.add('morph', { kind: 'pin', author: 'user', note: text, layout, revision, camera: hooks.camera(), anchor })
    },
    [point, note] as const
  )
  return added as PinMark
}

/** The colour an element is drawn in, and the colour a token of the design stands for, both as the browser computes them. */
function colours(selector: string, token: string): Promise<{ drawn: string; token: string }> {
  return page.evaluate(
    ([sel, name]) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return { drawn: getComputedStyle(document.querySelector(sel)!).color, token: colour }
    },
    [selector, token] as const
  )
}

let placed: { top: Anchor; post: Anchor }

test('pins on the top of the plate and on the post are on those faces', async () => {
  await page.getByRole('button', { name: 'morph', exact: true }).click()
  await expect.poll(async () => (await state()).build, { timeout: 30_000 }).toMatchObject({ status: 'ok', revision: 1 })
  expect((await state()).layout).toBe('main')

  const top = await pinAt(ON_TOP, 'too thin here')
  const post = await pinAt(ON_POST, 'shorten the post')
  expect([top.id, post.id]).toEqual(['M1', 'M2'])
  expect(top.anchor.part).toBe('plate')
  expect(top.anchor.ref).toMatch(/^plate\/F\d+$/)
  expect(top.anchor.point[2]).toBeCloseTo(2.5, 3)
  expect(post.anchor.part).toBe('post')
  expect(post.anchor.ref).toMatch(/^post\/F\d+$/)
  expect(post.anchor.point[2]).toBeCloseTo(22.5, 3)
  placed = { top: top.anchor, post: post.anchor }

  expect((await marks()).map((m) => m.anchorState)).toEqual(['ok', 'ok'])
  await expect(page.locator('.mark-row .mark-chip')).toHaveText(['M1', 'M2'])
  await expect(page.locator('.mark-anchor')).toHaveCount(0)
})

test('rebuilt thicker and without its post: the first pin has drifted onto the face now there, the second is orphaned, and both rows say so', async () => {
  await switchTo('b', 2, ['drifted', 'orphaned'])
  const [top, post] = await marks()

  // The pin is where the person put it, 3 mm under the top the plate now has.
  expect(top.anchor.point).toEqual(placed.top.point)
  expect(top.anchor.part).toBe('plate')
  expect(top.anchor.ref).toMatch(/^plate\/F\d+$/)
  expect(top.anchor.normal![2]).toBeCloseTo(1, 6)
  expect(top.anchor.descriptor).toBe('plane, normal +Z, z = 5.5, 1064 mm²')
  // The ref is of this build: asked what that face is, the kernel says the same.
  expect(top.anchor.ref).not.toBe(placed.top.ref)
  expect(await describe(top.anchor.ref!)).toMatchObject({ kind: 'face', type: 'plane', descriptor: top.anchor.descriptor })
  // The face it used to name is not the top of anything any more.
  expect(await describe(placed.top.ref!)).not.toMatchObject({ descriptor: top.anchor.descriptor })

  // The post is gone: its pin is kept as it was, so that it is found again if the post comes back.
  expect(post.anchor).toEqual(placed.post)
  expect((await state()).scene?.parts.map((p) => p.name)).toEqual(['plate'])

  await expect(row('M1').locator('.mark-chip')).toHaveText('M1~')
  await expect(row('M1').locator('.mark-anchor')).toHaveText('moved: check it')
  await expect(row('M2').locator('.mark-chip')).toHaveText('M2?')
  await expect(row('M2').locator('.mark-anchor')).toHaveText('its part is gone')
  const moved = await colours('.mark-row[data-mark="M1"] .mark-anchor', '--warn')
  expect(moved.drawn).toBe(moved.token)
  const gone = await colours('.mark-row[data-mark="M2"] .mark-anchor', '--fail')
  expect(gone.drawn).toBe(gone.token)
  expect(moved.token).not.toBe(gone.token)
  // Either can still be resolved from its row, and keeps its note.
  for (const id of ['M1', 'M2']) await expect(row(id).getByRole('button', { name: `Resolve ${id}` })).toHaveCount(1)
  await expect(page.locator('.mark-row .mark-note')).toHaveText(['too thin here', 'shorten the post'])

  expect(marksOnDisk().marks).toEqual([top, post])
})

test('rebuilt as it was: both pins are ok again, on the faces they were put on', async () => {
  await switchTo('a', 3, ['ok', 'ok'])
  const [top, post] = await marks()
  expect(top.anchor).toMatchObject({ point: placed.top.point, part: 'plate', ref: placed.top.ref, descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' })
  expect(post.anchor).toMatchObject({ point: placed.post.point, part: 'post', ref: placed.post.ref, descriptor: 'plane, normal +Z, z = 22.5, 50.27 mm²' })
  await expect(page.locator('.mark-row .mark-chip')).toHaveText(['M1', 'M2'])
  await expect(page.locator('.mark-anchor')).toHaveCount(0)
  expect(marksOnDisk().marks).toEqual([top, post])
})

test('a resolved mark is left alone by the builds that follow', async () => {
  await row('M2').hover()
  await row('M2').getByRole('button', { name: 'Resolve M2' }).click()
  // Resolved marks are folded away in the panel.
  await expect.poll(async () => (await marks())[1].status).toBe('resolved')
  await expect(row('M2')).toHaveCount(0)
  const before = (await marks())[1]
  await switchTo('b', 4, ['drifted', 'ok'])
  expect((await marks())[1]).toEqual(before)
  await expect(page.locator('.mark-anchor')).toHaveText(['moved: check it'])
})

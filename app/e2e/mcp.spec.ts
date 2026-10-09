import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { describeMark } from '../src/main/marks/describe'
import type { TornoState } from '../src/renderer/state/store'
import type { PinMark } from '../src/shared/marks'
import type { Camera } from '../src/shared/view'

// What the agent is given, through the real path: the SDK's MCP client in this
// process against the app's own server, answered by the window's renderer. The
// agent in the session pane is the stand-in (test/fake-agent.mjs).
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let app: ElectronApplication
let page: Page
const clients: Client[] = []

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-mcp-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  // A plate with a blind pocket in the middle of its top: the centre of that face is over the pocket, not on the face.
  mkdirSync(join(root, 'pocket'))
  writeFileSync(join(root, 'pocket', 'pocket.py'), 'from build123d import Box, Pos\n\nplate = Box(40, 30, 5) - Pos(0, 0, 1.5) * Box(10, 10, 2)\n')
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
  app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  await app?.close()
  rmSync(root, { recursive: true, force: true })
})

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())

/** How many checks of an object's marks against its build main has started, and how many have ended. */
function checks(objectId: string): Promise<{ started: number; finished: number }> {
  return app.evaluate((_electron, id) => (globalThis as unknown as { __tornoMain: { marksChecks(id: string): { started: number; finished: number } } }).__tornoMain.marksChecks(id), objectId)
}

/**
 * Wait until main has checked the marks of an object against its build since
 * `before` was read (read it before the marks are added): a check has ended
 * since, and none is under way or waiting.
 */
async function checked(objectId: string, before: { finished: number }): Promise<void> {
  await expect
    .poll(async () => {
      const now = await checks(objectId)
      return now.started === now.finished && now.finished > before.finished
    })
    .toBe(true)
}
const terminal = (): Promise<string> => page.evaluate(() => window.__tornoTerm!.text())

/** The address an agent working on that object is given. */
function mcpUrl(objectId: string): Promise<string> {
  return app.evaluate((_electron, id) => (globalThis as unknown as { __tornoMain: { mcpUrlFor(id: string): string } }).__tornoMain.mcpUrlFor(id), objectId)
}

async function connect(objectId: string): Promise<Client> {
  const client = new Client({ name: 'torno-e2e', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(await mcpUrl(objectId))))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; content: Content; text: string }> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Content
  return { isError: result.isError === true, content, text: content.find((block) => block.type === 'text')?.text ?? '' }
}

/** Share of a PNG's pixels that are neither the background nor as faint as the ground grid: the parts. */
function drawn(base64: string): Promise<{ width: number; height: number; drawn: number }> {
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    // --surface is #F1EFEA; the grid's hairlines are within 30 of it, the parts far from it.
    const background = [0xf1, 0xef, 0xea]
    let count = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (background.some((value, channel) => Math.abs(pixels[i + channel] - value) > 40)) count += 1
    }
    return { width: bitmap.width, height: bitmap.height, drawn: count / (pixels.length / 4) }
  }, base64)
}

async function openObject(name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => (await state()).build?.status, { timeout: 30_000 }).toBe('ok')
}

let bracket: Client
let whole: string

test('before an object has been built, scene and look say there is no build', async () => {
  await page.emulateMedia({ colorScheme: 'light' })
  bracket = await connect('bracket')
  expect((await bracket.listTools()).tools.map((t) => t.name).sort()).toEqual(['add_mark', 'describe', 'highlight', 'look', 'marks', 'resolve_mark', 'scene', 'show'])
  const asked: Array<[string, Record<string, unknown>]> = [
    ['scene', {}],
    ['look', {}],
    ['describe', { ref: 'base' }],
    ['highlight', { refs: ['base'] }],
    ['show', { view: 'top' }],
    ['add_mark', { kind: 'pin', note: '', ref: 'base' }]
  ]
  for (const [name, args] of asked) {
    const result = await call(bracket, name, args)
    expect(result.isError, name).toBe(true)
    expect(result.text, name).toBe('no build yet: bracket has not been opened in the torno window')
  }
  // The marks are the object's, built or not: there are none yet.
  expect(await call(bracket, 'marks')).toMatchObject({ isError: false, text: '{"revision":null,"marks":[]}' })
  const nothing = await call(await connect('no such object'), 'scene')
  expect(nothing).toMatchObject({ isError: true, text: 'unknown object: no such object' })
})

test('scene reports the build, the parts and what the window shows', async () => {
  await openObject('bracket')
  // The window reports its camera once the first build is on screen.
  await expect.poll(async () => JSON.parse((await call(bracket, 'scene')).text).camera).not.toBeNull()
  const result = await call(bracket, 'scene')
  expect(result.isError).toBe(false)
  const scene = JSON.parse(result.text)
  expect(scene).toMatchObject({
    object: 'bracket',
    model: 'bracket.py',
    build: { status: 'ok', revision: 1, stale: false },
    layout: 'assembly',
    layouts: ['assembly', 'print'],
    camera: { ortho: false }
  })
  expect(scene).not.toHaveProperty('note')
  expect(scene.parts.map((p: { layout: string; name: string }) => `${p.layout}:${p.name}`)).toEqual(['assembly:base', 'assembly:post', 'print:base', 'print:post'])
  expect(scene.parts[0]).toMatchObject({ name: 'base', visible: true, size: [40, 30, 5], bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, volume: 6000, faces: 6, edges: 12, valid: true })
  expect(scene.parts[1]).toMatchObject({ name: 'post', visible: true, size: [8, 8, 20], volume: 1005.31 })
})

test('look returns the picture the window draws, and keeps a copy under .torno/views', async () => {
  const result = await call(bracket, 'look', { view: 'iso' })
  expect(result.isError).toBe(false)
  const image = result.content.find((block) => block.type === 'image')!
  expect(image.mimeType).toBe('image/png')
  expect(image.data!.startsWith('iVBORw0KGgo')).toBe(true) // the PNG signature
  whole = image.data!
  const saved = join(root, 'bracket', '.torno', 'views', '1.png')
  expect(result.text).toBe(`view iso · layout assembly · parts base, post · orthographic · 1280×960\nrevision r1\nsaved as ${saved}`)
  expect(readFileSync(saved).toString('base64')).toBe(whole)
  const measured = await drawn(whole)
  expect(measured).toMatchObject({ width: 1280, height: 960 })
  expect(measured.drawn).toBeGreaterThan(0.02)

  // With no arguments: the person's own view, in the shape of their viewport.
  const current = await call(bracket, 'look')
  expect(current.text).toContain('view current · layout assembly · parts base, post · perspective')
  expect(current.text).toContain(join(root, 'bracket', '.torno', 'views', '2.png'))
  expect((await drawn(current.content[0].data!)).drawn).toBeGreaterThan(0.02)

  // The size is held to what the agent's CLI passes on unscaled.
  expect((await call(bracket, 'look', { view: 'front', size: 9000 })).text).toContain('2000×1500')
  // Whether the marks are drawn is the agent's to say; here there are none either way.
  expect((await call(bracket, 'look', { view: 'front', marks: false })).isError).toBe(false)
  expect((await call(bracket, 'look', { view: 'front', marks: 'no' })).isError).toBe(true)
  expect((await call(bracket, 'look', { view: 'front', layout: 'print', parts: ['post'], size: 100 })).text).toContain('view front · layout print · parts post · orthographic · 256×192')
})

test('a layer the person hides is gone from the next look, and scene says it is hidden', async () => {
  await page.locator('[data-layer="post"]').hover()
  await page.getByRole('button', { name: 'Show post' }).click()
  await expect.poll(async () => JSON.parse((await call(bracket, 'scene')).text).parts[1].visible).toBe(false)

  const result = await call(bracket, 'look', { view: 'iso' })
  expect(result.text).toContain('view iso · layout assembly · parts base · orthographic')
  const image = result.content[0].data!
  expect(image).not.toBe(whole)
  const [before, after] = [await drawn(whole), await drawn(image)]
  expect(after.drawn).toBeGreaterThan(0.02)
  expect(Math.abs(after.drawn - before.drawn)).toBeGreaterThan(0.005)

  // Asked for by name, a hidden part is drawn all the same.
  expect((await call(bracket, 'look', { view: 'iso', parts: ['post'] })).text).toContain('parts post ·')
})

test('an unknown part or layout is an error that names the ones there are', async () => {
  const part = await call(bracket, 'look', { parts: ['lid'] })
  expect(part).toMatchObject({ isError: true, text: "unknown part 'lid'; parts in layout assembly: base, post" })
  const layout = await call(bracket, 'look', { layout: 'exploded' })
  expect(layout.isError).toBe(true)
  expect(layout.text).toContain('assembly, print')
})

test('the pictures saved did not start a build', async () => {
  expect(existsSync(join(root, 'bracket', '.torno', 'views', '5.png'))).toBe(true)
  // Longer than the watcher waits before it builds.
  await page.waitForTimeout(1000)
  expect((await state()).build).toMatchObject({ status: 'ok', revision: 1 })
})

test('the agent is told of torno in its system prompt, and of the build with every prompt', async () => {
  await page.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
  await expect.poll(terminal).toContain('READY')
  const argv: string[] = JSON.parse(/READY (\[.*\])/s.exec((await terminal()).replace(/\n/g, ''))![1])
  const prompt = argv[argv.indexOf('--append-system-prompt') + 1]
  expect(argv).toContain('--append-system-prompt')
  expect(prompt).toContain('mcp__torno__look')
  expect(argv[argv.indexOf('--mcp-config') + 1]).toContain(await mcpUrl('bracket'))

  await page.locator('.session-term textarea').focus()
  await page.keyboard.type('hook')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await terminal()).replace(/\s+/g, ' ')).toMatch(
    /context: \[torno\] bracket · build ok · r1 \(\d+\.\d s\) · layout assembly · parts: base, post \(hidden: post\)\./
  )
  for (const tool of ['marks', 'describe', 'highlight', 'show', 'add_mark', 'resolve_mark']) expect(prompt).toContain(`mcp__torno__${tool}`)
})

// ---- Marks and the window, from the agent's side ----

const camera = (): Promise<Camera> => page.evaluate(() => window.__tornoTest!.camera())
const canvas = () => page.locator('.viewport-canvas canvas').first()
const ON_BASE: [number, number, number] = [14, 9, 2.5] // on the top of the base, clear of the post
/** What the terminal shows without its line breaks, which fall where the pane is wide. */
const said = async (): Promise<string> => (await terminal()).replace(/\s+/g, '')
const times = (text: string, part: string): number => text.split(part.replace(/\s+/g, '')).length - 1
const stateFile = () => join(root, 'bracket', '.torno', 'state.md')

async function prompt(): Promise<void> {
  await page.locator('.session-term textarea').focus()
  await page.keyboard.type('hook')
  await page.keyboard.press('Enter')
}

let pin: PinMark

test("show changes what the user sees for now, not the layers they saved, and waits while they have a button down", async () => {
  const sceneFile = join(root, 'bracket', '.torno', 'scene.json')
  // As the person left it, by hand, in the test above: the post hidden.
  await expect.poll(() => (existsSync(sceneFile) ? JSON.parse(readFileSync(sceneFile, 'utf8')).layers : null)).toEqual({ post: { visible: false } })
  const saved = readFileSync(sceneFile, 'utf8')

  // In the middle of a drag in the viewport, the view is theirs.
  const box = (await canvas().boundingBox())!
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 80)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 60, box.y + box.height - 90, { steps: 2 })
  const refused = await call(bracket, 'show', { parts: ['base', 'post'], layout: 'print' })
  expect(refused).toMatchObject({ isError: true, text: 'the user is in the middle of a stroke or drag; try again' })
  expect(await state()).toMatchObject({ layout: 'assembly', layers: { post: { visible: false } } })
  await page.mouse.up()

  const shown = await call(bracket, 'show', { parts: ['base', 'post'], layout: 'print' })
  expect(shown.isError).toBe(false)
  expect(await state()).toMatchObject({ layout: 'print', layers: { post: { visible: true } } })
  // Longer than a change made by hand takes to be written.
  await page.waitForTimeout(900)
  expect(readFileSync(sceneFile, 'utf8')).toBe(saved)
  // A change the person then makes by hand is saved, without what the agent had shown.
  await page.locator('[data-layer="base"]').getByRole('button', { name: 'Show base' }).click()
  await expect.poll(() => JSON.parse(readFileSync(sceneFile, 'utf8'))).toEqual({ layout: 'assembly', layers: { base: { visible: false }, post: { visible: false } } })
  await page.locator('[data-layer="base"]').getByRole('button', { name: 'Show base' }).click()
  await expect.poll(() => JSON.parse(readFileSync(sceneFile, 'utf8')).layers.base.visible).toBe(true)
  // Back as the tests that follow expect it: assembly, the post hidden by the person.
  expect((await call(bracket, 'show', { layout: 'assembly', parts: ['base'] })).isError).toBe(false)
  expect(await state()).toMatchObject({ layout: 'assembly', layers: { post: { visible: false } } })
})

test("show changes the user's layers and camera, and says what they see then", async () => {
  // The post was hidden by hand above: the agent brings it back.
  const parts = await call(bracket, 'show', { parts: ['base', 'post'] })
  expect(parts).toMatchObject({ isError: false, text: "view current · layout assembly · parts base, post · perspective\nrevision r1\nThe user's viewport now shows this." })
  expect((await state()).layers.post.visible).toBe(true)
  await expect(page.locator('[data-layer="post"]').getByRole('button', { name: 'Show post' })).toHaveAttribute('aria-pressed', 'true')

  const before = await camera()
  const top = await call(bracket, 'show', { view: 'top' })
  expect(top.text).toBe("view top · layout assembly · parts base, post · perspective\nrevision r1\nThe user's viewport now shows this.")
  // The camera travels there: straight above what it looks at.
  await expect
    .poll(async () => {
      const c = await camera()
      return c.position[2] > c.target[2] && Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1]) < 0.01 * (c.position[2] - c.target[2])
    })
    .toBe(true)
  expect(await camera()).not.toEqual(before)
  // What main is told the user sees follows.
  await expect.poll(async () => JSON.parse((await call(bracket, 'scene')).text).camera.position[2]).toBeGreaterThan(20)

  const unknown = await call(bracket, 'show', { parts: ['lid'] })
  expect(unknown).toMatchObject({ isError: true, text: "unknown part 'lid'; parts in layout assembly: base, post" })
  expect(await call(bracket, 'show', { layout: 'exploded' })).toMatchObject({ isError: true, text: "no layout 'exploded'; layouts: assembly, print" })
  expect((await state()).layers.post.visible).toBe(true)
})

test('a pin the user places with the pointer is in marks, with the face it is on', async () => {
  // By its button: the keys are the terminal's while it has the focus.
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Pin', exact: true }).click()
  const [fx, fy] = await page.evaluate((at) => window.__tornoTest!.project(at), ON_BASE)
  const box = (await canvas().boundingBox())!
  await page.mouse.move(box.x + fx * box.width, box.y + fy * box.height)
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.locator('.note-card textarea')).toBeFocused()
  await page.keyboard.type('make this corner thicker')
  await page.keyboard.press('Enter')
  await expect(page.locator('.note-card')).toHaveCount(0)
  await page.keyboard.press('Escape') // back to Select
  await expect.poll(async () => (await state()).marks[0]?.note).toBe('make this corner thicker')

  const listed: { revision: number; marks: Array<PinMark & { line: string }> } = JSON.parse((await call(bracket, 'marks')).text)
  expect(listed.revision).toBe(1)
  expect(listed).not.toHaveProperty('stale')
  expect(listed.marks).toHaveLength(1)
  const { line: _line, ...asListed } = listed.marks[0]
  pin = asListed as PinMark
  // Checked against the build it was placed on, the moment it was kept.
  expect(pin.checkedRevision).toBe(1)
  expect(pin).toMatchObject({ id: 'M1', kind: 'pin', author: 'user', status: 'draft', anchorState: 'ok', layout: 'assembly', note: 'make this corner thicker' })
  expect(pin.anchor).toMatchObject({ part: 'base', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' })
  expect(pin.anchor.ref).toMatch(/^base\/F\d+$/)
  expect(JSON.parse((await call(bracket, 'marks', { status: 'draft' })).text).marks).toHaveLength(1)
  expect((await call(bracket, 'marks', { status: 'sent' })).text).toBe('{"revision":1,"marks":[]}')

  // The same face, asked of the kernel, and the mark by its number.
  const face = JSON.parse((await call(bracket, 'describe', { ref: pin.anchor.ref! })).text)
  expect(face).toMatchObject({ layout: 'assembly', revision: 1, kind: 'face', ref: `assembly:${pin.anchor.ref}`, type: 'plane', area: 1200, normal: [0, 0, 1], descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' })
  expect(JSON.parse((await call(bracket, 'describe', { ref: 'M1' })).text)).toEqual({ revision: 1, mark: listed.marks[0] })
  expect(await call(bracket, 'describe', { ref: 'base/F99' })).toMatchObject({ isError: true, text: 'base has 6 faces, F0 to F5: there is no F99' })
  expect(await call(bracket, 'describe', { ref: 'M7' })).toMatchObject({ isError: true, text: 'no mark M7; marks: M1' })
})

test('the next prompt carries the pin as one line, and turns it sent', async () => {
  const line = describeMark(pin)
  expect(line).toMatch(/^M1 pin on base\/F\d \(plane, normal \+Z, z = 2\.5, 1200 mm²\) at \(1\d(\.\d+)?, \d(\.\d+)?, 2\.5\): "make this corner thicker"$/)
  // A hook that is not a prompt takes nothing with it.
  await page.locator('.session-term textarea').focus()
  await page.keyboard.type('hook Stop')
  await page.keyboard.press('Enter')
  await expect.poll(said).toContain('Stop:ok')
  expect((await state()).marks[0].status).toBe('draft')

  await prompt()
  await expect.poll(said).toContain(`Marks from the user (drawn in look pictures with these numbers): ${line}`.replace(/\s+/g, ''))
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
  await expect(page.locator('.mark-row[data-mark="M1"] .mark-status')).toHaveText('sent')
})

test("add_mark places the agent's own marks, by ref and by point, which the user sees in green", async () => {
  const unchecked = await checks('bracket')
  const byRef = await call(bracket, 'add_mark', { kind: 'pin', note: '<i>this</i> face?', ref: pin.anchor.ref })
  expect(byRef.isError).toBe(false)
  expect(byRef.text).toBe(`placed in layout assembly: (yours) M2 pin on ${pin.anchor.ref} (plane, normal +Z, z = 2.5, 1200 mm²) at (0, 0, 2.5): "<i>this</i> face?"\nrevision r1`)

  const row = page.locator('.mark-row[data-mark="M2"]')
  await expect(row).toHaveAttribute('data-author', 'agent')
  // --agent-mark, outlined: the user's own are filled with --user-mark.
  await expect(row.locator('.mark-chip')).toHaveCSS('border-top-color', 'rgb(43, 138, 92)')
  await expect(row.locator('.mark-chip')).toHaveCSS('color', 'rgb(43, 138, 92)')
  await expect(row.locator('.mark-chip')).toHaveAttribute('title', /The agent's mark/)
  // What the agent wrote is text, whatever it looks like.
  await expect(row.locator('.mark-note')).toHaveText('<i>this</i> face?')
  await expect(row.locator('.mark-note i')).toHaveCount(0)
  const agents = (await state()).marks[1] as PinMark
  expect(agents).toMatchObject({ id: 'M2', kind: 'pin', author: 'agent', status: 'sent', anchorState: 'ok', revision: 1 })
  expect(agents.anchor).toMatchObject({ point: [0, 0, 2.5], part: 'base', descriptor: 'plane, normal +Z, z = 2.5, 1200 mm²' })

  // By a point alone: the kernel says which part it is on.
  const byPoint = await call(bracket, 'add_mark', { kind: 'arrow', note: 'taller', point: [0, 0, 22.5], by: [0, 0, 10] })
  expect(byPoint.text).toMatch(/^placed in layout assembly: \(yours\) M3 arrow from post\/F\d \(plane, normal \+Z, z = 22\.5, 50\.27 mm²\) at \(0, 0, 22\.5\) by \(0, 0, 10\), 10 mm: "taller"\nrevision r1$/)
  const inAir = await call(bracket, 'add_mark', { kind: 'shape', note: 'keep clear', shape: 'box', size: [10, 10, 4], position: [30, 30, 30], intent: 'keep-out' })
  expect(inAir.text).toBe('placed in layout assembly: (yours) M4 box 10 × 10 × 4 mm centred at (30, 30, 30), intent keep-out: "keep clear"\nrevision r1')
  await expect.poll(async () => (await state()).marks.map((m) => `${m.id} ${m.author} ${m.kind}`)).toEqual(['M1 user pin', 'M2 agent pin', 'M3 agent arrow', 'M4 agent shape'])

  // Main checks each new mark against the build at once: what was answered still holds afterwards.
  await checked('bracket', unchecked)
  const kept = (await state()).marks
  expect(kept.map((m) => m.anchorState)).toEqual(['ok', 'ok', 'ok', 'ok'])
  expect(byRef.text).toBe(`placed in layout assembly: ${describeMark(kept[1])}\nrevision r1`)
  expect(byPoint.text).toBe(`placed in layout assembly: ${describeMark(kept[2])}\nrevision r1`)
  // Each was checked against that build.
  expect(kept.map((m) => m.checkedRevision)).toEqual([1, 1, 1, 1])
  // Each mark comes with its line.
  const listed: { revision: number; marks: Array<{ id: string; line: string }> } = JSON.parse((await call(bracket, 'marks')).text)
  expect(listed.marks.map((m) => m.line)).toEqual(kept.map((m) => describeMark(m, { revision: 1 })))

  expect(await call(bracket, 'add_mark', { kind: 'pin', note: '', ref: 'lid/F1' })).toMatchObject({ isError: true, text: "no part 'lid' in layout assembly (parts: base, post)" })
  expect(await call(bracket, 'add_mark', { kind: 'pin', note: '', ref: 'base', point: [0, 0, 90] })).toMatchObject({ isError: true, text: expect.stringMatching(/^the point \(0, 0, 90\) is 87\.5 mm from the surface of base: /) })
  expect((await state()).marks).toHaveLength(4)
})

test('a second prompt does not repeat the pin, and tells the agent none of its own marks', async () => {
  const before = await said()
  expect(times(before, 'Marks from the user')).toBe(1)
  await prompt()
  await expect.poll(async () => times(await said(), 'Open marks: M1, M2, M3, M4')).toBe(1)
  const after = await said()
  expect(times(after, 'Marks from the user')).toBe(1)
  expect(times(after, describeMark(pin))).toBe(1)
  expect((await state()).marks.map((m) => m.status)).toEqual(['sent', 'sent', 'sent', 'sent'])
})

test('highlight shows the user what the agent means, until they click', async () => {
  const line = page.locator('.agent-line')
  await expect(line).toHaveCount(0)
  const result = await call(bracket, 'highlight', { refs: [pin.anchor.ref!, 'post', 'M1'], note: '<b>this one?</b>' })
  expect(result).toMatchObject({
    isError: false,
    text: `highlighted ${pin.anchor.ref}, post in layout assembly for the user, with the note "<b>this one?</b>", until they click in the viewport or 60 s pass.`
  })
  await expect(line).toBeVisible()
  await expect(line.locator('[data-ref]')).toHaveText([pin.anchor.ref!, 'post'])
  await expect(line.locator('[data-ref]').first()).toHaveCSS('border-top-color', 'rgb(43, 138, 92)')
  await expect(line.locator('.agent-note')).toHaveText('<b>this one?</b>')
  await expect(line.locator('.agent-note b')).toHaveCount(0)

  // Turning the part to see it leaves it there; a click anywhere in the viewport puts it away.
  const box = (await canvas().boundingBox())!
  const before = await camera()
  await page.mouse.move(box.x + box.width - 12, box.y + box.height - 60)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 80, box.y + box.height - 100, { steps: 4 })
  await page.mouse.up()
  await expect.poll(camera).not.toEqual(before)
  await expect(line).toBeVisible()
  await page.mouse.click(box.x + box.width - 12, box.y + box.height - 60)
  await expect(line).toHaveCount(0)

  // A part that is switched off cannot be pointed at: the user would see nothing.
  await call(bracket, 'show', { parts: ['base'] })
  const hidden = await call(bracket, 'highlight', { refs: ['post/F1'] })
  expect(hidden).toMatchObject({ isError: true, text: 'nothing was highlighted: post is hidden, so the user would see nothing of it. Call show with parts ["base","post"] first, which changes what the user sees' })
  await expect(line).toHaveCount(0)
  await call(bracket, 'show', { parts: ['base', 'post'] })

  // So does its own control.
  await call(bracket, 'highlight', { refs: ['base/E0'] })
  await expect(line.locator('[data-ref]')).toHaveText(['base/E0'])
  await expect(line.locator('.agent-note')).toHaveCount(0)
  await line.getByRole('button', { name: 'Dismiss what the agent points at' }).click()
  await expect(line).toHaveCount(0)

  const wrong = await call(bracket, 'highlight', { refs: ['base/F1', 'lid', 'post/E9'] })
  expect(wrong).toMatchObject({ isError: true, text: "nothing was highlighted: no part 'lid' in layout assembly (parts: base, post); post has 3 edges, E0 to E2: there is no E9" })
  const elsewhere = await call(bracket, 'highlight', { refs: ['base'], layout: 'print' })
  expect(elsewhere).toMatchObject({ isError: true, text: 'layout print is not the one on screen (assembly): call show with that layout first, which changes what the user sees' })
  await expect(line).toHaveCount(0)
})

test('resolve_mark resolves a mark, which the user sees as resolved by the agent with what it did, and then moves under Resolved', async () => {
  const result = await call(bracket, 'resolve_mark', { id: 'M1', note: 'made the corner 2 mm thicker' })
  expect(result).toMatchObject({ isError: false, text: `resolved: ${describeMark(pin)}\nnote: made the corner 2 mm thicker` })
  const marks = page.getByRole('region', { name: 'Marks' })
  // Still in the list, saying who resolved it and what was done, in words on the row.
  const awaiting = marks.locator('.mark-rows').first().locator('[data-mark="M1"]')
  await expect(marks.locator('.mark-rows').first().locator('[data-mark]')).toHaveCount(4)
  await expect(awaiting).toHaveAttribute('data-awaiting', '')
  await expect(awaiting.locator('.mark-resolution-note')).toHaveText('Resolved by the agent: made the corner 2 mm thicker')
  await awaiting.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(marks.locator('.mark-rows').first().locator('[data-mark]')).toHaveCount(3)
  await expect(marks.locator('.mark-rows').first().locator('[data-mark="M1"]')).toHaveCount(0)
  await marks.getByRole('button', { name: /Resolved/ }).click()
  const resolved = marks.getByRole('list', { name: 'Resolved marks' }).locator('[data-mark="M1"]')
  await expect(resolved).toHaveAttribute('data-status', 'resolved')
  await expect(resolved.locator('.mark-note')).toHaveAttribute('title', 'make this corner thicker\nResolved: made the corner 2 mm thicker')
  expect((await call(bracket, 'marks', { status: 'open' })).text).not.toContain('"M1"')

  expect(await call(bracket, 'resolve_mark', { id: 'M9' })).toMatchObject({ isError: true, text: 'no mark M9; marks: M1, M2, M3, M4' })
})

test('state.md says the same to an agent without the tools, and writing it starts no build', async () => {
  // It follows the marks by a second: wait for the one that tells of the mark just resolved.
  await expect.poll(() => (existsSync(stateFile()) ? readFileSync(stateFile(), 'utf8') : ''), { timeout: 10_000 }).toMatch(/In layout assembly:\n\n- \(yours\) M2 pin[^]*- \(yours\) M4 box/)
  const text = readFileSync(stateFile(), 'utf8')
  expect(text).toContain('# bracket\n')
  expect(text).toContain('## Build\n\nBuild ok, r1.\n')
  expect(text).toContain('- assembly: base 40 × 30 × 5 mm, post 8 × 8 × 20 mm\n')
  expect(text).toContain(`In layout assembly:\n\n- (yours) M2 pin on ${pin.anchor.ref} (plane, normal +Z, z = 2.5, 1200 mm²) at (0, 0, 2.5): "<i>this</i> face?"\n- (yours) M3 arrow from post/F`)
  // Resolved: no longer something to act on.
  expect(text).not.toContain('M1 pin')
  // Longer than the watcher waits before it builds, and than the file waits to be written again.
  await page.waitForTimeout(1500)
  expect(readFileSync(stateFile(), 'utf8')).toBe(text)
  expect((await state()).build).toMatchObject({ status: 'ok', revision: 1 })
  expect(readdirSync(join(root, 'bracket', '.torno')).filter((name) => name.includes('.tmp'))).toEqual([])
})

test('for an object that is not the one open, look refuses and scene says what it cannot know', async () => {
  await openObject('plain')
  const look = await call(bracket, 'look', { view: 'iso' })
  expect(look).toMatchObject({ isError: true, text: 'bracket is not the object open in the torno window (open: plain). Ask the user to open it.' })
  // Nor is the user shown anything of an object they are not looking at.
  for (const [name, args] of [['show', { view: 'top' }], ['highlight', { refs: ['base'] }]] as const) {
    expect(await call(bracket, name, args)).toMatchObject({ isError: true, text: 'bracket is not the object open in the torno window (open: plain). Ask the user to open it.' })
  }
  await expect(page.locator('.agent-line')).toHaveCount(0)
  // Its marks and its geometry are still there to ask about.
  expect(JSON.parse((await call(bracket, 'marks', { status: 'open' })).text).marks).toHaveLength(3)
  expect(JSON.parse((await call(bracket, 'describe', { ref: 'post' })).text)).toMatchObject({ layout: 'assembly', kind: 'part' })
  const scene = JSON.parse((await call(bracket, 'scene')).text)
  expect(scene).toMatchObject({ object: 'bracket', build: { status: 'ok', revision: 1 }, layout: null, camera: null })
  expect(scene.note).toContain('not the object open in the torno window (open: plain)')
  expect(scene.parts).toHaveLength(4)
  expect(scene.parts[0]).not.toHaveProperty('visible')

  // The object that is open answers at its own address.
  const plain = await call(await connect('plain'), 'look', { view: 'top' })
  expect(plain.text).toContain('view top · layout main · parts plate')
})

test('add_mark by a face whose centre is not on it puts the pin on the face under the point, says so, and keeps what it said', async () => {
  await openObject('pocket')
  const pocket = await connect('pocket')
  const faces: Array<{ ref: string; descriptor: string }> = []
  for (let i = 0; i < 11; i += 1) {
    const face = JSON.parse((await call(pocket, 'describe', { ref: `plate/F${i}` })).text)
    faces.push({ ref: `plate/F${i}`, descriptor: face.descriptor })
  }
  // The top, with the mouth of the pocket in its middle, and the floor of the pocket 2 mm under it.
  const top = faces.find((f) => /^plane, normal \+Z, z = 2\.5, /.test(f.descriptor))!
  const floor = faces.find((f) => /^plane, normal \+Z, z = 0\.5, /.test(f.descriptor))!
  expect(top.descriptor).toBe('plane, normal +Z, z = 2.5, 1100 mm²')
  expect(floor.descriptor).toBe('plane, normal +Z, z = 0.5, 100 mm²')

  const unchecked = await checks('pocket')
  const placed = await call(pocket, 'add_mark', { kind: 'pin', note: 'deeper?', ref: top.ref })
  expect(placed.isError).toBe(false)
  expect(placed.text).toBe(
    `placed in layout main: (yours) M1 pin on ${floor.ref} (${floor.descriptor}) at (0, 0, 0.5): "deeper?"\nThe centre of ${top.ref} is not on it: the mark is placed on ${floor.ref}, the face under that point. Give a point on ${top.ref} to put it there.\nrevision r1`
  )
  // The check that follows the adding finds it as it was said to be.
  await checked('pocket', unchecked)
  const [kept] = (await state()).marks as PinMark[]
  expect(kept).toMatchObject({ id: 'M1', anchorState: 'ok', anchor: { point: [0, 0, 0.5], part: 'plate', ref: floor.ref, descriptor: floor.descriptor } })
  expect(placed.text.split('\n')[0]).toBe(`placed in layout main: ${describeMark(kept)}`)
  const [listed] = (JSON.parse((await call(pocket, 'marks')).text) as { marks: Array<{ line: string }> }).marks
  expect(listed.line).toBe(describeMark(kept))
})

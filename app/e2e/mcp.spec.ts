import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'

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
  expect((await bracket.listTools()).tools.map((t) => t.name).sort()).toEqual(['look', 'scene'])
  for (const name of ['scene', 'look']) {
    const result = await call(bracket, name)
    expect(result.isError).toBe(true)
    expect(result.text).toBe('no build yet: bracket has not been opened in the torno window')
  }
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
    /context: \[torno\] bracket · build ok · r1 \(\d+\.\d s\) · layout assembly · parts: base, post \(hidden: post\)\. Tools: mcp__torno__scene, mcp__torno__look\./
  )
})

test('for an object that is not the one open, look refuses and scene says what it cannot know', async () => {
  await openObject('plain')
  const look = await call(bracket, 'look', { view: 'iso' })
  expect(look).toMatchObject({ isError: true, text: 'bracket is not the object open in the torno window (open: plain). Ask the user to open it.' })
  const scene = JSON.parse((await call(bracket, 'scene')).text)
  expect(scene).toMatchObject({ object: 'bracket', build: { status: 'ok', revision: 1 }, layout: null, camera: null })
  expect(scene.note).toContain('not the object open in the torno window (open: plain)')
  expect(scene.parts).toHaveLength(4)
  expect(scene.parts[0]).not.toHaveProperty('visible')

  // The object that is open answers at its own address.
  const plain = await call(await connect('plain'), 'look', { view: 'top' })
  expect(plain.text).toContain('view top · layout main · parts plate')
})

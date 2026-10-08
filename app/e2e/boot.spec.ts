import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const appDir = resolve(__dirname, '..')

// TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
function launch(): Promise<ElectronApplication> {
  return electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1' } })
}

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="viewport"]')
})

test.afterAll(async () => {
  await app?.close()
})

test('the window is hidden, 1440 × 900, and titled torno', async () => {
  const win = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getSize()
    return { visible: w.isVisible(), width, height }
  })
  expect(win).toEqual({ visible: false, width: 1440, height: 900 })
  expect(await page.title()).toBe('torno')
})

test('the four shell regions exist with their placeholders', async () => {
  await expect(page.locator('aside[data-region="left"]')).toContainText('torno')
  await expect(page.locator('main[data-region="viewport"]')).toContainText('No object open')
  await expect(page.locator('aside[data-region="session"]')).toBeVisible()
  await expect(page.locator('footer[data-region="status"]')).toBeVisible()
})

test('the viewport fills the window and the panels sit over it', async () => {
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!
  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(await box('[data-region="viewport"]')).toEqual({ x: 0, y: 0, width: win.w, height: win.h })
  const left = await box('[data-region="left"]')
  expect(left.x).toBe(0)
  expect(left.width).toBe(248)
  const session = await box('[data-region="session"]')
  expect(session.width).toBe(520)
  expect(session.x + session.width).toBe(win.w)
  const status = await box('[data-region="status"]')
  expect(status.height).toBe(28)
  expect(status.y + status.height).toBe(win.h)
})

test('the renderer is isolated and the bridge is exposed', async () => {
  const probe = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    let message = ''
    try {
      window.torno.workspace.current()
    } catch (e) {
      message = (e as Error).message
    }
    return { hasRequire: typeof w.require, hasProcess: typeof w.process, groups: Object.keys(window.torno).sort(), message }
  })
  expect(probe).toEqual({
    hasRequire: 'undefined',
    hasProcess: 'undefined',
    groups: ['object', 'session', 'view', 'workspace'],
    message: 'not implemented'
  })
})

test('WebGL2 runs on the GPU, not a software rasteriser', async () => {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return null
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  })
  expect(renderer, 'a WebGL2 context').not.toBeNull()
  expect(renderer).not.toContain('SwiftShader')
  expect(renderer).not.toContain('llvmpipe')
})

test('the session dock is resized by dragging its edge, within limits', async () => {
  const dock = page.locator('[data-region="session"]')
  const handle = page.getByRole('separator', { name: 'Resize session' })
  const width = async () => (await dock.boundingBox())!.width
  const dragEdgeBy = async (dx: number) => {
    const edge = (await handle.boundingBox())!
    const x = edge.x + edge.width / 2
    const y = edge.y + edge.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 4 })
    await page.mouse.up()
  }

  await dragEdgeBy(-100)
  expect(await width()).toBe(620)

  // It stops at a minimum width rather than vanishing...
  await dragEdgeBy(900)
  expect(await width()).toBe(320)
  // ...and at a maximum that keeps 240 px of viewport free beside the left column.
  await dragEdgeBy(-1400)
  expect((await dock.boundingBox())!.x).toBe(248 + 240)

  // The edge also answers to the arrow keys, 16 px a press.
  await handle.focus()
  const widest = await width()
  await page.keyboard.press('ArrowRight')
  expect(await width()).toBe(widest - 16)
  await page.keyboard.press('ArrowLeft')
  expect(await width()).toBe(widest)

  await dragEdgeBy(widest - 520)
  expect(await width()).toBe(520)
})

test('the session dock collapses and comes back at the same width', async () => {
  const dock = page.locator('[data-region="session"]')
  const before = (await dock.boundingBox())!.width
  await page.getByRole('button', { name: 'Hide session' }).click()
  await expect(dock).toBeHidden()
  await expect(dock).toBeAttached()
  await page.getByRole('button', { name: 'Show session' }).click()
  await expect(dock).toBeVisible()
  expect((await dock.boundingBox())!.width).toBe(before)
})

// Set TORNO_SHOTS=<dir> to write shell-light.png and shell-dark.png there.
// Each picture needs its own launch: on a hidden window capturePage() delivers
// one image and hangs on the next call, and page.screenshot() never returns.
for (const scheme of ['light', 'dark'] as const) {
  test(`screenshot, ${scheme}`, async () => {
    const dir = process.env.TORNO_SHOTS
    test.skip(!dir, 'TORNO_SHOTS is not set')
    mkdirSync(dir!, { recursive: true })
    const shotApp = await launch()
    try {
      const shotPage = await shotApp.firstWindow()
      await shotPage.emulateMedia({ colorScheme: scheme })
      await shotPage.waitForSelector('[data-region="viewport"]')
      await shotPage.evaluate(async () => {
        await document.fonts.ready
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      })
      const png = await shotApp.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
        return image.toPNG().toString('base64')
      })
      writeFileSync(join(dir!, `shell-${scheme}.png`), Buffer.from(png, 'base64'))
    } finally {
      await shotApp.close()
    }
  })
}

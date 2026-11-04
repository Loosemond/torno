import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { openListed } from './objects'

// The exported page that GitHub Pages serves (site/index.html, .github/workflows/pages.yml): the repository's own
// `bracket` (kernel/tests/fixtures/ws), with two marks, exported by torno's own code, as a person would. Skipped
// unless TORNO_SITE_OUT names a folder; it is not a test of anything:
//   TORNO_SITE_OUT=$PWD/site pnpm -C app exec playwright test e2e/site.spec.ts   (after `pnpm build`)
// The window is hidden (TORNO_TEST=1) and the save goes where `__tornoMain.pickSave` says.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')
const target = process.env.TORNO_SITE_OUT ?? ''

test.skip(!target, 'TORNO_SITE_OUT is not set')

type Main = { pickSave: string | null }

test('the bracket is exported for the site', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-site-'))
  const made = mkdtempSync(join(realpathSync(tmpdir()), 'torno-site-out-'))
  cpSync(join(fixtures, 'bracket'), join(root, 'bracket'), { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  const camera = { position: [90, -80, 60], target: [0, 0, 8], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
  const base = { author: 'user', status: 'sent', anchorState: 'ok', layout: 'assembly', revision: 1, camera, createdAt: '2026-10-09T20:00:00.000Z' }
  mkdirSync(join(root, 'bracket', '.torno'), { recursive: true })
  writeFileSync(
    join(root, 'bracket', '.torno', 'marks.json'),
    JSON.stringify({
      next: 3,
      marks: [
        { ...base, id: 'M1', kind: 'pin', note: 'A fillet where the post meets the base?', anchor: { point: [4, 0, 2.5], normal: [0, 0, 1], part: 'base' } },
        { ...base, id: 'M2', kind: 'dimension', note: 'base width', measure: 'distance', a: { point: [-20, 0, 0], normal: [-1, 0, 0], part: 'base' }, b: { point: [20, 0, 0], normal: [1, 0, 0], part: 'base' }, expected: 40 }
      ]
    })
  )
  const app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-region="left"]')
    await openListed(page, 'bracket')
    await expect.poll(async () => (await page.evaluate(() => window.__tornoTest!.state())).build?.status, { timeout: 60_000 }).toBe('ok')
    await expect.poll(async () => ((await page.evaluate(() => window.torno.marks.list('bracket'))) as { id: string; value?: number }[]).find((m) => m.id === 'M2')?.value, { timeout: 30_000 }).toBe(40)
    const out = join(made, 'bracket.html')
    await app.evaluate((_e, to) => void ((globalThis as unknown as { __tornoMain: Main }).__tornoMain.pickSave = to), out)
    await page.getByRole('button', { name: 'Export…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Export' })
    await sheet.getByRole('checkbox', { name: /Include marks and their notes/ }).check()
    await sheet.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
    const html = readFileSync(out, 'utf8')
    expect(html).not.toContain(root)
    expect(html).not.toContain(process.env.HOME ?? '\0')
    mkdirSync(target, { recursive: true })
    copyFileSync(out, join(target, 'index.html'))
    writeFileSync(join(target, '.nojekyll'), '')
    console.log(`site/index.html: ${statSync(join(target, 'index.html')).size} bytes`)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(made, { recursive: true, force: true })
  }
})

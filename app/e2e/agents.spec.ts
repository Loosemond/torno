import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'

// The agent of an object, chosen in the session header, and an agent that
// posts no hooks: the stand-in (test/fake-agent.mjs, named by TORNO_AGENT_CMD)
// started with Copilot CLI's arguments. No test here runs `copilot` or `claude`.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let other: string
let app: ElectronApplication
let page: Page

function copyFixtures(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-agents-'))
  cpSync(fixtures, dir, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  return dir
}

test.beforeAll(async () => {
  root = copyFixtures()
  other = copyFixtures()
  // A file that names an agent torno does not have, as one written by a later torno might.
  mkdirSync(join(root, 'hollow', '.torno'), { recursive: true })
  writeFileSync(join(root, 'hollow', '.torno', 'agent.json'), '{"agent":"gemini"}')
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it.
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [root, other]) rmSync(dir, { recursive: true, force: true })
})

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const term = (): Promise<string> => page.evaluate(() => window.__tornoTerm!.text())
const dock = () => page.locator('[data-region="session"]')
const left = () => page.locator('[data-region="left"]')
const picker = () => page.getByRole('combobox', { name: 'Agent' })
const told = () => dock().locator('.session-told')
const chosenOnDisk = (object: string): unknown => existsSync(join(root, object, '.torno', 'agent.json')) && JSON.parse(readFileSync(join(root, object, '.torno', 'agent.json'), 'utf8')).agent

async function open(name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => (await state()).build, { timeout: 30_000 }).toMatchObject({ objectId: name, status: 'ok' })
}

/** The stand-in agents running in a folder, by pid. */
function agentsIn(dir: string): number[] {
  const found: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (!readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes('fake-agent.mjs')) continue
      if (readlinkSync(`/proc/${entry}/cwd`) === dir) found.push(Number(entry))
    } catch {
      // Gone meanwhile, or not ours to read.
    }
  }
  return found
}

test('the agent is chosen per object and kept; one without hooks is told by "Send marks", and the marks are sent once the line has gone', async () => {
  await open('plain')
  await expect(picker()).toHaveValue('claude')
  // Under test the stand-in is on PATH for every adapter: both can be chosen.
  await expect(picker().locator('option')).toHaveText(['Claude Code', 'Copilot CLI'])
  await picker().selectOption('copilot')
  await expect.poll(() => chosenOnDisk('plain')).toBe('copilot')
  await expect(dock().getByRole('heading', { name: 'Copilot CLI' })).toBeVisible()
  await expect(dock()).toContainText('Copilot CLI runs here, in the folder of plain')
  await page.locator('.session-actions .button-primary').click() // the button that starts a new session
  await expect.poll(term).toContain('READY')
  expect(await term()).toContain('--additional-mcp-config')
  expect(await term()).not.toContain('--settings')
  // Nothing says whether it works: it runs, and that is all that is said.
  await expect(page.locator('.session-status')).toHaveText('Running')
  await expect(page.locator('.session-status')).toHaveAttribute('data-status', 'running')
  await expect(page.getByText('This agent is not told with each prompt: use "Send marks".')).toBeVisible()
  // Its instructions are in a folder of torno's own, and nowhere else in the object.
  expect(readFileSync(join(root, 'plain', '.torno', 'agent', 'AGENTS.md'), 'utf8')).toContain('At the start of each task read .torno/state.md')
  expect(readdirSync(join(root, 'plain')).filter((name) => /agents\.md|\.github|copilot/i.test(name))).toEqual([])
  // With nothing to send there is no button.
  await expect(dock().getByRole('button', { name: /^Send/ })).toHaveCount(0)

  // A pin, left with the Pin tool: a click on the plate keeps it, and its note is typed where it opens.
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Pin', exact: true }).click()
  const box = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  await expect.poll(async () => (await state()).marks.map((m) => m.status)).toEqual(['draft'])
  await page.keyboard.type('this face')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).marks[0].note).toBe('this face')
  const send = dock().getByRole('button', { name: /^Send marks/ })
  await expect(send).toHaveText('Send marks (1)')
  await expect(send.locator('.num')).toHaveText('1')
  await expect(send).toHaveAttribute('title', 'Writes .torno/prompt.md and puts a line at the cursor for you to send')
  await send.click()
  await expect.poll(() => existsSync(join(root, 'plain', '.torno', 'prompt.md'))).toBe(true)
  expect(readFileSync(join(root, 'plain', '.torno', 'prompt.md'), 'utf8')).toContain('this face')
  expect(readFileSync(join(root, 'plain', '.torno', 'prompt.md'), 'utf8')).toMatch(/^Written \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC by torno/)
  // The line is at the cursor, not sent: still a draft, and the pane says what is waited for.
  await expect(told()).toContainText('A line is at the cursor: press Enter there to send it. Marks stay drafts until you do.')
  await expect.poll(term).toContain('torno: 1 new mark (M1)')
  expect(await term()).not.toContain('> ')
  expect((await state()).marks[0].status).toBe('draft')
  // The keyboard is in the terminal, where Enter sends the line.
  await expect(page.locator('.session-term textarea')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(term).toMatch(/> .*torno: 1 new mark \(M1\)/)
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
  await expect(told()).toContainText('The line went with your Enter. Whether the agent read the file, torno cannot see.')
  await expect(dock().getByRole('button', { name: /^Send/ })).toHaveCount(0)
  // It was sent a line: its conversation is on file as Copilot's.
  expect(JSON.parse(readFileSync(join(root, 'plain', '.torno', 'session.json'), 'utf8')).agent).toBe('copilot')
})

test('the header keeps to the width of the dock, with the agent, where it stands and the list to choose from', async () => {
  const fits = await dock().locator('.session-head').evaluate((head) => ({ wide: head.scrollWidth, room: head.clientWidth }))
  expect(fits.wide).toBeLessThanOrEqual(fits.room)
  const strip = await told().evaluate((el) => ({ wide: el.scrollWidth, room: el.clientWidth }))
  expect(strip.wide).toBeLessThanOrEqual(strip.room)
})

test('a line that may have been changed before Enter leaves the marks drafts, and is offered again', async () => {
  // The note of the mark is changed: it is a draft again, to be told as changed.
  await app.evaluate(async () => {
    const { marks } = (globalThis as unknown as { __tornoMain: { marks: { update(object: string, id: string, patch: object, by: string): Promise<unknown> } } }).__tornoMain
    await marks.update('plain', 'M1', { note: 'this face, 2 mm thicker' }, 'user')
  })
  await expect.poll(async () => (await state()).marks[0].status).toBe('draft')
  await dock().getByRole('button', { name: /^Send marks/ }).click()
  await expect(told()).toContainText('A line is at the cursor')
  // While the line waits, the file it names follows the marks.
  await app.evaluate(async () => {
    const { marks } = (globalThis as unknown as { __tornoMain: { marks: { update(object: string, id: string, patch: object, by: string): Promise<unknown> } } }).__tornoMain
    await marks.update('plain', 'M1', { note: 'this face, 3 mm thicker' }, 'user')
  })
  await expect.poll(() => readFileSync(join(root, 'plain', '.torno', 'prompt.md'), 'utf8')).toContain('3 mm thicker')
  await page.keyboard.press('Backspace')
  await expect(told()).toContainText('The line may have been changed before Enter, so the marks are still drafts: use "Send marks" again.')
  await page.keyboard.press('Enter')
  await expect.poll(async () => ((await term()).match(/> /g) ?? []).length).toBe(2)
  expect((await state()).marks[0].status).toBe('draft')
  // Asked again, and sent as it was put there.
  await dock().getByRole('button', { name: /^Send marks/ }).click()
  await expect(told()).toContainText('A line is at the cursor')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
})

test('ending a session whose agent does not say whether it works is asked about; the choice cannot be changed under it', async () => {
  const [agent] = agentsIn(join(root, 'plain'))
  await dock().getByRole('button', { name: 'New session' }).click()
  const ask = dock().getByRole('alertdialog', { name: 'End the running session?' })
  await expect(ask).toContainText('Copilot CLI may be working: torno cannot tell. A new session ends this one.')
  await ask.getByRole('button', { name: 'Keep it' }).click()
  expect(agentsIn(join(root, 'plain'))).toEqual([agent])
  // Main refuses whatever the window asks while the session runs.
  const refused = await page.evaluate(() => window.torno.session.chooseAgent('plain', 'claude').then(() => 'chosen', (e: Error) => e.message))
  expect(refused).toContain('End the session first')
  expect(chosenOnDisk('plain')).toBe('copilot')
  const unknown = await page.evaluate(() => window.torno.session.chooseAgent('plain', 'gemini' as never).then(() => 'chosen', (e: Error) => e.message))
  expect(unknown).not.toBe('chosen')
})

test('choosing another agent while a session runs asks, ends that session, and starts none', async () => {
  const [agent] = agentsIn(join(root, 'plain'))
  await picker().selectOption('claude')
  const ask = dock().getByRole('alertdialog', { name: 'End the running session?' })
  await expect(ask).toContainText('Copilot CLI may be working: torno cannot tell. Choosing another agent ends this session, and starts none.')
  await expect(ask.getByRole('button')).toHaveText(['Keep it', 'End it and choose Claude Code'])
  // Nothing has been ended or chosen by asking.
  await expect(picker()).toHaveValue('copilot')
  expect(chosenOnDisk('plain')).toBe('copilot')
  await ask.getByRole('button', { name: 'Keep it' }).click()
  await expect(ask).toHaveCount(0)
  expect(agentsIn(join(root, 'plain'))).toEqual([agent])
  await expect(picker()).toHaveValue('copilot')

  await picker().selectOption('claude')
  await ask.getByRole('button', { name: 'End it and choose Claude Code' }).click()
  await expect.poll(() => chosenOnDisk('plain')).toBe('claude')
  await expect(picker()).toHaveValue('claude')
  await expect(page.locator('.session-status')).toHaveText('Ended')
  await expect.poll(() => agentsIn(join(root, 'plain'))).toEqual([])
  // Its conversation was Copilot's: Claude Code is not offered it to resume.
  await expect(dock().getByRole('button', { name: 'Resume' })).toHaveCount(0)
  await expect(told()).toHaveCount(0)
  // A session of Claude Code is as it ever was: its hooks, its status, no strip.
  await dock().getByRole('button', { name: 'New session' }).click()
  await expect.poll(term).toContain('--settings')
  await expect(page.locator('.session-status')).toHaveText('Idle')
  await expect(dock().getByRole('heading', { name: 'Claude Code' })).toBeVisible()
  await expect(told()).toHaveCount(0)
  expect(JSON.parse(readFileSync(join(root, 'plain', '.torno', 'session.json'), 'utf8')).agent).toBe('copilot')
})

test('another object has its own agent; a file that names one torno does not know is said, and Claude Code is used', async () => {
  await open('hollow')
  await expect(picker()).toHaveValue('claude')
  await expect(told()).toHaveText('agent.json names "gemini", which torno does not know: Claude Code is used.')
  // The file is the person's until they choose: it is as it was.
  expect(chosenOnDisk('hollow')).toBe('gemini')
  await picker().selectOption('copilot')
  await expect.poll(() => chosenOnDisk('hollow')).toBe('copilot')
  await expect(told()).toHaveCount(0)
  await open('plain')
  await expect(picker()).toHaveValue('claude')
})

test('leaving the folder while an agent that does not say runs is asked about, as what it is', async () => {
  await open('hollow')
  await page.locator('.session-actions .button-primary').click()
  await expect.poll(term).toContain('READY')
  await expect(page.locator('.session-status')).toHaveText('Running')
  // The session of plain, Claude Code's and idle, is ended so that only this one is in the way.
  const plain = (await state()).sessions.plain.sessionId
  await page.evaluate((id) => window.torno.session.stop(id), plain)
  await expect.poll(async () => (await state()).sessions.plain.status).toBe('exited')
  await app.evaluate((_electron, dir) => {
    ;(globalThis as unknown as { __tornoMain: { pickFolder: string | null } }).__tornoMain.pickFolder = dir
  }, other)
  await left().getByRole('button', { name: 'Open folder' }).click()
  const ask = left().getByRole('alertdialog', { name: 'End the sessions of this folder?' })
  await expect(ask).toContainText('A session here may be in the middle of its work: its agent does not say. Opening another folder ends it.')
  await ask.getByRole('button', { name: 'Stay here' }).click()
  expect((await state()).workspace?.root).toBe(root)
  expect(agentsIn(join(root, 'hollow'))).toHaveLength(1)
})

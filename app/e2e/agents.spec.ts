import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'

// The agent of an object, chosen in the session header, and an agent that
// posts no hooks: the stand-in (test/fake-agent.mjs, named by TORNO_AGENT_CMD)
// started with Copilot CLI's arguments. No test here runs `copilot` or `claude`.
//
// Every test works in an object of its own, starts what it needs there and ends
// it afterwards: each can be run alone, and one that fails leaves the others theirs.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

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

const status = () => page.locator('.session-status')
const promptFile = (object: string): string => readFileSync(join(root, object, '.torno', 'prompt.md'), 'utf8')

// Whatever a test started is ended, so that the next finds no session in the way.
test.afterEach(async () => {
  await page.evaluate(async () => {
    const sessions = Object.values(window.__tornoTest!.state().sessions)
    await Promise.all(sessions.filter((s) => s.status !== 'exited').map((s) => window.torno.session.stop(s.sessionId)))
  })
  await expect.poll(async () => Object.values((await state()).sessions).every((s) => s.status === 'exited')).toBe(true)
})

/** Open an object, choose Copilot CLI for it and start a session there: the stand-in, with no hook to post. */
async function hookless(name: string): Promise<void> {
  await open(name)
  if ((await picker().inputValue()) !== 'copilot') await picker().selectOption('copilot')
  await expect.poll(() => chosenOnDisk(name)).toBe('copilot')
  await page.locator('.session-actions .button-primary').click() // the button that starts a new session
  await expect.poll(term).toContain('READY')
  await expect(status()).toHaveText('Running')
}

/** A draft of the person's on the part of the open object, wherever one is drawn; answers with its id. */
async function draft(object: string, note: string): Promise<string> {
  return page.evaluate(
    async ([id, text]) => {
      const hooks = window.__tornoTest!
      for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6]) {
        for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6]) {
          const hit = hooks.pickAt(fx, fy, { edges: false, partsOnly: true })
          if (!hit) continue
          const anchor = { point: hit.point, part: hit.part, ref: hit.ref, ...(hit.normal ? { normal: hit.normal } : {}) }
          const { layout, revision } = hooks.state()
          return (await window.torno.marks.add(id, { kind: 'pin', author: 'user', note: text, layout, revision, camera: hooks.camera(), anchor } as never)).id
        }
      }
      throw new Error('no part is drawn near the middle of the canvas')
    },
    [object, note] as const
  )
}

const statusOf = async (id: string) => (await state()).marks.find((m) => m.id === id)?.status
const sendButton = () => dock().getByRole('button', { name: /^Send marks/ })

/** "Send marks", and the line it puts at the cursor shown by the agent at its prompt. */
async function sendMarks(): Promise<void> {
  await sendButton().click()
  await expect(told()).toContainText('A line is at the cursor: press Enter to send it as it is. Marks stay drafts until you do.')
  await expect.poll(term).toMatch(/torno: \d+ new mark/)
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
  await expect(status()).toHaveText('Running')
  await expect(status()).toHaveAttribute('data-status', 'running')
  await expect(page.getByText('This agent is not told with each prompt: use "Send marks".')).toBeVisible()
  // Its instructions are in a folder of torno's own, and nowhere else in the object; they never promise what a hook would do.
  const instructions = readFileSync(join(root, 'plain', '.torno', 'agent', 'AGENTS.md'), 'utf8')
  expect(instructions).toContain('At the start of each task read .torno/state.md')
  expect(instructions).not.toContain('arrive with the prompt')
  expect(readdirSync(join(root, 'plain')).filter((name) => /agents\.md|\.github|copilot/i.test(name))).toEqual([])
  // What changes with every send is not for git; the choice of agent travels with the object.
  expect(readFileSync(join(root, 'plain', '.torno', '.gitignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['prompt.md', 'agent/']))
  expect(readFileSync(join(root, 'plain', '.torno', '.gitignore'), 'utf8')).not.toContain('agent.json')
  // Nothing of an earlier session is there to be read as news.
  expect(promptFile('plain')).toMatch(/^Nothing new from torno/)
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
  await expect(sendButton()).toHaveText('Send marks (1)')
  await expect(sendButton().locator('.num')).toHaveText('1')
  await expect(sendButton()).toHaveAttribute('title', 'Writes .torno/prompt.md and puts a line at the cursor for you to send')
  await sendMarks()
  expect(promptFile('plain')).toContain('this face')
  expect(promptFile('plain')).toMatch(/^Written \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC by torno/)
  // The line is at the cursor, not sent: still a draft.
  await expect.poll(term).toContain('torno: 1 new mark (M1)')
  expect(await term()).not.toContain('> ')
  expect((await state()).marks[0].status).toBe('draft')
  // The keyboard is in the terminal, where Enter sends the line.
  await expect(page.locator('.session-term textarea')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(term).toMatch(/> .*torno: 1 new mark \(M1\)/)
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
  // What is said is what is known: that Enter was pressed, not that the agent has the marks.
  await expect(told().locator('p')).toHaveText('Enter was pressed with the line at the prompt. Whether the agent read the file, torno cannot see.')
  await expect(dock().getByRole('button', { name: /^Send/ })).toHaveCount(0)
  // It was sent a line: its conversation is on file as Copilot's, and as one that was told.
  await expect.poll(() => JSON.parse(readFileSync(join(root, 'plain', '.torno', 'session.json'), 'utf8'))).toMatchObject({ agent: 'copilot', told: true })
})

test('the header keeps to the width of the dock, with the agent, where it stands and the list to choose from', async () => {
  await hookless('bracket')
  await draft('bracket', 'here')
  await expect(sendButton()).toBeVisible()
  const fits = await dock().locator('.session-head').evaluate((head) => ({ wide: head.scrollWidth, room: head.clientWidth }))
  expect(fits.wide).toBeLessThanOrEqual(fits.room)
  const strip = await told().evaluate((el) => ({ wide: el.scrollWidth, room: el.clientWidth }))
  expect(strip.wide).toBeLessThanOrEqual(strip.room)
})

test('something typed after the line leaves the marks drafts, says why, and the line is offered again', async () => {
  await hookless('gauge')
  const id = await draft('gauge', 'this face, 2 mm thicker')
  await sendMarks()
  // While the line waits, the file it names follows the marks.
  await page.evaluate((mark) => window.torno.marks.update('gauge', mark, { note: 'this face, 3 mm thicker' }), id)
  await expect.poll(() => promptFile('gauge')).toContain('3 mm thicker')
  // Moving along the line changes nothing; a letter may be an answer to something else.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Home')
  await expect(told()).toContainText('A line is at the cursor')
  await page.keyboard.type('y')
  await expect(told().locator('p')).toHaveText('Something was typed after the line, so the marks are still drafts: use "Send marks" again.')
  await page.keyboard.press('Enter')
  await expect.poll(async () => ((await term()).match(/> /g) ?? []).length).toBe(1)
  expect(await statusOf(id)).toBe('draft')
  // The line went all the same, with the letter after it, and it names the file: the file is as it was written (the sweep's finding 16).
  expect(promptFile('gauge')).toContain('3 mm thicker')
  // Asked again, and sent as it was put there.
  await sendMarks()
  expect(promptFile('gauge')).toContain('3 mm thicker')
  await page.keyboard.press('Enter')
  await expect.poll(() => statusOf(id)).toBe('sent')
})

test('lines pasted after the line leave the marks drafts: a line break in a paste sends nothing', async () => {
  await hookless('morph')
  const id = await draft('morph', 'here')
  await sendMarks()
  // As a paste of two lines reaches the agent while it has bracketed paste on.
  const session = (await state()).sessions.morph.sessionId
  await page.evaluate((to) => window.torno.session.write(to, '\x1b[200~Traceback (most recent call last):\r  File "lid.py", line 3\x1b[201~'), session)
  await expect(told().locator('p')).toHaveText('Something was typed after the line, so the marks are still drafts: use "Send marks" again.')
  expect(await statusOf(id)).toBe('draft')
  expect(existsSync(join(root, 'morph', '.torno', 'session.json'))).toBe(false)
})

test('Enter while the agent has a question up in place of its prompt leaves the marks drafts, and says so', async () => {
  await hookless('makers')
  const id = await draft('makers', 'here')
  // As a CLI that asks whether the folder is trusted: what is typed is not shown at a prompt.
  await page.locator('.session-term textarea').focus()
  await page.keyboard.type('dialog')
  await page.keyboard.press('Enter')
  await expect.poll(term).toContain('dialog: up')
  await sendButton().click()
  await expect(told()).toContainText('A line is at the cursor')
  await page.keyboard.press('Enter')
  await expect.poll(term).toContain('dialog: answered')
  await expect(told().locator('p')).toHaveText('The line was not at the prompt when Enter was pressed, so the marks are still drafts: use "Send marks" again.')
  expect(await statusOf(id)).toBe('draft')
  expect(await term()).not.toContain('torno: 1 new mark')
  // At the prompt, it goes.
  await sendMarks()
  await page.keyboard.press('Enter')
  await expect.poll(() => statusOf(id)).toBe('sent')
})

test('ending a session whose agent does not say whether it works is asked about; the choice cannot be changed under it', async () => {
  await hookless('measures')
  const [agent] = agentsIn(join(root, 'measures'))
  await dock().getByRole('button', { name: 'New session' }).click()
  const ask = dock().getByRole('alertdialog', { name: 'End the running session?' })
  await expect(ask).toContainText('Copilot CLI may be working: torno cannot tell. A new session ends this one.')
  await ask.getByRole('button', { name: 'Keep it' }).click()
  expect(agentsIn(join(root, 'measures'))).toEqual([agent])
  // Main refuses whatever the window asks while the session runs.
  const refused = await page.evaluate(() => window.torno.session.chooseAgent('measures', 'claude').then(() => 'chosen', (e: Error) => e.message))
  expect(refused).toContain('End the session first')
  expect(chosenOnDisk('measures')).toBe('copilot')
  const unknown = await page.evaluate(() => window.torno.session.chooseAgent('measures', 'gemini' as never).then(() => 'chosen', (e: Error) => e.message))
  expect(unknown).not.toBe('chosen')
})

test('choosing another agent while a session runs asks, ends that session, and starts none', async () => {
  await hookless('spread')
  // A line of the person's own: there is a conversation of Copilot's to resume.
  await page.locator('.session-term textarea').focus()
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect.poll(() => existsSync(join(root, 'spread', '.torno', 'session.json'))).toBe(true)
  const [agent] = agentsIn(join(root, 'spread'))
  await picker().selectOption('claude')
  const ask = dock().getByRole('alertdialog', { name: 'End the running session?' })
  await expect(ask).toContainText('Copilot CLI may be working: torno cannot tell. Choosing another agent ends this session, and starts none.')
  await expect(ask.getByRole('button')).toHaveText(['Keep it', 'End it and choose Claude Code'])
  // Nothing has been ended or chosen by asking.
  await expect(picker()).toHaveValue('copilot')
  expect(chosenOnDisk('spread')).toBe('copilot')
  await ask.getByRole('button', { name: 'Keep it' }).click()
  await expect(ask).toHaveCount(0)
  expect(agentsIn(join(root, 'spread'))).toEqual([agent])
  await expect(picker()).toHaveValue('copilot')

  await picker().selectOption('claude')
  await ask.getByRole('button', { name: 'End it and choose Claude Code' }).click()
  await expect.poll(() => chosenOnDisk('spread')).toBe('claude')
  await expect(picker()).toHaveValue('claude')
  await expect(status()).toHaveText('Ended')
  await expect.poll(() => agentsIn(join(root, 'spread'))).toEqual([])
  // Its conversation was Copilot's: Claude Code is not offered it to resume.
  await expect(dock().getByRole('button', { name: 'Resume' })).toHaveCount(0)
  await expect(told()).toHaveCount(0)
  // A session of Claude Code is as it ever was: its hooks, its status, no strip. Its terminal is chosen, as the person can.
  await dock().getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal' }).click()
  await dock().getByRole('button', { name: 'New session' }).click()
  await expect.poll(term).toContain('--settings')
  await expect(status()).toHaveText('Idle')
  await expect(dock().getByRole('heading', { name: 'Claude Code' })).toBeVisible()
  await expect(told()).toHaveCount(0)
  expect(JSON.parse(readFileSync(join(root, 'spread', '.torno', 'session.json'), 'utf8')).agent).toBe('copilot')
})

test('another object has its own agent; a file that names one torno does not know is said, and choosing clears it', async () => {
  await open('bracket')
  await picker().selectOption('copilot')
  await expect.poll(() => chosenOnDisk('bracket')).toBe('copilot')
  await open('hollow')
  await expect(picker()).toHaveValue('claude')
  await expect(told().locator('p')).toHaveText('agent.json names "gemini", which torno does not know: Claude Code is used.')
  // The file is the person's until they choose: it is as it was.
  expect(chosenOnDisk('hollow')).toBe('gemini')
  // Claude Code is what the list already shows: it is chosen with the button beside the note.
  await told().getByRole('button', { name: 'Use Claude Code' }).click()
  await expect.poll(() => chosenOnDisk('hollow')).toBe('claude')
  await expect(told()).toHaveCount(0)
  await expect(picker()).toHaveValue('claude')
  await open('bracket')
  await expect(picker()).toHaveValue('copilot')
})

test('leaving the folder while an agent that does not say runs is asked about, as what it is', async () => {
  await hookless('hollow')
  await app.evaluate((_electron, dir) => {
    ;(globalThis as unknown as { __tornoMain: { pickFolder: string | null } }).__tornoMain.pickFolder = dir
  }, other)
  // The folder button is a menu now: the dialog is one of its ways.
  await left().getByRole('button', { name: 'Folders' }).click()
  await left().getByRole('menuitem', { name: 'Open folder…' }).click()
  const ask = left().getByRole('alertdialog', { name: 'End the sessions of this folder?' })
  await expect(ask).toContainText('A session here may be in the middle of its work: its agent does not say. Opening another folder ends it.')
  await ask.getByRole('button', { name: 'Stay here' }).click()
  expect((await state()).workspace?.root).toBe(root)
  expect(agentsIn(join(root, 'hollow'))).toHaveLength(1)
})

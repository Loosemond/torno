import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { TornoState } from '../src/renderer/state/store'

// What the chat asks of the person and what it offers: a permission request, the questions of `AskUserQuestion`
// and a plan, each a card that is answered; "Attach view"; the `/` commands the CLI named; the model of the session;
// the rate line. The agent is the stand-in in its stream mode (test/fake-agent.mjs). The window is hidden: everything
// is read from the DOM and the store, never from pixels.
const appDir = resolve(__dirname, '..')
const fixtures = resolve(appDir, '../kernel/tests/fixtures/ws')
const fakeAgent = resolve(appDir, 'test/fake-agent.mjs')

test.describe.configure({ mode: 'serial' })

let root: string
let home: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-chatask-'))
  home = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-chatask-home-'))
  cpSync(fixtures, root, { recursive: true, filter: (source) => !source.endsWith('__pycache__') })
  // TORNO_TEST=1 makes main create the window with show: false. Never launch without it. The home is a folder of
  // this run: nothing of the settings of the person's own Claude Code may be written there, or anywhere.
  app = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, HOME: home, TORNO_TEST: '1', TORNO_AGENT_CMD: `node ${fakeAgent}`, TORNO_WORKSPACE: root } })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const state = (): Promise<TornoState> => page.evaluate(() => window.__tornoTest!.state())
const dock = () => page.locator('[data-region="session"]')
const chat = () => dock().locator('.chat')
const composer = () => dock().locator('[data-chat-composer]')
const turns = () => chat().locator('.chat-turn')
const asks = () => chat().locator('.chat-ask')
const status = () => dock().getByRole('status').first()

/** Write a prompt in the box and send it, as a person does. */
async function say(prompt: string): Promise<void> {
  await composer().focus()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
}

/** What a tool of the agent's was given back, opened out. */
async function resultOf(tool: Locator): Promise<string> {
  if ((await tool.locator('.chat-tool-line').getAttribute('aria-expanded')) !== 'true') await tool.locator('.chat-tool-line').click()
  return (await tool.textContent()) ?? ''
}

/** The turns that have ended in this session so far; `finished` waits for one more. */
let ended = 0
async function finished(): Promise<void> {
  ended += 1
  await expect(turns()).toHaveCount(ended)
}

async function newSession(): Promise<void> {
  ended = 0
  await dock().getByRole('button', { name: 'New session' }).click()
  await expect(composer()).toBeEnabled()
}

test('a request to use a tool is a card with the input, answered with Allow, Always allow or Deny and a reason', async () => {
  await page.getByRole('button', { name: 'bracket', exact: true }).click()
  await expect.poll(async () => (await state()).build, { timeout: 30_000 }).toMatchObject({ status: 'ok', revision: 1 })
  await dock().getByRole('button', { name: 'New session' }).click()
  await expect(chat()).toBeVisible()

  await say('ask Bash {"command":"ls"}')
  const card = asks().last()
  await expect(card).toContainText('Claude Code asks to use Bash')
  await expect(card.locator('.chat-ask-input')).toHaveText('ls')
  await expect(card).toHaveAttribute('data-state', 'open')
  await expect(status()).toHaveText('Needs input')
  await expect(card.getByRole('button', { name: 'Allow', exact: true })).toHaveClass(/button-primary/)
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveAttribute('data-state', 'allowed')
  await expect(card).toContainText('Allowed')
  await expect(card.getByRole('button')).toHaveCount(0)
  await finished()
  await expect(turns().last()).toContainText('Done in')
  await expect(status()).toHaveText('Idle')
  const allowed = await resultOf(chat().locator('.chat-tool').last())
  expect(allowed).toContain('allowed: {"command":"ls"}')
  // "Allow" alone passes no permission on.
  expect(allowed).not.toContain('permissions:')

  // Write: the file and a few lines of what it will hold. Deny, with a reason.
  await say('ask Write {"file_path":"notes/a.txt","content":"one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight"}')
  const write = asks().last()
  await expect(write).toContainText('Claude Code asks to use Write')
  await expect(write.locator('.chat-ask-input')).toContainText('notes/a.txt')
  await expect(write.locator('.chat-ask-input')).toContainText('three')
  await expect(write.locator('.chat-ask-input')).not.toContainText('eight')
  await write.getByLabel('Reason (optional)').fill('not there, please')
  await write.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(write).toHaveAttribute('data-state', 'denied')
  await expect(write).toContainText('Denied')
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('denied: not there, please')

  // Deny with nothing typed says so in a sentence of its own.
  await say('ask Edit {"file_path":"b.txt","old_string":"a","new_string":"b"}')
  await asks().last().getByRole('button', { name: 'Deny', exact: true }).click()
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('denied: The person denied this.')

  // Always allow passes on the suggestions the CLI sent, as they came.
  await say('ask Bash {"command":"pwd"}')
  const always = asks().last()
  await always.getByRole('button', { name: 'Always allow', exact: true }).click()
  await expect(always).toContainText('Allowed')
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('permissions: [{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"session"}]')
})

test('a card takes the focus only when nothing is being written: not from a prompt in the box', async () => {
  // Sent with the button: the box is empty and has not the focus, so the card has it.
  await composer().focus()
  await page.keyboard.type('ask Bash {"command":"date"}')
  await dock().getByRole('button', { name: 'Send', exact: true }).click()
  const card = asks().last()
  await expect(card).toHaveAttribute('data-state', 'open')
  await expect(card).toBeFocused()
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card).toHaveAttribute('data-state', 'allowed')
  await finished()

  // The next prompt is being written when the request comes: the box keeps the focus.
  await composer().focus()
  await page.keyboard.type('slow 1')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('ask Bash {"command":"id"}')
  await page.keyboard.press('Enter')
  await page.keyboard.type('draft')
  const late = asks().last()
  await expect(late).toHaveAttribute('data-state', 'open', { timeout: 10_000 })
  await expect(composer()).toBeFocused()
  await expect(composer()).toHaveValue('draft')
  await late.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(late).toHaveAttribute('data-state', 'allowed')
  await finished()
  await composer().fill('')
})

test('the questions of AskUserQuestion are one card: radio-like buttons, toggles joined by a comma, an Other line, and Submit once all are answered', async () => {
  const input = {
    questions: [
      { question: 'Which wall?', header: 'Wall', multiSelect: false, options: [{ label: '2 mm', description: 'thin' }, { label: '3 mm', description: 'thick' }] },
      { question: 'Finish?', header: 'Finish', multiSelect: true, options: [{ label: 'Matte', description: 'dull' }, { label: 'Gloss', description: 'shiny' }, { label: 'Brushed', description: 'lined' }] }
    ]
  }
  await say(`ask AskUserQuestion ${JSON.stringify(input)}`)
  const card = asks().last()
  await expect(card).toContainText('Which wall?')
  await expect(card).toContainText('Finish?')
  await expect(card).toContainText('thick')
  const submit = card.getByRole('button', { name: 'Submit', exact: true })
  await expect(submit).toBeDisabled()
  await expect(status()).toHaveText('Needs input')

  // One of a single choice: choosing another takes the first back.
  await card.getByRole('button', { name: /^2 mm/ }).click()
  await card.getByRole('button', { name: /^3 mm/ }).click()
  await expect(card.getByRole('button', { name: /^2 mm/ })).toHaveAttribute('aria-pressed', 'false')
  await expect(card.getByRole('button', { name: /^3 mm/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(submit).toBeDisabled()
  // As many as are toggled on, joined.
  await card.getByRole('button', { name: /^Matte/ }).click()
  await card.getByRole('button', { name: /^Gloss/ }).click()
  await card.getByRole('button', { name: /^Brushed/ }).click()
  await card.getByRole('button', { name: /^Brushed/ }).click()
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(card).toHaveAttribute('data-state', 'allowed')
  await expect(card).toContainText('Which wall?')
  await expect(card).toContainText('3 mm')
  await expect(card).toContainText('Matte, Gloss')
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('"answers":{"Which wall?":"3 mm","Finish?":"Matte, Gloss"}')

  // The Other line is an answer of its own: its text, in place of what was chosen.
  await say(`ask AskUserQuestion ${JSON.stringify({ questions: [input.questions[0]] })}`)
  const other = asks().last()
  await other.getByRole('button', { name: /^2 mm/ }).click()
  await other.getByLabel('Other answer to Which wall?').fill('2.5 mm')
  await expect(other.getByRole('button', { name: /^2 mm/ })).toHaveAttribute('aria-pressed', 'false')
  await other.getByRole('button', { name: 'Submit', exact: true }).click()
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('"answers":{"Which wall?":"2.5 mm"}')
})

test('a plan is drawn as markdown, approved or kept for more planning with a reason', async () => {
  await say('ask ExitPlanMode {"plan":"# The plan\\n- widen the wall\\n- rebuild"}')
  const plan = asks().last()
  await expect(plan).toContainText('Claude Code asks to leave plan mode')
  await expect(plan.locator('li')).toHaveCount(2)
  await expect(plan.locator('li').first()).toHaveText('widen the wall')
  await expect(plan.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await plan.getByLabel('Reason (optional)').fill('make it 3 mm')
  await plan.getByRole('button', { name: 'Keep planning', exact: true }).click()
  await expect(plan).toHaveAttribute('data-state', 'denied')
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('denied: make it 3 mm')

  await say('ask ExitPlanMode {"plan":"- just do it"}')
  const again = asks().last()
  await again.getByRole('button', { name: 'Approve plan', exact: true }).click()
  await expect(again).toContainText('Approved')
  await finished()
  expect(await resultOf(chat().locator('.chat-tool').last())).toContain('allowed: {"plan":"- just do it"}')
})

test('a request still open when the session ends says it was not answered', async () => {
  await say('ask Bash {"command":"sleep 100"}')
  const card = asks().last()
  await expect(card).toHaveAttribute('data-state', 'open')
  await dock().getByRole('button', { name: 'End session' }).click()
  // Ending a session that waits for an answer asks first.
  await page.getByRole('button', { name: 'End it', exact: true }).click()
  await expect(status()).toHaveText('Ended')
  await expect(card).toHaveAttribute('data-state', 'ended')
  await expect(card).toContainText('Not answered: the session ended')
  await expect(card.getByRole('button')).toHaveCount(0)
})

test('Attach view adds a picture of the viewport at 1280 px to the next prompt only, and the prompt shows it', async () => {
  await newSession()
  const attach = dock().getByRole('button', { name: 'Attach view' })
  await expect(attach).toHaveAttribute('aria-pressed', 'false')
  await attach.click()
  await expect(attach).toHaveAttribute('aria-pressed', 'true')
  await say('images')
  // Off after each send.
  await expect(attach).toHaveAttribute('aria-pressed', 'false')
  const user = chat().locator('.chat-user').first()
  await expect(user.locator('.chat-thumb')).toHaveCount(1, { timeout: 20_000 })
  await expect(chat().locator('.chat-text').first()).toContainText(/images: 1 (1280x\d+|\d+x1280)/, { timeout: 20_000 })
  await expect(turns().first()).toContainText('Done in')

  // The next prompt carries none.
  await say('images')
  await expect(chat().locator('.chat-text').last()).toContainText('images: 0')
  await expect(chat().locator('.chat-user').last().locator('.chat-thumb')).toHaveCount(0)
})

test('typing a / command offers the commands the CLI named: arrows choose, Tab or a click completes to the name and a space', async () => {
  await composer().focus()
  await page.keyboard.type('/co')
  const offered = chat().getByRole('listbox', { name: 'Commands' })
  await expect(offered).toBeVisible()
  await expect(offered.getByRole('option')).toHaveCount(1)
  await expect(offered.getByRole('option').first()).toContainText('compact')
  await expect(offered.getByRole('option').first()).toContainText('Compact the conversation')
  await page.keyboard.press('Tab')
  await expect(composer()).toHaveValue('/compact ')
  await expect(composer()).toBeFocused()
  // A space after the word: it is an argument now, and nothing is offered.
  await expect(offered).toHaveCount(0)

  await composer().fill('/c')
  await expect(offered.getByRole('option')).toHaveCount(2)
  await expect(offered.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(offered.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Tab')
  await expect(composer()).toHaveValue('/clear ')

  await composer().fill('/')
  await offered.getByRole('option', { name: /compact/ }).click()
  await expect(composer()).toHaveValue('/compact ')
  await expect(composer()).toBeFocused()
  // Text that is no command word offers nothing.
  await composer().fill('see /co')
  await expect(offered).toHaveCount(0)
  await composer().fill('/zzz')
  await expect(offered).toHaveCount(0)
  await composer().fill('')
})

test('the model menu lists what the CLI offers, changes the model of the session only, and writes nothing under the home', async () => {
  const menu = dock().getByRole('combobox', { name: 'Model' })
  await expect(menu.locator('option')).toHaveText(['fake-model', 'Default', 'Haiku'])
  await expect(menu).toHaveValue('fake-model')
  await menu.selectOption({ label: 'Haiku' })
  // The next answer says it was given by the model chosen.
  await say('say with the new model')
  await expect(turns().last()).toContainText('Done in')
  await expect(menu).toHaveValue('haiku')
  // Nothing of Claude Code's settings was written, here or in the home of this run.
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/claude/i.test(entry.name)) found.push(join(dir, entry.name))
      if (entry.isDirectory() && depth < 3) walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(home, 0)
  expect(found).toEqual([])
})

test('the foot says, quietly, when a window of the rate limit is half used or more', async () => {
  await expect(chat().locator('.chat-rate')).toHaveCount(0)
  await say('rate 72')
  const line = chat().locator('.chat-rate')
  await expect(line).toContainText('5-hour limit: 72 % used, resets at ')
  await expect(line).toContainText(/resets at \d{1,2}[:.]\d{2}/)
  await expect(line.locator('.num').first()).toBeVisible()
  await expect(turns().last()).toContainText('Done in')
  await say('rate 30')
  await expect(line).toHaveCount(0)
})

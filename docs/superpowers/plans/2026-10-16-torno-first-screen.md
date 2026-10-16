# First screen: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The screen shown with no folder open says what to do in one look: one main action ("Open folder"), the
idea of "the folder that holds your objects" drawn as a small tree, not told in three paragraphs, and, for someone
coming back, the recent folders first.

**Architecture:** Renderer only. `ui/Welcome.tsx` is rewritten in two states picked by whether `workspace.recent()`
has anything: *first run* (tagline, the tree, the ways in) and *returning* (the recent folders, then the ways in).
The two pure parts it has (a folder's name, the wording of a failed open) move into `ui/welcome.ts` with a unit test.
Main is not touched: the folder dialog already offers to make a folder (`properties: ['openDirectory',
'createDirectory']` in `main/ipc.ts` `workspace:pick`), and an empty folder already opens on "New object"
(`ui/ShowPage.tsx`).

**Tech Stack:** React, TypeScript, CSS on `styles/tokens.css`; vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` section 10 (the look); Issue #15.

## Global Constraints

- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1` (`show: false`); never
  `--ozone-platform=headless`, never `page.screenshot()`, never the clipboard (`app/e2e/CLAUDE.md`).
- Never run a real agent CLI from tests: `TORNO_AGENT_CMD` is `node app/test/fake-agent.mjs`.
- No new npm dependency. No new image file: the tree is markup.
- Every key is a row of `shared/keys.ts`; a hint is `hint(id)`, never a literal key.
- UI text is sentence case. Every number, path and file name is in the monospace face (`num` class or `numbered()`).
- Colours, spacing and type from `styles/tokens.css` only. No endless animation. Not nerv's look: no black/red/amber,
  no condensed uppercase labels, no corner-tick frames.
- Keep the logo head (`ui/Logo.tsx`: the vise in `--ink`, the part in `--accent`) and its e2e check.
- Never write inside a user workspace; this change writes nothing anywhere.
- Stage explicit paths (`git add <file> …`), never `git add -A`.
- Before each commit run the four suites: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`,
  `pnpm test:e2e`, plus `pnpm -C app typecheck`. Commit after every task; the message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (confirmed 2026-10-16)

Confirmed on #15: Every recommendation below holds, but for decision 3, changed: the line under "Open folder" makes no promise about the dialog (Electron's `createDirectory` is macOS only, and the Linux chooser cannot be checked from a test). It reads "An empty folder is fine: torno helps you make the first object."

Each is the issue's "To brainstorm" question, the recommendation, the reason, the alternative. **(changes tasks)**
marks those whose other answer changes the tasks.

1. **Who is it for: two screens?** One component, two states: first run (no recent folder) and returning (any
   recent folder). Same place in `App.tsx`, no new routing; the returning state drops the explanation, which someone
   who has opened a folder no longer needs. Alternative: two components, or a returning screen that is the list
   alone. **(changes tasks: Task 2's layout and its e2e)**
2. **The main idea.** A three-line tree in the monospace face (`objects/` the folder you open, `bracket/` an object,
   `bracket.py` its model), each line with a muted label beside it. It shows the nesting a sentence has to explain.
   Alternative: explain only after a folder is picked (the empty page already does). **(changes tasks)**
3. **Making the folder.** No new button: one line under "Open folder" says an empty folder is fine ("An empty folder
   is fine: torno helps you make the first object."). It makes no promise about the dialog: Electron honours
   `createDirectory` on macOS only, and no test can check the Linux chooser. A torno-made folder would need a new
   bridge call, a place to put it and the workspace rule to be widened. Alternative: "Start a new folder for my
   objects" (a name field + `workspace.create` in main writing `~/objects`). **(changes tasks: adds a main task,
   a bridge call, a vitest of main and an e2e, and a change to the root CLAUDE.md's write rule)**
4. **First object.** No jump: an empty folder opens on the page of objects, whose empty state has "New object" as
   its primary button already, one click away; jumping would hide that the folder is now open. The page around New
   object is #16's. Alternative: open the New object page straight away when the folder chosen has no object.
   **(changes tasks: an `App.tsx` step and an e2e assertion)**
5. **The example.** A quiet button (`button button-quiet`) "Open the example", after the main one, with its
   note "A temporary copy, removed when torno quits." beside it. It is for trying, not the way in. Alternative:
   keep it a second full button.
6. **The `.torno` promise.** Keep it, as the one footer line, in fewer words: it is a trust signal best read before
   choosing a folder. Alternative: move it to the empty page of objects (`ShowPage.tsx`), where torno first writes.
7. **Keys.** Drop the hint from this screen; `?` still opens the sheet here (the e2e keeps that check), and the hint
   is in the left column once a folder is open. Nothing here needs a key. Alternative: keep it as a footer.
   (Coordinate with #19, duplicated key hints.)

## Design

A single column centred in the viewport region, `max-width: 34rem`, gaps from the spacing tokens; left-aligned text.

**First run** (`recent.length === 0`), top to bottom:

1. Head: `<Logo />` over `<h1 class="wordmark">torno</h1>` (unchanged).
2. Tagline, one `<p class="welcome-tagline">`: **"Make CAD parts with an AI agent: it writes the model, you point at
   what to change."**
3. The tree, `<figure class="welcome-tree" aria-label="How a folder of objects is laid out">`, three rows, indented
   by depth, each a `num` name and a muted label:
   - `objects/` — "the folder you open"
   - `bracket/` — "an object"
   - `bracket.py` — "its model, in build123d"
4. The ways in, `.welcome-ways`:
   - `button button-primary` **"Open folder"** (name kept: README, FolderMenu and the e2e use it).
   - Under it, `<p class="welcome-note">`: **"An empty folder is fine: torno helps you make the first object."**
   - When `hasExample()`: `button button-quiet` **"Open the example"**, then `<span class="welcome-note">`
     **"A temporary copy, removed when torno quits."** (the `title` tooltip stays as it is).
5. Problem (unchanged): `<p class="welcome-problem" role="alert">` with "<what> could not be opened: <reason>".
6. Footer, one line: **"torno writes only into a `.torno` folder inside each object."** (`.torno` in `num`).

**Returning** (`recent.length > 0`): head, tagline, then `<nav aria-label="Recent folders">` with
`<h2 class="section-title">Recent folders</h2>` and the rows exactly as today (name, `num` path, a missing one struck
with "Not found" and "Remove"), then the ways in (without the empty-folder note), then the footer. No tree.

The list is read again on window focus as today; removing the last recent folder turns the screen to the first-run
state, which is right. While `recent()` has not answered the screen shows the head only, so first-run text does not
flash for someone returning (`recent` starts `null`, not `[]`).

## Tasks

### Task 1: the pure parts of the first screen, under test

**Files:**
- Create: `app/src/renderer/ui/welcome.ts`
- Create: `app/src/renderer/ui/welcome.test.ts`
- Modify: `app/src/renderer/ui/Welcome.tsx` (import them)

- [ ] **Step 1: the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { nameOf, openProblem } from './welcome'

describe('the first screen', () => {
  it('names a folder by its last part, trailing separators and all', () => {
    expect(nameOf('/home/a/objects/')).toBe('objects')
    expect(nameOf('C:\\parts')).toBe('parts')
    expect(nameOf('/')).toBe('/')
  })
  it('says why a folder could not be opened without the IPC wrapping', () => {
    expect(openProblem('The example', new Error("Error invoking remote method 'workspace:open': Error: gone"))).toBe('The example could not be opened: gone')
    expect(openProblem('parts', 'no')).toBe('parts could not be opened: no')
  })
})
```

- [ ] **Step 2:** `pnpm -C app exec vitest run src/renderer/ui/welcome.test.ts` fails (no module).
- [ ] **Step 3: implement** `welcome.ts` with `nameOf` moved from `Welcome.tsx` and
  `openProblem(what: string, e: unknown): string` holding the wording now inline in `open`. `Welcome.tsx` imports both.
- [ ] **Step 4:** the test passes; `pnpm -C app typecheck`.
- [ ] **Step 5: commit**: `git add app/src/renderer/ui/welcome.ts app/src/renderer/ui/welcome.test.ts app/src/renderer/ui/Welcome.tsx`,
  "First screen: a folder's name and a failed open's wording, under test".

### Task 2: the first screen redone

**Files:**
- Modify: `app/e2e/welcome.spec.ts` (tests 1 and 2)
- Modify: `app/src/renderer/ui/Welcome.tsx`
- Modify: `app/src/renderer/styles/welcome.css`

- [ ] **Step 1: the failing e2e.** In test 1 ("the first run …"), rename it to "the first run shows what to open and
  how a folder of objects is laid out, and a folder with nothing in it says what to make", and replace the three
  paragraph assertions, the `.welcome-says p` count and the keys-hint assertion with:

```ts
await expect(says).toContainText('Make CAD parts with an AI agent: it writes the model, you point at what to change.')
const tree = first.getByRole('figure', { name: 'How a folder of objects is laid out' })
await expect(tree.locator('.num')).toHaveText(['objects/', 'bracket/', 'bracket.py'])
await expect(tree).toContainText('the folder you open')
await expect(says).toContainText('An empty folder is fine: torno helps you make the first object.')
await expect(says).toContainText('A temporary copy, removed when torno quits.')
await expect(says).toContainText('torno writes only into a .torno folder inside each object.')
await expect(says).not.toContainText('for the keys')
// The main way in is the one primary button; the example is a quiet one.
await expect(first.locator('.welcome-page .button-primary')).toHaveText(['Open folder'])
await expect(first.getByRole('button', { name: 'Open the example' })).toHaveClass(/button-quiet/)
```

  Keep the logo check, `toHaveText(['Open folder', 'Open the example'])` for the buttons, the `?` sheet check and
  everything after "Open folder" is clicked. In test 2 (recent folders) add, after the list count:

```ts
// Coming back, the list is what is shown first, and the explanation is not.
await expect(first.getByRole('figure', { name: 'How a folder of objects is laid out' })).toHaveCount(0)
await expect(first.locator('.welcome-page').getByText('An empty folder is fine', { exact: false })).toHaveCount(0)
```

- [ ] **Step 2:** `pnpm build && pnpm -C app exec playwright test e2e/welcome.spec.ts` fails on the new text.
- [ ] **Step 3: implement `Welcome.tsx`.** `recent` state becomes `RecentFolder[] | null` (null until answered;
  render only the head while null). `const returning = recent !== null && recent.length > 0`. Render per the Design:
  tagline; `{!returning && <Tree />}` (a local component, a `<figure>` of three `<div class="tree-row" style={{'--depth': n}}>`
  each `<span className="num">…</span><span className="tree-label">…</span>`); recent `<nav>` when `returning`, before
  the ways; the ways; the note under "Open folder" only when `!returning`; the example as `button button-quiet` with
  its note span; the problem; the one footer. Remove the `hint` import and the keys paragraph. Update the doc comment.
- [ ] **Step 4: `welcome.css`.** Drop `.welcome-says`; add `.welcome-tagline` (`--ink`, the body size up one step),
  `.welcome-tree` (`--panel` ground, `1px solid var(--hairline)`, radius token, padding), `.tree-row`
  (`padding-left: calc(var(--depth) * 1.25rem)`, grid of name and label), `.tree-label` (`--muted`);
  `.welcome-ways` as a column with the quiet button and its note on one row. Only tokens; check both themes by the
  existing themes capture if `e2e/themes.spec.ts` covers the first screen (grep `welcome` there and run it).
- [ ] **Step 5:** the e2e passes; `pnpm test`, `pnpm -C app typecheck`; then the four suites.
- [ ] **Step 6: commit**: `git add app/e2e/welcome.spec.ts app/src/renderer/ui/Welcome.tsx app/src/renderer/styles/welcome.css`,
  "First screen redone: one way in, the folder of objects drawn as a tree, the recent folders first when coming back".

### Task 3: the docs

**Files:**
- Modify: `app/src/renderer/CLAUDE.md` ("The first screen", first bullet)
- Modify: `README.md` (the paragraph "With no folder to open, the first screen …", near line 78)
- Check: `docs/superpowers/specs/2026-10-08-torno-design.md` (grep `first screen`, `Welcome`: today it does not
  describe the screen; add nothing unless it does)

- [ ] **Step 1:** renderer CLAUDE.md's first bullet becomes: "With no folder open the window is `ui/Welcome.tsx`. On
  a first run (no recent folder): a line of what torno is, a three-row tree of the folder of objects, an object and
  its model, "Open folder" with a note that an empty folder is fine, and, where torno runs from its repository, a quiet
  "Open the example". Coming back: the recent folders first, no tree. One footer: torno writes only into `.torno`.
  Its head is the logo …" (keep the logo sentences as they are).
- [ ] **Step 2:** README: "the first screen says what torno is, draws how a folder of objects is laid out and offers
  "Open folder" (an empty one is fine) and "Open the example" …; coming back, it lists the folders opened lately first."
- [ ] **Step 3:** `pnpm -C app exec vitest run src/readme.test.ts` passes (headings and keys unchanged).
- [ ] **Step 4: commit**: `git add app/src/renderer/CLAUDE.md README.md`, "Docs: the first screen as redone".

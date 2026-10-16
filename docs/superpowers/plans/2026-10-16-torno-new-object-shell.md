# The window while a new object is made: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the New object page is up, the whole shell is about the object being made: the session pane says what
Claude Code will start with instead of offering New session and Resume for the object that was open, the list selects
nothing, the Marks section gives way, and the status line says "New object" with no Rebuild, revision, parts or
Export. A session of the previous object that is still running, or waiting on a question, stays in full view.

**Architecture:** Everything reads `store.page === 'new'` (`state/store.ts`) and the draft (`state/onboard.ts`). A pure
`draftSummary(draft)` words what is given; a small `ui/onboard/DraftPane.tsx` shows it in the session pane in place of
`session-empty`. `SessionPane.tsx`, `ObjectList.tsx`, `App.tsx` (left column) and `BuildStatus.tsx` each branch on the
page. Nothing in the store under the page changes, so Cancel/Esc brings the previous object back as it was, and Create
goes on through `openObject` as today.

**Tech Stack:** Electron, TypeScript, React, zustand (vanilla stores); vitest (`renderToStaticMarkup`), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (the onboarding and the shell), plus Issue #16.

## Global Constraints

- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1`; never `--ozone-platform=headless`,
  never `page.screenshot()`, never the clipboard (`app/e2e/CLAUDE.md`).
- Never run a real agent CLI from tests: `TORNO_AGENT_CMD` is the stand-in, `node app/test/fake-agent.mjs`.
- No new npm dependency.
- Every key is a row of `shared/keys.ts`; handlers use `pressed`/`which`, never `.key`. This plan adds no key.
- UI text is sentence case. Every number and ref is set in the monospace face (`num` class, `numbered`).
- Colours, spacing and type from `app/src/renderer/styles/tokens.css` only; no CSS animation that never ends
  (`styles/styles.test.ts`); not nerv's look (no black/red/amber, no condensed uppercase labels, no corner ticks).
- No per-frame state in React.
- The session's terminal host (`.session-term`) stays laid out at all times; nothing here unmounts it.
- Nothing of the draft is written to disk; this plan writes nothing in a workspace.
- Stage explicit paths (`git add <file> …`, never `-A` or `.`). Commit after every task, the message ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit run all four suites from the repository root: `pnpm test`, `pnpm test:kernel`,
  `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`, and `pnpm -C app typecheck`.
- Neighbouring plans own: the first screen (#15), mark rows (#17), the tool taxonomy (#18), the Marks empty state's key
  list (#19), part groups (#20), the scans panel (#21), chat pictures (#22). This plan only decides whether the Marks
  section is shown on the New object page, not what it says.

## Decisions (confirmed 2026-10-16)

Confirmed on #16: Every recommendation below holds.

1. **What the right pane shows while you make an object.** Recommended: what Claude Code will be given, filled in live
   (the name, whether there is a brief, "3 photos, 1 doodle, 1 scan, 1 object"), under one line that says it starts
   once you create it. It answers "where does the session go" and doubles as a check of the draft at no cost, since
   the draft is already in a store. Alternative: the one line alone (Task 2 shrinks to the line; Task 1 is dropped).
   Collapsing the pane is not recommended: `dockOpen` is the person's choice and collapsing would hide a live
   session. *Changes the tasks if answered otherwise.*
2. **A running session of the previous object.** Recommended: when it is live (status other than `exited`: `working`,
   `idle`, `needs_input`, …) the pane stays exactly as it is, the chat or terminal and any permission question in full,
   with one note above it: "This is the session of tiago-support. It goes on; the new object gets its own when you
   create it." No draft summary in that case. Hiding or shrinking it could hide a permission question, and the person
   may want to keep talking to it while filling in the form. Alternative: a one-line strip ("tiago-support's session
   is waiting for you", with a Show button) over the draft summary; more code and a question one click away.
   *Changes Task 2 if answered otherwise.* An ended session (`exited`) is treated as none: the draft summary replaces
   its Resume, which stays waiting on the object when you go back.
3. **The whole window.** Recommended: yes, a "new object" state. No row of the list is `aria-current` (the
   "New object" button is already `aria-pressed`); the Marks section is hidden like the layers and scans (no tool
   works on this page); the status line shows "New object" and the build123d version only. Nothing of the previous
   object is presented as if it were acted on. Alternative: keep the list selection and Marks, change only the status
   line. *Changes Task 3 if answered otherwise.*
4. **Going back.** Recommended: no change to the answers. Cancel/Esc goes back to `onboard.from` (`leaveNewObject`),
   and since the store under the page is untouched the selection, marks, status line and session pane come back as
   they were, by the same `page` branch. Create opens the new object (`openObject`), whose pane shows its own session
   and the held prompt as today. A busy previous session is left running on Create too (as it is today when you open
   another object).

## Design

**Session pane, page `new`, no live session of the open object (or none open).** The header reads "Claude Code"
(`AGENT_LABEL`), no status, no End/New session/Resume; the view switch row (`session-views`) is not shown (the view is
a choice of an object, made in its `.torno/agent.json`). The body is `DraftPane`:

> **Claude Code starts here once you create the object.**
> It works in the new folder with what you give it:
>
> - Name: `cable-clip` (or, with none yet: "No name yet")
> - What it is: "Said" / "Not said yet"
> - What you have: `3` photos, `1` doodle, `1` scan, `1` object (or: "Nothing yet")

Counts go through `numbered` (monospace); the name is set `num` as a folder name. Plurals: photo/photos, doodle/doodles,
scan/scans, object/objects; zero kinds are left out.

**Session pane, page `new`, live session of the previous object.** Everything as now, plus above `session-body` a
`p.session-aside[role=note]`: "This is the session of {objectName}. It goes on; the new object gets its own when you
create it."

**Object list.** No `aria-current` on any object row while `page === 'new'`. "New object" stays `aria-pressed`.

**Left column.** `Layers` and `ScansPanel` stay as they are (shown only when `page === 'object'`). `MarksPanel` is
shown when `page !== 'new'`, so it stays on the page of objects, where it says why a card fails.

**Status line.** On page `new`: `<span className="status-name">New object</span>`, the spacer, the build123d version.
No Rebuild, no revision, no dimension counts, no parts, no Export.

**Create.** Unchanged: `makeObject` → `openObject(id)` → page `object`; the pane is the new object's.
**Cancel / Esc.** Unchanged: back to `from`; everything above follows `page`.

## Tasks

### Task 1: `draftSummary`

**Files:** Modify `app/src/renderer/state/onboard.ts`; test `app/src/renderer/state/onboard.test.ts`.

- [ ] Write the failing test:

```ts
import { draftSummary } from './onboard'
it('words what a draft gives, leaving out the kinds it has none of', () => {
  const d = { name: 'cable-clip', description: 'A clip', photos: [{}, {}, {}], doodles: [{}], scans: [{}], objects: [] } as unknown as Draft
  expect(draftSummary(d)).toEqual({ name: 'cable-clip', described: true, given: [[3, 'photos'], [1, 'doodle'], [1, 'scan']] })
  expect(draftSummary({ ...d, name: ' ', description: '', photos: [], doodles: [], scans: [] })).toEqual({ name: null, described: false, given: [] })
})
```

- [ ] Run `pnpm -C app exec vitest run src/renderer/state/onboard.test.ts`: fails (no export).
- [ ] Implement:

```ts
/** What Claude Code will start with, as the session pane says it while the draft is made. */
export function draftSummary(d: Draft): { name: string | null; described: boolean; given: Array<[number, string]> } {
  const words: Array<[Kind, string, string]> = [['photos', 'photo', 'photos'], ['doodles', 'doodle', 'doodles'], ['scans', 'scan', 'scans'], ['objects', 'object', 'objects']]
  return {
    name: d.name.trim() || null,
    described: d.description.trim() !== '',
    given: words.filter(([k]) => d[k].length > 0).map(([k, one, many]) => [d[k].length, d[k].length === 1 ? one : many]),
  }
}
```

- [ ] Run the test again: passes. Commit `state/onboard.ts`, `state/onboard.test.ts`: "Onboard: draftSummary words what a new object starts with".

### Task 2: the session pane on the New object page

**Files:** Create `app/src/renderer/ui/onboard/DraftPane.tsx`, `app/src/renderer/ui/onboard/DraftPane.test.ts`;
modify `app/src/renderer/ui/SessionPane.tsx`, `app/src/renderer/styles/layout.css` (or the stylesheet holding
`.session-empty`).

- [ ] Failing test (`renderToStaticMarkup(createElement(DraftPane, { summary }))`): contains "Claude Code starts here
  once you create the object.", `<span class="num">3</span> photos`, "No name yet" for a null name, "Nothing yet" for
  an empty `given`; and does not contain "New session" or "Resume".
- [ ] Run `pnpm -C app exec vitest run src/renderer/ui/onboard/DraftPane.test.ts`: fails.
- [ ] Implement `DraftPane({ summary })` (pure, props only) and `DraftPaneLive()` reading
  `useOnboard((s) => s.draft)` → `draftSummary` (memoised on the draft).
- [ ] In `SessionPane.tsx`: `const creating = useStore((s) => s.page === 'new')`; `const live = session && session.status !== 'exited'`
  (reuse the existing `ended`/`live` locals where they exist). When `creating && !live`: the header shows no session
  buttons, `session-views` is not rendered, and in `session-body` the `!objectId ? … : !session && …` branch becomes
  `<DraftPaneLive />`. When `creating && live`: render the `session-aside` note above `session-body`. The
  `.session-term` div stays where it is. The `held` banner is of the open object and is hidden while `creating`.
- [ ] Style `.draft-pane` and `.session-aside` with tokens only (muted text, the pane's padding).
- [ ] Run the unit test, `pnpm -C app typecheck`; commit the four files: "Session pane: on the New object page, what Claude Code will start with instead of New session and Resume".

### Task 3: list, left column and status line

**Files:** Modify `app/src/renderer/ui/ObjectList.tsx`, `app/src/renderer/App.tsx`, `app/src/renderer/ui/BuildStatus.tsx`;
test `app/src/renderer/ui/BuildStatus.test.ts`.

- [ ] Failing test in `BuildStatus.test.ts`: with `store.setState({ page: 'new', objectId: 'bracket', build: { status: 'ok', revision: 1, … }, scene: SCENE })`,
  `renderToStaticMarkup(createElement(BuildStatus, { errorOpen: false, onErrorOpen: () => {} }))` contains "New object"
  and none of "Rebuild", "Export", `r1`, "part"; with `page: 'object'` it still has "Rebuild" and "Export…".
- [ ] Run `pnpm -C app exec vitest run src/renderer/ui/BuildStatus.test.ts`: fails.
- [ ] `BuildStatus.tsx`: `const creating = useStore((st) => st.page === 'new')`; when creating render
  `<span className="status-name">New object</span>` in place of the name/build block, and hide Export
  (`objectId !== null && !paged && !creating`).
- [ ] `ObjectList.tsx`: `aria-current={o.id === openId && !creating ? 'true' : undefined}`.
- [ ] `App.tsx`: `{page !== 'new' && <MarksPanel />}`; update the comment above `Layers` to say the marks give way on
  the New object page.
- [ ] Run the test and typecheck; commit the four files: "The list, the marks and the status line give way to the New object page".

### Task 4: e2e

**Files:** Modify `app/e2e/onboard.spec.ts`.

- [ ] Add a test (stand-in agent, hidden window, as the file's `start`): open an object; check the dock shows
  "New session"; click "New object"; expect `dock()` to show "Claude Code starts here once you create the object."
  and no "New session"/"Resume" buttons; fill the name with `cable-clip` and add a photo through the existing
  dialog stub; expect "cable-clip" and "1 photo" in the dock; expect no `[aria-current="true"]` in the Objects nav, no
  `region`/section named Marks, and in `[data-region="status"]` "New object" and no "Rebuild"/"Export…". Press Escape
  (twice, the draft has something: then "Discard") and expect the object row current, Marks, Rebuild and "New session"
  back.
- [ ] Add a second test: start a session with "New session" (the stand-in), then "New object": the session's status
  and End button stay, the note "This is the session of …" shows, and the draft summary does not. Escape back.
- [ ] Run `pnpm build && pnpm -C app exec playwright test e2e/onboard.spec.ts`; then all four suites; commit
  `app/e2e/onboard.spec.ts`: "e2e: the shell while a new object is made, with and without a running session".

### Task 5: docs

**Files:** Modify `app/src/renderer/CLAUDE.md` ("A new object", "Agents"), `README.md` ("Making a new object"),
`docs/superpowers/specs/2026-10-08-torno-design.md` (where it describes the onboarding page).

- [ ] `renderer/CLAUDE.md`, "A new object": the page hides the layers, scans and marks; no row is current; the status
  line is "New object" alone; the session pane shows `DraftPane` (from `draftSummary`) unless the open object's session
  is live, which stays in full with the `session-aside` note. "Agents": the same rule from the pane's side.
- [ ] `README.md`, "Making a new object": one sentence on what the right pane shows while the page is up, and that a
  running session goes on.
- [ ] The design spec: the same, in its words.
- [ ] Run `pnpm -C app exec vitest run src/readme.test.ts` (headings unchanged), then the four suites; commit the three
  files: "Docs: the window while a new object is made".

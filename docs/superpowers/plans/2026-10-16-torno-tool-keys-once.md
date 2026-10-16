# Tool keys shown once: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool's key is shown on the tool palette (its button and tooltip) and on the sheet of keys, and nowhere
else. The empty Marks section stops listing the keys and says what a mark is for and how it reaches the agent.

**Architecture:** One renderer change. `ui/MarksPanel.tsx` drops the `marks-keys` list (built from `TOOLS`) in its
empty state and shows two short sentences instead; `styles/marks.css` drops the `.marks-keys` rules. The palette
(`ui/ToolPalette.tsx`), the sheet (`ui/KeySheet.tsx`) and `shared/keys.ts` are not touched. No key is written in the
new text, so nothing depends on how #18 groups the palette.

**Tech Stack:** React, TypeScript, CSS tokens; Playwright (e2e), vitest (`keys.test.ts`, `readme.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md`; Issue #19. Relates to #18 (Measure makes no mark by
default; the palette grouped into inspecting and marking tools).

## Global Constraints

- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1`; never `--ozone-platform=headless`,
  never `page.screenshot()`, never the clipboard (`app/e2e/CLAUDE.md`).
- No new npm dependency.
- Every key comes from `shared/keys.ts` (`TOOL_KEYS`, `hint(id)`); `keys.test.ts` fails on a key written out in a
  text. The new empty-state text names no key at all.
- UI text is sentence case; keys and numbers in the monospace face (`num`).
- Colours, sizes and spaces from `app/src/renderer/styles/tokens.css` only; not nerv's look (no black/red/amber, no
  condensed uppercase labels, no corner-tick frames).
- Stage explicit paths (`git add <file> ...`), never `git add -A`.
- Commit after every task, the message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit run all four suites: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`,
  `pnpm test:e2e`, and `pnpm -C app typecheck`.

## Decisions (confirmed 2026-10-16)

Confirmed on #19: Every recommendation below holds.

1. **Enough already?** Recommended: yes, the palette (key on the button, key in the tooltip) and `?` are enough; the
   empty Marks section drops its list. The palette is always on screen beside the view, so the list only repeated
   it. Alternative: keep a shortened list (marking tools only). *Changes Task 1 if answered otherwise.*
2. **The empty state.** Recommended: two sentences, no keys: what a mark is and that it goes with the next prompt
   (wording in Design). It answers "what is this section for", which the palette cannot. Alternative: add a small
   picture of a pin on a part, drawn with tokens; left out because the panel is narrow and the view beside it
   already shows the part. *Adding the picture adds a step to Task 1.*
3. **After a split (#18).** Recommended: no tool sits near Marks, grouped or not; the text names no tool key, so it
   holds whichever order #18 and this land in. Alternative: show the marking group's keys in the empty state; it
   would bring back half the repetition this issue removes. *Changes Task 1 if answered otherwise.*
4. **Keys on buttons.** Recommended: keep the badges (`tool-key`). They are how a person learns the keys without
   hovering, they cost a corner of a 32 px button, and the tooltip needs a hover that takes time. Alternative: drop
   the badges and keep tooltips and `?`. *If answered otherwise, add a task: remove the two `tool-key` spans in
   `ui/ToolPalette.tsx` (~81, ~122) and `.tool-key` rules in `styles/tools.css` (~124, ~133), update the comment
   at ToolPalette.tsx:12 and the renderer CLAUDE.md.*

## Design

The empty Marks section (`.marks-empty`, `--muted`, as now) reads, word for word:

> Point at the part to leave a note for the agent.
>
> A mark goes with your next prompt, and stays here until the agent resolves it.

Both are `<p>` in `.marks-empty`; no list, no `kbd`, no picture. The palette keeps its key badges and its tooltips
(`Pin (P)`, from `t.key`), and `?` keeps opening the sheet of keys. Nothing changes in `shared/keys.ts`, so the
README's table of keys (`cheatSheet()`) is unchanged.

Check of the second sentence against the code before writing it: marks not yet sent go with the next prompt
(`sentBefore` in `shared/marks.ts`), and a mark the agent resolved stays in the main list until acknowledged (root
CLAUDE.md). If #17 changes how resolved marks are shown, the sentence still holds.

## Tasks

### Task 1: the empty Marks section says what a mark is for, with no keys

**Files:**
- Modify: `app/e2e/marks.spec.ts` (test "with no marks, the panel says how to leave one", ~120)
- Modify: `app/src/renderer/ui/MarksPanel.tsx` (~97-108; and the `TOOLS` import if nothing else uses it)
- Modify: `app/src/renderer/styles/marks.css` (remove `.marks-keys`, `.marks-keys li`, `.marks-keys kbd`, ~532-557)

- [ ] **Step 1: change the e2e test first.** Replace lines 124-127 with:

```ts
  await expect(panel).toContainText('A mark goes with your next prompt, and stays here until the agent resolves it.')
  // The keys are on the palette and on the sheet of keys, not here.
  await expect(panel.getByRole('list', { name: 'Tool keys' })).toHaveCount(0)
  await expect(panel.locator('kbd')).toHaveCount(0)
```

  Drop the `TOOLS` import from the spec if it is no longer used (`grep -n TOOLS app/e2e/marks.spec.ts`).

- [ ] **Step 2: see it fail.**
  `pnpm -C app build && pnpm -C app exec playwright test e2e/marks.spec.ts -g "with no marks"`; expected: fails
  on the missing sentence.

- [ ] **Step 3: implement.** In `MarksPanel.tsx` make the empty state:

```tsx
          <div className="marks-empty">
            <p>Point at the part to leave a note for the agent.</p>
            <p>A mark goes with your next prompt, and stays here until the agent resolves it.</p>
          </div>
```

  Remove the `TOOLS` import if unused (`grep -n TOOLS app/src/renderer/ui/MarksPanel.tsx`). Remove the three
  `.marks-keys` rules from `marks.css`; `.marks-empty p` keeps its margin.

- [ ] **Step 4: see it pass.** Same command as Step 2, then
  `pnpm -C app exec vitest run src/shared/keys.test.ts` and `pnpm -C app typecheck`.
  Also `grep -rn "marks-keys" app/src app/e2e` returns nothing.

- [ ] **Step 5: all suites, then commit.**

```sh
pnpm test && pnpm test:kernel && (cd kernel && uv run pytest -q) && pnpm test:e2e && pnpm -C app typecheck
git add app/e2e/marks.spec.ts app/src/renderer/ui/MarksPanel.tsx app/src/renderer/styles/marks.css
git commit -m "Marks: the empty section says what a mark is for and lists no keys; the palette and the sheet show them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: docs

**Files:**
- Modify: `app/src/renderer/CLAUDE.md` (the "Tools and keys" item under Marks, ~16-25)
- Modify: `docs/superpowers/specs/2026-10-08-torno-design.md` (where the Marks panel is described; `grep -n -i "marks panel\|panel of marks" docs/superpowers/specs/2026-10-08-torno-design.md`)
- Check: `README.md` (`grep -n -i "marks" README.md`)

- [ ] **Step 1:** In `app/src/renderer/CLAUDE.md`, add to the "Tools and keys" item: "A tool's key is shown on its
  palette button and in its tooltip, and on the sheet of keys; nowhere else. The empty Marks section names no key: it
  says what a mark is and that it goes with the next prompt."
- [ ] **Step 2:** In the design spec, where the Marks panel is described, add the empty state's two sentences and
  that keys are shown only on the palette and the sheet. If the spec has no such passage, add one sentence to the
  Marks panel's description.
- [ ] **Step 3:** README: change only if it says the empty Marks section lists keys (today it does not). Run
  `pnpm -C app exec vitest run src/readme.test.ts`; expected: passes (the table of keys is unchanged).
- [ ] **Step 4: all suites, then commit.**

```sh
pnpm test && pnpm test:kernel && (cd kernel && uv run pytest -q) && pnpm test:e2e && pnpm -C app typecheck
git add app/src/renderer/CLAUDE.md docs/superpowers/specs/2026-10-08-torno-design.md
git commit -m "Docs: a tool's key is shown on the palette and the sheet of keys only; what the empty Marks section says

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

# Marks panel: whole notes, and what the agent resolved: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mark's note can be read whole in the Marks list, and the marks the agent resolved are told as one
summary ("The agent resolved 4 marks", with "Review" and "OK all") instead of one open block each; the bare `~` and
`?` after a row's id give way to words.

**Architecture:** The list (`ui/MarksPanel.tsx`) is grouped by status. The active row opens out to its whole note
(`MarkRow.tsx`, CSS only for the wrap: `marks.css`). The awaiting marks fold under one summary row (new
`ui/ResolvedSummary.tsx`); each resolution is shown on demand. "OK all" goes through a new bridge call
`marks.acknowledge(objectId, ids)` to a new `MarkStore.acknowledge`, one `change` (one atomic write) for all of them;
main checks each id as `update` does. The row's chip is the id alone (`rowLabel`); the words of the drift are the
`.mark-anchor` line that exists for open marks. `labelText` keeps `~`/`?` for the chips on the view and in pictures.

**Tech Stack:** Electron, TypeScript, React, zustand; vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (marks, the panel); Issue #17.

## Global Constraints

- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1` (`show: false`); never
  `page.screenshot()`, never `--ozone-platform=headless`, never the clipboard (`app/e2e/CLAUDE.md`).
- Never run a real agent CLI in tests: `TORNO_AGENT_CMD` is the stand-in `node app/test/fake-agent.mjs`.
- No new npm dependency.
- Every key is a row of `shared/keys.ts`, read with `pressed`/`which`; `keys.test.ts` must pass. This plan adds
  no key (decision 3).
- Main is the only writer of `<object>/.torno/marks.json`: one change at a time per object, written atomically
  before it is told (`MarkStore.change`). `acknowledged` is in `MAIN_ONLY_KEYS`: the window asks, main sets it.
- UI text sentence case; every id, ref and number in the monospace face (class `num`).
- `--user-mark` / `--agent-mark` only for marks; colours from `styles/tokens.css` only.
- No endless animation; no control-room look (no black/red/amber, no condensed uppercase labels, no corner ticks).
- The Marks list never scrolls sideways (`e2e/reanchor.spec.ts`).
- Stage explicit paths (`git add <files>`, never `-A`). Commit after every task, message ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit run all four suites: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`,
  `pnpm test:e2e`, and `pnpm -C app typecheck`.
- Not this plan's: the empty state of Marks (#19), what Measure makes (#18), the scans panel (#21).

## Decisions (confirmed 2026-10-16)

Confirmed on #17: Every recommendation below holds. It lands after #19 (`tool-keys-once`), which changes the empty state of `MarksPanel.tsx`: build on that.

1. **Reading a note in full: the active row opens out.** The active row (clicked, or chosen on the view) shows its
   note wrapped, whole; other rows stay one line. It is where the eye already is and needs no new surface.
   Alternative: a popover beside the row (floats over the view, one more layer to place and dismiss). *Changes
   Task 2 if answered otherwise.*
2. **Where marks live: stay in the left column, no move now.** The left column is the model's tree: marks are
   things on the model, and the chat already says what the agent did. Moving them next to the chat is a layout
   change across #16/#22 and is better a separate issue. Alternative: a marks tab in the session pane. *Changes
   every task's files if answered otherwise (the plan would move `MarksPanel` first).*
3. **What the agent resolved: one summary, review on demand, OK all.** "The agent resolved 4 marks" with "Review"
   and "OK all"; Review opens each awaiting row with its resolution, OK and Reopen as today. Not per turn: main keeps
   no turn on a mark, and one summary of all awaiting marks says the same in practice. No key for OK all (a key
   that acknowledges many marks unseen is too easy to press). Alternative: drop the resolution from the row and
   leave it to the chat (loses the resolution next to the geometry once the chat scrolls). *Changes Tasks 3–4.*
4. **Drift on a resolved mark: not shown.** The agent resolved it after changing the geometry; the drift is the
   expected effect, and the person reviews the result anyway. On open marks drift is said in words only
   (`moved: check it`, already there), never as `~` in the row. The view's chips keep `~`/`?` (they are pictures
   for the agent too, and room there is small). Alternative: keep `~` and add a tooltip. *Changes Task 1.*
5. **Grouping by status: yes, four groups.** "To send" (drafts), "With the agent" (sent, pinned dimensions
   among them), "To review" (the summary of decision 3), and "Resolved" (the fold, as today). Headings only when
   a group has marks. Alternative: one list with the status word, as now. *Changes Task 3.*

## Design

**Row.** `[M25] [icon] note… [status]` on one line as today, the chip without `~`/`?`. A drifted open mark has
its line under the note: `moved: check it` (unchanged). An orphaned one: `its part is gone`. The status word is
gone from the rows of the groups "To send" and "With the agent" (the heading says it); a pinned dimension keeps
`pinned`.

**Whole note.** When the row is active (`aria-current`), `.mark-note` wraps (`white-space: normal;
overflow-wrap: anywhere`), the full text shown, still a button that opens the field. Inactive rows keep the
ellipsis and the `title`.

**Groups.** Headings (class `marks-group`, small, sentence case, count in `num`): `To send`, `With the agent`,
`To review`. Then the existing fold `Resolved <n>`.

**To review.** One block, `.marks-review`:

> The agent resolved **4** marks. `Review` `OK all`

One mark: "The agent resolved 1 mark." `Review` toggles (`aria-expanded`) the awaiting rows under it, each with
its resolution block as today ("Resolved by the agent: <note>", `OK`, `Reopen`). Its label is `Review` / `Hide`.
`OK all` acknowledges every awaiting mark shown in the summary at once; they go to the Resolved fold. Reopen
works as today, one at a time.

## Tasks

### Task 1: The row's chip is the id alone

**Files:** Modify `app/src/renderer/viewport/marks/labels.ts`, `app/src/renderer/ui/MarkRow.tsx`; test
`app/src/renderer/viewport/marks/markObjects.test.ts`.

- [ ] **Test first.** In `markObjects.test.ts`, beside the `labelText` cases (line ~204):

```ts
it('names a mark in its row by its id alone', () => {
  expect(rowLabel({ id: 'M3', anchorState: 'drifted' })).toBe('M3')
  expect(rowLabel({ id: 'M3', anchorState: 'orphaned' })).toBe('M3')
  expect(labelText({ id: 'M3', anchorState: 'drifted' })).toBe('M3~') // the view's chip keeps it
})
```

- [ ] Run `pnpm -C app exec vitest run src/renderer/viewport/marks/markObjects.test.ts`: fails (no `rowLabel`).
- [ ] **Implement.** In `labels.ts`:

```ts
/** What a mark is called in its row: the row says in words what the last build did to it. */
export function rowLabel(mark: Pick<Mark, 'id'>): string {
  return mark.id
}
```

  In `MarkRow.tsx` use `rowLabel(mark)` for `label` (line 104). The chip's `title` keeps `anchorNote` only when
  the mark is not resolved. `NotePopover.tsx` keeps `labelText` (it is on the view).
- [ ] Run the test again; then `pnpm -C app exec playwright test e2e/reanchor.spec.ts` after `pnpm build` and fix
  any expectation reading `M1~` in a row (`grep -n "~'" app/e2e/*.spec.ts`).
- [ ] Commit: `Marks: a row's chip is its id; what the build did is said under the note`.

### Task 2: The active row shows its note whole

**Files:** Modify `app/src/renderer/styles/marks.css`, `app/src/renderer/ui/MarkRow.tsx`; test
`app/e2e/reanchor.spec.ts`.

- [ ] **Test first.** In `reanchor.spec.ts`, after the check that the list does not scroll sideways with the long
  note (line ~165): click the row, then

```ts
const note = row.locator('.mark-note')
await expect(note).toHaveText(LONG_NOTE)
expect(await note.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1)).toBe(true)
expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
```

  (`LONG_NOTE`, `row`, `list`: the names the spec already uses there; reuse them.)
- [ ] Run `pnpm build && pnpm -C app exec playwright test e2e/reanchor.spec.ts`: fails (ellipsis).
- [ ] **Implement.** `marks.css`:

```css
.mark-row[aria-current='true'] .mark-note {
  white-space: normal;
  overflow-wrap: anywhere;
  text-overflow: clip;
  flex-basis: 100%;
}
```

  (Checked: `.mark-row` is `display: flex; height: 30px` with no wrap (`marks.css:19`), so `flex-basis` alone does
  nothing. The active row must open out as a row with fields does: add `.mark-row[aria-current='true']` to the
  selectors of `.mark-row[data-expanded]` (`flex-wrap: wrap; align-content: flex-start; height: auto`,
  `marks.css:246`) and of `.mark-row[data-expanded] .mark-actions` (`marks.css:254`), so the note takes a line of
  its own under the chip and the actions stay on the first line.) In `MarkRow.tsx`, drop the `title` on
  `.mark-note` when `active` (the text is all there). Update the comment in `renderer/CLAUDE.md` in Task 6.
- [ ] Run the e2e again, and `e2e/measure.spec.ts` (an opened dimension keeps `Add a note` whole).
- [ ] Commit: `Marks: the active row shows its note whole`.

### Task 3: The list grouped by status

**Files:** Create `app/src/renderer/ui/markGroups.ts`, `app/src/renderer/ui/markGroups.test.ts`; modify
`app/src/renderer/ui/MarksPanel.tsx`, `app/src/renderer/ui/MarkRow.tsx`, `app/src/renderer/styles/marks.css`.

- [ ] **Test first.** `markGroups.test.ts`:

```ts
import { groupMarks } from './markGroups'
// mark(id, status, extra) builds a minimal pin (see store.test.ts for a fixture)
it('groups marks by what is to be done with them', () => {
  const g = groupMarks([mark('M1', 'draft'), mark('M2', 'sent'), mark('M3', 'resolved', { resolvedBy: 'agent' }), mark('M4', 'resolved', { resolvedBy: 'agent', acknowledged: true }), mark('M5', 'resolved', { resolvedBy: 'user' })])
  expect(ids(g.toSend)).toEqual(['M1'])
  expect(ids(g.withAgent)).toEqual(['M2'])
  expect(ids(g.toReview)).toEqual(['M3'])
  expect(ids(g.resolved)).toEqual(['M4', 'M5'])
})
```

- [ ] Run `pnpm -C app exec vitest run src/renderer/ui/markGroups.test.ts`: fails.
- [ ] **Implement.** `markGroups.ts`:

```ts
import { type Mark, awaitsAcknowledgement } from '../../shared/marks'
export function groupMarks(marks: readonly Mark[]) {
  return {
    toSend: marks.filter((m) => m.status === 'draft'),
    withAgent: marks.filter((m) => m.status === 'sent'),
    toReview: marks.filter(awaitsAcknowledgement),
    resolved: marks.filter((m) => m.status === 'resolved' && !awaitsAcknowledgement(m))
  }
}
```

  In `MarksPanel.tsx` replace `open`/`resolved` with `groupMarks(marks)`; render `To send` and `With the agent`
  under `<h3 className="marks-group">` with the count in `<span className="num">`, only when non-empty. Keep
  `Every mark is resolved.` for `toSend`, `withAgent`, `toReview` all empty. In `MarkRow.tsx` the `.mark-status`
  word shows only for a pinned dimension (`PINNED`); the heading says the rest. Style `.marks-group` in
  `marks.css` with existing tokens (the size and colour of `.section-note`).
- [ ] Fix e2e that read `.mark-status` text `draft`/`sent` (`grep -n "mark-status" app/e2e/*.spec.ts`): read the
  row's group (`page.getByRole('list', { name: 'To send' })`; give each `ul` that `aria-label`).
- [ ] Run the unit test, `pnpm build`, then the e2e specs touched.
- [ ] Commit: `Marks: the list grouped by status: to send, with the agent, to review, resolved`.

### Task 4: OK all, through main

**Files:** Modify `app/src/main/marks/store.ts`, `app/src/main/marks/store.test.ts`, `app/src/main/ipc.ts`,
`app/src/preload/index.ts`, `app/src/shared/bridge.ts`.

- [ ] **Test first.** In `store.test.ts`:

```ts
it('acknowledges many marks the agent resolved in one write', async () => {
  // three marks; the agent resolves M1 and M2 (update(..., { status: 'resolved' }, 'agent'))
  const changed = await store.acknowledge(id, ['M1', 'M2'])
  expect(changed.map((m) => m.acknowledged)).toEqual([true, true])
  expect(onDisk().filter((m) => m.acknowledged)).toHaveLength(2)
  expect(changes).toHaveLength(/* one more than before */)
})
it('acknowledges none when one of them was not resolved by the agent', async () => {
  await expect(store.acknowledge(id, ['M1', 'M3'])).rejects.toThrow('M3 was not resolved by the agent: there is nothing to acknowledge')
  expect(onDisk().some((m) => m.acknowledged)).toBe(false)
})
```

  (Use the file's existing fixtures for the store, the object id, reading the file and counting `onChanged`.)
- [ ] Run `pnpm -C app exec vitest run src/main/marks/store.test.ts`: fails.
- [ ] **Implement** in `store.ts`, next to `update`:

```ts
/** Says the person has seen what the agent did with these marks: all of them in one write, or none. */
acknowledge(objectId: string, ids: readonly string[]): Promise<Mark[]> {
  return this.change(objectId, (file) =>
    [...new Set(ids.map(String))].map((id) => {
      const mark = file.marks[indexOf(file, id)]
      if (mark.status !== 'resolved' || mark.resolvedBy !== 'agent') throw new Refusal(`${id} was not resolved by the agent: there is nothing to acknowledge`)
      mark.acknowledged = true
      return structuredClone(mark)
    })
  )
}
```

  `change` writes nothing when `edit` throws (checked: `edit` runs on a `structuredClone` of the file, and
  `saveMarksFile` comes only after it returns; the test above holds it). In
  `ipc.ts` add `handle('marks:acknowledge', (_e, objectId: string, ids: string[]) => requireMarks().acknowledge(String(objectId), Array.isArray(ids) ? ids.map(String) : []))`
  and list it in the comment at line 61. `preload/index.ts`: `acknowledge: (objectId, ids) => invokePlain('marks:acknowledge', objectId, ids)`.
  `bridge.ts` under `marks`:

```ts
/** The person has seen what the agent did with these marks: all are acknowledged in one write, or none, and the rejection says which was not the agent's to acknowledge. */
acknowledge(objectId: string, ids: string[]): Promise<Mark[]>
```

  No MCP tool: only the person acknowledges.
- [ ] Run the store test, `pnpm -C app typecheck`.
- [ ] Commit: `Marks: acknowledge many marks the agent resolved in one change (marks.acknowledge)`.

### Task 5: The summary of what the agent resolved

**Files:** Create `app/src/renderer/ui/ResolvedSummary.tsx`; modify `app/src/renderer/ui/MarksPanel.tsx`,
`app/src/renderer/styles/marks.css`; e2e `app/e2e/talk.spec.ts`, `app/e2e/mcp.spec.ts`.

- [ ] **Test first.** In `talk.spec.ts`, where the stand-in agent resolves marks (line ~191), make it resolve two
  (M1, M2) and assert:

```ts
const review = page.locator('.marks-review')
await expect(review).toContainText('The agent resolved 2 marks.')
await expect(row('M1').locator('.mark-resolution')).toHaveCount(0)
await review.getByRole('button', { name: 'Review' }).click()
await expect(row('M1').locator('.mark-resolution-note')).toHaveText('Resolved by the agent: made the corner 2 mm thicker')
await review.getByRole('button', { name: 'OK all' }).click()
await expect(review).toHaveCount(0)
expect(onDisk('bracket').filter((m) => m.acknowledged)).toHaveLength(2)
```

  Keep the one-at-a-time OK and Reopen checks (after Review). Update `mcp.spec.ts:506` to click Review first.
- [ ] Run `pnpm build && pnpm -C app exec playwright test e2e/talk.spec.ts e2e/mcp.spec.ts`: fails.
- [ ] **Implement.** `ResolvedSummary.tsx`:

```tsx
export function ResolvedSummary({ marks, row, acknowledgeAll }: { marks: Mark[]; row: (m: Mark) => ReactNode; acknowledgeAll: () => void }) {
  const [open, setOpen] = useState(false)
  const n = marks.length
  return (
    <div className="marks-review">
      <p>The agent resolved <span className="num">{n}</span> {n === 1 ? 'mark' : 'marks'}.{' '}
        <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Review'}</button>{' '}
        <button type="button" className="button" title="Seen: move them all to the resolved marks" onClick={acknowledgeAll}>OK all</button>
      </p>
      {open && <ul className="mark-rows" aria-label="To review">{marks.map(row)}</ul>}
    </div>
  )
}
```

  In `MarksPanel.tsx` render it for `toReview`, with `acknowledgeAll={() => done(window.torno.marks.acknowledge(objectId, toReview.map((m) => m.id)))}`
  (a refusal shows in the existing `refused` line). Reset nothing else; `open` lives in the component, keyed by
  `objectId`. `MarkRow` keeps its resolution block as is (`awaiting`). Style `.marks-review` with tokens
  (a surface like `.mark-resolution`, no mark colour).
- [ ] Run the e2e again, and `e2e/marks.spec.ts`.
- [ ] Commit: `Marks: what the agent resolved is one summary, with Review and OK all`.

### Task 6: Docs

**Files:** Modify `CLAUDE.md` (root), `app/src/renderer/CLAUDE.md` (Marks), `app/src/main/CLAUDE.md` (marks),
`README.md`, `docs/superpowers/specs/2026-10-08-torno-design.md`.

- [ ] Root `CLAUDE.md`, "What crosses processes": "A mark the agent resolved stays in the panel's main list until
  the person acknowledges it" becomes "A mark the agent resolved is under "To review" until the person
  acknowledges it, one at a time or all at once (`marks.acknowledge`, one write)".
- [ ] `renderer/CLAUDE.md`, Marks: the row's bullet says the chip is the id (`rowLabel`; `~`/`?` are the view's,
  `labelText`), the active row's note is whole and wrapped, the four groups, the summary.
- [ ] `main/CLAUDE.md`: `MarkStore.acknowledge`, all or none, one change.
- [ ] README and the design spec where they describe the panel and the OK of a resolution
  (`grep -n "acknowledg\|Reopen\|OK" README.md docs/superpowers/specs/2026-10-08-torno-design.md`). Run
  `pnpm -C app exec vitest run src/readme.test.ts`.
- [ ] Run the four suites and typecheck.
- [ ] Commit: `Docs: the marks list grouped by status, a note read whole, and OK all`.

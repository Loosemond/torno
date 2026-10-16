# Scans panel: one line per scan, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scan's row in the left column is one line, like a layer's: id, name, one state word, eye. Everything
else it says today opens beneath it on demand, and the "how was this file read" question is asked once, right
after the import, instead of staying in the row.

**Architecture:** `ScansPanel.tsx` keeps the section, the import button and the lines of the panel (problem,
importing, refused). The row's state logic moves out into a pure module, `ui/scanState.ts` (today's `stateOf`, plus
the one word and its tooltip), so it can be unit tested. The row (`ScanRow`) becomes a head line and a detail that
opens out under it (a disclosure, as `MarkRow` opens its numbers). The read question becomes `ui/ScanReadSheet.tsx`,
an inline sheet at the top of the Scans section, shown for a scan this window just imported whose unit or up axis
was assumed. Its size preview comes from a new pure `sizeAs` in `shared/scans.ts`. Rename uses
`window.torno.scans.rename`, which main and the bridge already have and no UI calls yet. Main, the kernel and what
the agent is told stay as they are.

**Tech Stack:** Electron, TypeScript, React, zustand (vanilla store `state/store.ts`); vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (sections 7 Layers/Scans, 8 Scans, 10 Design
language), and Issue #21 ("Scans panel: one scan takes most of the left column").

## Global Constraints

- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1` (`show: false`); never
  `--ozone-platform=headless`, never `page.screenshot()`, never the clipboard (`app/e2e/CLAUDE.md`).
- No test runs a real agent CLI: `TORNO_AGENT_CMD` is the stand-in `node app/test/fake-agent.mjs`.
- No new npm dependency.
- Every key is a row of `shared/keys.ts`, read with `pressed`/`which`, never `.key` (the rename field uses
  `field.keep` and `field.leave`, the sheet `sheet.close`; none is added).
- Nothing taken from a scan is said to be exact; whether its alignment is checked against the builds is part of
  that and may move but never be lost (root `CLAUDE.md`, `app/src/main/CLAUDE.md` Scans). The size in the row's
  detail and in the sheet stays without "exact".
- UI text is sentence case. Every number and ref is in the monospace face: `numbered()` from `ui/numbered.tsx`, or
  `className="num"`.
- Colours are tokens of `styles/tokens.css` only; a scan's own are `--scan-plain` and `--deviation-*`. No new
  colour literal in `scans.css`.
- No endless animation. Not nerv's look: no black/red/amber, no condensed uppercase labels, no corner-tick frames.
- Scans and layers stay two lists (issue #20 owns the Layers list).
- Stage explicit paths (`git add <files>`, never `-A`). Before each commit run the four suites (`pnpm test`,
  `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`) and `pnpm -C app typecheck`; commit after
  every task with a message describing the change, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions to confirm

The owner brainstorms each issue: these are the recommendations the tasks are written to. The ones marked
**(changes tasks)** would change the tasks if answered otherwise.

1. **At a glance or on demand.** Recommended: at a glance only the id, the name, one state word and the eye (the
   opacity slider on hover, as now). Size, units, up axis, colour, alignment detail, Frame, Align, Rename and Remove
   wait in the detail. Reason: the three things one scans the list for are "which one", "is it shown", "can I
   trust where it is"; the rest is asked for once in a while. Alternative: keep Frame and Align on the row as icon
   buttons on hover (they are the two actions used most). **(changes tasks: Task 3)**
2. **Units and up axis.** Recommended: asked once, right after an import in this window, in a short inline sheet
   at the top of the Scans section ("How is S1 read?" with unit and up selects, the size as it would be, "Keep" /
   "Apply" / "Later"); the scan is already drawn in the view, which is the preview. "Later", or a scan imported by
   the onboarding, leaves a small dot on the row and the question in the detail. Reason: the guess is right most of
   the time and a line that stays until answered is the clutter; but a wrong unit is a 1000x mistake, so it is
   asked before anything else is done with the scan. Alternative: a modal sheet before the import starts (needs
   the size before the kernel has read the file, so the kernel would read twice). **(changes tasks: Task 5)**
3. **Where the detail goes.** Recommended: the row opens out beneath itself (a disclosure, one open at a time per
   panel), as a mark's row opens its numbers. Reason: the left column already has this pattern, nothing covers the
   view, and e2e reads it inside `.scan-row`. Alternative: a popover beside the column (as `NotePopover` for
   marks): roomier, but it floats over the viewport the scan is looked at in. **(changes tasks: Task 3)**
4. **Alignment states.** Recommended: one word on the row, with the full sentence in its tooltip and in the
   detail: `aligned`, `placed`, `pending`, `check`, `rough`, `unaligned`, `missing` (table in Design). `placed`
   is new: an alignment tied to no point of the model (by hand, typed) is never checked against builds, so it must
   not read as `aligned`. Reason: the word keeps the one distinction that matters for trust; the basis ("4 pairs,
   RMS 2.1 mm") is detail. Alternative: keep `aligned` for by-hand too and show the untied fact only in the
   tooltip (fewer words, but the row would then claim more than it knows). **(changes tasks: Task 2, the e2e
   strings of Task 3)**
5. **One list?** Recommended: no; two sections, but the scan row is built like a layer row (same height,
   `.row-name` ellipsis, eye at the right edge, opacity on hover), so they read alike. Reason: a scan has an
   alignment and a source, a part has neither; #20 is reworking the Layers list in parallel. Alternative: one
   "In the view" list with scans as a group, after #20 lands.
6. **Names.** Recommended: keep the file name as the default name (it is what the agent is told and what the
   person recognises), show it whole in the row's `title` with the source path, and let the person rename in the
   detail (main's `scans.rename` exists). No agent tool for it now: no MCP tool writes a scan, by design (README,
   Tools). Alternative: strip the extension at import in main (`MikraK11_Hatch`), which changes what the agent is
   told and main's tests. **(changes tasks: Task 4)**

## Design

### The row (one line)

`S1  MikraK11_Hatch.stl ·  [aligned]  (eye)`

- `.scan-id.num` the id; `.row-name` the name, cut with an ellipsis, `title` = `${name}, from ${source.path}`.
- A dot (`.scan-dot`, `--warning` token, `aria-label="Read as assumed"`) after the name while
  `imported.assumed.unit || imported.assumed.up`, `title` = the guess sentence (`Read as millimetres, Z up: assumed`).
- The state word (`.chip[data-state]`), one word, `title` = its tooltip (below).
- The opacity slider (on hover, as today, `.layer-opacity`) and the eye (`Show S1`).
- A chevron button `aria-label="Details of S1"`, `aria-expanded`, `aria-controls="scan-detail-S1"`; a click on the
  name does the same. Only one detail open in the panel at a time (`open` state lifted to `ScansPanel`).

### The state word and its tooltip

`scanState(scan, layout, revision)` in `ui/scanState.ts` returns `{ state, word, tip, basis, said, rough, note,
confirm }` (today's `stateOf` fields, plus `word` and `tip`). `basis`, `said`, `rough` and `note` are the strings
today's code already makes (`standingOf`, `basisText`, `TIED_TO_NOTHING`); `{layout}`, `{basis}`, `{said}` below
are those.

| `data-state` | word | when | tooltip, word for word |
|---|---|---|---|
| `mesh-missing` | `missing` | `meshState === 'missing'` | `Its mesh is gone from the disk: it cannot be drawn or checked` |
| `unaligned` | `unaligned` | no alignment in the layout shown | `Not aligned in {layout}: nothing is checked against it here` |
| `unchecked` | `pending` | aligned, revision 0 or check waiting | `Aligned {basis}; not checked against a build yet` (+ `. {said}` when the check failed) |
| `stale` | `check` | `standing.stale` | `{said}` (today's chip title, e.g. `torno has moved lid for display since it was aligned: check the alignment`) |
| `rough` | `rough` | `standing.rough` | `Rough: {rough}` |
| `placed` | `placed` | aligned, `tiedPoints === 0` (by hand, typed, handles) | `Placed {basis}: tied to no point of the model, so not checked against builds` |
| `aligned` | `aligned` | otherwise | `Aligned {basis}; checked against r{n}` (`n` = `scan.checks[layout].revision`), or `Aligned {basis}; {note}` when confirmed |

The order of the rows is the order of the checks (missing first, as `stateOf` does now; `placed` comes after
`rough` and before `aligned`). A `title` is plain text; in the detail the same sentence is set with `numbered(capital(...))`.

### The detail (`.scan-detail`, `id="scan-detail-S1"`)

Top to bottom:

1. `.scan-read`: `numbered(importText(scan.imported))` (size, from unit, up, `(assumed)`, reduced).
2. While a guess stands: `.scan-guess` `Read as millimetres, Z up: right?` with "Yes" (`Yes, S1 was read rightly`),
   as today, and the unit/up fields right under it.
3. `.scan-said[data-part="state"]`: the tooltip sentence in full (so the basis, `.scan-basis`, is inside it as a
   span); the "Still right" button when `confirm`.
4. Whichever applies, each one `.scan-said` as today: `data-part="start"` (Use this alignment in …),
   `data-part="rough"`, `data-part="note"` (e.g. `Tied to no point of the model: not checked against builds.`; not
   repeated when the state is `placed`, whose sentence says it), mesh gone + "Import again", `Converting…`,
   `data-part="source"` (`source missing` / `source changed` with today's title as the sentence), `data-part=
   "clipped"` (`Not all in view: Frame brings more of it in`).
5. `.scan-actions`: buttons (not links) in one line that does not wrap: "Frame", "Align", "Rename".
6. `.scan-fields`: Read as (unit, up, Apply), Colour (Own colours / Plain), Remove, as today's More.

The detail opens only when asked, never by itself. A scan whose state is `check` or `rough` makes its word stand out (`data-state` styles, as today's chips);
that is the call to open it.

### Where each thing of today's row goes

| Today | Now |
|---|---|
| `S1`, name, eye, opacity on hover | the row, unchanged; whole name and path in `title` |
| `650 × 1226 × 357.7 mm, from mm, Z up (assumed)` | detail line 1 |
| `Read as millimetres, Z up: right? Yes` | the read sheet after import; then the dot on the row and detail line 2 |
| chip `not checked yet` etc. | the one word on the row (table), sentence in its `title` and detail line 3 |
| `· by hand` (basis) | inside the state sentence (`.scan-basis`) |
| chips `source missing`, `source changed`, `not all in view` | detail lines `data-part="source"`, `"clipped"`; `source changed` also makes the state `check` (it already does via `staleText`) |
| Frame, Align, More | detail `.scan-actions`; More is the chevron |
| `Tied to no point of the model: not checked against builds.` | the `placed` word and its sentence; for a floor-only alignment, `data-part="note"` as now |
| `scan-said` lines (stale + Still right, start, rough, note, mesh gone, Converting…) | detail, unchanged |
| Read as / Colour / Remove | detail `.scan-fields` |
| Confirm "Drop the alignment of S1?" / "Remove S1?" | under the row, unchanged |

### The read sheet (`ui/ScanReadSheet.tsx`)

`role="dialog"`, `aria-label="How is S1 read?"`, inside the Scans section above the rows, not modal.
Text: `S1 was read as millimetres, Z up: torno guessed from the format and the size.` Then a line `Its size
would be 650 × 1226 × 357.7 mm` (`numbered`, from `sizeAs(imported, { unit, up })`), the two selects (`Unit of
S1`, `Up axis of S1`, defaulting to how it was read), and three buttons: "Keep" (converts to the same unit and
axis, which clears `assumed`: today's "Yes"), "Apply" (enabled when changed; with alignments it asks the same
`Confirm` as today), "Later" (puts it away; `sheet.close` does the same). It is shown for `store.scanAsking`, an id
set by `importScan` when the import resolves with `assumed.unit || assumed.up`, cleared by any of the three or
when the object changes.

### Rename

"Rename" in the detail turns the row's name into a text field (`aria-label="Name of S1"`); `field.keep` (Enter)
commits through `window.torno.scans.rename`, `field.leave` (Esc) or blur without change puts it back; main's
refusal (`a scan needs a name`) is said through `asked()` as other refusals are.

## Tasks

### Task 1: The size a scan would have read otherwise (`sizeAs`)

**Files:** modify `app/src/shared/scans.ts`, `app/src/shared/scans.test.ts`.

- [ ] Write the failing test in `shared/scans.test.ts`:

```ts
describe('sizeAs', () => {
  const imported = { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, bbox: { min: [0, 0, 0], max: [650, 1226, 357.7] } } as unknown as ScanImport
  it('is the size as read when nothing changes', () => expect(sizeAs(imported, { unit: 'mm', up: 'z' })).toEqual([650, 1226, 357.7]))
  it('scales by the ratio of the units', () => expect(sizeAs(imported, { unit: 'cm', up: 'z' })).toEqual([6500, 12260, 3577]))
  it('swaps Y and Z when the up axis changes', () => expect(sizeAs(imported, { unit: 'mm', up: 'y' })).toEqual([650, 357.7, 1226]))
})
```

- [ ] Run `pnpm -C app exec vitest run src/shared/scans.test.ts`: fails (`sizeAs` is not exported).
- [ ] Implement next to `importText`:

```ts
/** The size of a scan, in mm, had it been read with this unit and up axis: what the read sheet says before Apply. */
export function sizeAs(imported: Pick<ScanImport, 'unit' | 'up' | 'bbox'>, as: { unit: ScanUnit; up: ScanUp }): Vec3 {
  const { min, max } = imported.bbox
  const k = UNIT_MM[as.unit] / UNIT_MM[imported.unit]
  const [x, y, z] = max.map((c, axis) => (c - min[axis]) * k)
  return as.up === imported.up ? [x, y, z] : [x, z, y]
}
```

  The axis mapping is checked: the kernel turns Y up to Z up as `(x, y, z) → (x, -z, y)` (and back as
  `(x, z, -y)`, `kernel/src/torno_kernel/scans.py:64`, `:68`), so the extents only swap Y and Z, whichever way. Round in the test with `toBeCloseTo` if `* k` leaves float noise.
- [ ] Run the test again: passes. Typecheck.
- [ ] Commit `shared/scans: sizeAs, the size a scan would have read with another unit or up axis`.

### Task 2: One word for the state of a scan (`ui/scanState.ts`)

**Files:** create `app/src/renderer/ui/scanState.ts`, `app/src/renderer/ui/scanState.test.ts`; modify
`app/src/renderer/ui/ScansPanel.tsx` (import it, delete the local `stateOf` and `guessOf`).

- [ ] Write `scanState.test.ts` with one case per row of the Design table, building `ScanInfo` the way
  `shared/scans.test.ts` and `main/mcp/scanTools.test.ts` build them (copy a fixture, do not invent fields).
  E.g.:

```ts
it('says placed for a scan tied to no point of the model', () => {
  const s = scanState(byHand, 'print', 3)
  expect(s).toMatchObject({ state: 'placed', word: 'placed' })
  expect(s.tip).toBe('Placed by hand (typed values): tied to no point of the model, so not checked against builds')
})
it('says aligned and the build it was checked on', () => {
  expect(scanState(fitted, 'print', 3).tip).toMatch(/^Aligned by 4 pairs \(.*\); checked against r3$/)
})
it('says pending before anything is built', () => expect(scanState(fitted, 'print', 0)).toMatchObject({ state: 'unchecked', word: 'pending' }))
it('says unaligned in a layout it has no alignment in', () => expect(scanState(fitted, 'assembly', 3).tip).toBe('Not aligned in assembly: nothing is checked against it here'))
```

  Also `guessOf` cases (`Read as millimetres, Z up`; null when chosen) moved from the panel.
- [ ] `pnpm -C app exec vitest run src/renderer/ui/scanState.test.ts`: fails.
- [ ] Move `stateOf` and `guessOf` from `ScansPanel.tsx` into `scanState.ts` as `scanState` and `guessOf`, add
  `word` and `tip` per the table, and the `placed` branch (`tiedPoints(alignmentOf(scan, layout)!) === 0` after the
  `rough` check). `note` drops `TIED_TO_NOTHING` when the state is `placed` (its sentence says it).
- [ ] Panel: replace `state.text` with `state.word` and `title={state.tip}` (the rest of the row unchanged in this
  task), so the e2e strings change in one place: update `app/e2e/align.spec.ts` lines that read
  `toHaveText('not aligned here')` → `'unaligned'`, `'check alignment'` → `'check'`, `'rough alignment'` →
  `'rough'`, and `scan.spec.ts` where it reads a state chip. Where a test placed a scan by hand and expects
  `aligned` (`align.spec.ts` ~256-271), expect `placed`.
- [ ] Unit test passes; `pnpm test`, typecheck. Run the two specs (after `pnpm build`):
  `pnpm -C app exec playwright test e2e/align.spec.ts e2e/scan.spec.ts`.
- [ ] Commit `Scans: one word for a scan's state (placed for one tied to no point), its sentence in the tooltip`.

### Task 3: The row is one line, the rest opens beneath it

**Files:** modify `app/src/renderer/ui/ScansPanel.tsx`, `app/src/renderer/styles/scans.css`,
`app/e2e/scan.spec.ts`, `app/e2e/align.spec.ts`.

- [ ] Change the e2e first. Add a helper in both specs:

```ts
const detail = async (id: string, p: Page = page) => {
  const button = row(id, p).getByRole('button', { name: `Details of ${id}` })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  return row(id, p).locator('.scan-detail')
}
```

  and a new test in `scan.spec.ts`: after import, the row's head (`.scan-head`) is one line (its bounding box
  height at most 1.5 x the line height of `.row-name`, measured with `boundingBox()`), shows `S1`, the name, a
  state word and the eye; `.scan-read`, `.scan-said`, Frame, Align and Remove are not visible until "Details of S1"
  is clicked; opening S2's detail closes S1's. Every existing step that reaches `.scan-basis`, `.scan-said`, the
  unit field, Apply, Frame, Align, Colour, Remove or Still right goes through `await detail('S1')` first
  (`align.spec.ts` 127, 176-177, 324, 421, 454-466; `scan.spec.ts` 98-99, 172-179, 188, 250-257). The state
  sentence assertions read `.scan-said[data-part="state"]`.
- [ ] `pnpm build && pnpm -C app exec playwright test e2e/scan.spec.ts`: the new test fails.
- [ ] In `ScanRow`: the head line as in Design (id, name with `title`, `.scan-dot` while guessed, the chip, the
  slider, the eye, the chevron button); `open`/`onToggle` props from `ScansPanel` (`useState<string | null>` there,
  cleared when the object changes). Everything else of today's row moves, unchanged in its markup, into
  `{open && <div className="scan-detail" id={`scan-detail-${id}`}>…</div>}` in the order of Design. Frame and Align
  become `className="button button-quiet"` in a `.scan-actions` row; the `More` button and its `more` state go (the
  chevron replaces them; the fields are always there in an open detail).
- [ ] `scans.css`: `.scan-head` as `.layer-row`'s line (`display: flex; align-items: center; gap; min-height`
  of `.row`), `.scan-head .row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap }`, `.scan-dot` (6 px, `background: var(--warning)`), `.scan-detail` indented under the name
  with `border-left: 1px solid var(--line)` (use the token names in `tokens.css`), `.scan-actions { display: flex;
  flex-wrap: nowrap; gap }`. Delete the rules of `.scan-more` and `.scan-state` it no longer uses. The chevron turns
  90° with a `transition` (once, not endless).
- [ ] Both specs pass; `pnpm test`, typecheck.
- [ ] Commit `Scans panel: a scan's row is one line; its size, alignment, actions and fields open beneath it`.

### Task 4: Rename a scan

**Files:** modify `app/src/renderer/ui/ScansPanel.tsx`, `app/e2e/scan.spec.ts`.

- [ ] e2e: open S1's detail, click "Rename", fill `Name of S1` with `hatch`, press Enter: the row's name is
  `hatch` and `window.__tornoTest!.scans()` (or `window.torno.scans.list('bracket')` via `page.evaluate`) has
  `name: 'hatch'`; Rename again, clear the field, Enter: the panel's alert says `a scan needs a name` and the name is
  still `hatch`; Rename, type, Esc: unchanged.
- [ ] Run it: fails (no Rename).
- [ ] `naming` state in `ScanRow`; while true the `.row-name` is an `<input className="row-name" aria-label={`Name
  of ${id}`}>` with `onKeyDown`: `pressed(e, 'field.keep')` → `void asked(objectId, window.torno.scans.rename(objectId,
  id, value)).finally(() => setNaming(false))`; `pressed(e, 'field.leave')` → `setNaming(false)`; blur with the
  value unchanged → `setNaming(false)`.
- [ ] Passes; typecheck.
- [ ] Commit `Scans panel: rename a scan from its detail`.

### Task 5: The read question, asked once after an import

**Files:** create `app/src/renderer/ui/ScanReadSheet.tsx`; modify `app/src/renderer/state/store.ts`
(`scanAsking: string | null` in the state, in `NO_OBJECT`, `actions.askScanRead(id: string | null)`),
`app/src/renderer/ui/scanDrop.ts` (`importScan`), `app/src/renderer/ui/scanDrop.test.ts`,
`app/src/renderer/ui/ScansPanel.tsx`, `app/src/renderer/styles/scans.css`, `app/e2e/scan.spec.ts`.

- [ ] Unit test in `scanDrop.test.ts` (it already stubs `window.torno.scans`): `importScan` resolving with a scan
  whose `imported.assumed.unit` is true sets `store.getState().scanAsking` to its id; one with nothing assumed
  leaves it null; one resolving after the object changed leaves it null.
- [ ] e2e in `scan.spec.ts`, replacing the `.scan-guess` steps at 97 and 171: after import the dialog `How is S1
  read?` is visible, says `Its size would be` and the size; choosing `cm` changes that line to the size times ten;
  "Apply" converts (the row's dot is gone, the dialog is gone, `__tornoTest.scans()` has `unit: 'cm'`). A second
  scan (S2, line ~245): "Keep" does what "Yes" did (`assumed` cleared, no dot). A third: "Later" puts it away, the
  dot stays (`aria-label="Read as assumed"`), and detail line 2 still asks `right?` with "Yes".
- [ ] Run both: fail.
- [ ] `importScan`: `.then((scan) => { if (scan && (scan.imported.assumed.unit || scan.imported.assumed.up) &&
  store.getState().objectId === objectId) actions.askScanRead(scan.id) })` on the promise `reading` returns.
- [ ] `ScanReadSheet({ objectId, scan })`: text, `sizeAs` line through `numbered` and `number` from
  `shared/format`, the two selects (same `pointerChoice`/`chosen` as the row's fields), Keep / Apply / Later, the
  same `Confirm` for an Apply that drops alignments (a scan just imported has none, but one imported by the
  onboarding could have been aligned before the person gets to it), `sheet.close` on keydown inside it. Rendered
  by `ScansPanel` above the rows when `scanAsking` names a scan of `scans`. The convert call is the row's
  `convert`: lift it into a function in `ScansPanel.tsx` both use.
- [ ] `scans.css`: `.scan-sheet` with the surface and border tokens a `Confirm` uses.
- [ ] All pass; `pnpm test`, typecheck.
- [ ] Commit `Scans: how a scan is read is asked once, right after its import, with the size it would have`.

### Task 6: Captures for the themes

**Files:** modify `app/e2e/themes.spec.ts`.

- [ ] In the `scans` shot (~line 246), after `scan()`, open the detail of S1 (`Details of S1`) so the capture holds
  the one-line row and an open detail; add a shot `scan-read` (to `STATES`) that stops with the read sheet shown
  (the fixture `sheet.stl` is read with an assumed unit: check `__tornoTest.scans()[0].imported.assumed` and pick
  a fixture size under 20 units so it is).
- [ ] `pnpm -C app exec playwright test e2e/themes.spec.ts` in both themes; look at the captures it writes (the way
  `app/e2e/CLAUDE.md` says) for contrast and the warning dot in dark.
- [ ] Commit `e2e: captures of the one-line scan row, its detail and the read sheet`.

### Task 7: Docs

**Files:** modify `app/src/renderer/CLAUDE.md` (Scans), `README.md` (Scans: Importing, Units, The Scans panel,
the table of what the row says; "Not yet verified on a visible screen"), `docs/superpowers/specs/2026-10-08-torno-design.md`
(section 8 and 7's Scans bullet).

- [ ] renderer `CLAUDE.md`, Scans: the row is one line (`ScanRow` head), the detail opens beneath it, one open at
  a time; the state word and its sentence come from `ui/scanState.ts` (`placed` for an alignment tied to no point);
  the read sheet is `ui/ScanReadSheet.tsx`, shown for `store.scanAsking`; "not all in view" is now a line of the
  detail (fix the sentence that names "the chip").
- [ ] README: "Units" says the question comes once after the import (Keep / Apply / Later) and stays in the detail
  until answered; "The Scans panel" says what the row shows and what the detail holds, and Rename; the table's left
  column becomes the words (`aligned`, `placed`, `pending`, `check`, `rough`, `unaligned`, `missing`) with today's
  meanings; add the new row and the read sheet to "Not yet verified on a visible screen". Run
  `pnpm -C app exec vitest run src/readme.test.ts` (headings and order unchanged).
- [ ] Spec section 8: one sentence on the row and the read question at import.
- [ ] Commit `Docs: the one-line scan row, its detail, the state words and the read question at import`.

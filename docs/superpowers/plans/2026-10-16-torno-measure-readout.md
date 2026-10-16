# Measure gives a readout: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A measurement shows the kernel's value and leaves no mark. The person keeps one as a dimension only when
they mean to, with a button on the readout strip or `Enter`. The palette shows its tools in groups: those that
inspect, those that mark, and the scan's.

**Architecture:** Main gets one new call, `geometry.measure` (`geometry:measure`). It runs the kernel's measurement
through the same `measureDimension` that a dimension's keeping uses, with the same refusals (stale build, parts
spread apart, the kernel's own reason), and writes nothing. The Measure tool calls it in place of `ctx.commit` and
puts what came back in a small vanilla store, `state/measured.ts`, which holds the last measurement: its ends as
anchors, its kind, the kernel's value, the build. The `MeasureChoice` strip reads that store (it changes once per
measurement, never per pointer move) and shows `Last: 6 mm` with a `Keep as a dimension` button. Keeping commits the
same anchors as a `dimension` mark through `ctx.commit` / `marks.add`, and main measures it again as it does today. A
`group` on each row of `TOOL_KEYS` sorts the palette into three groups, with the `toolbox-rule` that already sits
above the keys button between them.

**Tech Stack:** Electron, TypeScript, React, zustand (vanilla stores), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (Marks, Measure, dimensions), and Issue #18.

## Global Constraints

- Tests never open a visible window: every launch sets `TORNO_TEST=1` (`show: false`), never
  `--ozone-platform=headless`, never `page.screenshot()`, never the clipboard (`app/e2e/CLAUDE.md`).
- Never run a real agent CLI in tests: `TORNO_AGENT_CMD` is the stand-in `node app/test/fake-agent.mjs`.
- No new npm dependency.
- Every key is a row of `shared/keys.ts`, checked by `shared/keys.test.ts`. Handlers use `pressed`, never `.key`.
  README's key table is `cheatSheet()`, rewritten with `TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts`.
- Every number told is the kernel's. The mesh gives only the `≈` estimate while the second end is pending, and the
  kernel's value replaces it. Every number shown goes through `shared/format.ts` (`valueText` in `shared/dimension.ts`).
- No per-frame state in React. Pointer moves reach only the readout and the viewport. The store of the last
  measurement changes once per measurement.
- Main is the only writer of `marks.json`. `geometry:measure` writes nothing, and a value from the window is never
  taken (`marks:add` measures again).
- UI text is sentence case. Numbers and refs are set in the monospace face (`num`).
- Colours come from `styles/tokens.css` only. `--user-mark` and `--agent-mark` are for marks alone, so a readout
  is not a mark and is never drawn in them. No endless animation. Not nerv's look: no black, red or amber, no
  condensed uppercase labels, no corner ticks.
- Stage explicit paths (`git add <file> …`, never `-A`). Commit after every task with a message describing the
  change, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`,
  `pnpm -C app typecheck`, all from the repository root.

## Decisions to confirm

Each is a question from the issue's "To brainstorm" list. **(changes tasks)** means a different answer changes the
tasks below.

1. **The default.** *Recommended:* the kernel's exact value, with how it was taken (`6 mm between planes`), at the
   pointer until the pointer moves 12 px (as now). It also stays in the strip as `Last: …` until the next
   measurement, Escape with nothing pending, another tool, a new build or another object. No mark is made. *Why:*
   the person sees an exact number, and the agent hears nothing. *Alternative:* keep today's behaviour behind a
   setting ("measurements leave dimensions"). **(changes tasks: a different default drops Tasks 2–3)**
2. **Keeping one.** *Recommended:* a `Keep as a dimension` button on the strip, plus `Enter` in the `measure`
   scope. Both keep the last measurement. *Why:* you keep it after seeing the value, which a modifier on the click
   cannot do. `Enter` already means "keep" in Region (`region.keep`). *Alternative:* Alt+click keeps at once.
   **(changes tasks: Task 3)**
3. **Expected values.** *Recommended:* keeping is the one way to make a dimension. The expected value is typed in
   `DimensionFields` on the kept row, as today, so no expected field goes on the strip. *Why:* a requirement is a
   mark, and the row already holds its fields. *Alternative:* an `Expect` field on the strip that keeps on Enter.
4. **History.** *Recommended:* none for now. Only the last measurement is held. *Why:* to compare before and after a
   build, keep it as a dimension: it is measured again on every build and its row shows `was 6 mm on r11`. A list
   would be a second, weaker copy of that. *Alternative:* the last five, under the strip, never sent.
   **(changes tasks: a history adds a task)**
5. **What the agent hears.** *Recommended:* nothing of a measurement that was not kept. It is not in the prompt, not
   in `state.md`, not in a picture (the readout and the strip are DOM, not drawn on the canvas the picture is taken
   of). *Why:* the issue's point is that a check is not a message. A kept one is a mark, and is told as one.
   *Alternative:* a line in the next prompt's context ("the person measured plate/F2 to plate/F4: 6 mm").
6. **Groups of tools.** *Recommended:* three groups split by a hairline (`toolbox-rule`): inspect (Select, Measure,
   Section), mark (Pin, Arrow, Draw, Shape, Region of a scan) and scan (Align scan). There is no extra colour, and
   the toolbar's `aria-label`s name each group. *Why:* the rule is already used in the palette and is quiet. Region
   leaves a mark, so it goes with the marking tools. This order is the order of the keys sheet and of README.
   *Alternative:* a look of their own for the marking tools (a tinted pressed state). That would come close to the
   mark colours. **(changes tasks: Task 4 only)**
7. **Other measures.** *Recommended:* the same for all. Wall thickness (`T`) and diameter or radius (double click)
   give a readout, and the same button or `Enter` keeps them. *Why:* one rule for one tool. *Alternative:* `T`
   keeps at once, since a wall is often a requirement.

## Design

**Readout at the pointer.** It is the same as today: while the second end is pending, the `≈` estimate. After the
click, the kernel's value replaces it: `ctx.readout.show(client, valueText(measure, value), how)` (today it is
`mark.id` and the value). It stays until the pointer has moved `RESULT_PX`. Refusals are unchanged: the reason for
`REFUSAL_MS`, `SPREAD_LINE` sticky, `NOT_ROUND`.

**The strip** (`MeasureChoice`, shown only with Measure in hand) gets a third part after the two segmented groups
once something is held:

```
[Distance|Angle] [Diameter|Radius]   Last: <num>6 mm</num> between planes   [Keep as a dimension]
```

- The text is `Last: ` + `valueText(measure, value)` in `num`, then `how` muted. Its title says
  `Measured on r<N>, not kept: the agent is not told`.
- The button is `Keep as a dimension`, title `Keep it as a dimension (Enter): a mark, measured again on every build,
  sent with the next prompt`.
- Once kept, the part reads `Kept as <num>M7</num>` with no button, until the next measurement.
- It is cleared by the next click's first end, by Escape with nothing pending (Escape then returns true), by the
  tool's `cancel`, and by a revision or object other than the one held (the strip checks this against the
  `objectId`/`revision` it is given and hides).

**Keys.** A new row in `shared/keys.ts`:
`row('measure.keep', ['Enter'], 'Measure: keep the last measurement as a dimension', 'With a tool in hand', 'measure')`.
In the `measure` scope `Enter` clashes with nothing (`region.keep` is in the `region` scope, and the composer and
fields are `TYPING`).

**What crosses to main.** The bridge gets
`geometry.measure(objectId, probe: MeasureProbe): Promise<Measured>`, where
`MeasureProbe = { measure: MeasureKind; layout: string; revision: number; a: Anchor; b?: Anchor }` and
`Measured = { value: number; how: string; revision: number }` (in `shared/geometry.ts`). It rejects with a plain
message, as `describe` does. Main's handler checks the shape the way `marks:add` does, then calls the new
`measureOnce` in `main/marks/measure.ts`.

**The agent** is told nothing new. `main/prompt.ts` and the MCP tools are unchanged. A kept dimension goes through
`marks:add` → `addDimension` exactly as today.

**Palette.** `TOOL_KEYS` rows get `group: 'inspect' | 'mark' | 'scan'` and are put in group order: select, measure,
section, pin, arrow, draw, shape, region, align. `TOOLS` carries `group`. `ToolPalette` renders one
`<div role="group" aria-label="Inspect|Mark|Scan">` per group, with `<span className="toolbox-rule">` between them.
The Marks empty state's list belongs to #19, which takes `group === 'mark'` from here.

## Tasks

### Task 1: `measureOnce` in main, and `geometry:measure`

**Files:**
- Modify: `app/src/main/marks/measure.ts` (new `measureOnce`, next to `addDimensionTold`)
- Modify: `app/src/shared/geometry.ts` (`MeasureProbe`, `Measured`)
- Modify: `app/src/shared/bridge.ts` (`geometry.measure`)
- Modify: `app/src/preload/index.ts` (`measure: (objectId, probe) => invokePlain('geometry:measure', objectId, probe)`)
- Modify: `app/src/main/ipc.ts` (handler next to `geometry:describe`; add the channel to the list at the top)
- Test: `app/src/main/marks/measure.test.ts`

- [ ] **Step 1: failing tests** in `measure.test.ts`, using that file's existing fake deps (`query`, `scene`):
  - `measureOnce` answers `{ value: 6, how: 'between planes', revision: 3 }` for a distance on r3 and writes no mark
    (`deps.marks.add` is never called).
  - It rejects with `it was placed on r2, and the part has been built again since (r3): measure it again` for a stale probe.
  - It rejects with the `spreadApart` reason for a distance between two spread parts.
  - It rejects with the kernel's `refused` text (an angle between a plane and a cylinder).
  - It rejects with a plain message when the kernel cannot be asked. Nothing is kept "for later", unlike `addDimensionTold`.
- [ ] **Step 2:** `pnpm -C app exec vitest run src/main/marks/measure.test.ts` and see them fail.
- [ ] **Step 3: implement.**

```ts
/** A measurement the person takes and does not keep: the kernel's value on the last build, and nothing written. */
export async function measureOnce(deps: MeasureDeps, objectId: string, probe: MeasureProbe): Promise<Measured> {
  const last = deps.scene(objectId)
  if (last === undefined) throw new Refusal(`there is no build of ${objectId} to measure on`)
  if (probe.revision !== last.revision) throw new Refusal(`it was placed on r${probe.revision}, and the part has been built again since (r${last.revision}): measure it again`)
  const apart = probe.measure === 'distance' ? spreadApart(last.scene, probe.layout, probe.a.part, probe.b?.part, 'the distance between') : null
  if (apart !== null) throw new Refusal(apart)
  const m = await measureDimension(deps, objectId, probe, probe.revision)
  if (m.refused !== undefined) throw new Refusal(m.refused)
  return { value: m.value!, how: m.how!, revision: probe.revision }
}
```

  Factor the stale and spread checks out of `addDimensionTold` into one helper that both call, so that the two
  cannot drift apart. In `ipc.ts`, check the probe as `marks:add` checks a `NewMark` (`placedMark` or that file's
  validator for dimensions: `measure` one of the five, anchors with finite points, `b` only for distance and angle),
  then `measureOnce(measuring(requireMarks()), String(objectId), probe)`.
- [ ] **Step 4:** run the focused test again, then `pnpm -C app typecheck`.
- [ ] **Step 5: commit** `git add app/src/main/marks/measure.ts app/src/main/marks/measure.test.ts app/src/shared/geometry.ts app/src/shared/bridge.ts app/src/preload/index.ts app/src/main/ipc.ts`,
  message `Main measures without keeping: geometry:measure (measureOnce), the kernel's value and the refusals of a dimension, nothing written`.

### Task 2: the Measure tool reads out and holds, and commits nothing

**Files:**
- Create: `app/src/renderer/state/measured.ts` (vanilla zustand: `held: Held | null`, `setHeld`, `clearHeld`, `useHeld`)
- Modify: `app/src/renderer/tools/Tool.ts` (`ToolContext.measure(probe): Promise<Measured>`)
- Modify: `app/src/renderer/ui/ViewportPane.tsx` (pass `measure: (probe) => window.torno.geometry.measure(objectId, probe)` next to `commit`)
- Modify: `app/src/renderer/tools/measureTool.ts` (`commit` → `take`, and its doc comment)
- Test: `app/src/renderer/tools/measure.test.ts`

`Held = { objectId: string; layout: string; revision: number; camera: Camera; measure: MeasureKind; a: Anchor; b?: Anchor; value: number; how: string; kept?: string }`.

- [ ] **Step 1: failing tests.** Add `measure` to `fake()`, taking over the values its `commit` now gives, and assert:
  - Two clicks call `ctx.measure` once with `{ measure: 'distance', layout, revision, a, b }` and `committed` stays
    `[]`. The readout says `6 mm | between planes`, and `measuredStore.getState().held` holds the value.
  - A double click on a cylinder and `T` over a face do the same (`diameter`, `thickness`).
  - A refusal leaves `held` null and reads the reason out, as before. A spread pair gives `SPREAD_LINE`, sticky.
  - Escape with no first end and something held clears `held` and returns true. Escape with a first end drops only the end.
  - A new first end clears `held`. `cancel` clears it.
  - Turn the existing "commits" tests into these. Keep the estimate, `angleHint` and `NOT_ROUND` tests unchanged.
- [ ] **Step 2:** `pnpm -C app exec vitest run src/renderer/tools/measure.test.ts` and see them fail.
- [ ] **Step 3: implement.** In `take`, build the anchors as `commit` does (`end`), then
  `const got = await ctx.measure({ measure, layout, revision, a: from, ...(to ? { b: to } : {}) })`. Hold
  `{ ...probe, objectId: ctx.objectId, camera, ...got }` with `setHeld`, and show
  `ctx.readout.show(held.client, valueText(measure, got.value), got.how)`. The `mine !== committing` guard, the draft
  and the `catch` branch stay as they are.
- [ ] **Step 4:** run the focused test, then `pnpm -C app typecheck`.
- [ ] **Step 5: commit** the five files, message `Measure reads out the kernel's value and keeps no mark: the last measurement is held in state/measured.ts`.

### Task 3: keep as a dimension (button and `Enter`)

**Files:**
- Modify: `app/src/shared/keys.ts` (row `measure.keep`)
- Modify: `app/src/shared/keys.test.ts` (if it lists rows or scopes explicitly)
- Modify: `app/src/renderer/tools/measureTool.ts` (`onKey`: `pressed(e, 'measure.keep')`, and an exported `keepHeld(ctx)`)
- Modify: `app/src/renderer/ui/ToolPalette.tsx` (`MeasureChoice`: the `Last:` part and the button)
- Modify: `app/src/renderer/styles/tools.css` (`.measure-last`: muted `how`, the `num` value, tokens only)
- Test: `app/src/renderer/tools/measure.test.ts`, `app/e2e/measure.spec.ts`

- [ ] **Step 1: failing unit tests.** After two clicks, `Enter` calls `ctx.commit` once with
  `{ kind: 'dimension', measure: 'distance', author: 'user', note: '', layout, revision, camera, a, b }`, which is
  exactly what was committed before. `held.kept` becomes `'M1'`. A second `Enter` keeps nothing more. `Enter` with
  nothing held returns false. If the commit is refused, the reason is read out and the measurement stays held.
- [ ] **Step 2: failing e2e** in `measure.spec.ts`. Turn the existing tests into these:
  - "two clicks … 6 mm between planes" now expects the strip `Last: 6 mm` and **no** row in Marks
    (`marks.json` has none). Then `Keep as a dimension` makes the row `M1`, with the same value, and the strip says
    `Kept as M1`.
  - A double click on the hole gives `⌀ 8` in the strip. `Enter` keeps it.
  - "T over a face …" gives a readout and no mark.
  - "a dimension is given to the agent with the next prompt": measure without keeping, send a prompt, and the
    stand-in's context has no dimension. Keep it, send again, and it does.
  - The gauge, expected-value, build-fails and passes tests keep their dimensions through the button first.
  - "the picture for the agent shows both dimensions …" is unchanged once they are kept.
- [ ] **Step 3: implement.** The button and `Enter` call the same thing. `MeasureChoice` cannot reach the tool's
  `ctx`, so make the keeping a function of the held measurement:
  `keepHeld(commit)` builds the `NewMark` from `held`, then calls `commit` (`commitMark(objectId, mark)` from
  `ViewportPane`, passed in or imported as `ViewportPane` does). `ViewportPane` gives the strip an `onKeep`.
  Check `held.objectId`/`revision` against the object shown and hide the part when they differ.
- [ ] **Step 4:** `pnpm -C app exec vitest run src/renderer/tools/measure.test.ts src/shared/keys.test.ts`, then
  `pnpm build && pnpm -C app exec playwright test e2e/measure.spec.ts`.
- [ ] **Step 5: commit** the files above, message `Keep as a dimension: the last measurement becomes a mark by the strip's button or Enter (measure.keep)`.

### Task 4: the palette in three groups

**Files:**
- Modify: `app/src/shared/keys.ts` (`TOOL_KEYS`: a `group` on each row, rows in group order)
- Modify: `app/src/renderer/state/tools.ts` (`TOOLS` carries `group`; export `TOOL_GROUPS = [{ group: 'inspect', label: 'Inspect' }, { group: 'mark', label: 'Mark' }, { group: 'scan', label: 'Scan' }]`)
- Modify: `app/src/renderer/ui/ToolPalette.tsx` (one `role="group"` per group, a `toolbox-rule` between)
- Modify: `app/src/renderer/styles/tools.css` (only if the groups need a gap; `.toolbox-rule` lives in `keys.css`)
- Test: `app/src/shared/keys.test.ts`, `app/e2e/tools.spec.ts`

- [ ] **Step 1: failing tests.** In `keys.test.ts`, every tool has a group, and the rows come in the order of
  `TOOL_GROUPS`. In `tools.spec.ts`, the toolbar has groups `Inspect`, `Mark` and `Scan`, with buttons
  `[select, measure, section]`, `[pin, arrow, draw, shape, region]` and `[align]` (read by `data-tool`). The keys
  still take each tool.
- [ ] **Step 2:** run them and see them fail.
- [ ] **Step 3: implement.** Keep the Shape button's choice and Region's `data-waiting` as they are, inside their group.
- [ ] **Step 4:** `pnpm -C app exec vitest run src/shared/keys.test.ts src/readme.test.ts`. The key table's order
  changes, so run `TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts` and review the README diff.
  Then `pnpm build && pnpm -C app exec playwright test e2e/tools.spec.ts e2e/themes.spec.ts`.
- [ ] **Step 5: commit** the files above and `README.md`, message `The palette in three groups: inspect, mark and scan, split by a rule`.

### Task 5: docs

**Files:**
- Modify: `app/src/renderer/CLAUDE.md` (Marks: tools and keys. The Measure paragraph: a measurement is held in
  `state/measured.ts` and kept only by `measure.keep` / the strip. The groups of `TOOL_KEYS`.)
- Modify: `app/src/main/CLAUDE.md` (dimensions: `measureOnce` / `geometry:measure` writes nothing and shares the
  refusals of `addDimensionTold`. A measurement not kept is told to no one.)
- Modify: `README.md` ("Measuring and dimensions": the readout, `Last:`, `Keep as a dimension`, `Enter`. The Marks
  table row for `M`: `Measures; Enter keeps a dimension.`)
- Modify: `docs/superpowers/specs/2026-10-08-torno-design.md` (the Measure tool and the palette's groups)
- Test: `app/src/readme.test.ts`

- [ ] **Step 1:** write the sections in the folders' own style. Where the `M` row's text comes from `TOOL_KEYS.does`,
  change `does` to `Measure: two clicks, or a double click on a round thing; nothing is kept unless you keep it`
  and rewrite the README table with `TORNO_README=write`.
- [ ] **Step 2:** `pnpm -C app exec vitest run src/readme.test.ts`, then all four suites and `pnpm -C app typecheck`.
- [ ] **Step 3: commit** the four docs (and `app/src/shared/keys.ts` if `does` changed), message `Docs: Measure reads out and keeps a dimension only when asked; the palette's groups`.

# Groups of parts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model can say which of its parts belong together (`groups(p)`), and both sides use it. The person sees
the groups in the layers list, where they can fold one, hide or show it with one eye, or show only that group. Claude Code makes
groups by writing `groups(p)` in the model, reads them in `scene`, `state.md` and `describe`, and can name a group
wherever `show`, `look`, `save_view` and `highlight` take part names: "show the flat spoiler" is
`show({parts: ["flat"]})`.

**Architecture:** A worker reads the optional `groups(p)` while it loads the model (`loader.load_model`), checks it
against the part names of every layout, and sends it with the scene (`scene["groups"]`, next to `scene["params"]`).
The supervisor passes the frame on without reading it. `Scene.groups` (`shared/scene.ts`) is
`{name, parts}[]`, one level deep, across layouts by part name. A new `shared/groups.ts` holds the one function that
turns a list of part or group names into part names for a layout (`partsNamed`). Main's tools call it before they
build a request, the renderer calls it in `show`/`proposeView`, and `ui/Layers.tsx` uses it to fold rows under a
group header. Whether a group is folded is kept per object in `.torno/scene.json` (`folded`).

**Tech Stack:** Python 3 / build123d (kernel, pytest), Electron + TypeScript + React + zustand (vitest, Playwright),
zod schemas for the MCP tools.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (sections on the layers list, the MCP tools and the
model contract), plus Issue #20 "Groups of parts, for the person and for Claude Code".

**Phases** (each can ship alone):

- **Phase 1, groups in the window (Tasks 1 to 5).** The kernel reads `groups(p)`, the scene carries it, and the layers
  list folds, hides, shows and solos a group. This is useful as soon as the person (or the agent, unprompted) writes `groups(p)`.
- **Phase 2, the agent's side (Tasks 6 to 9).** Group names in `show`/`look`/`save_view`/`highlight`; groups in `scene`
  and `state.md`; the skill tells the agent how to make them; the README and the docs.
- **Phase 3, extras (Tasks 10 to 11).** `describe` of a group (its box and volume), explode by group.

## Global Constraints

- The kernel supervisor only imports. It never loads a model, builds, tessellates or answers a query. Groups are read
  by the worker that loads the model and cross the protocol inside the scene frame. Workers never fork.
- Kernel stdout carries protocol frames only; what `groups(p)` prints goes to the captured buffer like any model output.
- Units are millimetres, Z up; coordinates crossing a process boundary are in the object frame unless named `local`.
- Never write inside a user workspace except under `<object>/.torno/`. torno never writes the model file: a group
  is made by whoever edits the source (the person or the agent), and torno itself writes only `folded` in
  `.torno/scene.json`.
- `uv run --no-sync` only, and only when `<workspace>/.venv` exists. No new npm or Python dependency.
- Tests never open a visible window (`TORNO_TEST=1`, `show: false`), never `--ozone-platform=headless`, never
  `page.screenshot()`, never the clipboard, never a real agent CLI (`TORNO_AGENT_CMD` is `app/test/fake-agent.mjs`).
  e2e works on a temporary copy of `kernel/tests/fixtures/ws` (read `app/e2e/CLAUDE.md` before launching).
- Every key is a row of `shared/keys.ts`; this plan adds no key (the group's buttons are clicked). If one is added
  later it goes through `keys.ts` and the README's table (`TORNO_README=write`).
- UI text is sentence case. Part names, group names and refs are set in the monospace face (`num`).
- Colours, sizes and spacing come from `app/src/renderer/styles/tokens.css` only. Don't copy nerv's look: no black, red or amber, no
  condensed uppercase labels, no corner-tick frames.
- No per-frame state in React.
- `README.md` names every MCP tool as `mcp__torno__<name>` and `app/src/readme.test.ts` holds it to `TOOLS`: no tool
  is added here, but descriptions that change are reflected in the README's text.
- Never write under `/home/luisgonc/objects/` (the `micra-spoiler` example is read only).
- Stage explicit paths (`git add <file> …`), never `git add -A`.
- Before each commit run all four suites: `pnpm test`, `pnpm test:kernel`, `pnpm test:e2e`, `pnpm -C app typecheck`.
  When `kernel/` changes, also run `(cd kernel && uv run --no-sync pytest -q)`.
- Commit after every task, with a message that describes the change and ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (confirmed 2026-10-16)

Confirmed on #20: Every recommendation below holds. The owner chose decision 2's recommendation: groups are defined in the model (`groups(p)`); no `.torno/groups.json`, no group tools, no "Group" action in the window.

The owner brainstorms each issue. Each decision below gives a recommendation and the main alternative. **[changes tasks]** means
that the other answer changes the task list.

1. **Group or variant?** *Recommend:* one idea, a group, with a "show only this group" action (solo). The two spoilers
   are groups that are never shown together, and the person and the agent express that by soloing one. A stand's left half
   is a group shown with the rest. The difference is in how a group is used, so the data needs no second kind.
   *Alternative:* variants as extra layouts (`assembly-flat`, `assembly-aggressive`). That changes the loader's layout
   convention (today only `assembly`, `print` and `main` exist) and doubles every build, so it is not recommended. *Alternative 2:* a
   `kind: "group" | "variant"` field, where opening a variant hides its siblings. That is small to add later on top of this
   shape. Not **[changes tasks]** unless the owner chooses layouts.

2. **Where is a group defined?** *Recommend:* in the model, as an optional `groups(p) -> dict[str, list[str]]` (group
   name to part names). The build stays the one truth, and a rename that leaves a group stale fails the build
   loudly, telling the agent how to fix it. **Create:** the agent edits the model file, as it edits everything else, and the
   skill tells it how. The person asks the agent, or writes the function themselves. **Read:** `scene`, `state.md`,
   `describe`, and the layers list. *Alternative:* `.torno/groups.json`, written by main from the window (a "Group"
   action on selected rows) and from a new MCP tool `set_group({name, parts})` / `remove_group({name})`. That works for
   any model and the person can group with no code, but the groups live apart from the source, go stale on a rename,
   and add two tools (README and `TOOLS`). **[changes tasks]**: Task 1 is dropped (no kernel change), and Task 2 becomes a
   `main/groups/store.ts` (one writer, atomic, as `marks/store.ts`) with two new tools and a window action. Tasks 3 to 11
   then read `groups` from that store instead of `Scene`. *Rejected:* inferring groups from name prefixes. It is a guess
   (`agressiv-` and `flat-` would work, `key` would not), but the skill does suggest prefixes as a naming habit.

3. **Refs.** *Recommend:* a group name is not a ref and gets no new grammar. It follows the part-name rule plus two
   checks the loader makes: no `/` in it, it is not the name of a part in any layout, and it is not `M<n>`. So wherever
   a part name is taken, a group name can be given unambiguously. In `highlight`'s `refs`, a bare group name stands for
   all of its parts in the layout. `F<i>`/`E<i>` never follow a group. *Alternative:* a prefix such as `group:flat`.
   It is explicit, but it is one more grammar for the agent and the kernel to learn. Not **[changes tasks]**: only
   `partsNamed` and its messages change.

4. **What the agent gets.** *Recommend:* `scene` gains `groups: [{name, parts, visible: "all" | "some" | "none"}]`
   for the layout shown. `state.md` lists them under each layout. `show`, `look` and `save_view` take group names in
   `parts`, and `highlight` takes them in `refs`. `describe` of a group name gives its box and volume (Phase 3). A mark on a
   whole group is left out: a mark on the group's first part, with a note, says the same. *Alternative:* group marks
   (`ref: "flat"`). That touches `shared/marks.ts`, the anchor check against a build and `marks.json`, so it would be a plan
   of its own. **[changes tasks]** only if it is wanted now.

5. **Per layout or across layouts?** *Recommend:* across layouts, by part name, as a layer's settings already are.
   A group in a layout is those of its parts the layout has. A group with none of its parts there is not shown in that layout, and a
   name that is in no layout fails the build. *Alternative:* `groups(p)` returns `{layout: {group: [parts]}}`. That is more
   to write, and print and assembly would disagree for no gain. Not **[changes tasks]** beyond the loader's check.

6. **What else follows a group?** *Recommend:* now, the eye, solo, fold, saved views (which already store hidden part
   names, so a view made with `parts: ["flat"]` is saved as part names and outlives a group's removal), and `describe`
   (box and volume, exact only when every part's are). Phase 3 adds explode by group (a group moves as one body). Left out:
   export of one group (export takes the visible parts already, so solo and then export gives that) and thumbnails (they draw what is shown).
   *Alternative:* export a group to its own file. That would be a new choice in the save dialog, a separate issue.

7. **How deep?** *Recommend:* one level, and a part is in at most one group, so the layers list is a tree with no
   repeats. Parts in no group are listed after the groups, in their model order. *Alternative:* overlapping
   groups (tags), where a part can be in "left" and in "flat". That is more expressive, but the eye of a part shown in two groups is ambiguous.
   **[changes tasks]**: Task 1's check is dropped and Task 4 lists a part under each of its groups.

## Design

### The model declares groups (the spoiler)

```python
def groups(p: Params) -> dict[str, list[str]]:
    """Parts that belong together: a name each, for the layers list and for the agent."""
    return {name: [f"{name}-{label}" for label in part_names(p.n_parts)] for name, _ in p.meshes}
```

For `micra-spoiler` this gives `{"agressiv": [5 parts], "flat": [5 parts]}`, and `key` stays ungrouped. `groups` is called
with the same `Params()` as `assembly`/`printables`. It is optional: a model without it has no groups. It is read only
under the `Params` convention (`assembly`/`printables`/`make_<part>`), never for top-level shapes.

The loader refuses the following with `LoadError("exception", …)`, so that the build fails and the message reaches the agent:

- `groups()` that does not return a `dict` of `str` to a list or tuple of `str`;
- a group name that is empty, contains `/`, matches `M\d+`, or is the name of a part in some layout;
- a part name that is in no layout (`groups() names flat-centre, which no layout has; parts: …`);
- a part in two groups;
- an empty group.

### Across processes

```ts
// shared/scene.ts
/** Parts that belong together, as the model's groups(p) gave them: one level, a part in one group at most, by part name across layouts. */
export interface PartGroup { name: string; parts: string[] }
export interface Scene { /* … */ groups?: PartGroup[] }   // absent from a kernel that does not read them
```

The order is the model's dict order. `parts` holds the names as given, and some of them may be missing from a given layout.

```ts
// shared/groups.ts
/** The groups of a layout: those with a part in it, each with only those parts, in model order. */
export function groupsIn(scene: Scene, layout: string): PartGroup[]
/** The group a part of the layout is in, or undefined. */
export function groupOf(scene: Scene, name: string): PartGroup | undefined
/**
 * Part or group names, as a tool or the window gives them, to the part names of the layout they stand for:
 * each group by its parts there, in order, without repeats. A name that is neither is the failure's text,
 * worded as today's "unknown part '…'; parts in layout …", plus "; groups: …" when the scene has groups.
 */
export function partsNamed(scene: Scene, layout: string, names: readonly string[]): string[] | { unknown: string; text: string }
```

### The layers list

`ui/Layers.tsx` draws each group of `groupsIn(scene, layout)` as a header row (`li.layer-group`, `data-group={name}`):

- a fold chevron (`button`, `aria-expanded`, label `Fold flat` / `Unfold flat`);
- the name in `num`, and the count `5 parts` in `num`;
- a "Show only" button (`aria-label="Show only flat"`, the target icon, shown on hover like the opacity slider). It
  switches on the group's parts and switches off every other part of the layout, as one edit;
- an eye whose state is `all` (open), `none` (closed) or `some` (open, at `--text-muted`), with `aria-pressed` being
  `true`, `false` or `mixed`. A click on `some` or `all` hides the group, and a click on `none` shows it.

Under the header come the member rows as they are today, indented by `--space-3`. Ungrouped parts follow. A folded
group hides its rows. Folding is stored in `scene.json` as `folded: string[]` (group names) by
`actions.setFolded(name, on)`, which counts in `edits` so the scene file is saved. `sceneFileOf` drops a
`folded` that is not a list of strings. A model with no groups draws exactly today's list.

Store actions (in `renderer/state/store.ts`, beside `setLayer`): `setLayers(names, settings)`, one edit over many
parts that clears `shownByAgent` as `setLayer` does, and `soloLayers(layout, names)`.

### MCP

- `schemas.ts` `showInput.parts`: "Names of parts or groups to leave switched on (a group stands for its parts in the
  layout, as scene lists them under groups); every other part of the layout is hidden. Default: no part is switched."
  The same wording goes to `lookInput.parts` and `saveViewInput.parts`. `highlightInput.refs` gets the sentence "A group name
  stands for all of its parts."
- The `scene` description gains: "under groups the groups of parts the model's groups(p) declares, each with its
  parts in the layout shown and whether they are visible (all, some, none); a group name can be given wherever parts
  are named".
- `describe` description: "or of a group (a group name, as scene lists them): the box of its parts and their total
  volume" (Phase 3).
- The expansion happens in main before the request goes to the window (`showTool`, `lookTool`, `saveViewTool`,
  `highlightTool`). The renderer's `show`/`proposeView`/`picture` also accept group names through `partsNamed`, so that a
  saved view's `parts` and a request made in the window agree.

### The skill (`app/resources/agent-plugin/skills/torno-model/SKILL.md`)

A section "Groups" after "What torno takes from it" says the following. When parts belong together (one of two alternatives, a
sub-assembly, the pieces a part is cut into), define `groups(p)` returning group name to part names. One level only, a part in one
group at most, no `/` in a name, and no name shared with a part. Group names are then accepted in `show`, `look`, `save_view`,
`highlight` and `describe`. Name parts with the group as a prefix (`flat-centre`) so that a reader of the file sees it too. The
template gets a commented `groups` example.

---

## Phase 1: groups in the window

### Task 1: The kernel reads `groups(p)`

**Files:**
- Create: `kernel/tests/fixtures/ws/grouped/grouped.py`
- Modify: `kernel/src/torno_kernel/loader.py` (`load_model`, new `_groups`), `kernel/src/torno_kernel/worker.py` (`scene["groups"]`)
- Test: `kernel/tests/test_loader.py`, `kernel/tests/test_supervisor.py` (the scene frame)

**Interfaces:** `load_model(dir, model) -> tuple[layouts, params, groups]` where `groups: list[dict]` is `[{"name", "parts"}]`.
`load_scene` is unchanged (it returns `[0]`).

- [ ] **Step 1: The fixture.** `grouped.py` is `bracket.py`'s form with four parts and two groups:

```python
from dataclasses import dataclass
from build123d import Box, Pos

@dataclass(frozen=True)
class Params:
    size: float = 10

def assembly(p):
    return {"flat-a": Box(p.size, p.size, 2), "flat-b": Pos(20, 0, 0) * Box(p.size, p.size, 2),
            "tall-a": Pos(0, 0, 0) * Box(p.size, p.size, 8), "key": Pos(0, 30, 0) * Box(4, 4, 4)}

def printables(p):
    return {name: Pos(40 * i, 0, 0) * shape for i, (name, shape) in enumerate(assembly(p).items())}

def groups(p):
    return {"flat": ["flat-a", "flat-b"], "tall": ["tall-a"]}
```

Before committing, grep `app/e2e` and `app/src` for tests that count the objects of the fixture workspace
(`grep -rn "bracket.*two\|objects.*toHaveCount" app/e2e`) and update any count the new folder changes.

- [ ] **Step 2: Failing tests** in `test_loader.py`:

```python
def test_groups_are_read_in_model_order(ws):
    _, _, groups = load_model(ws / "grouped", "grouped.py")
    assert groups == [{"name": "flat", "parts": ["flat-a", "flat-b"]}, {"name": "tall", "parts": ["tall-a"]}]

def test_no_groups_function_gives_none(ws):
    assert load_model(ws / "bracket", "bracket.py")[2] == []

@pytest.mark.parametrize("body, said", [
    ('{"flat": ["nope"]}', "groups() names nope, which no layout has"),
    ('{"flat/x": ["flat-a"]}', "a group name has no /"),
    ('{"key": ["flat-a"]}', "group key has the name of a part"),
    ('{"a": ["flat-a"], "b": ["flat-a"]}', "flat-a is in groups a and b"),
    ('{"a": []}', "group a has no parts"),
    ('["flat-a"]', "groups() must return a dict of group name to part names"),
])
def test_bad_groups_fail_the_build(ws, tmp_path, body, said):
    src = (ws / "grouped" / "grouped.py").read_text().replace(
        'return {"flat": ["flat-a", "flat-b"], "tall": ["tall-a"]}', f"return {body}")
    (tmp_path / "g.py").write_text(src)
    with pytest.raises(LoadError, match=re.escape(said)):
        load_model(tmp_path, "g.py")
```

Also add `M3` as a refused name. Run `(cd kernel && uv run --no-sync pytest -q tests/test_loader.py)`, which should fail.

- [ ] **Step 3: Implement.** In `loader.py`, `_collect_scene` stays as it is. `load_model` calls `_groups(module, scene)` inside the same
`try` (so an exception in `groups()` is a `LoadError("exception", …, _model_traceback(...))`). `_groups` returns `[]`
when the module has no callable `groups` or no `Params`. Otherwise it calls `module.groups(module.Params())` and
checks the result in the order given in Design. Then, in `worker.py` beside `scene["params"] = params`, set
`scene["groups"] = groups`.

- [ ] **Step 4: The frame.** Add a case to `test_supervisor.py` that builds `grouped` through the supervisor and asserts that
`scene["groups"]` arrives. This pins that the supervisor passes it through and does not load the model. Run the whole kernel
suite: `(cd kernel && uv run --no-sync pytest -q)`.

- [ ] **Step 5: Commit** `kernel/src/torno_kernel/loader.py kernel/src/torno_kernel/worker.py kernel/tests/test_loader.py kernel/tests/test_supervisor.py kernel/tests/fixtures/ws/grouped/grouped.py`
("Kernel: a model's groups(p), checked against its parts and sent with the scene").

### Task 2: `Scene.groups` and `shared/groups.ts`

**Files:**
- Modify: `app/src/shared/scene.ts` (`PartGroup`, `Scene.groups?`)
- Create: `app/src/shared/groups.ts`, `app/src/shared/groups.test.ts`
- Test: `app/src/main/kernel/client.itest.ts` (the real kernel gives `groups` for `grouped`)

- [ ] **Step 1: Failing unit tests** in `groups.test.ts`, on a hand-made `Scene` of the fixture's shape:
  `groupsIn` drops a group with no part in the layout and keeps only present parts. `partsNamed(scene, 'assembly',
  ['flat', 'key'])` gives `['flat-a', 'flat-b', 'key']`, `['flat-a', 'flat']` gives no repeat, and `['nope']` gives
  `{ unknown: 'nope', text: "unknown part 'nope'; parts in layout assembly: flat-a, flat-b, tall-a, key; groups: flat, tall" }`.
  A scene without `groups` gives today's text exactly (no "; groups"). `groupOf` returns the group or undefined.
- [ ] **Step 2:** `pnpm -C app exec vitest run src/shared/groups.test.ts` fails, then implement, then it passes.
- [ ] **Step 3:** In `client.itest.ts`, build `grouped` and expect `scene.groups` to equal the fixture's groups. Run
  `pnpm -C app exec vitest run --mode kernel src/main/kernel/client.itest.ts`.
- [ ] **Step 4: Commit** the four files ("Shared: a scene's groups of parts, and part or group names to parts").

### Task 3: Store actions and `folded` in the scene file

**Files:**
- Modify: `app/src/shared/scenefile.ts` (`SceneFile.folded?: string[]`, `sceneFileOf`), `app/src/renderer/state/store.ts`
  (`folded` in state and `NO_OBJECT`, loaded at line ~204 and written in the scene-file builder at line ~739,
  `setLayers`, `soloLayers`, `setFolded`)
- Test: `app/src/main/scenefile.test.ts`, `app/src/renderer/state/store.test.ts` (find the file that tests `setLayer` with
  `grep -rln "setLayer" app/src --include=*.test.ts`)

- [ ] **Step 1: Failing tests.** `sceneFileOf` keeps `folded: ['flat']` and drops `folded: 'flat'` and `[1]`.
  `setLayers(['flat-a','flat-b'], {visible:false})` is one `edits` step and clears `shownByAgent`.
  `soloLayers('assembly', ['flat-a','flat-b'])` leaves exactly those parts of the layout visible and does not touch parts of
  other layouts that have no namesake. `setFolded('flat', true)` adds the name and `false` removes it, and the scene file written
  holds `folded` only when it is not empty.
- [ ] **Step 2:** Implement, following `setLayer` (line 246) for `shownByAgent` and `edits`. A folded name of a group
  the scene no longer has is kept, as a layer of a vanished part is kept for a while (line ~227 drops layers of gone
  parts; drop folded names of gone groups in the same place).
- [ ] **Step 3:** Run the two focused tests, then `pnpm -C app typecheck`.
- [ ] **Step 4: Commit** ("Store: hide, show and solo many parts as one edit; folded groups kept in scene.json").

### Task 4: The layers list draws groups

**Files:**
- Modify: `app/src/renderer/ui/Layers.tsx`, `app/src/renderer/styles/layout.css` (or the stylesheet that holds
  `.layer-row`: `grep -rn "layer-row" app/src/renderer/styles`)
- Test: `app/src/renderer/ui/Layers.test.tsx` if the renderer has component tests (`ls app/src/renderer/ui/*.test.*`);
  otherwise the behaviour is pinned in Task 5's e2e, and the pure parts (header eye state `all|some|none`) go into
  `shared/groups.ts` as `groupVisibility(names, layers)` with a unit test in `groups.test.ts`.

- [ ] **Step 1: Failing test** for `groupVisibility`: all visible gives `'all'`, a mix gives `'some'`, none gives `'none'`, with an absent layer counted as visible.
- [ ] **Step 2: Implement** the rows as described in Design ("The layers list"). Reuse `EyeIcon`. The "Show only" icon is a
  small inline SVG drawn like `EyeIcon` (stroke `currentColor`, 1.25). The header is `li.row.layer-group`, the member rows keep
  `data-layer` and gain `data-in-group`, and a folded group renders no member rows. Sentence case labels: "Fold",
  "Show only flat", "Hide flat" / "Show flat". The names and counts are in `num`. Indent and muted colour come from tokens only.
- [ ] **Step 3:** `pnpm -C app exec vitest run src/shared/groups.test.ts` and `pnpm -C app typecheck`.
- [ ] **Step 4: Commit** `Layers.tsx`, the stylesheet, `groups.ts`, `groups.test.ts` ("Layers: groups fold, hide, show and solo their parts").

### Task 5: e2e for the layers list

**Files:**
- Create: `app/e2e/groups.spec.ts`

Read `app/e2e/CLAUDE.md` first. Use the helpers that `loop.spec.ts` uses to open a copy of the fixture workspace and
an object (`layerNames` at line 49 is a model for the reads).

- [ ] **Step 1: Write the spec.** Open `grouped`. The list shows headers `flat` and `tall`, then `key`, and
  `[data-in-group]` rows under each. Click "Hide flat": both `flat-*` rows get `data-hidden`, and the header's eye has
  `aria-pressed="false"`. Show one `flat-*` row again, and the header shows `aria-pressed="mixed"`. Click "Show only tall": only
  `tall-a` is visible in the layout. Fold `flat`: its rows are gone. Reload the object: it is still folded (from
  `scene.json`). Open `bracket`: no header row, and the list is as before.
- [ ] **Step 2:** `pnpm build && pnpm -C app exec playwright test e2e/groups.spec.ts`.
- [ ] **Step 3:** Run the four suites, then commit `app/e2e/groups.spec.ts` ("e2e: groups in the layers list").

## Phase 2: the agent's side

### Task 6: Group names in `show`, `look`, `save_view`

**Files:**
- Modify: `app/src/main/mcp/viewTools.ts` (`showTool` ~298, `lookTool` ~142, `saveViewTool` ~471, `besideView` ~431),
  `app/src/main/mcp/schemas.ts` (`lookInput.parts`, `showInput.parts` ~130, `saveViewInput.parts` ~149),
  `app/src/renderer/state/agent.ts` (`show` ~78, `proposeView` ~163, and the look path that checks `req.parts`)
- Test: `app/src/main/mcp/tools.test.ts`, `app/src/main/mcp/server.itest.ts`

- [ ] **Step 1: Failing tests** in `tools.test.ts`, with a scene fake that has groups:
  `show({parts: ['flat']})` sends `request.parts` `['flat-a','flat-b']`. `save_view({name:'Flat', parts:['flat','key']})`
  sends the parts expanded. An unknown name fails with `partsNamed`'s text (which names the groups). `look({parts:['tall']})` sends `['tall-a']`.
- [ ] **Step 2: Implement.** In each tool, after the layout is known, replace `args.parts` with
  `partsNamed(scene, layout, args.parts)` and fail with its `text`. In `saveViewTool`, this replaces the `unknown` check at
  ~486. In `agent.ts`, the three loops of `unknown part` call `partsNamed` the same way, so that the window agrees.
  The schema descriptions are worded as in Design.
- [ ] **Step 3:** `server.itest.ts`: against the real kernel and the `grouped` fixture, `show({parts:['flat']})` is
  answered with the two parts named in the reply. Run `pnpm -C app exec vitest run src/main/mcp/tools.test.ts` and
  `pnpm -C app exec vitest run --mode kernel src/main/mcp/server.itest.ts`.
- [ ] **Step 4: Commit** ("MCP: a group's name stands for its parts in show, look and save_view").

### Task 7: Group names in `highlight`

**Files:**
- Modify: `app/src/main/mcp/markTools.ts` (`checkRef` ~50 or `highlightTool` ~176), `schemas.ts` (`highlightInput.refs`)
- Test: `app/src/main/mcp/tools.test.ts` (beside the cases at ~689 to 730)

- [ ] **Step 1: Failing tests.** `highlight({refs:['flat']})` highlights `flat-a` and `flat-b`, and the reply names them.
  `flat/F1` stays an error ("no part 'flat' …; flat is a group: its parts are flat-a, flat-b"). The combined
  failure text at ~730 is unchanged for a scene without groups.
- [ ] **Step 2: Implement** in `highlightTool`: before `checkRef`, a bare ref that is a group name of the layout
  is replaced by its parts. In `checkRef`'s "no part" message, add the "is a group" clause when `groupOf` finds it.
- [ ] **Step 3:** Run the focused test. **Step 4: Commit** ("MCP: highlight a whole group by its name").

### Task 8: Groups in `scene` and `state.md`

**Files:**
- Modify: `app/src/main/mcp/viewTools.ts` (`sceneTool` ~52 to 120), `app/src/main/statefile.ts` (`stateText`, the
  "Layouts and parts" block ~39 to 50), `schemas.ts` (`TOOLS.scene.description`)
- Test: `app/src/main/mcp/tools.test.ts` (or `readTools.test.ts`, wherever `sceneTool` is tested:
  `grep -rn "sceneTool" app/src/main --include=*.test.ts`), `app/src/main/statefile.test.ts`

- [ ] **Step 1: Failing tests.** `scene` JSON has `groups: [{name:'flat', parts:['flat-a','flat-b'], visible:'all'}, …]`
  for the layout on screen, with `visible` from `groupVisibility` on the view's visible parts, and there is no `groups` key when the
  scene has none. Each entry of `parts` gains `group: 'flat'` when the part is in one. `stateText` writes
  `- assembly: groups flat (flat-a, flat-b), tall (tall-a); flat-a 10 × 10 × 2 mm, …` (it keeps the existing per-part
  line and adds a `groups` line before it only when there are groups).
- [ ] **Step 2: Implement** and update `TOOLS.scene.description` as worded in Design.
- [ ] **Step 3:** Run the focused tests and `pnpm test` (the README test reads `TOOLS`).
- [ ] **Step 4: Commit** ("Agent context: groups in scene and state.md").

### Task 9: The skill, the README and the docs

**Files:**
- Modify: `app/resources/agent-plugin/skills/torno-model/SKILL.md` (a "Groups" section, a commented `groups(p)` in the
  template), `README.md` (the layers list and the `show`/`highlight` text), `CLAUDE.md` (root, "What crosses
  processes": one bullet on groups), `app/src/main/CLAUDE.md` (MCP tools: group names expanded by `partsNamed` in main
  before a request, the `scene`/`state.md` groups), `app/src/renderer/CLAUDE.md` (the layers list: headers, fold, solo,
  `folded`), `app/src/shared/CLAUDE.md` (`groups.ts`, `folded` in the view state), `kernel/CLAUDE.md` (the worker
  reads `groups(p)`, and the supervisor passes it), `docs/superpowers/specs/2026-10-08-torno-design.md` (the layers
  list and the model contract)
- Test: `kernel/tests/test_skill_template.py` (the template still builds, and now with groups), `app/src/readme.test.ts`

- [ ] **Step 1:** Add `groups` to the skill's template, and assert in `test_skill_template.py` that the built template gives
  the groups. Run `(cd kernel && uv run --no-sync pytest -q tests/test_skill_template.py)`, which fails and then passes.
- [ ] **Step 2:** Write the docs. Keep the README's headings in order (`readme.test.ts`). Run `pnpm -C app exec vitest
  run src/readme.test.ts`.
- [ ] **Step 3:** Run the four suites and the kernel suite, then commit the listed files ("Docs and skill: groups of parts").

## Phase 3: extras

### Task 10: `describe` of a group

**Files:**
- Modify: `app/src/main/mcp/readTools.ts` (the `describe` handler ~149), `schemas.ts` (`describeInput.ref`, `TOOLS.describe.description`)
- Test: `app/src/main/mcp/readTools.test.ts`, `app/src/main/mcp/server.itest.ts`

The supervisor answers no query, and a part's box and volume are already in the scene (the kernel's, with `bboxExact` and
`volumeExact`). So `describe` of a group needs no new kernel query: main combines the parts of the scene.

- [ ] **Step 1: Failing test.** `describe({ref:'flat'})` gives `{type:'group', name:'flat', parts:[…], bbox, bboxExact,
  volume, volumeExact, descriptor}`, where the bbox is the union of the parts' boxes and the volume is the sum. Each Exact flag
  is true only when every part's is (the box of an inexact part is widened, so the union is not exact). The descriptor
  goes through `marks/describe`'s `sizes`/`number`, with `≈` when it is not exact. The revision and stale note are as for a part.
- [ ] **Step 2: Implement.** A group name is checked before `deps.describe` is called. **Step 3:** Run the focused tests.
- [ ] **Step 4: Commit** ("MCP: describe a group: the box of its parts and their volume").

### Task 11: Explode by group

**Files:**
- Modify: `app/src/shared/explode.ts` (and its caller in the viewport; find it with `grep -rn "from '.*shared/explode'" app/src/renderer`)
- Test: `app/src/shared/explode.test.ts`, `app/e2e/explode.spec.ts` (one case)

Read `app/src/shared/CLAUDE.md` and `app/src/renderer/CLAUDE.md` "Explode" first.

- [ ] **Step 1: Failing test.** When the scene has groups, the explode offsets are worked out per group (a group's
  box centre moves, and every part of the group gets that same offset). Ungrouped parts are treated as groups of one. Without groups,
  the offsets are exactly as today.
- [ ] **Step 2: Implement** by passing `groupOf` into the function that places parts apart. The e2e case explodes
  `grouped` and checks that `flat-a` and `flat-b` moved by the same vector, through the test hook already used by `explode.spec.ts`.
- [ ] **Step 3:** Run the focused tests, the four suites, then update the "Explode" sections of `shared/CLAUDE.md` and
  `renderer/CLAUDE.md` and commit ("Explode: a group moves as one").

# Torno Milestone 5 "Show" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The parts of an object can be drawn apart, the way of looking at it can be saved under a name and asked for by the agent, the objects of a workspace are on one page of cards, an object or several can be written out as one HTML file that needs nothing else, a second agent CLI can be embedded, and a first-time reader can start torno and find their way.

**Architecture:** Explode is view state per layout: the viewport adds a display offset to each part's group and takes it away again from every pick, so nothing that is stored or told ever holds a displayed position. Saved views live in `scene.json`, which stays the window's file to write; main remembers the last file it read or was given, and resolves a view's name for `look` and `show`. Thumbnails are drawn by the window from the scenes main already broadcasts and cached under `.torno/`. The export is built in main from the last build's blob (meshes quantised and deflated) around a viewer of its own (three.js and OrbitControls, bundled once at build time). An agent adapter says whether its CLI posts hooks; one that does not is told through `.torno/prompt.md` and a line the person sends.

**Tech Stack:** as Milestones 1 to 4. No new dependency: the exported page's viewer is bundled by `vite` (already a devDependency) from `three` 0.186.1; meshes are packed with node's `zlib`; the page inflates them with the browser's `DecompressionStream`. Fonts in the page are the three woff2 files of `@fontsource/ibm-plex-*` already installed.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md`, sections 3 (files torno writes), 6 (sessions, the adapter, the tools), 7 (layers: explode; views: named), 9 (show, export), 10 (design language), 13. Task 1 amends its text where the Decisions below depart from it or add to it. Experiments this plan cites: `.superpowers/sdd/m5-notes.md` (E1 to E4).

Read `CLAUDE.md` first: test commands, global constraints, kernel invariants, hidden-window rules. They bind every task.

How this plan is written: each task gives its files, the exact interfaces it consumes and produces, the tests to write (as code) and the code of whatever is an algorithm or a file format. Where a step wires an interface into existing UI or IPC code, it names the file, the function and the behaviour, and the existing neighbour to copy the shape of. Write each listed test first, watch it fail, then implement. Milestone 4 is merged to `main` (`a1bc7b5`): branch `m5-show` from it.

## Global Constraints

- Everything in `CLAUDE.md`. Copied here because every task leans on them:
  - Never write inside a user workspace except under `<object>/.torno/`. Never run `uv sync` there: always `uv run --no-sync`, and only when `<workspace>/.venv` exists.
  - The kernel supervisor only imports. It never loads a model, builds, tessellates or answers a query. Workers never fork.
  - Kernel stdout carries protocol frames only. Model output goes to a captured buffer.
  - Units are millimetres, Z up. Coordinates crossing a process boundary are in the object frame unless named `local`.
  - Renderer: `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`. No per-frame and no per-pointer-move state in React or Zustand.
  - HTTP server binds `127.0.0.1` only, on an OS-assigned port.
  - Images for the agent: long edge at most 2000 px, default 1280.
  - Do not copy nerv's look: no black/red/amber, no condensed uppercase labels, no corner-tick frames. Follow spec section 10 and the tokens in `app/src/renderer/styles/tokens.css`. UI text is sentence case. Every number and ref is set in the monospace face (class `num`, or `numbered()` of `ui/numbered.tsx`).
  - User marks are drawn in `--user-mark`, agent marks in `--agent-mark`, and nothing else in the UI uses those colours: not a view the agent proposed, not a card, not the agent picker.
  - Tests must not open a visible window: `show: false` when `TORNO_TEST=1`.
  - Commit after every task with a message describing the change, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The owner works on this desktop. Hidden window only.** Every Electron launch sets `TORNO_TEST=1`, also a second window a test opens (`new BrowserWindow({ show: false })` through `app.evaluate`). Never `--ozone-platform=headless`; never `page.screenshot()`; `webContents.capturePage()` at most once per launch; never the clipboard. Never click "Open folder", "Import scan" or "Export" unless main runs with `TORNO_TEST=1`: the dialogs are then replaced by `globalThis.__tornoMain.pickFolder`, `.pickFile` and `.pickSave`.
- **Never write in a user workspace except under `<object>/.torno/`, with one exception:** the export writes one file to the path the person chose in the save dialog, and nothing else outside `.torno/`: no temporary file beside it, no folder made for it. No task and no test writes under `/home/luisgonc` outside this repository: tests write to temporary folders they make and remove; `~/.local/share/applications/` is written only by `scripts/torno --install-desktop`, which the owner runs and no test does.
- **Never run a real agent CLI in a test or a check:** not `claude`, not `copilot`. `TORNO_AGENT_CMD` is `node app/test/fake-agent.mjs` and stands in for every adapter. `--help` and `--version` of an installed CLI may be read. What only a real CLI can show is listed for the owner (Task 9, "Not yet verified on a visible screen").
- `TORNO_KEEP_BUILDS=1` in every test harness: `app/vitest.config.ts` and `app/playwright.config.ts` set it already; a script of a task that launches the app or the kernel itself sets it too. Nothing else sets it.
- Every argument of an MCP tool is a key of `TOOLS[name].inputSchema` (`app/src/main/mcp/schemas.ts` after Task 1): the wrapper in `registerTools` refuses any other key by name. A new tool is added to `TOOLS` with its schema and registered through `tool(...)`, never through `server.registerTool` directly.
- **Nothing is told to the agent that it cannot rely on.** An exploded position is never told as a position: every coordinate, box, ref, value and reading in a tool reply, in the prompt's context, in `state.md` and in a mark is of the parts as the build placed them. A picture drawn exploded says so in its caption, with the sentence `EXPLODED_NOTE`.
- Nothing from a scan is ever said to be exact (Milestone 4), and a scan may show the real world: none is in an exported file or a thumbnail unless the person ticked it for that export, and then reduced.
- Tests work on a temporary copy of `kernel/tests/fixtures/ws`, never on the fixtures themselves, never on a real workspace. Nothing under `/home/luisgonc/objects` or `/home/luisgonc/Downloads` is ever written, and no git is run there. `micra-intake` is never built by a task (its worker holds about 11 GB).
- No build is ever started for the sake of a picture, a card or an export: they are made from the last good build of this run, or not made, and say which.

## Review Focus

The five ways this milestone is most likely to bite the owner, most likely first. Each has its test in the task that owns the code.

1. **A number or a mark taken from an exploded view.** The parts are drawn apart, the person clicks a face to pin it or measures a gap, and the point kept is where the part was drawn, not where it is; or the agent reads a caption and takes the gap in the picture for a clearance. Expected: no mark is placed and nothing is measured from the window while exploded (the pointer says why and how to put the parts together); what is selected names the true face at its true point; every reply is as before; the caption of an exploded picture says positions are as assembled. Tests in Task 2 (`explode.test.ts`: `pick` answers the true point; `Tool.test.ts`: `EXPLODED_TOOLS`; `viewTools.test.ts`: the caption and `measure` unchanged; `e2e/explode.spec.ts`: a pin attempt keeps nothing).
2. **An exported file that shows more than was meant, or needs the network.** The file is sent to someone: it must hold no scan the person did not tick, no absolute path of this machine, no note of a mark unless marks were ticked, and must open from `file://` on a machine with no connection. Expected: the page's own policy forbids every fetch; `source.path`, the object's folder and the user's name are nowhere in the file; scans and marks are in it only when asked. Tests in Task 5 (`html.test.ts`: no `http`, no `/home/`, no scan and no note by default; `e2e/export.spec.ts`: zero requests other than the file itself).
3. **A saved view that no longer fits the model.** The model loses a part or a layout, a scan is removed, the file was edited by hand or by a merge. Expected: a view of a layout that is gone stays in the strip, cannot be applied and says why; parts and scans it names that are gone are passed over; a file with a broken view loses that view only; `look {view: "…"}` of an unknown name lists the names there are. Tests in Task 3 (`views.test.ts`, `scenefile.test.ts`, `viewTools.test.ts`).
4. **A card that lies about an object.** The thumbnail is of a build of last week, the model has changed since, or the object has never been built on this machine. Expected: the card says when its picture was made and that the model is newer; an object not built in this run shows no dimension verdicts (they are of no build of this run) and says so; nothing is built for a card. Tests in Task 4 (`cards.test.ts`: `behind`, `dimensions: null`; `e2e/show.spec.ts`: opening the page starts no build).
5. **Marks that never reach an agent without hooks, or are taken for sent.** With Copilot the prompt carries nothing: the person types, presses Enter, and the agent knows nothing of M4. Expected: the session header says in words that this agent is told by "Send marks"; the drafts stay drafts until the line torno pasted has been sent with Enter; a session ended before that leaves them drafts; choosing another agent never resumes the other one's conversation. Tests in Task 6 (`sendMarks.test.ts`, `manager.itest.ts` with the stand-in started with Copilot's arguments).

## Decisions

The controller's rulings, as followed:

- **R1.** Task 1 is the carried debt, behaviour unchanged unless listed there: the four splits and the small deferred fixes. What is in and what is left out is listed under "Deferred items" below, a reason each.
- **R2.** Explode is view state per layout (`amount` 0 to 1, a distance `scale`, an `axis`: from the centre, or along x, y or z), kept in `scene.json`, never geometry, never in a mark or a measurement. The viewport moves each part's group for display. The rule, which Task 2 writes into `CLAUDE.md` under "One geometry":
  - *Exploded is display only.* `Part.loc`, `Part.bbox`, every anchor, every `points` of a dimension and everything the kernel is asked are of the parts as built.
  - `Viewport.pick` answers the point on the part as built (the display offset of the part hit is taken away). Selecting, hovering, "Insert ref" and the readout at the pointer work exploded.
  - No mark is placed, moved or measured from the window while the layout shown is exploded: Pin, Arrow, Draw, Shape, Measure, Section, Align and Region hand on no event, and the pointer says `EXPLODED_TOOLS`; "Add a note" on the selection is disabled with the same words.
  - Marks are drawn moved with their part. A dimension whose two ends are on parts that moved differently is not drawn while exploded, and its row says so; its value in the row is the kernel's, of the parts as built.
  - A section is never drawn exploded (D2). Scans are not moved; a caption that draws both says so.
  - The agent's `look` takes `explode`; `show` sets it for now. `scene` reports it. Every other tool answers of the parts as built and says nothing of explode.
- **R3.** Named views: the person saves the view on screen (camera, layout, hidden parts, section, explode, how the scans are shown) under a name, per object, in `scene.json`; a strip of them over the viewport; the agent lists them in `scene`, asks `look {view: "name"}` and `show {view: "name"}`, and proposes one with `save_view`, which is the agent's and marked "proposed" until the person keeps it.
- **R4.** A page of cards for the objects of the workspace: thumbnail, build status, open marks, failing dimensions, session. A click opens the object. The spec is silent on a side-by-side comparison, so there is none (D6).
- **R5.** Export: one HTML file per object or for a selection, nothing fetched, torno's look, parts, layouts, explode, section, saved views, marks as an option, scans only when ticked and then reduced; the person chooses the path in a save dialog whose default is `<object>/.torno/exports/`; a stated budget (D7).
- **R6.** `AgentAdapter` says whether its CLI posts hooks. A second adapter, Copilot CLI, the only other agent on PATH (E1); the fallback for an agent without hooks is `.torno/state.md`, `.torno/prompt.md`, the MCP tools and "Send marks". The agent is chosen per object in the session header and kept in `<object>/.torno/agent.json`.
- **R7.** Polish as the last tasks: first run and "Open folder" (Task 7), the key sheet from one table (Task 7), light and dark (Task 8), the launcher and the desktop entry (Task 8), the README (Task 9), the sweep by hand on `helmet-stand` and `guitar-wall-stand` (Task 10).
- **R8.** The README gets the section "Not yet verified on a visible screen" (Task 9); Tasks 6, 8 and 10 add their lines to it.

Where this plan departs from a ruling or adds to one, because an experiment or the code says so:

- **D1. Ruling proposed: the explode direction "from the centre" is from the centre of the box round the layout's parts to the centre of each part's box, and each part moves by `(R + d) × amount × scale` along it, `R` half the diagonal of the layout's box and `d` the part's distance from the centre; along an axis the parts are ranked by their centre on that axis and set `2R × amount × scale` apart.** Why: a part's centroid is not in the scene and its box is; a move in proportion to `d` alone leaves a lid on its tub (their centres are 6 mm apart in the fixture: 9 mm of gap at 100 %); ranking separates parts whose centres coincide. Cost if wrong: a layout whose parts nest around one centre explodes weakly "from the centre", and the person chooses an axis.
- **D2. Ruling proposed: a section and an explode are never on at once. The slider is disabled while there is a section and the Section tool hands on nothing while exploded; `look` and `show` refuse the two together; a saved view holds one or the other.** Why: `SectionCut` clips every part by one plane of the object frame and hangs each cut face under its part's group (`section.ts:299`, `:501-530`): a part moved for display would be cut where it is drawn, which is not where the plane cuts it, and R2 forbids exactly that. Cost if wrong: an exploded section view needs a plane per part (the plane moved by the part's offset), about a day in `section.ts` and its tests.
- **D3. Ruling proposed: `scene.json` stays the window's to write. `save_view` is carried to the window as `show` is (`view:saveView`), and main keeps the last scene file it read or was given per folder (`sceneFileNow`) to answer `scene`, `look {view}` and `show {view}` from.** Why: the window writes the whole file 500 ms after an edit (`App.tsx` `useMain`); a second writer in main would lose one side's change. Cost if wrong: `save_view` is refused for an object that is not the one open in the window, as `look` and `show` are.
- **D4. Ruling proposed: a saved view keeps the names of the parts switched off (`hidden`), not of those switched on.** Why: a part the model gains later is then in the view, as it is on screen. Cost if wrong: a view meant to show one part shows a new part too until it is saved again.
- **D5. Ruling proposed: no build is ever started for a thumbnail. A thumbnail is made when a build of an object opened in this run lands, drawn by the window in a scene of its own without that object being shown (E4), and kept as `<object>/.torno/thumb.png`. An object not opened in this run shows the picture on file, with its date and whether the model is newer, or none.** Why: stronger than the ruling and simpler: whether a worker fits in memory is not known before it is forked (the M4 policy judges by the last worker's RSS). Cost if wrong: a new workspace has no pictures until each object has been opened once.
- **D6. As ruled: cards and opening only, no comparison grid.** The spec's section 9 says a scene with layers and named views "already is the show" and names no grid. Cost if wrong: comparing two objects means two exports side by side.
- **D7. Ruling proposed: the budget is 12 MB for a file. Over it, scans are cut first (each from 60,000 to 30,000 to 15,000 triangles, then left out, the largest first); part meshes are never reduced; if the parts alone are over, the sheet says the size and the person exports fewer objects or goes ahead; above 64 MB nothing is written.** Why: E2: the viewer and the fonts are 0.65 MB, a part about 13 bytes a triangle (the owner's largest object about 0.8 MB, eleven large parts about 4 MB), so only scans and many objects can reach it; a B-rep mesh cannot be thinned without losing its faces' borders. Cost if wrong: a selection of every object of a large workspace is refused at 64 MB and must be split.
- **D8. Ruling proposed: one second adapter, Copilot CLI, without hooks; none for Codex, Gemini CLI, opencode or aider.** Why: E1: those four are not installed, so no flag of theirs could be read, and the ruling allows only `--help`. Copilot's help offers a per-session MCP configuration, a session id for new and resumed sessions, an allow rule for a server's tools and a variable for a folder of instructions, and nothing for context with a prompt or for status. Cost if wrong: a third adapter is one file of about 40 lines against the same interface; Copilot's three unverified points (the keys of its MCP JSON, whether `AGENTS.md` in the named folder is read, the tool names it shows the model) are in the by-hand list.
- **D9. Ruling proposed: "Send marks" pastes one line and does not send it; the marks it tells of turn `sent` when the person next presses Enter in that terminal, and stay drafts if the session ends first.** Why: torno never submits for the person (`Sessions.insert`), and a mark is `sent` only once its telling has left (`CLAUDE.md`, Status). Cost if wrong: a person who clears the pasted line and sends something else has marks marked sent that the agent was told of only by the file; `marks` still returns them, and they can be made drafts again from their rows.
- **D10. Ruling proposed: the exported page cuts by clipping only (parts are drawn open, with their insides in a darker tone of their colour), has no cut faces, and its marks are numbers, lines and notes, not the app's full drawing.** Why: stencil caps and the mark layer are 1,600 lines that depend on the app's viewport; the spec asks for "the same viewer reduced". Cost if wrong: a cut in the page reads less well than in torno; the person exports a picture from `look` beside it.
- **D11. Ruling proposed: `scripts/torno` passes `--ozone-platform` only when `TORNO_OZONE` is `wayland` or `x11`, refuses `headless`, and otherwise leaves the choice to Electron.** Why: which platform Electron 44 picks on Hyprland with NVIDIA has never been seen on a visible screen here, and a wrong forced value is a window that does not open. Cost if wrong: the owner sets one variable; it is the first line of "Not yet verified on a visible screen".

- **D12. Ruling proposed: the system prompt may be 6,800 characters (it was held to 6,250).** Why: explode, saved views and `save_view` need three sentences, about 430 characters, and the prompt stands at 6,218. Cost if wrong: 150 tokens more with every session; the sentences can be cut back to the tools' descriptions.

### Deferred items: in, and left out

In Task 1 (from `final-review.md` "Code health", `final-fix-review.md` and ledger line 98):

| Item | What is done |
|---|---|
| Split `main/scans/store.ts` (899 lines) | `scans/masks.ts`, `scans/alignments.ts`; the store keeps import, convert, reimport, rename, remove, list |
| Split `mcp/tools.ts` (887) | `mcp/schemas.ts` (every schema and description, `TOOLS`), `mcp/viewTools.ts` (`scene`, `look`, `show`) |
| Split `ui/AlignBar.tsx` (519) | `ui/Field.tsx`, `ui/align/{FloorBody,PairsBody,NudgeBody}.tsx` |
| Split `tools/regionTool.ts` (599) | `tools/regionPainting.ts` (the registry and what the bar calls) |
| R1, the brush against a part in front | every triangle a stamp would take is tested against the parts, not only the brush's centre |
| A scan clipped by `SCAN_REACH` | said on its row and in `scansNote` |
| M5 | the words after a failed restore name Rebuild, and a check asked by the person then says the model does not build |
| M6 | `checkingAlignments` is looked up at each run |
| M7 | the fit's own figures are told to 0.1 mm |
| M9 | a linked `.torno/scans` is refused for deletes as for writes |
| M12 | a mask that failed to read is remembered per mask name until the scans change |
| R3, S5, S6, T3, T6 | a few lines each, in Task 1 |
| e2e: Tab in Pairs, "Use this alignment", Frame, the let-go status line | `e2e/align.spec.ts`, `e2e/scan.spec.ts`, `e2e/loop.spec.ts` |

Left out, each for a reason:

| Item | Why it is left |
|---|---|
| M8 (`section` with a scan over budget cuts the scan twice) | a cost on large scans only, in the kernel; nothing wrong is told |
| M10 (the 4 GiB floor lets every other worker go) | by ruling in M4; needs a day of the owner's use before it is judged |
| T9 (the system prompt does not name `measure`'s scan end, `section`'s `scan`, `scanColour`) | the prompt is at 6,218 characters and Tasks 2 and 3 need room in it; the tools' descriptions name all three |
| Nudge by axes typed for a scan | a feature, not a debt; nobody has asked for it since |
| K6, K9 (wording and comments in `scanclash.py`), `RLIMIT_AS` for the import | kernel work with no report of harm; this milestone does not touch the kernel |
| Split of `scanclash.py` (1,223 lines), long-triangle loops, coloured imports unwelded | the same: no kernel change in Milestone 5, so no risk is added to it |
| Meshes over an app scheme instead of IPC | 140 MB held by the window on a 1.6 M scan; works, and a transport change deserves its own review |
| I1's wiring in `ipc.ts` under e2e | covered by `vprobe/loop.probe.test.ts` of the re-review as a unit; an e2e of a lost worker needs a kernel that loses one |
| From M3: a kernel kind `busy`; one `measure` query per dimension; the lamina of a touching part under a section; `SPREAD_LINE` for a bare point | kernel or section work, none reported as harm |
| From M3: the blur of the window during a drag, by hand | needs a visible window: it is in the README's list for the owner |

Not in this milestone at all: a comparison grid (D6); adapters for agents that are not installed (D8); publishing or uploading an export (the spec: "torno does not publish anything itself"); thumbnails or exports of objects never built in this run; ICP; a chat-panel adapter.

## File structure

New files, each with one job:

```
app/src/shared/
  explode.ts          ExplodeState, explodeOf, explodeOffsets, explodeText. Pure.
  views.ts            SavedView, savedViewOf, viewNameRefusal, findView. Pure.
  show.ts             ObjectCard.
  exportdata.ts       ExportData and its parts; packMesh, unpackMesh. Pure, no node, no DOM.
  palette.ts          moved from renderer/viewport/palette.ts (main needs the parts' colours for an export).
  keys.ts             the one table of tools and keys; cheatSheet().
  contrast.ts         the contrast ratio of two colours, for the test that holds the tokens to theirs.
app/src/main/
  mcp/schemas.ts      every tool's input schema, description and argument type; TOOLS; refusedKeys.
  mcp/viewTools.ts    scene, look, show, save_view; the camera and the named view of a request.
  scans/masks.ts      a region's mask on the disk.
  scans/alignments.ts what changes a scan's alignments.
  show/cards.ts       the cards of a workspace; the thumbnail files.
  export/build.ts     ExportData from the last builds.
  export/decimate.ts  a scan reduced by vertex clustering.
  export/html.ts      the page: policy, style, fonts, data, viewer.
  export/save.ts      the save dialog, the default folder, the write.
  sessions/copilot.ts the Copilot CLI adapter.
  sessions/choice.ts  <object>/.torno/agent.json.
  sessions/sendMarks.ts  .torno/prompt.md and the line that is pasted.
app/src/export/
  page.css            the page's own style, with the tokens it uses.
  viewer/main.ts      entry of the page's script (bundled to out/viewer/viewer.js).
  viewer/model.ts     three.js objects from ExportData; layouts, parts, explode, section, scans.
  viewer/overlay.ts   marks and their notes, as DOM over the canvas.
  viewer/panel.ts     the page's controls.
app/scripts/
  build-viewer.mjs    bundles src/export/viewer with vite into one classic script.
app/src/renderer/
  viewport/thumbnail.ts   ThumbnailMaker: a small scene of any object, drawn off screen.
  state/thumbs.ts         makes a thumbnail when a build lands, and hands it to main.
  tools/regionPainting.ts the registry of paintings and what the region bar calls.
  tools/stamp.ts          which triangles one stamp of the brush takes.
  ui/Field.tsx  ui/align/FloorBody.tsx  ui/align/PairsBody.tsx  ui/align/NudgeBody.tsx
  ui/ExplodeControl.tsx   the slider, the scale and the axis.
  ui/ViewsStrip.tsx       the saved views.
  ui/ShowPage.tsx         the cards.
  ui/ExportSheet.tsx      what goes into an export.
  ui/AgentPicker.tsx      which agent an object's session runs.
  ui/KeySheet.tsx         the overlay of keys.
  ui/Welcome.tsx          the first run.
app/e2e/
  explode.spec.ts  views.spec.ts  show.spec.ts  export.spec.ts  agents.spec.ts  welcome.spec.ts
app/src/
  launcher.test.ts        scripts/torno, asked what it would do.
  readme.test.ts          the README's layout and what it must name.
scripts/
  torno.desktop.in        the desktop entry, with @EXEC@ and @ICON@ to fill.
  torno.svg               the icon.
```

Modified: `app/package.json` (build scripts only), `app/src/shared/{bridge,view,scenefile}.ts`, `app/src/preload/index.ts`, `app/src/main/{ipc,index,scenefile,context,statefile,prompt,look}.ts`, `main/mcp/{tools,markTools,readTools,scanTools,server}.ts`, `main/scans/store.ts`, `main/sessions/{adapter,claude,manager,status}.ts`, `app/test/fake-agent.mjs`, `app/src/renderer/{App.tsx,env.d.ts}`, `renderer/state/{store,tools,agent}.ts`, `renderer/tools/{Tool,regionTool}.ts`, `renderer/viewport/{Viewport,picture,scans,partMesh}.ts`, `viewport/marks/MarkLayer.ts`, `renderer/ui/{ViewBar,ViewportPane,ToolPalette,AlignBar,RegionBar,ScansPanel,MarkRow,Selection,ObjectList,SessionPane,BuildStatus}.tsx`, `styles/{tokens,app}.css`, `scripts/torno`, `README.md`, `CLAUDE.md`, the spec.

`Viewport.ts` is 1,120 lines. Explode and thumbnails add to it only what joins `explodeOffsets` and `ThumbnailMaker` to the entries, the pick and the renderer: at most 90 lines over the milestone. `app.css` is 2,843 lines: new rules go in at the end, under one comment per component.

## Shared contracts

### Explode (`app/src/shared/explode.ts`, Task 2)

```ts
import type { Vec3 } from './marks'

/** How the parts of one layout are drawn apart. View state: never geometry. */
export interface ExplodeState {
  /** 0 (as assembled) to 1. */
  amount: number
  /** Times the layout's own reach, 0.25 to 4. 1 when left out of a file. */
  scale: number
  /** Away from the centre of the layout's box, or apart along an axis of the object frame. */
  axis: 'centre' | 'x' | 'y' | 'z'
}
export const NO_EXPLODE: ExplodeState = { amount: 0, scale: 1, axis: 'centre' }
export const MIN_EXPLODE_SCALE = 0.25
export const MAX_EXPLODE_SCALE = 4
/** Whether anything is drawn apart. */
export function isExploded(explode: ExplodeState | null | undefined): explode is ExplodeState
/** An explode out of whatever was given (a file, a request): `amount` clamped to 0..1, `scale` to its range (1 for none), `axis` one of the four (`centre` for none). Null for what is no object or has no finite amount. */
export function explodeOf(value: unknown): ExplodeState | null
/** What the agent may give: a number is the amount. */
export function explodeArg(value: unknown): ExplodeState | null
export interface ExplodePart { name: string; bbox: { min: Vec3; max: Vec3 } }
/** By part name, how far each part of a layout is drawn from where it is. Empty when nothing is exploded or the layout has fewer than two parts. Never a part of another layout: give it the parts of one. */
export function explodeOffsets(parts: readonly ExplodePart[], explode: ExplodeState | null | undefined): Record<string, Vec3>
/** `exploded 40 % from the centre`, `exploded 100 % along z, ×2`. */
export function explodeText(explode: ExplodeState): string
/** Said with every picture and caption that draws parts apart. */
export const EXPLODED_NOTE = 'the parts are drawn apart for display: every position, ref and number told is of the parts as assembled'
/** Said at the pointer by every tool but Select while the layout shown is exploded. */
export const EXPLODED_TOOLS = 'The parts are drawn apart: put them together (E, or the slider at 0) to mark, measure or cut'
```

`scene.json` gains `"explode": { "assembly": { "amount": 0.4, "scale": 1, "axis": "centre" } }`: by layout name; an entry equal to `NO_EXPLODE` is left out, and the key when none is left.

### Saved views (`app/src/shared/views.ts`, Task 3)

```ts
import type { ExplodeState } from './explode'
import type { Camera, SectionPlane } from './view'

export interface SavedView {
  /** 1 to 40 characters, one line, unique in the object whatever the case; never `current` or the name of a standard view. */
  name: string
  author: 'user' | 'agent'
  /** The agent's, and the person has not kept it yet. Only ever true, only on an agent's. */
  proposed?: true
  /** Why the agent proposes it, one line, at most 200 characters. */
  note?: string
  layout: string
  camera: Camera
  /** Names of the parts switched off (D4). */
  hidden: string[]
  /** One or the other, never both (D2). */
  section?: SectionPlane
  explode?: ExplodeState
  /** By scan id, how each scan is shown: only `visible` and `opacity`. */
  scans?: Record<string, { visible?: boolean; opacity?: number }>
  /** ISO time it was saved. */
  at: string
}
export const MAX_VIEWS = 24
export const MAX_VIEW_NAME = 40
export const MAX_VIEW_NOTE = 200
export const RESERVED_VIEW_NAMES = ['current', 'iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const
/** A view out of whatever a file holds, or null: a name that is one, an author, a layout, a camera whose position is not its target. With both a section and an explode the section is kept. */
export function savedViewOf(value: unknown): SavedView | null
/** The views of a file: each that is one, the first of each name, `MAX_VIEWS` at most. */
export function savedViewsOf(value: unknown): SavedView[]
export function findView(views: readonly SavedView[], name: string): SavedView | undefined
/** Why a view cannot be saved under a name by `author`, as a sentence, or null. The person may save over any view; the agent only over its own that is still proposed. */
export function viewNameRefusal(name: string, views: readonly SavedView[], author: 'user' | 'agent'): string | null
/** A view as `scene` lists it. */
export function viewSummary(view: SavedView): { name: string; by: 'user' | 'agent'; proposed?: true; layout: string; exploded?: true; section?: true; note?: string }
```

`scene.json` gains `"views": [SavedView, …]`. `SceneFile` in `shared/scenefile.ts`:

```ts
export interface SceneFile { layout?: string; layers: Record<string, LayerSettings>; section?: SectionPlane | null; scans?: Record<string, ScanView>; explode?: Record<string, ExplodeState>; views?: SavedView[] }
```

An example file after Tasks 2 and 3:

```json
{
  "layout": "assembly",
  "layers": { "lid": { "opacity": 0.4 } },
  "explode": { "assembly": { "amount": 0.4, "scale": 1, "axis": "z" } },
  "views": [
    { "name": "Hinge side", "author": "user", "layout": "assembly", "camera": { "position": [120, -90, 60], "target": [0, 0, 6], "up": [0, 0, 1], "ortho": false, "fov": 35, "zoom": 1 }, "hidden": [], "explode": { "amount": 0.4, "scale": 1, "axis": "z" }, "at": "2026-10-09T21:14:03.000Z" },
    { "name": "Wall at the latch", "author": "agent", "proposed": true, "note": "the 1.2 mm wall M7 is about", "layout": "assembly", "camera": { "position": [0, -80, 6], "target": [0, 0, 6], "up": [0, 0, 1], "ortho": true, "fov": 35, "zoom": 2.1 }, "hidden": ["lid"], "section": { "origin": [0, 3, 0], "normal": [0, -1, 0] }, "at": "2026-10-09T21:20:44.000Z" }
  ]
}
```

### View state and requests (`app/src/shared/view.ts`, Tasks 2 and 3)

```ts
export interface ViewState { /* as now */; explode?: ExplodeState }        // of the layout shown; absent for none
export interface LookRequest { /* as now */; explode?: ExplodeState | 'current' | null }   // 'current', and when absent: as on screen
export interface ShowRequest { /* as now */; explode?: ExplodeState | null }               // null puts the parts together; absent leaves it
export interface LookResult { /* as now */; exploded?: boolean }
export interface ShowResult { /* as now */; exploded?: boolean }
/** What the agent asks the window to keep as a view it proposes. Everything left out is as on screen. */
export interface SaveViewRequest { objectId: string; name: string; note?: string; view?: ViewName | Camera; layout?: string; parts?: string[]; section?: SectionPlane | null; explode?: ExplodeState | null }
export interface SaveViewResult { objectId: string; revision: number; view: SavedView; replaced: boolean }
```

### Tool schemas added or widened (`app/src/main/mcp/schemas.ts`)

```ts
const explodeInput = loose(z.union([z.number(), z.strictObject({ amount: z.number(), scale: z.number().optional(), axis: z.enum(['centre', 'x', 'y', 'z']).optional() })]))
const explodeHelp = 'a number from 0 to 1 (how far apart the parts are drawn, away from the centre of the layout), or {"amount": 0.5, "axis": "z", "scale": 2} to set them apart along x, y or z and further. For display only: positions, refs and measurements are always of the parts as assembled.'

// look
view: z.union([z.string(), cameraInput]).optional()      // a preset, 'current', the name of a saved view (as scene lists them), or a camera
explode: explodeInput.nullable().optional()               // 'current' is not taken here: absent is as on screen, null or 0 draws them together
// show
view: z.union([z.string(), cameraInput]).optional()
explode: explodeInput.nullable().optional()

const saveViewInput = {
  name: z.string().describe('What the view is called, 1 to 40 characters, as the user will read it in their strip of views: "Wall at the latch". Not current, iso, front, back, left, right, top or bottom, and not the name of a view of the user\'s.'),
  note: z.string().optional().describe('Why you propose it, in a line.'),
  view: z.union([z.enum(VIEW_NAMES), cameraInput]).optional().describe('iso, front, back, left, right, top or bottom, fitted to the parts, or a camera as scene gives one. Default: the user\'s own camera.'),
  layout: z.string().optional().describe('The layout the view is of. Default: the one on screen.'),
  parts: z.array(z.string()).max(MAX_PARTS).optional().describe('Names of the parts the view shows; every other part of the layout is hidden in it. Default: those on screen.'),
  section: planeInput.nullable().optional().describe(`The cut the view has: ${planeHelp}; null for none. Default: the one on screen. Not with explode.`),
  explode: explodeInput.nullable().optional().describe(`How far apart the view draws the parts: ${explodeHelp} Default: as on screen. Not with a section.`)
}
```

`TOOLS.save_view`: `'Returns the view you proposed, as kept in the user\'s strip of saved views marked "proposed" until they keep or discard it, and the revision it was saved on. Use it to leave the user a way back to something you showed them: the view of a problem, of a fit, of a change. It changes nothing on their screen; to show it now, call show with its name.'`

Example replies (text content):

- `scene`, new keys beside the existing ones: `"explode": {"amount": 0.4, "scale": 1, "axis": "z"}` (null for none) and `"views": [{"name": "Hinge side", "by": "user", "layout": "assembly", "exploded": true}, {"name": "Wall at the latch", "by": "agent", "proposed": true, "layout": "assembly", "section": true, "note": "the 1.2 mm wall M7 is about"}]`; while exploded the `note` ends `The user's view is exploded 40 % along z: the parts are drawn apart for display: every position, ref and number told is of the parts as assembled.`
- `look {"explode": 0.5}`: caption `view current · layout assembly · parts tray, lid · exploded 50 % from the centre (the parts are drawn apart for display: every position, ref and number told is of the parts as assembled) · perspective`, then `revision r3` and `saved as …` as now.
- `look {"view": "Hinge side"}`: caption begins `view "Hinge side" · layout assembly · …`.
- `look {"view": "hinge"}` with no such view: error `no view "hinge": the saved views are "Hinge side", "Wall at the latch"; or current, iso, front, back, left, right, top, bottom, or a camera`.
- `look {"explode": 0.5, "section": {"axis": "z", "at": 3}}`: error `a section is not drawn exploded: give explode or section, not both (explode: null draws the parts together, section: null draws them whole)`.
- `save_view {"name": "Wall at the latch", "view": "front", "parts": ["tray"], "note": "the 1.2 mm wall M7 is about"}`: `saved "Wall at the latch" as a view you propose: layout assembly, parts tray, orthographic. The user sees it in their views, marked proposed, until they keep or discard it.\nrevision r3`
- `save_view {"name": "Hinge side"}` when the user has that view: error `the user has a view named "Hinge side": choose another name (their views: "Hinge side")`.

### Cards (`app/src/shared/show.ts`, Task 4)

```ts
import type { SessionStatus } from './bridge'
export interface ObjectCard {
  id: string
  name: string
  /** Why it cannot be built, as the object list says it. */
  problem?: string
  /** Opened in this run: it has a build state, and its marks are checked against it. */
  opened: boolean
  build?: { status: 'idle' | 'building' | 'ok' | 'failed'; revision: number; stale: boolean; letGo?: 'memory'; error?: string }
  /** The picture on file: when it was made, of which layout, and whether the model file is newer than it. Null for none. */
  thumb: { at: string; layout: string; behind: boolean } | null
  /** Null when the marks file could not be read. */
  marks: { open: number; drafts: number } | null
  /** Of the last build of this run; null for an object not built in it (a verdict of no build of this run is none). */
  dimensions: { failing: number; unmeasured: number; passing: number } | null
  session: SessionStatus | null
}
```

Files: `<object>/.torno/thumb.png` (480 × 360, transparent ground, parts only, no marks, no scans, no section, never exploded) and `<object>/.torno/thumb.json`:

```json
{ "at": "2026-10-09T21:14:03.000Z", "layout": "assembly", "parts": 2, "model": "hollow.py", "modelMtimeMs": 1791580443000 }
```

### The exported file (`app/src/shared/exportdata.ts`, `app/src/main/export/html.ts`, Task 5)

```ts
export const EXPORT_VERSION = 1
export interface PackedMesh {
  vertices: number
  triangles: number
  /** Edge segments (two points each). */
  segments: number
  /** Positions and edge points are u16 per coordinate: lo + q / 65535 × span, in the part's own frame. */
  lo: [number, number, number]
  span: [number, number, number]
  /** Triangle indices are u32 (true) or u16. */
  wide: boolean
  /** base64 of zlib-deflated bytes: positions (u16 × 3 × vertices), normals (i8 × 3 × vertices, a pad byte when odd), indices, edge points (u16 × 6 × segments). Little-endian. */
  data: string
}
export interface ExportPart { name: string; layout: string; loc: { t: Vec3; q: Quat }; bbox: { min: Vec3; max: Vec3 }; color: string; opacity: number; visible: boolean; faces: number; mesh: string /* key into meshes */ }
export interface ExportMark { id: string; kind: Mark['kind']; author: 'user' | 'agent'; layout: string; note: string; status: MarkStatus; part?: string; at: Vec3; line?: Vec3[]; text?: string /* a dimension's value as the row says it */ }
export interface ExportScan { id: string; name: string; triangles: number; reducedFrom: number; colours: boolean; lo: Vec3; span: Vec3; data: string; placed: Record<string, { t: Vec3; q: Quat; s: number }> }
export interface ExportObject {
  id: string
  name: string
  revision: number
  layouts: string[]
  layout: string
  parts: ExportPart[]
  /** By the part's content hash: the same shape in two layouts is in the file once. */
  meshes: Record<string, PackedMesh>
  explode: Record<string, ExplodeState>
  views: SavedView[]
  marks?: ExportMark[]
  scans?: ExportScan[]
}
export interface ExportData { format: 'torno-export'; version: 1; title: string; exportedAt: string; objects: ExportObject[] }
export interface MeshArrays { positions: Float32Array; normals: Float32Array; triangles: Uint32Array; edges: Float32Array }
/** The bytes that are deflated, and the header that reads them back. */
export function packMesh(mesh: MeshArrays): { header: Omit<PackedMesh, 'data'>; bytes: Uint8Array }
export function unpackMesh(header: Omit<PackedMesh, 'data'>, bytes: Uint8Array): MeshArrays
```

The file, in this order, and nothing else:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="torno">
<title>hollow · r3</title>
<style>/* @font-face × 3 with data: URLs, then app/src/export/page.css */</style>
</head>
<body>
<div id="torno"><canvas id="view"></canvas><div id="overlay"></div><aside id="panel"></aside><noscript>This page draws 3D parts with JavaScript.</noscript></div>
<script type="application/json" id="torno-data">{"format":"torno-export","version":1,…}</script>
<script>/* out/viewer/viewer.js: one classic script, no import */</script>
</body>
</html>
```

Every `<` in the JSON is written `<`, and every `</script` in the viewer `<\/script` (E3).

### Agents (`app/src/main/sessions/adapter.ts`, `app/src/shared/bridge.ts`, Task 6)

```ts
export type AgentId = 'claude' | 'copilot'
export interface AgentLaunch { command: string; args: string[]; env: Record<string, string>; /** Written under `agentDir` before the start: file name → text. */ files?: Record<string, string> }
export interface LaunchContext {
  sessionId: string
  conversationId: string
  resume: boolean
  cwd: string
  mcpUrl: string
  hookUrl: (event: string) => string
  /** `<cwd>/.torno/agent`: a folder of torno's own that an adapter may point its agent at. */
  agentDir: string
}
export interface AgentAdapter {
  id: AgentId
  /** As the person reads it: "Claude Code", "Copilot CLI". */
  label: string
  /** The command looked for on PATH. */
  command: string
  /** It posts hooks: context goes with every prompt and the status follows its work. Without, it is told through `.torno/prompt.md` and "Send marks". */
  hooks: boolean
  /** How this agent's client names a tool of torno's to the model: `mcp__torno__scene`. */
  toolName(tool: string): string
  launch(ctx: LaunchContext): AgentLaunch
}
export function adapters(agentCmd?: string): Record<AgentId, AgentAdapter>

// shared/bridge.ts, session
agents(): Promise<Array<{ id: AgentId; label: string; installed: boolean; hooks: boolean }>>
/** The agent an object's sessions run, and whether one of that agent's conversations can be resumed. */
current(objectId: string): Promise<{ running: { sessionId: string; status: SessionStatus } | null; resumable: boolean; agent: AgentId; hooks: boolean }>
/** Rejects while a session runs in that object. */
chooseAgent(objectId: string, agent: AgentId): Promise<void>
/** For an agent without hooks: writes `.torno/prompt.md` and pastes one line at its cursor, not sent. Answers with the marks the file tells of for the first time. */
sendMarks(sessionId: string): Promise<{ marks: string[]; line: string }>
```

`<object>/.torno/agent.json`: `{ "agent": "copilot" }`. `<object>/.torno/session.json` gains `"agent"`: `{ "conversationId": "…", "agent": "copilot", "updatedAt": "…" }`; a file without it is Claude Code's.

---

### Task 1: The spec as ruled, and the carried debt

Behaviour is unchanged by this task except where a row of "Deferred items: in" says otherwise. It lands before anything is added to the four files.

**Files:**
- Create: `app/src/main/mcp/schemas.ts`, `app/src/main/mcp/viewTools.ts`, `app/src/main/scans/masks.ts`, `app/src/main/scans/alignments.ts`, `app/src/renderer/ui/Field.tsx`, `app/src/renderer/ui/align/FloorBody.tsx`, `app/src/renderer/ui/align/PairsBody.tsx`, `app/src/renderer/ui/align/NudgeBody.tsx`, `app/src/renderer/tools/regionPainting.ts`, `app/src/renderer/tools/stamp.ts`, `app/src/renderer/tools/stamp.test.ts`
- Modify: `docs/superpowers/specs/2026-10-08-torno-design.md`, `app/src/main/mcp/{tools,markTools,readTools,scanTools,server}.ts` and the tests that import from `./tools`, `app/src/main/scans/store.ts`, `app/src/main/index.ts`, `app/src/main/ipc.ts`, `app/src/main/builds.ts`, `app/src/main/scans/{alignCheck,said}.ts`, `app/src/main/marks/{store,describe}.ts`, `app/src/main/context.ts`, `app/src/shared/scans.ts`, `app/src/renderer/ui/{AlignBar,RegionBar,ScansPanel,MarkRow,ViewportPane}.tsx`, `app/src/renderer/tools/{regionTool,regionTints}.ts`, `app/src/renderer/viewport/{scans,picture}.ts`, `app/e2e/{align,scan,loop}.spec.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing of this plan.
- Produces (names the later tasks import):

```ts
// main/mcp/schemas.ts — everything of today's tools.ts from `MIN_SIZE` to `KEYS` and `refusedKeys`:
export { MIN_SIZE, MAX_SIZE, DEFAULT_SIZE, FOV, MAX_PARTS, VIEW_NAMES, SHAPES, INTENTS, MEASURES, NO_PLANE, TOOLS, refusedKeys, planeInput, planeHelp, cameraInput, CAMERA_KEYS, loose, vec3 }
export type { LookArgs, ShowArgs, MarksArgs, DescribeArgs, HighlightArgs, AddMarkArgs, ResolveMarkArgs, PlaneArg }
// main/mcp/viewTools.ts
export function sceneTool(deps: ToolDeps, objectId: string, marks?: readonly Mark[], scans?: readonly ScanInfo[]): ToolResult
export function lookTool(deps: ToolDeps, objectId: string, args: LookArgs): Promise<ToolResult>
export function showTool(deps: ToolDeps, objectId: string, args: ShowArgs): Promise<ToolResult>
export function cameraOf(view: LookArgs['view']): NonNullable<LookRequest['view']> | null     // today's private `camera`
export function cameraKeys(view: unknown): string | null
export function spreadBesideScans(scene: Scene, shown: { layout?: string; scans?: string[] }): string
// main/mcp/tools.ts keeps: ToolDeps, ToolResult, registerTools, failure, notOpen, built, onScreen, planeArg, layoutFor, marksOf, noMark, marksTool, describeTool, ofBuild, behind, scansFor, tidy, messageOf, MARK_ID, clampSize, SPREAD_NOTE

// main/scans/masks.ts — what store.ts has at `writeMask`, `mask`, `removeMask`, `masks`, `MaskGone`, `maskPath`
export class MaskGone extends Error {}
export function maskPath(dir: string, scan: string, stem: string): string
export async function writeMaskFile(dir: string, scan: string, stem: string, bits: Uint8Array, triangles: number): Promise<void>
export async function readMaskFile(dir: string, scan: string, stem: string): Promise<Buffer>
export async function removeMaskFile(dir: string, scan: string, stem: string): Promise<void>
export async function maskStems(dir: string, scan: string): Promise<string[]>
/** Why nothing is written or deleted under a scans folder: it, or `.torno/scans`, is a link (S3, M9). Null when neither is. */
export async function linkRefusal(dir: string, scan?: string): Promise<string | null>
// main/scans/alignments.ts — the pure halves of `aligning`, `undoAlign`, `alignmentHolds`, `checking`, with `samePairs`, `withoutBefore`, `frameOf`
export function aligned(scan: Scan, layout: string, alignment: ScanAlignment | null, accepted: { rough?: boolean; scaled?: boolean }, now: Date): Scan
export function undone(scan: Scan, layout: string): Scan
export function held(scan: Scan, layout: string, holds: { revision: number; frame: Record<string, Vec3>; held: Array<Vec3 | null> }, now: Date): Scan
export function checked(scan: Scan, layout: string, check: AlignmentCheck | null, judged?: Pick<ScanAlignment, 'at' | 'confirmed'>): Scan
export function frameOf(scene: Scene | undefined, layout: string): Record<string, Vec3> | null
// ScanStore's public methods keep their names and signatures: each now calls one of these inside `change`.

// renderer/ui/Field.tsx
export function Field(props: { label: string; sign?: string; axis?: 'x' | 'y' | 'z'; value: string; unit?: string; disabled?: boolean; commit: (text: string) => void }): JSX.Element
// renderer/tools/regionPainting.ts — the registry of paintings and what the bar calls
export { NO_SCAN, NOT_INDEXED, NOTHING_PAINTED, CHOOSE_SCAN, KEEPING, IN_HAND, CLEARED, GROWING, paintingOn, waiting, current, show, publish, clearRegion, undoStroke, growRegion, keepRegion, editRegion, forgetPaintings, brushRadius }
// renderer/tools/regionTool.ts keeps: regionTool(), connectRegion(), boxPlanes

// renderer/tools/stamp.ts
/** How many triangles of one stamp are asked about, one pick each, when a part is in front of some of the brush. */
export const STAMP_TESTS = 400
/**
 * The triangles a stamp takes of those under the brush. With no part in front of the brush's centre or of any of
 * the eight points of its rim (`rimBlocked` all false), all of them. Otherwise each is asked about (`hidden`), up
 * to `cap`; those not asked about are left: what is not seen to be in sight is not painted.
 */
export function stampTriangles(gathered: readonly number[], rimBlocked: readonly boolean[], hidden: (triangle: number) => boolean, cap = STAMP_TESTS): number[]
// viewport/scans.ts
export interface ScanLayerState { /* as now */; clipped: boolean }   // it reaches beyond SCAN_REACH times the parts' sphere: the far plane cuts it
```

- [ ] **Step 1: Amend the spec.** In `docs/superpowers/specs/2026-10-08-torno-design.md`:
  - Section 3, "Files torno writes": the line of `scene.json` reads `scene.json          layer visibility, colours, the section, how far each layout is exploded, the saved views`; add under it `thumb.png, thumb.json  a picture of the last build, for the page of objects`, `agent.json          which agent this object's sessions run`, `prompt.md           what an agent without hooks is told when the person sends their marks`, `exports/            HTML files the person exported (ignored by git)`.
  - Section 6, "Sessions", the adapter paragraph: replace with `An **agent adapter** says how one CLI is started so that it knows torno (command, arguments, where the MCP server is, the system prompt) and whether it posts hooks. Claude Code does. Copilot CLI is the second adapter and does not: it reads its instructions from a folder torno names, is told of the build and the marks through .torno/prompt.md when the person presses "Send marks", and its status is only running or ended. The agent is chosen per object. Codex, Gemini CLI and opencode are not written: none was at hand to read the flags of.`
  - Section 6, the tools table: `look(view?, …, explode?)`, `show(view?, …, explode?)`, a row `save_view(name, …)` | `proposes a saved view to the user`; `scene()` returns also `the saved views and whether the view is exploded`.
  - Section 7, Layers: `Explode slider: per layout, for display only. Nothing is marked, measured or cut while the parts are drawn apart, and no position told to the agent is an exploded one. A section is never drawn exploded.`
  - Section 9: replace the paragraph with `The objects of a workspace are on one page of cards: a picture of the last build, its status, open marks and failing dimensions. **Export** writes one self-contained HTML file for one object or several: three.js and a small viewer inlined, meshes quantised and compressed, parts, layouts, explode, a clipping section, saved views, marks when asked, scans only when the person ticks them and then reduced to 60,000 triangles. It fetches nothing and opens from file://. Torno does not publish anything itself, and has no side-by-side comparison of objects.`
  - Section 10, Keyboard: add `E` explode and `?` for the sheet of keys; drop "a command palette, and `Tab` between viewport and session" (neither exists).
  - Section 13, item 5: `**Show.** Explode, named views, the page of objects, HTML export, a second agent adapter, polish.`

- [ ] **Step 2: Split `mcp/tools.ts`.** Move, do not rewrite: the schemas, descriptions, argument interfaces, `TOOLS`, `KEYS` and `refusedKeys` to `schemas.ts`; `sceneTool`, `scanStanding`, `sectionData`, `lookTool`, `showTool`, `spreadBesideScans`, `undrawnScans`, `staleNote`, `camera` (exported as `cameraOf`), `cameraKeys`, `round`, `lastLines` to `viewTools.ts`. `tools.ts` imports `sceneTool`, `lookTool`, `showTool` for `registerTools`. No re-export is left behind: `markTools.ts`, `readTools.ts`, `scanTools.ts`, `server.ts`, `index.ts` and the tests import each name from the file that now has it. `built`'s traceback uses `lastLines`: it moves with `built`'s needs into `tools.ts` and `viewTools.ts` imports it from there.

Run: `pnpm -C app typecheck && pnpm -C app exec vitest run src/main/mcp` Expected: PASS, the same count of tests as before the move (`git stash`-free check: `git diff --stat` shows the test files changed only in their import lines).
Then: `wc -l app/src/main/mcp/{tools,schemas,viewTools}.ts` Expected: each under 420.

```bash
git add app/src/main && git commit -m "The tools' schemas and the tools of the view have files of their own: mcp/schemas.ts, mcp/viewTools.ts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Split `scans/store.ts`.** The mask methods become thin calls of `masks.ts`; the bodies of `aligning`, `undoAlign`, `alignmentHolds` and `checking` that work on a `Scan` become the four pure functions of `alignments.ts`, called inside `this.change(place, (file) => …)` exactly where the code is now. `linkRefusal` is today's `lstat` guard of the writes (S3), now also asked by `removeMaskFile`, by `removing` before a scan's folder is deleted and by the sweep of `list` (M9): a refusal is thrown as an `Error` with its sentence, `"<path> is a link: torno deletes nothing through it"`.

Add to `app/src/main/scans/store.test.ts` (in its style, with its temp-folder helper `folder()` and store maker):

```ts
it('deletes nothing through a linked scans folder', async () => {
  const { dir, store, objectId } = await withScan()          // the file's own helper: an object folder with S1 imported
  const elsewhere = await mkdtemp(join(tmpdir(), 'torno-elsewhere-'))
  await writeFile(join(elsewhere, 'keep.mask'), 'x')
  await rm(join(dir, '.torno', 'scans', 'S1'), { recursive: true })
  await symlink(elsewhere, join(dir, '.torno', 'scans', 'S1'))
  await expect(store.removeMask(objectId, 'S1', 'keep')).rejects.toThrow('is a link: torno deletes nothing through it')
  await expect(store.remove(objectId, 'S1')).rejects.toThrow('is a link')
  expect(await readFile(join(elsewhere, 'keep.mask'), 'utf8')).toBe('x')
})
```

Run: `pnpm -C app exec vitest run src/main/scans` Expected: the new test FAILS before `linkRefusal` is asked by the deletes, then PASS; `wc -l app/src/main/scans/store.ts` under 680.

```bash
git add app/src/main/scans && git commit -m "A scan's masks and what changes its alignments have files of their own, and nothing is deleted through a linked scans folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Split `AlignBar.tsx` and `regionTool.ts`.** `Field` to `ui/Field.tsx` (`RegionBar.tsx` and the three bodies import it from there); `FloorBody`, `PairsBody` with `PairRow`, and `NudgeBody` to `ui/align/`, each with the helpers only it uses (`coords`, `typed`, `shown` go to `ui/align/format.ts` if two of them use one). `AlignBar.tsx` keeps `AlignBar`, `AskRough`, `numberedNames`. From `regionTool.ts`, lines 30 to 287 (the sentences, the registry `paintings`/`cleared`, `current`, `show`, `publish`, `clearRegion`, `undoStroke`, `brushRadius`, `growRegion`, `keepRegion`, `editRegion`) and `forgetPaintings` go to `regionPainting.ts`; `regionTool.ts` keeps the tool and `connectRegion`. `RegionBar.tsx`, `MarkRow.tsx`, `ViewportPane.tsx` and `region.test.ts` import from the file that has the name.

Run: `pnpm -C app typecheck && pnpm -C app exec vitest run src/renderer` Expected: PASS, same count. `wc -l` of `AlignBar.tsx` under 260, `regionTool.ts` under 360.

```bash
git add app/src/renderer && git commit -m "The align bar's bodies, its field and the registry of paintings have files of their own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: The brush against a part in front (R1). Write the failing test.** `app/src/renderer/tools/stamp.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { STAMP_TESTS, stampTriangles } from './stamp'

const NONE = [false, false, false, false, false, false, false, false]

describe('stampTriangles', () => {
  it('takes every triangle under the brush when no part is in front of its rim, and asks about none', () => {
    let asked = 0
    expect(stampTriangles([4, 5, 6], NONE, () => (asked++, true))).toEqual([4, 5, 6])
    expect(asked).toBe(0)
  })

  it('asks about each one when a part is in front of any of the rim, and leaves those hidden', () => {
    const rim = [false, false, true, false, false, false, false, false]
    expect(stampTriangles([4, 5, 6, 7], rim, (t) => t % 2 === 1)).toEqual([4, 6])
  })

  it('leaves what it did not ask about: what is not seen to be in sight is not painted', () => {
    const gathered = Array.from({ length: STAMP_TESTS + 50 }, (_, i) => i)
    const taken = stampTriangles(gathered, [true, ...NONE.slice(1)], () => false)
    expect(taken).toHaveLength(STAMP_TESTS)
    expect(taken.at(-1)).toBe(STAMP_TESTS - 1)
  })
})
```

Run: `pnpm -C app exec vitest run src/renderer/tools/stamp.test.ts` Expected: FAIL (module missing).

- [ ] **Step 6: Implement `stamp.ts` and use it in `regionTool.ts`.**

```ts
export const STAMP_TESTS = 400

export function stampTriangles(gathered: readonly number[], rimBlocked: readonly boolean[], hidden: (triangle: number) => boolean, cap = STAMP_TESTS): number[] {
  if (!rimBlocked.some(Boolean)) return [...gathered]
  const taken: number[] = []
  for (const triangle of gathered.slice(0, cap)) if (!hidden(triangle)) taken.push(triangle)
  return taken
}
```

In `regionTool.ts` `brush` (and the stamp of a press): after the sphere's triangles are gathered and before they are added to the stroke, work out `rimBlocked` for the eight points of the brush ring on screen (`e.client` plus the ring's radius in pixels at angles of 45°; the ring's pixel radius is what `showBrush` is given): a point is blocked when `ctx.viewport.pick(x, y, { partsOnly: true })` hits a part nearer the camera than the scan point under the pointer (`hit.distance` against the distance from `ctx.camera.position` to the scan hit). `hidden(triangle)` projects the triangle's centroid (scan frame → object frame by the scan's group matrix) with `ctx.viewport.project`, picks parts there, and says yes when a part is hit nearer than the centroid. `ToolViewport` gains `project` in its `Pick`. The tooltip of the brush in `RegionBar.tsx` loses the sentence that only its centre is tested; the bullet of `CLAUDE.md` "Scans" that says "at the pixel" now reads: `A stamp takes nothing a part hides: with a part in front of any of its rim each triangle is asked about, 400 a stamp at most, and the rest are left.`

Add to `app/e2e/region.spec.ts`, beside the test of the brush behind a part (it has the fixture of a scan sheet under the plate): paint with the brush's centre 3 px outside the plate's silhouette at a radius that reaches under it; `window.__tornoTest.regions()` then counts no triangle whose centroid projects (`__tornoTest.projectScan`) onto a pixel where `pickAt(fx, fy, { partsOnly: true })` is the plate.

Run: `pnpm -C app exec vitest run src/renderer/tools && pnpm build && pnpm -C app exec playwright test e2e/region.spec.ts` Expected: PASS.

- [ ] **Step 7: The small fixes, each with its test first.**

| Item | Change | Test |
|---|---|---|
| `SCAN_REACH` | `reaching` in `viewport/scans.ts` also says whether it cut the reach short; `ScanLayer.state()` gives `clipped` per scan; `ScansPanel` shows a quiet chip `not all in view` (`data-state="clipped"`, title `This scan reaches further than the view is drawn: Frame brings more of it in`); `scansNote` in `picture.ts` adds `, reaches beyond the view` for such a scan. | `scans.test.ts`: a scan box 500 times the parts' sphere is `clipped: true`, one twice it is not; `picture.test.ts`: `scansNote([{ id: 'S1', opacity: 1, aligned: true, stale: false, clipped: true }], 'print')` contains `S1, reaches beyond the view` |
| M5 | `builds.ts`: the sentence ends `It is built again when a source changes or Rebuild is pressed.`; `alignCheck.ts`: after a restore that failed the reason recorded is `the model does not build now: it is checked when it builds again` | change the two strings in `builds.test.ts` and `alignCheck.test.ts` first, see them fail |
| M6 | `ipc.ts`: `const check = (...a) => (scans ? checkingAlignments(...a) : noop(...a))`, looked up at each run | covered by the existing alignment itests; no new test |
| M7 | `scans/said.ts`: a fit's `rms` and `worst` go through `tenth()`: one decimal, `under 0.1 mm` below 0.05; README examples follow in Task 9 | `said.test.ts`: `rms: 0.003, worst: 0.005` reads `rms under 0.1 mm, worst under 0.1 mm`; `rms: 1.26` reads `rms 1.3 mm` |
| M12 | `marks/store.ts`: `maskReads` remembers a failure per `<dir>/<scan>/<stem>` until `ScanStore` says the scans changed | `regions.test.ts`: two `marks.list` after one failing mask read call the reader once |
| R3 | `regionTints.ts`: the set of failed masks is emptied when the store's `scans` change | `region.test.ts`: a mask that failed is asked for again after `actions.setScans` |
| S5 | the comment of `Reimported` in `shared/scans.ts` says what `store.ts` does; `written` in `marks/regions.ts` words a conversion as a conversion | none (comments and one string: update its assertion) |
| S6 | `ScanStore.removing`: after the folder is removed, a re-import that finishes for a scan that is gone removes the `S<n>/` it made | `store.test.ts`: remove during a re-import leaves no `S1` folder |
| T3 | `marks/describe.ts` `markData` of a region gains `alignment`: the word `alignmentSaid(...).state` | `describe.test.ts`: a region on a rough alignment has `alignment: 'rough'` |
| T6 | `context.ts`: a region draft of an object that is not open is told in the build's first layout, and its line says `[in layout <name>]` | `context.test.ts`: such a draft's line ends `[in layout print]` |

Run after each: its focused test, FAIL then PASS. Then `pnpm test && pnpm test:kernel`. Expected: PASS.

- [ ] **Step 8: The e2e gaps.** Add to `app/e2e/align.spec.ts`, after "three pairs and a fourth…" (it uses the file's own `open`, `row`, `bar`, `clickScan`, `clickModel`, `state`, `alignment`):

```ts
test('in Pairs, Tab changes which end is asked for first, and leaves a button its own Tab', async () => {
  await open('plain')
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Pairs' }).click()
  const first = await bar().locator('.alignbar-next').innerText()
  await page.locator('[data-region="viewport"] canvas').focus()
  await page.keyboard.press('Tab')
  await expect(bar().locator('.alignbar-next')).not.toHaveText(first)
  await page.keyboard.press('Tab')
  await expect(bar().locator('.alignbar-next')).toHaveText(first)
  // On a button of the bar, Tab moves the focus and asks for no other end.
  await bar().getByRole('button', { name: 'Pairs' }).focus()
  await page.keyboard.press('Tab')
  await expect(bar().locator('.alignbar-next')).toHaveText(first)
  expect(await page.evaluate(() => document.activeElement?.closest('.alignbar') !== null)).toBe(true)
})

test('"Use this alignment" in another layout keeps it there as placed by hand, with no fit said', async () => {
  await open('spread')                                   // layouts assembly and print; S1 aligned in print by the earlier test of this fixture
  await page.getByRole('button', { name: 'assembly', exact: true }).click()
  await row('S1').getByRole('button', { name: /Use this alignment in/ }).click()
  await expect.poll(async () => (await alignment('assembly'))?.steps).toEqual(['typed'])
  const kept = await alignment('assembly')
  expect(kept.pairs ?? []).toEqual([])
  expect(kept.fitRms).toBeUndefined()
  await expect(row('S1')).toContainText('by hand')
})
```

Add to `app/e2e/scan.spec.ts`: "Frame" on a scan's row brings it into view without turning the camera (`camera()` before and after: the direction `target − position`, normalised, is the same to 1e-6; `reachesBeyond` is no longer said: the row's chip `[data-state="clipped"]` has count 0). Add to `app/e2e/loop.spec.ts`: with `app.evaluate` setting the open object's build state through the test hook `__tornoMain.letGo(objectId)` (add it to `testHooks` in `index.ts`: it calls `builds.letGoForTest(objectId)`, which sets `letGo: 'memory'` and emits the state), `page.locator('.status-letgo[data-part="let-go"]')` has the text of `letGoText({ status: 'ok', letGo: 'memory' })`.

Run: `pnpm test:e2e` Expected: PASS (225 or more passed, 26 skipped).

- [ ] **Step 9: Update `CLAUDE.md`** (the MCP bullet names `mcp/schemas.ts` for every input schema and description and `mcp/viewTools.ts` for `scene`, `look`, `show`; the Scans section names `scans/masks.ts`, `scans/alignments.ts`, `tools/regionPainting.ts`, `tools/stamp.ts`), run all four suites and typecheck, commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && (cd kernel && uv run --no-sync pytest -q) && pnpm test:e2e
git add -A docs app CLAUDE.md && git commit -m "The spec says what Milestone 5 is; a stamp takes nothing a part hides, a scan cut by the view says so, and the smaller findings left from Milestone 4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Explode

**Files:**
- Create: `app/src/shared/explode.ts`, `app/src/shared/explode.test.ts`, `app/src/renderer/ui/ExplodeControl.tsx`, `app/e2e/explode.spec.ts`
- Modify: `app/src/shared/{view,scenefile}.ts`, `app/src/main/{scenefile,look,context,statefile,prompt}.ts` and their tests, `app/src/main/mcp/{schemas,viewTools}.ts`, `app/src/main/mcp/tools.test.ts`, `app/src/renderer/state/{store,agent}.ts`, `store.test.ts`, `app/src/renderer/viewport/{Viewport,picture}.ts`, `picture.test.ts`, `app/src/renderer/viewport/marks/MarkLayer.ts` and its test, `app/src/renderer/tools/Tool.ts`, `Tool.test.ts`, `app/src/renderer/ui/{ViewBar,ViewportPane,Selection,MarkRow,SectionBar}.tsx`, `app/src/renderer/env.d.ts`, `styles/app.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `VIEW_NAMES`, `loose`, `TOOLS` (`mcp/schemas.ts`), `lookTool`, `showTool`, `sceneTool` (`mcp/viewTools.ts`), Task 1.
- Produces: everything under "Explode" and "View state and requests" in Shared contracts, and:

```ts
// renderer/state/store.ts
explode: Record<string, ExplodeState>                 // by layout; what scene.json keeps
actions.setExplode(change: Partial<ExplodeState>): string | null    // of the layout shown, by hand: an edit. Returns why not (a section is on), or null
shownByAgent: { /* as now */; explode?: { theirs: ExplodeState | null } }
actions.showForAgent(layout, visible, section?, scans?, explode?: ExplodeState | null): void
export function explodeNow(s: TornoState, layout = s.layout): ExplodeState | null       // null when not exploded
// renderer/viewport/Viewport.ts
setExplode(explode: ExplodeState | null): void        // of the layout shown; called again by setLayout and setScene
exploded(): boolean
/** Where a point of the object frame is drawn, in client pixels; with `part`, where it is drawn as a point of that part (its display offset added). */
project(point: Vec3, part?: string): [number, number]
// renderer/viewport/marks/MarkLayer.ts
setOffsets(offsets: Readonly<Record<string, Vec3>>): void       // by part name, of the layout shown; {} for none
/** How a mark is drawn while parts are drawn apart: moved by this much, or not drawn (`'split'`: its ends are on parts that moved differently). */
export function markOffset(mark: Mark, offsets: Readonly<Record<string, Vec3>>): Vec3 | 'split'
// renderer/viewport/picture.ts
export interface ImageRequest { /* as now */; explode?: ExplodeState | 'current' | null }
export interface PictureHost { /* as now */; explode(): ExplodeState | null; explodeFor(explode: ExplodeState | null, layout: string): () => void /* draws that layout so; returns what puts the screen back */ }
// renderer/tools/Tool.ts
export interface ToolContext { /* as now */; exploded?: string | null }   // EXPLODED_TOOLS while the layout shown is exploded
```

Behaviour:
- **The maths** is `explodeOffsets` (D1), below, whole.
- **The viewport.** `setExplode` keeps the state, works out `explodeOffsets(partsOf(layout), explode)` and sets each entry's `group.position` to `part.loc.t` plus its offset (`setScene` does the same after it has placed the groups: the one place a group's position is set is a private `placePart(entry)`). It then calls `marks.setOffsets`, `this.extent = this.measured()`, `gizmo.place()`, `invalidate()`. `fit()`, the named views and `visibleBox()` frame the parts where they are drawn (each part's box moved by its offset). The grid stays under the parts as built.
- **Picking.** `pick` subtracts the offset of the part hit from `hit.point` before it returns (a `Hit` already names its part). Nothing else in `picking.ts` changes. Highlights hang under the part's group (`highlight.ts:190, 209`) and move with it.
- **Tools.** `routePointer` in `Tool.ts` hands an event to a tool other than `select` only when `ctx.exploded` is null; otherwise it says `ctx.exploded` at the pointer on a move over a part and on a press, exactly as it does for `ctx.stale`, and the tool's `cancel` is called once when the layout becomes exploded with something under way. `ViewportPane.connect` fills `exploded` from `explodeNow(store.getState()) ? EXPLODED_TOOLS : null`. `Selection.tsx`'s "Add a note" is `disabled` with `title={EXPLODED_TOOLS}` while exploded; `MarkRow`'s "Put somewhere else" too.
- **Marks.** `MarkLayer` adds `markOffset(mark, offsets)` to the position of a mark's object and of its label anchor; a `'split'` mark is hidden like one on a hidden part, and `MarkRow` shows under it `not drawn while the parts are apart` (class `row-note`). A mark on no part, and a region, do not move.
- **Section.** `actions.setExplode` returns `'Take the section away to draw the parts apart'` and changes nothing while `section !== null` and the change would make `amount > 0`; `actions.setSection(plane)` with a plane sets the layout's explode `amount` to 0 in the same `setState` (the person asked for a cut: the parts come together, and `ExplodeControl` shows 0). `SectionBar` needs no change.
- **The control** (`ExplodeControl`, in the `ViewBar` after "Fit", `role="group" aria-label="Explode"`): a range input (`aria-label="Explode"`, 0 to 100, step 1) with its value beside it in `num` (`40 %`), and a disclosure "More" with the axis (`From centre`, `X`, `Y`, `Z`, as `bar-button`s with `aria-pressed`) and the scale (`×0.5`, `×1`, `×2`, `×4`). With fewer than two parts in the layout it is disabled, title `One part: nothing to draw apart`; with a section on, title `Take the section away to draw the parts apart`. Dragging the slider calls `viewport.setExplode` on every `input` event (no store write) and `actions.setExplode` once on `change` (release): nothing of a drag goes through React or the store, as for the section. Key `E` (in `ViewBar`'s key handler, after the tool in hand has been offered the key: the Region tool's `e` stays its own): toggles between 0 and the last amount above 0 used in this layout (0.5 the first time).
- **`scene.json`.** `clean` in `main/scenefile.ts` keeps `explode`: a record by layout name (any string key of at most 100 characters) of `explodeOf(value)`, entries equal to `NO_EXPLODE` left out. `sceneFileOf` writes `shownByAgent.explode.theirs` in place of what the agent shows.
- **What is reported.** `ViewportPane.report()` adds `explode` when exploded; `reportView` in `main/look.ts` keeps it through `explodeOf`. `sceneTool` adds `explode` (the state or null) and the note of Shared contracts. `context.ts` `layoutShown` adds `, exploded 40 % along z (display only)`. `statefile.ts` says nothing of it (the file is of the build, not of the view).
- **`look`.** `lookTool`: `args.explode` absent → request `'current'`; `null` or a number `0` → `null`; else `explodeArg(args.explode)` or the error `explode is ${explodeHelp}`. With an explode above 0 and a section that would be drawn (given, or `'current'` while the person has one and `args.section` is not null): the error of Shared contracts. The renderer's `picture()` (`ViewportPane.tsx:54`) passes it on; `PictureMaker.render` calls `host.explodeFor(explode, layout)` before `asPictured` and the returned function in `finally`; the caption gains ` · ${explodeText(e)} (${EXPLODED_NOTE})` and, when a scan is drawn too, ` · scans are where they are`. `LookResult.exploded` is set.
- **`show`.** `showTool` takes `explode` the same way (`null` and `0` put the parts together); with a section in the same call, or while the person's view has one and the call does not pass `section: null`: the same error. The renderer's `show` passes it to `actions.showForAgent(…, explode)`, which remembers `theirs` like the section's. `'nothing to show'` names `explode` among what can be given.
- **The prompt** (`prompt.ts`), one sentence after the `show` sentence: `look and show take explode (0 to 1) to draw the parts apart for display; a picture says when it is exploded, and no position, ref or number is ever of an exploded part.` The test's limit becomes 6,800 (D12).

- [ ] **Step 1: Write the failing unit tests.** `app/src/shared/explode.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EXPLODED_NOTE, NO_EXPLODE, explodeArg, explodeOf, explodeOffsets, explodeText, isExploded } from './explode'

const tray = { name: 'tray', bbox: { min: [-20, -15, 0] as [number, number, number], max: [20, 15, 10] as [number, number, number] } }
const lid = { name: 'lid', bbox: { min: [-20, -15, 10] as [number, number, number], max: [20, 15, 12] as [number, number, number] } }
const R = Math.hypot(20, 15, 6)

describe('explodeOffsets', () => {
  it('moves nothing when nothing is exploded, or there is one part', () => {
    expect(explodeOffsets([tray, lid], null)).toEqual({})
    expect(explodeOffsets([tray, lid], NO_EXPLODE)).toEqual({})
    expect(explodeOffsets([tray], { amount: 1, scale: 1, axis: 'centre' })).toEqual({})
  })

  it('moves each part away from the centre of the layout, by the layout\'s reach and its own distance', () => {
    const moved = explodeOffsets([tray, lid], { amount: 0.5, scale: 1, axis: 'centre' })
    expect(moved.tray[0]).toBe(0)
    expect(moved.tray[1]).toBe(0)
    expect(moved.tray[2]).toBeCloseTo(-(R + 1) * 0.5, 9)
    expect(moved.lid[2]).toBeCloseTo((R + 5) * 0.5, 9)
    // Twice as far at twice the scale.
    expect(explodeOffsets([tray, lid], { amount: 0.5, scale: 2, axis: 'centre' }).lid[2]).toBeCloseTo(R + 5, 9)
  })

  it('leaves a part whose centre is the layout\'s where it is', () => {
    const core = { name: 'core', bbox: { min: [-1, -1, 5] as [number, number, number], max: [1, 1, 7] as [number, number, number] } }
    expect(explodeOffsets([tray, lid, core], { amount: 1, scale: 1, axis: 'centre' }).core).toEqual([0, 0, 0])
  })

  it('sets parts apart along an axis in the order of their centres, also when their centres coincide on it', () => {
    const z = explodeOffsets([tray, lid], { amount: 0.5, scale: 1, axis: 'z' })
    expect(z.tray).toEqual([0, 0, expect.closeTo(-0.5 * R, 9)])
    expect(z.lid).toEqual([0, 0, expect.closeTo(0.5 * R, 9)])
    // Along x both centres are at 0: the scene's order decides, and they still part.
    const x = explodeOffsets([tray, lid], { amount: 1, scale: 1, axis: 'x' })
    expect(x.tray[0]).toBeCloseTo(-R, 9)
    expect(x.lid[0]).toBeCloseTo(R, 9)
    expect(x.lid[2]).toBe(0)
  })

  it('never answers with a number that is none', () => {
    const flat = { name: 'a', bbox: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] } }
    for (const moved of Object.values(explodeOffsets([flat, { ...flat, name: 'b' }], { amount: 1, scale: 4, axis: 'centre' }))) expect(moved.every(Number.isFinite)).toBe(true)
  })
})

describe('explodeOf', () => {
  it('keeps what is an explode, within its ranges', () => {
    expect(explodeOf({ amount: 0.4, scale: 2, axis: 'z' })).toEqual({ amount: 0.4, scale: 2, axis: 'z' })
    expect(explodeOf({ amount: 7 })).toEqual({ amount: 1, scale: 1, axis: 'centre' })
    expect(explodeOf({ amount: 0.5, scale: 99, axis: 'w' })).toEqual({ amount: 0.5, scale: 4, axis: 'centre' })
    expect(explodeOf({ amount: -1, scale: 0 })).toEqual({ amount: 0, scale: 0.25, axis: 'centre' })
  })
  it('is none for what is not one', () => {
    for (const value of [null, 3, 'half', [], {}, { amount: '0.5' }, { amount: NaN }, { amount: Infinity }]) expect(explodeOf(value)).toBeNull()
  })
  it('takes a bare number from the agent as the amount', () => {
    expect(explodeArg(0.5)).toEqual({ amount: 0.5, scale: 1, axis: 'centre' })
    expect(explodeArg({ amount: 0.5, axis: 'x' })).toEqual({ amount: 0.5, scale: 1, axis: 'x' })
    expect(explodeArg('0.5')).toBeNull()
  })
})

it('says it in words, and whether anything is apart', () => {
  expect(explodeText({ amount: 0.4, scale: 1, axis: 'centre' })).toBe('exploded 40 % from the centre')
  expect(explodeText({ amount: 1, scale: 2, axis: 'z' })).toBe('exploded 100 % along z, ×2')
  expect(isExploded({ amount: 0, scale: 2, axis: 'z' })).toBe(false)
  expect(isExploded(null)).toBe(false)
  expect(isExploded({ amount: 0.01, scale: 1, axis: 'centre' })).toBe(true)
  expect(EXPLODED_NOTE).toContain('as assembled')
})
```

Run: `pnpm -C app exec vitest run src/shared/explode.test.ts` Expected: FAIL (module missing).

- [ ] **Step 2: Implement `shared/explode.ts`.**

```ts
import { number } from './format'
import type { Vec3 } from './marks'

export interface ExplodeState { amount: number; scale: number; axis: 'centre' | 'x' | 'y' | 'z' }
export const NO_EXPLODE: ExplodeState = { amount: 0, scale: 1, axis: 'centre' }
export const MIN_EXPLODE_SCALE = 0.25
export const MAX_EXPLODE_SCALE = 4
export const EXPLODED_NOTE = 'the parts are drawn apart for display: every position, ref and number told is of the parts as assembled'
export const EXPLODED_TOOLS = 'The parts are drawn apart: put them together (E, or the slider at 0) to mark, measure or cut'
const AXES = ['x', 'y', 'z'] as const

export function isExploded(explode: ExplodeState | null | undefined): explode is ExplodeState {
  return explode !== null && explode !== undefined && explode.amount > 0
}

export function explodeOf(value: unknown): ExplodeState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const said = value as { amount?: unknown; scale?: unknown; axis?: unknown }
  if (typeof said.amount !== 'number' || !Number.isFinite(said.amount)) return null
  const scale = typeof said.scale === 'number' && Number.isFinite(said.scale) ? said.scale : 1
  const axis = said.axis === 'x' || said.axis === 'y' || said.axis === 'z' ? said.axis : 'centre'
  return { amount: Math.min(Math.max(said.amount, 0), 1), scale: Math.min(Math.max(scale, MIN_EXPLODE_SCALE), MAX_EXPLODE_SCALE), axis }
}

export function explodeArg(value: unknown): ExplodeState | null {
  return typeof value === 'number' ? explodeOf({ amount: value }) : explodeOf(value)
}

export interface ExplodePart { name: string; bbox: { min: Vec3; max: Vec3 } }

export function explodeOffsets(parts: readonly ExplodePart[], explode: ExplodeState | null | undefined): Record<string, Vec3> {
  if (!isExploded(explode) || parts.length < 2) return {}
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const { bbox } of parts) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], bbox.min[i])
    max[i] = Math.max(max[i], bbox.max[i])
  }
  const centre = min.map((lo, i) => (lo + max[i]) / 2)
  // Never nothing: a layout with no size is exploded as if it reached half a millimetre.
  const reach = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 0.5)
  const by = explode.amount * explode.scale
  const centres = parts.map(({ bbox }) => bbox.min.map((lo, i) => (lo + bbox.max[i]) / 2))
  const offsets: Record<string, Vec3> = {}
  if (explode.axis === 'centre') {
    parts.forEach((part, n) => {
      const d = centres[n].map((c, i) => c - centre[i])
      const far = Math.hypot(d[0], d[1], d[2])
      // A part at the centre has no way to go: it stays, and the others leave it.
      const k = far > reach * 1e-6 ? ((reach + far) * by) / far : 0
      offsets[part.name] = [d[0] * k + 0, d[1] * k + 0, d[2] * k + 0]
    })
    return offsets
  }
  const i = AXES.indexOf(explode.axis)
  // By where each centre is along the axis; the scene's order where two are level (the sort is stable).
  const order = parts.map((_, n) => n).sort((a, b) => centres[a][i] - centres[b][i])
  order.forEach((n, rank) => {
    const moved: Vec3 = [0, 0, 0]
    moved[i] = (rank - (parts.length - 1) / 2) * 2 * reach * by + 0
    offsets[parts[n].name] = moved
  })
  return offsets
}

export function explodeText(explode: ExplodeState): string {
  const how = explode.axis === 'centre' ? 'from the centre' : `along ${explode.axis}`
  return `exploded ${number(explode.amount * 100)} % ${how}${explode.scale === 1 ? '' : `, ×${number(explode.scale)}`}`
}
```

Run the same command. Expected: PASS.

- [ ] **Step 3: Write the failing tests of the store, the scene file, the mark layer and the tools.**

Add to `app/src/renderer/state/store.test.ts` (with its `open` helper and a two-layout scene):

```ts
it('explodes the layout shown by hand, keeps it per layout, and saves it', () => {
  open()
  expect(actions.setExplode({ amount: 0.4 })).toBeNull()
  actions.setExplode({ axis: 'z' })
  expect(store.getState().explode).toEqual({ assembly: { amount: 0.4, scale: 1, axis: 'z' } })
  expect(sceneFileOf(store.getState()).explode).toEqual({ assembly: { amount: 0.4, scale: 1, axis: 'z' } })
  actions.setLayout('print')
  expect(explodeNow(store.getState())).toBeNull()
  actions.setExplode({ amount: 0 })
  expect(sceneFileOf(store.getState()).explode).toEqual({ assembly: { amount: 0.4, scale: 1, axis: 'z' } })
})

it('never has a section and an explode at once', () => {
  open()
  actions.setSection({ origin: [0, 0, 3], normal: [0, 0, 1] })
  expect(actions.setExplode({ amount: 0.5 })).toBe('Take the section away to draw the parts apart')
  expect(explodeNow(store.getState())).toBeNull()
  actions.setSection(null)
  actions.setExplode({ amount: 0.5 })
  actions.setSection({ origin: [0, 0, 3], normal: [0, 0, 1] })
  expect(explodeNow(store.getState())).toBeNull()
  // What it was drawn apart by is remembered for when the cut is gone: only the amount went.
  expect(store.getState().explode.assembly).toMatchObject({ amount: 0, scale: 1, axis: 'centre' })
})

it('shows an explode for the agent without making it the person\'s', () => {
  open()
  const edits = store.getState().edits
  actions.showForAgent('assembly', {}, undefined, undefined, { amount: 1, scale: 1, axis: 'x' })
  expect(explodeNow(store.getState())).toEqual({ amount: 1, scale: 1, axis: 'x' })
  expect(store.getState().edits).toBe(edits)
  expect(sceneFileOf(store.getState()).explode).toBeUndefined()
  // Their own choice afterwards is theirs.
  actions.setExplode({ amount: 0.2 })
  expect(store.getState().shownByAgent).toBeNull()
  expect(sceneFileOf(store.getState()).explode).toEqual({ assembly: { amount: 0.2, scale: 1, axis: 'x' } })
})
```

Add to `app/src/main/scenefile.test.ts`: `{ layers: {}, explode: { assembly: { amount: 0.4, axis: 'z' }, print: { amount: 0 }, bad: 'x', also: { amount: 9, scale: 9 } } }` saved and loaded is `{ layers: {}, explode: { assembly: { amount: 0.4, scale: 1, axis: 'z' }, also: { amount: 1, scale: 4, axis: 'centre' } } }`.

Add to the test of `MarkLayer` (`viewport/marks/MarkLayer.test.ts`):

```ts
it('moves a mark with its part, leaves one on no part, and does not draw one whose ends moved apart', () => {
  const pin = { kind: 'pin', anchor: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
  const free = { kind: 'shape', position: [5, 5, 5] } as unknown as Mark
  const across = { kind: 'dimension', a: { point: [0, 0, 10], part: 'tray' }, b: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
  const within = { kind: 'dimension', a: { point: [0, 0, 10], part: 'lid' }, b: { point: [0, 0, 12], part: 'lid' } } as unknown as Mark
  const offsets = { lid: [0, 0, 15] as [number, number, number], tray: [0, 0, -13] as [number, number, number] }
  expect(markOffset(pin, offsets)).toEqual([0, 0, 15])
  expect(markOffset(free, offsets)).toEqual([0, 0, 0])
  expect(markOffset(within, offsets)).toEqual([0, 0, 15])
  expect(markOffset(across, offsets)).toBe('split')
  expect(markOffset(across, {})).toEqual([0, 0, 0])
})
```

Add to `app/src/renderer/tools/Tool.test.ts` (with its fake context and viewport):

```ts
it('hands a press to no tool but Select while the parts are drawn apart, and says why', () => {
  const said: string[] = []
  const got: string[] = []
  const ctx = context({ exploded: EXPLODED_TOOLS, readout: { ...quiet, say: (_at, text) => void said.push(text) } })
  const tool = (id: string): Tool => ({ id, cursor: 'default', onPointer: () => void got.push(id), cancel: () => {} })
  routePointer(tool('pin'), press({ hit: face }), ctx)
  routePointer(tool('measure'), press({ hit: face }), ctx)
  routePointer(tool('select'), press({ hit: face }), ctx)
  expect(got).toEqual(['select'])
  expect(said).toEqual([EXPLODED_TOOLS, EXPLODED_TOOLS])
})
```

Add to `app/src/main/mcp/tools.test.ts` (it has `deps()` with a fake `look` and `show` that record their requests):

```ts
it('asks for an exploded picture, refuses one with a section, and tells positions as before', async () => {
  const d = deps()
  await lookTool(d, 'hollow', { explode: 0.5 })
  expect(d.looked.at(-1)).toMatchObject({ explode: { amount: 0.5, scale: 1, axis: 'centre' } })
  await lookTool(d, 'hollow', {})
  expect(d.looked.at(-1)!.explode).toBe('current')
  await lookTool(d, 'hollow', { explode: 0 })
  expect(d.looked.at(-1)!.explode).toBeNull()
  const both = await lookTool(d, 'hollow', { explode: 0.5, section: { axis: 'z', at: 3 } })
  expect(both.isError).toBe(true)
  expect(text(both)).toBe('a section is not drawn exploded: give explode or section, not both (explode: null draws the parts together, section: null draws them whole)')
  expect(text(await lookTool(d, 'hollow', { explode: 'half' as never }))).toContain('explode is a number from 0 to 1')
})

it('reports an exploded view in scene, with the note, and every part where it is built', () => {
  const d = deps({ view: { explode: { amount: 0.4, scale: 1, axis: 'z' } } })
  const exploded = JSON.parse(text(sceneTool(d, 'hollow')))
  const assembled = JSON.parse(text(sceneTool(deps(), 'hollow')))
  expect(exploded.explode).toEqual({ amount: 0.4, scale: 1, axis: 'z' })
  expect(exploded.note).toContain('exploded 40 % along z: the parts are drawn apart for display')
  expect(exploded.parts).toEqual(assembled.parts)
  expect(assembled.explode).toBeNull()
})
```

Add to `app/src/main/mcp/readTools.test.ts`: `measureTool` and `checkTool` answer the same text with `view.explode` set as without it (one `expect(...).toEqual(...)` each: the readings do not look at the view).

Run: `pnpm -C app exec vitest run src/renderer/state/store.test.ts src/main/scenefile.test.ts src/renderer/viewport/marks src/renderer/tools/Tool.test.ts src/main/mcp` Expected: FAIL.

- [ ] **Step 4: Implement** the store, `main/scenefile.ts`, `shared/view.ts`, `main/look.ts`, the schemas, `viewTools.ts`, `markOffset` and `MarkLayer.setOffsets`, `routePointer`, `Viewport.setExplode`/`placePart`/`pick`/`project`, `picture.ts`, `agent.ts`, `ExplodeControl`, the prompt sentence. `markOffset`:

```ts
export function markOffset(mark: Mark, offsets: Readonly<Record<string, Vec3>>): Vec3 | 'split' {
  const anchors = mark.kind === 'dimension' ? markAnchors(mark) : markAnchors(mark).slice(0, 1)
  const moved = anchors.map((anchor) => (anchor.part !== undefined && offsets[anchor.part]) || ([0, 0, 0] as Vec3))
  if (moved.length === 0) return [0, 0, 0]
  return moved.every((m) => m.every((c, i) => Math.abs(c - moved[0][i]) < 1e-9)) ? moved[0] : 'split'
}
```

Run the command of Step 3. Expected: PASS. Then `pnpm -C app typecheck`.

- [ ] **Step 5: Write the e2e test.** `app/e2e/explode.spec.ts` (launch and helpers as `e2e/mcp.spec.ts`: a temporary copy of the fixtures, `TORNO_TEST: '1'`, the stand-in agent, an MCP client `call(name, args)` against `__tornoMain.mcpUrlFor('hollow')`):

```ts
test('the parts are drawn apart, what is picked is where the part is, and nothing is marked meanwhile', async () => {
  await open('hollow')                                           // tub and lid
  const lidTop: Vec3 = [0, 0, (await state()).scene!.parts.find((p) => p.name === 'lid')!.bbox.max[2]]
  const before = await page.evaluate((p) => window.__tornoTest!.project(p), lidTop)
  await page.getByRole('slider', { name: 'Explode' }).fill('100')
  await expect.poll(async () => (await state()).explode.assembly?.amount).toBe(1)
  // Drawn somewhere else now: as a point of the lid it has moved on screen.
  const after = await page.evaluate((p) => window.__tornoTest!.project(p, 'lid'), lidTop)
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.05)
  // Picked where it is drawn, answered where it is.
  const hit = await page.evaluate(({ x, y }) => window.__tornoTest!.pickAt(x, y), after)
  expect(hit?.ref.startsWith('lid/F')).toBe(true)
  expect(Math.abs(hit!.point[2] - lidTop[2])).toBeLessThan(1e-3)
  // A pin is not placed: the pointer says why, and no mark is kept.
  await page.keyboard.press('p')
  const box = (await page.locator('[data-region="viewport"] canvas').boundingBox())!
  await page.mouse.click(box.x + after.x * box.width, box.y + after.y * box.height)
  await expect(page.locator('.readout')).toContainText('The parts are drawn apart')
  expect((await state()).marks).toHaveLength(0)
  // Put together with E, the pin goes where it was aimed.
  await page.keyboard.press('e')
  await expect.poll(async () => (await state()).explode.assembly?.amount).toBe(0)
})

test('the agent sees an exploded picture as one, and measures the parts as they are', async () => {
  const assembled = text(await call('measure', { kind: 'bbox', a: 'lid' }))
  const look = await call('look', { explode: { amount: 1, axis: 'z' } })
  expect(caption(look)).toContain('exploded 100 % along z (the parts are drawn apart for display: every position, ref and number told is of the parts as assembled)')
  expect(text(await call('measure', { kind: 'bbox', a: 'lid' }))).toBe(assembled)
  // The person's view was not changed by the picture.
  expect((await state()).explode.assembly?.amount ?? 0).toBe(0)
  const shown = text(await call('show', { explode: 0.5 }))
  expect(shown).toContain('exploded 50 % from the centre')
  expect(JSON.parse(text(await call('scene', {}))).explode).toEqual({ amount: 0.5, scale: 1, axis: 'centre' })
  // For now only: not what their scene file keeps.
  await page.waitForTimeout(700)
  expect(JSON.parse(readFileSync(join(root, 'hollow', '.torno', 'scene.json'), 'utf8')).explode).toBeUndefined()
})
```

(`project` of `window.__tornoTest` takes the optional part name and answers fractions of the canvas as now; the readout's element is the one `Readout` makes: take its class from `viewport/highlight.ts`.)

Run: `pnpm build && pnpm -C app exec playwright test e2e/explode.spec.ts` Expected: PASS.

- [ ] **Step 6: `CLAUDE.md`.** Under "Kernel invariants", "One geometry" ends: `The viewport never moves a part, with one exception that is display only: explode (below).` A new section `## Explode` with the five bullets of R2 as written under Decisions, naming `shared/explode.ts`, `Viewport.setExplode`, `Viewport.pick`, `markOffset`, `ToolContext.exploded`, `EXPLODED_NOTE`, D2 and key `E`. The Tools and keys bullet gains `E`.

- [ ] **Step 7: Run all suites and commit.**

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && pnpm test:e2e
git add -A app CLAUDE.md && git commit -m "Explode: the parts of a layout are drawn apart for display, and nothing kept or told is ever of an exploded part

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Saved views

**Files:**
- Create: `app/src/shared/views.ts`, `app/src/shared/views.test.ts`, `app/src/renderer/ui/ViewsStrip.tsx`, `app/e2e/views.spec.ts`
- Modify: `app/src/shared/{scenefile,view,bridge}.ts`, `app/src/preload/index.ts`, `app/src/main/{scenefile,look,ipc,index,prompt,statefile}.ts` and tests, `app/src/main/mcp/{schemas,tools,viewTools}.ts`, `tools.test.ts`, `app/src/renderer/state/{store,agent}.ts`, `store.test.ts`, `app/src/renderer/ui/ViewportPane.tsx`, `styles/app.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `ExplodeState`, `explodeOf`, `explodeArg`, `explodeText`, `EXPLODED_NOTE` (Task 2); `cameraOf`, `cameraKeys`, `lookTool`, `showTool` (Task 1); `actions.showForAgent(…, explode)` (Task 2).
- Produces: everything under "Saved views" in Shared contracts, the `save_view` tool, and:

```ts
// main/scenefile.ts
/** The scene file of a folder as main last read it or was given it to save: what `scene`, `look` and `show` answer from. Reads the disk the first time. */
export function sceneFileNow(dir: string): Promise<SceneFile>
// main/look.ts
export function requestSaveView(win: BrowserWindow, req: SaveViewRequest, timeoutMs?: number): Promise<SaveViewResult>
// main/mcp/tools.ts, ToolDeps
views(objectId: string): Promise<SavedView[]>
saveView(objectId: string, req: SaveViewRequest): Promise<SaveViewResult>
// main/mcp/viewTools.ts
export function saveViewTool(deps: ToolDeps, objectId: string, args: SaveViewArgs): Promise<ToolResult>
/** What a saved view asks of a picture or of the window: its camera, layout, the parts it shows (every part of its layout the build has, but its hidden ones), its section or its explode, its scans. Or the error to answer with. */
export function namedView(deps: ToolDeps, objectId: string, scene: Scene, name: string): Promise<{ view: SavedView; parts: string[]; scans?: string[] } | ToolResult>
// shared/bridge.ts, view
onSaveView(cb: (m: { id: number; request: SaveViewRequest }) => void): () => void
saveViewReply(id: number, result: SaveViewResult | { error: string }): void
// renderer/state/store.ts
views: SavedView[]
actions.saveView(name: string, camera: Camera): string | null       // the view on screen, by hand; replaces one of that name. Returns why not, or null
actions.applyView(name: string): SavedView | string                  // sets layout, layers, section, explode, scans as an edit of the person's; returns the view (for its camera) or why not
actions.removeView(name: string): void
actions.keepView(name: string): void                                  // the agent's proposal becomes one of the views: `proposed` goes
actions.proposeView(view: SavedView): boolean                         // the agent's; replaces its own proposal of that name; false when it cannot (`viewNameRefusal`)
```

Behaviour:
- **A name** is trimmed, one line, 1 to 40 characters, no control character, and not one of `RESERVED_VIEW_NAMES` in any case. Two names are the same when they are equal in lower case. A person may save over any view (the button says "Replace"); the agent may save only over its own view that is still `proposed`. With `MAX_VIEWS` views a new name is refused: `There are 24 views: remove one first`.
- **Saving by hand** takes what is on screen: `viewport.getCamera()`, the layout, `hidden` (the names of the layout's parts whose layer is switched off), the section, or else the layout's explode when exploded, and `scans` (for each scan whose `scanViews` entry sets `visible` or `opacity`). Where the agent's `show` has something else on screen, it is what is on screen that is saved: the person saves what they see.
- **Applying** (`applyView`): refused with `Layout print is no longer in the model` when the build has not the view's layout. Otherwise, as one edit: the layout; every part of that layout switched on unless its name is in `hidden` (names the build no longer has are passed over); the section (or none); the layout's explode (the view's, or `amount: 0`); each scan the object still has shown as the view says, the others left. Then the caller moves the camera: `viewport.setView(view.camera, true)`. It is the person's own choice: `shownByAgent` is cleared.
- **The strip** (`ViewsStrip`, under the `ViewBar`, `role="toolbar" aria-label="Saved views"`): a chip per view (`button.view-chip[data-view="<name>"]`), its name; one that is `proposed` has the word `proposed` after it in `--muted` and two small buttons, "Keep" and "Discard"; any chip shows a "Remove" × on hover or focus. A chip whose layout is gone is `aria-disabled` with the reason as its title. At the end "+ Save view": a field (`aria-label="Name of the view"`, `maxLength={40}`) and "Save" (or "Replace"); Enter saves, Escape puts it away; a refusal is shown under the field in `--fail`. With no views and no object built the strip is not shown. Colours are tokens that are neither `--user-mark` nor `--agent-mark`.
- **`scene.json`.** `clean` keeps `views: savedViewsOf(value.views)` when it has any. `sceneFileOf` writes `views`. `saveSceneFile` and `loadSceneFile` record the cleaned file per `dir` for `sceneFileNow`; `forgetViews()` in `look.ts` is joined by `forgetSceneFiles()`, called where the workspace is closed.
- **`scene`** adds `views: (await deps.views(objectId)).map(viewSummary)` (`registerTools` awaits it as it does the marks and the scans; a file that cannot be read gives none).
- **`look {view}` and `show {view}`.** A string that is `current` or one of `VIEW_NAMES` is what it was. Any other string is a saved view's name: `namedView` finds it (whatever the case) or answers with the error of Shared contracts listing the names. Found, the request is the view's camera, layout, parts, section and explode, and for `look` the scans the view switches on; an argument given beside `view` (`layout`, `parts`, `section`, `explode`, `scans`) wins over the view's. A view of a layout the build no longer has: `the view "Hinge side" is of layout print, which the model no longer has (layouts: assembly)`. The caption's view is `"Hinge side"` in double quotes (the renderer is given a camera and the name: `LookRequest` and `ShowRequest` gain `viewName?: string`, used only for the caption). `show {view: name}` changes the person's screen for now, like any `show`.
- **`save_view`** is refused for an object that is not open in the window (`onScreen`). Main checks the name (`viewNameRefusal` against `deps.views`), the layout, the parts, the plane, the explode, and `section` with `explode` (the error of Task 2); the window (`agent.ts`, a third `answered` handler beside `show` and `highlight`) builds the `SavedView` from the request and what is on screen, calls `actions.proposeView`, saves the scene file at once (`window.torno.object.saveSceneFile(id, sceneFileOf(state))`, not after the 500 ms) and answers. The text of the reply is as in Shared contracts. `registerTools` gets `tool<SaveViewArgs>('save_view', …)`; `TOOLS.save_view.inputSchema = saveViewInput`.
- **`state.md`** gains a line `Saved views: "Hinge side", "Wall at the latch" (proposed by the agent)` when there are any (`stateText` takes `views?: readonly SavedView[]`).
- **The prompt**, two sentences after the explode sentence: `scene lists the views the user saved by name: look {"view": "Hinge side"} draws one and show {"view": "Hinge side"} puts it on their screen.` and `mcp__torno__save_view {"name": "Wall at the latch", "view": "front", "parts": ["tray"]} proposes a view of your own for them to keep.`

- [ ] **Step 1: Write the failing unit tests.** `app/src/shared/views.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_VIEWS, findView, savedViewOf, savedViewsOf, viewNameRefusal, viewSummary, type SavedView } from './views'

const camera = { position: [120, -90, 60], target: [0, 0, 6], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const view = (name: string, more: Partial<SavedView> = {}): SavedView => ({ name, author: 'user', layout: 'assembly', camera: camera as SavedView['camera'], hidden: [], at: '2026-10-09T21:14:03.000Z', ...more })

describe('savedViewOf', () => {
  it('keeps a view as it was saved', () => {
    const full = view('Hinge side', { hidden: ['lid'], explode: { amount: 0.4, scale: 1, axis: 'z' }, scans: { S1: { visible: false, opacity: 0.5 } } })
    expect(savedViewOf(JSON.parse(JSON.stringify(full)))).toEqual(full)
  })

  it('keeps of a damaged view what is one, and nothing of what is none', () => {
    expect(savedViewOf({ ...view('  Top  side '), hidden: ['lid', 3, 'lid'], scans: { S1: { visible: 'no', opacity: 7, colour: 'plain' }, lid: { visible: false } }, author: 'me' })).toBeNull()
    expect(savedViewOf({ ...view('  Top  side '), hidden: ['lid', 3, 'lid'], scans: { S1: { visible: 'no', opacity: 7, colour: 'plain' }, lid: { visible: false } } })).toEqual(view('Top  side', { hidden: ['lid'], scans: { S1: { opacity: 1 } } }))
    for (const broken of [null, 'view', { ...view('a'), camera: { ...camera, target: camera.position } }, { ...view('a'), layout: 7 }, { ...view(''), name: ' ' }, { ...view('iso') }, { ...view('Front') }, { ...view('x'.repeat(41)) }, { ...view('two\nlines') }]) {
      expect(savedViewOf(broken)).toBeNull()
    }
  })

  it('holds a section or an explode, never both: the section stays', () => {
    const both = savedViewOf({ ...view('Cut'), section: { origin: [0, 0, 3], normal: [0, 0, 2] }, explode: { amount: 0.5 } })!
    expect(both.section).toEqual({ origin: [0, 0, 3], normal: [0, 0, 1] })
    expect(both.explode).toBeUndefined()
    // An explode of nothing is not kept.
    expect(savedViewOf({ ...view('Flat'), explode: { amount: 0 } })!.explode).toBeUndefined()
  })

  it('marks only an agent\'s view as proposed, and keeps its note to a line', () => {
    expect(savedViewOf({ ...view('Mine'), proposed: true })!.proposed).toBeUndefined()
    const agents = savedViewOf({ ...view('Wall', { author: 'agent' }), proposed: true, note: ` the wall\nM7 is about ${'x'.repeat(300)}` })!
    expect(agents.proposed).toBe(true)
    expect(agents.note).toHaveLength(200)
    expect(agents.note).not.toContain('\n')
  })
})

describe('savedViewsOf', () => {
  it('drops a broken view and a second of the same name, and stops at the most there may be', () => {
    expect(savedViewsOf([view('A'), { name: 'broken' }, view('a'), view('B')]).map((v) => v.name)).toEqual(['A', 'B'])
    expect(savedViewsOf(Array.from({ length: 40 }, (_, i) => view(`v${i}`)))).toHaveLength(MAX_VIEWS)
    expect(savedViewsOf('views')).toEqual([])
  })
})

describe('names', () => {
  const views = [view('Hinge side'), view('Wall', { author: 'agent', proposed: true }), view('Kept', { author: 'agent' })]
  it('finds a view whatever the case', () => {
    expect(findView(views, 'hinge SIDE')?.name).toBe('Hinge side')
    expect(findView(views, 'hinge')).toBeUndefined()
  })
  it('lets the person save over any view, and the agent only over its own proposal', () => {
    expect(viewNameRefusal('Hinge side', views, 'user')).toBeNull()
    expect(viewNameRefusal('New', views, 'agent')).toBeNull()
    expect(viewNameRefusal('wall', views, 'agent')).toBeNull()
    expect(viewNameRefusal('hinge side', views, 'agent')).toBe('the user has a view named "Hinge side": choose another name')
    expect(viewNameRefusal('Kept', views, 'agent')).toBe('the user kept the view "Kept": choose another name')
  })
  it('refuses a name that is none, a standard view\'s, and one more than there may be', () => {
    expect(viewNameRefusal(' ', views, 'user')).toBe('A view needs a name')
    expect(viewNameRefusal('TOP', views, 'user')).toBe('"TOP" is a standard view: choose another name')
    expect(viewNameRefusal('x'.repeat(41), views, 'user')).toBe('A name has at most 40 characters')
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => view(`v${i}`))
    expect(viewNameRefusal('one more', full, 'user')).toBe('There are 24 views: remove one first')
    expect(viewNameRefusal('v3', full, 'user')).toBeNull()
  })
  it('summarises a view for the agent', () => {
    expect(viewSummary(view('Wall', { author: 'agent', proposed: true, note: 'thin', section: { origin: [0, 0, 0], normal: [0, 0, 1] } }))).toEqual({ name: 'Wall', by: 'agent', proposed: true, layout: 'assembly', section: true, note: 'thin' })
    expect(viewSummary(view('Apart', { explode: { amount: 1, scale: 1, axis: 'x' } }))).toEqual({ name: 'Apart', by: 'user', layout: 'assembly', exploded: true })
  })
})
```

Add to `store.test.ts`:

```ts
it('saves the view on screen, applies it again as the person\'s own, and passes over what is gone', () => {
  open()
  actions.setLayer('lid', { visible: false })
  actions.setExplode({ amount: 0.4, axis: 'z' })
  expect(actions.saveView('Hinge side', CAMERA)).toBeNull()
  expect(store.getState().views[0]).toMatchObject({ name: 'Hinge side', author: 'user', layout: 'assembly', hidden: ['lid'], explode: { amount: 0.4, scale: 1, axis: 'z' } })
  expect(sceneFileOf(store.getState()).views).toHaveLength(1)
  actions.setLayer('lid', { visible: true })
  actions.setExplode({ amount: 0 })
  actions.setLayout('print')
  const applied = actions.applyView('hinge side')
  expect(applied).toMatchObject({ name: 'Hinge side' })
  const s = store.getState()
  expect([s.layout, s.layers.lid?.visible, explodeNow(s)?.amount]).toEqual(['assembly', false, 0.4])
  // A view that hides a part the model no longer has, of a layout it still has, is applied without it.
  store.setState({ views: [{ ...s.views[0], hidden: ['lid', 'gone'] }] })
  expect(typeof actions.applyView('Hinge side')).toBe('object')
  // One of a layout that is gone is not.
  store.setState({ views: [{ ...s.views[0], layout: 'bed' }] })
  expect(actions.applyView('Hinge side')).toBe('Layout bed is no longer in the model')
})

it('keeps the agent\'s view as proposed until the person keeps it, and never over one of theirs', () => {
  open()
  actions.saveView('Mine', CAMERA)
  const proposal = { ...store.getState().views[0], name: 'Wall', author: 'agent' as const, proposed: true as const }
  expect(actions.proposeView(proposal)).toBe(true)
  expect(actions.proposeView({ ...proposal, name: 'mine' })).toBe(false)
  expect(store.getState().views.map((v) => [v.name, v.proposed])).toEqual([['Mine', undefined], ['Wall', true]])
  actions.keepView('Wall')
  expect(store.getState().views[1]).toMatchObject({ name: 'Wall', author: 'agent' })
  expect(store.getState().views[1].proposed).toBeUndefined()
  actions.removeView('Mine')
  expect(store.getState().views.map((v) => v.name)).toEqual(['Wall'])
})
```

Add to `app/src/main/mcp/tools.test.ts` (`deps({ views: [...] })` answers `views()` with them and records `saveView` requests):

```ts
const HINGE = { name: 'Hinge side', author: 'user', layout: 'assembly', camera: CAMERA, hidden: ['lid'], explode: { amount: 0.4, scale: 1, axis: 'z' }, at: '' } as SavedView

it('draws and shows a saved view by its name, and lets what is given beside it win', async () => {
  const d = deps({ views: [HINGE] })
  await lookTool(d, 'hollow', { view: 'hinge side' })
  expect(d.looked.at(-1)).toMatchObject({ view: CAMERA, viewName: 'Hinge side', layout: 'assembly', parts: ['tub'], explode: HINGE.explode })
  await lookTool(d, 'hollow', { view: 'Hinge side', parts: ['tub', 'lid'], explode: null })
  expect(d.looked.at(-1)).toMatchObject({ parts: ['tub', 'lid'], explode: null })
  await showTool(d, 'hollow', { view: 'Hinge side' })
  expect(d.shown.at(-1)).toMatchObject({ view: CAMERA, layout: 'assembly', parts: ['tub'], explode: HINGE.explode })
  expect(text(await lookTool(d, 'hollow', { view: 'hinge' }))).toBe('no view "hinge": the saved views are "Hinge side"; or current, iso, front, back, left, right, top, bottom, or a camera')
  expect(text(await lookTool(deps({ views: [{ ...HINGE, layout: 'bed' }] }), 'hollow', { view: 'Hinge side' }))).toBe('the view "Hinge side" is of layout bed, which the model no longer has (layouts: assembly, print)')
})

it('lists the views in scene, and proposes one only under a name that is free', async () => {
  const d = deps({ views: [HINGE] })
  expect(JSON.parse(text(await sceneWith(d))).views).toEqual([{ name: 'Hinge side', by: 'user', layout: 'assembly', exploded: true }])
  const taken = await saveViewTool(d, 'hollow', { name: 'hinge side' })
  expect(text(taken)).toBe('the user has a view named "Hinge side": choose another name (their views: "Hinge side")')
  expect(d.savedViews).toHaveLength(0)
  const kept = await saveViewTool(d, 'hollow', { name: 'Wall at the latch', view: 'front', parts: ['tub'], note: 'the 1.2 mm wall M7 is about' })
  expect(d.savedViews[0]).toMatchObject({ objectId: 'hollow', name: 'Wall at the latch', view: 'front', parts: ['tub'], note: 'the 1.2 mm wall M7 is about' })
  expect(text(kept)).toContain('saved "Wall at the latch" as a view you propose')
  expect(text(await saveViewTool(d, 'hollow', { name: 'Both', section: { axis: 'z', at: 3 }, explode: 0.5 }))).toContain('a section is not drawn exploded')
  expect(text(await saveViewTool(d, 'hollow', { name: 'x', parts: ['nope'] }))).toContain("unknown part 'nope'")
})

it('refuses a key save_view does not take', () => {
  expect(text(refusedKeys('save_view', { name: 'a', camera: {} })!)).toContain('save_view takes no "camera"')
})
```

Run: `pnpm -C app exec vitest run src/shared/views.test.ts src/renderer/state/store.test.ts src/main/mcp/tools.test.ts` Expected: FAIL.

- [ ] **Step 2: Implement `shared/views.ts`.** `savedViewOf` in full (the others follow from it and the tests):

```ts
export function savedViewOf(value: unknown): SavedView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const said = value as Record<string, unknown>
  const name = typeof said.name === 'string' ? said.name.trim() : ''
  if (viewNameShape(name) !== null) return null
  if (said.author !== 'user' && said.author !== 'agent') return null
  if (typeof said.layout !== 'string' || said.layout === '' || said.layout.length > 100) return null
  const camera = cameraOfFile(said.camera)
  if (!camera) return null
  const view: SavedView = { name, author: said.author, layout: said.layout, camera, hidden: [], at: typeof said.at === 'string' ? said.at.slice(0, 40) : '' }
  if (Array.isArray(said.hidden)) view.hidden = [...new Set(said.hidden.filter((part): part is string => typeof part === 'string' && part.length > 0 && part.length <= 200))].slice(0, 256)
  if (said.author === 'agent' && said.proposed === true) view.proposed = true
  if (typeof said.note === 'string') {
    const note = said.note.replace(/\s+/g, ' ').trim().slice(0, MAX_VIEW_NOTE)
    if (note) view.note = note
  }
  const section = sectionOf(said.section)
  const explode = explodeOf(said.explode)
  if (section) view.section = section
  else if (isExploded(explode)) view.explode = explode
  if (typeof said.scans === 'object' && said.scans !== null && !Array.isArray(said.scans)) {
    const scans: NonNullable<SavedView['scans']> = {}
    for (const [id, raw] of Object.entries(said.scans as Record<string, unknown>)) {
      if (!/^S[1-9]\d{0,14}$/.test(id) || typeof raw !== 'object' || raw === null) continue
      const { visible, opacity } = raw as { visible?: unknown; opacity?: unknown }
      const shown: { visible?: boolean; opacity?: number } = {}
      if (typeof visible === 'boolean') shown.visible = visible
      if (typeof opacity === 'number' && Number.isFinite(opacity)) shown.opacity = Math.min(Math.max(opacity, MIN_SCAN_OPACITY), 1)
      if (Object.keys(shown).length > 0) scans[id] = shown
    }
    if (Object.keys(scans).length > 0) view.scans = scans
  }
  return view
}

/** Why a text is no name for a view, or null: the shape of it only, not whether it is taken. */
function viewNameShape(name: string): string | null {
  if (name === '') return 'A view needs a name'
  if (name.length > MAX_VIEW_NAME) return `A name has at most ${MAX_VIEW_NAME} characters`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'A name is one line'
  if ((RESERVED_VIEW_NAMES as readonly string[]).includes(name.toLowerCase())) return `"${name}" is a standard view: choose another name`
  return null
}

/** A camera out of a file: position, target and up as three finite numbers each, a lens of 1 to 120 degrees, a zoom above 0, and a position that is not its target. */
function cameraOfFile(value: unknown): Camera | null {
  const said = value as Partial<Record<keyof Camera, unknown>> | null
  if (typeof said !== 'object' || said === null) return null
  const triple = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null)
  const position = triple(said.position)
  const target = triple(said.target)
  const up = triple(said.up)
  if (!position || !target || !up || position.every((c, i) => c === target[i]) || up.every((c) => c === 0)) return null
  const fov = typeof said.fov === 'number' && said.fov >= 1 && said.fov <= 120 ? said.fov : 35
  const zoom = typeof said.zoom === 'number' && Number.isFinite(said.zoom) && said.zoom > 0 ? said.zoom : 1
  return { position, target, up, ortho: said.ortho === true, fov, zoom }
}
```

`viewNameRefusal(name, views, author)`: `viewNameShape(name.trim())`, then the view of that name: for `'agent'`, a user's is `the user has a view named "<its name>": choose another name`, its own that is no longer proposed is `the user kept the view "<its name>": choose another name`; with no view of that name and `views.length >= MAX_VIEWS`, `There are 24 views: remove one first`. `saveViewTool` adds ` (their views: "A", "B")` to the first of those when it answers.

- [ ] **Step 3: Implement** the store actions, `sceneFileNow`, the bridge channel `view:saveView` (preload and `ipc.ts`, copying `view:show`), `requestSaveView`, `ToolDeps.views`/`saveView` in `index.ts` (`views: (id) => { const obj = findObject(id); return obj ? sceneFileNow(obj.dir).then((f) => f.views ?? []) : Promise.resolve([]) }`), `namedView`, `saveViewTool`, the strip, the prompt sentences, `stateText`.

Run the command of Step 1, then `pnpm -C app typecheck`. Expected: PASS.

- [ ] **Step 4: Write the e2e test.** `app/e2e/views.spec.ts` (harness as `explode.spec.ts`):

```ts
test('a view is saved under a name, survives a restart of the window\'s state, and is applied with a click', async () => {
  await open('hollow')
  await page.getByRole('slider', { name: 'Explode' }).fill('40')
  await page.getByRole('button', { name: 'Save view' }).click()
  await page.getByRole('textbox', { name: 'Name of the view' }).fill('Apart')
  await page.keyboard.press('Enter')
  await expect(page.locator('.view-chip[data-view="Apart"]')).toBeVisible()
  await expect.poll(() => existsSync(join(root, 'hollow', '.torno', 'scene.json')) && JSON.parse(readFileSync(join(root, 'hollow', '.torno', 'scene.json'), 'utf8')).views?.[0]?.name).toBe('Apart')
  await page.getByRole('slider', { name: 'Explode' }).fill('0')
  await open('plain')
  await open('hollow')
  await page.locator('.view-chip[data-view="Apart"]').click()
  await expect.poll(async () => (await state()).explode.assembly?.amount).toBe(0.4)
  // A standard view's name is refused where it is typed.
  await page.getByRole('button', { name: 'Save view' }).click()
  await page.getByRole('textbox', { name: 'Name of the view' }).fill('top')
  await page.keyboard.press('Enter')
  await expect(page.getByText('"top" is a standard view: choose another name')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('the agent lists the views, draws one by name, and proposes one the person keeps', async () => {
  expect(JSON.parse(text(await call('scene', {}))).views).toEqual([{ name: 'Apart', by: 'user', layout: 'assembly', exploded: true }])
  expect(caption(await call('look', { view: 'apart' }))).toMatch(/^view "Apart" · layout assembly · .*exploded 40 % from the centre/)
  const saved = text(await call('save_view', { name: 'Tub alone', view: 'front', parts: ['tub'], note: 'the wall' }))
  expect(saved).toContain('saved "Tub alone" as a view you propose: layout assembly, parts tub')
  const chip = page.locator('.view-chip[data-view="Tub alone"]')
  await expect(chip).toContainText('proposed')
  // At once in what scene lists, and on the disk.
  expect(JSON.parse(text(await call('scene', {}))).views[1]).toEqual({ name: 'Tub alone', by: 'agent', proposed: true, layout: 'assembly', note: 'the wall' })
  expect(text(await call('save_view', { name: 'APART' }))).toContain('the user has a view named "Apart"')
  await page.getByRole('button', { name: 'Keep Tub alone' }).click()
  await expect(chip).not.toContainText('proposed')
  // Proposing changed nothing on screen; showing it does, for now.
  expect((await state()).layers.lid?.visible).not.toBe(false)
  expect(text(await call('show', { view: 'Tub alone' }))).toContain('parts tub')
  expect((await state()).layers.lid?.visible).toBe(false)
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/views.spec.ts` Expected: PASS.

- [ ] **Step 5: `CLAUDE.md`** gains a section `## Views` : what a saved view holds and that `hidden` is by name (D4); that `scene.json` is the window's to write and `sceneFileNow` is what main answers from (D3); the name rules; `proposed`; that a view holds a section or an explode. The MCP tools bullet lists `save_view`. Run all suites, commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && pnpm test:e2e
git add -A app CLAUDE.md && git commit -m "Saved views: the view on screen is kept under a name in scene.json, the agent draws and shows one by name and proposes its own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The page of objects

**Files:**
- Create: `app/src/shared/show.ts`, `app/src/main/show/cards.ts`, `app/src/main/show/cards.test.ts`, `app/src/renderer/viewport/thumbnail.ts`, `app/src/renderer/viewport/thumbnail.test.ts`, `app/src/renderer/state/thumbs.ts`, `app/src/renderer/ui/ShowPage.tsx`, `app/e2e/show.spec.ts`
- Modify: `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/{ipc,index}.ts`, `app/src/renderer/viewport/{Viewport,picture,partMesh}.ts`, `app/src/renderer/state/store.ts`, `store.test.ts`, `app/src/renderer/App.tsx`, `app/src/renderer/ui/{ObjectList,ViewportPane}.tsx`, `app/src/renderer/env.d.ts`, `styles/app.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `ObjectInfo`, `BuildState`, `unmetDimensions`, `standingOf` (`shared/dimension.ts`), `sanitiseMarksFile` (`main/marks/file.ts`), `writeFileAtomic`, `fitCamera`, `viewDirection`, `DEFAULT_FOV` (`viewport/views.ts`), `buildPart`, `colorsByName` (palette).
- Produces: `ObjectCard` (Shared contracts) and:

```ts
// main/show/cards.ts
export const THUMB_PNG = 'thumb.png'
export const THUMB_JSON = 'thumb.json'
export const THUMB_MAX_BYTES = 512 * 1024
export interface CardDeps {
  objects(): ObjectInfo[]
  opened(objectId: string): boolean
  build(objectId: string): BuildState | undefined
  /** The marks of an object opened in this run, from the store. */
  marks(objectId: string): Promise<Mark[]>
  session(objectId: string): SessionStatus | null
  readFile(path: string): Promise<string>                // rejects when there is none
  mtimeMs(path: string): Promise<number | null>          // null when there is none
}
export function cardsOf(deps: CardDeps): Promise<ObjectCard[]>
/** The marks of a folder as its file has them, read and nothing else: no file is set aside, nothing is written. Null when it cannot be read as one. */
export function peekMarks(text: string): Mark[] | null
/** What a `thumb.json` says, against the model file as it is now. Null for what is not one. */
export function thumbOf(meta: unknown, modelMtimeMs: number | null): ObjectCard['thumb']
/** Why bytes the window handed over are not kept as a picture, or null: a PNG, 480 × 360, at most `THUMB_MAX_BYTES`. */
export function thumbnailRefusal(png: Uint8Array): string | null
export function saveThumbnail(dir: string, png: Uint8Array, of: { layout: string; parts: number; model: string; modelMtimeMs: number | null }, now: Date): Promise<void>
// shared/bridge.ts
show: {
  cards(): Promise<ObjectCard[]>
  /** The PNG on file, or null. */
  thumbnail(objectId: string): Promise<ArrayBuffer | null>
  /** A picture of the build `revision` of an object opened in this run. Dropped without a word when that is no longer its last build, or the bytes are no such picture. */
  saveThumbnail(objectId: string, revision: number, png: Uint8Array, of: { layout: string; parts: number }): void
  /** Something a card says may have changed. */
  onChanged(cb: () => void): () => void
}
// renderer/viewport/thumbnail.ts
export const THUMB_WIDTH = 480
export const THUMB_HEIGHT = 360
/** The layout a thumbnail is of: `assembly` when the build has it, else its first. */
export function thumbnailLayout(layouts: readonly string[]): string | null
export class ThumbnailMaker {
  constructor(renderer: THREE.WebGLRenderer)
  /** A picture of the parts of one layout of any scene, seen from the standard iso view, on a clear ground: parts and their edges in the palette's colours, nothing else. Null for a scene with no part in that layout. Leaves the renderer as it found it. */
  render(scene: Scene, blob: ArrayBuffer): Promise<{ png: Uint8Array; layout: string; parts: number } | null>
  dispose(): void
}
// renderer/viewport/partMesh.ts
export function buildPart(part: Part, blob: ArrayBuffer, opts?: { tree?: boolean }): BuiltPart      // tree false: no bounds tree; such a part is never picked
// renderer/viewport/picture.ts
/** A drawn target as PNG bytes: through the encoder (sRGB, rows the right way up), read back, and written by an OffscreenCanvas. What `PictureMaker.render` does at its end, lifted out. `clear` keeps the alpha the target has. */
export function pngOf(renderer: THREE.WebGLRenderer, encoder: Encoder, drawn: THREE.WebGLRenderTarget, encoded: THREE.WebGLRenderTarget, opts?: { alpha?: boolean }): Promise<Uint8Array>
export class Encoder { /* as now, exported */ }
// renderer/viewport/Viewport.ts
thumbnail(scene: Scene, blob: ArrayBuffer): ReturnType<ThumbnailMaker['render']>
// renderer/state/store.ts
page: 'object' | 'objects'
actions.showPage(page: 'object' | 'objects'): void
```

Behaviour:
- **When a thumbnail is made** (D5). `state/thumbs.ts` `connectThumbs(viewport)` listens to `window.torno.object.onScene` (every build of every object opened in this run arrives there with its blob: `ipc.ts:130`), keeps only the latest message per object, and makes them one at a time in an idle callback (`requestIdleCallback`, falling back to `setTimeout 0`): `viewport.thumbnail(scene, blob)`, then `window.torno.show.saveThumbnail(objectId, revision, png, { layout, parts })`. It never opens an object, never asks main for a scene and never starts a build. A scene that was sent again unchanged (same revision as the last one it made a picture of for that object) is skipped.
- **What a thumbnail is.** 480 × 360, the standard iso view fitted to the parts of `thumbnailLayout(scene.layouts)`, perspective, the viewport's own lights, a ground that is clear (alpha 0) so the card's own surface shows in either theme; palette colours by part name (`colorsByName`), edges in `edgeTint`; no marks, no scans, no section, never exploded, whatever the person has on screen. `ThumbnailMaker` keeps one render target pair and builds the parts with `buildPart(part, blob, { tree: false })`, disposing of them after the frame.
- **What main keeps.** `show:saveThumbnail`: only for an object in `ws.opened` whose last good revision is the one named, and bytes `thumbnailRefusal` passes; then `saveThumbnail` writes `thumb.png` and `thumb.json` atomically under `<object>/.torno/` and `show:changed` is broadcast. A picture holds only the parts, so it needs no `.gitignore`.
- **A card** (`cardsOf`): one per object of the workspace, in the list's order. `build` only for an opened object (`error` is the first line of its message, at most 200 characters). `marks`: of an opened object from the store; of another from `peekMarks` of its `marks.json` (a missing file is `{ open: 0, drafts: 0 }`, an unreadable one `null`). `dimensions`: only for an opened object with a revision above 0, from `unmetDimensions` and `standingOf`; otherwise `null`. `thumb`: `thumbOf(JSON.parse(thumb.json), mtime of the model file)`, `behind` when the model file is newer than `modelMtimeMs` or the model's name changed. `session`: the status of its session, or null.
- **`show:changed`** is broadcast, at most once in 200 ms, after a build state, a change of marks, a session status, a thumbnail saved, and a rescan of the workspace.
- **The page** (`ShowPage`, in the viewport region over the viewport, which stays mounted under it and is `inert` meanwhile; `aria-label="Objects of <workspace>"`): a grid of cards, `minmax(240px, 1fr)`. A card is one `button.card[data-object="<id>"]`: the picture (an `img` from a blob URL of `show.thumbnail(id)`, revoked when replaced; with none, the `DatumMark` and `No picture yet: it is made when the object is built here`), the name, then lines in `--text-small`:
  - build: `Built, r3` with the number in `num`; `Building…`; `Failed: <first line>` in `--fail`; `Let go to make room: built again when opened`; for one not opened `Not opened in this run`; a `problem` in place of all of it, in `--muted`.
  - picture: `Picture of 8 Oct, 21:14` and, when `behind`, ` · the model has changed since` in `--warn`.
  - marks: `2 open marks, 1 not sent yet` (nothing for none; `Marks could not be read` for null).
  - dimensions: `1 dimension fails` in `--fail`, `2 not measured`, `3 pass` in `--ok`; for `null` with dimensions on file, nothing (a verdict of no build of this run is none).
  - session: `Session working`, `Session needs you` in `--warn`, `Session idle`.
  A click, or Enter on it, opens the object (`onOpen(id)`) and goes to `page: 'object'`. The page is asked for again on `show.onChanged`.
- **Getting there.** `ObjectList` gets a first row "All objects" (`aria-pressed`), which calls `actions.showPage('objects')`. `actions.setWorkspace` starts on `'objects'` when the workspace has two or more objects, else `'object'`; `actions.openObject` sets `'object'`.

- [ ] **Step 1: Write the failing unit tests.** `app/src/main/show/cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Mark } from '../../shared/marks'
import { type CardDeps, THUMB_MAX_BYTES, cardsOf, peekMarks, thumbOf, thumbnailRefusal } from './cards'

const pin = (id: string, status: Mark['status']): Mark => ({ id, kind: 'pin', author: 'user', note: '', status, anchorState: 'ok', layout: 'assembly', revision: 1, camera: { position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], ortho: true, fov: 35, zoom: 1 }, createdAt: '', anchor: { point: [0, 0, 0] } })
const dimension = (id: string, value: number, measuredRevision?: number): Mark => ({ ...pin(id, 'sent'), kind: 'dimension', measure: 'distance', a: { point: [0, 0, 0] }, b: { point: [0, 0, 6] }, value, expected: 8, ...(measuredRevision ? { measuredRevision } : {}) }) as Mark
const png = (width: number, height: number, bytes = 200): Uint8Array => {
  const made = new Uint8Array(bytes)
  made.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(made.buffer).setUint32(16, width)
  new DataView(made.buffer).setUint32(20, height)
  return made
}

function deps(over: Partial<CardDeps> = {}): CardDeps {
  const files: Record<string, string> = {
    '/ws/b/.torno/marks.json': JSON.stringify({ next: 3, marks: [pin('M1', 'draft'), pin('M2', 'resolved'), dimension('M3', 6)] }),
    '/ws/b/.torno/thumb.json': JSON.stringify({ at: '2026-10-08T21:14:03.000Z', layout: 'assembly', parts: 2, model: 'b.py', modelMtimeMs: 1000 }),
    '/ws/c/.torno/marks.json': '{ not json'
  }
  return {
    objects: () => [
      { id: 'a', name: 'a', dir: '/ws/a', model: 'a.py' },
      { id: 'b', name: 'b', dir: '/ws/b', model: 'b.py' },
      { id: 'c', name: 'c', dir: '/ws/c', model: null, problem: 'no model file in /ws/c' }
    ],
    opened: (id) => id === 'a',
    build: (id) => (id === 'a' ? { objectId: 'a', status: 'failed', revision: 4, stale: true, error: { kind: 'exception', message: 'NameError: name x is not defined\n  File …' } } : undefined),
    marks: async () => [pin('M1', 'sent'), dimension('M2', 6, 4), dimension('M3', 8, 4), dimension('M4', 8, 3)],
    session: (id) => (id === 'a' ? 'working' : null),
    readFile: async (path) => files[path] ?? Promise.reject(new Error('ENOENT')),
    mtimeMs: async (path) => (path === '/ws/b/b.py' ? 2000 : null),
    ...over
  }
}

describe('cardsOf', () => {
  it('says of an object opened here how its build, its marks and its dimensions stand', async () => {
    const [a] = await cardsOf(deps())
    expect(a).toEqual({
      id: 'a', name: 'a', opened: true,
      build: { status: 'failed', revision: 4, stale: true, error: 'NameError: name x is not defined' },
      thumb: null,
      marks: { open: 4, drafts: 0 },
      dimensions: { failing: 1, unmeasured: 1, passing: 1 },
      session: 'working'
    })
  })

  it('says of one not opened only what its files say, and no verdict of a build it has not seen', async () => {
    const [, b] = await cardsOf(deps())
    expect(b).toEqual({ id: 'b', name: 'b', opened: false, thumb: { at: '2026-10-08T21:14:03.000Z', layout: 'assembly', behind: true }, marks: { open: 2, drafts: 1 }, dimensions: null, session: null })
  })

  it('says a marks file could not be read, and carries a problem', async () => {
    const [, , c] = await cardsOf(deps())
    expect(c).toMatchObject({ id: 'c', problem: 'no model file in /ws/c', marks: null, thumb: null })
  })
})

it('reads marks without keeping anything of a file that is not one', () => {
  expect(peekMarks('{ not json')).toBeNull()
  expect(peekMarks(JSON.stringify({ marks: 'none' }))).toBeNull()
  expect(peekMarks(JSON.stringify({ next: 2, marks: [pin('M1', 'draft')] }))).toHaveLength(1)
})

it('takes a picture as behind when the model file is newer, or another', () => {
  const meta = { at: '2026-10-08T21:14:03.000Z', layout: 'print', parts: 1, model: 'a.py', modelMtimeMs: 1000 }
  expect(thumbOf(meta, 1000)).toEqual({ at: meta.at, layout: 'print', behind: false })
  expect(thumbOf(meta, 1000.5)).toEqual({ at: meta.at, layout: 'print', behind: true })
  expect(thumbOf(meta, null)).toEqual({ at: meta.at, layout: 'print', behind: true })
  for (const none of [null, 'x', {}, { ...meta, at: 7 }, { ...meta, layout: '' }]) expect(thumbOf(none, 1000)).toBeNull()
})

it('keeps as a picture only a PNG of the size of one, and not a large one', () => {
  expect(thumbnailRefusal(png(480, 360))).toBeNull()
  expect(thumbnailRefusal(png(4000, 3000))).toBe('not a 480 × 360 picture')
  expect(thumbnailRefusal(new Uint8Array(200))).toBe('not a PNG')
  expect(thumbnailRefusal(png(480, 360, THUMB_MAX_BYTES + 1))).toBe('a picture of more than 512 KB')
})
```

`app/src/renderer/viewport/thumbnail.test.ts`:

```ts
import { expect, it } from 'vitest'
import { thumbnailLayout } from './thumbnail'

it('is of the assembly when there is one, else of the first layout, and of none when there is none', () => {
  expect(thumbnailLayout(['print', 'assembly'])).toBe('assembly')
  expect(thumbnailLayout(['print'])).toBe('print')
  expect(thumbnailLayout([])).toBeNull()
})
```

Add to `store.test.ts`: `setWorkspace` of two objects starts on `page: 'objects'`, of one on `'object'`; `openObject` sets `'object'`; `showPage('objects')` leaves the open object as it is (its id, its selection).

Run: `pnpm -C app exec vitest run src/main/show src/renderer/viewport/thumbnail.test.ts src/renderer/state/store.test.ts` Expected: FAIL.

- [ ] **Step 2: Implement `cards.ts`.** The parts that decide:

```ts
export function peekMarks(text: string): Mark[] | null {
  try {
    return sanitiseMarksFile(JSON.parse(text))?.marks ?? null
  } catch {
    return null
  }
}

export function thumbOf(meta: unknown, modelMtimeMs: number | null): ObjectCard['thumb'] {
  const said = meta as { at?: unknown; layout?: unknown; modelMtimeMs?: unknown } | null
  if (typeof said !== 'object' || said === null || typeof said.at !== 'string' || typeof said.layout !== 'string' || said.layout === '') return null
  const made = typeof said.modelMtimeMs === 'number' ? said.modelMtimeMs : null
  return { at: said.at.slice(0, 40), layout: said.layout.slice(0, 100), behind: made === null || modelMtimeMs === null || modelMtimeMs > made }
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function thumbnailRefusal(png: Uint8Array): string | null {
  if (png.length > THUMB_MAX_BYTES) return 'a picture of more than 512 KB'
  if (png.length < 24 || PNG_HEAD.some((byte, i) => png[i] !== byte)) return 'not a PNG'
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return header.getUint32(16) === 480 && header.getUint32(20) === 360 ? null : 'not a 480 × 360 picture'
}
```

In `cardsOf`, for each object: `opened = deps.opened(id)`; the marks are `await deps.marks(id).catch(() => null)` when opened, else `deps.readFile(join(dir, '.torno', 'marks.json')).then(peekMarks, (e) => (isMissing(e) ? [] : null))` (in the test's fake, a rejection is "missing"); `open` counts those not `resolved`, `drafts` those `draft`; `dimensions` from `unmetDimensions(marks, revision)` and the count of `standingOf(m, revision) === 'pass'` among unresolved dimensions, only when `opened && build && build.revision > 0`. In the first test above: M2 is measured on r4 at 6 against 8 (fails), M3 on r4 at 8 (passes), M4 on r3 (not measured on r4).

- [ ] **Step 3: Implement** `ThumbnailMaker` (its own `THREE.Scene` with a `HemisphereLight` and a `DirectionalLight` as `Viewport` sets them; `fitCamera(boxOf(parts), viewDirection('iso').dir, viewDirection('iso').up, 4 / 3, DEFAULT_FOV, false)`; `renderer.setRenderTarget`, `setClearColor(0x000000, 0)`, one `render`, `pngOf(…, { alpha: true })`, then the renderer's target, clear colour and clipping planes put back), `pngOf` and the exported `Encoder` in `picture.ts` (`PictureMaker.render` now ends with `pngOf`), `buildPart`'s option, `Viewport.thumbnail`, `connectThumbs` (called in `ViewportPane.connect`, undone in its return), the bridge and the three IPC handlers, `ShowPage`, the store's `page`. `window.__tornoTest` gains `thumbnail: () => viewport.thumbnail(store.getState().scene!, lastBlob)` only if a test needs it: the e2e below reads the file main wrote instead.

Run the command of Step 1 and `pnpm -C app typecheck`. Expected: PASS.

- [ ] **Step 4: Write the e2e test.** `app/e2e/show.spec.ts`:

```ts
test('the page of objects shows a card each, builds nothing, and opens one with a click', async () => {
  // A workspace of several objects starts on the page.
  await expect(page.locator('.card')).toHaveCount((await state()).workspace!.objects.length)
  await expect(page.locator('.card[data-object="hollow"]')).toContainText('Not opened in this run')
  await expect(page.locator('.card[data-object="hollow"]')).toContainText('No picture yet')
  // Looking at the page built nothing.
  expect(await app.evaluate(() => (globalThis as unknown as { __tornoMain: { opened(): string[] } }).__tornoMain.opened())).toEqual([])
  await page.locator('.card[data-object="hollow"]').click()
  await expect.poll(async () => (await state()).build?.status).toBe('ok')
  // Its picture is made from that build, without anything more being asked of the kernel.
  const thumb = join(root, 'hollow', '.torno', 'thumb.png')
  await expect.poll(() => existsSync(thumb)).toBe(true)
  const bytes = readFileSync(thumb)
  expect([...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([480, 360])
  expect(JSON.parse(readFileSync(join(root, 'hollow', '.torno', 'thumb.json'), 'utf8'))).toMatchObject({ layout: 'assembly', parts: 2, model: 'hollow.py' })
  await page.getByRole('button', { name: 'All objects' }).click()
  const card = page.locator('.card[data-object="hollow"]')
  await expect(card).toContainText('Built, r1')
  await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 480)
})

test('a card says when its picture is older than the model, and a second object gets its picture while the first is shown', async () => {
  await page.locator('.card[data-object="plain"]').click()
  await expect.poll(async () => (await state()).build?.status).toBe('ok')
  await expect.poll(() => existsSync(join(root, 'plain', '.torno', 'thumb.png'))).toBe(true)
  // hollow is still watched: saved again, it is built and pictured while plain is on screen.
  const before = statSync(join(root, 'hollow', '.torno', 'thumb.png')).mtimeMs
  appendFileSync(join(root, 'hollow', 'hollow.py'), '\n# touched\n')
  await expect.poll(() => statSync(join(root, 'hollow', '.torno', 'thumb.png')).mtimeMs, { timeout: 20_000 }).toBeGreaterThan(before)
  expect((await state()).objectId).toBe('plain')
  // A picture older than its model says so.
  const meta = join(root, 'hollow', '.torno', 'thumb.json')
  writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), modelMtimeMs: 1 }))
  await page.getByRole('button', { name: 'All objects' }).click()
  await expect(page.locator('.card[data-object="hollow"]')).toContainText('the model has changed since')
})
```

(`__tornoMain.opened` is added to `testHooks`: `() => [...(current?.opened ?? [])]`, through a getter `openedObjects()` exported by `ipc.ts`.)

Run: `pnpm build && pnpm -C app exec playwright test e2e/show.spec.ts` Expected: PASS. The other specs open an object by its row in the list, which is still there beside the page: run `pnpm test:e2e` and fix any that waited for the viewport before choosing an object.

- [ ] **Step 5: `CLAUDE.md`** gains `## The page of objects`: when a thumbnail is made and by what (D5: never a build for a picture), what it holds, that main keeps only a 480 × 360 PNG of an opened object's last build, `peekMarks` (reads, never sets aside), and that a card of an object not built in this run has no verdicts. Commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && pnpm test:e2e
git add -A app CLAUDE.md && git commit -m "The page of objects: a card each with a picture of its last build, how it stands and what is open on it; nothing is built for a card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Export to one HTML file

**Files:**
- Create: `app/src/shared/exportdata.ts`, `exportdata.test.ts`, `app/src/shared/palette.ts` (moved from `renderer/viewport/palette.ts`, with its test), `app/src/main/export/{build,decimate,html,save}.ts`, `app/src/main/export/{build,decimate,html}.test.ts`, `app/src/main/raw.d.ts`, `app/src/export/page.css`, `app/src/export/page.test.ts`, `app/src/export/viewer/{main,model,overlay,panel}.ts`, `app/scripts/build-viewer.mjs`, `app/src/renderer/ui/ExportSheet.tsx`, `app/e2e/export.spec.ts`
- Modify: `app/package.json`, `scripts/torno`, `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/{ipc,index}.ts`, `app/src/renderer/viewport/{Viewport,thumbnail,sectionDrawing}.ts` and whatever imports `./palette`, `app/src/renderer/ui/{ShowPage,ViewBar}.tsx`, `styles/app.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `Scene`, `Part`, `bufView` (`shared/scene.ts`), `SavedView`, `ExplodeState`, `explodeOffsets`, `sceneFileNow` (Task 3), `parseScanMesh`, `ScanInfo` (`shared/scans.ts`), `dimensionText` (`shared/dimension.ts`), `Builds.scene(id)`.
- Produces: everything under "The exported file" in Shared contracts, and:

```ts
// main/export/build.ts
export interface ExportRequest { objects: string[]; marks: boolean; /** `<objectId>/<scanId>` of each scan the person ticked. */ scans: string[]; title?: string }
export interface ExportDeps {
  object(objectId: string): ObjectInfo | undefined
  /** The last good build of this run, with its blob; undefined for an object not built in it. */
  last(objectId: string): { revision: number; scene: Scene; blob: Buffer } | undefined
  sceneFile(objectId: string): Promise<SceneFile>
  marks(objectId: string): Promise<Mark[]>
  scans(objectId: string): Promise<ScanInfo[]>
  scanMesh(objectId: string, id: string): Promise<Buffer>
  now(): Date
  /** For tests: other limits than `EXPORT_BUDGET` and `EXPORT_MOST`. */
  budget?: number
  most?: number
}
export const EXPORT_BUDGET = 12 * 1024 * 1024
export const EXPORT_MOST = 64 * 1024 * 1024
export const SCAN_TRIANGLES = [60_000, 30_000, 15_000] as const
export interface ExportPlan {
  objects: Array<{ id: string; exportable: boolean; why?: string; revision?: number; triangles?: number; scans: Array<{ id: string; name: string; triangles: number }> }>
  /** What the file would weigh, and what was cut or left out to keep it under the budget, a sentence each. */
  bytes: number
  dropped: string[]
  over: boolean
}
export function exportData(deps: ExportDeps, req: ExportRequest, scanTriangles?: Record<string, number | null>): Promise<ExportData>
/** The data and the page for a request, with scans cut until the file is under the budget (D7). Rejects above `EXPORT_MOST`, and when no object named can be exported. */
export function exportFile(deps: ExportDeps, req: ExportRequest, assets: PageAssets): Promise<{ html: string; bytes: number; dropped: string[]; over: boolean }>
/** What `exportFile` would write, without the page: which objects can be exported, what it would weigh and what would be cut. Never rejects for an object that cannot be exported: it says so of it. */
export function exportPlan(deps: ExportDeps, req: ExportRequest, assets: PageAssets): Promise<ExportPlan>
// main/export/decimate.ts
export interface ScanArrays { positions: Float32Array; colours: Uint8Array | null /* r g b a per vertex */; triangles: Uint32Array }
/** At most `most` triangles, by clustering vertices on a grid that is coarsened until it is so; a scan already under it is returned as it is. */
export function clusterScan(scan: ScanArrays, most: number): ScanArrays
// main/export/html.ts
export interface PageAssets { viewer: string; css: string; fonts: Array<{ family: string; weight: number; woff2: Uint8Array }> }
export function exportHtml(data: ExportData, assets: PageAssets): string
export function loadAssets(): Promise<PageAssets>          // out/viewer/viewer.js, src/export/page.css (?raw), the three woff2 files
// main/export/save.ts
export const EXPORTS = 'exports'
export function defaultExportPath(dir: string, name: string, revision: number): string     // <dir>/.torno/exports/<name>-r<revision>.html
/** Makes `<dir>/.torno/exports/` with a `.gitignore` of `*` (written once, never again), so the dialog can open there. */
export function prepareExports(dir: string): Promise<string>
/** Writes the page to the path the person chose: that one file, with no temporary file beside it. */
export function writeExport(path: string, html: string): Promise<void>
// shared/bridge.ts
export: {
  plan(req: ExportRequest): Promise<ExportPlan>
  /** Asks where to save (under test: `__tornoMain.pickSave`), writes the file, and says where; null when the dialog was cancelled. */
  save(req: ExportRequest): Promise<{ path: string; bytes: number; dropped: string[] } | null>
}
// The page's own test hook, always there (it costs nothing and lets the file be checked wherever it is opened):
window.__tornoExport: {
  state(): { object: string; layout: string; parts: Array<{ name: string; visible: boolean; offset: Vec3 }>; explode: ExplodeState; section: SectionPlane | null; marks: boolean; theme: 'light' | 'dark'; views: string[]; scans: Array<{ id: string; visible: boolean }> }
  setObject(id: string): void
  setLayout(name: string): void
  setPart(name: string, visible: boolean): void
  setExplode(amount: number, axis?: ExplodeState['axis']): void
  setSection(axis: 'x' | 'y' | 'z' | null, t?: number): void
  applyView(name: string): boolean
  setMarks(on: boolean): void
  setTheme(theme: 'light' | 'dark'): void
  /** The colour drawn at a point of the canvas, in fractions of it: [r, g, b, a], after a frame drawn for the asking. */
  pixel(fx: number, fy: number): [number, number, number, number]
  ground(): [number, number, number]
}
```

Behaviour:
- **What is exported** is the last good build of this run of each object named, from `Builds.scene(id)`: its parts in every layout, with each layer's colour, opacity and whether it is switched on from the object's scene file (`sceneFileNow`; the palette's colour where the file names none), its explode per layout, its saved views (the agent's proposals not kept are left out), and its layout on screen. An object not built in this run is not exportable: `why` is `Open it first: torno exports the last build of this run`. Nothing is built for an export.
- **Meshes** are packed by `packMesh` and deflated with `zlib.deflateSync(bytes, { level: 9 })` (E2: about 13 bytes a triangle), keyed by the part's `hash`, so a shape that is in two layouts is in the file once.
- **Marks**, only with `marks: true`: every mark that is not a region and not `orphaned`, as an `ExportMark`: `at` is the first of `markPoints(mark)` and `line` all of them for an arrow, a stroke or a dimension (`markPoints` is a pure function of `viewport/marks/markObjects.ts:310`: it moves to `shared/marks.ts`, and `markObjects.ts` imports it from there, so that main can use it), `text` for a dimension `dimensionText(mark, revision)` (a value only when measured on the exported revision), `part` the part of its first anchor (the page moves it with that part when exploded, and hides a dimension between two parts then, as torno does). Notes are text and are set with `textContent` in the page, never as HTML.
- **Scans**, only those named in `req.scans`: read with `parseScanMesh`, reduced by `clusterScan` to 60,000 triangles, positions quantised to `u16` in the scan's box, a colour per vertex as `u8 × 3` when it has colours, triangles `u16` or `u32`, deflated together; `placed` holds the transform of each layout it is aligned in (it is drawn only there). Its `source.path` is not in the file: only its id and its name.
- **Nothing of this machine**: no absolute path, no `dir`, no `source`, no session id, no user name. `ExportObject.id` and `name` are the folder's name.
- **The budget** (D7). `exportFile` builds the page; while it is over `EXPORT_BUDGET` and a scan can still be cut, the largest scan goes to the next of `SCAN_TRIANGLES`, then out (`dropped` gains `S1 of airbox reduced to 30,000 triangles` or `S1 of airbox left out`). Parts are never reduced. Still over: `over: true`, and the sheet says the size; above `EXPORT_MOST` it rejects with `The export would be 71 MB: more than the 64 MB torno writes in one file. Export fewer objects.`
- **The page** (D10, `app/src/export/viewer/`): a canvas that fills the window, a panel (a drawer from the bottom under 640 px of width) with, in order: the object's name and `r3` (a `select` of objects when there are several), layouts as buttons, the parts with a checkbox and their colour, "Explode" (a range, and the axis buttons), "Section" (off, X, Y, Z, a range across the layout's box, "Flip"), the saved views as chips, "Marks" (a checkbox, and under it the list of numbers and notes; a click on one turns the camera to its point), "Scans" (a checkbox and an opacity range per scan, only when the file has any), standard views (Iso, Front, Right, Top), "Fit", and "Light / Dark" (the system's by default). A footer line: `Exported from torno on 9 Oct 2026. Positions are stored to 1/65535 of each part's size; dimensions are those torno measured.` Explode and section are never on at once, as in torno: moving one slider above zero puts the other to rest. Render on demand: a frame is drawn after a change and while the camera moves, never in a loop. Parts keep `explodeOffsets` from `shared/explode.ts` (the same code). No picking, no measuring.
- **The page's look** is `app/src/export/page.css`: the tokens of `tokens.css` it uses, copied by name and value for light and dark (`page.test.ts` holds them equal to `tokens.css`), IBM Plex Sans and Mono from `data:` URLs, sentence case, numbers and refs in the monospace face, user marks in `--user-mark` and agent marks in `--agent-mark` and nothing else in those colours.
- **Build.** `app/scripts/build-viewer.mjs` runs `vite.build` with `configFile: false`, `build.lib = { entry: 'src/export/viewer/main.ts', formats: ['iife'], name: 'tornoViewer', fileName: () => 'viewer.js' }`, `outDir: 'out/viewer'`, `emptyOutDir: true`, `minify: 'esbuild'`, `target: 'es2020'`, and fails when the output holds the text `import(` or is over 900,000 bytes (E2: 561 KB). `app/package.json`: `"build": "electron-vite build && node scripts/build-viewer.mjs"`, `"test:e2e": "electron-vite build && node scripts/build-viewer.mjs && playwright test"`. `scripts/torno` also rebuilds when `out/viewer/viewer.js` is missing or `app/scripts` is newer than the stamp.
- **Saving.** `export:save`: `exportFile`, then the path: under test `opts.pickSave()` (`__tornoMain.pickSave`, `savePicks`), else `dialog.showSaveDialog(win, { title: 'Export', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })`, where `defaultPath` is `defaultExportPath` of the first object exported after `prepareExports(dir)`; for several objects the name is the workspace folder's. A path that does not end in `.html` gets it. `writeExport` is `writeFile(path, html)`: one file, no temporary file, no folder made (a folder that is not there is the dialog's refusal to pick it, or an error said in the sheet).
- **The sheet** (`ExportSheet`, opened by "Export…" in the `ViewBar` for the open object, and by "Export…" on the page of objects with every exportable object ticked): the objects with a checkbox each (one that is not exportable is disabled with its `why`), "Include marks and their notes" (off), and, where an object has scans, one checkbox per scan under the words `A scan may show the real world: a room, a number plate. It is left out unless you tick it, and is then reduced to 60,000 triangles.` (off); the size from `export.plan` in `num` (`about 1.4 MB`), what would be dropped, and "Export". Before `plan` and `save` the sheet has the window save the open object's scene file at once, so the export is of what is on screen. After a save: `Saved to <path>` with the path selectable.

- [ ] **Step 1: Write the failing unit tests.** `app/src/shared/exportdata.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { packMesh, unpackMesh } from './exportdata'

const box = {
  positions: new Float32Array([-20, -15, -2.5, 20, -15, -2.5, 20, 15, -2.5, -20, 15, 2.5, 3.14159, -7.5, 1.25]),
  normals: new Float32Array([0, 0, -1, 0, 0, -1, 0.6, 0.8, 0, -1, 0, 0, 0, 0, 1]),
  triangles: new Uint32Array([0, 2, 1, 0, 3, 2, 1, 2, 4]),
  edges: new Float32Array([-20, -15, -2.5, 20, -15, -2.5, 20, -15, -2.5, 20, 15, -2.5])
}

describe('packMesh', () => {
  it('comes back within a 65535th of the part\'s size, with its triangles to the number', () => {
    const { header, bytes } = packMesh(box)
    expect(header).toMatchObject({ vertices: 5, triangles: 3, segments: 2, wide: false, lo: [-20, -15, -2.5], span: [40, 30, 5] })
    // 5 vertices: 30 bytes of positions, 15 of normals and one to keep the rest even, 18 of indices, 24 of edges.
    expect(bytes).toHaveLength(30 + 16 + 18 + 24)
    const back = unpackMesh(header, bytes)
    expect([...back.triangles]).toEqual([...box.triangles])
    for (let i = 0; i < box.positions.length; i++) expect(Math.abs(back.positions[i] - box.positions[i])).toBeLessThanOrEqual(header.span[i % 3] / 65535 / 2 + 1e-6)
    for (let i = 0; i < box.normals.length; i++) expect(Math.abs(back.normals[i] - box.normals[i])).toBeLessThan(1 / 127)
    for (let i = 0; i < box.edges.length; i++) expect(Math.abs(back.edges[i] - box.edges[i])).toBeLessThanOrEqual(header.span[i % 3] / 65535 / 2 + 1e-6)
  })

  it('uses wide indices above 65,535 vertices, and takes a flat part and an empty one', () => {
    const many = { positions: new Float32Array(65536 * 3), normals: new Float32Array(65536 * 3), triangles: new Uint32Array([0, 1, 65535]), edges: new Float32Array(0) }
    const wide = packMesh(many)
    expect(wide.header.wide).toBe(true)
    expect([...unpackMesh(wide.header, wide.bytes).triangles]).toEqual([0, 1, 65535])
    const none = packMesh({ positions: new Float32Array(0), normals: new Float32Array(0), triangles: new Uint32Array(0), edges: new Float32Array(0) })
    expect(none.header).toMatchObject({ vertices: 0, lo: [0, 0, 0], span: [0, 0, 0] })
    expect(none.bytes).toHaveLength(0)
    // A part with no size along an axis comes back where it was.
    const flat = packMesh({ ...box, positions: new Float32Array([1, 2, 3, 5, 2, 3, 5, 6, 3]), normals: new Float32Array(9), triangles: new Uint32Array([0, 1, 2]), edges: new Float32Array(0) })
    expect(unpackMesh(flat.header, flat.bytes).positions[2]).toBe(3)
  })

  it('refuses bytes that are not of the header\'s counts', () => {
    const { header, bytes } = packMesh(box)
    expect(() => unpackMesh(header, bytes.subarray(0, 40))).toThrow('88 bytes were expected, 40 came')
    expect(() => unpackMesh({ ...header, vertices: 1e9 }, bytes)).toThrow(RangeError)
  })
})
```

`app/src/main/export/decimate.test.ts`:

```ts
import { expect, it } from 'vitest'
import { clusterScan } from './decimate'

/** A flat sheet of n × n squares, two triangles each, 1 mm apart. */
function sheet(n: number, colours = false) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3)
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.set([x, y, 0], (y * (n + 1) + x) * 3)
  const triangles: number[] = []
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x
    triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1)
  }
  return { positions, colours: colours ? new Uint8Array((n + 1) * (n + 1) * 4).fill(200) : null, triangles: new Uint32Array(triangles) }
}

it('leaves a scan that is small enough as it is', () => {
  const small = sheet(10)
  expect(clusterScan(small, 200)).toBe(small)
})

it('cuts a scan to at most what was asked, keeps it where it was, and keeps its colours', () => {
  const cut = clusterScan(sheet(100, true), 2000)                      // 20,000 triangles
  expect(cut.triangles.length / 3).toBeLessThanOrEqual(2000)
  expect(cut.triangles.length / 3).toBeGreaterThan(500)
  expect(cut.colours).toHaveLength((cut.positions.length / 3) * 4)
  expect(cut.colours![0]).toBe(200)
  let [lo, hi] = [Infinity, -Infinity]
  for (let i = 0; i < cut.positions.length; i += 3) [lo, hi] = [Math.min(lo, cut.positions[i]), Math.max(hi, cut.positions[i])]
  expect(lo).toBeLessThan(5)
  expect(hi).toBeGreaterThan(95)
  // No triangle of nothing: its three corners are three vertices.
  for (let i = 0; i < cut.triangles.length; i += 3) expect(new Set(cut.triangles.subarray(i, i + 3)).size).toBe(3)
  expect(Math.max(...cut.triangles)).toBeLessThan(cut.positions.length / 3)
})
```

`app/src/main/export/html.test.ts` (with `data()` making an `ExportData` of one object from a two-part scene built in the test, and `ASSETS = { viewer: 'window.__ran = "</script><b>"', css: 'body{margin:0}', fonts: [{ family: 'IBM Plex Sans', weight: 400, woff2: new Uint8Array([1, 2, 3]) }] }`):

```ts
it('is one file that fetches nothing and closes no script early', () => {
  const html = exportHtml(data({ title: 'a </script> <b>title</b>' }), ASSETS)
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`)
  // Two scripts and no more: the data and the viewer.
  expect(html.match(/<script/g)).toHaveLength(2)
  expect(html.match(/<\/script>/g)).toHaveLength(2)
  expect(html).not.toMatch(/\b(?:src|href)\s*=/)
  expect(html).not.toMatch(/https?:\/\//)
  expect(html).toContain('<title>a &lt;/script&gt; &lt;b&gt;title&lt;/b&gt;</title>')
  expect(html).toContain("url(data:font/woff2;base64,AQID) format('woff2')")
  const json = /<script type="application\/json" id="torno-data">(.*?)<\/script>/s.exec(html)![1]
  expect(JSON.parse(json).title).toBe('a </script> <b>title</b>')
})
```

`app/src/main/export/build.test.ts` (with `deps()` over a scene of `tray` and `lid` in `assembly` and `print` sharing hashes, a blob made by the test, marks and one scan of 100,000 triangles with `source.path: '/home/someone/Downloads/Car.glb'`):

```ts
it('holds each shape once, the views the person has, and nothing of this machine', async () => {
  const data = await exportData(deps(), { objects: ['hollow'], marks: false, scans: [] })
  const [object] = data.objects
  expect(object).toMatchObject({ id: 'hollow', name: 'hollow', revision: 3, layouts: ['assembly', 'print'], layout: 'assembly' })
  expect(object.parts.map((p) => [p.layout, p.name, p.mesh])).toEqual([['assembly', 'tray', 'h-tray'], ['assembly', 'lid', 'h-lid'], ['print', 'tray', 'h-tray'], ['print', 'lid', 'h-lid']])
  expect(Object.keys(object.meshes).sort()).toEqual(['h-lid', 'h-tray'])
  expect(object.parts[1]).toMatchObject({ color: '#aa5500', opacity: 0.4, visible: false })        // from the scene file's layers
  expect(object.views.map((v) => v.name)).toEqual(['Hinge side'])                                    // the proposal that was not kept is left out
  expect(object.marks).toBeUndefined()
  expect(object.scans).toBeUndefined()
  const text = JSON.stringify(data)
  for (const secret of ['/ws/', '/home/', 'Downloads', 'Car.glb', 'conversationId', 'thin wall here']) expect(text).not.toContain(secret)
})

it('holds marks and scans only when asked, a scan reduced and without its source', async () => {
  const data = await exportData(deps(), { objects: ['hollow'], marks: true, scans: ['hollow/S1'] })
  const [object] = data.objects
  expect(object.marks!.map((m) => [m.id, m.kind, m.part, m.text])).toEqual([['M1', 'pin', 'lid', undefined], ['M2', 'dimension', 'tray', '6 mm']])
  expect(object.marks![0].note).toBe('thin wall here')
  expect(object.scans![0]).toMatchObject({ id: 'S1', name: 'Car.glb', reducedFrom: 100_000, placed: { assembly: { s: 1 } } })
  expect(object.scans![0].triangles).toBeLessThanOrEqual(60_000)
  expect(JSON.stringify(data)).not.toContain('/home/')
})

it('exports only what was built in this run, cuts scans before anything else, and stops at the most it writes', async () => {
  await expect(exportFile(deps(), { objects: ['never-built'], marks: false, scans: [] }, ASSETS)).rejects.toThrow('Open it first: torno exports the last build of this run')
  const tight = await exportFile(deps({ budget: 600_000 }), { objects: ['hollow'], marks: false, scans: ['hollow/S1'] }, ASSETS)
  expect(tight.dropped[0]).toBe('S1 of hollow reduced to 30,000 triangles')
  expect(tight.dropped.at(-1)).toMatch(/^S1 of hollow (reduced to 15,000 triangles|left out)$/)
  await expect(exportFile(deps({ most: 1000 }), { objects: ['hollow'], marks: false, scans: [] }, ASSETS)).rejects.toThrow('more than the')
})
```

`app/src/export/page.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/** `--name: value` of a block of CSS, by name. */
const tokens = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const halves = (css: string): [string, string] => {
  const at = css.indexOf('@media (prefers-color-scheme: dark)')
  return [css.slice(0, at), css.slice(at)]
}

it('uses the tokens of the app, to the value, in light and in dark', () => {
  const app = halves(readFileSync(resolve(__dirname, '../renderer/styles/tokens.css'), 'utf8'))
  const page = halves(readFileSync(resolve(__dirname, 'page.css'), 'utf8'))
  for (const theme of [0, 1]) {
    const [ours, theirs] = [tokens(page[theme]), tokens(app[theme])]
    expect(Object.keys(ours).length).toBeGreaterThan(8)
    for (const [name, value] of Object.entries(ours)) expect([name, value]).toEqual([name, theirs[name]])
  }
  // The page can be switched by hand: the dark values are also under [data-theme="dark"].
  expect(readFileSync(resolve(__dirname, 'page.css'), 'utf8')).toContain(':root[data-theme="dark"]')
})
```

Run: `pnpm -C app exec vitest run src/shared/exportdata.test.ts src/main/export src/export` Expected: FAIL.

- [ ] **Step 2: Implement `shared/exportdata.ts`.**

```ts
const q16 = (value: number, lo: number, span: number): number => (span > 0 ? Math.round(((value - lo) / span) * 65535) : 0)

export function packMesh(mesh: MeshArrays): { header: Omit<PackedMesh, 'data'>; bytes: Uint8Array } {
  const vertices = mesh.positions.length / 3
  const triangles = mesh.triangles.length / 3
  const segments = mesh.edges.length / 6
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  // The edges with the vertices: an edge's point may lie a hair outside the box of the triangles' corners.
  for (const points of [mesh.positions, mesh.edges]) for (let i = 0; i < points.length; i++) {
    if (points[i] < lo[i % 3]) lo[i % 3] = points[i]
    if (points[i] > hi[i % 3]) hi[i % 3] = points[i]
  }
  if (!Number.isFinite(lo[0])) lo.fill(0), hi.fill(0)
  const span = hi.map((h, i) => h - lo[i]) as [number, number, number]
  const wide = vertices > 65535
  const normalBytes = vertices * 3 + ((vertices * 3) & 1)
  const bytes = new Uint8Array(vertices * 6 + normalBytes + triangles * 3 * (wide ? 4 : 2) + segments * 12)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (let i = 0; i < vertices * 3; i++, at += 2) view.setUint16(at, q16(mesh.positions[i], lo[i % 3], span[i % 3]), true)
  for (let i = 0; i < vertices * 3; i++) view.setInt8(at + i, Math.round(Math.min(Math.max(mesh.normals[i] || 0, -1), 1) * 127))
  at += normalBytes
  for (let i = 0; i < triangles * 3; i++, at += wide ? 4 : 2) {
    if (wide) view.setUint32(at, mesh.triangles[i], true)
    else view.setUint16(at, mesh.triangles[i], true)
  }
  for (let i = 0; i < segments * 6; i++, at += 2) view.setUint16(at, q16(mesh.edges[i], lo[i % 3], span[i % 3]), true)
  return { header: { vertices, triangles, segments, lo, span, wide }, bytes }
}

export function unpackMesh(header: Omit<PackedMesh, 'data'>, bytes: Uint8Array): MeshArrays {
  const { vertices, triangles, segments, lo, span, wide } = header
  for (const count of [vertices, triangles, segments]) if (!Number.isSafeInteger(count) || count < 0 || count > 50_000_000) throw new RangeError(`${count} is no count of a mesh`)
  const normalBytes = vertices * 3 + ((vertices * 3) & 1)
  const expected = vertices * 6 + normalBytes + triangles * 3 * (wide ? 4 : 2) + segments * 12
  if (bytes.length !== expected) throw new RangeError(`${expected} bytes were expected, ${bytes.length} came`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const indices = new Uint32Array(triangles * 3)
  const edges = new Float32Array(segments * 6)
  let at = 0
  for (let i = 0; i < positions.length; i++, at += 2) positions[i] = lo[i % 3] + (view.getUint16(at, true) / 65535) * span[i % 3]
  for (let i = 0; i < normals.length; i++) normals[i] = view.getInt8(at + i) / 127
  at += normalBytes
  for (let i = 0; i < indices.length; i++, at += wide ? 4 : 2) indices[i] = wide ? view.getUint32(at, true) : view.getUint16(at, true)
  for (let i = 0; i < edges.length; i++, at += 2) edges[i] = lo[i % 3] + (view.getUint16(at, true) / 65535) * span[i % 3]
  return { positions, normals, triangles: indices, edges }
}
```

- [ ] **Step 3: Implement `decimate.ts`.**

```ts
export function clusterScan(scan: ScanArrays, most: number): ScanArrays {
  if (scan.triangles.length / 3 <= most) return scan
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < scan.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], scan.positions[i])
    hi[i % 3] = Math.max(hi[i % 3], scan.positions[i])
  }
  // From a grid of about `most` cells across its surface, coarser by a quarter until it is few enough.
  let cell = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / Math.sqrt(most * 4), 1e-6)
  for (let round = 0; round < 60; round++, cell *= 1.25) {
    const cut = clustered(scan, lo, cell)
    if (cut.triangles.length / 3 <= most) return cut
  }
  throw new Error('the scan could not be reduced')
}

function clustered(scan: ScanArrays, lo: number[], cell: number): ScanArrays {
  const SIDE = 2 ** 17
  const of = new Map<number, number>()
  const to = new Uint32Array(scan.positions.length / 3)
  const sums: number[] = []
  const tints: number[] = []
  const counts: number[] = []
  for (let v = 0; v < to.length; v++) {
    const [x, y, z] = [0, 1, 2].map((i) => Math.min(Math.floor((scan.positions[v * 3 + i] - lo[i]) / cell), SIDE - 1))
    const key = x + y * SIDE + z * SIDE * SIDE
    let n = of.get(key)
    if (n === undefined) {
      n = counts.length
      of.set(key, n)
      counts.push(0)
      sums.push(0, 0, 0)
      tints.push(0, 0, 0, 0)
    }
    to[v] = n
    counts[n] += 1
    for (let i = 0; i < 3; i++) sums[n * 3 + i] += scan.positions[v * 3 + i]
    if (scan.colours) for (let i = 0; i < 4; i++) tints[n * 4 + i] += scan.colours[v * 4 + i]
  }
  const positions = new Float32Array(counts.length * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = sums[i] / counts[Math.floor(i / 3)]
  const colours = scan.colours ? new Uint8Array(counts.length * 4) : null
  if (colours) for (let i = 0; i < colours.length; i++) colours[i] = Math.round(tints[i] / counts[Math.floor(i / 4)])
  const triangles: number[] = []
  for (let i = 0; i < scan.triangles.length; i += 3) {
    const [a, b, c] = [to[scan.triangles[i]], to[scan.triangles[i + 1]], to[scan.triangles[i + 2]]]
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c)
  }
  return { positions, colours, triangles: new Uint32Array(triangles) }
}
```

- [ ] **Step 4: Implement `html.ts`.**

```ts
const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"

export function exportHtml(data: ExportData, assets: PageAssets): string {
  const fonts = assets.fonts.map((font) => `@font-face{font-family:'${font.family}';font-weight:${font.weight};font-style:normal;src:url(data:font/woff2;base64,${Buffer.from(font.woff2).toString('base64')}) format('woff2')}`).join('\n')
  // In a script element only `</script` and `<!--` matter: every `<` of the data is written as an escape JSON takes.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const viewer = assets.viewer.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
  const style = `${fonts}\n${assets.css}`.replace(/<\/style/gi, '<\\/style')
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="color-scheme" content="light dark">',
    '<meta name="generator" content="torno">',
    `<title>${escapeText(data.title)}</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    '<div id="torno"><canvas id="view"></canvas><div id="overlay"></div><aside id="panel"></aside><noscript>This page draws 3D parts with JavaScript.</noscript></div>',
    `<script type="application/json" id="torno-data">${json}</script>`,
    `<script>${viewer}</script>`,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
```

(The page test's `not.toMatch(/\b(?:src|href)\s*=/)` holds because the font's `src:` in CSS has a colon, not an equals sign.) `loadAssets` reads `join(__dirname, '../viewer/viewer.js')`, imports `page.css?raw` (`app/src/main/raw.d.ts`: `declare module '*?raw' { const text: string; export default text }`), and reads the three woff2 files through `createRequire(__filename).resolve('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2')` and the `600` and `ibm-plex-mono` `400` ones: main's dependencies are left external and load from `node_modules` (`electron.vite.config.ts`).

- [ ] **Step 5: Implement `build.ts`, `save.ts`, the bridge and the IPC handlers, `ExportSheet`.** A part's arrays come from the blob with `bufView` (`vertices`, `normals`, `triangles`, `edges` of `Part.mesh`). `testHooks` gains `pickSave: null as string | null` and `savePicks: 0`.

Run the command of Step 1 and `pnpm -C app typecheck`. Expected: PASS.

- [ ] **Step 6: Write the viewer** (`app/src/export/viewer/`). `main.ts` reads `#torno-data`, inflates every mesh (`new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()`, E3), then `unpackMesh`; with no `DecompressionStream` the panel says `This browser cannot unpack the parts: open the file in a current Chrome, Edge, Firefox or Safari` and nothing is drawn. `model.ts` builds one `Group` per part (a `Mesh` with a `MeshStandardMaterial` of the part's colour and opacity, `polygonOffset` as in `partMesh.ts`, and `LineSegments` in the edge tint), places it by `loc` plus its explode offset, and clips by one `Plane` in `renderer.clippingPlanes` when a section is on (the materials then `DoubleSide`, the back faces darker by `onBeforeCompile`-free means: a second material of the same colour mixed 24 % towards the ink, drawn with `side: BackSide`). `overlay.ts` positions a chip per mark by projecting its point each frame drawn. `panel.ts` builds the controls with `document.createElement` and `textContent` only: no `innerHTML` anywhere in the viewer. `window.__tornoExport` is set at the end of `main.ts`.

Run: `pnpm -C app exec node scripts/build-viewer.mjs` Expected: `out/viewer/viewer.js`, between 500,000 and 900,000 bytes, no `import(`. Then `grep -c "innerHTML" app/out/viewer/viewer.js` Expected: 0 of the viewer's own (three.js does not use it).

- [ ] **Step 7: Write the e2e test.** `app/e2e/export.spec.ts`:

```ts
/** Opens an exported file in a second window that is never shown, and gives a way to ask its page things. */
async function openExport(file: string) {
  const id = await app.evaluate(async ({ BrowserWindow, session }, file) => {
    const requests: string[] = []
    const own = session.fromPartition('export-check')
    own.webRequest.onBeforeRequest((details, done) => {
      if (!details.url.startsWith('file://') && !details.url.startsWith('data:') && !details.url.startsWith('blob:') && !details.url.startsWith('devtools:')) requests.push(details.url)
      done({})
    })
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: own, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(file)
    ;(globalThis as unknown as { __exportRequests: string[] }).__exportRequests = requests
    return win.id
  }, file)
  const ask = <T>(js: string): Promise<T> => app.evaluate(({ BrowserWindow }, [id, js]) => BrowserWindow.fromId(id as number)!.webContents.executeJavaScript(js as string), [id, js] as const) as Promise<T>
  const close = () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.destroy(), id)
  const visible = () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(), id)
  return { ask, close, visible }
}

test('an object is exported to the path that was chosen, and the file opens by itself and answers its controls', async () => {
  await open('hollow')
  await page.getByRole('slider', { name: 'Explode' }).fill('0')
  const out = join(mkdtempSync(join(realpathSync(tmpdir()), 'torno-export-')), 'hollow.html')
  await app.evaluate((_e, path) => void ((globalThis as unknown as { __tornoMain: { pickSave: string | null } }).__tornoMain.pickSave = path), out)
  await page.getByRole('button', { name: 'Export…' }).click()
  await expect(page.getByRole('dialog', { name: 'Export' })).toContainText('about')
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export' }).click()
  await expect(page.getByText(`Saved to ${out}`)).toBeVisible()
  // The default folder was made ready for the dialog, ignored by git; the file went only where it was asked to.
  expect(readFileSync(join(root, 'hollow', '.torno', 'exports', '.gitignore'), 'utf8')).toBe('*\n')
  expect(readdirSync(dirname(out))).toEqual(['hollow.html'])
  const html = readFileSync(out, 'utf8')
  expect(html.length).toBeLessThan(2_000_000)
  expect(html).not.toContain(root)
  expect(html).not.toMatch(/https?:\/\//)

  const file = await openExport(out)
  try {
    expect(await file.visible()).toBe(false)
    await expect.poll(() => file.ask<boolean>('typeof window.__tornoExport === "object"')).toBe(true)
    const state = await file.ask<{ object: string; layout: string; parts: Array<{ name: string; visible: boolean }> }>('window.__tornoExport.state()')
    expect(state).toMatchObject({ object: 'hollow', layout: 'assembly', parts: [{ name: 'tub', visible: true }, { name: 'lid', visible: true }] })
    const ground = await file.ask<number[]>('window.__tornoExport.ground()')
    const centre = await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')
    expect(centre.slice(0, 3)).not.toEqual(ground)
    // Switched off, nothing is drawn there.
    await file.ask('window.__tornoExport.setPart("tub", false); window.__tornoExport.setPart("lid", false)')
    expect((await file.ask<number[]>('window.__tornoExport.pixel(0.4, 0.5)')).slice(0, 3)).toEqual(ground)
    await file.ask('window.__tornoExport.setPart("tub", true); window.__tornoExport.setPart("lid", true)')
    // Exploded, the lid is drawn somewhere else; a section puts the parts together again.
    await file.ask('window.__tornoExport.setExplode(1, "z")')
    const apart = await file.ask<{ parts: Array<{ name: string; offset: number[] }>; section: unknown }>('window.__tornoExport.state()')
    expect(apart.parts.find((p) => p.name === 'lid')!.offset[2]).toBeGreaterThan(1)
    await file.ask('window.__tornoExport.setSection("z", 0.5)')
    const cut = await file.ask<{ explode: { amount: number }; section: unknown }>('window.__tornoExport.state()')
    expect(cut.explode.amount).toBe(0)
    expect(cut.section).not.toBeNull()
    // The other layout, and the dark theme.
    await file.ask('window.__tornoExport.setSection(null); window.__tornoExport.setLayout("print"); window.__tornoExport.setTheme("dark")')
    expect(await file.ask<{ layout: string; theme: string }>('window.__tornoExport.state()')).toMatchObject({ layout: 'print', theme: 'dark' })
    expect(await file.ask<number[]>('window.__tornoExport.ground()')).not.toEqual(ground)
    // It asked for nothing but itself.
    expect(await app.evaluate(() => (globalThis as unknown as { __exportRequests: string[] }).__exportRequests)).toEqual([])
  } finally {
    await file.close()
  }
})

test('a cancelled dialog writes nothing, and marks are in the file only when ticked', async () => {
  await app.evaluate(() => void ((globalThis as unknown as { __tornoMain: { pickSave: string | null } }).__tornoMain.pickSave = null))
  await page.getByRole('button', { name: 'Export…' }).click()
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export' }).click()
  await expect(page.getByText('Nothing was saved')).toBeVisible()
  expect(readdirSync(join(root, 'hollow', '.torno', 'exports'))).toEqual(['.gitignore'])
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/export.spec.ts` Expected: PASS.

- [ ] **Step 8: `CLAUDE.md`** gains `## Export`: what is in a file and what never is (a scan unless ticked, a path of this machine, a proposal not kept); `packMesh` and its error bound; the budget and the order of cutting (D7); the one write outside `.torno/`; that the viewer is `src/export/viewer`, built by `scripts/build-viewer.mjs` into `out/viewer/viewer.js`, with no `innerHTML`; the page's policy; `window.__tornoExport`. Global Constraints gains the sentence of the save dialog. Commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && pnpm test:e2e
git add -A app scripts/torno CLAUDE.md && git commit -m "Export: one HTML file per object or for several, with its own viewer, that fetches nothing; scans only when ticked, and reduced

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A second agent, and agents without hooks

**Files:**
- Create: `app/src/main/sessions/copilot.ts`, `copilot.test.ts`, `app/src/main/sessions/choice.ts`, `choice.test.ts`, `app/src/main/sessions/sendMarks.ts`, `sendMarks.test.ts`, `app/src/renderer/ui/AgentPicker.tsx`, `app/e2e/agents.spec.ts`
- Modify: `app/src/main/sessions/{adapter,claude,manager,status}.ts`, `claude.test.ts`, `manager.itest.ts`, `app/src/main/{prompt,context,index,ipc}.ts`, `prompt.test.ts`, `context.test.ts`, `app/test/fake-agent.mjs`, `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/renderer/state/store.ts`, `app/src/renderer/ui/SessionPane.tsx`, `styles/app.css`, `README.md` (the environment table), `CLAUDE.md`

**Interfaces:**
- Consumes: `Sessions` (`manager.ts`), `contextFor`, `PromptContext` (`context.ts`), `writeFileAtomic`, `MarkStore.markSent`.
- Produces: everything under "Agents" in Shared contracts, and:

```ts
// main/prompt.ts
/** The system prompt, with torno's tools named as an agent's client names them. */
export function systemPrompt(toolName: (tool: string) => string): string
export const SYSTEM_PROMPT: string                                   // systemPrompt((tool) => `mcp__torno__${tool}`): the text of today, to the letter
/** Added for an agent that posts no hooks. */
export const NO_HOOKS_PROMPT: string
// main/context.ts
contextFor(deps, objectId, marks?, opts?: { fresh?: boolean; scans?: readonly ScanInfo[]; toolName?: (tool: string) => string }): PromptContext
// main/sessions/copilot.ts
export function copilotAdapter(agentCmd?: string): AgentAdapter
// main/sessions/claude.ts
export function claudeAdapter(agentCmd?: string): AgentAdapter          // gains label, command, hooks: true, toolName
// main/sessions/choice.ts
export function loadAgentChoice(dir: string): Promise<AgentId>           // 'claude' for no file, a file that is not one, or an agent that is not known
export function saveAgentChoice(dir: string, agent: AgentId): Promise<void>
// main/sessions/sendMarks.ts
export const PROMPT_FILE = 'prompt.md'
/** The one line that is pasted: `torno: 2 new marks (M4, M5) and the build status are in .torno/prompt.md. Read it first.` */
export function sendLine(markIds: readonly string[]): string
/** What `.torno/prompt.md` holds: when it was written, then the context. */
export function promptFile(context: string, at: Date): string
// main/sessions/manager.ts
constructor(deps: { /* as now, but */ adapterFor: (obj: ObjectInfo) => AgentAdapter | Promise<AgentAdapter>; systemPromptFor: (adapter: AgentAdapter) => string })
start(obj, opts): Promise<{ sessionId: string; cols: number; rows: number; status: SessionStatus }>     // now a promise: the choice is read from the disk
sendMarks(sessionId: string): Promise<{ marks: string[]; line: string }>
agentOf(sessionId: string): AgentId | undefined
resumable(obj: ObjectInfo, agent: AgentId): boolean      // a conversation of that agent's is on file
```

Behaviour:
- **Claude Code** is as it is: the same arguments, to the letter (`claude.test.ts` and `manager.itest.ts` pin them). `hooks: true`, `toolName: (tool) => `mcp__torno__${tool}``.
- **Copilot CLI** (E1). Command `copilot`. Arguments: `--session-id <conversationId>` (the help: "Resume an existing session or task by ID, or set the UUID for a new session": the same flag starts and resumes), `--additional-mcp-config <json>` with `{"mcpServers":{"torno":{"type":"http","url":"<mcpUrl>","tools":["*"]}}}`, `--allow-tool=torno`, `--no-auto-update`. Environment: `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<agentDir>`. Files: `AGENTS.md` = `systemPrompt(toolName)` + two newlines + `NO_HOOKS_PROMPT`. `hooks: false`. `toolName: (tool) => `the torno tool ${tool}`` (what Copilot shows the model as a tool's name is not in its help: the prompt names the server and the tool in words).
- **`NO_HOOKS_PROMPT`**: `torno cannot add to your prompts in this CLI. When the user sends a line that begins with "torno:", read the file .torno/prompt.md in this folder before anything else: it holds the build status, what is on their screen and the marks they have just made. .torno/state.md always holds the build, the parts and every open mark as text. Read these two files only; never write in .torno/.`
- **`TORNO_AGENT_CMD`** replaces the command of whichever adapter is chosen, as it does now for Claude Code: that is how every test runs the stand-in with Copilot's arguments.
- **Starting.** `Sessions.start` asks `adapterFor(obj)` (main: `adapters(process.env.TORNO_AGENT_CMD)[await loadAgentChoice(obj.dir)]`), makes `agentDir` (`<dir>/.torno/agent`) and writes `launch.files` into it atomically before the PTY is spawned, and passes `launch.env`. `storedConversation(dir, agent)` answers only when the file's `agent` is the adapter's (a file without the key is Claude Code's): choosing another agent never resumes the other's conversation. For an adapter with hooks nothing else changes.
- **Without hooks.** The status goes `starting` → `idle` on the first output and stays there until the exit: `SessionPane` shows `Running` for `idle` when `hooks` is false, and under the header the line `This agent is not told with each prompt: use "Send marks".` The conversation is written to `session.json` the first time a `\r` is written to the PTY (the person sent something: there is something to resume). `/hooks/<session>/…` answers 404 for such a session.
- **Send marks.** `Sessions.sendMarks(sessionId)`: the context of the object (`contextFor(…, { fresh: false, toolName: adapter.toolName })`); an empty one rejects with `Nothing to send: nothing has been built here yet`; else `<dir>/.torno/prompt.md` is written atomically with `promptFile(text, now)`, `sendLine(sentMarkIds)` is pasted with `insert` (bracketed, not sent), and the session remembers `pending = sentMarkIds`. The next `\r` written to that session's PTY while `pending` is set calls `onDelivered(objectId, pending)` and clears it (D9); the exit of the session clears it without delivering. A second "Send marks" before the Enter replaces the file, pastes nothing more (the line is still at the cursor) and replaces `pending`. For a session whose adapter has hooks it rejects: `This agent is told with every prompt`.
- **Choosing** (`AgentPicker`, in the session header where "New session" is, shown when there is no session running in the object): a `select` (`aria-label="Agent"`) of `session.agents()`: `Claude Code`, `Copilot CLI`; one that is not installed is disabled and reads `Copilot CLI (not found on PATH)`. A change calls `session.chooseAgent`, which writes `agent.json`; main refuses while a session runs there (`End the session first`). With a session running, the header names the agent in `--muted` beside the status.
- **The header** with a hookless agent running gains the button "Send marks" with the count of drafts in `num` (`Send marks (2)`; `Send status` when there is none), `title="Writes .torno/prompt.md and puts a line at the cursor for you to send"`.
- **The stand-in** (`app/test/fake-agent.mjs`): its `env` line also lists `COPILOT*` names; a new line `file <path>` prints `file: <the first 200 characters of that file, on one line>` or `file: none`; `args` prints `READY`'s JSON again. Nothing else changes: with Copilot's arguments it has no `--settings`, so `hook` prints `no UserPromptSubmit hook`, as an agent without hooks would be.

- [ ] **Step 1: Write the failing unit tests.** `app/src/main/sessions/copilot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { NO_HOOKS_PROMPT, SYSTEM_PROMPT, systemPrompt } from '../prompt'
import { adapters } from './adapter'
import { copilotAdapter } from './copilot'

const ctx = { sessionId: 's1', conversationId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2', resume: false, cwd: '/ws/hollow', mcpUrl: 'http://127.0.0.1:4100/mcp/hollow', hookUrl: (event: string) => `http://127.0.0.1:4100/hooks/s1/${event}`, agentDir: '/ws/hollow/.torno/agent' }

describe('copilotAdapter', () => {
  it('starts Copilot CLI with torno\'s server for this session only, allowed, and its instructions in a folder of torno\'s', () => {
    const launch = copilotAdapter().launch(ctx)
    expect(launch.command).toBe('copilot')
    expect(launch.args).toEqual([
      '--session-id', '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
      '--additional-mcp-config', '{"mcpServers":{"torno":{"type":"http","url":"http://127.0.0.1:4100/mcp/hollow","tools":["*"]}}}',
      '--allow-tool=torno',
      '--no-auto-update'
    ])
    expect(launch.env).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/ws/hollow/.torno/agent' })
    expect(Object.keys(launch.files!)).toEqual(['AGENTS.md'])
    expect(launch.files!['AGENTS.md']).toContain('the torno tool scene')
    expect(launch.files!['AGENTS.md']).not.toContain('mcp__torno__')
    expect(launch.files!['AGENTS.md'].endsWith(NO_HOOKS_PROMPT)).toBe(true)
    // No hook is passed: it has none to pass.
    expect(launch.args.join(' ')).not.toContain('/hooks/')
  })

  it('resumes with the same flag, and runs the command it is given in its place', () => {
    expect(copilotAdapter().launch({ ...ctx, resume: true }).args.slice(0, 2)).toEqual(['--session-id', ctx.conversationId])
    const fake = copilotAdapter('node /repo/app/test/fake-agent.mjs').launch(ctx)
    expect([fake.command, fake.args[0], fake.args[1]]).toEqual(['node', '/repo/app/test/fake-agent.mjs', '--session-id'])
  })

  it('says of itself what the window needs to know', () => {
    const all = adapters()
    expect(Object.keys(all)).toEqual(['claude', 'copilot'])
    expect([all.claude.label, all.claude.hooks, all.claude.command]).toEqual(['Claude Code', true, 'claude'])
    expect([all.copilot.label, all.copilot.hooks, all.copilot.command]).toEqual(['Copilot CLI', false, 'copilot'])
  })
})

it('names the tools as each client does, and is the same text for Claude Code as before', () => {
  expect(systemPrompt((tool) => `mcp__torno__${tool}`)).toBe(SYSTEM_PROMPT)
  expect(SYSTEM_PROMPT).toContain('mcp__torno__scene reports the build status')
  expect(systemPrompt((tool) => `the torno tool ${tool}`)).toContain('the torno tool scene reports the build status')
  expect(NO_HOOKS_PROMPT).toContain('.torno/prompt.md')
})
```

`app/src/main/sessions/choice.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadAgentChoice, saveAgentChoice } from './choice'

it('keeps the agent of an object in .torno/agent.json, and is Claude Code for anything else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torno-choice-'))
  expect(await loadAgentChoice(dir)).toBe('claude')
  await saveAgentChoice(dir, 'copilot')
  expect(JSON.parse(await readFile(join(dir, '.torno', 'agent.json'), 'utf8'))).toEqual({ agent: 'copilot' })
  expect(await loadAgentChoice(dir)).toBe('copilot')
  for (const text of ['{ not json', '{"agent":"gemini"}', '[]', '{"agent":7}']) {
    await mkdir(join(dir, '.torno'), { recursive: true })
    await writeFile(join(dir, '.torno', 'agent.json'), text)
    expect(await loadAgentChoice(dir)).toBe('claude')
  }
})
```

`app/src/main/sessions/sendMarks.test.ts`:

```ts
import { expect, it } from 'vitest'
import { promptFile, sendLine } from './sendMarks'

it('says in one line what the file holds, with no character that could send it', () => {
  expect(sendLine(['M4', 'M5'])).toBe('torno: 2 new marks (M4, M5) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine(['M4'])).toBe('torno: 1 new mark (M4) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine([])).toBe('torno: the build status and the open marks are in .torno/prompt.md. Read it first.')
  expect(sendLine(Array.from({ length: 30 }, (_, i) => `M${i + 1}`))).toBe('torno: 30 new marks (M1, M2, M3, M4, M5, M6, M7, M8 and 22 more) and the build status are in .torno/prompt.md. Read it first.')
  expect(sendLine(['M4'])).not.toMatch(/[\r\n\u001b]/)
})

it('writes the context under the time it was written', () => {
  expect(promptFile('Build ok, r3.\nMarks from the user:', new Date('2026-10-09T21:14:03Z'))).toBe('Written 2026-10-09 21:14:03 UTC by torno, for the prompt that follows it.\n\nBuild ok, r3.\nMarks from the user:\n')
})
```

Add to `app/src/main/sessions/manager.itest.ts` (it starts the stand-in in a temp folder and reads the PTY's output; `started(agent)` there makes a `Sessions` whose `adapterFor` answers the adapter named, over `TORNO_AGENT_CMD`'s stand-in):

```ts
it('starts an agent without hooks with its own arguments, files and variables, and never resumes another agent\'s conversation', async () => {
  const { sessions, obj, output, typed } = await started('copilot')
  const argv = JSON.parse(/READY (.*)/.exec(await output.until('READY'))![1]) as string[]
  expect(argv[0]).toBe('--session-id')
  expect(argv).toContain('--allow-tool=torno')
  expect(argv.join(' ')).not.toContain('--settings')
  expect(readFileSync(join(obj.dir, '.torno', 'agent', 'AGENTS.md'), 'utf8')).toContain('the torno tool scene')
  typed('env\r')
  expect(await output.until('env:')).toContain('COPILOT_CUSTOM_INSTRUCTIONS_DIRS')
  // It sent a line: its conversation can be resumed, by Copilot and by no other.
  expect(JSON.parse(readFileSync(join(obj.dir, '.torno', 'session.json'), 'utf8'))).toMatchObject({ agent: 'copilot', conversationId: argv[1] })
  expect(sessions.resumable(obj, 'copilot')).toBe(true)
  expect(sessions.resumable(obj, 'claude')).toBe(false)
  expect(sessions.current(obj.id)!.status).toBe('idle')
})

it('sends marks through a file and a line, and counts them sent only once the line has gone', async () => {
  const delivered: string[][] = []
  const { sessions, obj, output, typed, sessionId } = await started('copilot', { context: { text: 'Build ok, r3.\nMarks from the user:\nM4 pin on lid/F2', sentMarkIds: ['M4'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
  await output.until('READY')
  const sent = await sessions.sendMarks(sessionId)
  expect(sent).toEqual({ marks: ['M4'], line: 'torno: 1 new mark (M4) and the build status are in .torno/prompt.md. Read it first.' })
  expect(readFileSync(join(obj.dir, '.torno', 'prompt.md'), 'utf8')).toContain('M4 pin on lid/F2')
  // Pasted, not sent: the terminal echoes what was pasted, but the stand-in has been given no line (it answers each with `> `), and the mark is still a draft.
  await new Promise((r) => setTimeout(r, 200))
  expect(output.all()).not.toContain('> ')
  expect(delivered).toEqual([])
  typed('\r')
  // The line it was given, between the marks of a paste.
  expect(await output.until('> ')).toMatch(/> .*torno: 1 new mark \(M4\)/)
  expect(delivered).toEqual([['M4']])
  // Nothing is pending now: another Enter delivers nothing more.
  typed('\r')
  await new Promise((r) => setTimeout(r, 100))
  expect(delivered).toHaveLength(1)
})

it('leaves marks drafts when the session ends before the line is sent, and refuses for an agent that has hooks', async () => {
  const delivered: string[][] = []
  const { sessions, sessionId } = await started('copilot', { context: { text: 'Build ok.', sentMarkIds: ['M1'] }, onDelivered: (_id, marks) => void delivered.push(marks) })
  await sessions.sendMarks(sessionId)
  await sessions.stop(sessionId)
  expect(delivered).toEqual([])
  const claude = await started('claude')
  await expect(claude.sessions.sendMarks(claude.sessionId)).rejects.toThrow('This agent is told with every prompt')
})
```

Run: `pnpm -C app exec vitest run src/main/sessions src/main/prompt.test.ts && pnpm -C app exec vitest run --mode kernel src/main/sessions/manager.itest.ts` Expected: FAIL.

- [ ] **Step 2: Implement.** `sendLine`:

```ts
const MOST_NAMED = 8

export function sendLine(markIds: readonly string[]): string {
  if (markIds.length === 0) return 'torno: the build status and the open marks are in .torno/prompt.md. Read it first.'
  const named = markIds.length > MOST_NAMED ? `${markIds.slice(0, MOST_NAMED).join(', ')} and ${markIds.length - MOST_NAMED} more` : markIds.join(', ')
  return `torno: ${markIds.length} new mark${markIds.length === 1 ? '' : 's'} (${named}) and the build status are in .torno/prompt.md. Read it first.`
}

export function promptFile(context: string, at: Date): string {
  return `Written ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC by torno, for the prompt that follows it.\n\n${context}\n`
}
```

`copilotAdapter`:

```ts
export function copilotAdapter(agentCmd?: string): AgentAdapter {
  const [command = 'copilot', ...before] = (agentCmd ?? '').split(' ').filter(Boolean)
  const toolName = (tool: string): string => `the torno tool ${tool}`
  return {
    id: 'copilot',
    label: 'Copilot CLI',
    command: 'copilot',
    hooks: false,
    toolName,
    launch(ctx) {
      const mcp = { mcpServers: { torno: { type: 'http', url: ctx.mcpUrl, tools: ['*'] } } }
      return {
        command,
        args: [...before, '--session-id', ctx.conversationId, '--additional-mcp-config', JSON.stringify(mcp), '--allow-tool=torno', '--no-auto-update'],
        env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: ctx.agentDir },
        files: { 'AGENTS.md': `${systemPrompt(toolName)}\n\n${NO_HOOKS_PROMPT}` }
      }
    }
  }
}
```

`systemPrompt(toolName)` is today's array with every `mcp__torno__<name>` written `${toolName('<name>')}`; `context.ts` does the same for `MARKS_DATA`, `moreMarks` and `moreDimensions` through `opts.toolName`. In `manager.ts`: `write()` looks for `\r` in the data of a session whose adapter has no hooks (store the conversation once; deliver what is pending); `OWN_VARIABLES` is unchanged (the `COPILOT_*` variables are the person's own, as `CLAUDE_CODE_USE_BEDROCK` is). `session:start` in `ipc.ts` awaits the promise.

Run the commands of Step 1 and `pnpm -C app typecheck`. Expected: PASS.

- [ ] **Step 3: Write the e2e test.** `app/e2e/agents.spec.ts` (harness as `e2e/session.spec.ts`; `term()` reads `window.__tornoTerm.text()`):

```ts
test('the agent is chosen per object and kept; one without hooks is told by "Send marks", and the marks are sent once the line has gone', async () => {
  await open('plain')
  await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('claude')
  // Under test the stand-in is on PATH for every adapter: both can be chosen.
  await page.getByRole('combobox', { name: 'Agent' }).selectOption('copilot')
  await expect.poll(() => existsSync(join(root, 'plain', '.torno', 'agent.json')) && JSON.parse(readFileSync(join(root, 'plain', '.torno', 'agent.json'), 'utf8')).agent).toBe('copilot')
  await page.locator('.session-actions .button-primary').click()                  // the button that starts a new session
  await expect.poll(term).toContain('READY')
  expect(await term()).toContain('--additional-mcp-config')
  await expect(page.locator('.session-status')).toHaveText('Running')
  await expect(page.getByText('This agent is not told with each prompt: use "Send marks".')).toBeVisible()
  // A pin, left with the Pin tool: a click on the plate keeps it, and its note is typed where it opens.
  await page.keyboard.press('p')
  const box = (await page.locator('[data-region="viewport"] canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(async () => (await state()).marks.map((m) => m.status)).toEqual(['draft'])
  await page.keyboard.type('this face')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).marks[0].note).toBe('this face')
  await page.getByRole('button', { name: /^Send marks/ }).click()
  await expect.poll(() => existsSync(join(root, 'plain', '.torno', 'prompt.md'))).toBe(true)
  expect(readFileSync(join(root, 'plain', '.torno', 'prompt.md'), 'utf8')).toContain('this face')
  // The line is at the cursor, not sent: still a draft.
  expect((await state()).marks[0].status).toBe('draft')
  await page.locator('.session-term').click()
  await page.keyboard.press('Enter')
  await expect.poll(term).toMatch(/> .*torno: 1 new mark \(M1\)/)
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
  // Another object is still Claude Code's.
  await open('hollow')
  await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('claude')
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/agents.spec.ts e2e/session.spec.ts e2e/talk.spec.ts` Expected: PASS (the last two are the hooks path, unchanged).

- [ ] **Step 4: What only the owner can check, by hand.** No task and no test runs these. Add the five lines below to `README.md` under a new heading at its end, `## Not yet verified on a visible screen` (Task 9 completes that section and moves it into place):
  - `Copilot CLI: choose it for an object and start a session. Does /mcp list torno with its tools? (If not: the keys of the JSON torno passes to --additional-mcp-config are a guess from the help: "type", "url", "tools".)`
  - `Copilot CLI: does /instructions list .torno/agent/AGENTS.md? (COPILOT_CUSTOM_INSTRUCTIONS_DIRS is documented; that a bare AGENTS.md in such a folder is read is not.)`
  - `Copilot CLI: press "Send marks" with a draft, then Enter: does it read .torno/prompt.md and name the mark?`
  - `Copilot CLI: end the session and resume it: does --session-id <the same id> continue the conversation?`
  - `Claude Code: one prompt after this milestone, to see that the marks still arrive with it (the arguments did not change; the manager did).`

- [ ] **Step 5: `CLAUDE.md`**: the section "Never run the real `claude` CLI from tests" becomes "Never run a real agent CLI from tests" and names `copilot`; a new `## Agents`: what an adapter says (`hooks`, `toolName`, `files`), `.torno/agent/`, `agent.json`, `session.json`'s `agent`, "Send marks" and when its marks are sent (D9), and that no draft is consumed by anything but a `UserPromptSubmit` hook or that Enter. The README's environment table says `TORNO_AGENT_CMD` replaces the command of whichever agent is chosen. Commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && pnpm test:e2e
git add -A app README.md CLAUDE.md && git commit -m "A second agent: Copilot CLI, chosen per object; an agent without hooks is told through .torno/prompt.md and a line the person sends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The first run, and the sheet of keys

**Files:**
- Create: `app/src/shared/keys.ts`, `app/src/shared/keys.test.ts`, `app/src/renderer/ui/Welcome.tsx`, `app/src/renderer/ui/KeySheet.tsx`, `app/e2e/welcome.spec.ts`
- Modify: `app/src/renderer/state/tools.ts`, `app/src/renderer/ui/{ViewBar,ToolPalette,ObjectList,ShowPage}.tsx`, `app/src/renderer/App.tsx`, `app/e2e/boot.spec.ts`, `styles/app.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `ToolName`, `TOOLS`, `GIZMO_MODES` (`state/tools.ts`), `MAIN_VIEWS` (`ui/ViewBar.tsx`), `TYPING` (`ui/typing.ts`).
- Produces:

```ts
// shared/keys.ts — the one table. state/tools.ts and ViewBar take their keys from it; nothing else names a key.
export type KeyGroup = 'Tools' | 'View' | 'With a tool in hand' | 'In a field'
/** Where a key is listened to: anywhere outside a field, or only with that tool in hand (which then has it first). */
export type KeyScope = 'anywhere' | 'shape' | 'section' | 'measure' | 'align' | 'region' | 'field'
export interface KeyRow { keys: string[]; does: string; group: KeyGroup; scope: KeyScope }
export const TOOL_KEYS: ReadonlyArray<{ name: 'select' | 'pin' | 'arrow' | 'draw' | 'shape' | 'section' | 'measure' | 'align' | 'region'; label: string; key: string }>
export const VIEW_KEYS: ReadonlyArray<{ view: 'iso' | 'front' | 'right' | 'top'; label: string; key: string }>
export const GIZMO_KEYS: ReadonlyArray<{ mode: 'translate' | 'rotate' | 'scale'; label: string; key: string }>
export const KEYS: readonly KeyRow[]                    // every row, the three tables above among them
export function cheatSheet(): Array<{ group: KeyGroup; rows: KeyRow[] }>
/** The keys two rows would both answer to: both anywhere, or both of one tool. Empty when the table is sound. */
export function keyClashes(rows?: readonly KeyRow[]): string[]
```

The table, whole (`KEYS` is these rows; `does` is the text of the sheet):

| Group | Keys | Does | Scope |
|---|---|---|---|
| Tools | `V` | Select: click a face, an edge or a part | anywhere |
| Tools | `P` | Pin: click a point and leave a note | anywhere |
| Tools | `A` | Arrow: drag from a point | anywhere |
| Tools | `D` | Draw: a stroke on the surface, or on a locked view | anywhere |
| Tools | `S` | Shape: place a box, a cylinder, a sphere or a plane | anywhere |
| Tools | `X` | Section: cut the parts by a plane | anywhere |
| Tools | `M` | Measure: two clicks, or a double click on a round thing | anywhere |
| Tools | `L` | Align scan | anywhere |
| Tools | `B` | Region of a scan: paint what something is | anywhere |
| View | `1` `2` `3` `4` | Iso, front, right and top view | anywhere |
| View | `F` | Fit the parts in view | anywhere |
| View | `O` | Perspective or orthographic | anywhere |
| View | `E` | Draw the parts apart, or together again | anywhere |
| View | `?` | This sheet | anywhere |
| With a tool in hand | `G` `R` `T` | Shape: move, rotate, size the shape in hand | shape |
| With a tool in hand | `T` | Measure: the wall under the pointer | measure |
| With a tool in hand | `←` `→` `↑` `↓` | Section: move the plane a step | section |
| With a tool in hand | `Tab` | Align, pairs: which end is asked for first | align |
| With a tool in hand | `Backspace` | Align, pairs: take the last end back | align |
| With a tool in hand | `[` `]` | Align, floor: a smaller or larger patch | align |
| With a tool in hand | `G` `R` | Align, by hand: move or turn the scan | align |
| With a tool in hand | `[` `]` | Region: a smaller or larger brush | region |
| With a tool in hand | `E` | Region: paint or rub out | region |
| With a tool in hand | `Z` | Region: undo the last stroke | region |
| With a tool in hand | `Enter` | Region: keep what is painted | region |
| With a tool in hand | `Esc` | Step back, then put the tool down | anywhere |
| In a field | `Enter` | Keep what was typed | field |
| In a field | `Esc` | Leave it as it was | field |

Behaviour:
- **One table.** `state/tools.ts` builds `TOOLS` from `TOOL_KEYS` (adding `ready: true`) and `GIZMO_MODES` from `GIZMO_KEYS`; `ViewBar` takes `MAIN_VIEWS` from `VIEW_KEYS`; the titles of the palette's buttons (`Pin (P)`) are made from the table. The tools' own `onKey` code is not rewritten to read the table: `keys.test.ts` holds the table and the code together where it can (the three tables) and the e2e below presses a sample of the rest.
- **The sheet** (`KeySheet`, mounted by `App`): opened by `?` outside a field and the terminal (`e.target.closest(TYPING)`), and by a small `?` button at the foot of the tool palette (`aria-label="Keys"`); closed by `Esc`, by `?` again, by a click outside it. `role="dialog" aria-label="Keys" aria-modal="false"`, over the viewport, in the panel's colours; a column per group, a row per `KeyRow`: its keys each in a `kbd` (monospace face), then `does`. No key but `Esc` and `?` is taken while it is open: `V` still chooses Select behind it.
- **The first run** (`Welcome`, in place of the inline block of `App.tsx` for no workspace): the datum mark, the wordmark, then:
  - `Torno shows the parts an AI coding agent writes as build123d Python, and lets you point at them: the agent gets the face, the point and your note, not a screenshot.`
  - a list of three: `A workspace is a folder of objects that share one Python environment.` / `An object is a folder inside it with one Python model file, for example bracket/bracket.py.` (the path in `num`) / `Torno builds the model every time you save it, and writes only into a .torno folder inside each object.`
  - the one button, `Open folder` (the test of `boot.spec.ts` that counts one button stays true), and under it in `--muted`: `Press ? at any time for the keys.`
- **A workspace with nothing in it.** Where the workspace has no objects, the viewport region shows, in place of the empty page of objects: `No objects in <folder> yet.` and `Make a folder with a Python model in it, for example <folder>/part/part.py, and it appears here.`; and when `hasProject` is false, also `This folder has no pyproject.toml: models are built with torno's own build123d. For your own packages, make it a uv project (uv init, uv add build123d, uv sync) and open it again.` Torno runs none of those commands.

- [ ] **Step 1: Write the failing unit test.** `app/src/shared/keys.test.ts`:

```ts
import { expect, it } from 'vitest'
import { GIZMO_MODES, TOOLS } from '../renderer/state/tools'
import { GIZMO_KEYS, KEYS, TOOL_KEYS, VIEW_KEYS, cheatSheet, keyClashes } from './keys'

it('is where the tools, the views and the gizmo have their keys from', () => {
  expect(TOOLS.map((t) => [t.name, t.label, t.key])).toEqual(TOOL_KEYS.map((t) => [t.name, t.label, t.key]))
  expect(GIZMO_MODES.map((m) => [m.mode, m.key])).toEqual(GIZMO_KEYS.map((m) => [m.mode, m.key]))
  expect(TOOL_KEYS.map((t) => t.key).join('')).toBe('VPADSXMLB')
  expect(VIEW_KEYS.map((v) => v.key).join('')).toBe('1234')
})

it('lists every tool, every view key and the gizmo in the sheet, each key once where it is listened to', () => {
  const sheet = cheatSheet()
  expect(sheet.map((g) => g.group)).toEqual(['Tools', 'View', 'With a tool in hand', 'In a field'])
  const anywhere = KEYS.filter((row) => row.scope === 'anywhere').flatMap((row) => row.keys)
  for (const key of ['V', 'P', 'A', 'D', 'S', 'X', 'M', 'L', 'B', '1', '2', '3', '4', 'F', 'O', 'E', '?']) expect(anywhere.filter((k) => k === key)).toHaveLength(1)
  expect(keyClashes()).toEqual([])
  // E is the Region tool's own while it is in hand, and explode otherwise: two scopes, no clash.
  expect(KEYS.filter((row) => row.keys.includes('E')).map((row) => row.scope).sort()).toEqual(['anywhere', 'region'])
})

it('finds a key given twice in one scope', () => {
  expect(keyClashes([...KEYS, { keys: ['F'], does: 'Something else', group: 'View', scope: 'anywhere' }])).toEqual(['F (anywhere)'])
  expect(keyClashes([{ keys: ['Z'], does: 'a', group: 'With a tool in hand', scope: 'region' }, { keys: ['Z'], does: 'b', group: 'With a tool in hand', scope: 'region' }])).toEqual(['Z (region)'])
})
```

Run: `pnpm -C app exec vitest run src/shared/keys.test.ts` Expected: FAIL (module missing).

- [ ] **Step 2: Implement `shared/keys.ts`** with the table above as data, and:

```ts
export function keyClashes(rows: readonly KeyRow[] = KEYS): string[] {
  const seen = new Set<string>()
  const clashes = new Set<string>()
  for (const row of rows) for (const key of row.keys) {
    const where = `${key} (${row.scope})`
    if (seen.has(where)) clashes.add(where)
    seen.add(where)
  }
  return [...clashes]
}

const GROUPS: KeyGroup[] = ['Tools', 'View', 'With a tool in hand', 'In a field']
export function cheatSheet(): Array<{ group: KeyGroup; rows: KeyRow[] }> {
  return GROUPS.map((group) => ({ group, rows: KEYS.filter((row) => row.group === group) }))
}
```

(`Esc` is listed once, as `anywhere`; the two `[` `]` rows are of different scopes.) Then `state/tools.ts`, `ViewBar`, `ToolPalette`, `KeySheet`, `Welcome`, the empty workspace.

Run the test. Expected: PASS. Then `pnpm -C app typecheck && pnpm test`.

- [ ] **Step 3: Write the e2e test.** `app/e2e/welcome.spec.ts`:

```ts
test('the first run says what a workspace and an object are, with one button', async () => {
  const bare = await electron.launch({ args: ['.'], cwd: appDir, env: { ...process.env, TORNO_TEST: '1' } })
  try {
    const first = await bare.firstWindow()
    expect(await bare.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await expect(first.locator('[data-region="viewport"]')).toContainText('A workspace is a folder of objects that share one Python environment.')
    await expect(first.locator('[data-region="viewport"]')).toContainText('bracket/bracket.py')
    await expect(first.getByRole('button')).toHaveText(['Open folder'])
    // The dialog is main's test hook under TORNO_TEST: a folder with nothing in it says what to make.
    const empty = mkdtempSync(join(realpathSync(tmpdir()), 'torno-e2e-empty-'))
    await bare.evaluate((_e, folder) => void ((globalThis as unknown as { __tornoMain: { pickFolder: string | null } }).__tornoMain.pickFolder = folder), empty)
    await first.getByRole('button', { name: 'Open folder' }).click()
    await expect(first.locator('[data-region="viewport"]')).toContainText('Make a folder with a Python model in it')
    await expect(first.locator('[data-region="viewport"]')).toContainText('This folder has no pyproject.toml')
    rmSync(empty, { recursive: true, force: true })
  } finally {
    await bare.close()
  }
})

test('? shows the keys from the one table, and is typed as a character in a field', async () => {
  await open('plain')
  await page.locator('[data-region="viewport"] canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('?')
  const sheet = page.getByRole('dialog', { name: 'Keys' })
  await expect(sheet).toBeVisible()
  for (const line of ['Pin: click a point and leave a note', 'Draw the parts apart, or together again', 'Region: undo the last stroke']) await expect(sheet).toContainText(line)
  await expect(sheet.locator('kbd', { hasText: /^P$/ })).toHaveCount(1)
  // A tool's key still works behind it, and Escape puts the sheet away, not the tool down.
  await page.keyboard.press('m')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: /^Measure/ })).toHaveAttribute('aria-pressed', 'true')
  // In a field it is a question mark.
  await page.getByRole('button', { name: 'Save view' }).click()
  await page.getByRole('textbox', { name: 'Name of the view' }).pressSequentially('Why?')
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Name of the view' })).toHaveValue('Why?')
  await page.keyboard.press('Escape')
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/welcome.spec.ts e2e/boot.spec.ts` Expected: PASS.

- [ ] **Step 4: `CLAUDE.md`**: the bullet "Tools and keys" ends `Every key is a row of shared/keys.ts, which the palette, the view bar and the sheet of keys (?) are made from: a new key is added there first.` Commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:e2e
git add -A app CLAUDE.md && git commit -m "The first run says what a workspace and an object are, and ? shows every key from one table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Light and dark, the launcher and the desktop entry

**Files:**
- Create: `app/src/shared/contrast.ts`, `app/src/shared/contrast.test.ts`, `app/e2e/themes.spec.ts`, `app/src/launcher.test.ts`, `scripts/torno.desktop.in`, `scripts/torno.svg`
- Modify: `scripts/torno`, `app/src/renderer/styles/{tokens,app}.css` (only where the pass finds a fault), `app/src/export/page.css` (the same values), `README.md` (Run), `CLAUDE.md`

**Interfaces:**
- Consumes: the tokens of `tokens.css`; `window.__tornoTest.look`; `nativeTheme` (through `app.evaluate`).
- Produces:

```ts
// shared/contrast.ts
/** The WCAG contrast ratio of two colours given as #rrggbb: 1 to 21. */
export function contrast(a: string, b: string): number
```

```
scripts/torno [workspace]          as now
scripts/torno --print-command [workspace]   prints the command it would start, one argument a line, and exits: nothing is installed, built or started
scripts/torno --print-desktop      prints the desktop entry it would install, and exits
scripts/torno --install-desktop    writes it and the icon under ${XDG_DATA_HOME:-$HOME/.local/share}, says what it wrote, and exits
scripts/torno --uninstall-desktop  removes those two files, and exits
TORNO_OZONE=wayland | x11          passes --ozone-platform=<that> to Electron; unset: Electron chooses (D11)
```

Behaviour:
- **The pass over the themes.** `e2e/themes.spec.ts` runs the app once per theme (`nativeTheme.themeSource = 'light' | 'dark'` set through `app.evaluate` before the object is opened; a fresh launch each, because `capturePage()` gives one image per launch). In each it: opens `hollow`; leaves a pin of the user's and, through the MCP client, a mark of the agent's; saves a view; reads every colour token from `getComputedStyle(document.documentElement)` and holds them to the ratios below; takes four pictures with `window.__tornoTest.look` (`{ size: 1280 }` as on screen, `{ view: 'front', section: { origin: [0, 0, 3], normal: [0, 0, 1] } }`, `{ explode: { amount: 1, scale: 1, axis: 'z' } }`, and the page of objects' thumbnail of `hollow` from the disk), one `capturePage()` of the whole window with the key sheet open, and writes them to `app/e2e/.results/themes/<theme>-<name>.png` (the folder is ignored by git). The implementer then opens each PNG (the Read tool shows images) and writes in the task's report, per picture, what was looked for and whether it holds: the parts are the loudest thing; edges read on every part colour; a user mark and an agent mark are told apart at a glance, and no other thing is red or green; numbers are in the monospace face; hairlines are visible but quiet; no pure black, no amber, no uppercase label, no corner ticks; in dark the cut face and the grid do not glare. A fault found is fixed in `tokens.css` (and the same value in `export/page.css`, which `page.test.ts` holds equal), and the picture is taken again.
- **Measured when this plan was written** (the tokens at `a1bc7b5`, notes file): every ratio below holds in both themes but one: `--muted` on `--surface` in light is 4.28 (4.67 on `--panel`). The test of Step 1 fails on it; that is the first finding of the pass. `--muted: #686D74` gives 4.54 on the surface and 4.95 on the panel: change it in `tokens.css` and in `export/page.css`, and look for copies of the old value with `grep -rn -i '6C7178' app/src` (`--ansi-white` is the same grey and follows it).
- **Ratios** (both themes): `--ink` on `--surface` and on `--panel` at least 7; `--muted` on both at least 4.5; `--accent` on `--panel` at least 4.5; `--user-mark`, `--agent-mark`, `--ok`, `--warn`, `--fail` on `--surface` at least 3; `--hairline` on `--surface` between 1.15 and 2 (seen, and quiet).
- **The launcher.** The new options are read before anything is checked, installed or built. `TORNO_OZONE=headless`, or any value but `wayland` and `x11`, ends at once with `torno: TORNO_OZONE must be wayland or x11 (headless is not supported: Electron crashes with it here)` and status 2. `--print-command` and the real start share one function that builds the argument list, so what is printed is what is run. Nothing is ever passed when `TORNO_TEST=1` is set in the environment.
- **The desktop entry** (`scripts/torno.desktop.in`):

```ini
[Desktop Entry]
Type=Application
Name=torno
GenericName=CAD workbench
Comment=Make CAD parts with an AI coding agent
Exec=@EXEC@ %f
Icon=torno
Terminal=false
Categories=Graphics;3DGraphics;Engineering;
MimeType=inode/directory;
StartupWMClass=torno
```

  `@EXEC@` is the absolute path of `scripts/torno` in double quotes with `"`, `` ` ``, `$` and `\` escaped as the Desktop Entry Specification asks. `--install-desktop` writes `applications/torno.desktop` and `icons/hicolor/scalable/apps/torno.svg` under `${XDG_DATA_HOME:-$HOME/.local/share}`, makes those two folders if they are missing, and prints both paths and `Run it again after moving the repository.` It is the only code in the repository that writes there, and it runs only when the owner types it. `scripts/torno.svg` is the datum mark of `DatumMark` (`ui/ViewportPane.tsx`) on the paper grey, 64 × 64, in `--accent`: no black, red or amber.

- [ ] **Step 1: Write the failing tests.** `app/src/shared/contrast.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './contrast'

it('is the ratio WCAG gives', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  expect(contrast('#ffffff', '#ffffff')).toBe(1)
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.478, 2)
  expect(contrast('#22252A', '#F1EFEA')).toBeGreaterThan(12)
})

const css = readFileSync(resolve(__dirname, '../renderer/styles/tokens.css'), 'utf8')
const dark = css.indexOf('@media (prefers-color-scheme: dark)')
const tokens = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]))

describe.each([['light', tokens(css.slice(0, dark))], ['dark', { ...tokens(css.slice(0, dark)), ...tokens(css.slice(dark)) }]])('%s', (_theme, t) => {
  it('reads: ink and muted text on both grounds, the accent on the panel', () => {
    for (const ground of ['--surface', '--panel']) {
      expect(contrast(t['--ink'], t[ground])).toBeGreaterThanOrEqual(7)
      expect(contrast(t['--muted'], t[ground])).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(t['--accent'], t['--panel'])).toBeGreaterThanOrEqual(4.5)
  })
  it('shows its marks and its verdicts on the ground, and keeps its hairlines quiet', () => {
    for (const name of ['--user-mark', '--agent-mark', '--ok', '--warn', '--fail']) expect([name, contrast(t[name], t['--surface']) >= 3]).toEqual([name, true])
    const hairline = contrast(t['--hairline'], t['--surface'])
    expect(hairline).toBeGreaterThanOrEqual(1.15)
    expect(hairline).toBeLessThanOrEqual(2)
  })
})
```

`app/src/launcher.test.ts`:

```ts
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const script = resolve(__dirname, '../../scripts/torno')
/** With a HOME and a data folder of its own, so that nothing of the person's is read or written whatever the script does. */
function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'torno-launcher-'))
  const result = spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, XDG_DATA_HOME: join(home, 'data'), ...env } })
  return { ...result, home }
}

it('says the command it would start, with a platform only when one is asked for, and starts nothing', () => {
  const plain = run(['--print-command'])
  expect(plain.status).toBe(0)
  const lines = plain.stdout.trim().split('\n')
  expect(lines[0].endsWith('/app/node_modules/.bin/electron')).toBe(true)
  expect(lines[1].endsWith('/app')).toBe(true)
  expect(lines).toHaveLength(2)
  expect(run(['--print-command'], { TORNO_OZONE: 'wayland' }).stdout.trim().split('\n').at(-1)).toBe('--ozone-platform=wayland')
  expect(run(['--print-command'], { TORNO_OZONE: 'x11' }).stdout.trim().split('\n').at(-1)).toBe('--ozone-platform=x11')
  // Never with the test switch, whatever is asked.
  expect(run(['--print-command'], { TORNO_OZONE: 'wayland', TORNO_TEST: '1' }).stdout).not.toContain('ozone')
})

it('refuses the headless platform, and any other it does not know, before it does anything', () => {
  for (const value of ['headless', 'drm', '']) {
    const refused = run(['--print-command'], { TORNO_OZONE: value })
    expect([value, refused.status]).toEqual([value, value === '' ? 0 : 2])
    if (value !== '') expect(refused.stderr).toContain('TORNO_OZONE must be wayland or x11 (headless is not supported')
  }
})

it('prints a desktop entry that starts this script, and writes nothing for the asking', () => {
  const printed = run(['--print-desktop'])
  expect(printed.status).toBe(0)
  expect(printed.stdout).toContain('[Desktop Entry]')
  expect(printed.stdout).toContain(`Exec="${script}" %f`)
  expect(printed.stdout).toContain('Icon=torno')
  expect(printed.stdout).not.toContain('@')
  expect(printed.stdout).not.toContain('headless')
  expect(readdirSync(printed.home)).toEqual([])
})

it('still says how it is used', () => {
  const help = execFileSync('sh', [script, '--help'], { encoding: 'utf8' })
  for (const word of ['usage: torno [workspace]', '--install-desktop', '--print-desktop', 'TORNO_OZONE']) expect(help).toContain(word)
})
```

(No test runs `--install-desktop`: the person does, once. `--print-desktop` shares the text it writes.)

Run: `pnpm -C app exec vitest run src/shared/contrast.test.ts src/launcher.test.ts` Expected: FAIL.

- [ ] **Step 2: Implement `contrast.ts` and the launcher.**

```ts
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}
```

In `scripts/torno`, after `root` and `app` are known and before the `case ${1-}` of `--help`:

```sh
ozone=
case ${TORNO_OZONE-} in
  '') ;;
  wayland | x11) [ "${TORNO_TEST-}" = 1 ] || ozone=--ozone-platform=$TORNO_OZONE ;;
  *)
    echo "torno: TORNO_OZONE must be wayland or x11 (headless is not supported: Electron crashes with it here)" >&2
    exit 2
    ;;
esac

desktop_entry() {
  # A path in Exec is quoted, with the four characters the specification names escaped.
  quoted=$(printf '%s' "$root/scripts/torno" | sed 's/[\\"`$]/\\&/g')
  sed "s|@EXEC@|\"$quoted\"|" "$root/scripts/torno.desktop.in"
}

case ${1-} in
  --print-command)
    printf '%s\n' "$app/node_modules/.bin/electron" "$app"
    [ -z "$ozone" ] || printf '%s\n' "$ozone"
    exit 0
    ;;
  --print-desktop)
    desktop_entry
    exit 0
    ;;
  --install-desktop | --uninstall-desktop)
    data=${XDG_DATA_HOME:-$HOME/.local/share}
    entry=$data/applications/torno.desktop
    icon=$data/icons/hicolor/scalable/apps/torno.svg
    if [ "$1" = --uninstall-desktop ]; then
      rm -f -- "$entry" "$icon"
      echo "removed $entry and $icon"
      exit 0
    fi
    mkdir -p -- "$data/applications" "$data/icons/hicolor/scalable/apps"
    desktop_entry >"$entry"
    cp -- "$root/scripts/torno.svg" "$icon"
    echo "wrote $entry"
    echo "wrote $icon"
    echo "Run it again after moving the repository."
    exit 0
    ;;
esac
```

and the last line becomes `exec "$app/node_modules/.bin/electron" "$app" ${ozone:+"$ozone"}`. A path that holds a `|` would break the `sed` of `desktop_entry`: the script refuses such a root with `torno: the repository's path holds a '|': the desktop entry cannot be written for it` before the `sed`. `--help` lists the four options and `TORNO_OZONE`.

Run the tests. Expected: PASS. Then `sh -n scripts/torno`.

- [ ] **Step 3: Write `e2e/themes.spec.ts`** as described under Behaviour: `for (const theme of ['light', 'dark'] as const) test(…)`, each with its own `electron.launch` (`TORNO_TEST: '1'`, the stand-in agent, a temporary copy of the fixtures), `await app.evaluate(({ nativeTheme }, theme) => void (nativeTheme.themeSource = theme), theme)`, then:

```ts
  const tokens = await page.evaluate(() => Object.fromEntries(['--surface', '--panel', '--ink', '--muted', '--accent', '--hairline', '--user-mark', '--agent-mark', '--ok', '--warn', '--fail'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])))
  // The window has the theme that was asked for: the ground is the light one or the dark one.
  expect(contrast(tokens['--surface'], '#ffffff') < 2).toBe(theme === 'light')
  expect(contrast(tokens['--ink'], tokens['--surface'])).toBeGreaterThanOrEqual(7)
  const shots: Array<[string, object]> = [['view', { size: 1280 }], ['section', { view: 'front', section: { origin: [0, 0, 3], normal: [0, 0, 1] } }], ['exploded', { explode: { amount: 1, scale: 1, axis: 'z' } }]]
  for (const [name, request] of shots) {
    const picture = await page.evaluate((request) => window.__tornoTest!.look(request as never).then((p) => ({ png: Array.from(p.png), caption: p.caption })), request)
    writeFileSync(join(out, `${theme}-${name}.png`), Buffer.from(picture.png))
    expect(picture.png.length).toBeGreaterThan(5000)
  }
  // A picture for the agent draws every mark alike, on the theme's own ground: the same view in the two themes is not the same picture.
  await page.keyboard.press('?')
  const whole = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage().then((image) => image.toPNG().toString('base64')))
  writeFileSync(join(out, `${theme}-window.png`), Buffer.from(whole, 'base64'))
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/themes.spec.ts` Expected: PASS, eight PNGs under `app/e2e/.results/themes/`.

- [ ] **Step 4: Look at the eight pictures**, one by one, against the list under Behaviour, and write what each shows in the task's report (a line a picture, and every fault with the token that was changed for it). Fix, run Steps 1 and 3 again, look again. A fault that is not a token (a rule of `app.css`) is fixed there, and named.

- [ ] **Step 5: README "Run"** gains the four options and `TORNO_OZONE`; **`CLAUDE.md`** says under "Testing the app in a hidden window": `scripts/torno never passes a platform when TORNO_TEST=1, and refuses headless whoever asks.` Commit.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:e2e
git add -A app scripts README.md CLAUDE.md && git commit -m "Light and dark are held to their contrasts and looked at; the launcher takes a platform on request, never headless, and can install a desktop entry when asked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The README for a first-time reader

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `app/src/main/statefile.ts` (only if Step 3 finds a line of `state.md` the README describes and the code does not write)
- Test: `app/src/readme.test.ts` (new)

**Interfaces:**
- Consumes: everything Tasks 1 to 8 made; the five by-hand lines of Task 6; `TOOLS` of `main/mcp/schemas.ts`; `KEYS` of `shared/keys.ts`.
- Produces: the README's headings, which `readme.test.ts` pins:

```
# torno
## Five minutes with torno
## Requirements
## Install
## Run
## The window
### Objects, and the page of them
### Pointing and marks
### Measuring and cutting
### Explode and saved views
### Scans
### Keys
### How a model is read
## The agent
### Choosing an agent
### What the agent is told
### Tools
## Export
## Files torno writes
## Tests
## Environment variables
## Not yet verified on a visible screen
```

- [ ] **Step 1: Write the failing test.** `app/src/readme.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { TOOLS } from './main/mcp/schemas'
import { TOOL_KEYS } from './shared/keys'

const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf8')
const headings = readme.split('\n').filter((line) => /^#{1,3} /.test(line))

it('is laid out for a first-time reader, the walk-through before the reference', () => {
  expect(headings.slice(0, 6)).toEqual(['# torno', '## Five minutes with torno', '## Requirements', '## Install', '## Run', '## The window'])
  for (const heading of ['### Explode and saved views', '### Keys', '### Choosing an agent', '## Export', '## Files torno writes', '## Not yet verified on a visible screen']) expect(headings).toContain(heading)
  expect(headings).not.toContain('## Next')
})

it('names every tool the agent has and every tool key, and the files Milestone 5 added', () => {
  for (const tool of Object.keys(TOOLS)) expect([tool, readme.includes(`\`${tool}\``)]).toEqual([tool, true])
  for (const { key, label } of TOOL_KEYS) expect([label, readme.includes(`\`${key}\``)]).toEqual([label, true])
  for (const file of ['thumb.png', 'agent.json', 'prompt.md', 'exports/', 'scene.json', 'TORNO_OZONE']) expect([file, readme.includes(file)]).toEqual([file, true])
})

it('lists what nobody has seen on a visible screen', () => {
  const section = readme.slice(readme.indexOf('## Not yet verified on a visible screen'))
  for (const item of ['Hyprland', 'Alt-drag', 'clipboard', 'Copilot CLI', 'Claude Code', '--install-desktop', 'file://']) expect([item, section.includes(item)]).toEqual([item, true])
})
```

Run: `pnpm -C app exec vitest run src/readme.test.ts` Expected: FAIL.

- [ ] **Step 2: Restructure.** Move, do not rewrite, except where a section is new or a sentence became untrue. Where each of today's sections goes:

| Today | Goes to |
|---|---|
| the opening (lines 1 to 28) | `# torno`, cut to what torno is and is not, in ten lines; the evidence stays in the spec |
| Requirements, Install, Run | the same headings, after the walk-through; Run gains the options of Task 8 |
| The window | `## The window` and `### Objects, and the page of them` (new: the page, the cards, when a picture is made) |
| Pointing and marks | `### Pointing and marks`; its part on dimensions and the section moves to `### Measuring and cutting` |
| (new) | `### Explode and saved views`: the slider, `E`, the axis and the scale; that nothing is marked, measured or cut while apart, and why; saving, applying, keeping a proposal |
| Scans | `### Scans`, with the examples' `rms` figures as Task 1 now words them |
| (new) | `### Keys`: one sentence, `Press ? for every key`, and the table of `shared/keys.ts` |
| How a model is read | the same |
| What the agent gets | `## The agent`: `### Choosing an agent` (new), `### What the agent is told` (the prompt's context; for an agent without hooks, `.torno/prompt.md` and "Send marks"), `### Tools` (the table, with `save_view`, and `explode` on `look` and `show`; Measuring tools and Scan tools as they are, under it) |
| (new) | `## Export`: what is in a file, what never is, the budget, that it opens from `file://` with no network |
| Files torno writes | the same, with `thumb.png`, `thumb.json`, `agent.json`, `agent/`, `prompt.md`, `exports/` and the new keys of `scene.json` |
| Tests, Environment variables | the same; the table gains `TORNO_OZONE` and `TORNO_KEEP_BUILDS` (for tests only) |
| Next | removed: Milestone 5 was the last |

- [ ] **Step 3: Write "Five minutes with torno"**, this text (commands in code blocks as given):

````markdown
## Five minutes with torno

This walk-through uses the small models torno is tested with, on a copy, so nothing of yours is touched.

1. Make a workspace from the test models and open it:

   ```sh
   cp -r kernel/tests/fixtures/ws /tmp/torno-tour
   scripts/torno /tmp/torno-tour
   ```

   The window opens on a page of cards, one per object. None has a picture yet: a picture is made when an
   object is built here.

2. Click `hollow`. It is built (about a second, the first time a few more) and drawn: a tub and its lid. Drag
   to turn it, scroll to zoom, `F` to fit. `1` to `4` are the standard views.

3. Press `E`. The lid lifts off the tub: the parts are drawn apart, for looking only. Press `E` again.

4. Press `P` and click the top of the lid. A pin is left there, numbered `M1`; type "too thin here" and press
   Enter. The pin is red: it is yours.

5. Press `M`, click the top face of the lid, then its bottom face: the distance between them is measured by the
   kernel, exactly, and stays on the part as `M2`. Type `3` as what it should be: it now says whether it is.

6. Press `X`. A plane cuts the parts; drag its arrow. Press `X` again and "Clear" to take it away.

7. In the session pane on the right, start a session. With Claude Code, type "what did I mark?" and press Enter:
   your two marks go with the prompt, as text: the face, the point, your note, the measured value. The agent can
   ask torno for a picture (`look`), for a measurement (`measure`) and for a cut (`section`), and it edits
   `hollow/hollow.py`; every save is built and drawn.

8. Above the view, "Save view" keeps how you are looking at the part under a name. "Export…" writes one HTML file
   you can open on a phone or send to someone: it needs nothing else.

9. Press `?` for every key. Then open your own folder with the folder button at the top left.

To clean up: close torno and `rm -r /tmp/torno-tour`.
````

  Check each step against the app as it is after Task 8 by doing it in the hidden window through the test hooks (the fixtures' `hollow`: the lid's top and bottom faces are parallel planes, so step 5 measures; the value typed must be one the lid can be compared with: read the lid's thickness from `hollow.py` and write that number in step 5 in place of `3` if it is another). A step that is not true is corrected in the text, not in the app.

- [ ] **Step 4: Write "Not yet verified on a visible screen"**, this text:

```markdown
## Not yet verified on a visible screen

Torno was built and tested in a window that is never shown. These have not been seen by anyone on a real screen,
or with a real agent, and are yours to try once. Each says what to look for.

- **The first visible start on Hyprland with NVIDIA.** `scripts/torno ~/objects`. The window should open, draw
  the parts, and resize without flicker. If it stays blank or does not open, try `TORNO_OZONE=x11 scripts/torno`
  and then `TORNO_OZONE=wayland scripts/torno`, and keep the one that works in your shell's profile.
- **Alt-drag with the Draw tool.** With `D` in hand, hold Alt and drag: the camera should turn, and no menu bar
  should appear. Hyprland may take Alt-drag for moving the window: if so, the binding is Hyprland's to change.
- **Losing focus during a drag.** Start dragging the section's arrow, switch to another workspace, come back: the
  plane should be where it was before the drag, and the camera should turn again on the next drag.
- **Clipboard keys in the terminal.** In a session, select text and copy it (Ctrl+Shift+C), and paste
  (Ctrl+Shift+V): no test touches the clipboard.
- **Claude Code, one prompt.** Start a session, leave a pin, send a prompt: the pin's line should be in what
  Claude says it was told, and the pin should turn from draft to sent.
- **Copilot CLI: is torno's server there?** Choose Copilot CLI for an object, start a session, type `/mcp`: `torno`
  should be listed with its tools. If it is not, the keys of the JSON torno passes to `--additional-mcp-config`
  (`type`, `url`, `tools`) are a guess from the help text, and that is where to look.
- **Copilot CLI: are torno's instructions read?** `/instructions` should list `.torno/agent/AGENTS.md`.
- **Copilot CLI: "Send marks".** Leave a pin, press "Send marks", then Enter: the agent should read
  `.torno/prompt.md` and name the pin, and the pin should turn to sent.
- **Copilot CLI: resume.** End the session, press "Resume": the earlier conversation should continue.
- **The desktop entry.** `scripts/torno --install-desktop`, then start torno from your launcher; a folder opened
  with it from a file manager should become the workspace. The window's class should be `torno` (for a
  Hyprland window rule); if the launcher shows a second icon while it runs, `StartupWMClass` is the line to change.
- **An exported file elsewhere.** Open one from `file://` in Firefox and on a phone: parts, layouts, the explode
  slider and the section should work with the network off. It was checked in Chromium only.
- **A large object on the page of objects.** Open `micra-intake` and go back to the page: its card should get
  its picture within a second of the build landing, and the window should not stall while it is made.
```

- [ ] **Step 5: Go over `CLAUDE.md` once**, whole, against the code: every file path it names exists (`grep -o '`[a-zA-Z/_.-]*\.\(ts\|tsx\|py\|css\|mjs\)`' CLAUDE.md` and test each with `ls` under `app/src`, `app/`, `kernel/src/torno_kernel` or the root), the sections added by Tasks 2 to 6 are there (`## Explode`, `## Views`, `## The page of objects`, `## Export`, `## Agents`), and the first lines name `scripts/build-viewer.mjs` and `app/src/export`.

Run: `pnpm -C app exec vitest run src/readme.test.ts` Expected: PASS. Then all suites.

```bash
pnpm -C app typecheck && pnpm test && pnpm test:kernel && (cd kernel && uv run --no-sync pytest -q) && pnpm test:e2e
git add -A README.md CLAUDE.md app && git commit -m "The README starts with five minutes on the test models, says how the window, the agents and the export work, and lists what nobody has seen on a visible screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The sweep by hand, on two of the owner's objects

Nothing is implemented here. Every feature of the five milestones is used in one session of the app on a temporary copy of two objects that are cheap to build, in the hidden window, through the test hooks and an MCP client; what is found is fixed if it is small and recorded if it is not.

**Files:**
- Create: none in the repository but the report the controller keeps (`.superpowers/sdd/2026-10-09-torno-m5-show/task-10-report.md`, by the controller's convention). The driver script lives in the scratchpad.
- Modify: whatever a small finding needs, each with its test in the file that owns it.

**Interfaces:**
- Consumes: everything.
- Produces: the report, and the last lines of the README's "Not yet verified" section if the sweep finds more that only a visible screen can show.

- [ ] **Step 1: Make the copy, read-only at the source.** `helmet-stand` (295 lines of model, built in 1.4 s at Milestone 1) and `guitar-wall-stand` (1,043 lines, 13 s, three parts). Not `micra-intake` (its worker holds about 11 GB), not `micra-spoiler` (98 s).

```sh
T=$(mktemp -d /tmp/torno-m5-sweep-XXXXXX)
touch "$T/.marker"
cp -r /home/luisgonc/objects/helmet-stand /home/luisgonc/objects/guitar-wall-stand /home/luisgonc/objects/common "$T/"
cp /home/luisgonc/objects/pyproject.toml /home/luisgonc/objects/uv.lock "$T/"
ln -s /home/luisgonc/objects/.venv "$T/.venv"          # read by `uv run --no-sync`, which writes nothing into it
rm -rf "$T"/*/.torno "$T"/*/__pycache__
du -sh "$T"
```

  No git command is run in `/home/luisgonc/objects`, and nothing there is written: Step 6 proves it.

- [ ] **Step 2: Write the driver** in the scratchpad (a `.mjs` using `_electron` from `@playwright/test` as `e2e/mcp.spec.ts` does): `TORNO_TEST: '1'`, `TORNO_KEEP_BUILDS` **not** set (the memory policy is part of what is swept), `TORNO_WORKSPACE: $T`, `TORNO_AGENT_CMD: node app/test/fake-agent.mjs`, `TORNO_CONFIG` pointing into the scratchpad. It prints `BrowserWindow.getAllWindows()[0].isVisible()` first and stops if that is not `false`.

- [ ] **Step 3: The session.** In order, each line a thing to do and what to record (times in ms, sizes in bytes, every tool reply saved under the scratchpad):

  1. Loop: the page of objects with two cards and no picture; open `helmet-stand` (build time); the card's picture appears; save `helmet_stand.py` unchanged (`touch`) and time the rebuild; break it (a syntax error in a copy of the line) and see the stale parts and the error sheet, then put it back.
  2. Talk: a pin, a pick, an arrow, a stroke on a locked front view, a shape; `hook` typed into the stand-in (the context text: every mark has its line); the marks are `sent`; `marks`, `describe`, `highlight`, `show`, `add_mark`, `resolve_mark` through the MCP client.
  3. Read: a distance between two faces and a diameter with the Measure tool, one with an expectation that fails; `measure` (distance, bbox, volume), `section` (the drawing saved and looked at), `check mesh`; a rebuild, and the dimension is measured again.
  4. Scan: a generated scan (`app/src/test/scanFixtures.ts` `boxStl` written to the scratchpad) imported into `guitar-wall-stand`, aligned by three pairs, a region painted, `scan_clash` and `scan_deviation` (replies saved).
  5. Explode: `guitar-wall-stand` (three parts) at 50 % and 100 %, from the centre and along each axis: a `look` of each saved and looked at (do the parts part? does anything overlap at 100 %?); a pin attempt (refused, no mark); `E`.
  6. Views: two saved by hand, one with a section; `scene` lists them; `look {view}` of each (pictures looked at); `save_view`, kept; the object closed and opened again: the views are there.
  7. Show: back to the page: both cards with pictures, counts and the failing dimension; a third object made in the copy (`mkdir "$T/new" && cp` a fixture model) appears without a picture.
  8. Export: `helmet-stand` alone; then both, with marks; then with the scan ticked. Each file's size, what the sheet said, and each opened in a second hidden window: parts toggled, layouts, explode, section, a view applied, marks on; `grep -c "$T\|/home/" <file>` is 0.
  9. Agents: `guitar-wall-stand` set to Copilot CLI (the stand-in); a session; "Send marks" with a draft; Enter; the mark is `sent`; `.torno/prompt.md` read. `helmet-stand` stays Claude Code: `hook` still answers with context.
  10. Polish: `?`; the themes (`nativeTheme.themeSource`) with one `look` each; `scripts/torno --print-command` and `--print-desktop`.
  11. Memory: with both objects open, `ps -o rss= -p <worker pids>` and `/proc/meminfo`'s `MemAvailable`; whether any build let another go.

- [ ] **Step 4: Fix what is small.** A finding that is a wrong word, a missing refusal, a wrong number or anything told to the agent that it cannot rely on is fixed now, with a test first in the file that owns the code, and the step that found it is run again. A finding that needs a design decision is written in the report under "For the owner", with what was seen and the smallest change that would mend it.

- [ ] **Step 5: Write the report**: per step of the session what was done and seen (numbers, the pictures looked at and what each showed), the findings with their severity and what became of each, the times and sizes in one table (build of each object, rebuild, a `look`, a thumbnail, each export's bytes and how long it took to write, the workers' memory), and the list "For the owner".

- [ ] **Step 6: Prove nothing of the owner's was touched, clean up, run everything, commit.**

```sh
find /home/luisgonc/objects /home/luisgonc/Downloads -newer "$T/.marker" -not -path '*/.venv/*' 2>/dev/null | head      # expected: nothing
find /home/luisgonc/objects/.venv -newer "$T/.marker" -type f 2>/dev/null | head                                        # expected: nothing
diff -rq /home/luisgonc/objects/helmet-stand "$T/helmet-stand" | grep -v '\.torno\|__pycache__'                          # expected: nothing
ls ~/.local/share/applications/torno.desktop 2>/dev/null                                                                 # expected: nothing (unless the owner installed it)
rm -rf "$T"
pnpm -C app typecheck && pnpm test && pnpm test:kernel && (cd kernel && uv run --no-sync pytest -q) && pnpm test:e2e
git add -A app README.md CLAUDE.md && git commit -m "What the sweep of all five milestones on two real objects found, and what it changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  (If the sweep changed nothing in the repository there is nothing to commit: say so in the report.)

---

## Order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10, one after the other: nobody else is in the tree, and each of Tasks 2 to 6 changes `store.ts`, `ipc.ts` or `schemas.ts`. Task 1 is first because 2, 3, 5 and 6 add to the files it splits. Explode (2) and saved views (3) are before the page (4) and the export (5), which both hold them. Task 6 depends on nothing of 2 to 5 but the prompt's sentences and could be moved up; it is after the export so that the thing the owner asked for first is done first. 7 and 8 need the strip, the page and the sheet to be there to list their keys and look at them. 9 describes what is there. 10 is last.

## Self-review

**Spec coverage.** Section 13, item 5: explode (Task 2), named views (3), HTML export (5), more agent adapters (6), polish (7, 8, 9, 10). Section 9: the page of objects (4; the amended text), export "reduced to layers, views, explode and scan opacity" (5), "does not publish" (nothing uploads; the README says so). Section 7: "Explode slider" (2), "named views saved per object" (3). Section 3: "named views" in `scene.json` (3), the new files (1 amends the list; 4, 5, 6 write them). Section 6: `look`'s "a preset name, a named view, or a camera" (3); the adapter "config record … whether hooks exist" (6); "Codex, Gemini CLI and opencode are later adapters" is amended in Task 1 (D8). Section 10: the keys (7; the command palette and `Tab` between panes, which the spec names and nothing implements, are struck from the spec in Task 1 rather than built: nobody has missed them in four milestones). Section 12: every task has unit tests, and an e2e in a hidden window where it has a UI. Gap, said: no comparison of objects side by side (D6).

**Rulings.** R1 Task 1, with the two tables. R2 Task 2, the rule under Decisions and in `CLAUDE.md`; D1, D2. R3 Task 3; D3, D4. R4 Task 4; D5, D6. R5 Task 5; D7, D10. R6 Task 6; D8, D9. R7 (a) and (b) Task 7, (c) and (d) Task 8, (e) Task 9, (f) Task 10. R8 Task 9 Step 4, with lines from Tasks 6 and 8. Departures are D1 to D12, each with why and the cost if wrong; the two that narrow a ruling are D2 (no exploded section, where R5 lists both for the export: the page has both controls and never both on) and D5 (no build for a thumbnail at all).

**Placeholders.** Searched for "TBD", "TODO", "similar to", "appropriate", "as needed", "etc.": none in a step. Three places describe wiring in words, with the neighbour to copy, as the header says: the React components (`ExplodeControl`, `ViewsStrip`, `ShowPage`, `ExportSheet`, `AgentPicker`, `KeySheet`, `Welcome`: their text, roles, labels and behaviour are given, and the e2e tests pin them), the export viewer's four files (Task 5 Step 6: what each does, the hook it must expose, the build's size check and the e2e that drives it), and the four file splits of Task 1 (moves, with the names of what goes where). The algorithms and formats are in full: `explodeOffsets`, `savedViewOf`, `markOffset`, `stampTriangles`, `packMesh`/`unpackMesh`, `clusterScan`, `exportHtml`, `thumbnailRefusal`, `sendLine`, `copilotAdapter`, `contrast`, `keyClashes`, the launcher's shell.

**Type consistency.** `ExplodeState` (`amount`, `scale`, `axis`) is one type from `shared/explode.ts` in the store, `scene.json`, `ViewState`, `LookRequest`, `ShowRequest`, `SavedView`, `ExportObject` and the page's hook. `SavedView.hidden` (names switched off) is what `actions.saveView` writes, `applyView` and `namedView` read, and `exportData` copies. `explodeNow(s)` is null when not exploded, everywhere. `Viewport.project(point, part?)` is the one projection the e2e of Task 2 uses; `window.__tornoTest.project` passes the part on. `ToolDeps` gains `views` and `saveView` in Task 3 and nothing else in the plan. `AgentAdapter` has `id`, `label`, `command`, `hooks`, `toolName`, `launch` in the contract, in `copilotAdapter` and in the tests; `Sessions.resumable(obj, agent)` and `start` returning a promise are in Task 6's Produces and used so in its tests. `ExportDeps.budget` and `.most` exist for the tests that use them. `pngOf` and the exported `Encoder` are produced in Task 4 and used only there. `cameraOf` is Task 1's name for today's private `camera` and is what Task 3 consumes. `TOOL_KEYS` carries `name`, `label`, `key`; `TOOLS` of `state/tools.ts` adds `ready`.

**Review Focus.** 1: `explode.test.ts`, `Tool.test.ts` (`EXPLODED_TOOLS`), `tools.test.ts` (caption, `scene` parts unchanged), `readTools.test.ts` (measure unchanged), `e2e/explode.spec.ts` (true pick, no pin). 2: `html.test.ts` (policy, two scripts, no URL), `build.test.ts` (no path, no scan and no note by default), `e2e/export.spec.ts` (no request, not the workspace's path). 3: `views.test.ts` (damaged views, names), `store.test.ts` (a part gone, a layout gone), `tools.test.ts` (unknown name, layout gone). 4: `cards.test.ts` (`behind`, `dimensions: null`, unreadable marks), `e2e/show.spec.ts` (nothing built for the page; the model changed since). 5: `sendMarks.test.ts`, `manager.itest.ts` (not sent before Enter, not sent when the session ends, never another agent's conversation), `e2e/agents.spec.ts`.

**What this plan could not check.** No test code in it has been run: it is specification written against the code as read at `a1bc7b5`, and selectors and helper names of existing specs (`open`, `row`, `bar`, `clickScan`, `state`, `term`) are as found there or said to be taken from the neighbouring spec. The fixtures' exact numbers in the e2e tests (the lid's top face, `Built, r1`, two parts in `hollow`'s assembly) are from the fixture models' names and the M4 specs, not from a run. Copilot CLI's behaviour beyond its help text is unverified by design and listed for the owner.

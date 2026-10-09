# Torno Milestone 3 "Read" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user and the agent can read the part: measure it exactly, pin dimensions that are re-measured and judged on every build, see it cut by a section plane, and check overlap, clearance and mesh integrity.

**Architecture:** The kernel gains exact queries (`measure`, `section`, `check`). A dimension is a new kind of mark, so it reuses the store, re-anchoring, delivery and drawing built in Milestone 2; main re-measures dimensions after every build. The section is a clipping plane with stencil caps in the viewport, mirrored by exact outlines from the kernel for the agent.

**Tech Stack:** as Milestones 1 and 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md`, sections 4 (queries), 5 (dimension marks, pinned dimensions), 6 (`measure`, `section`, `check`), 7 (section, measure). Scan clash and region marks are Milestone 4.

Read `CLAUDE.md` first: test commands, global constraints, kernel invariants, hidden-window rules. They bind every task.

How this plan is written: each task gives files, exact interfaces and the tests to write. Write each listed test first, watch it fail, then implement.

## Global Constraints

- Everything in `CLAUDE.md`.
- Every number told to the agent is exact, from the kernel's B-rep. The mesh may drive hover readouts only, and those are replaced by the kernel's value on commit. A bounding box on freeform geometry is labelled approximate.
- Lengths are millimetres, angles degrees, areas mm², volumes mm³, mass grams. Numbers shown use the shared formatter (at most 4 significant digits, no trailing zeros); numbers stored and returned as data are full precision.
- A dimension is a mark: ids continue the `M<n>` sequence, the store, file, re-anchoring guards and delivery rules of Milestone 2 apply unchanged.
- A dimension whose ends could not be found again is never reported with a value: it says it could not be measured.
- The section never changes geometry or marks; it is a view. What the agent is told about a section comes from the kernel's exact outlines, not from pixels.
- No per-pointer-move state in React or Zustand.
- Tests never call the real `claude` CLI and never open a visible window.

## Review Focus

1. **A pinned dimension after a rebuild that renumbers faces or removes an end.** Expected: re-measured between the same two features when they can be found (by re-anchoring, not by index), flagged `drifted`/`orphaned` like any mark, and shown as "not measurable" with no stale value when they cannot. Tests in Tasks 3 and 4.
2. **Expected value and tolerance.** Expected: pass when `|value − expected| <= tolerance` (default tolerance 0.05 mm, 0.1°), fail otherwise, and the agent is told of every failing dimension with every prompt until it passes. Tests in Tasks 4 and 7.
3. **Measuring between things that are not simply two points:** two parallel planes (distance between planes), a plane and a point, two axes of cylinders (axis distance), a face and an edge. Expected: the kind of measurement is stated with the value ("between planes", "axis to axis", "minimum"), never a bare number. Tests in Tasks 1 and 3.
4. **A section through a part that is not watertight or through several overlapping parts.** Expected: caps drawn per part in the part's colour; no cap bleeding outside the solid; scans and open meshes clipped without caps; `section` from the kernel returns closed loops per part or says which part gave open ones. Tests in Tasks 5 and 6.
5. **Mass and volume asked of a part with no density.** Expected: volume always; mass only with a density, defaulting to PLA 1.24 g/cm³ and saying so. Test in Task 1.

## Shared contracts

### Dimension mark (`app/src/shared/marks.ts`, added to the `Mark` union)

```ts
export type MeasureKind = 'distance' | 'angle' | 'radius' | 'diameter' | 'thickness'
export interface DimensionMark extends MarkBase {
  kind: 'dimension'
  measure: MeasureKind
  a: Anchor                 // first end; for radius, diameter and thickness the only one
  b?: Anchor                // second end, for distance and angle
  value?: number            // mm or degrees, as last measured by the kernel; absent when not measurable
  how?: string              // "between planes" | "axis to axis" | "point to plane" | "minimum" | "wall, along the normal" | ...
  measuredRevision?: number // this run's build it was measured on (dropped on load, like checkedRevision)
  expected?: number
  tolerance?: number        // default 0.05 mm, 0.1°
  verdict?: 'pass' | 'fail' // present when expected is set and value is known
  points?: [Vec3, Vec3]     // the two points the value was taken between, for drawing the dimension line
}
```

`MarkPatch` gains `expected` and `tolerance` (a `null` clears `expected`). `markAnchors` returns `a` and `b`.

### Kernel queries (all take the object's `dir`; refs are `<layout>:<part>[/F<i>|/E<i>]`)

- `measure`, args `{"kind": "distance" | "angle" | "radius" | "diameter" | "thickness" | "bbox" | "volume" | "area" | "mass", "a": Target, "b"?: Target, "density"?: number}` where `Target` is `{"ref": "assembly:lid/F12"}` or `{"layout": "assembly", "point": [x, y, z]}` or both (the ref's feature, measured at/near the point).
  Reply `{"kind": ..., "value": number, "unit": "mm" | "deg" | "mm2" | "mm3" | "g", "how": string, "points"?: [[x,y,z],[x,y,z]], "exact": boolean, ...}`; `bbox` replies `{"min", "max", "size", "exact"}`; `mass` also carries `"density"` and `"volume"`.
- `section`, args `{"layout": "assembly", "plane": {"origin": [x,y,z], "normal": [x,y,z]}, "parts"?: ["lid"]}`.
  Reply `{"plane": {"origin", "normal", "x", "y"}, "parts": [{"part": "lid", "loops": [{"points": [[u,v], ...], "closed": true, "area": number}], "area": number, "open": 0}], "bounds": {"min": [u,v], "max": [u,v]}}`; points are mm in the plane's `x`/`y` axes, deflection 0.05 mm, at most 2,000 points per loop.
- `check`, args `{"kind": "overlap" | "clearance" | "mesh", "layout": "assembly", "a": "lid", "b"?: "tub"}`.
  `overlap` → `{"volume": mm3, "bbox": {"min","max"} | null}`; `clearance` → `{"distance": mm, "points": [[...],[...]]}` (0 when touching or overlapping, with `"overlapping": true`); `mesh` → `{"watertight": boolean, "openEdges": number, "where": [[x,y,z], ...] (at most 20), "triangles": number}` on the part's own tessellation after welding vertices at 1e-4 mm.

### View and look additions (`app/src/shared/view.ts`)

```ts
export interface SectionPlane { origin: Vec3; normal: Vec3 }           // keeps the side the normal points away from
export interface ViewState { ...; section?: SectionPlane | null }
export interface LookRequest { ...; section?: SectionPlane | 'current' | null }   // 'current' (default): the user's own; null: uncut
export interface ShowRequest { ...; section?: SectionPlane | null }
```

`scene.json` gains `section?: SectionPlane | null`.

---

### Task 1: Carried fixes, and the kernel's measuring queries

**Files:**
- Modify: `app/src/main/context.ts`, `context.test.ts`, `app/src/main/prompt.ts`, `app/src/main/mcp/tools.ts`, `mcp/markTools.ts`, `app/src/main/marks/reanchor.ts`, `app/src/main/look.ts`, `app/src/shared/view.ts`, `app/src/renderer/ui/NotePopover.tsx`, `app/src/renderer/ui/ViewportPane.tsx`
- Create: `kernel/src/torno_kernel/measure.py`, `kernel/tests/test_measure.py`
- Modify: `kernel/src/torno_kernel/queries.py` (dispatch), `kernel/tests/test_supervisor.py` (one protocol test)

**Carried from Milestone 2's last review (each with a test):**
1. The prompt context is cut to `CONTEXT_LIMIT` in every case (it could reach 6,087 on a fresh conversation): check room before the second list's head and apply a final cut.
2. A user mark the agent resolved and the user reopened is told as `(reopened by the user)`, not `(changed)`: record it at the resolved → draft transition, clear it in `markSent`.
3. `NotePopover` keeps the typed note on `pagehide`.
4. The system prompt explains `(changed)`, `(reopened by the user)`, `[not checked against rN]`, `Selected:` and "Marks still open", in two sentences.
5. The `marks` tool description says a mark is unchecked when its `checkedRevision` is absent or differs from the revision.
6. A selection of more than eight refs carries its total (`SelectionReport.total`), and the context says "and N more".
7. `add_mark` by point alone returns a failure when the kernel answered an error for the point, never "on no part".
8. `judgePin` takes `edgeUnder` when the kernel found an edge other than the named one.
9. Re-anchor retry timers are cancelled when the workspace closes.

**Kernel `measure` (new module, dispatched from `queries.run`):**
- `distance` between two targets:
  - two planar faces within 0.01° of parallel → distance between the planes, `how: "between planes"`, points at the foot of the perpendicular from `a`'s centre;
  - two cylindrical faces or circular edges with parallel axes → axis distance, `how: "axis to axis"`;
  - a point and a planar face → `how: "point to plane"`;
  - anything else → `BRepExtrema_DistShapeShape`, `how: "minimum"`.
  - A target with only a point is that point. A target with a ref and a point is the ref's feature (the point only disambiguates nothing in this task; it is kept for drawing).
- `angle` between two planar faces (between normals, 0-180), two straight edges, or a face and an edge; `how` says which; anything else is `bad_request` naming what can be measured.
- `radius` / `diameter` of a cylindrical, spherical or toroidal face or a circular edge; a face of another type is `bad_request` with its type.
- `thickness` at a target with a ref and a point: a ray from the point along the inward normal, to the first other face of the same part; `how: "wall, along the normal"`; no hit → `bad_request` "no opposite wall along the normal".
- `bbox`, `volume`, `area` of a part, face or edge as applicable; `bbox` of a part with any non-planar, non-cylindrical face has `exact: false`.
- `mass` of a part: `density` in g/cm³, default 1.24 with `how: "PLA 1.24 g/cm³ (default)"`.
- Every reply carries `exact` and `how`. Errors are `bad_ref` (naming valid refs, as `describe` does) or `bad_request`.

- [ ] **Step 1:** Carried fixes 1 to 9, test first; commit.
- [ ] **Step 2:** `test_measure.py` on fixtures (`bracket`, plus a new `measures` fixture: a 40 × 30 × 6 plate with two Ø8 holes 20 mm apart, a 45° chamfer on one edge, and a 2 mm wall pocket): plate thickness between top and bottom planes is 6 "between planes"; hole axis distance 20 "axis to axis"; hole diameter 8; angle between top and chamfer 135 or 45 (state which, and assert `how`); pocket wall thickness 2; point to plane; minimum distance between two parts (bracket post and a far face); bbox exact for the plate; volume, area; mass at the default density and at 7.85; each `bad_request` text.
- [ ] **Step 3:** Implement; one supervisor protocol test (`measure` over the wire, for the object asked); run the kernel suite; commit.

### Task 2: Split `Viewport.ts`

**Files:**
- Create: `app/src/renderer/viewport/picture.ts`, `app/src/renderer/viewport/pointer.ts`
- Modify: `app/src/renderer/viewport/Viewport.ts`

`Viewport.ts` is about 1,200 lines. Before the section adds to it: move the picture path (`renderImage`, the encoder, the render targets, the picture-time state swap and restore) into `picture.ts`, and pointer routing (event normalising, click detection, the gizmo hand-off, held-button tracking, the wheel handler) into `pointer.ts`. Each takes a small explicit interface to the viewport's internals (a `PictureHost` / `PointerHost` object built in the constructor), not the class itself. Behaviour unchanged.

- [ ] **Step 1:** Run the unit and e2e suites; note the counts.
- [ ] **Step 2:** Move the code; `Viewport.ts` ends under 800 lines; no public method changes.
- [ ] **Step 3:** Same suites, same counts, typecheck clean; commit.

### Task 3: Dimension marks and the Measure tool

**Files:**
- Modify: `app/src/shared/marks.ts`, `app/src/main/marks/{file,store,describe}.ts` and tests, `app/src/renderer/viewport/marks/{markObjects,labels,MarkLayer}.ts`, `app/src/renderer/ui/{MarkRow,MarksPanel,ToolPalette}.tsx`, `app/src/renderer/state/tools.ts`
- Create: `app/src/renderer/tools/measureTool.ts`, `measure.test.ts`; `app/src/renderer/ui/DimensionFields.tsx`; `app/src/main/marks/measure.ts`, `measure.test.ts`; `app/e2e/measure.spec.ts`
- Modify: `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/ipc.ts` (a `geometry.measure(objectId, args)` call)

**Interfaces:**
- Produces the `DimensionMark` contract, `geometry.measure(objectId, args): Promise<Measured>`, and `measureDimension(deps, objectId, mark): Promise<Pick<DimensionMark, 'value' | 'how' | 'points' | 'measuredRevision' | 'verdict'>>` in main (asks the kernel with each end's ref and point; computes the verdict).
- `describeMark` for a dimension: `M7 distance 6 mm between planes, base/F5 to base/F0` · with an expectation: `M8 diameter 8 mm, base/F9 (expected 8.5 ± 0.05: FAIL, 0.5 under)` · not measurable: `M9 distance: not measurable, [its part is gone]`.

Behaviour:
- Measure tool (`M`): hover shows a live mesh readout; the first click picks `a` (a face, edge or point on a face; `Shift`-click forces a bare point); for a radius-like feature (cylindrical face, circular edge) a double click on it commits a diameter at once; otherwise the second click picks `b` and commits. The kind is chosen from what was picked: two things → `distance` by default, with a small chip row offering "Distance / Angle" while the second pick is pending; one curved thing → `diameter` (the row can flip it to `radius`); `T` while hovering a face commits `thickness` at that point.
- On commit the kernel's value replaces the mesh readout. A dimension is drawn as a dimension line between `points` with extension ticks and the value on a chip beside its `M<n>` label; angles as an arc; diameters as a leader with `⌀`. User colour for the user's, agent colour for the agent's; a failing dimension's value chip is outlined in `--fail`, a passing one shows a small check.
- A dimension is created `draft` like any mark and is delivered with the next prompt. It is not "resolved" by default afterwards: the row offers "Pin" (stays, re-measured every build; this is the default for a dimension with an `expected`) and "Resolve".
- The row expands to `DimensionFields`: the value (read-only, full precision on hover), `how`, an "Expected" number and a "Tolerance" number (placeholders showing the defaults), and the verdict.
- Dimension marks are sanitised like the others; an old `marks.json` loads unchanged.

- [ ] **Step 1:** Store, file and describe tests for the new kind (sanitising, patching `expected`/`tolerance`, each `describeMark` form, verdict arithmetic at the tolerance boundary).
- [ ] **Step 2:** `measure.test.ts` (main) with a fake kernel: the request built from a mark's ends; the verdict; "not measurable" when the kernel answers `bad_ref`.
- [ ] **Step 3:** Renderer unit tests for the tool with a fake context (two picks → distance; curved face double click → diameter; `T` → thickness; cancel).
- [ ] **Step 4:** `e2e/measure.spec.ts` on the `measures` fixture: measure the plate's thickness (6, "between planes") and a hole (⌀ 8) with real pointer events; set expected 8.5 on the hole → the row shows fail and the picture's chip is outlined; the look picture shows both dimensions.
- [ ] **Step 5:** Design pass with `frontend-design:frontend-design`: gated shots of three dimensions (distance, diameter, angle; one failing) in light and dark and in a `look` picture; refine until values are legible at 1280 px and the part is still the loudest thing.
- [ ] **Step 6:** Suites; commit.

### Task 4: Dimensions re-measured on every build, and told to the agent

**Files:**
- Modify: `app/src/main/marks/reanchor.ts` (after anchors are judged, dimensions of that object are re-measured in the same pass), `measure.ts`, `store.ts`, `app/src/main/context.ts`, `statefile.ts`, their tests; `app/src/renderer/ui/BuildStatus.tsx` (a count of failing dimensions beside the build state); `app/e2e/measure.spec.ts`; fixture `kernel/tests/fixtures/ws/gauge/` (a plate whose thickness and hole size come from `variant.txt`)

Behaviour:
- After each successful build and after its re-anchoring: every unresolved dimension is re-measured from its (possibly refreshed) ends. A dimension with an end `orphaned` or with a kernel error is stored with no `value` and no `verdict`. One atomic write for all, under the same guard as re-anchoring (skip a mark whose ends changed since it was read).
- A dimension whose ends `drifted` is still measured, between the features now under its ends, and says `[moved since it was placed: check it]`.
- The prompt context gains, after the marks lines, a `Dimensions:` block listing every pinned (sent, unresolved) dimension that FAILS or is not measurable, one line each, every prompt until it passes; and a count of those passing (`4 pinned dimensions pass`). Draft dimensions are listed with the drafts as marks.
- `state.md` lists all pinned dimensions with values and verdicts.
- The status line shows `2 dimensions fail` in `--fail` when any does; clicking it scrolls the marks panel to the first.

- [ ] **Step 1:** `reanchor`/`measure` tests: re-measure after judging; orphaned end → no value; guard; one write.
- [ ] **Step 2:** `context.test.ts`: the Dimensions block (fail, not measurable, the passing count, within the limit).
- [ ] **Step 3:** e2e on `gauge`: pin thickness expected 6 and hole ⌀ expected 8; switch the variant to a 5 mm plate → after the build the thickness row and the status line show fail with "1 under"; the stand-in agent's hook prints the Dimensions block; switch back → pass and the block shows only the count (Review Focus 1 and 2).
- [ ] **Step 4:** Suites; commit.

### Task 5: Section cut in the viewport

**Files:**
- Create: `app/src/renderer/viewport/section.ts`, `section.test.ts`; `app/src/renderer/tools/sectionTool.ts`; `app/src/renderer/ui/SectionBar.tsx`; `app/e2e/section.spec.ts`
- Modify: `Viewport.ts`, `picture.ts`, `partMesh.ts` (materials take the clipping plane), `viewport/marks/*` (marks are not clipped; marks behind the cut stay drawn at their reduced opacity), `app/src/shared/view.ts`, `scenefile.ts` (both sides), `ViewportPane.tsx`, `ToolPalette.tsx`, `state/store.ts`

**Interfaces:**
- Produces `Viewport.setSection(plane: SectionPlane | null): void`, `Viewport.getSection()`, `ImageRequest.section`, and the pure helpers `planeFromFace(hit)`, `planeOnAxis(axis, bbox, t)`, `movedAlongNormal(plane, mm)`, `flipped(plane)`.

Behaviour:
- One section plane per object view. Everything on the side the normal points to is removed; the cut faces of each solid part are capped in the part's colour, slightly darkened, with a thin outline (three's stencil-cap method: per part, back faces increment and front faces decrement the stencil under the clip plane, then a plane-sized quad is drawn where the stencil is non-zero, with `renderOrder` so parts do not cap each other). Faceted (mesh-derived) parts and anything not closed are clipped without caps.
- Section tool (`X`): the bar appears at the bottom centre: X / Y / Z axis buttons (plane through the scene's centre), "From face" (the next click on a planar face puts the plane on it), a slider and a mm field for the offset along the normal across the scene's extent, "Flip", and "Off". Dragging in the viewport with the tool in hand moves the plane along its normal (a handle arrow at the plane's centre; `Alt`-drag still orbits). Arrow keys nudge by 1 mm, with `Shift` by 0.1.
- The plane is shown as a faint outline rectangle at the scene's extent; hidden in pictures.
- The section is part of the view: saved in `scene.json`, restored on open, reported in `ViewState`, applied in `look` pictures unless `section: null` is asked, settable by the agent's `show`.
- Picking and the mark tools work on what is visible: a click on a cap picks nothing (caps are not B-rep faces) and says "that is the cut face"; faces behind the removed half are not pickable.
- Rendering stays on demand; moving the plane redraws at most once per frame.

- [ ] **Step 1:** `section.test.ts`: the pure helpers (a face's plane; axis planes through the bbox centre; move and flip); the extent of the slider for a given bbox and normal.
- [ ] **Step 2:** `e2e/section.spec.ts`: on `bracket`, a Z section at half the post's height: the `look` picture from the top shows the post's cut disc in the post's colour (sample pixels at the projected centre) and the base uncut; flipping shows the other half; "From face" on the base's side puts the plane there; the section survives a reload (from `scene.json`); `look` with `section: null` is uncut; a pick on the cap returns nothing.
- [ ] **Step 3:** Design pass: gated shots of the bracket and of a hollow fixture cut through (light, dark, look); the caps must read as solid material and the bar as part of the same family of floating surfaces.
- [ ] **Step 4:** Suites; commit.

### Task 6: Exact sections and checks in the kernel

**Files:**
- Create: `kernel/src/torno_kernel/section.py`, `kernel/src/torno_kernel/checks.py`, `kernel/tests/test_section.py`, `kernel/tests/test_checks.py`
- Modify: `kernel/src/torno_kernel/queries.py` (dispatch)

Behaviour:
- `section`: for each requested part of the layout (default all), `BRepAlgoAPI_Section` (or build123d's `section`) with the plane; wires joined into loops; each loop discretised (`GCPnts_QuasiUniformDeflection`, 0.05 mm, capped at 2,000 points by raising the deflection) and expressed in the plane's own `x`/`y` (a stable right-handed pair derived from the normal: `x` along the world axis least aligned with the normal, projected; `y = normal × x`). Per loop `closed` and signed `area`; per part the summed area (outer minus holes) and the count of open loops. A part the plane misses is listed with no loops.
- `check overlap`: `(a & b)` volume and bbox, `null` bbox when the volume is below 1e-6 mm³.
- `check clearance`: `BRepExtrema_DistShapeShape`; `overlapping: true` when the solids intersect (overlap volume above 1e-6).
- `check mesh`: the part's own tessellation at the display tolerance, vertices welded at 1e-4 mm, edges used by exactly one triangle counted; up to 20 mid-points of open edges returned.
- All three are subject to the query deadline; `overlap` on large parts can be slow: a `bad_request` naming the deadline is acceptable, a hang is not.

- [ ] **Step 1:** `test_section.py`: bracket cut at z = 12.5 → one closed circular loop for `post` of area ≈ 50.27 and none for `base`; cut at z = 0 → a 40 × 30 rectangle of area 1200 for `base`; a hollow box → outer and inner loop, area = difference; a plane that misses; loops are in plane coordinates (check a known corner).
- [ ] **Step 2:** `test_checks.py`: two boxes overlapping by 10 × 10 × 5 → 500; apart by 3 → clearance 3 with points; touching → 0, not overlapping; mesh of a closed box → watertight; of a deliberately open shell (a box with a face removed, as a shell) → open edges 4 with their mid-points.
- [ ] **Step 3:** Implement; suites; commit.

### Task 7: The agent's tools for reading

**Files:**
- Create: `app/src/main/mcp/readTools.ts`, `readTools.test.ts`; `app/src/renderer/viewport/sectionDrawing.ts` (a 2D drawing of kernel outlines), `sectionDrawing.test.ts`
- Modify: `app/src/main/mcp/tools.ts` (register), `markTools.ts` (`add_mark` accepts `kind: 'dimension'`), `server.itest.ts`, `app/src/main/prompt.ts`, `app/src/main/look.ts`, `app/src/shared/{bridge,view}.ts`, `preload`, `ipc.ts`, `ViewportPane.tsx`/`state/agent.ts` (`show` and `look` with `section`), `app/e2e/mcp.spec.ts`

Tools:
- `measure({ kind, a, b?, density?, layout? })` → the kernel's reply as JSON plus a one-line reading (`6 mm between planes, base/F5 to base/F0`); `a` and `b` are refs, mark ids (`M3`: the mark's anchor) or `{point: [x, y, z]}`. Carries `revision` and the stale note.
- `section({ plane, parts?, layout?, size? })` where `plane` is `{origin, normal}` or `{axis: 'x' | 'y' | 'z', at: number}` or `'current'` (the user's own) → an image and JSON. The image is a 2D drawing made by the renderer from the kernel's outlines (not a screenshot): each part's loops filled in its colour with a hairline outline, a millimetre grid with labelled axes in the plane's `u`/`v`, the plane's description as the title, and the bounding dimensions of the whole cut written on two sides. The JSON is the kernel's reply with loops cut to 200 points each (the full outline is available by asking for one part).
- `check({ kind: 'overlap' | 'clearance' | 'mesh', a, b?, layout? })` → the kernel's reply as JSON and a one-line reading.
- `add_mark` with `kind: 'dimension'`: `measure`, `a`, `b?`, `expected?`, `tolerance?`, `note` → measured at once, authored by the agent; this is how the agent proposes a check the user can see.
- `look` and `show` accept `section` (`{origin, normal}`, `{axis, at}`, `null`); `scene` reports the user's section.
- The system prompt gains: measure before claiming a size; pinned dimensions with an expectation are the user's acceptance checks, and failing ones are listed with every prompt; `section` gives exact outlines, `look` with a section gives the picture the user sees.

- [ ] **Step 1:** `readTools.test.ts` with fake deps: each tool's reading line, the `M<n>` and point targets, error texts (unknown ref lists valid ones; stale note; the object not open for `section: 'current'`).
- [ ] **Step 2:** `sectionDrawing.test.ts`: the drawing's scale and bounds for known loops; holes are holes (even-odd fill); the labelled extents.
- [ ] **Step 3:** `e2e/mcp.spec.ts` through a real MCP client on `measures`: `measure` thickness → 6; `section` with `{axis: 'z', at: 3}` → an image with the plate's outline and two holes (pixels at a hole centre are background) and JSON with one part, three loops; `check clearance` between two parts of `bracket`; `add_mark` dimension with expected → appears in the panel as the agent's with its verdict; `show` with a section cuts the user's view.
- [ ] **Step 4:** Suites; commit.

### Task 8: A real check, the owner's objects, docs

- [ ] **Step 1:** One real check with the real CLI, hidden, sonnet, on a temp copy of the fixtures with `gauge` open and two pinned dimensions (thickness expected 8, currently 6 → failing; hole ⌀ expected 8 → passing): one prompt, `One of my pinned dimensions fails. Which, by how much, and what would you change in the model? Use measure and section to confirm before answering. Do not edit any file.` Record the context the hook sent, the tool calls made, and the answer.
- [ ] **Step 2:** Hidden sweep on a temp copy of `micra-intake` (as in Milestone 2's last task: copy `common`, `micra-intake`, `pyproject.toml`, `uv.lock`, symlink `.venv`): measure the tub's wall thickness at three places and the lid's overall bbox; cut the tub and lid with an X section through the middle and save `look` pictures; ask the kernel for the same `section` and save the 2D drawing; time `section`, `check mesh` on each part and `check clearance` lid ↔ tub; look at every picture. Report times, values and anything that reads badly. Nothing is written under `/home/luisgonc/objects`.
- [ ] **Step 3:** README and CLAUDE.md: measuring, dimensions and expectations, the section, the three tools, units and exactness.
- [ ] **Step 4:** All suites; commit.

## Order

Task 1 (carried fixes and kernel `measure`) and Task 2 (the split) are independent. Task 3 needs both. Task 4 needs 3. Task 5 needs 2. Task 6 is kernel-only and independent of 3 to 5. Task 7 needs 4, 5 and 6. Task 8 is last.

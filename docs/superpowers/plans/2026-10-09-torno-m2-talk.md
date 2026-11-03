# Torno Milestone 2 "Talk" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user points at geometry, places marks (pin, pick, arrow, stroke, shape) with notes, and the agent receives them as data with the next prompt; the agent can describe geometry, highlight it, move the user's view, and place and resolve marks itself.

**Architecture:** Main owns marks per object (`.torno/marks.json`) and mirrors them to the renderer. The viewport picks faces and edges with a BVH and draws marks as 3D objects with numbered labels, on screen and in `look` pictures. The kernel keeps one live worker per object and answers `describe` and `nearest`, which main uses to describe anchors and to re-anchor marks after each build. The `UserPromptSubmit` hook lists draft marks; six new MCP tools read and write them.

**Tech Stack:** as Milestone 1, plus three-mesh-bvh (already installed) and three's `TransformControls` and fat lines (`Line2`).

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md`, sections 4 (geometry identity), 5 (marks), 6 (agent link), 7 (viewport), 10 (design language). Dimension and region marks, pinned dimensions, `measure`, `section` and `check` are Milestone 3 and 4.

Read `CLAUDE.md` first: test commands, global constraints, kernel invariants, hidden-window rules. They bind every task.

How this plan is written: each task gives files, exact interfaces and the tests to write. Write each listed test first, watch it fail, then implement.

## Global Constraints

- Everything in `CLAUDE.md` "Global constraints" and "Kernel invariants".
- Coordinates in marks, refs, tools and files are millimetres in the object frame of the layout the mark belongs to, Z up.
- A ref is `<part>` | `<part>/F<i>` | `<part>/E<i>` | `M<n>`, resolved in a named layout. On the wire to the kernel it is prefixed: `<layout>:<part>/F<i>`.
- Mark ids are `M1`, `M2`, … per object, never reused, assigned by main only.
- User marks are drawn in `--user-mark`, agent marks in `--agent-mark`. Nothing else in the UI uses those two colours.
- No per-pointer-move state in React or Zustand: hover and drag live in the viewport.
- Main is the only writer of `.torno/marks.json`; writes are atomic (temp file then rename) and serialised per file.
- The agent is told nothing it cannot rely on: a mark whose anchor drifted or was orphaned says so wherever it is reported.
- Tests never call the real `claude` CLI and never open a visible window.

## Review Focus

1. **A mark placed, then the model rebuilt with different topology.** Expected: the mark stays at its point in space, its ref is refreshed to the face now there, and it is flagged `drifted` when the surface moved away or `orphaned` when the part is gone; the agent is told. Tests in Tasks 1 and 8.
2. **A prompt sent while marks are still drafts, twice in a row.** Expected: the first prompt carries them and turns them `sent`; the second does not repeat them. A prompt in another object's session does not consume them. Tests in Task 9.
3. **Picking through hidden or translucent layers, and on a stale build.** Expected: hidden parts are never picked; picks on a stale build are refused with a plain message, since their refs would be wrong. Tests in Task 3.
4. **Two objects open, queries for each.** Expected: `describe` and `nearest` answer about the object asked for, whichever built last. Test in Task 1.
5. **A stroke of thousands of points, or fifty marks.** Expected: strokes are simplified on commit (0.2 mm tolerance, at most 400 points); the prompt context stays within its limit and says how many marks it left out and how to get them. Tests in Tasks 6 and 9.

## Shared contracts

### Marks (`app/src/shared/marks.ts`)

```ts
import type { Camera } from './view'
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]            // x y z w

export interface Anchor {
  point: Vec3
  normal?: Vec3
  part?: string            // part name; absent for a point in empty space
  ref?: string             // `lid` | `lid/F12` | `lid/E3`, refreshed after each build
  descriptor?: string      // from the kernel: "plane, normal +Z, z = 20, 1180 mm²"
}
export type MarkStatus = 'draft' | 'sent' | 'resolved'
export type AnchorState = 'ok' | 'drifted' | 'orphaned'
export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'plane'
export type ShapeIntent = 'add' | 'remove' | 'keep-out' | 'reference'

interface MarkBase {
  id: string               // 'M3'
  author: 'user' | 'agent'
  note: string
  status: MarkStatus
  anchorState: AnchorState
  layout: string
  revision: number         // build it was placed on
  camera: Camera           // the view it was placed from
  createdAt: string        // ISO
  resolvedNote?: string
}
export interface PinMark extends MarkBase { kind: 'pin'; anchor: Anchor }
export interface PickMark extends MarkBase { kind: 'pick'; target: 'face' | 'edge' | 'part'; anchor: Anchor }
export interface ArrowMark extends MarkBase { kind: 'arrow'; from: Anchor; to: Vec3 }
export interface StrokeMark extends MarkBase {
  kind: 'stroke'
  space: 'surface' | 'plane'
  anchor: Anchor                                         // first point
  points?: Vec3[]                                        // surface strokes
  plane?: { origin: Vec3; x: Vec3; y: Vec3; label: string }   // label: "XZ at y = 40.0"
  points2d?: [number, number][]                          // plane strokes, mm in plane axes
}
export interface ShapeMark extends MarkBase {
  kind: 'shape'
  shape: ShapeKind
  intent: ShapeIntent
  position: Vec3
  rotation: Quat
  size: Vec3               // box: x y z; cylinder: diameter, diameter, height; sphere: diameter ×3; plane: width, height, 0
  anchor?: Anchor          // where it was first placed
}
export type Mark = PinMark | PickMark | ArrowMark | StrokeMark | ShapeMark
export type MarkKind = Mark['kind']
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** What a caller supplies; main adds id, status, anchorState, createdAt. */
export type NewMark = DistributiveOmit<Mark, 'id' | 'status' | 'anchorState' | 'createdAt'>
export type MarkPatch = Partial<Pick<MarkBase, 'note' | 'status' | 'resolvedNote'>> &
  Partial<Pick<ShapeMark, 'intent' | 'position' | 'rotation' | 'size' | 'shape'>>
export interface MarksFile { next: number; marks: Mark[] }
```

### Bridge additions (`app/src/shared/bridge.ts`)

```ts
marks: {
  list(objectId: string): Promise<Mark[]>
  add(objectId: string, mark: NewMark): Promise<Mark>
  update(objectId: string, id: string, patch: MarkPatch): Promise<Mark>
  remove(objectId: string, id: string): Promise<void>
  onChanged(cb: (m: { objectId: string; marks: Mark[] }) => void): () => void
}
geometry: {
  describe(objectId: string, layout: string, ref: string): Promise<Described>   // rejects with a plain message
}
view: {                                   // added to the existing group
  onShow(cb: (m: ShowRequest) => void): () => void
  onHighlight(cb: (m: { objectId: string; layout: string; refs: string[]; note?: string }) => void): () => void
}
session: {                                // added to the existing group
  insert(sessionId: string, text: string): void     // bracketed paste at the cursor, never submitted
}
```

`Described` is the kernel's `describe` reply plus `descriptor: string`. `ShowRequest` is `{ objectId: string; view?: ViewName | Camera; layout?: string; parts?: string[] }`.

### Kernel protocol changes

- `query` requests carry `dir` (the object folder): `{"id": 7, "op": "query", "dir": "/abs/object", "name": "describe", "args": {...}}`. The supervisor keeps one live worker per `dir`, at most 4, retiring the least recently used. `no_build` when that `dir` has none.
- `describe` replies gain `descriptor` (one line, see Task 1).
- New query `nearest`, args `{"layout": "assembly", "anchors": [{"part": "lid", "point": [x, y, z]}, ...]}`, reply `{"anchors": [{"part": "lid", "found": true, "point": [...], "normal": [...] | null, "ref": "lid/F12", "distance": 0.0, "descriptor": "..."} | {"part": "gone", "found": false}]}`.

---

### Task 1: Kernel: a live worker per object, descriptors, `nearest`

**Files:**
- Modify: `kernel/src/torno_kernel/supervisor.py`, `queries.py`, `worker.py`; `kernel/tests/test_supervisor.py`, `kernel/tests/kclient.py`
- Create: `kernel/src/torno_kernel/describe.py`, `kernel/tests/test_queries.py`
- Modify: `app/src/main/kernel/client.ts`, `fake-kernel.mjs`, `client.test.ts`, `client.itest.ts`; `app/src/main/builds.ts` (pass the object's folder with every query)

**Interfaces:**
- Produces the protocol changes above.
- Produces `KernelClient.query<T>(dir: string, name: string, args: object): Promise<T>` (signature change: `dir` first) and `Builds.query<T>(objectId: string, name: string, args: object): Promise<T>`, which rejects with `KernelError('no_build', …)` when the object has no successful build.
- Produces `describe.descriptor(kind, facts) -> str`:
  - face: `"plane, normal +Z, z = 20, 1180 mm²"`; a plane names the axis when the normal is within 0.5° of one, with the coordinate it sits at, otherwise `normal (0.71, 0, 0.71)`; `"cylinder, radius 4, axis Z, 502.7 mm²"`; other types `"bspline, 913.2 mm²"`.
  - edge: `"line, 40 mm"`, `"circle, radius 4, 25.1 mm"`, other `"bspline, 31.4 mm"`.
  - part: `"part, 40 × 30 × 5 mm, 6000 mm³, 6 faces"`.
  - Numbers use at most 4 significant digits and no trailing zeros.

Behaviour:
- The supervisor's single `_live` becomes a map `dir → worker` with an order list. A successful build for `dir` replaces only that folder's worker. A fifth folder retires the least recently used (used = built or queried). All workers die at shutdown as before.
- A build still runs one at a time; cancelling a build does not touch any live worker.
- `nearest`: for each anchor, the part's shape in that layout; `BRepExtrema_DistShapeShape(vertex, shape)`; the support face (or, on an edge, the first adjacent face by index) gives `ref` and `normal` at the nearest point; `distance` in mm. A part missing from the layout gives `found: false`. An unknown layout is `bad_ref` naming the layouts.
- Queries for the M1 "fix before Milestone 2" list, done here: a worker result and a query reply readable in the same round are handled live-first, so a received reply is never turned into `cancelled`; every query has a 30 s deadline, after which it replies `timeout` and the worker is left alone.

- [ ] **Step 1:** `test_queries.py` (in-process, on fixture shapes): descriptors for a plane on each axis, a tilted plane, a cylinder, a line, a circle, a part; `nearest` for a point 3 mm above the bracket base top face returns that face's ref, `distance` 3 and normal +Z; a point beside the post returns the cylindrical face; a missing part returns `found: false`.
- [ ] **Step 2:** `test_supervisor.py` additions: build `bracket` then `plain`; `describe` with `dir` of each answers about that one (Review Focus 4); a query for a folder never built is `no_build`; after building five folders the first is `no_build` and the other four answer; `nearest` over the protocol; a `describe` reply carries `descriptor`.
- [ ] **Step 3:** Client and `Builds`: `client.test.ts` for the new signature against the fake kernel; `client.itest.ts`: two objects built, each queried; `builds.test.ts`: `Builds.query` passes the object's folder and rejects `no_build` before a first success.
- [ ] **Step 4:** Run the kernel suite and the app's unit and kernel-integration suites; commit.

### Task 2: Marks model and store in main

**Files:**
- Create: `app/src/shared/marks.ts`, `app/src/main/marks/store.ts`, `app/src/main/marks/file.ts`, `app/src/main/marks/store.test.ts`, `app/src/main/marks/file.test.ts`
- Modify: `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/ipc.ts`, `app/src/main/index.ts`, `app/src/renderer/state/store.ts`, `store.test.ts`, `app/src/renderer/env.d.ts`

**Interfaces:**
- Produces `shared/marks.ts` exactly as in "Shared contracts", plus `markAnchors(mark): Anchor[]` (the anchors a mark carries: one for pin, pick and stroke; `from` for an arrow; `anchor` if present for a shape).
- Produces:

```ts
export class MarkStore {
  constructor(deps: { dirOf(objectId: string): string | undefined; now?(): Date })
  list(objectId: string): Promise<Mark[]>
  add(objectId: string, mark: NewMark): Promise<Mark>
  update(objectId: string, id: string, patch: MarkPatch): Promise<Mark>
  remove(objectId: string, id: string): Promise<void>
  /** Replaces anchors and anchor states in one write; ids not listed are untouched. */
  reanchor(objectId: string, changes: Array<{ id: string; anchors: Anchor[]; anchorState: AnchorState }>): Promise<void>
  /** Turns every draft of the object into sent; returns the marks that changed. */
  markSent(objectId: string): Promise<Mark[]>
  on(event: 'changed', cb: (m: { objectId: string; marks: Mark[] }) => void): void
}
```

Behaviour:
- `.torno/marks.json` is `MarksFile`. A missing file is `{ next: 1, marks: [] }`. A corrupt file is kept aside as `marks.json.corrupt-<timestamp>` and a fresh one started; the status line says so once (emit a `problem` event the renderer shows as a toast-free line in the marks panel).
- Marks are sanitised on read and on write: unknown kinds dropped, numbers finite, notes cut at 2000 characters, strokes cut at 400 points.
- `update` rejects an unknown id with "no mark M9; marks: M1, M2". Status may only move `draft → sent → resolved`, or to `resolved` from anywhere, or back to `draft` by an explicit patch (the user reopening it).
- The renderer store gains `marks: Mark[]` for the open object, loaded on `object.open` and replaced on `onChanged`.
- `geometry.describe`, `view.onShow`, `view.onHighlight` and `session.insert` are declared in the bridge here and backed in the tasks that use them (3, 9, 3); until then they reject with "not implemented".

- [ ] **Step 1:** `file.test.ts`: round trip; missing file; corrupt file kept aside; sanitising; atomic write leaves no temp file.
- [ ] **Step 2:** `store.test.ts`: ids `M1`, `M2`, never reused after a remove; status transitions; `markSent` changes only drafts and emits once; `reanchor` in one write; unknown id message; two objects do not mix; concurrent adds get distinct ids.
- [ ] **Step 3:** Renderer `store.test.ts`: marks load on open and follow `onChanged`; switching object swaps them.
- [ ] **Step 4:** Run suites; commit.

### Task 3: Picking, selection, describe, insert ref

**Files:**
- Create: `app/src/renderer/viewport/picking.ts`, `picking.test.ts`, `highlight.ts`; `app/src/renderer/ui/Selection.tsx`, `ToolPalette.tsx`; `app/src/renderer/state/tools.ts`
- Modify: `app/src/renderer/viewport/Viewport.ts`, `partMesh.ts`; `app/src/renderer/ui/ViewportPane.tsx`; `app/src/main/ipc.ts`, `app/src/preload/index.ts` (back `geometry.describe`, `session.insert`); `app/src/main/sessions/manager.ts` (`insert`); `app/e2e/pick.spec.ts`

**Interfaces:**
- Produces:

```ts
// picking.ts
export interface Hit { partKey: string; part: string; kind: 'face' | 'edge'; index: number; ref: string; point: Vec3; normal: Vec3 | null; distance: number }
export function edgeOfSegment(edgeStarts: Uint32Array, segment: number): number
export function refOf(part: string, kind: 'face' | 'edge', index: number): string
// Viewport additions
pick(clientX: number, clientY: number, opts?: { edges?: boolean }): Hit | null     // visible parts of the current layout only
setHover(hit: Hit | null): void
setSelection(refs: string[]): void              // drawn in --accent
setAgentHighlight(refs: string[]): void         // drawn in --agent-mark (used by Task 9)
onPointer(cb: (e: { type: 'move' | 'down' | 'up' | 'click' | 'cancel'; hit: Hit | null; ray: { origin: Vec3; direction: Vec3 }; client: [number, number]; buttons: number; shift: boolean }) => void): void
setNavigation(enabled: boolean): void           // tools switch orbiting off while they drag
```

- Produces `Sessions.insert(sessionId, text)`: writes `ESC[200~` + text with control characters removed + `ESC[201~`, no newline.
- Produces the tool state (`tools.ts`, Zustand): `tool: 'select' | 'pin' | 'arrow' | 'draw' | 'shape'`, `setTool`.

Behaviour:
- Each part mesh gets a `three-mesh-bvh` bounds tree when built (`computeBoundsTree`), reused while the part's hash is unchanged. Faces are hit by raycast; the triangle maps to a face through `faceOfTriangle`. Edges are hit when the pointer is within 6 px of a segment in screen space and that segment is not behind a nearer face by more than 0.5 mm; an edge within reach wins over the face under it.
- Hover tints the face or thickens the edge, in the viewport only. A one-line readout near the pointer shows the ref and, after 150 ms of rest, the kernel's descriptor (cached per revision and ref).
- Select tool (`V`, the default): click selects, `Shift`-click adds, click on nothing clears, `Esc` clears. The selection appears as a chip row at the bottom centre of the viewport: ref in the mono face, descriptor, and two actions: "Insert" (inserts the refs, space separated, into the object's running session; disabled with a tooltip when none runs) and "Note" (Task 5 turns it into a pick mark).
- Picking is refused on a stale build: the readout says "Rebuilding: picks wait for the new build" and nothing is selected (Review Focus 3). Hidden layers are never hit; a layer with opacity below 1 is hit normally.
- The tool palette floats at the left edge of the viewport, vertically centred: five buttons with icons and single-key shortcuts (`V`, `P`, `A`, `D`, `S`); this task enables only Select and shows the others disabled until their tasks land. The shortcuts obey the same focus rule as the view keys.
- Left drag still orbits in the Select tool; a click is a press and release within 4 px and 400 ms.

- [ ] **Step 1:** `picking.test.ts`: `edgeOfSegment` at boundaries and with zero-segment edges; `refOf`; a pure `pickEdge(segmentsScreen, pointer, radius)` helper chooses the nearest segment within the radius and none beyond it.
- [ ] **Step 2:** `manager.itest.ts` addition: `insert` puts the text at the fake agent's input without a newline, strips `ESC` and control characters, and does nothing for an exited session.
- [ ] **Step 3:** `e2e/pick.spec.ts` (hidden window, fixture copy): through `__tornoTest` expose `pickAt(x, y)` in canvas fractions and `project(point)`; picking the centre of the bracket's top face in top view returns `base/F<i>` with normal +Z; picking with `post` hidden never returns `post`; a click selects and the chip shows the ref and a descriptor containing "plane"; "Insert" with the fake agent running puts the ref in the terminal; on a stale build the pick is refused.
- [ ] **Step 4:** Run suites; commit.

### Task 4: Drawing marks, and the marks panel

**Files:**
- Create: `app/src/renderer/viewport/marks/MarkLayer.ts`, `markObjects.ts`, `labels.ts`, `markObjects.test.ts`; `app/src/renderer/ui/MarksPanel.tsx`, `MarkRow.tsx`
- Modify: `Viewport.ts` (owns a `MarkLayer`; `setMarks(marks, layout)`; marks and labels in `renderImage` when asked), `overlay.ts`, `ViewportPane.tsx`, `App.tsx`, `styles/app.css`, `app/src/shared/view.ts` (`LookRequest.marks?: boolean`), `app/e2e/marks.spec.ts`

**Interfaces:**
- Produces `Viewport.setMarks(marks: Mark[]): void`, `Viewport.focusMark(id: string): void` (moves the camera to the mark's stored camera), `Viewport.setActiveMark(id: string | null): void`, and `ImageRequest.marks: boolean`.
- Produces `markObjects.build(mark, colours, scale): THREE.Object3D` and `labels.project(marks, camera, size): Array<{ id: string; x: number; y: number; visible: boolean }>` (pure).

Behaviour:
- Only marks of the current layout that are not `resolved` are drawn; resolved ones appear in the panel under a collapsed "Resolved" heading.
- Pin: a 3 px-equivalent dot on the surface and a short leader along the normal ending in the label. Pick: the face or edge tinted in the author's colour, with the label at its anchor. Arrow: shaft and head from `from.point` to `to`. Stroke: a fat line (`Line2`, 2.5 px) through its points; a plane stroke also shows its plane as a faint rectangle while it is the active mark. Shape: a translucent solid (opacity 0.25) with outline; `remove` and `keep-out` are hatched by a dashed outline, `reference` is grey.
- Marks keep a constant apparent size where that matters (dots, arrow heads, line width) and are drawn after the parts with depth testing relaxed so they are never buried, but a mark behind the part is drawn at 35% opacity.
- Labels (`M3`) are drawn in a 2D overlay on screen and in the composited picture, in the mono face on a small rounded chip of the author's colour; `drifted` marks get a `~` suffix and `orphaned` a `?`.
- Marks panel, in the left column below Layers: a row per mark with its id chip, a kind icon, the note (click to edit in place, `Enter` saves, `Esc` cancels), a status word (`draft` in the accent, `sent` muted), and on hover: focus, resolve, delete. Clicking a row makes it the active mark and focuses it. An empty panel says "Point at the part to leave a note for the agent." with the tool keys.
- `look` pictures draw marks unless `marks: false`.

- [ ] **Step 1:** `markObjects.test.ts`: each kind builds without WebGL and with the expected child objects; an arrow's length equals `|to − from|`; a plane stroke's 3D points equal `origin + x·u + y·v`; `labels.project` hides labels behind the camera and outside the frame.
- [ ] **Step 2:** `e2e/marks.spec.ts`: add a pin and an arrow through `window.torno.marks.add`; the panel lists `M1`, `M2`; a `look` with marks differs from one with `marks: false` in pixels near the projected anchor; editing the note in the panel persists to `.torno/marks.json`; resolving moves the row under "Resolved" and removes it from the picture; deleting removes it from the file; switching layout hides marks of the other layout.
- [ ] **Step 3:** Design pass with the `frontend-design:frontend-design` skill: take the gated design shots (light and dark) with five marks of all kinds on the bracket, look at them, and refine sizes, label chips and panel rows until the part is still the loudest thing on screen.
- [ ] **Step 4:** Run suites; commit.

### Task 5: Pin, pick and arrow tools, and the note popover

**Files:**
- Create: `app/src/renderer/tools/Tool.ts`, `pinTool.ts`, `arrowTool.ts`, `tools.test.ts`; `app/src/renderer/ui/NotePopover.tsx`
- Modify: `ToolPalette.tsx`, `Selection.tsx`, `ViewportPane.tsx`, `app/e2e/tools.spec.ts` (new)

**Interfaces:**
- Produces `interface Tool { id: string; cursor: string; onPointer(e, ctx): void; onKey?(e, ctx): boolean; cancel(ctx): void }` and a `ToolContext` giving the viewport, the store's open object, layout, revision and camera, `describe(ref)`, and `commit(mark: NewMark): Promise<Mark>`.
- Produces `anchorFromHit(hit, describe): Promise<Anchor>` (fills `descriptor`; a failed describe leaves it out).

Behaviour:
- Pin (`P`): click on a part places a pin there and opens the note popover at it. Click on empty space does nothing.
- Pick: the Select chip's "Note" action turns the selection into one pick mark per selected ref and opens the popover on the first.
- Arrow (`A`): press on a part, drag, release. While dragging, the head follows the pointer on the plane through the start point facing the camera; with `Shift` held it snaps to the surface normal at the start, or to the nearest principal axis when within 15° of one. A live readout shows the length in mm and the vector. A drag shorter than 4 px is cancelled.
- The note popover is a small card anchored to the mark with one text field (placeholder "What should change here?"), `Enter` to save, `Esc` to keep the mark with an empty note, and a delete button. It never covers the mark itself: it sits on the side with more room.
- After a mark is committed the tool stays active (place several pins in a row); `Esc` or `V` returns to Select.
- Tools are refused on a stale build with the same message as picking.

- [ ] **Step 1:** `tools.test.ts` with a fake context: the pin tool commits a `pin` with the hit's point, normal, part and ref, the current layout, revision and camera; the arrow tool commits `from` and `to` and cancels a 2 px drag; `Shift` snaps to the normal; nothing is committed on a stale build.
- [ ] **Step 2:** `e2e/tools.spec.ts`: press `P`, click the bracket's top face (pointer events on the canvas), type a note, `Enter`; `marks.json` holds a pin with that note, a ref on `base`, and a descriptor; drag an arrow and check its length against the projected points within 5%; `Esc` returns to Select.
- [ ] **Step 3:** Run suites; commit.

### Task 6: Draw tool

**Files:**
- Create: `app/src/renderer/tools/drawTool.ts`, `simplify.ts`, `planes.ts`, `draw.test.ts`
- Modify: `ToolPalette.tsx`, `ViewBar.tsx` (shows the lock state), `app/e2e/tools.spec.ts`

**Interfaces:**
- Produces `simplify(points, tolerance, max): points` (Ramer–Douglas–Peucker, then uniform thinning to `max`), for 2D and 3D; `viewPlane(camera, through: Vec3): { origin, x, y, label }` where `x` is the view's right and `y` its up, and `label` names the principal plane and its offset when the view direction is within 0.5° of an axis (`"XZ at y = 40.0"`), otherwise `"view plane"`.

Behaviour:
- Draw (`D`) has two modes, chosen by where the stroke starts and whether the view is locked:
  - **On the surface:** the stroke starts on a part in a free view. Each sampled pointer position is ray-cast; samples that miss are skipped. The result is a `surface` stroke of 3D points.
  - **On a plane:** the view is one of the orthographic named views (the view bar shows a small lock on that view's button; orbiting leaves the lock). The stroke lies on the view plane through the first hit point, or through the centre of the scene's bounding box when it starts in empty space. The result is a `plane` stroke with `points2d` in mm.
- Sampling is every 3 px of pointer travel. On release the stroke is simplified with a 0.2 mm tolerance to at most 400 points (Review Focus 5); a stroke of fewer than 2 points is cancelled.
- The note popover opens at the stroke's first point.
- While drawing, navigation is off; the mouse wheel still zooms.

- [ ] **Step 1:** `draw.test.ts`: `simplify` keeps the ends, removes collinear points, honours `max`; `viewPlane` for front view through (0, 40, 0) gives label `"XZ at y = 40.0"`, `x = +X`, `y = +Z`; plane coordinates round-trip to 3D.
- [ ] **Step 2:** e2e: in front view, draw a three-segment stroke in empty space beside the bracket; `marks.json` holds a `plane` stroke labelled `XZ at y = …` whose `points2d` extents match the drag within 5%; in iso view draw across the base's top face and get a `surface` stroke whose points all have z = 2.5 within 0.01.
- [ ] **Step 3:** Run suites; commit.

### Task 7: Shape tool

**Files:**
- Create: `app/src/renderer/tools/shapeTool.ts`, `shape.test.ts`; `app/src/renderer/ui/ShapeFields.tsx`
- Modify: `ToolPalette.tsx`, `MarkRow.tsx`, `markObjects.ts`, `Viewport.ts` (a `TransformControls` gizmo bound to the active shape mark), `app/e2e/tools.spec.ts`

**Interfaces:**
- Produces `Viewport.editShape(id: string | null, mode: 'translate' | 'rotate' | 'scale', onChange: (t: { position: Vec3; rotation: Quat; size: Vec3 }) => void): void`.
- Produces `defaultShape(kind, hit, sceneSize): Pick<ShapeMark, 'position' | 'rotation' | 'size'>`: sized at 15% of the scene's diagonal rounded to a whole millimetre, sitting on the surface with its Z along the hit normal (a plane lies in the surface).

Behaviour:
- Shape (`S`): the palette button opens a small choice of box, cylinder, sphere, plane (last one remembered). Click on a part places the shape there with intent `add`; click in empty space places it at the centre of the view on the ground plane.
- The placed shape is the active mark with a gizmo. `G`, `R`, `T` switch between move, rotate and scale while a shape is active; dragging updates the viewport every frame and commits one `marks.update` on release.
- The mark row for a shape expands to `ShapeFields`: intent (four segmented choices), position, rotation as Euler degrees, and size, all editable numbers in the mono face with mm; edits commit on blur or `Enter`.
- Scale changes `size`, never a scale factor: the stored shape is always exact millimetres.

- [ ] **Step 1:** `shape.test.ts`: `defaultShape` on a +Z face sits flush (bottom at the hit point), has whole-millimetre sizes, and aligns Z to the normal for a tilted face; size edits clamp at 0.1 mm.
- [ ] **Step 2:** e2e: place a box on the base, set intent to `remove` and size to 10 × 10 × 4 through the fields; `marks.json` holds exactly those numbers; a `look` shows it (pixels differ near its projected centre).
- [ ] **Step 3:** Run suites; commit.

### Task 8: Re-anchoring after builds

**Files:**
- Create: `app/src/main/marks/reanchor.ts`, `reanchor.test.ts`
- Modify: `app/src/main/index.ts` (wire `Builds` scene events to re-anchoring), `app/src/main/ipc.ts`, `MarkRow.tsx` (state badge), `app/e2e/reanchor.spec.ts`; fixtures: `kernel/tests/fixtures/ws/morph/morph.py`

**Interfaces:**
- Consumes `Builds.query(objectId, 'nearest', …)`, `MarkStore.reanchor`, `markAnchors`.
- Produces `reanchorAll(deps: { marks: MarkStore; query: Builds['query']; scene(objectId): Scene | undefined }, objectId: string): Promise<void>` and the pure `judge(anchor, nearest, tolerance): { anchor: Anchor; state: AnchorState }`.

Behaviour:
- After every successful build of an object, for each layout that has unresolved marks, one `nearest` query with all their anchors that name a part.
- `judge`: part not found → `orphaned`, anchor kept as it was. Found with `distance <= tolerance` → `ok`, with `ref`, `normal` and `descriptor` refreshed and the point left where the user put it. Beyond tolerance → `drifted`, same refresh. Tolerance is `max(0.5 mm, 0.5% of the part's bounding-box diagonal)`.
- A mark's state is the worst of its anchors. Anchors with no part (points in space, plane strokes started in empty space, shapes placed in space) are always `ok`.
- A failed or timed-out query leaves marks untouched and logs once.
- The row shows `drifted` as "moved: check it" in `--warn` and `orphaned` as "its part is gone" in `--fail`; both offer "Re-place" (activates the pin tool to click a new spot for that mark, keeping id and note) and resolve.
- `morph.py` reads an environment-free switch from a sibling file `variant.txt` (`a` or `b`): `a` is a 40 × 30 × 5 plate with a post; `b` is the same plate 8 mm thick with a chamfer (different face count) and no post.

- [ ] **Step 1:** `reanchor.test.ts`: `judge` for each case and the tolerance rule; `reanchorAll` sends one query per layout, skips resolved marks, writes once, and leaves marks alone when the query rejects.
- [ ] **Step 2:** `e2e/reanchor.spec.ts`: on `morph` variant `a`, pin the top face and pin the post; switch to `b`; after the build the first pin is `drifted` (the top moved 3 mm) with a ref on the plate, the second is `orphaned`; both rows say so (Review Focus 1). Switch back to `a`: both return to `ok`.
- [ ] **Step 3:** Run suites; commit.

### Task 9: The agent's side

**Files:**
- Create: `app/src/main/marks/describe.ts`, `describe.test.ts`; `app/src/main/statefile.ts`, `statefile.test.ts`
- Modify: `app/src/main/context.ts`, `context.test.ts`, `app/src/main/mcp/tools.ts`, `tools.test.ts`, `server.itest.ts`, `app/src/main/prompt.ts`, `app/src/main/sessions/manager.ts` (context is asked per session's object and marks are consumed there), `app/src/main/index.ts`, `app/src/main/ipc.ts`, `ViewportPane.tsx` (answers `onShow`, `onHighlight`), `app/e2e/mcp.spec.ts`

**Interfaces:**
- Produces `describeMark(mark): string`, one line:
  - `M3 pin on lid/F12 (plane, normal +Z, z = 20, 1180 mm²) at (12, 40.5, 20): "this edge is ugly"`
  - `M4 pick of base/E7 (line, 40 mm): "round this"`
  - `M5 arrow from lid/F3 (…) at (0, 10, 5) by (0, 14.2, 0), 14.2 mm: "move this wall out"`
  - `M6 stroke on plane XZ at y = 40.0, 23 points, 60 × 35 mm: "profile like this"` (points through the `marks` tool)
  - `M7 box 10 × 10 × 4 mm at (5, 5, 4.5), intent remove: "pocket here"`
  - A drifted mark appends ` [moved since it was placed: check it]`; an orphaned one ` [its part is gone]`; an agent's own mark is prefixed `(yours)`.
- Produces new `ToolDeps` members: `marks(objectId)`, `addMark`, `updateMark`, `describe(objectId, layout, ref)`, `show(objectId, req)`, `highlight(objectId, layout, refs, note?)`.

Behaviour:
- **Prompt context.** `CONTEXT_LIMIT` rises to 6000. After the build line, when the object has draft marks: a line `Marks from the user (drawn in look pictures with these numbers):` and one `describeMark` line each, oldest first. If they do not fit, the oldest that fit are listed and a last line says `… and 12 more: call mcp__torno__marks`. Then those drafts become `sent`: only the ones actually listed, and only when the hook is `UserPromptSubmit` for a session of that object (Review Focus 2). Sent, unresolved marks are summarised in one line (`Open marks: M1, M2, M4`).
- **Tools.**
  - `marks({ status? })` → JSON of the object's marks, all fields, strokes with their points.
  - `describe({ ref, layout? })` → the kernel's reply as JSON; `ref` may also be `M3`, which returns that mark.
  - `highlight({ refs, note?, layout? })` → the user's viewport tints those refs in the agent colour with the note in the selection chip row until the user clicks or 60 s pass; returns what was highlighted, or `isError` naming refs that do not exist.
  - `show({ view?, layout?, parts? })` → sets the user's camera, layout and visible parts; returns the same caption a `look` would.
  - `add_mark({ kind: 'pin' | 'pick' | 'arrow' | 'shape', note, ref?, point?, to?, shape?, size?, position?, intent?, layout? })` → places a mark authored by the agent. A pin or pick given only a `ref` is anchored at that face's or edge's centre (from `describe`); a `point` given without a ref is anchored through `nearest`.
  - `resolve_mark({ id, note? })` → status `resolved` with `resolvedNote`.
  - `look` gains `marks?: boolean` (default true).
  - All refuse an object that is not the one open in the window where they touch the window (`highlight`, `show`), and all return `isError` texts that name the valid refs, ids or layouts.
- **System prompt** gains: marks are how the user points; refs and how to read a descriptor; resolve a mark when acted on; use `highlight` to ask "this one?" before a risky change; `show` changes what the user sees, so say so.
- **`.torno/state.md`** is rewritten (atomically, debounced 1 s) on every build and marks change: the build line, the layouts and parts with sizes, and every unresolved mark as a `describeMark` line. It is for agents with no MCP.

- [ ] **Step 1:** `describe.test.ts`: every line form above, including the drift and orphan suffixes and number formatting (at most 4 significant digits, no trailing zeros).
- [ ] **Step 2:** `context.test.ts`: drafts listed and counted; the overflow line; the limit holds for 200 marks; a second call lists none; `statefile.test.ts`: content and atomic write.
- [ ] **Step 3:** `tools.test.ts`: each new tool's happy path and each error text; `add_mark` by ref and by point; `resolve_mark` unknown id.
- [ ] **Step 4:** `manager.itest.ts`: a `UserPromptSubmit` for object A's session lists and consumes A's drafts only; a `Stop` consumes nothing.
- [ ] **Step 5:** `e2e/mcp.spec.ts`: through a real MCP client: place a pin with the pointer, call `marks` and find it with its ref; `add_mark` by ref makes a green mark appear in the panel as `(agent)`; `highlight` sets the chip row; `show({ view: 'top' })` changes `__tornoTest.state()` camera; `resolve_mark` moves it under "Resolved"; the fake agent's `hook` line prints the pin's `describeMark` line, and a second `hook` does not.
- [ ] **Step 6:** Run suites; commit.

### Task 10: Loose ends from Milestone 1, a real check, docs

**Files:**
- Modify as needed: `app/src/main/builds.ts`, `ipc.ts`, `look.ts`, `sessions/manager.ts`, `sessions/status.ts`, `sessions/claude.ts`, `app/src/renderer/App.tsx`, `ui/SessionPane.tsx`, `README.md`, `CLAUDE.md`

Items (each with a test unless marked):
1. A displaced build is restarted even when the displacer releases the kernel before the `cancelled` reply lands: record the displaced object in `start()` (`builds.ts`).
2. Watcher scans are sequenced with a counter so an older scan cannot overwrite a newer one (`ipc.ts`).
3. Clicking the object that is already open does nothing (`App.tsx`).
4. `view.onLook` is subscribed at app level and answers "no object open" at once; `requestLook` rejects when the window closes mid-wait (`look.ts`).
5. Session status returns to `working` after a permission prompt is answered: add `PreToolUse` and `PostToolUse` http hooks that map to `working` (`claude.ts`, `status.ts`).
6. `session.start` returns the status with the session so the header never sticks on "Starting" (`SessionPane.tsx`).
7. A follow-up rebuild caused by a non-`.py` change is skipped when the build that just ended was itself such a follow-up (`builds.ts`).
8. `killGroup` returns unless `pid > 1`; the second-launch folder is held until the first window has loaded; a second launch prints one line to stderr (no test for the last two).
9. README and CLAUDE.md describe marks, the tools and keys, the new MCP tools, `.torno/marks.json` and `state.md`.

- [ ] **Step 1:** Items 1 to 8, test first.
- [ ] **Step 2:** One real check with the real CLI, hidden, sonnet, one prompt, on a temp copy of the fixtures (as in Milestone 1's Task 10, with `TORNO_AGENT_CMD="claude --model sonnet"`): place a pin on the bracket's top face with the note "make this plate 8 mm thick" and an arrow on the post, then send the prompt `What did I mark? Answer from the marks you were given, then call highlight on the face of the first one. Do not edit any file.` Record: the context lines the hook sent, the model's answer, that the highlight appeared in the window state, and that the marks became `sent`.
- [ ] **Step 3:** Hidden sweep on `~/objects`: open `intake`, place a pin on the lid and a plane stroke in front view through pointer events, save `look` pictures with marks, and look at them. `git -C ~/objects status --short` before and after: only `.torno/` may appear (and is left in place).
- [ ] **Step 4:** All suites; commit.

## Order

Task 1 and Task 2 are independent of each other. Then 3 → 4 → 5 → 6 → 7 in the renderer. Task 8 needs 1, 2 and 4. Task 9 needs 4 and 8. Task 10 is last.

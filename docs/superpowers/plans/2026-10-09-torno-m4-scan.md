# Torno Milestone 4 "Scan" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scan of the real surroundings (GLB, glTF, OBJ, PLY, STL) can be imported, aligned to the model and overlaid without a script, parts of it can be painted and named, and the agent can ask whether a part runs into it and how far a part lies from it.

**Architecture:** A one-shot Python process of the kernel package reads the source with trimesh and writes one binary mesh (`mesh.bin`, millimetres, Z up) under `<object>/.torno/scans/<id>/`; main owns `.torno/scans.json` (the source's path and hash, how it was imported, one transform per layout) with the discipline of `marks.json`. The window draws that one mesh, picks it through a BVH built in a worker, and aligns it with pure functions shared with main; the kernel's live build worker answers `scan_clash`, `scan_deviation` and `scan_section` from the same file with numpy ray parity on the part's tessellation and the reported points retaken on the B-rep. A region is a mark kind whose triangles are a bitset beside the mesh.

**Tech Stack:** as Milestones 1 to 3, plus `trimesh` (5.x) and `pillow` as the optional extra `scans` of the kernel package, used by the import process only; `scipy.spatial.cKDTree`, imported in the build worker from the workspace's own environment (build123d brings it); a Web Worker in the renderer for the scan's BVH (three-mesh-bvh 0.9.16, already a dependency). No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md`, sections 2 (scan, ref `S1`), 3 (files torno writes), 4 (queries), 5 (region marks), 6 (tools), 7 (scans, section), 8 (scans), 13. Task 1 amends its text where the Decisions below depart from it. Experiments this plan cites: `.superpowers/sdd/m4-experiments.md` (E1, E2, E3). Groundwork: `.superpowers/sdd/m4-groundwork.md`.

Read `CLAUDE.md` first: test commands, global constraints, kernel invariants, hidden-window rules. They bind every task.

How this plan is written: each task gives its files, the exact interfaces it consumes and produces, the tests to write (as code) and the code of whatever is an algorithm or a file format. Where a step wires an interface into existing UI or IPC code, it names the file, the function and the behaviour, and the existing neighbour to copy the shape of. Write each listed test first, watch it fail, then implement. Milestone 3 is merged to `main` before this starts: branch `m4-scan` from it.

## Global Constraints

- Everything in `CLAUDE.md`. Copied here because every task leans on them:
  - Never write inside a user workspace except under `<object>/.torno/`. Never run `uv sync` there: always `uv run --no-sync`, and only when `<workspace>/.venv` exists.
  - The kernel supervisor only imports. It never loads a model, builds, tessellates, reads a scan or answers a query. Workers never fork.
  - Kernel stdout carries protocol frames only. The import process is not the kernel: its stdout carries exactly one line of JSON, its last; progress goes to stderr.
  - Units are millimetres, Z up. Coordinates crossing a process boundary are in the object frame unless named `local`. A scan's own frame (as imported: mm, Z up, before any alignment) is the "scan frame"; a point in it is named `local` or `scan` wherever it crosses a boundary.
  - Renderer: `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`. No per-frame and no per-pointer-move state in React or Zustand.
  - HTTP server binds `127.0.0.1` only, on an OS-assigned port.
  - Images for the agent: long edge at most 2000 px, default 1280.
  - Do not copy nerv's look: no black/red/amber, no condensed uppercase labels, no corner-tick frames. Follow spec section 10 and the tokens in `app/src/renderer/styles/tokens.css`. UI text is sentence case. Every number and ref is set in the monospace face (class `num`).
  - User marks are drawn in `--user-mark`, agent marks in `--agent-mark`, and nothing else in the UI uses those colours: a scan, a deviation picture and the alignment points use tokens of their own.
  - Tests must not open a visible window: `show: false` when `TORNO_TEST=1`. Every Electron launch sets `TORNO_TEST=1`.
  - Commit after every task with a message describing the change, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The owner works on this desktop. Hidden window only; never `--ozone-platform=headless`; never `page.screenshot()`; `webContents.capturePage()` at most once per launch; never the clipboard; never click "Open folder" or "Import scan" unless main runs with `TORNO_TEST=1` (the dialogs are then replaced by `globalThis.__tornoMain.pickFolder` and `.pickFile`).
- Never run the real `claude` CLI from tests: `TORNO_AGENT_CMD` is `node app/test/fake-agent.mjs`.
- **Nothing from a scan is ever said to be exact.** A scan is a mesh measured by a phone or a scanner. Every reply that holds a number taken from a scan has `"exact": false` and `"approximate"`, every reading of it has `≈`, and every reply names the revision, the layout, the scan's alignment state in that layout and how it was sampled. The one thing said exactly is the distance from a *reported scan point* to the part's B-rep, and it is worded as that.
- A scan's source file is never copied, moved or written. Scan fixtures are generated by test code; the owner's scans are never committed, and no fixture file above 200 KB is committed.
- Nothing is checked against a scan where it was imported: a scan with no transform for a layout is "not aligned" there, and `scan_clash`, `scan_deviation`, `scan_section` and a scan end of `measure` refuse it with a plain reason.
- A part torno moved for display (`Part.arranged`) is refused by the scan checks, as two such parts are refused by `check` (`spreadApart`): the reply names the layouts that place it as assembled, or says to add `def assembly(p)`.
- A kernel query has 30 s (`QUERY_TIMEOUT`). A scan query gives itself 15 s, samples what it cannot finish, and says so (`sampling`).
- Tests work on a temporary copy of `kernel/tests/fixtures/ws`, never on the fixtures themselves, never on a real workspace. Nothing under `/home/luisgonc/objects` or `/home/luisgonc/Downloads` is ever written.

## Review Focus

The five ways this is most likely to bite the owner, most likely first. Each has its test in the task that owns the code.

1. **A wrong unit or up-axis guess.** An STL in centimetres or inches, an OBJ that is Z up, a GLB that is not in metres: the scan arrives 10, 25.4 or 1000 times too large, or lying on its side. Expected: the row says the size in millimetres and what was assumed ("2518 × 2351 × 1494 mm, from m, Y up (assumed)"), unit and up axis can be changed afterwards without the source file, and a pair fit whose free scale is within 3 % of a unit ratio says "this looks like a unit". Tests in Tasks 1 (`test_guess_*`, `test_convert_*`), 2 (`convert`), 5 (`unitHint`).
2. **The source file moves, changes or is deleted** (it is in Telegram's download folder). Expected: the scan goes on working from `mesh.bin`; the row says "source missing" or "source changed"; when `mesh.bin` is gone too the row says what to do and every tool refuses with the path it looked for. Tests in Task 2 (`store.test.ts`: `sourceState`, `meshState`).
3. **The scan in a layout torno spread** (`micra-intake` has only `print`: the tub stays, five parts are moved). Expected: alignment and `scan_clash` against the tub work, with a note that a print layout poses parts for the bed; against the lid they are refused, naming `def assembly(p)`. Tests in Task 7 (`scanTools.test.ts`: `SPREAD`) and by hand in Task 9.
4. **1.6 million triangles stalling the window.** Expected: the import never runs in the window or in main's thread; the scan is drawn as soon as its bytes arrive and is pickable when its tree arrives from a worker (1.6 s measured, E3); a pointer move costs one BVH ray; nothing of a brush stroke goes through React. Tests in Task 4 (`e2e/scan.spec.ts`: a 200,000-triangle generated scan is `ready`, `timeScanPicks` mean under 2 ms) and the frame time read by hand in Task 9.
5. **A stale alignment after the model's frame changes** (the owner moves the tub by changing `pad_t`, or a wider part respreads the layout). Expected: after every build each alignment is checked: the model points of its pairs are looked for on their parts again, and each part's `arranged` is compared with what it was; an alignment the model moved under says so in the row, in `scans`, in the prompt's line and in every scan reply (`stale`), and is never silently re-fitted. Tests in Task 5 (`alignCheck.test.ts`, and the `spread` fixture in `e2e/align.spec.ts`).

## Decisions

The controller's rulings, as followed:

- **R1.** Import is a one-shot process, `python -m torno_kernel.scans import …`: never the supervisor, never a build worker. trimesh reads GLB/glTF, OBJ, PLY, STL; textures are baked to vertex colours; the mesh is converted to millimetres and Z up; one binary file is written. Unit and up axis are guessed from the format and the size, shown, and changeable.
- **R2.** One mesh per scan, undecimated up to 2,000,000 triangles; above, reduced to at most 2,000,000 and said. What is drawn is what is picked, painted and clashed.
- **R3.** The source is referenced by absolute path, size, modification time and SHA-256, never copied or modified. `<object>/.torno/scans/<id>/mesh.bin` is the scan. `.torno/scans.json` is main-owned, atomic, one change at a time per object. Ids `S1`, `S2`, … per object, never reused. Visibility, opacity and colour mode are view state in `scene.json`.
- **R4.** One transform per layout. No transform for the layout shown: "not aligned" there, drawn where it was imported, flagged, refused by the checks. A part with a non-zero `arranged` is refused. `micra-intake`: usable against the tub (E2: the tub is not moved, and the model stands it in the tray frame lowered by `pad_t`); the docs say that fit against the car needs `assembly(p)`.
- **R5.** Alignment: (a) floor, from a patch or three points of the scan, to Z = 0 or onto a picked model face; (b) pairs, N ≥ 3, rigid by default, uniform scale offered when the residual says the unit is wrong, residuals per pair; (c) the existing gizmo, with typed values. No ICP.
- **R6.** A region is a mark of kind `region`, ids in the `M` sequence, `draft` → `sent` → `resolved` like any mark, told in text. Brush with a radius on the BVH, a box, and "grow to flat".
- **R7.** Tools `scans`, `scan_clash`, `scan_deviation`; `measure` takes a scan point or a region as an end; `look` draws scans by default, can hide them or colour one by distance to a part; `show` can switch them. Every reply says revision, layout, alignment state and that scan numbers are approximate. The prompt's context gains one line about scans; draft regions are listed with the marks.
- **R8.** Clash and deviation run in the kernel's live build worker: candidates by bounding box, inside or outside by numpy ray parity on the part's tessellation, depths retaken on the B-rep for the reported points, clusters with centres and counts, caps said in the reply. E2 passed: 0 disagreements with `BRepClass3d_SolidClassifier` away from the surface, 3 in 600 within 0.01 mm of it; 9 to 12 s worst case for 200,000 candidates under load.
- **R9.** A scan is clipped by the section and drawn open, no cap. `section` includes a scan only when asked (`scan: 'S1'`): its polylines in the plane, marked approximate.
- **R10.** A "Scans" group in the left panel (name, state chip, eye, opacity), an import button, drop of a file on the viewport, an alignment bar like the section bar. Keys: `L` align, `B` region brush; neither collides with `V P A D S X M`, `G R T`, `O`, `F`.

Where this plan departs from the groundwork or adds to a ruling, because an experiment or the code says so:

- **D1. Ruling proposed: trimesh and pillow are an optional extra (`scans`) of the kernel package, asked for by the import command only (`--with-editable "<kernel>[scans]"`); scipy is not declared and is imported lazily in the build worker.** Why: E1 (c) shows that a dependency of the kernel that is neither cached nor downloadable stops *every* kernel start, so trimesh in `dependencies` would make builds depend on a library no build uses; E1 (b) shows a declared scipy shadows the workspace's own for every model. Cost if wrong: on a machine with no network and no cached trimesh the import fails with uv's message while builds go on working (that is the intent); in a workspace whose environment has no scipy (none that has build123d 0.13) the scan checks are refused with a sentence.
- **D2. Ruling proposed: inside or outside is one ray along +Z through a 2D grid of the triangles, asked again along +X then +Y only for a point whose ray passes within 1e-9 of a triangle edge; depths come from a `cKDTree` over the part's mesh sampled every 1 mm, built with `balanced_tree=False, compact_nodes=False`.** Why: E2: the same answers as three rays and a majority on 800,000 points, 2 to 9 times quicker; scipy's default tree took 6 to 20 s for a query that takes 0.1 to 0.5 s so built. Cost if wrong: a point whose +Z ray grazes an edge by more than 1e-9 and less than rounding error is misjudged; the pytest against the classifier would show it.
- **D3. Ruling proposed: `scan_clash` counts scan vertices inside the part and scan triangles that cross its surface; it reports no volume.** Why: a scan is an open surface with no inside. Cost if wrong: a scan surface that passes through a wall thinner than the spacing of the scan's vertices (about 4 mm on Micra) with no vertex inside is seen only as crossing triangles when their vertices are candidates; the reply's `how` says so.
- **D4. Ruling proposed: the rigid fit is Umeyama's least-squares solution computed in Horn's quaternion form** (a symmetric 4 × 4 eigenproblem by Jacobi rotations). Why: the same minimiser, always a proper rotation, no SVD to write or import in TypeScript. Cost if wrong: none in result; the unit test recovers a known transform to 1e-9.
- **D5. Ruling proposed: unit and up axis are shown on the scan's row after the import and changed there (`convert`, which rewrites `mesh.bin` from itself), with no sheet before the import.** Why: a drop stays one gesture, and the change works when the source is gone (Review Focus 1 and 2). Cost if wrong: a scan guessed wrongly is drawn wrongly for the seconds it takes to change it; changing either drops the scan's alignments, and the confirmation says so.
- **D6. Ruling proposed: above 2,000,000 triangles the import reduces by vertex clustering on a grid in numpy** (cell doubled until under the limit), not by `fast-simplification`. Why: no further dependency, and the rule is only reached by files the owner does not have. Cost if wrong: a 5 M-triangle scan loses more detail than quadric decimation would keep; the row and every reply say `reduced from N`.
- **D7. Ruling proposed: `ShapeGizmo` is made to hold either a shape mark or a scan (`GizmoSubject`), not copied.** Why: the pointer router arbitrates one gizmo (`pointer.ts`). Cost if wrong: a regression in shape editing, which `ShapeGizmo.test.ts` and `e2e/tools.spec.ts` cover.
- **D8. Added: alignments are checked after every build** (Review Focus 5). Why: nothing in the rulings stops a scan from silently sitting where the model used to be. Cost if wrong: one more `nearest` query per layout and build, and a false "stale" when a face the person clicked was deliberately moved; the wording asks for a look, it does not undo anything.
- **D9. Ruling proposed: a region carries a note and no fixed label; `scan_clash` is told which regions to leave out (`ignore: ["M7"]`).** Why: R6 says the person names a region with a note; the spec's three labels (`ignore`, `movable`, `keep-out`) are not in the ruling. Cost if wrong: the agent must read "can be pushed aside" from a note and pass the id itself; Task 1 amends the spec's table.
- **D10. Added: `.torno/scans/.gitignore` holds `mesh.bin`.** Why: the spec promises `.torno/` is safe to commit, and Micra's mesh is 34 MB. Cost if wrong: a clone has the scan's record and regions but not its mesh, and the row offers "Import again" from the recorded source.

Not in this milestone: ICP, pins on a scan, a deviation colour mode for the person's own view (the agent's `look` has it), texture display, point clouds without faces (refused with a sentence), Draco or meshopt GLB (refused with trimesh's reason).

## File structure

New files, each with one job:

```
kernel/src/torno_kernel/
  scanfile.py        mesh.bin and .mask: the byte layouts, read and write. numpy only.
  scans.py           the import process: load with trimesh, guess, reduce, convert, the CLI.
  scanclash.py       inside(), clusters(), sampled(), to_triangles(); the three scan queries.
kernel/tests/
  scanfix.py         generated scan fixtures (STL, PLY, OBJ by hand; GLB through trimesh).
  test_scanfile.py   test_scans.py   test_scanclash.py
app/src/shared/
  scans.ts           Scan, ScanInfo, ScanTransform, ScanAlignment, ScanView; parseScanMesh; mask layout.
  align.ts           apply, compose, inverse, fitPlane, toFloor, fitPairs, nudged, unitHint. Pure.
  regions.ts         regionStats(mesh, bits). Pure.
app/src/test/
  scanFixtures.ts    boxStl, gridStl, meshBin: scans made in test code.
app/src/main/scans/
  file.ts            scans.json: load, sanitise, save.
  store.ts           ScanStore: the only writer of scans.json and of .torno/scans/.
  importer.ts        the import command and its one-line reply.
  alignCheck.ts      after a build: is the model still under each alignment?
app/src/main/mcp/
  scanTools.ts       scans, scan_clash, scan_deviation; the guards; the readings.
app/src/renderer/viewport/
  scanMesh.ts        buildScan, disposeScan, linearColours.
  scanBvh.ts  scanBvh.worker.ts     the tree, built off the main thread.
  scans.ts           ScanLayer: the scans of the object on show, their looks, picking, painting.
  scanPaint.ts       bitset, sphere and box gathers, grow to flat, the tint. Pure but for the BVH.
  scanDeviation.ts   colours a scan by distance to a part's mesh, for a picture.
app/src/renderer/tools/
  alignTool.ts       regionTool.ts
app/src/renderer/ui/
  ScansPanel.tsx     AlignBar.tsx     RegionBar.tsx
app/e2e/
  scan.spec.ts       align.spec.ts    region.spec.ts
```

Modified: `kernel/pyproject.toml`, `kernel/uv.lock`, `kernel/src/torno_kernel/{queries,tess}.py`; `app/src/shared/{bridge,view,scenefile,marks,geometry}.ts`; `app/src/preload/index.ts`; `app/src/main/{ipc,index,scenefile,context,statefile,prompt,look}.ts`, `main/kernel/client.ts`, `main/marks/{file,store,describe}.ts`, `main/mcp/{tools,markTools,readTools}.ts`; `app/src/renderer/viewport/{Viewport,picture,ShapeGizmo,sectionDrawing}.ts`, `viewport/marks/{MarkLayer,markObjects}.ts`, `state/{store,tools,agent}.ts`, `tools/Tool.ts`, `ui/{App,ViewportPane,ToolPalette,MarkRow}.tsx`, `styles/{tokens,app}.css`; `README.md`, `CLAUDE.md`, the spec.

`Viewport.ts` is 1,058 lines. Scans add to it only what joins `ScanLayer` to the scene, the section, the pictures and the pointer: everything else is in `viewport/scans.ts`. It must not grow by more than 120 lines over the milestone.

## Shared contracts

### `mesh.bin` (written by `scanfile.write_bin`, read by the kernel, main and the window)

Little-endian throughout. `V` vertices, `T` triangles.

| Offset | Bytes | What |
|---|---|---|
| 0 | 8 | ASCII `TORNOSCN` |
| 8 | 4 | `u32` version, 1 |
| 12 | 4 | `u32` flags: bit 0 set when the file has colours |
| 16 | 4 | `u32` V |
| 20 | 4 | `u32` T |
| 24 | 24 | `f32` × 6: bbox min x, y, z, max x, y, z, in mm, scan frame |
| 48 | 16 | zeros |
| 64 | 12·V | `f32` × 3 per vertex: x, y, z in mm, Z up, scan frame |
| 64 + 12·V | 4·V | `u8` × 4 per vertex: r, g, b, a (sRGB, a = 255). Present only with flag bit 0 |
| then | 12·T | `u32` × 3 per triangle: vertex numbers |

The file's length is exactly `64 + 12·V + (4·V if colours) + 12·T`. Every section starts on a multiple of 4. A triangle's number is its place in the last section: it is what a pick returns, what a region's bit means and what never changes while the file is the same.

### `<id>/<mark>.mask` (a region's triangles)

| Offset | Bytes | What |
|---|---|---|
| 0 | 8 | ASCII `TORNOMSK` |
| 8 | 4 | `u32` version, 1 |
| 12 | 4 | `u32` T: the triangle count of the `mesh.bin` it was painted on |
| 16 | ceil(T / 8) | bit `i & 7` of byte `i >> 3` is set when triangle `i` is in the region |

### `app/src/shared/scans.ts`

```ts
import type { Quat, Vec3 } from './marks'

export type ScanUnit = 'mm' | 'cm' | 'm' | 'in'
export type ScanUp = 'y' | 'z'
export const UNIT_MM: Record<ScanUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 }
export const SCAN_FORMATS = ['.glb', '.gltf', '.obj', '.ply', '.stl'] as const
export const MAX_SCAN_TRIANGLES = 2_000_000

/** Scan frame (mm, Z up, as imported) to the object frame of one layout: p' = s · R(q) · p + t. `s` is 1 unless a fit was made with scale. */
export interface ScanTransform { t: Vec3; q: Quat; s: number }
export const IDENTITY: ScanTransform = { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }

export type AlignStep = 'floor' | 'pairs' | 'nudge' | 'typed'
/** One pair of an alignment: a point of the scan, in the scan frame, and where it belongs, in the object frame of the layout. */
export interface ScanPair { scan: Vec3; model: Vec3; part?: string /* the part the model point was clicked on */; residual: number /* mm, after the fit */ }
export interface ScanAlignment {
  transform: ScanTransform
  /** How it came to be, in order: `['floor', 'pairs', 'nudge']`. Never empty. */
  steps: AlignStep[]
  pairs?: ScanPair[]
  /** Of the last fit: of the pairs, or of the floor patch about its plane. mm. */
  rms?: number
  /** The fit changed the scan's size. */
  scaled?: boolean
  /** The floor was laid on a face of this part, at this point of it (object frame). */
  floor?: { part?: string; point: Vec3 }
  /** `Part.arranged` of every part of the layout when it was aligned, zeros for a part that was not moved. */
  frame: Record<string, Vec3>
  at: string // ISO
}
/** What a caller gives to align: main adds `frame` and `at`. */
export type NewAlignment = Omit<ScanAlignment, 'frame' | 'at'>

/** What main found when it checked an alignment against a build (`main/scans/alignCheck.ts`). Never stored: revisions are of this run. */
export interface AlignmentCheck { revision: number; of: number; off: number; worst: number; moved: string[] }

export interface ScanSource { path: string /* absolute */; bytes: number; mtimeMs: number; sha256: string }
export interface ScanImport {
  unit: ScanUnit
  up: ScanUp
  /** Whether each was assumed from the format and the size, not chosen by the person. */
  assumed: { unit: boolean; up: boolean }
  vertices: number
  triangles: number
  colours: 'texture' | 'vertex' | 'none'
  bbox: { min: Vec3; max: Vec3 } // scan frame
  area: number // mm²
  reduced?: { from: number; cell: number }
  at: string
}
/** A scan as `scans.json` keeps it. */
export interface Scan {
  id: string // 'S1'
  name: string
  source: ScanSource
  imported: ScanImport
  alignments: Record<string, ScanAlignment> // by layout
}
export interface ScansFile { next: number; scans: Scan[] }

/** A scan as main tells it: with what it found on the disk and at the last build. */
export interface ScanInfo extends Scan {
  sourceState: 'present' | 'missing' | 'changed'
  meshState: 'ok' | 'missing'
  checks: Record<string, AlignmentCheck> // by layout; absent for one not checked in this run
}

/** How a scan is looked at: view state, kept in scene.json by scan id. */
export interface ScanView { visible?: boolean; opacity?: number; colour?: 'own' | 'plain' }

export interface ScanMesh { vertices: Float32Array; colours: Uint8Array | null; triangles: Uint32Array; bbox: { min: Vec3; max: Vec3 } }
/** Views into a `mesh.bin`; nothing is copied. Throws a RangeError that says what is wrong with the bytes. */
export function parseScanMesh(blob: ArrayBuffer): ScanMesh
/** The bytes of a `.mask` for a bitset over `triangles` triangles, and back. `maskBits` throws a RangeError for a file of another length or count. */
export function maskFile(bits: Uint8Array, triangles: number): Uint8Array
export function maskBits(file: Uint8Array, triangles: number): Uint8Array
/** `aligned` | `not aligned`: whether the scan has a transform for the layout. */
export function alignmentOf(scan: Pick<Scan, 'alignments'>, layout: string): ScanAlignment | null
/** Why an alignment may no longer hold, as a sentence, or null. */
export function staleText(check: AlignmentCheck | undefined): string | null
/** `by floor + 4 pairs (rms 2.1 mm, worst 3.4 mm)`; `by floor only: its place in that plane is as imported`. */
export function alignmentText(alignment: ScanAlignment): string
/** `2518 × 2351 × 1494 mm, from m, Y up (assumed)`. */
export function importText(imported: ScanImport): string
```

### `scans.json`

```json
{
  "next": 2,
  "scans": [
    {
      "id": "S1",
      "name": "Micra.glb",
      "source": { "path": "/home/luisgonc/Downloads/Telegram Desktop/Micra.glb", "bytes": 55567676, "mtimeMs": 1790000000000, "sha256": "11569451127b93cf…" },
      "imported": { "unit": "m", "up": "y", "assumed": { "unit": true, "up": true }, "vertices": 936823, "triangles": 1607144, "colours": "texture",
                    "bbox": { "min": [-1258.9, -1175.3, 0], "max": [1258.9, 1175.3, 1493.6] }, "area": 14200000, "at": "2026-10-10T09:00:00.000Z" },
      "alignments": {
        "print": {
          "transform": { "t": [-112.3, 690.1, -34.8], "q": [0.701, 0.02, -0.03, 0.712], "s": 1 },
          "steps": ["floor", "pairs"],
          "pairs": [{ "scan": [310.2, -44.1, 12.9], "model": [-96, 31, 0], "part": "airbox-tub", "residual": 1.8 }],
          "rms": 2.1,
          "frame": { "airbox-tub": [0, 0, 0], "airbox-lid": [277.361, 0, 0] },
          "at": "2026-10-10T09:05:00.000Z"
        }
      }
    }
  ]
}
```

### `scene.json` and the view (`shared/scenefile.ts`, `shared/view.ts`)

```ts
export interface SceneFile { layout?: string; layers: Record<string, LayerSettings>; section?: SectionPlane | null; scans?: Record<string, ScanView> }

export interface ViewState { /* as now */; scans?: Array<{ id: string; visible: boolean; opacity: number }> }
/** Which scans a picture draws: absent or 'current', those on screen as they are; false, none; ids, those, at the opacity they have. */
export type ScanChoice = 'current' | false | string[]
/** Colours one scan by its distance to a part of the layout, for a picture: from `--deviation-near` at 0 to `--deviation-far` at `range` mm and beyond; scan vertices inside the part in `--deviation-inside`. */
export interface ScanColouring { scan: string; part: string; range: number }
export interface LookRequest { /* as now */; scans?: ScanChoice; scanColour?: ScanColouring }
export interface ShowRequest { /* as now */; scans?: string[]; scanOpacity?: number }
```

### The import process

```
python -m torno_kernel.scans import  <source> <out.bin> [--unit mm|cm|m|in] [--up y|z] [--max-triangles 2000000]
python -m torno_kernel.scans convert <mesh.bin> --from-unit U --to-unit U --from-up A --to-up A
```

Exit status 0 and one last line on stdout:

```json
{"ok": true, "unit": "m", "up": "y", "assumed": {"unit": true, "up": true}, "vertices": 936823, "triangles": 1607144, "colours": "texture",
 "bbox": {"min": [-1258.9, -1175.3, 0.0], "max": [1258.9, 1175.3, 1493.6]}, "area": 14200000.0, "reduced": null,
 "source": {"bytes": 55567676, "sha256": "…64 hex…"}, "seconds": 3.4}
```

or exit status 1 and `{"ok": false, "error": {"kind": "unreadable" | "no_triangles" | "too_large" | "bad_request", "message": "…"}}`. `convert` answers the same without `source`. stderr carries `stage: <name>` lines (`hashing`, `reading`, `colours`, `converting`, `writing`).

### Kernel queries (in the live build worker; `dir` names the object, as for every query)

Each takes `layout`, `part` (a name of that layout) and `scan`:

```json
{"id": "S1", "path": "/abs/obj/.torno/scans/S1/mesh.bin", "transform": {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1},
 "ignore": ["/abs/obj/.torno/scans/S1/M7.mask"], "only": null}
```

- `scan_clash`, further args `margin` (mm, default 5). Reply:

```json
{"part": "tub", "scan": "S1",
 "points": {"scan": 936823, "candidates": 13476, "checked": 13476, "ignored": 0},
 "inside": {"count": 2168, "crossing": 310,
   "clusters": [{"count": 1982, "centre": [-98.1, 30.2, 44.0], "bbox": {"min": [-120, 10, 30], "max": [-80, 52, 61]},
                 "depth": 14.2, "at": [-96.1, 31.0, 40.2], "under": "tub/F40"}],
   "clustersOmitted": 3},
 "deepest": {"depth": 14.2, "at": [-96.1, 31.0, 40.2], "under": "tub/F40"},
 "nearest": {"distance": 0.9, "at": [61.0, -12.2, 9.1], "on": [60.1, -12.2, 9.1], "face": "tub/F12"},
 "sampling": {"every": 1, "cell": 5.0, "surface": 1.0, "deflection": 0.1, "retaken": 9, "partial": false, "seconds": 3.2},
 "how": "scan vertices inside the part, by ray parity on the mesh the part is drawn with; each depth and distance told is from that scan point to the part's B-rep",
 "exact": false}
```

  `deepest` and `nearest` are null when there is none. A part that is no solid is `bad_request`: "tub is not a solid: nothing is inside it; scan_deviation says how far it is from the scan".

- `scan_deviation`, further args `faces` (indices, or null for the whole part), `from` (`"part"`: samples of the part's faces to the scan's triangles; `"scan"`: the scan's vertices to the part), `within` (mm, default 50), `samples` (default 20000). Reply:

```json
{"part": "plate", "faces": [5], "scan": "S1", "from": "part",
 "samples": 20000, "compared": 18840, "beyond": 1160,
 "distance": {"min": 0.0, "mean": 1.9, "max": 7.4, "rms": 2.4, "p50": 1.3, "p90": 4.0, "p95": 5.1},
 "signed": {"min": -3.1, "mean": 0.4, "max": 7.4, "inside": 212},
 "worst": {"distance": 7.4, "at": [10.0, 4.0, 6.0], "on": [10.0, 4.0, 13.4], "face": "plate/F5"},
 "sampling": {"surface": 1.0, "deflection": 0.1, "partial": false, "seconds": 1.1},
 "how": "from 20,000 points of the part's mesh to the scan's triangles; + where the scan is outside the part, − where it is inside",
 "exact": false}
```

  `signed` is null of a part that is no solid. `beyond` counts samples with nothing within `within`.

- `scan_section`, args `layout`, `plane` (`origin`, `normal`), `scan`. Reply `{"scan": "S1", "plane": {"origin", "normal", "x", "y"}, "polylines": [{"points": [[u, v], …], "closed": false}], "segments": 1234, "bounds": {"min": [u, v], "max": [u, v]} | null, "exact": false}`, with the plane's `x` and `y` as `section` gives them (`section._Frame`).

Errors: `bad_request` for a file that is not a `mesh.bin`, a mask of another triangle count, a transform that is not finite; `bad_ref` as `need_part` words it.

### Region mark (`app/src/shared/marks.ts`, added to the `Mark` union)

```ts
export interface RegionMark extends MarkBase {
  kind: 'region'
  scan: string                 // 'S1'
  triangles: number
  area: number                 // mm², of the mesh as imported (times s² where a fit scaled the scan)
  /** In the scan's own frame, which is why it is named `local`: where the region is in a layout is worked out from the scan's transform there. */
  local: {
    centroid: Vec3               // area-weighted
    bbox: { min: Vec3; max: Vec3 }
    plane: { origin: Vec3; normal: Vec3; rms: number }   // best fit through the triangles' centroids
  }
}
/** What main alone says of a region: no caller supplies these. */
export const REGION_KEYS = ['triangles', 'area', 'local'] as const
```

Its triangles are `.torno/scans/<scan>/<id>.mask`. `markAnchors` returns `[]` for it; `translated` returns it unchanged; `isUnchecked` is false of it. Its `anchorState` is `orphaned` once its scan is removed or its mask no longer fits the mesh.

### Bridge additions (`app/src/shared/bridge.ts`)

```ts
scans: {
  list(objectId: string): Promise<ScanInfo[]>
  /** The file dialog; under test, what `__tornoMain.pickFile` holds. Null when nothing was chosen. */
  pick(): Promise<string | null>
  /** Where a file dropped on the window is on the disk (`webUtils.getPathForFile`); '' for one that is nowhere. */
  pathOf(file: File): string
  import(objectId: string, path: string): Promise<ScanInfo>            // rejects with a plain message
  convert(objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo>
  rename(objectId: string, id: string, name: string): Promise<ScanInfo>
  remove(objectId: string, id: string): Promise<void>
  align(objectId: string, id: string, layout: string, alignment: NewAlignment | null): Promise<ScanInfo>
  mesh(objectId: string, id: string): Promise<ArrayBuffer>
  /** The `.mask` of a region of a scan, as the file is (Task 8). */
  mask(objectId: string, id: string, markId: string): Promise<ArrayBuffer>
  onChanged(cb: (m: { objectId: string; scans: ScanInfo[] }) => void): () => void
  onProgress(cb: (m: { objectId: string; name: string; stage: string | null }) => void): () => void
}
marks: { /* as now */; addRegion(objectId: string, region: NewRegion): Promise<Mark> }
```

```ts
/** What the window gives to keep a region: main works out everything else from the mesh. */
export interface NewRegion { scan: string; note: string; layout: string; revision: number; camera: Camera; bits: Uint8Array }
```

---

### Task 1: The spec as ruled, the mesh file, and the import process

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-torno-design.md` (sections 3, 4, 5, 6, 7, 8), `kernel/pyproject.toml`, `kernel/uv.lock`
- Create: `kernel/src/torno_kernel/scanfile.py`, `kernel/src/torno_kernel/scans.py`
- Test: `kernel/tests/scanfix.py`, `kernel/tests/test_scanfile.py`, `kernel/tests/test_scans.py`

**Interfaces:**
- Consumes: nothing of this milestone.
- Produces: the `mesh.bin` and `.mask` layouts of "Shared contracts"; the import process and its one-line reply; and in Python:
  - `scanfile.write_bin(path: str | Path, vertices: np.ndarray, triangles: np.ndarray, colours: np.ndarray | None = None) -> dict[str, Any]` (returns `vertices`, `triangles`, `bbox`, `area`; writes through a temp file beside `path`)
  - `scanfile.read_bin(path: str | Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]` (float32 `(V, 3)`, uint32 `(T, 3)`, uint8 `(V, 4)` or None; `ValueError` for a file that is not one)
  - `scanfile.write_mask(path, bits: np.ndarray) -> None`, `scanfile.read_mask(path, triangles: int) -> np.ndarray` (bool `(T,)`)
  - `scanfile.area_of(vertices, triangles) -> float`
  - `scans.guess(suffix: str, diagonal: float) -> tuple[str, str]`, `scans.reduce(vertices, triangles, colours, most) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, dict | None]`, `scans.main(argv: list[str]) -> int`
  - `scanfix.box(size, centre) -> (vertices, triangles)`, `scanfix.grid(count, cell, z) -> (vertices, triangles)`, `scanfix.write_stl / write_ply / write_obj / write_glb`, used by Task 6 too.

- [ ] **Step 1: Amend the spec to what was ruled**

In `docs/superpowers/specs/2026-10-08-torno-design.md`:

1. Section 3, "Files torno writes": replace the `scans/<id>/` line with

```
  scans.json          every scan: its source (path, size, hash), how it was imported, one transform per layout
  scans/<id>/         mesh.bin (the scan, in mm, Z up) and one .mask per region painted on it
```

   and after "safe to commit" add: "`scans/.gitignore` leaves `mesh.bin` out: it is rebuilt from the source."
2. Section 3, the kernel box and "Process model": after the sentence on the query server add: "A scan is imported by a process of its own (`python -m torno_kernel.scans`), never by the supervisor or a worker; trimesh is an optional extra of the kernel package that only that process asks for."
3. Section 4, "Queries": replace "`scan_clash(part, scan)` → points inside, deepest penetration and where" with "`scan_clash(part, scan)` → scan points inside the part in clusters, the deepest and where, the nearest outside; `scan_deviation(part or faces, scan)` → how far apart they lie, as min, mean, max and percentiles; `scan_section(plane, scan)` → the scan's polylines in a plane. These three are approximate by nature and say so: only the distance from a reported scan point to the B-rep is exact."
4. Section 5, the table's Region row: "| Region | paint or box on a scan | "this part of the scan", with a note saying what it is |". Remove `ignore`, `movable`, `keep-out`.
5. Section 6, the tool table: add rows `scans()` → "the scans with their alignment in the layout, size, source", `scan_clash(part, scan?, ignore?)` and `scan_deviation(part, faces?, scan?, region?, from?)`; in the `check` row remove `scan_clash`; in `look` add `scans?`, in `show` add `scans?`, in `section` add `scan?`.
6. Section 7, "Scans:" bullet: "drawn with vertex colours baked from the texture, opacity slider, one mesh for drawing, picking and checking (reduced only above 2 M triangles)."
7. Section 8: replace the first paragraph with: "Import GLB, glTF, OBJ, PLY or STL by drop or dialog. The import process (trimesh) bakes vertex colours from the texture, converts to millimetres and Z up, and writes one mesh, `mesh.bin`; up to 2,000,000 triangles it is not reduced (Micra: 1.6 M, 3.4 s, 34 MB). The source is referenced by path, size and hash and never copied. Unit and up axis are assumed from the format and the size (glTF: metres, Y up), shown, and can be changed afterwards." Replace the last paragraph with: "A transform is kept per layout; a scan with none for the layout shown is not aligned there and nothing is checked against it. After every build each alignment is checked against the model again. ICP refinement is deferred."

Commit: `git commit -am "Spec: scans as ruled for Milestone 4"` with the trailer.

- [ ] **Step 2: The optional extra**

`kernel/pyproject.toml`: after `dependencies` add

```toml
[project.optional-dependencies]
# What reading a scan needs. Asked for by the import process only (app/src/main/scans/importer.ts):
# the kernel itself starts without them, so no build waits on a library no build uses.
scans = [
    "trimesh>=5,<6",
    "pillow",
]
```

and add `"trimesh>=5,<6"` and `"pillow"` to the `dev` group. Run `(cd kernel && uv lock)` (with `--offline` when there is no network: both are in the uv cache on this machine, E1). `scipy` is not added: see D1.

- [ ] **Step 3: Write the fixtures and the failing tests of the file layout**

`kernel/tests/scanfix.py`:

```python
"""Scans made by test code: small, exact, and never a file in the repository."""

import struct
from pathlib import Path

import numpy as np

_BOX = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
        [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]


def box(size=(40.0, 30.0, 5.0), centre=(0.0, 0.0, 0.0)):
    """A box: 8 vertices, 12 triangles facing out. Vertex 4·i + 2·j + k is at (±x, ±y, ±z), minus first."""
    half = np.array(size) / 2
    corners = [[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    return np.array(corners, dtype=np.float64) * half + np.array(centre), np.array(_BOX)


def grid(count=30, cell=1.0, z=0.0):
    """A flat square sheet facing +Z: ``count`` vertices a side, ``cell`` apart, centred on the Z axis.

    With an even count no vertex has a whole-number coordinate: 30 gives -14.5 to 14.5.
    """
    along = (np.arange(count) - (count - 1) / 2) * cell
    x, y = np.meshgrid(along, along, indexing="ij")
    vertices = np.stack([x.ravel(), y.ravel(), np.full(count * count, float(z))], axis=1)
    i, j = np.meshgrid(np.arange(count - 1), np.arange(count - 1), indexing="ij")
    a = (i * count + j).ravel()
    b, c, d = a + count, a + count + 1, a + 1
    return vertices, np.concatenate([np.stack([a, b, c], axis=1), np.stack([a, c, d], axis=1)])


def write_stl(path: Path, vertices, triangles) -> Path:
    corners = np.asarray(vertices, dtype="<f4")[np.asarray(triangles)]
    with open(path, "wb") as out:
        out.write(b"\0" * 80 + struct.pack("<I", len(corners)))
        for a, b, c in corners:
            out.write(struct.pack("<12fH", 0, 0, 0, *a, *b, *c, 0))
    return path


def write_ply(path: Path, vertices, triangles, colours=None) -> Path:
    head = ["ply", "format ascii 1.0", f"element vertex {len(vertices)}", "property float x", "property float y", "property float z"]
    if colours is not None:
        head += ["property uchar red", "property uchar green", "property uchar blue"]
    head += [f"element face {len(triangles)}", "property list uchar int vertex_indices", "end_header"]
    rows = [" ".join(map(str, [*v, *(colours[n] if colours is not None else [])])) for n, v in enumerate(np.asarray(vertices).tolist())]
    rows += [f"3 {a} {b} {c}" for a, b, c in np.asarray(triangles).tolist()]
    path.write_text("\n".join(head + rows) + "\n")
    return path


def write_obj(path: Path, vertices, triangles) -> Path:
    rows = [f"v {x} {y} {z}" for x, y, z in np.asarray(vertices).tolist()]
    rows += [f"f {a + 1} {b + 1} {c + 1}" for a, b, c in np.asarray(triangles).tolist()]
    path.write_text("\n".join(rows) + "\n")
    return path


TEXTURE = [[(200, 30, 30), (30, 200, 30)], [(30, 30, 200), (220, 220, 40)]]  # rows from the top; [1][0] is the bottom left


def write_glb(path: Path, vertices, triangles, uv=(0.25, 0.25)) -> Path:
    """A GLB as glTF has them: metres, Y up. Every vertex has the same ``uv`` of a 2 × 2 texture."""
    import trimesh
    from PIL import Image

    image = Image.fromarray(np.array(TEXTURE, dtype=np.uint8), "RGB")
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=image)
    visual = trimesh.visual.TextureVisuals(uv=np.tile(uv, (len(vertices), 1)), material=material)
    v = np.asarray(vertices, dtype=np.float64)
    in_gltf = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1) / 1000.0  # mm, Z up → m, Y up
    trimesh.Trimesh(in_gltf, np.asarray(triangles), visual=visual, process=False).export(str(path))
    return path
```

`kernel/tests/test_scanfile.py`:

```python
"""``mesh.bin`` and ``.mask``, byte by byte."""

import struct

import numpy as np
import pytest
from scanfix import box

from torno_kernel import scanfile


def test_a_mesh_is_written_as_the_layout_says(tmp_path):
    vertices, triangles = box((40, 30, 5))
    said = scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    raw = (tmp_path / "mesh.bin").read_bytes()
    assert raw[:8] == b"TORNOSCN"
    assert struct.unpack_from("<IIII", raw, 8) == (1, 0, 8, 12)
    assert struct.unpack_from("<6f", raw, 24) == (-20, -15, -2.5, 20, 15, 2.5)
    assert raw[48:64] == b"\0" * 16
    assert len(raw) == 64 + 12 * 8 + 12 * 12
    assert struct.unpack_from("<3f", raw, 64) == (-20, -15, -2.5)
    assert struct.unpack_from("<3I", raw, 64 + 12 * 8) == (0, 1, 3)
    assert said == {"vertices": 8, "triangles": 12, "bbox": {"min": [-20, -15, -2.5], "max": [20, 15, 2.5]}, "area": pytest.approx(3100)}


def test_colours_sit_between_the_vertices_and_the_triangles(tmp_path):
    vertices, triangles = box()
    colours = np.tile(np.array([[10, 20, 30, 255]], dtype=np.uint8), (8, 1))
    scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles, colours)
    raw = (tmp_path / "mesh.bin").read_bytes()
    assert struct.unpack_from("<I", raw, 12) == (1,)
    assert len(raw) == 64 + 12 * 8 + 4 * 8 + 12 * 12
    assert raw[64 + 96 : 64 + 100] == bytes([10, 20, 30, 255])
    assert struct.unpack_from("<3I", raw, 64 + 96 + 32) == (0, 1, 3)


def test_what_was_written_is_read_back(tmp_path):
    vertices, triangles = box()
    scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    v, t, c = scanfile.read_bin(tmp_path / "mesh.bin")
    assert v.dtype == np.float32 and t.dtype == np.uint32 and c is None
    assert np.array_equal(v, vertices.astype(np.float32)) and np.array_equal(t, triangles)
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize("damage, says", [(lambda raw: raw[:-4], "bytes"), (lambda raw: b"NOTASCAN" + raw[8:], "not a scan"), (lambda raw: raw[:8] + struct.pack("<I", 2) + raw[12:], "version")])
def test_a_file_that_is_not_one_is_refused(tmp_path, damage, says):
    scanfile.write_bin(tmp_path / "mesh.bin", *box())
    (tmp_path / "bad.bin").write_bytes(damage((tmp_path / "mesh.bin").read_bytes()))
    with pytest.raises(ValueError, match=says):
        scanfile.read_bin(tmp_path / "bad.bin")


@pytest.mark.parametrize("vertices, triangles, says", [(np.zeros((0, 3)), np.zeros((0, 3), int), "vertices and triangles"), (np.zeros((3, 3)), np.array([[0, 1, 3]]), "vertex 3"), (np.array([[0, 0, np.nan]] * 3), np.array([[0, 1, 2]]), "finite")])
def test_a_mesh_that_is_none_is_not_written(tmp_path, vertices, triangles, says):
    with pytest.raises(ValueError, match=says):
        scanfile.write_bin(tmp_path / "mesh.bin", vertices, triangles)
    assert not list(tmp_path.iterdir())


def test_a_mask_is_one_bit_a_triangle_lowest_first(tmp_path):
    bits = np.zeros(12, dtype=bool)
    bits[[0, 9]] = True
    scanfile.write_mask(tmp_path / "M7.mask", bits)
    raw = (tmp_path / "M7.mask").read_bytes()
    assert raw[:8] == b"TORNOMSK" and struct.unpack_from("<II", raw, 8) == (1, 12)
    assert raw[16:] == bytes([0b00000001, 0b00000010])
    assert np.array_equal(scanfile.read_mask(tmp_path / "M7.mask", 12), bits)
    with pytest.raises(ValueError, match="12 triangles, not 13"):
        scanfile.read_mask(tmp_path / "M7.mask", 13)
```

Run: `(cd kernel && uv run pytest -q tests/test_scanfile.py)`. Expected: FAIL, `cannot import name 'scanfile'`.

- [ ] **Step 4: `scanfile.py`**

```python
"""``mesh.bin`` and ``.mask``: what a scan is on the disk. numpy only.

A ``mesh.bin`` is 64 bytes of header, the vertices (float32 x y z, mm, Z up, in
the scan's own frame), when the scan has colours one RGBA byte quad a vertex,
and the triangles (uint32, three vertex numbers each). Little-endian. The
import process writes it; the build worker, main and the window read it.
"""

import os
import struct
from pathlib import Path
from typing import Any

import numpy as np

MAGIC = b"TORNOSCN"
MASK_MAGIC = b"TORNOMSK"
VERSION = 1
HEADER = 64
_HEAD = struct.Struct("<8sIIII6f16x")
_MASK_HEAD = struct.Struct("<8sII")


def area_of(vertices: np.ndarray, triangles: np.ndarray) -> float:
    """The area of a mesh, mm²."""
    corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64)]
    return float(np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1).sum() / 2)


def write_bin(path: str | Path, vertices: np.ndarray, triangles: np.ndarray, colours: np.ndarray | None = None) -> dict[str, Any]:
    """Write a mesh as ``mesh.bin`` and say what was written. Readers see the old file or the new one."""
    v = np.ascontiguousarray(vertices, dtype="<f4").reshape(-1, 3)
    t = np.ascontiguousarray(triangles, dtype="<u4").reshape(-1, 3)
    if len(v) == 0 or len(t) == 0:
        raise ValueError("a scan needs vertices and triangles")
    if int(t.max()) >= len(v):
        raise ValueError(f"a triangle names vertex {int(t.max())}, and there are {len(v)}")
    if not np.isfinite(v).all():
        raise ValueError("a vertex is not finite")
    c = None if colours is None else np.ascontiguousarray(colours, dtype=np.uint8).reshape(-1, 4)
    if c is not None and len(c) != len(v):
        raise ValueError(f"{len(c)} colours for {len(v)} vertices")
    low, high = v.min(axis=0), v.max(axis=0)
    temp = Path(f"{path}.{os.getpid()}.tmp")
    try:
        with open(temp, "wb") as out:
            out.write(_HEAD.pack(MAGIC, VERSION, 0 if c is None else 1, len(v), len(t), *map(float, low), *map(float, high)))
            out.write(v.tobytes())
            if c is not None:
                out.write(c.tobytes())
            out.write(t.tobytes())
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    box = {"min": [float(x) for x in low], "max": [float(x) for x in high]}
    return {"vertices": len(v), "triangles": len(t), "bbox": box, "area": area_of(v, t)}


def read_bin(path: str | Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """The vertices (V, 3), the triangles (T, 3) and the colours (V, 4) or None of a ``mesh.bin``."""
    raw = Path(path).read_bytes()
    if len(raw) < HEADER or raw[:8] != MAGIC:
        raise ValueError(f"{path} is not a scan torno wrote")
    _, version, flags, count, faces, *_ = _HEAD.unpack_from(raw)
    if version != VERSION:
        raise ValueError(f"{path} is of version {version}; this torno reads version {VERSION}")
    coloured = bool(flags & 1)
    expected = HEADER + 12 * count + (4 * count if coloured else 0) + 12 * faces
    if len(raw) != expected:
        raise ValueError(f"{path} has {len(raw)} bytes, and its header says {expected}")
    vertices = np.frombuffer(raw, "<f4", 3 * count, HEADER).reshape(-1, 3)
    at = HEADER + 12 * count
    colours = np.frombuffer(raw, np.uint8, 4 * count, at).reshape(-1, 4) if coloured else None
    triangles = np.frombuffer(raw, "<u4", 3 * faces, at + (4 * count if coloured else 0)).reshape(-1, 3)
    return vertices, triangles, colours


def write_mask(path: str | Path, bits: np.ndarray) -> None:
    """Write which triangles a region has: one bit each, bit ``i & 7`` of byte ``i >> 3``."""
    bits = np.asarray(bits, dtype=bool).reshape(-1)
    Path(path).write_bytes(_MASK_HEAD.pack(MASK_MAGIC, VERSION, len(bits)) + np.packbits(bits, bitorder="little").tobytes())


def read_mask(path: str | Path, triangles: int) -> np.ndarray:
    """The triangles of a region, as one bool each, for a mesh of ``triangles`` triangles."""
    raw = Path(path).read_bytes()
    if len(raw) < _MASK_HEAD.size or raw[:8] != MASK_MAGIC:
        raise ValueError(f"{path} is not a region torno wrote")
    _, version, count = _MASK_HEAD.unpack_from(raw)
    if version != VERSION:
        raise ValueError(f"{path} is of version {version}; this torno reads version {VERSION}")
    if count != triangles or len(raw) != _MASK_HEAD.size + (count + 7) // 8:
        raise ValueError(f"{path} is of a mesh of {count} triangles, not {triangles}")
    return np.unpackbits(np.frombuffer(raw, np.uint8, offset=_MASK_HEAD.size), bitorder="little")[:count].astype(bool)
```

Run the same command. Expected: PASS, 10 tests. Commit: `Kernel: a scan's mesh and a region's mask as files` with the trailer.

- [ ] **Step 5: Write the failing tests of the import**

`kernel/tests/test_scans.py`:

```python
"""The import process: every format, units, the up axis, colours, the limit, what is refused."""

import json
import subprocess
import sys

import numpy as np
import pytest
import scanfix

from torno_kernel import scanfile, scans

BOX = scanfix.box((40, 30, 5))


def run(capsys, *argv) -> tuple[int, dict]:
    status = scans.main([str(a) for a in argv])
    return status, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_an_stl_in_millimetres_is_kept_as_it_is(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and said["ok"] is True
    assert (said["unit"], said["up"], said["assumed"]) == ("mm", "z", {"unit": True, "up": True})
    assert (said["vertices"], said["triangles"], said["colours"], said["reduced"]) == (8, 12, "none", None)
    assert said["bbox"] == {"min": [-20, -15, -2.5], "max": [20, 15, 2.5]}
    assert said["area"] == pytest.approx(3100)
    assert said["source"]["bytes"] == source.stat().st_size and len(said["source"]["sha256"]) == 64
    vertices, triangles, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    assert len(vertices) == 8 and len(triangles) == 12 and colours is None


def test_a_glb_is_metres_and_y_up_and_its_texture_becomes_colours(tmp_path, capsys):
    source = scanfix.write_glb(tmp_path / "box.glb", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and (said["unit"], said["up"], said["colours"]) == ("m", "y", "texture")
    assert said["bbox"]["min"] == pytest.approx([-20, -15, -2.5], abs=1e-4)
    assert said["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4)
    _, _, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    # Every vertex has the uv of the bottom left pixel.
    assert {tuple(c) for c in colours.tolist()} == {(*scanfix.TEXTURE[1][0], 255)}


def test_a_ply_keeps_its_vertex_colours(tmp_path, capsys):
    vertices, triangles = scanfix.grid(4)
    paint = [[n * 10, 100, 200] for n in range(len(vertices))]
    source = scanfix.write_ply(tmp_path / "sheet.ply", vertices * 100, triangles, paint)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin")
    assert status == 0 and said["colours"] == "vertex" and said["unit"] == "mm"
    _, _, colours = scanfile.read_bin(tmp_path / "mesh.bin")
    assert colours[:, :3].tolist() == paint and set(colours[:, 3].tolist()) == {255}


def test_an_obj_is_y_up_and_a_small_one_is_metres(tmp_path, capsys):
    vertices, triangles = BOX
    in_obj = np.stack([vertices[:, 0], vertices[:, 2], -vertices[:, 1]], axis=1) / 1000
    status, said = run(capsys, "import", scanfix.write_obj(tmp_path / "box.obj", in_obj, triangles), tmp_path / "mesh.bin")
    assert status == 0 and (said["unit"], said["up"]) == ("m", "y")
    assert said["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4)


@pytest.mark.parametrize("suffix, diagonal, expected", [(".glb", 5000, ("m", "y")), (".gltf", 0.1, ("m", "y")), (".obj", 0.3, ("m", "y")), (".obj", 300, ("mm", "y")),
                                                       (".stl", 1300, ("mm", "z")), (".stl", 1.3, ("m", "z")), (".ply", 25, ("mm", "z")), (".ply", 19.9, ("m", "z"))])
def test_what_is_assumed_of_a_file(suffix, diagonal, expected):
    assert scans.guess(suffix, diagonal) == expected


def test_a_unit_and_an_up_axis_that_are_given_are_not_assumed(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin", "--unit", "in", "--up", "y")
    assert status == 0 and said["assumed"] == {"unit": False, "up": False}
    # (x, y, z) → (x, −z, y), then inches to millimetres.
    assert said["bbox"]["max"] == pytest.approx([20 * 25.4, 2.5 * 25.4, 15 * 25.4], rel=1e-6)


def test_unit_and_up_are_changed_afterwards_without_the_source(tmp_path, capsys):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    run(capsys, "import", source, tmp_path / "mesh.bin")
    source.unlink()
    status, said = run(capsys, "convert", tmp_path / "mesh.bin", "--from-unit", "mm", "--to-unit", "cm", "--from-up", "z", "--to-up", "y")
    assert status == 0 and (said["unit"], said["up"], said["assumed"]) == ("cm", "y", {"unit": False, "up": False})
    assert said["bbox"]["max"] == pytest.approx([200, 25, 150], rel=1e-6) and "source" not in said
    status, back = run(capsys, "convert", tmp_path / "mesh.bin", "--from-unit", "cm", "--to-unit", "mm", "--from-up", "y", "--to-up", "z")
    assert back["bbox"]["max"] == pytest.approx([20, 15, 2.5], abs=1e-4) and back["triangles"] == 12


def test_above_the_limit_it_is_reduced_and_says_so(tmp_path, capsys):
    vertices, triangles = scanfix.grid(60)
    source = scanfix.write_stl(tmp_path / "sheet.stl", vertices * 10, triangles)
    status, said = run(capsys, "import", source, tmp_path / "mesh.bin", "--max-triangles", "2000")
    assert status == 0 and 0 < said["triangles"] <= 2000
    assert said["reduced"]["from"] == 6962 and said["reduced"]["cell"] > 0
    assert said["bbox"]["max"][0] == pytest.approx(295, abs=said["reduced"]["cell"])


def test_a_point_cloud_is_refused(tmp_path, capsys):
    vertices, _ = scanfix.grid(4)
    status, said = run(capsys, "import", scanfix.write_ply(tmp_path / "cloud.ply", vertices, []), tmp_path / "mesh.bin")
    assert status == 1 and said == {"ok": False, "error": {"kind": "no_triangles", "message": "cloud.ply has no triangles: a point cloud cannot be shown or checked against"}}
    assert not (tmp_path / "mesh.bin").exists()


def test_what_is_no_mesh_and_what_is_no_format_are_refused(tmp_path, capsys):
    (tmp_path / "junk.glb").write_bytes(b"not a glb at all")
    status, said = run(capsys, "import", tmp_path / "junk.glb", tmp_path / "mesh.bin")
    assert status == 1 and said["error"]["kind"] == "unreadable" and "junk.glb" in said["error"]["message"]
    (tmp_path / "part.3mf").write_bytes(b"")
    status, said = run(capsys, "import", tmp_path / "part.3mf", tmp_path / "mesh.bin")
    assert status == 1 and said["error"] == {"kind": "bad_request", "message": "part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl"}
    status, said = run(capsys, "import", tmp_path / "gone.stl", tmp_path / "mesh.bin")
    assert status == 1 and said["error"]["kind"] == "unreadable" and "gone.stl" in said["error"]["message"]


def test_the_source_is_only_read(tmp_path, capsys):
    folder = tmp_path / "downloads"
    folder.mkdir()
    source = scanfix.write_stl(folder / "box.stl", *BOX)
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    run(capsys, "import", source, tmp_path / "mesh.bin")
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
    assert [p.name for p in folder.iterdir()] == ["box.stl"]


def test_the_process_says_one_line_of_json_last_and_its_stages_on_stderr(tmp_path):
    source = scanfix.write_stl(tmp_path / "box.stl", *BOX)
    done = subprocess.run([sys.executable, "-m", "torno_kernel.scans", "import", str(source), str(tmp_path / "mesh.bin")], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0
    assert json.loads(done.stdout.strip().splitlines()[-1])["triangles"] == 12
    assert "stage: reading" in done.stderr and "stage: writing" in done.stderr


def test_the_module_brings_neither_the_cad_kernel_nor_trimesh_until_it_reads():
    code = "import sys, torno_kernel.scans, torno_kernel.scanfile; bad = [m for m in ('build123d', 'OCP', 'trimesh', 'PIL') if m in sys.modules]; sys.exit(repr(bad) if bad else 0)"
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
```

Run: `(cd kernel && uv run pytest -q tests/test_scans.py)`. Expected: FAIL, `cannot import name 'scans'`.

- [ ] **Step 6: `scans.py`**

```python
"""The import process: ``python -m torno_kernel.scans import|convert …``.

It is no part of the kernel that builds: it is started for one file, reads it
with trimesh, writes one ``mesh.bin`` in millimetres and Z up, says what it
wrote as one line of JSON, its last on stdout, and exits. Its stages go to
stderr. The source is only ever read. trimesh and pillow are imported when a
file is read, and build123d never: this module must stay cheap to import.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import scanfile

FORMATS = (".glb", ".gltf", ".obj", ".ply", ".stl")
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
MAX_TRIANGLES = 2_000_000
# More than this is refused before it is read: reading it would take the machine's memory.
MAX_SOURCE_BYTES = 2 << 30
MAX_SOURCE_TRIANGLES = 20_000_000
# A mesh under this across, in its own numbers, is taken to be in metres: a scan 20 mm across is of nothing.
METRES_BELOW = 20.0


class ScanError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def guess(suffix: str, diagonal: float) -> tuple[str, str]:
    """The unit and the up axis a file is taken to have: glTF says metres and Y up; OBJ is by habit Y up."""
    if suffix in (".glb", ".gltf"):
        return "m", "y"
    return ("m" if diagonal < METRES_BELOW else "mm"), ("y" if suffix == ".obj" else "z")


def to_z_up(vertices: np.ndarray, up: str) -> np.ndarray:
    """(x, y, z) → (x, −z, y) of a Y-up mesh: what was up is +Z, and the frame stays right-handed."""
    return vertices if up == "z" else np.stack([vertices[:, 0], -vertices[:, 2], vertices[:, 1]], axis=1)


def from_z_up(vertices: np.ndarray, up: str) -> np.ndarray:
    return vertices if up == "z" else np.stack([vertices[:, 0], vertices[:, 2], -vertices[:, 1]], axis=1)


def load(path: Path, say: Callable[[str], None]) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, str]:
    """Vertices in the file's own numbers, triangles, colours or None, and where the colours are from."""
    import trimesh
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None  # a scan's texture is 8192 × 8192 and more
    say("reading")
    try:
        scene = trimesh.load(str(path), force="scene", process=False)
    except Exception as e:
        raise ScanError("unreadable", f"{path.name} could not be read: {e}") from e
    vertices, triangles, colours, kinds, base = [], [], [], set(), 0
    for node in scene.graph.nodes_geometry:
        transform, name = scene.graph[node]
        mesh = scene.geometry[name]
        faces = getattr(mesh, "faces", None)
        if faces is None or len(faces) == 0:
            continue
        if base // 3 + len(faces) > MAX_SOURCE_TRIANGLES:
            raise ScanError("too_large", f"{path.name} has more than {MAX_SOURCE_TRIANGLES:,} triangles")
        points = trimesh.transformations.transform_points(np.asarray(mesh.vertices, dtype=np.float64), transform)
        colour, kind = _colours(mesh, say)
        kinds.add(kind)
        vertices.append(points)
        triangles.append(np.asarray(faces, dtype=np.int64) + sum(len(v) for v in vertices[:-1]))
        colours.append(colour)
        base += 3 * len(faces)
    if not triangles:
        raise ScanError("no_triangles", f"{path.name} has no triangles: a point cloud cannot be shown or checked against")
    v, t = np.concatenate(vertices), np.concatenate(triangles)
    if all(c is None for c in colours):
        return (*_welded(v, t), None, "none")
    # A piece without colours of its own is the grey of an uncoloured scan.
    c = np.concatenate([np.full((len(vertices[n]), 4), (200, 200, 200, 255), np.uint8) if c is None else c for n, c in enumerate(colours)])
    c[:, 3] = 255
    return v, t, c, "texture" if "texture" in kinds else "vertex"


def _colours(mesh: Any, say: Callable[[str], None]) -> tuple[np.ndarray | None, str]:
    visual = getattr(mesh, "visual", None)
    kind = getattr(visual, "kind", None)
    if kind == "texture" and getattr(visual, "uv", None) is not None:
        material = visual.material
        if getattr(material, "baseColorTexture", None) is None and getattr(material, "image", None) is None:
            return None, "none"
        say("colours")
        return np.asarray(visual.to_color().vertex_colors, dtype=np.uint8).reshape(-1, 4).copy(), "texture"
    if kind == "vertex":
        return np.asarray(visual.vertex_colors, dtype=np.uint8).reshape(-1, 4).copy(), "vertex"
    return None, "none"


def _welded(vertices: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vertices that are in the very same place made one: an STL has three of its own a triangle."""
    rows = np.ascontiguousarray(vertices).view([("", vertices.dtype)] * 3).reshape(-1)
    _, first, inverse = np.unique(rows, return_index=True, return_inverse=True)
    return vertices[first], inverse.reshape(-1)[triangles]


def reduce(vertices: np.ndarray, triangles: np.ndarray, colours: np.ndarray | None, most: int = MAX_TRIANGLES):
    """A mesh of more than ``most`` triangles in at most that many, by merging the vertices of each cell of a grid.

    The cell starts at 1/4096 of the mesh's diagonal and grows by half until
    the triangles left are few enough. A merged vertex stands at the mean of
    those it was and has the colour of the first. Returns the mesh, and
    ``{"from": triangles before, "cell": mm}``, or None when nothing was done.
    """
    if len(triangles) <= most:
        return vertices, triangles, colours, None
    low = vertices.min(axis=0)
    cell = float(np.linalg.norm(vertices.max(axis=0) - low)) / 4096
    while True:
        keys = np.floor((vertices - low) / cell).astype(np.int64)
        packed = (keys[:, 0] << 42) | (keys[:, 1] << 21) | keys[:, 2]
        _, first, inverse = np.unique(packed, return_index=True, return_inverse=True)
        inverse = inverse.reshape(-1)
        faces = inverse[triangles]
        faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])]
        if len(faces) <= most:
            break
        cell *= 1.5
    counts = np.bincount(inverse)
    merged = np.stack([np.bincount(inverse, weights=vertices[:, axis]) / counts for axis in range(3)], axis=1)
    return merged, faces, None if colours is None else colours[first], {"from": int(len(triangles)), "cell": cell}


def _said(written: dict[str, Any], unit: str, up: str, assumed: dict[str, bool], colours: str, reduced: Any, started: float) -> dict[str, Any]:
    return {"ok": True, "unit": unit, "up": up, "assumed": assumed, **written, "colours": colours, "reduced": reduced, "seconds": round(time.monotonic() - started, 2)}


def import_scan(source: Path, out: Path, unit: str | None, up: str | None, most: int, say: Callable[[str], None]) -> dict[str, Any]:
    started = time.monotonic()
    if source.suffix.lower() not in FORMATS:
        raise ScanError("bad_request", f"{source.name} is not a scan torno reads: {', '.join(FORMATS[:-1])} or {FORMATS[-1]}")
    try:
        size = source.stat().st_size
    except OSError as e:
        raise ScanError("unreadable", f"{source.name} could not be read: {e.strerror or e}") from e
    if size > MAX_SOURCE_BYTES:
        raise ScanError("too_large", f"{source.name} is {size / 2**30:.1f} GiB: more than the 2 GiB torno reads")
    say("hashing")
    digest = hashlib.sha256()
    with open(source, "rb") as file:
        while chunk := file.read(1 << 22):
            digest.update(chunk)
    vertices, triangles, colours, kind = load(source, say)
    say("converting")
    guessed = guess(source.suffix.lower(), float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0))))
    assumed = {"unit": unit is None, "up": up is None}
    unit, up = unit or guessed[0], up or guessed[1]
    vertices = to_z_up(vertices, up) * UNIT_MM[unit]
    vertices, triangles, colours, reduced = reduce(vertices, triangles, colours, most)
    say("writing")
    written = scanfile.write_bin(out, vertices, triangles, colours)
    return {**_said(written, unit, up, assumed, kind, reduced, started), "source": {"bytes": size, "sha256": digest.hexdigest()}}


def convert(path: Path, from_unit: str, to_unit: str, from_up: str, to_up: str, say: Callable[[str], None]) -> dict[str, Any]:
    """Rewrite a ``mesh.bin`` as if its source had been read with another unit and up axis. The source is not needed."""
    started = time.monotonic()
    try:
        vertices, triangles, colours = scanfile.read_bin(path)
    except (OSError, ValueError) as e:
        raise ScanError("unreadable", str(e)) from e
    say("converting")
    own = from_z_up(vertices.astype(np.float64) / UNIT_MM[from_unit], from_up)
    say("writing")
    written = scanfile.write_bin(path, to_z_up(own, to_up) * UNIT_MM[to_unit], triangles, colours)
    return _said(written, to_unit, to_up, {"unit": False, "up": False}, "none" if colours is None else "vertex", None, started)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m torno_kernel.scans")
    commands = parser.add_subparsers(dest="command", required=True)
    read = commands.add_parser("import")
    read.add_argument("source", type=Path)
    read.add_argument("out", type=Path)
    read.add_argument("--unit", choices=list(UNIT_MM))
    read.add_argument("--up", choices=["y", "z"])
    read.add_argument("--max-triangles", type=int, default=MAX_TRIANGLES)
    change = commands.add_parser("convert")
    change.add_argument("mesh", type=Path)
    for name, choices in (("unit", list(UNIT_MM)), ("up", ["y", "z"])):
        change.add_argument(f"--from-{name}", choices=choices, required=True)
        change.add_argument(f"--to-{name}", choices=choices, required=True)
    args = parser.parse_args(argv)

    def say(stage: str) -> None:
        print(f"stage: {stage}", file=sys.stderr, flush=True)

    try:
        if args.command == "import":
            said = import_scan(args.source, args.out, args.unit, args.up, args.max_triangles, say)
        else:
            said = convert(args.mesh, args.from_unit, args.to_unit, args.from_up, args.to_up, say)
    except ScanError as e:
        said = {"ok": False, "error": {"kind": e.kind, "message": e.message}}
    except MemoryError:
        said = {"ok": False, "error": {"kind": "too_large", "message": "there was not enough memory to read it"}}
    except Exception as e:  # whatever a library raises on a file it does not like
        said = {"ok": False, "error": {"kind": "unreadable", "message": str(e) or type(e).__name__}}
    print(json.dumps(said, allow_nan=False), flush=True)
    return 0 if said["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

Notes for the implementer: `convert` cannot know whether colours came from a texture, so main keeps the `colours` it had and ignores `convert`'s. If trimesh's PLY reader raises on a file with no faces instead of returning an empty one, map that exception to `no_triangles` in `load` (the test pins the message). The bake holds both textures decoded: 1.5 GB at the peak on Micra (E2); that is why this is a process that exits.

- [ ] **Step 7: Run, then the whole kernel suite**

Run: `(cd kernel && uv run pytest -q tests/test_scans.py)`. Expected: PASS, 20 tests.
Run: `(cd kernel && uv run pytest -q)`. Expected: every test that passed before still passes.

- [ ] **Step 8: Check by hand that the kernel still starts without the extra (E1)**

```sh
tmp=$(mktemp -d) && cp -r kernel/tests/fixtures/ws/bracket "$tmp/" && cd "$tmp"
PYTHONDONTWRITEBYTECODE=1 uv run --project /home/luisgonc/projects/torno/kernel python -c "import importlib.util as u, torno_kernel; print('trimesh in the kernel:', bool(u.find_spec('trimesh')))"
```

Expected: the line prints (True in the repository's own environment, where the `dev` group has it; the point is that the import of `torno_kernel` does not need it). Then `pnpm -C app exec vitest run --mode kernel src/main/kernel/client.itest.ts`: PASS as before.

- [ ] **Step 9: Commit**

```bash
git add kernel/pyproject.toml kernel/uv.lock kernel/src/torno_kernel/scans.py kernel/tests/scanfix.py kernel/tests/test_scans.py
git commit -m "Kernel: a scan is imported by a process of its own, into one mesh in millimetres and Z up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The scan store, the import from main, and the bridge

**Files:**
- Create: `app/src/shared/scans.ts`, `app/src/shared/scans.test.ts`, `app/src/test/scanFixtures.ts`, `app/src/main/scans/file.ts`, `app/src/main/scans/store.ts`, `app/src/main/scans/store.test.ts`, `app/src/main/scans/importer.ts`, `app/src/main/scans/importer.test.ts`, `app/src/main/scans/importer.itest.ts`
- Modify: `app/src/main/kernel/client.ts` (a new exported `scanCommand`; `kernelCommand` untouched), `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/ipc.ts`, `app/src/main/index.ts` (the store, `pickFile`, quit waits for it)

**Interfaces:**
- Consumes: the import process of Task 1 and its reply.
- Produces: everything in `shared/scans.ts` ("Shared contracts"), the `scans` part of the bridge except `align` (Task 5 gives it its meaning; here it stores what it is given), and in main:

```ts
// main/kernel/client.ts
/** The command that runs the kernel package's import process for a workspace: the kernel's own, with the `scans` extra. */
export function scanCommand(opts: { workspaceRoot: string; hasProject: boolean; kernelDir: string }, args: string[]): string[]

// main/scans/importer.ts
export interface ImportReply { unit: ScanUnit; up: ScanUp; assumed: { unit: boolean; up: boolean }; vertices: number; triangles: number; colours: 'texture' | 'vertex' | 'none'; bbox: { min: Vec3; max: Vec3 }; area: number; reduced: { from: number; cell: number } | null; source?: { bytes: number; sha256: string } }
export interface Importer {
  import(source: string, out: string, opts: { unit?: ScanUnit; up?: ScanUp }, onStage?: (stage: string) => void): Promise<ImportReply>
  convert(mesh: string, from: { unit: ScanUnit; up: ScanUp }, to: { unit: ScanUnit; up: ScanUp }): Promise<ImportReply>
  /** Ends whatever is running: the workspace is left. */
  stop(): void
}
export const IMPORT_TIMEOUT_MS = 300_000
export function processImporter(command: (args: string[]) => string[], cwd: string, timeoutMs?: number): Importer
/** The reply of an import process from all it wrote on stdout: its last line. Throws an Error with the process's own message. */
export function replyOf(stdout: string, status: number | null, stderr: string): ImportReply

// main/scans/store.ts
export class ScanStore {
  constructor(deps: { dirOf(objectId: string): string | undefined; importer(): Importer | string /* why none can run */; now?(): Date; stat?: typeof import('node:fs/promises').stat })
  on(event: 'changed', cb: (m: { objectId: string; scans: ScanInfo[] }) => void): void
  on(event: 'progress', cb: (m: { objectId: string; name: string; stage: string | null }) => void): void
  list(objectId: string): Promise<ScanInfo[]>
  import(objectId: string, source: string): Promise<ScanInfo>
  convert(objectId: string, id: string, as: { unit: ScanUnit; up: ScanUp }): Promise<ScanInfo>
  rename(objectId: string, id: string, name: string): Promise<ScanInfo>
  remove(objectId: string, id: string): Promise<void>
  align(objectId: string, id: string, layout: string, alignment: ScanAlignment | null): Promise<ScanInfo>
  /** What a check of the alignments found (Task 5): kept in memory, told with the scans. */
  checked(objectId: string, id: string, layout: string, check: AlignmentCheck | null): Promise<void>
  mesh(objectId: string, id: string): Promise<Buffer>
  /** Where a scan's files are: for the kernel, which is given paths and never looks for files. */
  paths(objectId: string, id: string): { mesh: string; mask(markId: string): string } | undefined
  forget(): void
  settled(): Promise<void> | null
}
```

Behaviour:
- `scanCommand` is `['uv', 'run', '--no-sync', '--project', root, '--with-editable', `${kernelDir}[scans]`, 'python', '-m', 'torno_kernel.scans', ...args]` with a project, `['uv', 'run', '--project', kernelDir, '--extra', 'scans', 'python', '-m', 'torno_kernel.scans', ...args]` without. Where `cannotStart(opts)` gives a reason, the store's `importer()` returns that reason and `import` rejects with it: no process is started (it would create a `.venv`).
- `processImporter` spawns with `cwd` the workspace root, `env` as the kernel's (`PYTHONDONTWRITEBYTECODE: '1'`), stdio `['ignore', 'pipe', 'pipe']`; keeps all of stdout; reads `stage: <name>` lines from stderr and hands each to `onStage`; on exit calls `replyOf`; kills the process (SIGKILL) after `timeoutMs` and rejects with "the import took more than 300 s and was stopped" (the seconds are those of `timeoutMs`); `stop()` kills what runs and rejects it with "the import was stopped: the workspace was closed". One import at a time: a second waits for the first.
- `ScanStore` follows `MarkStore` (`main/marks/store.ts`): one thing at a time per object folder (`turn`), the file read once and kept, every change written atomically (`writeFileAtomic`) before it is told, `forget()` on leaving the workspace with the `epoch` guard, `settled()` for the quit.
  - `import`: refuse a path that is not absolute, has not one of `SCAN_FORMATS` as its extension (case-insensitive) or is inside `<object>/.torno/`, and a workspace no process may run in, all before anything is written (a refusal leaves no `.torno/`); then take the id `S<next>` and **write `next + 1` first** (an import that fails leaves the id unused, never reused); make `<dir>/.torno/scans/<id>/`, write `<dir>/.torno/scans/.gitignore` (`mesh.bin\n`) if it is not there; run the importer into `<id>/mesh.bin`, telling `progress` with each stage and `stage: null` at the end, whichever way it ends; `stat` the source for `mtimeMs`; add the scan (`name` the source's base name, `alignments: {}`); on failure remove the `<id>/` folder it made and reject with the importer's message.
  - `list` answers each scan with `sourceState` (`missing` when `stat` fails; `changed` when its size or `mtimeMs` is not what was recorded; else `present`: the hash is not taken again) and `meshState` (`missing` when `<id>/mesh.bin` is not a file).
  - `convert`: refuse when `meshState` is `missing`; run `importer.convert` on `mesh.bin`; set `imported.unit`, `up`, `assumed` (both false), `bbox`, `area`, `at`; keep `colours`, `vertices`, `triangles`, `reduced`; **empty `alignments`** (a scan of another size or turned otherwise is aligned to nothing).
  - `remove`: delete the scan from the file, write, then `rm -r` `<dir>/.torno/scans/<id>/`: only ever that folder, whose path is built from the id checked against `/^S\d+$/`.
  - `rename`: the name trimmed and cut to 80 characters; an empty one is refused.
  - `align`: `layout` any non-empty string; `null` deletes that layout's entry; the alignment is sanitised (below).
  - `mesh`: the bytes of `mesh.bin`; rejects with "S1's mesh is gone from <path>. Import it again from <source path>" (and "…, which is missing too" when it is).
- `main/scans/file.ts`: `loadScansFile(dir)` (missing file: `{ next: 1, scans: [] }`; a file that is not JSON or not a scans file: copied aside as `scans.json.corrupt-<time>` and a new one started with `next` past every `S<n>` seen in its text, as `marks/file.ts` does), `saveScansFile(dir, file)`, `sanitiseScan(value): Scan | null`: every number finite, `q` normalised (a zero quaternion is identity), `s` within 1e-6 to 1e6, unit and up of their sets, `steps` non-empty and of the four, `pairs` at most 64 each with two finite points, an unknown key dropped.
- `ipc.ts`: handlers `scans:list`, `scans:pick`, `scans:import`, `scans:convert`, `scans:rename`, `scans:remove`, `scans:align`, `scans:mesh` (answering `toArrayBuffer(buffer)`, as `object:scene` sends its blob), each naming the object by id and rejecting with a plain message; broadcasts `scans:changed` and `scans:progress`. `scans:align` adds `frame` (each part of that layout in the last scene with its `arranged ?? [0, 0, 0]`) and `at`. `scans:pick` uses `opts.pickFile` when given, else `dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Scans', extensions: ['glb', 'gltf', 'obj', 'ply', 'stl'] }] })`. `registerIpc` gains `scans?: ScanStore` and `pickFile?: () => Promise<string | null>`. `closeWorkspace` calls `scans?.forget()` and stops the importer.
- `index.ts`: the store is made with `importer: () => { const ws = openWorkspaceInfo(); … }` returning `processImporter((args) => scanCommand({ workspaceRoot, hasProject, kernelDir: kernelDir() }, args), workspaceRoot)` or the reason from `cannotStart`; `testHooks` gains `scans` (the store), `pickFile: null as string | null` and `filePicks: 0`; under `TORNO_TEST=1` `pickFile` answers `testHooks.pickFile` and counts; `will-quit` also waits for `scans.settled()`.
- `preload/index.ts`: the `scans` block, with `pathOf: (file) => webUtils.getPathForFile(file)` (`import { contextBridge, ipcRenderer, webUtils } from 'electron'`).

- [ ] **Step 1: Write `shared/scans.ts` tests and the fixtures**

`app/src/test/scanFixtures.ts`:

```ts
// Scans made by test code. Nothing here is a file in the repository, and none is the owner's.
type Vec3 = [number, number, number]

const BOX = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]

/** A box: 8 vertices, 12 triangles facing out. Vertex 4·i + 2·j + k is at (±x, ±y, ±z), minus first. */
export function box(size: Vec3 = [40, 30, 5], centre: Vec3 = [0, 0, 0]): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push(centre[0] + (x * size[0]) / 2, centre[1] + (y * size[1]) / 2, centre[2] + (z * size[2]) / 2)
  return { vertices, triangles: BOX.flat() }
}

/** A flat square sheet facing +Z: `count` vertices a side, `cell` apart, centred on the Z axis, lifted by `height(x, y)`. */
export function grid(count = 30, cell = 1, height: (x: number, y: number) => number = () => 0): { vertices: number[]; triangles: number[] } {
  const vertices: number[] = []
  const triangles: number[] = []
  const at = (n: number): number => (n - (count - 1) / 2) * cell
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) vertices.push(at(i), at(j), height(at(i), at(j)))
  for (let i = 0; i < count - 1; i++) {
    for (let j = 0; j < count - 1; j++) {
      const a = i * count + j
      triangles.push(a, a + count, a + count + 1, a, a + count + 1, a + 1)
    }
  }
  return { vertices, triangles }
}

/** A rigid move of a mesh: turned by `degrees` about +Z, then moved by `by`. */
export function moved(mesh: { vertices: number[]; triangles: number[] }, degrees: number, by: Vec3): { vertices: number[]; triangles: number[] } {
  const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)]
  const vertices: number[] = []
  for (let n = 0; n < mesh.vertices.length; n += 3) {
    const [x, y, z] = mesh.vertices.slice(n, n + 3)
    vertices.push(c * x - s * y + by[0], s * x + c * y + by[1], z + by[2])
  }
  return { vertices, triangles: mesh.triangles }
}

/** A binary STL of a mesh. */
export function stl(mesh: { vertices: number[]; triangles: number[] }): Buffer {
  const count = mesh.triangles.length / 3
  const out = Buffer.alloc(84 + 50 * count)
  out.writeUInt32LE(count, 80)
  for (let n = 0; n < count; n++) {
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.triangles[n * 3 + corner] * 3
      for (let axis = 0; axis < 3; axis++) out.writeFloatLE(mesh.vertices[v + axis], 84 + 50 * n + 12 + 12 * corner + 4 * axis)
    }
  }
  return out
}

/** A `mesh.bin` of a mesh, as the import process would write it; `colours` are r g b a bytes, one quad a vertex. */
export function meshBin(mesh: { vertices: number[]; triangles: number[] }, colours?: number[]): ArrayBuffer {
  const v = mesh.vertices.length / 3
  const t = mesh.triangles.length / 3
  const out = new ArrayBuffer(64 + 12 * v + (colours ? 4 * v : 0) + 12 * t)
  const view = new DataView(out)
  new Uint8Array(out).set(new TextEncoder().encode('TORNOSCN'))
  view.setUint32(8, 1, true)
  view.setUint32(12, colours ? 1 : 0, true)
  view.setUint32(16, v, true)
  view.setUint32(20, t, true)
  for (let axis = 0; axis < 3; axis++) {
    const along = mesh.vertices.filter((_, n) => n % 3 === axis)
    view.setFloat32(24 + 4 * axis, Math.min(...along), true)
    view.setFloat32(36 + 4 * axis, Math.max(...along), true)
  }
  new Float32Array(out, 64, 3 * v).set(mesh.vertices)
  if (colours) new Uint8Array(out, 64 + 12 * v, 4 * v).set(colours)
  new Uint32Array(out, 64 + 12 * v + (colours ? 4 * v : 0), 3 * t).set(mesh.triangles)
  return out
}
```

`app/src/shared/scans.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { box, meshBin } from '../test/scanFixtures'
import { type ScanAlignment, type ScanImport, alignmentText, importText, maskBits, maskFile, parseScanMesh, staleText } from './scans'

describe('parseScanMesh', () => {
  it('gives views of the vertices, the colours and the triangles of a mesh.bin', () => {
    const colours = Array.from({ length: 8 }, (_, n) => [n, 2 * n, 3 * n, 255]).flat()
    const mesh = parseScanMesh(meshBin(box([40, 30, 5]), colours))
    expect(mesh.vertices).toHaveLength(24)
    expect([...mesh.vertices.slice(0, 3)]).toEqual([-20, -15, -2.5])
    expect([...mesh.colours!.slice(4, 8)]).toEqual([1, 2, 3, 255])
    expect([...mesh.triangles.slice(0, 3)]).toEqual([0, 1, 3])
    expect(mesh.bbox).toEqual({ min: [-20, -15, -2.5], max: [20, 15, 2.5] })
    expect(parseScanMesh(meshBin(box())).colours).toBeNull()
  })

  it('says what is wrong with bytes that are no mesh.bin', () => {
    const good = meshBin(box())
    expect(() => parseScanMesh(good.slice(0, 40))).toThrow(/not a scan torno wrote/)
    expect(() => parseScanMesh(good.slice(0, good.byteLength - 4))).toThrow(/has 300 bytes, and its header says 304/)
    const other = good.slice(0)
    new DataView(other).setUint32(8, 2, true)
    expect(() => parseScanMesh(other)).toThrow(/version 2/)
    const wild = good.slice(0)
    new Uint32Array(wild, 64 + 96, 1)[0] = 8
    expect(() => parseScanMesh(wild)).toThrow(/a triangle names vertex 8, and there are 8/)
  })
})

describe('a mask', () => {
  it('is one bit a triangle behind a header that says how many', () => {
    const bits = new Uint8Array([0b00000001, 0b00000010])
    const file = maskFile(bits, 12)
    expect(new TextDecoder().decode(file.slice(0, 8))).toBe('TORNOMSK')
    expect(new DataView(file.buffer).getUint32(12, true)).toBe(12)
    expect([...maskBits(file, 12)]).toEqual([1, 2])
    expect(() => maskBits(file, 13)).toThrow(/12 triangles, not 13/)
    expect(() => maskFile(new Uint8Array(3), 12)).toThrow(/2 bytes/)
  })
})

describe('what is said of a scan', () => {
  const imported: ScanImport = { unit: 'm', up: 'y', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-1258.9, -1175.3, 0], max: [1258.9, 1175.3, 1493.6] }, area: 1, at: '' }
  const aligned: ScanAlignment = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['floor'], rms: 0.8, frame: {}, at: '' }

  it('gives its size in millimetres and what was assumed', () => {
    expect(importText(imported)).toBe('2518 × 2351 × 1494 mm, from m, Y up (assumed)')
    expect(importText({ ...imported, assumed: { unit: false, up: true } })).toBe('2518 × 2351 × 1494 mm, from m, Y up (up assumed)')
    expect(importText({ ...imported, assumed: { unit: false, up: false }, reduced: { from: 5_000_000, cell: 2.4 } })).toBe('2518 × 2351 × 1494 mm, from m, Y up, reduced from 5,000,000 triangles')
  })

  it('says how it was aligned, and when a floor is all there is', () => {
    expect(alignmentText(aligned)).toBe('by floor only (plane rms 0.8 mm): its place in that plane is as imported')
    const pairs = [1.8, 3.4, 0.9, 1.2].map((residual) => ({ scan: [0, 0, 0] as [number, number, number], model: [0, 0, 0] as [number, number, number], residual }))
    expect(alignmentText({ ...aligned, steps: ['floor', 'pairs'], pairs, rms: 2.1 })).toBe('by floor + 4 pairs (rms 2.1 mm, worst 3.4 mm)')
    expect(alignmentText({ ...aligned, steps: ['pairs', 'nudge'], pairs, rms: 2.1, scaled: true })).toBe('by 4 pairs (rms 2.1 mm, worst 3.4 mm), scaled + nudge')
    expect(alignmentText({ ...aligned, steps: ['typed'], rms: undefined })).toBe('by typed values')
  })

  it('says when the model has moved under an alignment', () => {
    expect(staleText(undefined)).toBeNull()
    expect(staleText({ revision: 4, of: 4, off: 0, worst: 0.1, moved: [] })).toBeNull()
    expect(staleText({ revision: 4, of: 4, off: 2, worst: 6.2, moved: [] })).toBe('the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r4: check the alignment')
    expect(staleText({ revision: 4, of: 0, off: 0, worst: 0, moved: ['lid'] })).toBe('torno has moved lid for display since it was aligned: check the alignment')
  })
})
```

Run: `pnpm -C app exec vitest run src/shared/scans.test.ts`. Expected: FAIL, cannot find `./scans`.

- [ ] **Step 2: Implement `shared/scans.ts`**

The types are those of "Shared contracts", verbatim. `parseScanMesh` reads the header with a `DataView`, throws `RangeError` with exactly the texts the test pins (`<n> bytes is not a scan torno wrote`, `a scan of version <v>: this torno reads version 1`, `has <n> bytes, and its header says <m>`, `a triangle names vertex <i>, and there are <V>`: the last by one pass over the triangles for their maximum), and returns `new Float32Array(blob, 64, 3 * V)`, `new Uint8Array(blob, 64 + 12 * V, 4 * V)` or null, `new Uint32Array(blob, …, 3 * T)`. Numbers in the three texts go through `shared/format.ts` `number`; counts through `toLocaleString('en-US')`.

Run the test again. Expected: PASS.

- [ ] **Step 3: Write the failing store tests**

`app/src/main/scans/store.test.ts` (complete: these are the tests of Review Focus 2):

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanAlignment, ScanInfo } from '../../shared/scans'
import { box, meshBin, stl } from '../../test/scanFixtures'
import type { ImportReply, Importer } from './importer'
import { ScanStore } from './store'

let root: string
let dir: string
let source: string
let ran: Array<{ what: string; args: unknown[] }>
let fails: string | null

const REPLY: ImportReply = { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, reduced: null, source: { bytes: 684, sha256: 'ab'.repeat(32) } }
const ALIGNED: ScanAlignment = { transform: { t: [1, 2, 3], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { base: [0, 0, 0] }, at: '2026-10-10T09:00:00.000Z' }

/** Stands in for the import process: writes a mesh.bin where it is told to, unless it is to fail. */
const importer: Importer = {
  async import(from, out, opts, onStage) {
    ran.push({ what: 'import', args: [from, out, opts] })
    onStage?.('reading')
    if (fails) throw new Error(fails)
    writeFileSync(out, Buffer.from(meshBin(box())))
    return REPLY
  },
  async convert(mesh, from, to) {
    ran.push({ what: 'convert', args: [mesh, from, to] })
    return { ...REPLY, unit: to.unit, up: to.up, assumed: { unit: false, up: false }, bbox: { min: [-200, -150, -25], max: [200, 150, 25] }, source: undefined }
  },
  stop() {}
}
const store = (give: Importer | string = importer): ScanStore => new ScanStore({ dirOf: (id) => (id === 'bracket' ? dir : undefined), importer: () => give, now: () => new Date('2026-10-10T09:00:00.000Z') })
const file = (): { next: number; scans: ScanInfo[] } => JSON.parse(readFileSync(join(dir, '.torno', 'scans.json'), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torno-scans-'))
  dir = join(root, 'bracket')
  mkdirSync(dir)
  mkdirSync(join(root, 'downloads'))
  source = join(root, 'downloads', 'Box.STL')
  writeFileSync(source, stl(box()))
  ran = []
  fails = null
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ScanStore', () => {
  it('imports a scan into .torno/scans/S1, and records its source without touching it', async () => {
    const before = readFileSync(source)
    const scan = await store().import('bracket', source)
    expect(scan).toMatchObject({ id: 'S1', name: 'Box.STL', source: { path: source, bytes: 684, sha256: 'ab'.repeat(32) }, imported: { unit: 'mm', triangles: 12 }, alignments: {}, sourceState: 'present', meshState: 'ok' })
    expect(ran[0].args[1]).toBe(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect(file()).toMatchObject({ next: 2, scans: [{ id: 'S1' }] })
    expect(readFileSync(join(dir, '.torno', 'scans', '.gitignore'), 'utf8')).toBe('mesh.bin\n')
    expect(readFileSync(source).equals(before)).toBe(true)
    expect(readdirSync(join(root, 'downloads'))).toEqual(['Box.STL'])
    // Nothing of the object's folder but .torno was written.
    expect(readdirSync(dir)).toEqual(['.torno'])
  })

  it('never gives an id twice: not after a removal, not after an import that failed', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.remove('bracket', 'S1')
    expect(existsSync(join(dir, '.torno', 'scans', 'S1'))).toBe(false)
    fails = 'Box.STL could not be read: bad header'
    await expect(scans.import('bracket', source)).rejects.toThrow('Box.STL could not be read: bad header')
    expect(existsSync(join(dir, '.torno', 'scans', 'S2'))).toBe(false)
    fails = null
    expect((await scans.import('bracket', source)).id).toBe('S3')
    expect(file().next).toBe(4)
    // And a store that reads the file afresh goes on from there.
    expect((await store().import('bracket', source)).id).toBe('S4')
  })

  it('refuses what is no scan file, and a workspace no process may run in', async () => {
    await expect(store().import('bracket', 'relative.stl')).rejects.toThrow('give the whole path of the file')
    await expect(store().import('bracket', join(root, 'downloads', 'part.3mf'))).rejects.toThrow('part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl')
    await expect(store('This workspace has a pyproject.toml but no .venv. Run `uv sync` in /ws once, then reopen it.').import('bracket', source)).rejects.toThrow('no .venv')
    await expect(store().import('nothing', source)).rejects.toThrow('no object named nothing')
    expect(existsSync(join(dir, '.torno'))).toBe(false)
  })

  it('goes on working when the source is moved, and says so', async () => {
    const scans = store()
    await scans.import('bracket', source)
    rmSync(source)
    const [scan] = await scans.list('bracket')
    expect(scan).toMatchObject({ sourceState: 'missing', meshState: 'ok' })
    expect((await scans.mesh('bracket', 'S1')).byteLength).toBe(64 + 96 + 144)
  })

  it('says when the source has changed since', async () => {
    const scans = store()
    await scans.import('bracket', source)
    utimesSync(source, new Date('2027-01-01'), new Date('2027-01-01'))
    expect((await scans.list('bracket'))[0].sourceState).toBe('changed')
  })

  it('says what to do when the mesh is gone, and that the source is too', async () => {
    const scans = store()
    await scans.import('bracket', source)
    rmSync(join(dir, '.torno', 'scans', 'S1', 'mesh.bin'))
    expect((await scans.list('bracket'))[0].meshState).toBe('missing')
    await expect(scans.mesh('bracket', 'S1')).rejects.toThrow(`S1's mesh is gone from ${join(dir, '.torno', 'scans', 'S1', 'mesh.bin')}. Import it again from ${source}`)
    rmSync(source)
    await expect(scans.mesh('bracket', 'S1')).rejects.toThrow(`Import it again from ${source}, which is missing too`)
    await expect(scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })).rejects.toThrow("S1's mesh is gone")
  })

  it('keeps a transform for each layout, and drops them all when the unit is changed', async () => {
    const scans = store()
    await scans.import('bracket', source)
    await scans.align('bracket', 'S1', 'assembly', ALIGNED)
    await scans.align('bracket', 'S1', 'print', { ...ALIGNED, transform: { t: [9, 9, 9], q: [0, 0, 0, 2], s: 1 } })
    expect(file().scans[0].alignments.print.transform.q).toEqual([0, 0, 0, 1])
    expect(Object.keys((await scans.align('bracket', 'S1', 'print', null)).alignments)).toEqual(['assembly'])
    const converted = await scans.convert('bracket', 'S1', { unit: 'cm', up: 'z' })
    expect(converted).toMatchObject({ imported: { unit: 'cm', assumed: { unit: false, up: false }, colours: 'none', bbox: { max: [200, 150, 25] } }, alignments: {} })
    expect(ran.at(-1)).toEqual({ what: 'convert', args: [join(dir, '.torno', 'scans', 'S1', 'mesh.bin'), { unit: 'mm', up: 'z' }, { unit: 'cm', up: 'z' }] })
  })

  it('tells each change once it is written, and the stages of an import', async () => {
    const scans = store()
    const told: string[] = []
    scans.on('changed', (m) => told.push(`${m.objectId}: ${m.scans.map((s) => s.id).join(' ')}`))
    scans.on('progress', (m) => told.push(`${m.name}: ${m.stage}`))
    await scans.import('bracket', source)
    await scans.rename('bracket', 'S1', '  engine bay  ')
    expect(told).toEqual(['Box.STL: reading', 'Box.STL: null', 'bracket: S1', 'bracket: S1'])
    expect(file().scans[0].name).toBe('engine bay')
    await expect(scans.rename('bracket', 'S1', ' ')).rejects.toThrow('a scan needs a name')
    await expect(scans.rename('bracket', 'S9', 'x')).rejects.toThrow('no scan S9; scans: S1')
  })

  it('sets a file that is no scans file aside and starts past every id it held', async () => {
    mkdirSync(join(dir, '.torno'))
    writeFileSync(join(dir, '.torno', 'scans.json'), '{"next": 3, "scans": [{"id": "S7", ')
    expect(await store().list('bracket')).toEqual([])
    expect(readdirSync(join(dir, '.torno')).some((name) => name.startsWith('scans.json.corrupt-'))).toBe(true)
    expect((await store().import('bracket', source)).id).toBe('S8')
  })
})
```

`app/src/main/scans/importer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { scanCommand } from '../kernel/client'
import { processImporter, replyOf } from './importer'

describe('the import process', () => {
  it('is the kernel package with its scans extra, in the environment of the workspace and never synced', () => {
    expect(scanCommand({ workspaceRoot: '/ws', hasProject: true, kernelDir: '/torno/kernel' }, ['import', '/a.stl', '/out.bin'])).toEqual(
      ['uv', 'run', '--no-sync', '--project', '/ws', '--with-editable', '/torno/kernel[scans]', 'python', '-m', 'torno_kernel.scans', 'import', '/a.stl', '/out.bin'])
    expect(scanCommand({ workspaceRoot: '/ws', hasProject: false, kernelDir: '/torno/kernel' }, ['convert', '/m.bin'])).toEqual(
      ['uv', 'run', '--project', '/torno/kernel', '--extra', 'scans', 'python', '-m', 'torno_kernel.scans', 'convert', '/m.bin'])
  })

  it('answers with the last line it wrote, or rejects with its own words', () => {
    expect(replyOf('noise\n{"ok": true, "unit": "mm", "triangles": 12}\n', 0, '')).toMatchObject({ unit: 'mm', triangles: 12 })
    expect(() => replyOf('{"ok": false, "error": {"kind": "no_triangles", "message": "cloud.ply has no triangles"}}\n', 1, '')).toThrow('cloud.ply has no triangles')
    expect(() => replyOf('', 2, 'error: No solution found when resolving `--with` dependencies\n  trimesh was not found in the cache')).toThrow(/the import could not be started: .*trimesh was not found in the cache/s)
    expect(() => replyOf('Traceback…', null, '')).toThrow('the import process ended without an answer')
  })

  it('stops a process that takes too long, and one whose workspace is left', async () => {
    const hang = processImporter(() => ['node', '-e', 'setInterval(() => {}, 1000)'], process.cwd(), 200)
    await expect(hang.import('/a.stl', '/out.bin', {})).rejects.toThrow('was stopped')
    const left = processImporter(() => ['node', '-e', 'setInterval(() => {}, 1000)'], process.cwd())
    const pending = left.import('/a.stl', '/out.bin', {})
    setTimeout(() => left.stop(), 100)
    await expect(pending).rejects.toThrow('the import was stopped: the workspace was closed')
  })

  it('hands on each stage the process names on stderr', async () => {
    const script = "console.error('stage: reading'); console.error('stage: writing'); console.log(JSON.stringify({ ok: true, unit: 'mm', up: 'z', triangles: 12 }))"
    const stages: string[] = []
    await processImporter(() => ['node', '-e', script], process.cwd()).import('/a.stl', '/out.bin', {}, (stage) => stages.push(stage))
    expect(stages).toEqual(['reading', 'writing'])
  })
})
```

`app/src/main/scans/importer.itest.ts` (the real process, on a generated STL in a temp folder; `kernelDir` is `resolve(__dirname, '../../../../kernel')`, `hasProject: false` so the kernel's own environment is used):

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseScanMesh } from '../../shared/scans'
import { box, stl } from '../../test/scanFixtures'
import { scanCommand } from '../kernel/client'
import { processImporter } from './importer'

it('imports a real file with the real process, and changes its unit afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'torno-import-'))
  try {
    writeFileSync(join(dir, 'box.stl'), stl(box([40, 30, 5])))
    const importer = processImporter((args) => scanCommand({ workspaceRoot: dir, hasProject: false, kernelDir: resolve(__dirname, '../../../../kernel') }, args), dir)
    const said = await importer.import(join(dir, 'box.stl'), join(dir, 'mesh.bin'), {})
    expect(said).toMatchObject({ unit: 'mm', up: 'z', vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] } })
    const bytes = readFileSync(join(dir, 'mesh.bin'))
    expect(parseScanMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).triangles).toHaveLength(36)
    const converted = await importer.convert(join(dir, 'mesh.bin'), { unit: 'mm', up: 'z' }, { unit: 'm', up: 'z' })
    expect(converted.bbox.max).toEqual([20000, 15000, 2500])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

Run: `pnpm -C app exec vitest run src/main/scans` Expected: FAIL (no `./store`, no `./importer`, no `scanCommand`).

- [ ] **Step 4: Implement `scanCommand`, `importer.ts`, `file.ts`, `store.ts`** as "Behaviour" says, with these exact messages: `give the whole path of the file`, `<name> is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl`, `no scan <id>; scans: <ids or none>`, `a scan needs a name`, `the import took more than <n> s and was stopped`, `the import was stopped: the workspace was closed`, `the import could not be started: <the last 6 lines of stderr>` (exit status other than 0 and 1, or no JSON line), `the import process ended without an answer`.

Run: `pnpm -C app exec vitest run src/main/scans src/shared/scans.test.ts` Expected: PASS. Run: `pnpm -C app exec vitest run --mode kernel src/main/scans/importer.itest.ts` Expected: PASS (the first run builds the kernel's environment with the extra).

- [ ] **Step 5: The bridge, the preload, the IPC and main's hooks** as "Behaviour" says. Add to `app/src/main/ipc.ts` beside the marks handlers; every handler is `ipcMain.handle('scans:…', (_event, objectId: string, …) => requireScans().…(String(objectId), …))`.

Run: `pnpm -C app typecheck` Expected: clean. Run: `pnpm test` Expected: every test that passed before, and the new ones.

- [ ] **Step 6: Commit**

```bash
git add app/src/shared/scans.ts app/src/shared/scans.test.ts app/src/test/scanFixtures.ts app/src/main/scans app/src/main/kernel/client.ts app/src/shared/bridge.ts app/src/preload/index.ts app/src/main/ipc.ts app/src/main/index.ts
git commit -m "Main: the scans of an object are kept like its marks, and imported by a process that only reads the source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The scan on screen

**Files:**
- Create: `app/src/renderer/viewport/scanMesh.ts`, `scanMesh.test.ts`, `app/src/renderer/viewport/scans.ts`, `scans.test.ts`, `app/src/renderer/ui/ScansPanel.tsx`, `app/src/renderer/ui/scanDrop.ts`, `scanDrop.test.ts`, `app/e2e/scan.spec.ts`
- Modify: `app/src/shared/scenefile.ts`, `app/src/main/scenefile.ts`, `scenefile.test.ts`, `app/src/shared/view.ts`, `app/src/renderer/state/store.ts`, `store.test.ts`, `app/src/renderer/viewport/Viewport.ts`, `viewport/picture.ts`, `picture.test.ts`, `app/src/renderer/App.tsx`, `ui/ViewportPane.tsx`, `styles/tokens.css`, `styles/app.css`

**Interfaces:**
- Consumes: `window.torno.scans` (Task 2), `parseScanMesh`, `ScanInfo`, `ScanView`, `alignmentOf`, `importText`, `staleText` (`shared/scans.ts`).
- Produces:

```ts
// viewport/scanMesh.ts
export interface BuiltScan {
  id: string
  /** Placed by the scan's transform for the layout shown. Add this to the scene. */
  group: THREE.Group
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>
  /** Unlit, in the scan's own colours; null for a scan that has none. */
  own: THREE.MeshBasicMaterial | null
  /** Lit, flat shaded, in `--scan-plain`. */
  plain: THREE.MeshStandardMaterial
  vertices: number
  triangles: number
}
/** sRGB bytes r g b a per vertex as linear r g b per vertex, 0 to 65535: what three.js takes vertex colours to be. */
export function linearColours(rgba: Uint8Array): Uint16Array
/** The three.js objects of one scan. The geometry owns copies of the positions and the triangles, in the file's order. No bounds tree: `scanBvh.ts` makes it (Task 4). */
export function buildScan(id: string, blob: ArrayBuffer): BuiltScan
export function placeScan(built: BuiltScan, transform: ScanTransform): void
export function disposeScan(built: BuiltScan): void

// viewport/scans.ts
export interface ScanLayerState { id: string; loaded: boolean; ready: boolean /* its tree is there: it can be picked (Task 4) */; triangles: number; aligned: boolean; visible: boolean; opacity: number; transform: ScanTransform }
export class ScanLayer {
  readonly group: THREE.Group
  constructor(redraw: () => void)
  /** The scans of the object on show, and the layout shown: which there are and where each stands. Their meshes come by `load`. */
  set(scans: ScanInfo[], layout: string): void
  /** The scans there are whose mesh has not come and can (`meshState: 'ok'`). */
  wanting(): string[]
  load(id: string, blob: ArrayBuffer): void
  setView(id: string, view: ScanView): void
  setLook(look: { plain: string; surface: string }, stale: boolean): void
  setClipping(planes: THREE.Plane[] | null): void
  /** For a picture: only these are drawn (none for null), each as it is on screen. Returns what puts the screen back. */
  showOnly(ids: string[] | null): () => void
  shown(): Array<{ id: string; visible: boolean; opacity: number }>
  /** A box round what is drawn of them, in the object frame; null when nothing is. */
  box(): THREE.Box3 | null
  state(): ScanLayerState[]
  dispose(): void
}

// Viewport
setScans(scans: ScanInfo[]): void          // with the layout shown; called again by `setLayout`
setScanMesh(id: string, blob: ArrayBuffer): void
setScanView(id: string, view: ScanView): void
wantingScans(): string[]
scanState(): ScanLayerState[]

// picture.ts
export interface ImageRequest { /* as now */; scans?: 'current' | false | string[] }

// state/store.ts
scans: ScanInfo[]                              // of the open object, as main last told them
scanViews: Record<string, ScanView>            // by scan id: what scene.json keeps
importing: { name: string; stage: string | null } | null
actions.setScans(m: { objectId: string; scans: ScanInfo[] }): void
actions.setScanView(id: string, view: ScanView): void     // the person's own choice: counts as an edit, saved
actions.setImporting(m: { objectId: string; name: string; stage: string | null }): void

// ui/scanDrop.ts
/** Of the files dropped, the first torno reads as a scan: its index, or -1. */
export function droppedScan(files: ArrayLike<{ name: string }>): number
export const NOT_A_SCAN = 'torno reads .glb, .gltf, .obj, .ply and .stl scans'
```

Behaviour:
- **Drawing.** With colours: `MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })` on a `color` attribute made by `linearColours` (`new THREE.BufferAttribute(u16, 3, true)`): unlit, as the owner's own viewer drew it (groundwork, section 1). Without, or with colour mode `plain`: `MeshStandardMaterial({ color: --scan-plain, flatShading: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 })`; no normal attribute is made (flat shading needs none, and 1.6 M triangles' worth is 11 MB). Both: `polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2` (a part that lies in the scan's surface wins), `transparent` and `depthWrite = false` when opacity is under 0.95. `mesh.frustumCulled = false` is not set: the bounding sphere is computed once at build.
- **Where.** `placeScan` sets the group's position `t`, quaternion `q` and uniform scale `s`. A scan with no alignment for the layout shown stands at `IDENTITY` and is `aligned: false`. A stale build fades it like the parts (`mix` with the surface colour for `plain`; `own.color` set to the same fade factor, which multiplies vertex colours).
- **Defaults.** Visible, opacity 1, colour `own` when it has colours.
- **Section.** `Viewport`'s `SectionCut` is constructed with `(planes) => { this.highlights.setClipping(planes); this.scans.setClipping(planes) }`: both materials of every scan get `clippingPlanes`. Scans are never added to `SectionCut.add`: no stencil pass, no cap (R9).
- **Extent.** `Viewport.measured()` unions `scans.box()` into the sphere the camera's near and far are set by, so a 2.5 m scan round a 200 mm part is not cut by the far plane. `fit()` and the named views still frame the parts only.
- **Pictures.** `asPictured` calls `host.scans.showOnly(…)` after hiding the parts and restores it in `finally`. `'current'` or absent: as on screen. `false`: none. Ids: those (an unknown id is an error naming the scans there are). The caption gains ` · scans S1 at 60 %, S2` after the parts (opacity only when under 100 %), and nothing when no scan is drawn. `PictureHost` gains `scans: Pick<ScanLayer, 'showOnly' | 'shown' | 'box'>`.
- **The window's state.** `ViewportPane.connect` subscribes `window.torno.scans.onChanged` and `onProgress`, lists the scans when an object is opened, calls `viewport.setScans`, and for every id in `viewport.wantingScans()` fetches `window.torno.scans.mesh(objectId, id)` once (a Set of ids being fetched; dropped when the object changes) and hands it to `viewport.setScanMesh`. `report()` adds `scans: viewport.scanState().map(({ id, visible, opacity }) => ({ id, visible, opacity }))`. `__tornoTest` gains `scans: () => viewport.scanState()`.
- **`scene.json`.** `clean` in `main/scenefile.ts` keeps `scans` entries whose key matches `/^S\d+$/`: `visible` a boolean, `opacity` clamped to 0.05 to 1, `colour` `'own'` or `'plain'`. `sceneFileOf` writes `scanViews` when it has any; `actions.openObject` reads them.
- **The panel** (`ScansPanel`, under `Layers` in the left column of `App.tsx`, `aria-label="Scans"`, class `section scans`): the title "Scans" and beside it a button "Import scan…" (`title="Import a scan: GLB, glTF, OBJ, PLY or STL"`), which calls `window.torno.scans.pick()` and then `import`. With no scans: the note "Drop a scan on the view, or import one." A row per scan (`li.row.scan-row[data-scan="S1"]`):
  - the id in the monospace face, the name, and under them in `--muted` the `importText` line with every number in `num`;
  - one chip (`span.chip[data-state]`), the first that applies: `mesh missing` (`data-state="mesh-missing"`, `--fail`), `check alignment` (`"stale"`, `--warn`, its `title` the `staleText`), `not aligned here` (`"unaligned"`, `--warn`), `aligned` (`"aligned"`, `--ok`); and a second, quiet one, `source missing` (`"source-missing"`) or `source changed` (`"source-changed"`), when that is so;
  - the opacity slider and the eye, built as `Layers.tsx` builds them (`aria-label="Opacity of S1"`, `aria-label="Show S1"`);
  - a disclosure "More" with: unit (`select`, `aria-label="Unit of S1"`) and up axis (`aria-label="Up axis of S1"`), applied by "Apply", which asks first through `Confirm` when the scan has alignments ("Changing the unit or the up axis of S1 drops its alignment in print and assembly."); colour (`Own colours` / `Plain`, the first disabled for a scan without); "Import again" when the mesh is missing and the source is not; "Remove" (asks: "Remove S1 from this object? Its source file is not touched.").
  - While something is imported, a line under the title: "Reading Micra.glb: colours" from `importing` (`stage` words: `hashing` → "checking the file", `reading`, `colours`, `converting`, `writing`); a rejection is shown there in `--fail` until the next import or a click on it.
- **Drop.** The viewport's host element takes `dragover` (it calls `preventDefault()` only when `e.dataTransfer.types` includes `'Files'`, and sets `dropEffect = 'copy'`) and `drop`: `droppedScan(e.dataTransfer.files)`; -1 → the readout says `NOT_A_SCAN`; else `window.torno.scans.pathOf(file)`, and an empty path says "That file has no place on the disk"; else `import`. Nothing of a drag goes through React.
- **Tokens.** `--scan-plain: #B4AFA5` (light), `#5A5E64` (dark): a paper grey a step from `--surface`, no hue of the part palette. `Viewport`'s `Theme` gains `scan`, read in `readTheme`.

- [ ] **Step 1: Write the failing unit tests**

`app/src/renderer/viewport/scanMesh.test.ts`:

```ts
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { box, meshBin } from '../../test/scanFixtures'
import { buildScan, linearColours, placeScan } from './scanMesh'

describe('linearColours', () => {
  it('turns sRGB bytes into linear light, three a vertex', () => {
    expect([...linearColours(new Uint8Array([0, 128, 255, 255, 255, 0, 128, 255]))]).toEqual([0, 14146, 65535, 65535, 0, 14146])
  })
})

describe('buildScan', () => {
  it('draws a coloured scan unlit, in its own colours, from both sides', () => {
    const built = buildScan('S1', meshBin(box([40, 30, 5]), new Array(32).fill(255)))
    expect(built).toMatchObject({ id: 'S1', vertices: 8, triangles: 12 })
    expect(built.mesh.material).toBe(built.own)
    expect(built.own).toMatchObject({ vertexColors: true, side: THREE.DoubleSide })
    expect(built.mesh.geometry.getAttribute('color').count).toBe(8)
    expect(built.mesh.geometry.getAttribute('normal')).toBeUndefined()
    // The triangles are in the file's order: a triangle's number means the same everywhere.
    expect([...built.mesh.geometry.index!.array.slice(0, 6)]).toEqual([0, 1, 3, 0, 3, 2])
    expect(built.mesh.geometry.boundsTree).toBeUndefined()
  })

  it('draws a scan without colours lit and flat, and owns its data', () => {
    const blob = meshBin(box())
    const built = buildScan('S2', blob)
    expect(built.own).toBeNull()
    expect(built.mesh.material).toBe(built.plain)
    expect(built.plain).toMatchObject({ flatShading: true, side: THREE.DoubleSide, polygonOffset: true })
    new Float32Array(blob, 64, 3).fill(999)
    expect(built.mesh.geometry.getAttribute('position').getX(0)).toBe(-20)
  })

  it('stands where its transform says, scaled when a fit scaled it', () => {
    const built = buildScan('S1', meshBin(box()))
    placeScan(built, { t: [10, 20, 30], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], s: 2 })
    built.group.updateMatrixWorld(true)
    // (1, 0, 0) turned a quarter about Z, doubled, moved.
    expect(new THREE.Vector3(1, 0, 0).applyMatrix4(built.group.matrixWorld).toArray().map((c) => Math.round(c * 1e6) / 1e6)).toEqual([10, 22, 30])
  })
})
```

`app/src/renderer/viewport/scans.test.ts`:

```ts
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ScanInfo } from '../../shared/scans'
import { box, meshBin } from '../../test/scanFixtures'
import { ScanLayer } from './scans'

const scan = (id: string, more: Partial<ScanInfo> = {}): ScanInfo =>
  ({ id, name: `${id}.stl`, source: { path: `/d/${id}.stl`, bytes: 1, mtimeMs: 1, sha256: '' }, imported: { unit: 'mm', up: 'z', assumed: { unit: true, up: true }, vertices: 8, triangles: 12, colours: 'none', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, area: 3100, at: '' }, alignments: {}, sourceState: 'present', meshState: 'ok', checks: {}, ...more }) as ScanInfo
const aligned = (t: [number, number, number]) => ({ print: { transform: { t, q: [0, 0, 0, 1] as [number, number, number, number], s: 1 }, steps: ['typed' as const], frame: {}, at: '' } })

describe('ScanLayer', () => {
  it('asks for the meshes it has not got, and draws each where its layout puts it', () => {
    let drawn = 0
    const layer = new ScanLayer(() => (drawn += 1))
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]) }), scan('S2'), scan('S3', { meshState: 'missing' })], 'print')
    expect(layer.wanting()).toEqual(['S1', 'S2'])
    layer.load('S1', meshBin(box()))
    layer.load('S2', meshBin(box()))
    expect(layer.wanting()).toEqual([])
    expect(layer.state().map(({ id, loaded, aligned, transform }) => [id, loaded, aligned, transform.t])).toEqual([['S1', true, true, [100, 0, 0]], ['S2', true, false, [0, 0, 0]], ['S3', false, false, [0, 0, 0]]])
    expect(layer.box()!.max.toArray()).toEqual([120, 15, 2.5])
    // In another layout it is aligned in neither.
    layer.set([scan('S1', { alignments: aligned([100, 0, 0]) }), scan('S2')], 'assembly')
    expect(layer.state().map((s) => s.aligned)).toEqual([false, false])
    expect(drawn).toBeGreaterThan(0)
  })

  it('switches a scan off, thins it, and lets a picture choose', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1'), scan('S2')], 'print')
    layer.load('S1', meshBin(box()))
    layer.load('S2', meshBin(box()))
    layer.setView('S2', { visible: false })
    layer.setView('S1', { opacity: 0.6 })
    expect(layer.shown()).toEqual([{ id: 'S1', visible: true, opacity: 0.6 }, { id: 'S2', visible: false, opacity: 1 }])
    const mesh = layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    expect(mesh.material).toMatchObject({ transparent: true, opacity: 0.6, depthWrite: false })
    const back = layer.showOnly(['S2'])
    expect(layer.group.children.map((g) => g.visible)).toEqual([false, true])
    back()
    expect(layer.group.children.map((g) => g.visible)).toEqual([true, false])
    expect(() => layer.showOnly(['S9'])).toThrow('no scan S9; scans: S1, S2')
    layer.showOnly(null)()
  })

  it('is clipped by the section and never capped, and lets go of a scan that is removed', () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box(), new Array(32).fill(255)))
    const planes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)]
    layer.setClipping(planes)
    const mesh = layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    expect(mesh.material.clippingPlanes).toBe(planes)
    layer.setView('S1', { colour: 'plain' })
    expect((layer.group.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.clippingPlanes).toBe(planes)
    layer.set([], 'print')
    expect(layer.group.children).toHaveLength(0)
    expect(layer.box()).toBeNull()
  })
})
```

`app/src/renderer/ui/scanDrop.test.ts`:

```ts
import { expect, it } from 'vitest'
import { droppedScan } from './scanDrop'

it('takes the first dropped file that is a scan, whatever the case of its ending', () => {
  expect(droppedScan([{ name: 'notes.txt' }, { name: 'Micra.GLB' }, { name: 'b.stl' }])).toBe(1)
  expect(droppedScan([{ name: 'part.3mf' }, { name: 'stl' }])).toBe(-1)
  expect(droppedScan([])).toBe(-1)
})
```

Add to `store.test.ts` (in its style, with its `open` helper): scans of another object are not kept; `setScanView('S1', { opacity: 0.6 })` merges, counts as an edit and reaches `sceneFileOf(...).scans`; `openObject(id, { layers: {}, scans: { S1: { visible: false } } })` restores them; `setImporting` of another object is dropped. Add to `main/scenefile.test.ts`: `{ scans: { S1: { visible: false, opacity: 7, colour: 'own' }, lid: { visible: false }, S2: { colour: 'rainbow' } } }` loads as `{ scans: { S1: { visible: false, opacity: 1, colour: 'own' } } }`. Add to `picture.test.ts`: `asPictured` calls `scans.showOnly` with what the state says and puts it back when `draw` throws.

Run: `pnpm -C app exec vitest run src/renderer/viewport/scanMesh.test.ts src/renderer/viewport/scans.test.ts src/renderer/ui/scanDrop.test.ts` Expected: FAIL (modules missing).

- [ ] **Step 2: Implement `scanMesh.ts`, `scans.ts`, `scanDrop.ts`, the store and scene file changes.** `linearColours` uses a 256-entry table built once: `c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4`, times 65535, rounded.

Run the same command plus `src/renderer/state/store.test.ts src/main/scenefile.test.ts src/renderer/viewport/picture.test.ts`. Expected: PASS.

- [ ] **Step 3: Write the failing e2e**

`app/e2e/scan.spec.ts` (the head, `copyFixtures`, `launch`, `open` and `state` are as in `e2e/section.spec.ts`; only what differs is shown):

```ts
import { box, grid, stl } from '../src/test/scanFixtures'
import type { ScanLayerState } from '../src/renderer/viewport/scans'

// A scan made here: a plate 60 × 50 × 2 under the bracket's base, so that every view of the parts has it in frame.
const PLATE = stl(box([60, 50, 2], [0, 0, -10]))
let scanFile: string

const scans = (p: Page = page): Promise<ScanLayerState[]> => p.evaluate(() => window.__tornoTest!.scans())
const row = (id: string, p: Page = page) => p.locator(`.scan-row[data-scan="${id}"]`)
const pickFile = (path: string | null) => app.evaluate((_electron, path) => void ((globalThis as any).__tornoMain.pickFile = path), path)
const picture = (request: LookRequest, p: Page = page) =>
  p.evaluate(async (request) => {
    const made = await window.__tornoTest!.look(request)
    return { caption: made.caption, sum: made.png.reduce((a, b) => (a * 31 + b) % 1_000_000_007, 7) }
  }, request)
const scansFile = () => JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scans.json'), 'utf8'))

test.beforeAll(async () => {
  root = copyFixtures()
  scanFile = join(root, 'plate under.stl')   // outside every object folder, with a space in its name
  writeFileSync(scanFile, PLATE)
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
})

test('a scan is imported from the panel, drawn, and said in millimetres', async () => {
  await expect(page.getByRole('region', { name: 'Scans' })).toContainText('Drop a scan on the view, or import one.')
  await pickFile(scanFile)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect(row('S1')).toContainText('plate under.stl')
  await expect(row('S1')).toContainText('60 × 50 × 2 mm, from mm, Z up (assumed)')
  await expect(row('S1').locator('.chip[data-state="unaligned"]')).toHaveText('not aligned here')
  await expect.poll(async () => (await scans())[0]).toMatchObject({ id: 'S1', loaded: true, triangles: 12, aligned: false, visible: true, opacity: 1 })
  expect((await state()).scans[0]).toMatchObject({ id: 'S1', sourceState: 'present', meshState: 'ok', source: { path: scanFile } })
  expect(scansFile()).toMatchObject({ next: 2, scans: [{ id: 'S1', source: { path: scanFile, bytes: PLATE.length } }] })
  expect(readFileSync(scanFile).equals(PLATE)).toBe(true)
  // Only .torno was written in the object's folder.
  expect(existsSync(join(root, 'bracket', '.torno', 'scans', 'S1', 'mesh.bin'))).toBe(true)
  expect(await app.evaluate(() => (globalThis as any).__tornoMain.filePicks)).toBe(1)
})

test('a picture has the scan unless it is asked without, and says which', async () => {
  const withScan = await picture({ view: 'iso', size: 256 })
  const without = await picture({ view: 'iso', size: 256, scans: false })
  expect(withScan.caption).toContain(' · scans S1 · ')
  expect(without.caption).not.toContain('scans')
  expect(withScan.sum).not.toBe(without.sum)
  await expect(picture({ view: 'iso', size: 256, scans: ['S9'] })).rejects.toThrow('no scan S9; scans: S1')
})

test('opacity and the eye are kept in scene.json as the person set them, and are there again after a restart', async () => {
  await row('S1').getByRole('slider', { name: 'Opacity of S1' }).fill('0.6')
  await expect.poll(async () => (await scans())[0].opacity).toBe(0.6)
  expect((await picture({ view: 'iso', size: 256 })).caption).toContain('scans S1 at 60 %')
  await row('S1').getByRole('button', { name: 'Show S1' }).click()
  await expect.poll(async () => (await scans())[0].visible).toBe(false)
  expect((await picture({ view: 'iso', size: 256 })).caption).not.toContain('scans')
  await expect.poll(() => JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scene.json'), 'utf8')).scans).toEqual({ S1: { visible: false, opacity: 0.6 } })
  await app.close()
  app = await launch({ TORNO_WORKSPACE: root })
  page = await app.firstWindow()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
  await expect.poll(async () => (await scans())[0]).toMatchObject({ id: 'S1', loaded: true, visible: false, opacity: 0.6 })
  await row('S1').getByRole('button', { name: 'Show S1' }).click()
})

test('the section cuts a scan open, and what the view tells main names it', async () => {
  const whole = await picture({ view: 'front', size: 256, section: null })
  const cut = await picture({ view: 'front', size: 256, section: { origin: [0, 0, 0], normal: [0, -1, 0] } })
  expect(cut.sum).not.toBe(whole.sum)
  const view = await app.evaluate(() => (globalThis as any).__tornoMain.latestView('bracket'))
  expect(view.scans).toEqual([{ id: 'S1', visible: true, opacity: 0.6 }])
})

test('a unit that was assumed wrongly is changed on the row, without the source', async () => {
  rmSync(scanFile)
  await page.reload()
  await page.waitForSelector('[data-region="left"]')
  await open('bracket')
  await expect(row('S1').locator('.chip[data-state="source-missing"]')).toHaveText('source missing')
  await row('S1').getByText('More').click()
  await row('S1').getByRole('combobox', { name: 'Unit of S1' }).selectOption('cm')
  await row('S1').getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1')).toContainText('600 × 500 × 20 mm, from cm, Z up')
  // Both were chosen by pressing Apply: neither is assumed any more.
  await expect.poll(async () => (await state()).scans[0].imported.assumed).toEqual({ unit: false, up: false })
  await expect(row('S1')).not.toContainText('assumed')
})

test('a file that is no scan is said to be none, and a scan is removed with its folder only', async () => {
  const other = join(root, 'part.3mf')
  writeFileSync(other, '')
  await pickFile(other)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect(page.getByRole('region', { name: 'Scans' })).toContainText('part.3mf is not a scan torno reads: .glb, .gltf, .obj, .ply or .stl')
  await row('S1').getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
  await expect(row('S1')).toHaveCount(0)
  expect(existsSync(join(root, 'bracket', '.torno', 'scans', 'S1'))).toBe(false)
  expect(scansFile()).toMatchObject({ next: 2, scans: [] })
  expect(existsSync(other)).toBe(true)
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/scan.spec.ts` Expected: FAIL at the first test (no Scans region).

- [ ] **Step 4: Implement the viewport wiring, the pictures, `ScansPanel`, the drop and the hooks.** Then the same command. Expected: PASS, 6 tests.

- [ ] **Step 5: Design pass** with `frontend-design:frontend-design`: pictures by `window.__tornoTest.look` only (never `page.screenshot()`), of `bracket` with the plate at 100 % and at 50 %, in light and dark (`page.emulateMedia({ colorScheme: 'dark' })`), plain and with a vertex-coloured PLY made by the spec; and the panel's markup read back with `page.locator('.scans').innerHTML()`. Refine until the scan reads as surroundings and the part is still the loudest thing: the scan never brighter or more saturated than a part, its rows in the same family as the layer rows, numbers in the monospace face, sentence case.

- [ ] **Step 6: All suites, then commit**

Run: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`, `pnpm -C app typecheck`. Expected: all pass; the counts of Milestone 3 plus the new tests.

```bash
git add app/src app/e2e/scan.spec.ts
git commit -m "Renderer: a scan is drawn with the parts, switched and thinned from its row, cut open by the section and named in pictures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Pointing at a scan, and the maths of alignment

Two things with no UI of their own, which Task 5 joins: what a pointer is on when it is on a scan, and the pure functions that turn picked points into a transform.

**Files:**
- Create: `app/src/renderer/viewport/scanBvh.ts`, `app/src/renderer/viewport/scanBvh.worker.ts`, `app/src/shared/align.ts`, `app/src/shared/align.test.ts`
- Modify: `app/src/renderer/viewport/scans.ts`, `scans.test.ts`, `app/src/renderer/viewport/Viewport.ts`, `app/src/renderer/tools/Tool.ts` (`ToolViewport` gains `pickScan`), `app/src/renderer/ui/ViewportPane.tsx` (hooks), `app/e2e/scan.spec.ts`

**Interfaces:**
- Consumes: `BuiltScan`, `ScanLayer` (Task 3); `ScanTransform`, `ScanUnit`, `UNIT_MM` (`shared/scans.ts`).
- Produces:

```ts
// viewport/scanBvh.ts
/**
 * A bounds tree for a scan's geometry: indirect, so the triangles keep the file's order. Built in a worker
 * where one can be made (it is given copies of the positions and the triangles, so the scan is drawn
 * meanwhile), in place where none can (vitest). `how` says which.
 */
export function buildScanBvh(geometry: THREE.BufferGeometry, makeWorker?: (() => Worker) | null): Promise<{ tree: MeshBVH; how: 'worker' | 'main' }>

// viewport/scans.ts
/** What a pointer is on, of a scan. `point` and `normal` are in the object frame of the layout shown; `local` is the same point in the scan's own frame. The normal looks towards the eye. */
export interface ScanHit { scan: string; triangle: number; point: Vec3; local: Vec3; normal: Vec3; distance: number }
class ScanLayer {
  /** Resolves once the scan's tree is there, or it has been let go of. */
  whenReady(id: string): Promise<void>
  /** The first thing a ray meets of the scans drawn whose trees are there. With a section, the first the plane keeps. */
  pick(ray: THREE.Ray, keeps: THREE.Plane | null): ScanHit | null
  /** A scan's tree and how it was made; null until it is there. */
  tree(id: string): { tree: MeshBVH; how: 'worker' | 'main'; built: BuiltScan } | null
}

// Viewport
pickScan(clientX: number, clientY: number): ScanHit | null

// shared/align.ts  (pure: plain arrays in, plain arrays out; no three.js)
export function rotate(q: Quat, v: Vec3): Vec3
export function apply(t: ScanTransform, p: Vec3): Vec3
export function compose(after: ScanTransform, first: ScanTransform): ScanTransform   // apply(compose(a, f), p) equals apply(a, apply(f, p))
export function inverse(t: ScanTransform): ScanTransform
/** Sixteen numbers, column by column, as `THREE.Matrix4.fromArray` takes them. */
export function matrixOf(t: ScanTransform): number[]
/** The eigenvalues and the eigenvectors (as columns) of a symmetric matrix, by Jacobi rotations. */
export function eigenSymmetric(a: number[][]): { values: number[]; vectors: number[][] }
/** The plane nearest a set of points, least squares: through their (weighted) centroid, with how far they lie from it (rms, mm). Null for fewer than three or for points in a line. */
export function fitPlane(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number } | null
/** `fitPlane`, then up to three times: the points further than 4.5 times the median distance from the plane are left out, of all of them each time, and it is fitted again. `used` is how many it ends with. */
export function fitPlaneTrimmed(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number; used: number } | null
/**
 * The rigid move, in the object frame, that lays a plane of the scan as it now stands onto `onto`
 * (default: z = 0, facing up): the shortest turn about the plane's own point, then the shift along
 * `onto`'s normal. Where the scan is within that plane, and how it is turned about the normal, are
 * left as they are. `facing` is a direction the seen side of the plane looks towards (the eye).
 */
export function toFloor(plane: { origin: Vec3; normal: Vec3 }, facing: Vec3, onto?: { origin: Vec3; normal: Vec3 }): ScanTransform
export interface PairFit { transform: ScanTransform; residuals: number[]; rms: number; /** What the scale would be were it free. */ freeScale: number }
/** The least-squares move (Umeyama) taking `scan[i]` to `model[i]`: rigid, or with one scale for all when `scale` is set. An error in words for fewer than three pairs or points in a line. */
export function fitPairs(scan: Vec3[], model: Vec3[], opts?: { scale?: boolean }): PairFit | { error: string }
/** When a fit's free scale is within 3 % of the ratio of two units: the unit the scan looks to be in, and that ratio. Null otherwise. */
export function unitHint(freeScale: number, importedAs: ScanUnit): { unit: ScanUnit; factor: number } | null
/** A transform after it was turned by `turn` about `pivot` and then moved by `move`, all in the object frame. */
export function nudged(from: ScanTransform, pivot: Vec3, move: Vec3, turn: Quat): ScanTransform
```

- [ ] **Step 1: Write the failing tests of the maths**

`app/src/shared/align.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Quat, Vec3 } from './marks'
import type { ScanTransform } from './scans'
import { apply, compose, eigenSymmetric, fitPairs, fitPlane, fitPlaneTrimmed, inverse, matrixOf, nudged, rotate, toFloor, unitHint } from './align'

const near = (a: number[], b: number[], within = 1e-9): void => a.forEach((c, i) => expect(Math.abs(c - b[i])).toBeLessThan(within))
/** A turn of `degrees` about an axis. */
const turn = (axis: Vec3, degrees: number): Quat => {
  const half = (degrees * Math.PI) / 360
  const length = Math.hypot(...axis)
  return [(axis[0] / length) * Math.sin(half), (axis[1] / length) * Math.sin(half), (axis[2] / length) * Math.sin(half), Math.cos(half)]
}
const T: ScanTransform = { q: turn([1, 2, 3], 40), t: [100, -50, 20], s: 1 }
const POINTS: Vec3[] = [[0, 0, 0], [300, 10, 5], [20, 250, -30], [150, 150, 90], [-80, 40, 10]]

describe('transforms', () => {
  it('turn, scale, then move', () => {
    near(rotate(turn([0, 0, 1], 90), [1, 0, 0]), [0, 1, 0])
    near(apply({ q: turn([0, 0, 1], 90), t: [10, 20, 30], s: 2 }, [1, 0, 0]), [10, 22, 30])
  })

  it('compose, invert and say themselves as a matrix', () => {
    const other: ScanTransform = { q: turn([0, 1, 0], -70), t: [5, 6, 7], s: 1.02 }
    for (const p of POINTS) {
      near(apply(compose(other, T), p), apply(other, apply(T, p)))
      near(apply(inverse(other), apply(other, p)), p)
    }
    const m = matrixOf({ q: turn([0, 0, 1], 90), t: [10, 20, 30], s: 2 })
    // Column by column: the first column is where +X goes.
    near(m, [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1])
  })

  it('are nudged about a pivot, which stays where it is when only turned', () => {
    const pivot: Vec3 = [50, 60, 70]
    const local = apply(inverse(T), pivot)
    near(apply(nudged(T, pivot, [0, 0, 0], turn([0, 0, 1], 33)), local), pivot)
    near(apply(nudged(T, pivot, [1, 2, 3], [0, 0, 0, 1]), local), [51, 62, 73])
  })
})

describe('eigenSymmetric', () => {
  it('finds the axes of a symmetric matrix', () => {
    const { values, vectors } = eigenSymmetric([[2, 1, 0], [1, 2, 0], [0, 0, 5]])
    near([...values].sort((a, b) => a - b), [1, 3, 5])
    const at = values.findIndex((v) => Math.abs(v - 1) < 1e-9)
    near([Math.abs(vectors[0][at]), Math.abs(vectors[1][at]), Math.abs(vectors[2][at])], [Math.SQRT1_2, Math.SQRT1_2, 0])
  })
})

describe('fitPlane', () => {
  const tilted = (x: number, y: number): Vec3 => [x, y, 0.1 * x - 0.2 * y + 7]

  it('fits the plane points lie in, and says how far off they are', () => {
    const fit = fitPlane([tilted(0, 0), tilted(10, 0), tilted(0, 10), tilted(10, 10), tilted(5, 3)])!
    const n = [-0.1, 0.2, 1].map((c) => c / Math.hypot(0.1, 0.2, 1))
    near(fit.normal.map((c) => c * Math.sign(fit.normal[2])), n)
    expect(fit.rms).toBeLessThan(1e-6)
    // The centroid is a point of it.
    near([0.1 * fit.origin[0] - 0.2 * fit.origin[1] + 7], [fit.origin[2]])
    const rough = fitPlane([[0, 0, 1], [10, 0, -1], [0, 10, -1], [10, 10, 1]])!
    expect(rough.rms).toBeCloseTo(1, 9)
  })

  it('weighs points, and refuses what is no plane', () => {
    const heavy = fitPlane([[0, 0, 0], [10, 0, 0], [0, 10, 0], [5, 5, 9]], [1, 1, 1, 1e-9])!
    expect(heavy.rms).toBeLessThan(1e-3)
    expect(fitPlane([[0, 0, 0], [1, 1, 1]])).toBeNull()
    expect(fitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])).toBeNull()
    expect(fitPlane([[4, 4, 4], [4, 4, 4], [4, 4, 4]])).toBeNull()
  })

  it('leaves out what stands off the plane (a cable on the floor)', () => {
    const floor: Vec3[] = []
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) floor.push([x, y, 0.01 * ((x * 7 + y * 3) % 5) - 0.02])
    const cable: Vec3[] = [[2, 2, 6], [3, 2, 6], [4, 2, 7], [5, 2, 6]]
    const fit = fitPlaneTrimmed([...floor, ...cable])!
    expect(fit.used).toBe(100)
    expect(fit.rms).toBeLessThan(0.02)
    expect(Math.abs(fit.normal[2])).toBeGreaterThan(0.99999)
  })
})

describe('toFloor', () => {
  it('lays a tilted patch flat on z = 0, turning it about itself by the shortest way', () => {
    const plane = { origin: [100, 50, 30] as Vec3, normal: rotate(turn([1, 0, 0], 5), [0, 0, 1]) }
    const laid = toFloor(plane, [0, 0, 1])
    near(rotate(laid.q, plane.normal), [0, 0, 1])
    // The patch's own point goes straight down: it is not slid in the plane.
    near(apply(laid, plane.origin), [100, 50, 0])
    expect(laid.s).toBe(1)
    // Seen from below, the same patch is laid the other way up.
    near(rotate(toFloor(plane, [0, 0, -1]).q, plane.normal), [0, 0, -1])
  })

  it('lays it on a face of the model, facing as the face does', () => {
    const face = { origin: [0, 0, 2.5] as Vec3, normal: [0, 0, 1] as Vec3 }
    const laid = toFloor({ origin: [7, 8, 40], normal: [0, 1, 0] }, [0, 1, 0], face)
    near(rotate(laid.q, [0, 1, 0]), [0, 0, 1])
    near(apply(laid, [7, 8, 40]), [7, 8, 2.5])
    // A patch that already lies on it is left where it is.
    const same = toFloor(face, [0, 0, 1], face)
    near([...same.q, ...same.t], [0, 0, 0, 1, 0, 0, 0])
  })
})

describe('fitPairs', () => {
  const model = POINTS.map((p) => apply(T, p))

  it('recovers a rigid move from three pairs and from five', () => {
    for (const count of [3, 5]) {
      const fit = fitPairs(POINTS.slice(0, count), model.slice(0, count))
      if ('error' in fit) throw new Error(fit.error)
      near([...fit.transform.q].map((c) => c * Math.sign(fit.transform.q[3])), T.q)
      near(fit.transform.t, T.t, 1e-7)
      expect(fit.transform.s).toBe(1)
      expect(fit.rms).toBeLessThan(1e-9)
      expect(fit.freeScale).toBeCloseTo(1, 9)
    }
  })

  it('never answers with a mirror image', () => {
    const mirrored = POINTS.map(([x, y, z]) => [x, y, -z] as Vec3)
    const fit = fitPairs(POINTS, mirrored)
    if ('error' in fit) throw new Error(fit.error)
    // A rotation cannot do it: the pairs are left with residuals, and the turn is a proper one.
    expect(fit.rms).toBeGreaterThan(1)
    const [x, y, z] = [rotate(fit.transform.q, [1, 0, 0]), rotate(fit.transform.q, [0, 1, 0]), rotate(fit.transform.q, [0, 0, 1])]
    near([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], z)
  })

  it('keeps the size unless told to fit it, and says what the size would be', () => {
    const larger = POINTS.map((p) => apply({ ...T, s: 1.02 }, p))
    const rigid = fitPairs(POINTS, larger)
    if ('error' in rigid) throw new Error(rigid.error)
    expect(rigid.transform.s).toBe(1)
    expect(rigid.freeScale).toBeCloseTo(1.02, 9)
    expect(rigid.rms).toBeGreaterThan(0.5)
    expect(rigid.residuals).toHaveLength(5)
    const scaled = fitPairs(POINTS, larger, { scale: true })
    if ('error' in scaled) throw new Error(scaled.error)
    expect(scaled.transform.s).toBeCloseTo(1.02, 9)
    expect(scaled.rms).toBeLessThan(1e-9)
  })

  it('names the pair that is off', () => {
    const bad = model.map((p, i) => (i === 3 ? ([p[0] + 9, p[1], p[2]] as Vec3) : p))
    const fit = fitPairs(POINTS, bad)
    if ('error' in fit) throw new Error(fit.error)
    expect(fit.residuals.indexOf(Math.max(...fit.residuals))).toBe(3)
  })

  it('holds for the frame the owner worked out by hand for the Micra scan', () => {
    // micra-intake/docs/2026-10-06-micra-intake-design.md: glTF coordinates in mm, less the origin, dotted with each axis (four digits).
    const origin: Vec3 = [107.4, 689.9, 28.8]
    const axes: Vec3[] = [[0.9944, -0.0064, 0.1055], [0.1045, -0.0898, -0.9905], [0.0158, 0.9959, -0.0887]]
    const tray = (p: Vec3): Vec3 => axes.map((axis) => axis.reduce((sum, c, i) => sum + c * (p[i] - origin[i]), 0)) as Vec3
    const fit = fitPairs(POINTS, POINTS.map(tray))
    if ('error' in fit) throw new Error(fit.error)
    // Its axes are orthonormal to four digits: a rigid fit agrees with it to a fifth of a millimetre over 300 mm.
    expect(fit.rms).toBeLessThan(0.2)
    expect(Math.abs(fit.freeScale - 1)).toBeLessThan(1e-3)
    near(apply(fit.transform, origin), [0, 0, 0], 0.2)
  })

  it('refuses too few pairs, and points in a line', () => {
    expect(fitPairs(POINTS.slice(0, 2), model.slice(0, 2))).toEqual({ error: 'an alignment needs at least three pairs of points' })
    const line: Vec3[] = [[0, 0, 0], [10, 0, 0], [20, 0, 0], [35, 0, 0]]
    expect(fitPairs(line, model.slice(0, 4))).toEqual({ error: 'the scan points are in a line: an alignment needs three that are not' })
    expect(fitPairs(POINTS.slice(0, 4), line)).toEqual({ error: 'the model points are in a line: an alignment needs three that are not' })
  })
})

describe('unitHint', () => {
  it('says when the size a fit wants is a unit', () => {
    expect(unitHint(1000.4, 'mm')).toEqual({ unit: 'm', factor: 1000 })
    expect(unitHint(25.1, 'mm')).toEqual({ unit: 'in', factor: 25.4 })
    expect(unitHint(0.0101, 'm')).toEqual({ unit: 'cm', factor: 0.01 })
    expect(unitHint(1.02, 'mm')).toBeNull()
    expect(unitHint(3, 'mm')).toBeNull()
  })
})
```

Run: `pnpm -C app exec vitest run src/shared/align.test.ts` Expected: FAIL, cannot find `./align`.

- [ ] **Step 2: Implement `shared/align.ts`**

```ts
import type { Quat, Vec3 } from './marks'
import { type ScanTransform, type ScanUnit, UNIT_MM } from './scans'

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const times = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => times(a, 1 / (Math.hypot(...a) || 1))
const unitQuat = (q: Quat): Quat => {
  const length = Math.hypot(...q)
  return length > 0 ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [0, 0, 0, 1]
}
/** The turn `a` after the turn `b`. */
const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]

export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]]
  const first = cross(u, v)
  return add(v, add(times(first, 2 * q[3]), times(cross(u, first), 2)))
}

export function apply(t: ScanTransform, p: Vec3): Vec3 {
  return add(times(rotate(t.q, p), t.s), t.t)
}

export function compose(after: ScanTransform, first: ScanTransform): ScanTransform {
  return { q: unitQuat(multiply(after.q, first.q)), s: after.s * first.s, t: apply(after, first.t) }
}

export function inverse(t: ScanTransform): ScanTransform {
  const back: Quat = [-t.q[0], -t.q[1], -t.q[2], t.q[3]]
  return { q: back, s: 1 / t.s, t: times(rotate(back, t.t), -1 / t.s) }
}

export function matrixOf(t: ScanTransform): number[] {
  const [x, y, z] = [rotate(t.q, [1, 0, 0]), rotate(t.q, [0, 1, 0]), rotate(t.q, [0, 0, 1])].map((axis) => times(axis, t.s))
  return [...x, 0, ...y, 0, ...z, 0, ...t.t, 1]
}

export function nudged(from: ScanTransform, pivot: Vec3, move: Vec3, turn: Quat): ScanTransform {
  const q = unitQuat(turn)
  return compose({ q, s: 1, t: add(sub(pivot, rotate(q, pivot)), move) }, from)
}

export function eigenSymmetric(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length
  const m = a.map((row) => [...row])
  const v = m.map((_, i) => m.map((_, j) => (i === j ? 1 : 0)))
  const whole = m.flat().reduce((sum, c) => sum + c * c, 0)
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j]
    if (off <= 1e-30 * whole) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (m[p][q] === 0) continue
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q])
        const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (const of of [m, v]) {
          // Columns p and q, of the matrix and of the vectors.
          for (let k = 0; k < n; k++) {
            const [kp, kq] = [of[k][p], of[k][q]]
            of[k][p] = c * kp - s * kq
            of[k][q] = s * kp + c * kq
          }
        }
        // Rows p and q of the matrix.
        for (let k = 0; k < n; k++) {
          const [pk, qk] = [m[p][k], m[q][k]]
          m[p][k] = c * pk - s * qk
          m[q][k] = s * pk + c * qk
        }
      }
    }
  }
  return { values: m.map((row, i) => row[i]), vectors: v }
}

/** The centroid of some points and the axes they spread along, least first, with how much. */
function spread(points: Vec3[], weights?: number[]): { centre: Vec3; values: number[]; axes: Vec3[] } | null {
  const w = (i: number): number => weights?.[i] ?? 1
  const total = points.reduce((sum, _, i) => sum + w(i), 0)
  if (!(total > 0)) return null
  const centre = times(points.reduce<Vec3>((sum, p, i) => add(sum, times(p, w(i))), [0, 0, 0]), 1 / total)
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  points.forEach((p, i) => {
    const d = sub(p, centre)
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c[r][k] += (w(i) * d[r] * d[k]) / total
  })
  const { values, vectors } = eigenSymmetric(c)
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j])
  return { centre, values: order.map((i) => Math.max(values[i], 0)), axes: order.map((i) => [vectors[0][i], vectors[1][i], vectors[2][i]] as Vec3) }
}

/** Whether points lie in a line, or in one place: they spread along one axis at most. */
const inALine = (values: number[]): boolean => values[1] <= 1e-6 * values[2] || values[2] <= 1e-18

export function fitPlane(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number } | null {
  if (points.length < 3) return null
  const found = spread(points, weights)
  if (!found || inALine(found.values)) return null
  return { origin: found.centre, normal: unit(found.axes[0]), rms: Math.sqrt(found.values[0]) }
}

/** A point further from the plane than this many times the median distance is left out: about three standard deviations of points that scatter evenly. */
const TRIM = 4.5

export function fitPlaneTrimmed(points: Vec3[], weights?: number[]): { origin: Vec3; normal: Vec3; rms: number; used: number } | null {
  let kept = points.map((_, i) => i)
  let fit = fitPlane(points, weights)
  for (let pass = 0; fit && pass < 3; pass++) {
    const plane = fit
    // Of every point, each time: one left out while the plane was tilted by what stands off it may belong after all.
    const off = points.map((p) => Math.abs(dot(sub(p, plane.origin), plane.normal)))
    const median = [...off].sort((a, b) => a - b)[Math.floor(off.length / 2)]
    const within = points.map((_, i) => i).filter((i) => off[i] <= TRIM * Math.max(median, 1e-9))
    if (within.length < 3 || (within.length === kept.length && within.every((i, n) => i === kept[n]))) break
    kept = within
    fit = fitPlane(kept.map((i) => points[i]), weights && kept.map((i) => weights[i]))
  }
  return fit && { ...fit, used: kept.length }
}

/** The shortest turn that takes one direction to another; a half turn about any axis across them when they are opposed. */
function between(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to)
  if (d < -1 + 1e-12) {
    const across = unit(Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]))
    return [across[0], across[1], across[2], 0]
  }
  const axis = cross(from, to)
  return unitQuat([axis[0], axis[1], axis[2], 1 + d])
}

export function toFloor(plane: { origin: Vec3; normal: Vec3 }, facing: Vec3, onto: { origin: Vec3; normal: Vec3 } = { origin: [0, 0, 0], normal: [0, 0, 1] }): ScanTransform {
  const seen = unit(plane.normal)
  const up = unit(onto.normal)
  const q = between(dot(seen, facing) < 0 ? times(seen, -1) : seen, up)
  // About the patch's own point, which then goes along the target's normal onto the target.
  const turned = sub(plane.origin, rotate(q, plane.origin))
  return { q, s: 1, t: add(turned, times(up, dot(sub(onto.origin, plane.origin), up))) }
}

export interface PairFit { transform: ScanTransform; residuals: number[]; rms: number; freeScale: number }

export function fitPairs(scan: Vec3[], model: Vec3[], opts: { scale?: boolean } = {}): PairFit | { error: string } {
  if (scan.length !== model.length || scan.length < 3) return { error: 'an alignment needs at least three pairs of points' }
  const [from, to] = [spread(scan), spread(model)]
  if (!from || inALine(from.values)) return { error: 'the scan points are in a line: an alignment needs three that are not' }
  if (!to || inALine(to.values)) return { error: 'the model points are in a line: an alignment needs three that are not' }
  const a = scan.map((p) => sub(p, from.centre))
  const b = model.map((p) => sub(p, to.centre))
  // Horn's closed form: the turn is the eigenvector of the largest eigenvalue of this matrix, as (w, x, y, z).
  const S = [0, 1, 2].map((r) => [0, 1, 2].map((k) => a.reduce((sum, p, i) => sum + p[r] * b[i][k], 0)))
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const { values, vectors } = eigenSymmetric([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz]
  ])
  const top = values.indexOf(Math.max(...values))
  const q = unitQuat([vectors[1][top], vectors[2][top], vectors[3][top], vectors[0][top]])
  // Umeyama's scale: the one that leaves the least between the turned scan points and the model's.
  const freeScale = a.reduce((sum, p, i) => sum + dot(rotate(q, p), b[i]), 0) / a.reduce((sum, p) => sum + dot(p, p), 0)
  const s = opts.scale ? freeScale : 1
  const transform: ScanTransform = { q, s, t: sub(to.centre, times(rotate(q, from.centre), s)) }
  const residuals = scan.map((p, i) => Math.hypot(...sub(apply(transform, p), model[i])))
  return { transform, residuals, rms: Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length), freeScale }
}

export function unitHint(freeScale: number, importedAs: ScanUnit): { unit: ScanUnit; factor: number } | null {
  for (const unit of ['mm', 'cm', 'm', 'in'] as const) {
    if (unit === importedAs) continue
    const factor = UNIT_MM[unit] / UNIT_MM[importedAs]
    if (Math.abs(freeScale / factor - 1) <= 0.03) return { unit, factor }
  }
  return null
}
```

Run the test. Expected: PASS. If the "mirror image" or the "three pairs" case fails, the sign convention of Horn's matrix is the place to look (it is written for `S[r][k] = Σ a[r] · b[k]`, the scan on the left): do not patch the result with a flip.

- [ ] **Step 3: Write the failing tests of the tree and of picking**

Add to `app/src/renderer/viewport/scans.test.ts`:

```ts
describe('pointing at a scan', () => {
  const down = (x: number, y: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  async function layerWith(alignments = {}): Promise<ScanLayer> {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1', { alignments })], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    await layer.whenReady('S1')
    return layer
  }

  it('cannot be picked until its tree is there, and then says the triangle by its number in the file', async () => {
    const layer = new ScanLayer(() => {})
    layer.set([scan('S1')], 'print')
    layer.load('S1', meshBin(box([40, 30, 5])))
    expect(layer.state()[0].ready).toBe(false)
    expect(layer.pick(down(5, 1), null)).toBeNull()
    await layer.whenReady('S1')
    expect(layer.tree('S1')!.how).toBe('main')
    const hit = layer.pick(down(5, 1), null)!
    // The top of the box is triangles 10 and 11 of the file: (1, 5, 7) and (1, 7, 3).
    expect(hit).toMatchObject({ scan: 'S1', triangle: 10, point: [5, 1, 2.5], local: [5, 1, 2.5], normal: [0, 0, 1], distance: 97.5 })
    expect(layer.pick(down(50, 0), null)).toBeNull()
  })

  it('answers in the object frame where the scan stands, and in its own', async () => {
    const layer = await layerWith(aligned([100, 0, 10]))
    const hit = layer.pick(down(105, 1), null)!
    expect(hit.point).toEqual([105, 1, 12.5])
    expect(hit.local).toEqual([5, 1, 2.5])
  })

  it('sees what the section leaves, not what it takes away, and nothing of a scan that is switched off', async () => {
    const layer = await layerWith()
    // Keeps z <= 0: the top of the box is gone, and the ray meets its underside from inside.
    const keeps = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    const hit = layer.pick(down(5, 1), keeps)!
    expect(hit.point).toEqual([5, 1, -2.5])
    // Seen from above through the open top: the normal told looks at the eye.
    expect(hit.normal).toEqual([0, 0, 1])
    layer.setView('S1', { visible: false })
    expect(layer.pick(down(5, 1), null)).toBeNull()
  })
})
```

Run: `pnpm -C app exec vitest run src/renderer/viewport/scans.test.ts` Expected: FAIL (`whenReady` is not a function).

- [ ] **Step 4: Implement `scanBvh.worker.ts`, `scanBvh.ts`, and picking**

`app/src/renderer/viewport/scanBvh.worker.ts`:

```ts
import { BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

// Builds the bounds tree of one scan off the window's thread. It is given copies of the positions
// and the triangles, and sends back the tree's own buffers: the scan is drawn meanwhile.
self.onmessage = ({ data }: MessageEvent<{ position: Float32Array; index: Uint32Array }>) => {
  try {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(data.position, 3))
    geometry.setIndex(new BufferAttribute(data.index, 1))
    const made = MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { copyIndexBuffer: false })
    const send = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }
    send.postMessage({ roots: made.roots, indirectBuffer: made.indirectBuffer }, [...made.roots, made.indirectBuffer!.buffer])
  } catch (e) {
    ;(self as unknown as { postMessage(message: unknown): void }).postMessage({ error: e instanceof Error ? e.message : String(e) })
  }
}
```

`app/src/renderer/viewport/scanBvh.ts`:

```ts
import type * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

const inWorker = (): Worker => new Worker(new URL('./scanBvh.worker.ts', import.meta.url), { type: 'module' })

export function buildScanBvh(
  geometry: THREE.BufferGeometry,
  makeWorker: (() => Worker) | null = typeof Worker === 'undefined' ? null : inWorker
): Promise<{ tree: MeshBVH; how: 'worker' | 'main' }> {
  const here = (): { tree: MeshBVH; how: 'main' } => ({ tree: new MeshBVH(geometry, { indirect: true }), how: 'main' })
  if (!makeWorker) return Promise.resolve().then(here)
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = makeWorker()
    } catch {
      resolve(here())
      return
    }
    const done = (made: { tree: MeshBVH; how: 'worker' | 'main' }): void => {
      worker.terminate()
      resolve(made)
    }
    // A worker that cannot be started, or fails, is no reason for a scan that cannot be pointed at.
    worker.onerror = () => done(here())
    worker.onmessage = ({ data }: MessageEvent<{ roots?: ArrayBuffer[]; indirectBuffer?: Uint32Array; error?: string }>) => {
      if (!data.roots || !data.indirectBuffer) return done(here())
      // The triangles are the geometry's own, untouched: the tree looks them up through its indirect buffer.
      done({ tree: MeshBVH.deserialize({ roots: data.roots, index: null, indirectBuffer: data.indirectBuffer } as never, geometry, { setIndex: false }), how: 'worker' })
    }
    const position = (geometry.getAttribute('position').array as Float32Array).slice()
    const index = (geometry.index!.array as Uint32Array).slice()
    worker.postMessage({ position, index }, [position.buffer, index.buffer])
  })
}
```

`ScanLayer.load` starts `buildScanBvh(built.mesh.geometry)` and, if that scan is still the one it built for, sets `geometry.boundsTree`, `mesh.raycast = acceleratedRaycast`, `ready`, and redraws. `ScanLayer.pick`: for each scan that is drawn and ready, the ray in the scan's own frame (`ray.clone().applyMatrix4(inverse of group.matrixWorld)`, direction normalised again, since a scaled scan stretches it); without a section `tree.raycastFirst(localRay, THREE.DoubleSide)`, with one `tree.raycast(localRay, THREE.DoubleSide)` sorted by distance and the first whose point, brought to the object frame, has `keeps.distanceToPoint(point) >= 0`; the distance told is from `ray.origin` to that object-frame point; the triangle is `hit.faceIndex`; the normal is `hit.face.normal` turned by the group's world matrix and flipped when it looks along the ray; the nearest of all scans wins. Coordinates are rounded to 1e-9 (`+ 0`, never `-0`). `Viewport.pickScan` is `pick`'s twin: `canvasPoint`, `syncMatrices`, the pointer's ray by `pointerRay`, `this.section.keeps()`.

`__tornoTest` gains:

```ts
pickScanAt: (fx: number, fy: number) => ScanHit | null
/** Where a point of a scan, in the scan's own frame, is drawn: fractions of the canvas, as `project`. */
projectScan: (id: string, local: Vec3) => [number, number]
/** What `count` picks of the scans cost, at points spread over the canvas, and how each tree was made. */
timeScanPicks: (count?: number) => { count: number; hits: number; meanMs: number; worstMs: number; how: Record<string, 'worker' | 'main'> }
```

Run the unit tests. Expected: PASS.

- [ ] **Step 5: e2e: a large scan does not stall the window (Review Focus 4)**

Add to `app/e2e/scan.spec.ts`, in a `test.describe('a large scan')` of its own with its own launch and temp copy:

```ts
test('200,000 triangles are drawn at once, and can be pointed at when their tree arrives from the worker', async () => {
  test.setTimeout(120_000)
  // A wavy sheet 316 mm square, 199,712 triangles: 10 MB of STL, written here and nowhere else.
  const wavy = join(root, 'wavy.stl')
  writeFileSync(wavy, stl(grid(317, 1, (x, y) => -20 + 3 * Math.sin(x / 20) * Math.cos(y / 20))))
  await pickFile(wavy)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.loaded, { timeout: 60_000 }).toBe(true)
  // The window answers while the tree is built: a round trip to it takes no longer than it does idle.
  const before = Date.now()
  await page.evaluate(() => window.__tornoTest!.state().objectId)
  expect(Date.now() - before).toBeLessThan(500)
  await expect.poll(async () => (await scans())[0].ready, { timeout: 30_000 }).toBe(true)
  const cost = await page.evaluate(() => window.__tornoTest!.timeScanPicks(200))
  expect(cost.how).toEqual({ S1: 'worker' })
  expect(cost.hits).toBeGreaterThan(20)
  expect(cost.meanMs).toBeLessThan(2)
  // A point of the sheet, found again by pointing at where it is drawn.
  await page.evaluate(() => window.__tornoTest!.state())
  const [fx, fy] = await page.evaluate(() => window.__tornoTest!.projectScan('S1', [10.5, -20.5, -20 + 3 * Math.sin(10.5 / 20) * Math.cos(-20.5 / 20)]))
  const hit = await page.evaluate(([fx, fy]) => window.__tornoTest!.pickScanAt(fx, fy), [fx, fy])
  expect(hit).toMatchObject({ scan: 'S1' })
  expect(Math.hypot(hit!.local[0] - 10.5, hit!.local[1] + 20.5)).toBeLessThan(1.5)
  expect(hit!.triangle).toBeLessThan(199_712)
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/scan.spec.ts` Expected: PASS. If `how` is `main`, the worker did not start in the built app: read the window's console (`page.on('console')`) for the CSP or the chunk's path, and fix that rather than accept the fallback. `worker-src 'self' blob:` is already in `index.html`.

- [ ] **Step 6: Suites, commit**

Run: `pnpm test`, `pnpm test:e2e`, `pnpm -C app typecheck`. Expected: pass.

```bash
git add app/src app/e2e/scan.spec.ts
git commit -m "Renderer: a scan can be pointed at through a tree built off the window's thread, and the fits that align one are worked out in one place

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Aligning a scan: floor, pairs, the gizmo and typed values; and checking that it still holds

**Files:**
- Create: `app/src/renderer/state/align.ts`, `align.test.ts`, `app/src/renderer/tools/alignTool.ts`, `app/src/renderer/tools/align.test.ts`, `app/src/renderer/ui/AlignBar.tsx`, `app/src/main/scans/alignCheck.ts`, `alignCheck.test.ts`, `app/e2e/align.spec.ts`
- Modify: `app/src/renderer/state/tools.ts` (`'align'`, key `L`), `app/src/renderer/ui/ToolPalette.tsx`, `ui/ViewportPane.tsx`, `ui/ScansPanel.tsx` (an "Align" button on a row), `app/src/renderer/viewport/ShapeGizmo.ts`, `ShapeGizmo.test.ts`, `viewport/scans.ts`, `viewport/Viewport.ts`, `tools/Tool.ts`, `app/src/main/scans/store.ts`, `store.test.ts`, `app/src/main/ipc.ts`, `styles/app.css`

**Interfaces:**
- Consumes: `pickScan`, `ScanHit`, `ScanLayer.tree` (Task 4); `fitPlaneTrimmed`, `toFloor`, `fitPairs`, `unitHint`, `compose`, `apply`, `nudged` (`shared/align.ts`); `ScanStore.align`, `.checked` (Task 2); `tolerance` (`main/marks/tolerance.ts`); `AskedAnchor`, `NearestAnchor`, `answered`, `retrying` (`main/marks/reanchor.ts`).
- Produces:

```ts
// state/align.ts  (what the Align tool has in hand: changed by a click, a key or a field, never by a pointer move)
export type AlignMode = 'floor' | 'pairs' | 'nudge'
export interface PairDraft { scan?: Vec3 /* scan frame */; model?: Vec3 /* object frame */; part?: string }
export interface FloorDraft { plane: { origin: Vec3; normal: Vec3; rms: number; used: number }; facing: Vec3 }   // object frame, as the scan stood when it was clicked
export interface AlignState {
  scan: string | null
  mode: AlignMode
  pairs: PairDraft[]
  scale: boolean
  floor: FloorDraft | null
  /** What the floor is laid on: the ground at `height`, or a face of the model. */
  onto: { origin: Vec3; normal: Vec3; part?: string } | null
  height: number
  /** The next click on a part chooses the face to lay the floor on. */
  choosingFace: boolean
}
export const alignStore: StoreApi<AlignState>
/** A point of the scan was clicked: it is the scan end of the first pair that has none, or of a new pair. */
export function withScanEnd(pairs: PairDraft[], local: Vec3): PairDraft[]
/** A point of the model was clicked or typed: the model end of the first pair that has none, or of a new pair. */
export function withModelEnd(pairs: PairDraft[], point: Vec3, part?: string): PairDraft[]
/** What the whole pairs fit to: null with fewer than three. */
export function fitOf(pairs: PairDraft[], scale: boolean): PairFit | { error: string } | null
export function pairsAlignment(pairs: PairDraft[], fit: PairFit): NewAlignment
export function floorAlignment(current: ScanAlignment | null, floor: FloorDraft, onto: AlignState['onto'], height: number): NewAlignment
export function movedAlignment(current: ScanAlignment | null, transform: ScanTransform, step: 'nudge' | 'typed'): NewAlignment
/** What is said of a fit's size: a unit, a per cent, or nothing. */
export function sizeNote(fit: PairFit, unit: ScanUnit): string | null

// viewport/ShapeGizmo.ts
/** What the gizmo holds: a shape mark, or a scan by a point of it. Only a shape has a size. */
export interface GizmoSubject { position: Vec3; rotation: Quat; shape?: ShapeKind; size?: Vec3 }
export interface GizmoHost { subject(id: string): GizmoSubject | null; preview(id: string, change: Partial<ShapeTransform>): void; dragging(on: boolean): void; redraw(): void }

// Viewport / ScanLayer
/** Draws a scan somewhere else for now (a fit not yet applied, a drag); null draws it where main has it. */
previewScan(id: string, transform: ScanTransform | null): void
/** The triangles of a scan within `radius` mm of a hit whose normals are within `degrees` of the hit's: their centroids in the object frame and their areas. Tints them when `tint`. Null clears the tint. */
scanPatch(hit: ScanHit | null, radius: number, opts?: { degrees?: number; tint?: boolean }): { points: Vec3[]; weights: number[] } | null
/** Numbered dots for the ends of the pairs being made, and the floor's patch outline: in `--accent`, in no picture. */
showAlignPoints(points: Array<{ at: Vec3; label: string }>): void
/** The gizmo on a scan, at `pivot`: moving or turning it draws the scan as dragged, and on release says how far it was moved and turned about the pivot. Null takes it away. */
editScan(id: string | null, mode: 'translate' | 'rotate', pivot: Vec3, onChange: (change: { move: Vec3; turn: Quat }) => void): void

// main/scans/alignCheck.ts
/** The model points an alignment was tied to, with the part each was clicked on. */
export function anchoredPoints(alignment: ScanAlignment): Array<{ part: string; point: Vec3 }>
/** What a build makes of one alignment. `nearest` answers `anchoredPoints`, in order. Pure. */
export function judgeAlignment(alignment: ScanAlignment, parts: Part[], nearest: Array<NearestAnchor | undefined>, revision: number): AlignmentCheck
export interface AlignCheckDeps { scans: Pick<ScanStore, 'list' | 'checked'>; scene(objectId: string): { revision: number; scene: Scene } | undefined; nearest(objectId: string, layout: string, anchors: AskedAnchor[]): Promise<NearestAnchor[]> }
/** Checks every alignment of an object's scans against its last build. False when the kernel could not be asked, `'busy'` when it is busy: to be tried again (`retrying`). */
export function checkAlignments(deps: AlignCheckDeps, objectId: string): Promise<boolean | 'busy'>
```

Behaviour:
- **What main says of an alignment.** `ScanStore.align` never keeps a residual or an rms on a caller's word: for an alignment with `pairs`, each `residual` is `|apply(transform, pair.scan) − pair.model|` and `rms` is theirs; `scaled` is `|s − 1| > 1e-9`. `steps` is cut to its last 8. The `scans:align` handler adds `frame` and `at`, then starts `checkAlignments` for the object.
- **Steps.** A pair fit starts over: `steps: ['pairs']`, the transform is the fit's, any floor before it is superseded. A floor, a nudge and typed values are added to what there is (`[...steps, step]`, the same step not twice in a row), composed on the left of the current transform (`compose(move, current)`), and keep the alignment's `pairs` (whose residuals main works out anew).
- **The Align tool** (`L`; `Tool` id `align`, cursor `crosshair`). It works on `alignStore.scan`: the one scan when there is one, else the one whose row's "Align" was pressed; with none it says at the pointer "Import a scan first" and does nothing. It asks `ctx.viewport.pickScan(...)` itself on every event; a pointer move changes only the viewport (`scanPatch` tint, `setHover`) and the readout.
  - *Floor.* Hovering the scan tints the patch a click would take (radius 3 % of the scan's bbox diagonal; `[` and `]` shrink and grow it by a quarter). A click fits `fitPlaneTrimmed` to it and puts `floor` in the store; three clicks with `Shift` held fit the plane through those three points instead. With "On a face" pressed (`choosingFace`), the next click on a flat face of a part (asked with `ctx.describe`; another kind of face says "Click a flat face") sets `onto` to that face's centre and normal, and its part. The bar then shows the proposed move as a preview (`previewScan(id, compose(toFloor(...), current))`), with "plane rms 0.8 mm over 412 triangles".
  - *Pairs.* A click on the scan is a scan end (`hit.local`), a click on a part a model end (`e.hit.point`, `e.hit.part`); when both are under the pointer the nearer along the ray counts. `Backspace` drops the last end. The ends are drawn as numbered dots. With three whole pairs the fit is worked out (on that change of the store) and previewed.
  - *Nudge.* The gizmo is on the scan, at the last point clicked on it (its bbox centre before any); `G` and `R` choose moving or turning, as for a shape; `T` does nothing for a scan. A drag draws the scan as dragged and tells main once, on release.
  - `Escape` drops what is in hand (the draft pairs, the floor) and the preview; a second `Escape` puts the tool down. Changing the layout or the object empties the store.
  - In a layout whose shown parts torno moved (`ctx.moved`), a model end on a moved part is refused at the pointer: "torno moved lid for display here: align to a part it did not move, or in a layout that places the parts as assembled".
- **The bar** (`AlignBar`, at the bottom centre like `SectionBar`, class `alignbar`, `role="toolbar"`, `aria-label="Align"`), shown while the tool is in hand:
  - which scan (a `select` when there are several), and three mode buttons: "Floor", "Pairs", "Nudge" (`aria-pressed`);
  - Floor: "Lay on" with "Ground" and "On a face" (`aria-pressed`), a "Height" field in mm for the ground, the rms line, "Apply";
  - Pairs: a row per pair, `1  scan (310.2, −44.1, 12.9)  →  base (−96, 31, 0)  1.8 mm`, every number in `num`; three fields to type a model end (`aria-label="Model x of pair 1"`, and y, z; `Enter` keeps it); a remove button per row; below them `rms 2.1 mm · worst 3.4 mm (pair 2)`, the checkbox "Fit size too", the `sizeNote`, and "Apply" (disabled until three whole pairs fit without error; the error is shown in its place);
  - Nudge: six fields, `X`, `Y`, `Z` in mm (where the scan's own origin is) and `RX`, `RY`, `RZ` in degrees about X, then Y, then Z, as `ui/ShapeFields.tsx` shows a shape's; `Enter` or leaving a field applies it as `typed`;
  - always: "Not aligned here" or the `alignmentText`, a "Clear" button (`align(…, null)`, after a `Confirm`), and the `staleText` in `--warn` when there is one.
  - Fields are the DOM's own while they are typed in, as `SectionBar`'s are.
- **`sizeNote`.** With a `unitHint`: `These points fit 1000 × larger: this scan looks like it is in m, and was imported as mm. Change its unit on its row.` Else when `|freeScale − 1| > 0.005`: `The scan measures 1.8 % larger than the model between these points.` (or `smaller`). Else null.
- **Checking** (D8, Review Focus 5). After every successful build (`builds.on('scene')`, through a `retrying` of its own, cancelled with the workspace) and after every `align`: for each scan and each of its alignments whose layout the scene has, one `nearest` query for `anchoredPoints` (the pairs that have a `part`, and the floor's point when it has one); `judgeAlignment`:
  - `of` is how many points were asked; `off` counts those whose part the layout no longer has, or whose point is further from that part than `tolerance(part.bbox)`; `worst` is the greatest distance found;
  - `moved` names the parts whose `arranged` (zeros when absent) is not what `alignment.frame` holds for them, by more than 1e-6: of the parts the alignment is tied to, or, for an alignment tied to none (typed, nudged, a floor on the ground), of every part of the layout.
  - `ScanStore.checked` keeps it in memory and tells `changed`. Nothing is moved or re-fitted.

- [ ] **Step 1: Write the failing unit tests**

`app/src/main/scans/alignCheck.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Part } from '../../shared/scene'
import type { ScanAlignment } from '../../shared/scans'
import type { NearestAnchor } from '../marks/reanchor'
import { anchoredPoints, checkAlignments, judgeAlignment } from './alignCheck'

const part = (name: string, arranged?: [number, number, number]): Part =>
  ({ key: `print:${name}`, name, layout: 'print', bbox: { min: [-20, -15, -2.5], max: [20, 15, 2.5] }, ...(arranged ? { arranged } : {}) }) as Part
const pair = (model: [number, number, number], on?: string) => ({ scan: [0, 0, 0] as [number, number, number], model, residual: 0, ...(on ? { part: on } : {}) })
const ALIGNED: ScanAlignment = {
  transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 },
  steps: ['pairs'],
  pairs: [pair([10, 5, 2.5], 'tray'), pair([-10, 5, 2.5], 'tray'), pair([0, -5, 2.5], 'lid'), pair([7, 7, 7])],
  frame: { tray: [0, 0, 0], lid: [45, 0, 0] },
  at: ''
}
const found = (part: string, distance: number): NearestAnchor => ({ part, found: true, point: [0, 0, 0], normal: null, ref: `${part}/F0`, distance, descriptor: null, support: 'face' }) as NearestAnchor

describe('judgeAlignment', () => {
  it('asks only of the points that were clicked on a part', () => {
    expect(anchoredPoints(ALIGNED)).toEqual([{ part: 'tray', point: [10, 5, 2.5] }, { part: 'tray', point: [-10, 5, 2.5] }, { part: 'lid', point: [0, -5, 2.5] }])
    expect(anchoredPoints({ ...ALIGNED, pairs: undefined, steps: ['floor'], floor: { part: 'tray', point: [0, 0, 2.5] } })).toEqual([{ part: 'tray', point: [0, 0, 2.5] }])
    expect(anchoredPoints({ ...ALIGNED, pairs: undefined, steps: ['floor'], floor: { point: [0, 0, 0] } })).toEqual([])
  })

  it('holds while the model is still under its points', () => {
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [45, 0, 0])], [found('tray', 0), found('tray', 0.2), found('lid', 0.01)], 12)
    expect(check).toEqual({ revision: 12, of: 3, off: 0, worst: 0.2, moved: [] })
  })

  it('counts the points the model has left, and a part that is gone', () => {
    // A box 40 × 30 × 5: within half a millimetre is on it.
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [45, 0, 0])], [found('tray', 6.2), found('tray', 0.5), { part: 'lid', found: false }], 12)
    expect(check).toMatchObject({ of: 3, off: 2, worst: 6.2 })
  })

  it('says which of the parts it is tied to torno has moved since', () => {
    const check = judgeAlignment(ALIGNED, [part('tray'), part('lid', [50, 0, 0]), part('clip', [90, 0, 0])], [found('tray', 0), found('tray', 0), found('lid', 0)], 12)
    // The clip was moved too, and the alignment is tied to nothing of it.
    expect(check.moved).toEqual(['lid'])
  })

  it('of an alignment tied to no part, any part torno has moved since', () => {
    const typed: ScanAlignment = { ...ALIGNED, steps: ['typed'], pairs: undefined, frame: { tray: [0, 0, 0], lid: [45, 0, 0] } }
    expect(judgeAlignment(typed, [part('tray'), part('lid', [50, 0, 0])], [], 12)).toEqual({ revision: 12, of: 0, off: 0, worst: 0, moved: ['lid'] })
    expect(judgeAlignment(typed, [part('tray'), part('lid', [45, 0, 0])], [], 12).moved).toEqual([])
    // A part that came with a later build was never where it was not: it says nothing.
    expect(judgeAlignment(typed, [part('tray'), part('lid', [45, 0, 0]), part('new')], [], 12).moved).toEqual([])
  })
})

describe('checkAlignments', () => {
  const scans = (alignments: Record<string, ScanAlignment>) => [{ id: 'S1', alignments }]
  const scene = { revision: 12, scene: { model: 'm.py', layouts: ['print'], parts: [part('tray'), part('lid', [50, 0, 0])], seconds: 0, output: '' } }

  it('asks the kernel once per alignment of a layout the build has, and keeps what it found', async () => {
    const asked: unknown[] = []
    const kept: unknown[] = []
    const done = await checkAlignments(
      {
        scans: { list: async () => scans({ print: ALIGNED, assembly: ALIGNED }) as never, checked: async (...args) => void kept.push(args) },
        scene: () => scene,
        nearest: async (_id, layout, anchors) => {
          asked.push([layout, anchors.length])
          return anchors.map((a) => found(a.part, 0))
        }
      },
      'box'
    )
    expect(done).toBe(true)
    expect(asked).toEqual([['print', 3]])
    expect(kept).toEqual([['box', 'S1', 'print', { revision: 12, of: 3, off: 0, worst: 0, moved: ['lid'] }]])
  })

  it('is to be tried again when the kernel could not be asked, and keeps nothing meanwhile', async () => {
    const kept: unknown[] = []
    const deps = { scans: { list: async () => scans({ print: ALIGNED }) as never, checked: async (...args: unknown[]) => void kept.push(args) }, scene: () => scene }
    expect(await checkAlignments({ ...deps, nearest: async () => Promise.reject(new Error('the kernel exited')) }, 'box')).toBe(false)
    expect(kept).toEqual([])
    expect(await checkAlignments({ ...deps, scene: () => undefined, nearest: async () => [] }, 'box')).toBe(true)
  })
})
```

`app/src/renderer/state/align.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ScanAlignment } from '../../shared/scans'
import { fitOf, floorAlignment, movedAlignment, pairsAlignment, sizeNote, withModelEnd, withScanEnd } from './align'

describe('the pairs in hand', () => {
  it('take their ends in either order, each to the first pair that lacks one', () => {
    let pairs = withScanEnd([], [1, 2, 3])
    pairs = withScanEnd(pairs, [4, 5, 6])
    pairs = withModelEnd(pairs, [10, 0, 0], 'base')
    pairs = withModelEnd(pairs, [20, 0, 0])
    pairs = withModelEnd(pairs, [30, 0, 0], 'post')
    expect(pairs).toEqual([{ scan: [1, 2, 3], model: [10, 0, 0], part: 'base' }, { scan: [4, 5, 6], model: [20, 0, 0] }, { model: [30, 0, 0], part: 'post' }])
  })

  it('fit once three are whole, and say so as an alignment that starts over', () => {
    const whole = [[0, 0, 0], [10, 0, 0], [0, 10, 0]].map((p) => ({ scan: p as [number, number, number], model: [p[0] + 5, p[1], p[2] + 1] as [number, number, number], part: 'base' }))
    expect(fitOf(whole.slice(0, 2), false)).toBeNull()
    expect(fitOf([...whole.slice(0, 2), { scan: [0, 10, 0] }], false)).toBeNull()
    const fit = fitOf(whole, false)
    if (!fit || 'error' in fit) throw new Error('no fit')
    const made = pairsAlignment(whole, fit)
    expect(made.steps).toEqual(['pairs'])
    expect(made.transform.t.map((c) => Math.round(c * 1e9) / 1e9)).toEqual([5, 0, 1])
    expect(made.pairs).toHaveLength(3)
    expect(made.pairs![0]).toMatchObject({ scan: [0, 0, 0], model: [5, 0, 1], part: 'base' })
  })
})

describe('what is added to an alignment', () => {
  const current: ScanAlignment = { transform: { t: [5, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], pairs: [], rms: 1, frame: {}, at: '' }

  it('a floor is composed on what there is, and says what it was laid on', () => {
    const floor = { plane: { origin: [5, 0, 30] as [number, number, number], normal: [0, 0, 1] as [number, number, number], rms: 0.4, used: 120 }, facing: [0, 0, 1] as [number, number, number] }
    const onGround = floorAlignment(current, floor, null, 2)
    expect(onGround).toMatchObject({ steps: ['pairs', 'floor'], rms: 0.4, floor: { point: [0, 0, 2] } })
    expect(onGround.transform.t).toEqual([5, 0, -28])
    const onFace = floorAlignment(null, floor, { origin: [0, 0, 2.5], normal: [0, 0, 1], part: 'base' }, 0)
    expect(onFace).toMatchObject({ steps: ['floor'], floor: { part: 'base', point: [0, 0, 2.5] } })
    expect(onFace.transform.t).toEqual([0, 0, -27.5])
  })

  it('a nudge and typed values are added once each in a row', () => {
    const nudged = movedAlignment(current, { t: [6, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'nudge')
    expect(nudged.steps).toEqual(['pairs', 'nudge'])
    expect(movedAlignment({ ...current, ...nudged, frame: {}, at: '' }, { t: [7, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'nudge').steps).toEqual(['pairs', 'nudge'])
    expect(movedAlignment(null, { t: [7, 0, 0], q: [0, 0, 0, 1], s: 1 }, 'typed').steps).toEqual(['typed'])
  })
})

describe('sizeNote', () => {
  const fit = (freeScale: number) => ({ transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, residuals: [], rms: 0, freeScale }) as never
  it('says a unit when the size is one, a per cent when it is off, and nothing when it fits', () => {
    expect(sizeNote(fit(1000.2), 'mm')).toBe('These points fit 1000 × larger: this scan looks like it is in m, and was imported as mm. Change its unit on its row.')
    expect(sizeNote(fit(0.0393), 'in')).toBe('These points fit 25.4 × smaller: this scan looks like it is in mm, and was imported as in. Change its unit on its row.')
    expect(sizeNote(fit(0.982), 'mm')).toBe('The scan measures 1.8 % larger than the model between these points.')
    expect(sizeNote(fit(1.02), 'mm')).toBe('The scan measures 2 % smaller than the model between these points.')
    expect(sizeNote(fit(1.002), 'mm')).toBeNull()
  })
})
```

(A free scale under 1 means the scan must shrink to fit: it measures larger.)

Add to `main/scans/store.test.ts`:

```ts
  it('works out the residuals of an alignment itself, whatever it is told', async () => {
    const scans = store()
    await scans.import('bracket', source)
    const told = { ...ALIGNED, steps: ['pairs' as const], rms: 0, scaled: false, transform: { t: [0, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number], s: 2 },
      pairs: [{ scan: [1, 0, 0] as [number, number, number], model: [2, 0, 3] as [number, number, number], residual: 0 }, { scan: [0, 1, 0] as [number, number, number], model: [0, 2, 0] as [number, number, number], residual: 99 }] }
    const kept = (await scans.align('bracket', 'S1', 'print', told)).alignments.print
    expect(kept.pairs!.map((p) => p.residual)).toEqual([3, 0])
    expect(kept.rms).toBeCloseTo(Math.sqrt(4.5), 9)
    expect(kept.scaled).toBe(true)
  })
```

Add to `ShapeGizmo.test.ts`: `draggedTo('scale', undefined, undefined, stand)` is `{}` and leaves the stand's scale at 1 (a scan is never sized); `draggedTo('translate', …)` and `'rotate'` are unchanged. Change `draggedTo`'s signature to `(mode: GizmoMode, kind: ShapeKind | undefined, from: Vec3 | undefined, stand: THREE.Object3D)`.

`app/src/renderer/tools/align.test.ts`: with a fake `ToolContext` in the style of `tools/measure.test.ts` (its `context()` helper, to which `pickScan`, `scanPatch`, `previewScan`, `showAlignPoints` and `editScan` are added as recording stubs):
- in `pairs` mode a click with a scan hit adds a scan end and a click with a part hit a model end with its part; with both under the pointer the nearer counts;
- a model end on a part `ctx.moved` says is moved is refused with the sentence above and adds nothing;
- three whole pairs call `previewScan` with the fit's transform;
- in `floor` mode a move calls `scanPatch(hit, r, { tint: true })` and changes nothing in `alignStore`; a click puts a `floor` there with `used` and `rms`;
- `Escape` empties the draft and calls `previewScan(id, null)`; with nothing in hand it returns false;
- with no scan the pointer is told "Import a scan first".

Run: `pnpm -C app exec vitest run src/main/scans src/renderer/state/align.test.ts src/renderer/tools/align.test.ts src/renderer/viewport/ShapeGizmo.test.ts` Expected: FAIL (modules and functions missing).

- [ ] **Step 2: Implement `alignCheck.ts`, the store's rule, `state/align.ts`, the gizmo's subject, `alignTool.ts`, the viewport calls.**

`ScanLayer.scanPatch` gathers with `tree.shapecast({ intersectsBounds: (box) => box.intersectsSphere(sphere), intersectsTriangle: (triangle, index) => { … } })` in the scan's own frame (the radius divided by `s`), keeps a triangle whose centroid is in the sphere and whose normal is within `degrees` (default 25) of the hit's, and returns centroids brought to the object frame with areas times `s²`. The tint is one extra `THREE.Mesh` over the same position attribute with its own index (`setDrawRange` to what was gathered), `MeshBasicMaterial` in `--accent` at 35 %, `depthTest` with `polygonOffsetFactor: -1`: never a second copy of the scan.

`Viewport`'s gizmo host becomes `subject: (id) => (id.startsWith('S') ? this.scanSubject(id) : shape mark as before)`; `preview` for a scan calls `this.scans.preview(id, nudged(base, pivot, sub(change.position ?? pivot, pivot), change.rotation ?? [0, 0, 0, 1]))`.

Run the same command. Expected: PASS.

- [ ] **Step 3: Write the failing e2e**

`app/e2e/align.spec.ts` (head as `e2e/scan.spec.ts`; `scans`, `row`, `pickFile`, `open` as there):

```ts
import { apply } from '../src/shared/align'
import { box, grid, moved, stl } from '../src/test/scanFixtures'

type Vec3 = [number, number, number]
// The bracket's base is a box 40 × 30 × 5 round the origin. Its twin, turned 30° and moved: a "scan" of the base.
const TWIN = stl(moved(box([40, 30, 5]), 30, [30, 20, 12]))
const where = (p: Vec3): Vec3 => [Math.cos(Math.PI / 6) * p[0] - Math.sin(Math.PI / 6) * p[1] + 30, Math.sin(Math.PI / 6) * p[0] + Math.cos(Math.PI / 6) * p[1] + 20, p[2] + 12]
// Four points of the base's top, and where each is on the twin. Seen from above the twin covers part of the
// base: the first point, the one that is clicked on the base itself, is clear of it.
const ON_TOP: Vec3[] = [[-15, -10, 2.5], [15, 10, 2.5], [-15, 10, 2.5], [12, -8, 2.5]]
const bar = (p: Page = page) => p.locator('.alignbar')

/** Clicks where a point of the scan's own frame is drawn. */
async function clickScan(local: Vec3): Promise<void> {
  const [fx, fy] = await page.evaluate((local) => window.__tornoTest!.projectScan('S1', local), local)
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.click(canvas.x + fx * canvas.width, canvas.y + fy * canvas.height)
}
async function clickModel(point: Vec3): Promise<void> {
  const [fx, fy] = await page.evaluate((point) => window.__tornoTest!.project(point), point)
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.click(canvas.x + fx * canvas.width, canvas.y + fy * canvas.height)
}
/** Zooms out until every point given is well inside the canvas. */
async function frame(points: Vec3[]): Promise<void> {
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  for (let tries = 0; tries < 12; tries++) {
    const drawn = await page.evaluate((points) => points.map((p) => window.__tornoTest!.project(p)), points)
    if (drawn.every(([x, y]) => x > 0.08 && x < 0.92 && y > 0.08 && y < 0.92)) return
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(150)
  }
  throw new Error('the points never came into view')
}
const alignment = async (layout: string) => (await state()).scans[0].alignments[layout]

test('three pairs and a fourth bring a displaced scan onto the model, and say how well', async () => {
  await open('bracket')
  const file = join(root, 'twin.stl')
  writeFileSync(file, TWIN)
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  // From above, so that the tops of both are what is clicked.
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await frame([...ON_TOP, ...ON_TOP.map(where)])
  await page.keyboard.press('l')
  await expect(bar()).toBeVisible()
  await bar().getByRole('button', { name: 'Pairs' }).click()
  for (const [n, point] of ON_TOP.entries()) {
    await clickScan(where(point))
    if (n === 0) await clickModel(point)   // the first model end is clicked on the part
    else {
      for (const [axis, value] of (['x', 'y', 'z'] as const).map((axis, i) => [axis, point[i]] as const)) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
      await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
    }
  }
  await expect(bar()).toContainText(/rms 0(\.\d+)? mm/)
  // Nothing is kept until it is applied; the scan is already drawn where the fit puts it.
  expect(await alignment('assembly')).toBeUndefined()
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1').locator('.chip[data-state="aligned"]')).toHaveText('aligned')
  const kept = await alignment('assembly')
  expect(kept).toMatchObject({ steps: ['pairs'], frame: { base: [0, 0, 0], post: [0, 0, 0] }, pairs: [{ part: 'base' }, {}, {}, {}] })
  expect(kept.rms!).toBeLessThan(0.5)
  // Where the scan's own points now are: on the base, within what a click can be off by.
  for (const point of ON_TOP) {
    const now = apply(kept.transform, where(point))
    expect(Math.hypot(now[0] - point[0], now[1] - point[1], now[2] - point[2])).toBeLessThan(0.6)
  }
  expect(JSON.parse(readFileSync(join(root, 'bracket', '.torno', 'scans.json'), 'utf8')).scans[0].alignments.assembly.steps).toEqual(['pairs'])
  // In the other layout it is not aligned.
  await page.getByRole('button', { name: 'print', exact: true }).click()
  await expect(row('S1').locator('.chip[data-state="unaligned"]')).toHaveText('not aligned here')
  expect((await scans())[0].aligned).toBe(false)
})

test('typed values move it, and clearing leaves it where it was imported', async () => {
  await page.getByRole('button', { name: 'assembly', exact: true }).click()
  await bar().getByRole('button', { name: 'Nudge' }).click()
  const before = (await alignment('assembly')).transform.t
  await bar().getByRole('textbox', { name: 'Z', exact: true }).fill(String(before[2] + 4))
  await bar().getByRole('textbox', { name: 'Z', exact: true }).press('Enter')
  await expect.poll(async () => (await alignment('assembly')).steps).toEqual(['pairs', 'typed'])
  expect((await alignment('assembly')).transform.t[2]).toBeCloseTo(before[2] + 4, 6)
  // Its pairs are kept, and main says how far off they now are: 4 mm each.
  expect((await alignment('assembly')).pairs!.every((p) => Math.abs(p.residual - 4) < 0.6)).toBe(true)
  await bar().getByRole('button', { name: 'Clear' }).click()
  await page.getByRole('button', { name: 'Clear', exact: true }).last().click()
  await expect.poll(async () => (await state()).scans[0].alignments).toEqual({})
  expect((await scans())[0].transform).toEqual({ t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 })
})

test('a tilted floor is laid flat on the ground, and says that is all it is', async () => {
  await open('hollow')
  const file = join(root, 'tilted.stl')
  // A sheet 29 mm square that rises a millimetre in ten along X, 60 mm up.
  writeFileSync(file, stl(grid(30, 1, (x) => 60 + 0.1 * x)))
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await frame([[0, 0, 60], [14, 14, 61.4], [-14, -14, 58.6]])
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Floor' }).click()
  await clickScan([0.5, 0.5, 60.05])
  await expect(bar()).toContainText(/plane rms 0(\.\d+)? mm over \d+ triangles/)
  await bar().getByRole('button', { name: 'Apply' }).click()
  const kept = await alignment('assembly')
  expect(kept.steps).toEqual(['floor'])
  for (const local of [[0.5, 0.5, 60.05], [14.5, -14.5, 61.45], [-14.5, 14.5, 58.55]] as Vec3[]) expect(Math.abs(apply(kept.transform, local)[2])).toBeLessThan(1e-3)
  await expect(bar()).toContainText('by floor only')
})

test('an alignment says so when a build moves the model from under it', async () => {
  await open('spread')
  const file = join(root, 'lid twin.stl')
  // The lid of the spread fixture is 20 × 20 × 2; where torno puts it is read from the scene.
  const lid = (await state()).scene!.parts.find((p) => p.name === 'lid')!
  const centre: Vec3 = [(lid.bbox.min[0] + lid.bbox.max[0]) / 2, 0, 1]
  writeFileSync(file, stl(moved(box([20, 20, 2]), 0, [centre[0], 40, 1])))
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  const top: Vec3[] = [[6, 6, 2], [-6, 6, 2], [-6, -6, 2]]
  const onLid = top.map(([x, y, z]) => [centre[0] + x, y, z] as Vec3)
  const onTwin = top.map(([x, y, z]) => [centre[0] + x, 40 + y, z] as Vec3)
  await frame([...onLid, ...onTwin])
  await page.keyboard.press('l')
  await bar().getByRole('button', { name: 'Pairs' }).click()
  // The lid is a part torno moved: a model end on it is refused, and said.
  await clickScan(onTwin[0])
  await clickModel(onLid[0])
  await expect(page.locator('.pick-readout')).toContainText('torno moved lid for display here')
  // So it is tied to the tray, which stays, with typed ends; then the tray is made wider.
  for (const [n, [x, y]] of ([[6, 6], [-6, 6], [-6, -6]] as const).entries()) {
    if (n > 0) await clickScan(onTwin[n])
    for (const [axis, value] of [['x', x], ['y', y], ['z', 4]] as const) await bar().getByRole('textbox', { name: `Model ${axis} of pair ${n + 1}` }).fill(String(value))
    await bar().getByRole('textbox', { name: `Model z of pair ${n + 1}` }).press('Enter')
  }
  await bar().getByRole('button', { name: 'Apply' }).click()
  await expect(row('S1').locator('.chip[data-state="aligned"]')).toBeVisible()
  await expect.poll(async () => (await state()).scans[0].checks.print).toMatchObject({ of: 0, off: 0, moved: [] })
  writeFileSync(join(root, 'spread', 'width.txt'), '40\n')
  await expect.poll(async () => (await state()).scans[0].checks.print?.moved, { timeout: 60_000 }).toEqual(['lid'])
  await expect(row('S1').locator('.chip[data-state="stale"]')).toHaveText('check alignment')
  await expect(row('S1').locator('.chip[data-state="stale"]')).toHaveAttribute('title', 'torno has moved lid for display since it was aligned: check the alignment')
  // Nothing was re-fitted.
  expect((await alignment('print')).steps).toEqual(['pairs'])
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/align.spec.ts` Expected: FAIL at the first test (`l` takes no tool).

- [ ] **Step 4: Implement `AlignBar`, the palette entry, the pane's wiring, the rows' "Align" button, the check after builds.** In `ViewportPane.tsx`: `tools.align = alignTool()`; the bar is rendered beside `SectionBar`; a subscription to `alignStore` calls `viewport.previewScan` and `viewport.showAlignPoints` (dots at `apply(transformShown, pair.scan)` and at `pair.model`, labelled with the pair's number) when the draft changes. In `ipc.ts`: `const alignChecks = retrying((objectId) => checkAlignments({ scans, scene: …, nearest: … }, objectId))`, called from `builds.on('scene')` and after `scans:align`, cancelled in `closeWorkspace`.

Then the same command. Expected: PASS, 4 tests. Run `pnpm -C app exec playwright test e2e/tools.spec.ts` too: the shape gizmo's tests PASS unchanged (D7).

- [ ] **Step 5: Design pass** with `frontend-design:frontend-design`: `look` pictures cannot show the bar, so judge it by its markup and computed styles (`page.locator('.alignbar').evaluate((el) => getComputedStyle(el).cssText)` and `innerHTML`), next to `.sectionbar`'s: the same floating surface, hairline, radius and spacing; three pair rows must fit the bar at a 1280 px window without wrapping; residuals right-aligned in the monospace face; the worst pair marked in `--warn` only when it is more than twice the rms. The dots of the pairs are `--accent`, never a mark colour.

- [ ] **Step 6: Suites, commit**

Run: `pnpm test`, `pnpm test:kernel`, `pnpm test:e2e`, `pnpm -C app typecheck`. Expected: pass.

```bash
git add app/src app/e2e/align.spec.ts
git commit -m "A scan is aligned by a floor, by pairs of points or by hand, per layout, and is checked against every build since

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The kernel's scan queries

Kernel only, and independent of Tasks 2 to 5: it needs Task 1's `scanfile` and `scanfix`.

**Files:**
- Create: `kernel/src/torno_kernel/scanclash.py`, `kernel/tests/test_scanclash.py`
- Modify: `kernel/src/torno_kernel/queries.py` (dispatch, the list of queries in the refusal), `kernel/src/torno_kernel/tess.py` (`mesh_faces`), `kernel/tests/test_queries.py` (the refusal's text), `kernel/tests/test_supervisor.py` (one protocol test)

**Interfaces:**
- Consumes: `scanfile.read_bin`, `scanfile.read_mask`, `scanfile.write_bin`, `scanfile.write_mask`, `scanfix.box`, `scanfix.grid` (Task 1); `queries._Surface` (the B-rep nearest point that re-anchoring uses), `queries.need_part`, `tess._tessellate`, `section._Frame`, `topo.solids`.
- Produces: the queries `scan_clash`, `scan_deviation`, `scan_section` of "Shared contracts", and in Python:
  - `tess.mesh_faces(shape) -> tuple[np.ndarray, np.ndarray, np.ndarray]` (vertices in the object frame, triangles, triangles per face)
  - `scanclash.inside(points, vertices, triangles, grids: dict | None = None) -> np.ndarray` (bool per point)
  - `scanclash.clusters(points, cell: float = 5.0) -> np.ndarray` (a number per point, 0 the largest cluster)
  - `scanclash.sampled(vertices, triangles, spacing: float = 1.0) -> tuple[np.ndarray, np.ndarray]` (points, the triangle each is on)
  - `scanclash.to_triangles(p, a, b, c) -> tuple[np.ndarray, np.ndarray]` (distances, nearest points)
  - `scanclash.run(name, shapes, args, kept) -> dict`, and `clash`, `deviation`, `outline`
  - the constants `MAX_CANDIDATES = 200_000`, `MAX_RETAKEN = 32`, `MAX_CLUSTERS = 8`, `CELL = 5.0`, `SURFACE = 1.0`, `BUDGET = 15.0`

Everything below was run before this plan was written, in a scratch copy of the kernel (`.superpowers/sdd/m4-experiments.md`, "The final code"): the 17 tests pass, and on the owner's lid and tub 200,000 points are judged in 0.4 to 1.7 s.

Rules the code keeps, each with its test:
- The worker reads the `mesh.bin` and the masks it is given the paths of, and nothing else. One scan at a time is kept in `kept` (40 MB for Micra), under its path, modification time, size and what was asked of it.
- Inside or outside is decided on the part's own tessellation (`tess.mesh_faces`, the mesh the part is drawn with), never by the classifier: 50 ms a point on the lid (E2).
- A ray that grazes an edge of a triangle is asked again a millionth of a millimetre aside, then along +X, then +Y. (The first cut asked again along X and Y from the same point: from the very middle of a box all three rays meet a diagonal. The test with the box's centre pins it.)
- Distances come from a `cKDTree` over the mesh sampled every millimetre, built with `balanced_tree=False, compact_nodes=False`. scipy is imported when a scan is first asked about, in the worker; when it is not there the query is a `bad_request` that says so.
- Depths and distances that are *told* (`deepest`, each cluster's `depth`, `nearest`, the `worst` of a deviation from the scan) are taken again with `_Surface.nearest`: at most 32 times a query.
- `exact` is false in every reply.
- 15 s after it began a clash stops testing candidates and answers with what it has (`sampling.partial`).

- [ ] **Step 1: Write the failing tests**

`kernel/tests/test_scanclash.py`:

```python
"""The scan queries, in-process: what is inside a part, how far a part is from a scan, where a plane cuts one."""

import math
import re
from pathlib import Path

import numpy as np
import pytest
import scanfix

from torno_kernel import queries, scanclash, scanfile
from torno_kernel.loader import load_scene
from torno_kernel.tess import build_scene, mesh_of

WS = Path(__file__).parent / "fixtures" / "ws"
IDENTITY = {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1}
# A sheet of 30 × 30 vertices a millimetre apart, at -14.5 to 14.5: none on a whole number.
SHEET = scanfix.grid(30)


def scan_of(tmp_path, mesh=SHEET, name="S1", transform=IDENTITY, **more) -> dict:
    path = tmp_path / f"{name}.bin"
    scanfile.write_bin(path, *mesh)
    return {"id": name, "path": str(path), "transform": transform, **more}


def box_part() -> dict:
    """A 20 × 20 × 10 box round the origin."""
    from build123d import Box

    return {"assembly:a": Box(20, 20, 10)}


def ask(shapes, name: str, kept=None, **args) -> dict:
    return queries.run(shapes, name, {"layout": "assembly", "part": "a", **args}, {} if kept is None else kept)


def refused(shapes, name: str, **args) -> tuple[str, str]:
    with pytest.raises(queries.QueryError) as e:
        ask(shapes, name, **args)
    return e.value.kind, e.value.message


def face_at(shapes, point) -> str:
    return queries.run(shapes, "nearest", {"layout": "assembly", "anchors": [{"part": "a", "point": point}]}, {})["anchors"][0]["ref"]


# Inside or outside


def test_a_point_is_inside_when_its_ray_crosses_the_mesh_an_odd_number_of_times():
    vertices, triangles = scanfix.box((20, 20, 10))
    points = [[0.3, 0.2, 0], [11, 0, 0], [0.3, 0.2, 6], [0.3, 0.2, -6], [9.9, 9.9, 4.9], [-30, 0.2, 0.1]]
    assert scanclash.inside(points, vertices, triangles).tolist() == [True, False, False, False, True, False]


def test_a_ray_through_an_edge_or_a_corner_is_asked_again_another_way():
    vertices, triangles = scanfix.box((20, 20, 10))
    # Straight up from each of these the ray meets the diagonal the top is split by, or a corner of the box.
    # From the very middle the rays along X and along Y meet the diagonals of the sides too.
    points = [[0, 0, 0], [0, 0, -20], [0, 0, 20], [5, 5, 0], [10, 10, -20], [-5, -5, 4]]
    assert scanclash.inside(points, vertices, triangles).tolist() == [True, False, False, True, False, True]


def test_it_agrees_with_the_solid_itself_but_within_the_mesh_of_its_surface():
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    _, _, shapes = build_scene(load_scene(WS / "hollow", "hollow.py"), "hollow.py")
    tub = shapes["assembly:tub"]
    vertices, triangles = mesh_of(tub)
    rng = np.random.default_rng(7)
    anywhere = rng.uniform(vertices.min(axis=0) - 2, vertices.max(axis=0) + 2, size=(300, 3))
    near = vertices[rng.integers(0, len(vertices), 300)] + rng.normal(0, 0.3, size=(300, 3))
    points = np.concatenate([anywhere, near])
    mine = scanclash.inside(points, vertices, triangles)
    classifier = BRepClass3d_SolidClassifier(tub.wrapped)
    theirs = []
    for point in points:
        classifier.Perform(gp_Pnt(*map(float, point)), 1e-7)
        theirs.append(classifier.State() == TopAbs_IN)
    wrong = np.flatnonzero(mine != np.array(theirs))
    assert 20 < mine.sum() < 580
    # The post is round and its mesh is not: a point between the two is on one side of each.
    held = {}
    for point in points[wrong]:
        [found] = queries.nearest(shapes, "assembly", [{"part": "tub", "point": [float(c) for c in point]}], held)
        assert found["distance"] < 0.02


def test_points_are_clustered_by_the_cells_that_touch_the_largest_first():
    few = [[100, 100, 100], [102, 101, 100]]
    many = [[x, 0, 0] for x in range(0, 40, 3)]
    alone = [[0, 60, 0]]
    labels = scanclash.clusters(np.array(few + many + alone, dtype=float))
    assert labels.tolist() == [1, 1, *[0] * 14, 2]
    assert scanclash.clusters(np.zeros((0, 3))).tolist() == []


def test_how_far_a_point_is_from_a_triangle_over_it_beside_it_and_past_a_corner():
    a, b, c = np.array([[0.0, 0, 0]] * 4), np.array([[10.0, 0, 0]] * 4), np.array([[0.0, 10, 0]] * 4)
    points = np.array([[2.0, 2, 3], [5, -4, 0], [-3, -4, 0], [8, 8, 0]])
    distance, nearest = scanclash.to_triangles(points, a, b, c)
    assert distance == pytest.approx([3, 4, 5, math.sqrt(18)])
    assert nearest == pytest.approx(np.array([[2, 2, 0], [5, 0, 0], [0, 0, 0], [5, 5, 0]]))
    # A triangle with no area is a point.
    flat = scanclash.to_triangles(np.array([[1.0, 0, 0]]), np.zeros((1, 3)), np.zeros((1, 3)), np.zeros((1, 3)))
    assert flat[0] == pytest.approx([1])


def test_a_mesh_is_sampled_no_more_than_the_spacing_apart():
    vertices = np.array([[0.0, 0, 0], [40, 0, 0], [0, 0.5, 0], [0, 30, 7]])
    triangles = np.array([[0, 1, 2], [0, 1, 3]])
    points, owner = scanclash.sampled(vertices, triangles, 1.0)
    assert set(owner.tolist()) == {0, 1}
    # The sliver has a row or two of points along it, not as many as a triangle 40 mm a side.
    assert (owner == 0).sum() < 130 and (owner == 1).sum() > 500
    rng = np.random.default_rng(3)
    s, t = rng.uniform(0, 1, 500), rng.uniform(0, 1, 500)
    over = s + t > 1
    s[over], t[over] = 1 - s[over], 1 - t[over]
    anywhere = vertices[0] * (1 - s - t)[:, None] + vertices[1] * s[:, None] + vertices[3] * t[:, None]
    gap = np.linalg.norm(anywhere[:, None, :] - points[None, owner == 1, :], axis=2).min(axis=1)
    assert gap.max() <= 1.0


# scan_clash


def test_a_sheet_through_a_box_has_its_points_inside_counted_and_the_deepest_taken_on_the_solid(tmp_path):
    said = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert said["part"] == "a" and said["scan"] == "S1" and said["exact"] is False
    assert said["points"] == {"scan": 900, "candidates": 900, "checked": 900, "ignored": 0}
    assert said["inside"]["count"] == 400 and said["inside"]["clustersOmitted"] == 0
    # Round the 400, the triangles with a corner at 9.5 and one at 10.5: two in each of the 19 cells along a
    # side, and at the four corners two, two, one and one, by which way the cell is split.
    assert said["inside"]["crossing"] == 4 * 19 * 2 + 6
    [cluster] = said["inside"]["clusters"]
    assert cluster["count"] == 400 and cluster["centre"] == pytest.approx([0, 0, 0], abs=1e-9)
    assert cluster["bbox"] == {"min": [-9.5, -9.5, 0], "max": [9.5, 9.5, 0]}
    # In the middle of a box 10 thick every point is 5 from its top and its bottom: exactly, by the B-rep.
    assert said["deepest"]["depth"] == pytest.approx(5, abs=1e-9) and cluster["depth"] == pytest.approx(5, abs=1e-9)
    assert re.fullmatch(r"a/F\d", said["deepest"]["under"]) and said["deepest"]["at"][2] == 0
    assert said["nearest"]["distance"] == pytest.approx(0.5, abs=1e-9)
    assert max(abs(c) for c in said["nearest"]["at"]) == 10.5 and max(abs(c) for c in said["nearest"]["on"]) == pytest.approx(10)
    assert said["sampling"] == {"every": 1, "cell": 5.0, "surface": 1.0, "deflection": 0.1, "retaken": said["sampling"]["retaken"], "partial": False, "seconds": said["sampling"]["seconds"]}
    assert 1 <= said["sampling"]["retaken"] <= scanclash.MAX_RETAKEN


def test_the_scan_is_where_its_transform_puts_it(tmp_path):
    above = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert above["inside"] == {"count": 0, "crossing": 0, "clusters": [], "clustersOmitted": 0} and above["deepest"] is None
    assert above["nearest"]["distance"] == pytest.approx(2, abs=1e-9) and above["nearest"]["at"][2] == 7
    # Stood on edge through the middle: 20 across, and the ten rows from -4.5 to 4.5 high.
    upright = {"t": [0, 0, 0], "q": [math.sin(math.pi / 4), 0, 0, math.cos(math.pi / 4)], "s": 1}
    assert ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform=upright))["inside"]["count"] == 200
    # At half its size every vertex is within the box.
    half = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 0], "q": [0, 0, 0, 2], "s": 0.5}))
    assert half["inside"]["count"] == 900 and half["nearest"] is None


def test_a_region_is_left_out_or_is_all_that_is_asked(tmp_path):
    vertices, triangles = SHEET
    # The triangles whose first corner is left of the middle.
    left = vertices[triangles[:, 0], 0] < 0
    scanfile.write_mask(tmp_path / "M7.mask", left)
    without = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, ignore=[str(tmp_path / "M7.mask")]))
    only = ask(box_part(), "scan_clash", scan=scan_of(tmp_path, only=str(tmp_path / "M7.mask")))
    # The column of vertices at 0.5 is a corner of triangles on both sides.
    assert without["inside"]["count"] == 9 * 20 and without["points"]["ignored"] == 16 * 30
    assert only["inside"]["count"] == 11 * 20 and only["points"]["ignored"] == 14 * 30
    scanfile.write_mask(tmp_path / "M8.mask", np.ones(5, dtype=bool))
    kind, message = refused(box_part(), "scan_clash", scan=scan_of(tmp_path, ignore=[str(tmp_path / "M8.mask")]))
    assert kind == "bad_request" and "a region of S1 could not be read" in message and "5 triangles, not 1682" in message


def test_more_points_than_it_can_test_are_thinned_and_a_query_out_of_time_says_what_it_did(tmp_path, monkeypatch):
    monkeypatch.setattr(scanclash, "MAX_CANDIDATES", 100)
    thinned = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert thinned["points"] == {"scan": 900, "candidates": 900, "checked": 100, "ignored": 0}
    assert thinned["sampling"]["every"] == 9 and 30 <= thinned["inside"]["count"] <= 60
    monkeypatch.setattr(scanclash, "BUDGET", -1.0)
    late = ask(box_part(), "scan_clash", scan=scan_of(tmp_path))
    assert late["sampling"]["partial"] is True and late["points"]["checked"] == 0 and late["inside"]["count"] == 0


def test_what_has_no_inside_and_what_is_no_scan_are_refused(tmp_path):
    from build123d import Axis, Box

    shell = {"assembly:a": Box(20, 20, 10).faces().sort_by(Axis.Z)[-1]}
    assert refused(shell, "scan_clash", scan=scan_of(tmp_path)) == ("bad_request", "a is not a solid: nothing is inside it; scan_deviation says how far it is from the scan")
    kind, message = refused(box_part(), "scan_clash", scan={"id": "S1", "path": str(tmp_path / "gone.bin"), "transform": IDENTITY})
    assert kind == "bad_request" and message.startswith("the mesh of S1 could not be read: ")
    kind, message = refused(box_part(), "scan_clash", scan=scan_of(tmp_path, transform={"t": [0, 0, 0], "q": [0, 0, 0, 0], "s": 1}))
    assert (kind, message) == ("bad_request", "the transform of S1 is not one: t is three numbers, q four that are not all zero, s more than zero")
    assert refused(box_part(), "scan_clash", scan=scan_of(tmp_path), margin=500) == ("bad_request", "margin is a number from 0 to 50")
    assert refused(box_part(), "scan_clash")[1] == "a scan query needs args.scan, with id and path, both strings, and transform"
    assert refused(box_part(), "scan_clash", part="b", scan=scan_of(tmp_path))[0] == "bad_ref"


def test_what_was_worked_out_of_a_part_and_of_a_scan_is_kept_for_the_next_query(tmp_path):
    shapes, kept = box_part(), {}
    first = ask(shapes, "scan_clash", kept, scan=scan_of(tmp_path))
    read = kept["scan"][1]
    again = ask(shapes, "scan_clash", kept, scan=scan_of(tmp_path, name="S1"))
    assert again["inside"] == first["inside"]
    assert ("scan surface", "assembly:a") in kept and ("scan grids", "assembly:a") in kept
    # The same file asked of with another transform is read again: it stands elsewhere.
    ask(shapes, "scan_clash", kept, scan={**scan_of(tmp_path), "transform": {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}})
    assert kept["scan"][1] is not read


# scan_deviation


def test_a_face_of_a_part_is_so_far_from_the_scan_and_on_which_side(tmp_path):
    shapes = box_part()
    top = face_at(shapes, [0, 0, 5])
    above = {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}
    said = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=above), faces=[int(top.split("F")[1])])
    assert said["from"] == "part" and said["exact"] is False and said["beyond"] == 0 and said["compared"] == said["samples"] > 400
    assert {k: round(v, 6) for k, v in said["distance"].items()} == {"min": 2, "mean": 2, "max": 2, "rms": 2, "p50": 2, "p90": 2, "p95": 2}
    assert said["signed"] == {"min": pytest.approx(2), "mean": pytest.approx(2), "max": pytest.approx(2), "inside": 0}
    assert said["worst"]["face"] == top and said["worst"]["at"][2] == pytest.approx(5) and said["worst"]["on"][2] == pytest.approx(7)
    # The sheet at six tenths of its size, a millimetre under the top: all of it is inside the box.
    within = {"t": [0, 0, 4], "q": [0, 0, 0, 1], "s": 0.6}
    inside = ask(shapes, "scan_deviation", scan=scan_of(tmp_path, transform=within), faces=[int(top.split("F")[1])])
    assert inside["distance"]["min"] == pytest.approx(1) and inside["distance"]["max"] == pytest.approx(math.sqrt(1 + 2 * 1.3**2))
    assert inside["signed"]["max"] == pytest.approx(-1) and inside["signed"]["inside"] == inside["compared"]


def test_the_scan_is_so_far_from_the_part_and_the_furthest_point_is_taken_on_the_solid(tmp_path):
    above = {"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}
    said = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform=above), **{"from": "scan"})
    assert said["samples"] == 900 and said["compared"] == 900
    # Over the top the scan is 2 away; the mesh is sampled every millimetre, so the least found is that or a little more.
    assert 2 <= said["distance"]["min"] <= 2.13
    # The corner of the sheet, from the corner of the box: by the B-rep.
    assert said["worst"]["distance"] == pytest.approx(math.sqrt(4 + 4.5**2 + 4.5**2), abs=1e-9)
    assert [abs(c) for c in said["worst"]["at"]] == [14.5, 14.5, 7] and [abs(c) for c in said["worst"]["on"]] == pytest.approx([10, 10, 5])
    assert said["signed"]["inside"] == 0


def test_nothing_within_reach_is_said_as_that_and_a_part_that_is_no_solid_has_no_sides(tmp_path):
    from build123d import Axis, Box

    far = ask(box_part(), "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 100], "q": [0, 0, 0, 1], "s": 1}))
    assert far["compared"] == 0 and far["beyond"] == far["samples"] and far["distance"] is None and far["worst"] is None
    assert far["how"].endswith("nothing of the scan is within 50 mm")
    face = {"assembly:a": Box(20, 20, 10).faces().sort_by(Axis.Z)[-1]}
    said = ask(face, "scan_deviation", scan=scan_of(tmp_path, transform={"t": [0, 0, 7], "q": [0, 0, 0, 1], "s": 1}))
    assert said["signed"] is None and said["distance"]["max"] == pytest.approx(2)
    assert refused(box_part(), "scan_deviation", scan=scan_of(tmp_path), faces=[6]) == ("bad_ref", "faces are numbers of faces of a, which has 6: F0 to F5")
    assert refused(box_part(), "scan_deviation", scan=scan_of(tmp_path), **{"from": "both"})[0] == "bad_request"


# scan_section


def test_a_plane_cuts_a_sheet_in_one_line_told_in_the_planes_own_axes(tmp_path):
    said = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0.25, 0, 0], "normal": [1, 0, 0]}, "scan": scan_of(tmp_path)}, {})
    assert said["scan"] == "S1" and said["exact"] is False and said["segments"] == 58 and said["omitted"] == 0
    # As `section` has them for this normal: x along +Y, y along +Z.
    assert said["plane"] == {"origin": [0.25, 0, 0], "normal": [1, 0, 0], "x": [0, 1, 0], "y": [0, 0, 1]}
    [line] = said["polylines"]
    assert line["closed"] is False and len(line["points"]) == 59
    along = [u for u, _ in line["points"]]
    assert sorted(along) in (along, along[::-1]) and {v for _, v in line["points"]} == {0}
    assert said["bounds"] == {"min": [-14.5, 0], "max": [14.5, 0]}


def test_a_plane_through_a_closed_scan_cuts_a_closed_line_and_one_that_misses_cuts_none(tmp_path):
    scan = scan_of(tmp_path, scanfix.box((40, 30, 5)))
    said = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 1], "normal": [0, 0, 2]}, "scan": scan}, {})
    [loop] = said["polylines"]
    assert loop["closed"] is True and len(loop["points"]) == 8
    assert said["bounds"] == {"min": [-20, -15], "max": [20, 15]} and said["plane"]["normal"] == [0, 0, 1]
    missed = queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 50], "normal": [0, 0, 1]}, "scan": scan}, {})
    assert missed["polylines"] == [] and missed["bounds"] is None and missed["segments"] == 0
    with pytest.raises(queries.QueryError, match="scan_section needs args.plane"):
        queries.run(box_part(), "scan_section", {"layout": "assembly", "plane": {"origin": [0, 0, 0], "normal": [0, 0, 0]}, "scan": scan}, {})
```

Run: `(cd kernel && uv run pytest -q tests/test_scanclash.py)` Expected: FAIL, `cannot import name 'scanclash'`.

- [ ] **Step 2: `tess.mesh_faces` and the dispatch**

In `kernel/src/torno_kernel/tess.py`, after `mesh_of`:

```python
def mesh_faces(shape: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """As ``mesh_of``, with how many of the triangles each face has, in the order of the faces."""
    [(_, _, mesh, loc, _, _)] = _tessellate({"part": shape})
    vertices = np.asarray(mesh["vertices"]).reshape(-1, 3)
    triangles = np.asarray(mesh["triangles"]).reshape(-1, 3)
    per_face = np.asarray(mesh["triangles_per_face"], dtype=np.int64).reshape(-1)
    return _posed(vertices, [float(x) for x in loc[0]], [float(x) for x in loc[1]]), triangles, per_face
```

In `kernel/src/torno_kernel/queries.py`, in `run`, before `if name == "describe":`

```python
    if name in ("scan_clash", "scan_deviation", "scan_section"):
        from . import scanclash

        return scanclash.run(name, shapes, args, kept)
```

and the refusal at its end becomes

```python
    raise QueryError(
        "bad_request",
        f"unknown query {name!r}; the queries are describe, nearest, measure, section, check, "
        "scan_clash, scan_deviation and scan_section",
    )
```

Change the text `kernel/tests/test_queries.py` expects of it to match (one assertion, in the test that asks for `"nope"`).

- [ ] **Step 3: `scanclash.py`**

```python
"""What a part is to a scan: the ``scan_clash``, ``scan_deviation`` and ``scan_section`` queries.

A scan is a mesh someone measured: nothing here is exact, and every answer
says so. Which scan points are inside a part is decided on the mesh the part
is drawn with, by counting how often a ray from the point crosses it; how far
a point is from the part is first taken from that mesh sampled every
millimetre, and, for the few points an answer names, taken again from the
B-rep. The scan is read from the ``mesh.bin`` the query names: the worker is
given paths, and never looks for a file itself.
"""

import os
import time
from typing import Any

import numpy as np

from . import scanfile, tess, topo
from .queries import QueryError, _Surface, need_part

# No more scan vertices than this are tested against a part: more are thinned to every n-th, and the answer says so.
MAX_CANDIDATES = 200_000
# No more points than this are taken again on the B-rep (16 ms each on a part of 2,600 faces).
MAX_RETAKEN = 32
MAX_CLUSTERS = 8
# Scan points inside a part are one cluster when their cells of this size, mm, touch.
CELL = 5.0
# How far apart, mm, the points are that stand for a part's surface.
SURFACE = 1.0
# Seconds a query gives itself, of the 30 the supervisor allows: what is left undone is said.
BUDGET = 15.0
BATCH = 50_000
# A ray this near, in barycentric terms, to a triangle's edge is asked again along another axis.
GRAZE = 1e-9
# How far aside, mm, a point is asked from again when its ray grazed an edge: along no axis and no diagonal.
_ASIDE = np.array([0.7548776662, 0.5698402910, 0.4301597090]) * 1e-6
# No more points than this are told of the polylines of a scan in a plane.
MAX_OUTLINE_POINTS = 20_000


def run(name: str, shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    held = {} if kept is None else kept
    if name == "scan_clash":
        return clash(shapes, args, held)
    if name == "scan_deviation":
        return deviation(shapes, args, held)
    return outline(shapes, args, held)


# Inside or outside


def _grid(vertices: np.ndarray, triangles: np.ndarray, axis: int) -> dict[str, Any]:
    """The triangles of a mesh by the cells of a 2D grid across ``axis`` that each one's box touches."""
    u, v = [(1, 2), (2, 0), (0, 1)][axis]
    corners = vertices[triangles]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    det = (b[:, u] - a[:, u]) * (c[:, v] - a[:, v]) - (b[:, v] - a[:, v]) * (c[:, u] - a[:, u])
    # A triangle edge-on to the rays is crossed by none.
    seen = np.abs(det) > 1e-12
    a, b, c, det = a[seen], b[seen], c[seen], det[seen]
    low = np.minimum(np.minimum(a[:, [u, v]], b[:, [u, v]]), c[:, [u, v]])
    high = np.maximum(np.maximum(a[:, [u, v]], b[:, [u, v]]), c[:, [u, v]])
    origin = low.min(axis=0) if len(a) else np.zeros(2)
    extent = np.maximum(high.max(axis=0) - origin, 1e-9) if len(a) else np.ones(2)
    # About ten cells a triangle, and no more than four million pairs of a cell and a triangle.
    n = int(np.clip(np.sqrt(max(len(a), 1) * 10), 1, 1024))
    while True:
        cell = extent / n
        first = np.clip(((low - origin) / cell).astype(np.int64), 0, n - 1)
        last = np.clip(((high - origin) / cell).astype(np.int64), 0, n - 1)
        span = last - first + 1
        count = span[:, 0] * span[:, 1]
        if count.sum() <= 4_000_000 or n <= 8:
            break
        n //= 2
    owner = np.repeat(np.arange(len(a)), count)
    k = np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)
    wide = np.repeat(span[:, 1], count)
    cells = (np.repeat(first[:, 0], count) + k // wide) * n + np.repeat(first[:, 1], count) + k % wide
    order = np.argsort(cells, kind="stable")
    start = np.searchsorted(cells[order], np.arange(n * n + 1))
    return {"axis": axis, "a": a, "b": b, "c": c, "det": det, "origin": origin, "extent": extent, "cell": cell, "n": n, "owner": owner[order], "start": start}


def _crossings(points: np.ndarray, grid: dict[str, Any], chunk: int = 1_500_000) -> tuple[np.ndarray, np.ndarray]:
    """For each point: how many triangles a ray from it along +axis crosses, and whether it grazes an edge of one."""
    axis, n = grid["axis"], grid["n"]
    u, v = [(1, 2), (2, 0), (0, 1)][axis]
    flat = points[:, [u, v]]
    over = ((flat >= grid["origin"]) & (flat <= grid["origin"] + grid["extent"])).all(axis=1)
    at = np.clip(((flat - grid["origin"]) / grid["cell"]).astype(np.int64), 0, n - 1)
    cell = at[:, 0] * n + at[:, 1]
    per = np.where(over, grid["start"][cell + 1] - grid["start"][cell], 0)
    crossed = np.zeros(len(points), dtype=np.int64)
    grazed = np.zeros(len(points), dtype=bool)
    ends = np.cumsum(per)
    first = 0
    while first < len(points):
        # As many points at a time as have about `chunk` triangles to look at between them.
        last = max(int(np.searchsorted(ends, (ends[first - 1] if first else 0) + chunk, side="right")), first + 1)
        count = per[first:last]
        if count.sum():
            point = np.repeat(np.arange(first, last), count)
            k = np.arange(len(point)) - np.repeat(np.cumsum(count) - count, count)
            triangle = grid["owner"][np.repeat(grid["start"][cell[first:last]], count) + k]
            a, b, c = grid["a"][triangle], grid["b"][triangle], grid["c"][triangle]
            pu, pv = points[point, u] - a[:, u], points[point, v] - a[:, v]
            det = grid["det"][triangle]
            s = (pu * (c[:, v] - a[:, v]) - pv * (c[:, u] - a[:, u])) / det
            t = ((b[:, u] - a[:, u]) * pv - (b[:, v] - a[:, v]) * pu) / det
            r = 1 - s - t
            above = a[:, axis] + s * (b[:, axis] - a[:, axis]) + t * (c[:, axis] - a[:, axis]) > points[point, axis]
            hit = (s >= 0) & (t >= 0) & (r >= 0) & above
            edge = (np.minimum(np.minimum(np.abs(s), np.abs(t)), np.abs(r)) < GRAZE) & (s > -GRAZE) & (t > -GRAZE) & (r > -GRAZE) & above
            crossed += np.bincount(point[hit], minlength=len(points))
            grazed |= np.bincount(point[edge], minlength=len(points)) > 0
        first = last
    return crossed, grazed


def inside(points: np.ndarray, vertices: np.ndarray, triangles: np.ndarray, grids: dict[int, Any] | None = None) -> np.ndarray:
    """Whether each point is inside a closed mesh: a ray from it along +Z crosses the mesh an odd number of times.

    A point whose ray passes through an edge of a triangle, where a crossing
    may be counted twice or not at all, is asked again from a millionth of a
    millimetre aside, then along +X, then along +Y, each from a little further
    aside: a point that near the surface may be said to be on either side of
    it. ``grids`` keeps what was worked out of the mesh from one call to the
    next. A mesh that is not closed has no inside, and what this says of it
    means nothing.
    """
    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    vertices = np.asarray(vertices, dtype=np.float64)
    triangles = np.asarray(triangles, dtype=np.int64)
    grids = {} if grids is None else grids
    answer = np.zeros(len(points), dtype=bool)
    asked = np.arange(len(points))
    for attempt, axis in enumerate((2, 2, 0, 1)):
        if len(asked) == 0:
            break
        if axis not in grids:
            grids[axis] = _grid(vertices, triangles, axis)
        crossed, grazed = _crossings(points[asked] + attempt * _ASIDE, grids[axis])
        answer[asked] = (crossed & 1) == 1
        asked = asked[grazed]
    return answer


def clusters(points: np.ndarray, cell: float = CELL) -> np.ndarray:
    """A number for each point, the same for points whose cells of ``cell`` mm touch (by a face, an edge or a corner).

    The clusters are numbered from 0 by size, the largest first.
    """
    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if len(points) == 0:
        return np.zeros(0, dtype=np.int64)
    cells = np.floor(points / cell).astype(np.int64)
    cells -= cells.min(axis=0)
    span = cells.max(axis=0) + 3
    key = ((cells[:, 0] + 1) * span[1] + cells[:, 1] + 1) * span[2] + cells[:, 2] + 1
    filled, of = np.unique(key, return_inverse=True)
    of = of.reshape(-1)
    pairs = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                beside = filled + (dx * span[1] + dy) * span[2] + dz
                at = np.minimum(np.searchsorted(filled, beside), len(filled) - 1)
                there = filled[at] == beside
                pairs.append(np.stack([np.flatnonzero(there), at[there]], axis=1))
    pairs = np.concatenate(pairs)
    label = np.arange(len(filled))
    while True:
        # Every filled cell takes the least label among itself and its neighbours, until none changes.
        least = label.copy()
        np.minimum.at(least, pairs[:, 0], label[pairs[:, 1]])
        least = least[least]
        if np.array_equal(least, label):
            break
        label = least
    _, numbered, sizes = np.unique(label, return_inverse=True, return_counts=True)
    points_in = np.bincount(numbered[of], minlength=len(sizes))
    by_size = np.argsort(-points_in, kind="stable")
    rank = np.empty(len(by_size), dtype=np.int64)
    rank[by_size] = np.arange(len(by_size))
    return rank[numbered[of]]


# Distances


def sampled(vertices: np.ndarray, triangles: np.ndarray, spacing: float = SURFACE) -> tuple[np.ndarray, np.ndarray]:
    """Points on a mesh no further apart than about ``spacing``, and the triangle each is on.

    Each triangle gets a grid along two of its sides, as fine as each side
    needs, so a long thin triangle is not sampled as a large one would be.
    """
    corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64)]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    nu = np.clip(np.ceil(np.linalg.norm(b - a, axis=1) / spacing).astype(np.int64), 1, 512)
    nv = np.clip(np.ceil(np.linalg.norm(c - a, axis=1) / spacing).astype(np.int64), 1, 512)
    count = (nu + 1) * (nv + 1)
    owner = np.repeat(np.arange(len(a)), count)
    k = np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)
    wide = np.repeat(nv + 1, count)
    s = (k // wide) / np.repeat(nu, count)
    t = (k % wide) / np.repeat(nv, count)
    on = s + t <= 1 + 1e-9
    owner, s, t = owner[on], s[on], t[on]
    return a[owner] * (1 - s - t)[:, None] + b[owner] * s[:, None] + c[owner] * t[:, None], owner


def to_triangles(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """How far each point ``p[i]`` is from the triangle ``a[i] b[i] c[i]``, and the point of the triangle nearest to it."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(axis=1), (ac * ap).sum(axis=1)
    bp = p - b
    d3, d4 = (ab * bp).sum(axis=1), (ac * bp).sum(axis=1)
    cp = p - c
    d5, d6 = (ab * cp).sum(axis=1), (ac * cp).sum(axis=1)
    va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
    with np.errstate(divide="ignore", invalid="ignore"):
        whole = va + vb + vc
        # Over the face, unless one of the cases below says an edge or a corner is nearer.
        near = a + ab * (vb / whole)[:, None] + ac * (vc / whole)[:, None]
        near = np.where(((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[:, None], b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)))[:, None], near)
        near = np.where(((vb <= 0) & (d2 >= 0) & (d6 <= 0))[:, None], a + ac * (d2 / (d2 - d6))[:, None], near)
        near = np.where(((vc <= 0) & (d1 >= 0) & (d3 <= 0))[:, None], a + ab * (d1 / (d1 - d3))[:, None], near)
    near = np.where(((d6 >= 0) & (d5 <= d6))[:, None], c, near)
    near = np.where(((d3 >= 0) & (d4 <= d3))[:, None], b, near)
    near = np.where(((d1 <= 0) & (d2 <= 0))[:, None], a, near)
    # A triangle with no area is its first corner.
    near = np.where(np.isfinite(near), near, a)
    return np.linalg.norm(p - near, axis=1), near


def _tree(points: np.ndarray) -> Any:
    """A KD-tree over points. scipy comes with build123d; the worker loads it when a scan is first asked about."""
    try:
        from scipy.spatial import cKDTree
    except ImportError as e:
        raise QueryError("bad_request", "checks against a scan need scipy, which build123d brings: it is not in this workspace's environment") from e
    # Not scipy's defaults: on points that lie in sheets they make a tree that takes seconds to ask (E2).
    return cKDTree(points, balanced_tree=False, compact_nodes=False)


# What is asked


def _number(value: Any, default: float, least: float, most: float, name: str) -> float:
    if value is None:
        return default
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not least <= value <= most:
        raise QueryError("bad_request", f"{name} is a number from {least:g} to {most:g}")
    return float(value)


def _part(shapes: dict[str, Any], args: dict[str, Any]) -> tuple[str, str, Any, str]:
    layout, part = args.get("layout"), args.get("part")
    if not isinstance(layout, str) or not isinstance(part, str):
        raise QueryError("bad_request", "a scan query needs args.layout and args.part, the name of a part of it, both strings")
    return layout, part, need_part(shapes, layout, part), f"{layout}:{part}"


class _Scan:
    """A scan where its transform puts it: the points in the object frame, the triangles, and which vertices count."""

    def __init__(self, said: Any) -> None:
        if not isinstance(said, dict) or not isinstance(said.get("path"), str) or not isinstance(said.get("id"), str):
            raise QueryError("bad_request", "a scan query needs args.scan, with id and path, both strings, and transform")
        self.id = said["id"]
        try:
            vertices, self.triangles, _ = scanfile.read_bin(said["path"])
        except (OSError, ValueError) as e:
            raise QueryError("bad_request", f"the mesh of {self.id} could not be read: {e}") from e
        transform = said.get("transform")
        t, q, s = (transform or {}).get("t"), (transform or {}).get("q"), (transform or {}).get("s", 1)
        numbers = [*(t if isinstance(t, list) else []), *(q if isinstance(q, list) else []), s]
        fine = len(numbers) == 8 and all(isinstance(n, (int, float)) and not isinstance(n, bool) and np.isfinite(n) for n in numbers)
        if not fine or not s > 0 or not any(q):
            raise QueryError("bad_request", f"the transform of {self.id} is not one: t is three numbers, q four that are not all zero, s more than zero")
        turn = tess._rotation([float(c) / float(np.linalg.norm(q)) for c in q])
        self.points = vertices.astype(np.float64) @ turn.T * float(s) + np.array(t, dtype=np.float64)
        self.counts = np.ones(len(vertices), dtype=bool)
        only, ignore = said.get("only"), said.get("ignore") or []
        try:
            if only is not None:
                self.counts = self._of(scanfile.read_mask(only, len(self.triangles)))
            for path in ignore:
                self.counts &= ~self._of(scanfile.read_mask(path, len(self.triangles)))
        except (OSError, ValueError, TypeError) as e:
            raise QueryError("bad_request", f"a region of {self.id} could not be read: {e}") from e

    def _of(self, mask: np.ndarray) -> np.ndarray:
        """The vertices of the triangles a region has."""
        vertices = np.zeros(len(self.points), dtype=bool)
        vertices[self.triangles[mask].reshape(-1)] = True
        return vertices


def _scan(args: dict[str, Any], kept: dict[Any, Any]) -> _Scan:
    """The scan a query names, read once for as long as its file and what is asked of it are the same."""
    said = args.get("scan")
    try:
        stat = os.stat(said["path"])
        which = (said["path"], stat.st_mtime_ns, stat.st_size, repr(said.get("transform")), repr(said.get("only")), repr(said.get("ignore")))
    except (TypeError, KeyError, OSError):
        which = None
    if which is None or kept.get("scan", (None, None))[0] != which:
        # One scan at a time is kept: Micra's points and triangles are 40 MB.
        kept["scan"] = (which, _Scan(said))
    return kept["scan"][1]


def _mesh(shape: Any, key: str, kept: dict[Any, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The mesh a part is drawn with, and how many of its triangles each face has: worked out once."""
    if ("scan mesh", key) not in kept:
        kept["scan mesh", key] = tess.mesh_faces(shape)
    return kept["scan mesh", key]


def _surface_tree(vertices: np.ndarray, triangles: np.ndarray, key: str, kept: dict[Any, Any]) -> tuple[Any, np.ndarray, np.ndarray]:
    """A tree over the part's mesh sampled every millimetre, the samples, and the triangle each is on."""
    if ("scan surface", key) not in kept:
        points, owner = sampled(vertices, triangles)
        kept["scan surface", key] = (_tree(points), points, owner)
    return kept["scan surface", key]


def _brep(shape: Any, part: str, key: str, kept: dict[Any, Any]) -> _Surface:
    """What ``nearest`` keeps of a part, kept where it keeps it."""
    if key not in kept:
        kept[key] = _Surface(shape)
    return kept[key]


def _xyz(point: Any) -> list[float]:
    return [float(c) + 0.0 for c in point]


def _box(points: np.ndarray) -> dict[str, list[float]]:
    return {"min": _xyz(points.min(axis=0)), "max": _xyz(points.max(axis=0))}


def _face_of(per_face: np.ndarray, triangle: int) -> int:
    """The face a triangle of the part's mesh belongs to."""
    return int(np.searchsorted(np.cumsum(per_face), triangle, side="right"))


# scan_clash


def clash(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    started = time.monotonic()
    layout, part, shape, key = _part(shapes, args)
    if not topo.solids(shape):
        raise QueryError("bad_request", f"{part} is not a solid: nothing is inside it; scan_deviation says how far it is from the scan")
    margin = _number(args.get("margin"), 5.0, 0.0, 50.0, "margin")
    scan = _scan(args, kept)
    vertices, triangles, _ = _mesh(shape, key, kept)
    low, high = vertices.min(axis=0) - margin, vertices.max(axis=0) + margin
    near = np.flatnonzero(((scan.points >= low) & (scan.points <= high)).all(axis=1))
    ignored = int((~scan.counts[near]).sum())
    near = near[scan.counts[near]]
    every = max(1, -(-len(near) // MAX_CANDIDATES))
    checked = near[::every]
    grids = kept.setdefault(("scan grids", key), {})
    within = np.zeros(len(checked), dtype=bool)
    done = 0
    while done < len(checked) and time.monotonic() - started <= BUDGET:
        within[done : done + BATCH] = inside(scan.points[checked[done : done + BATCH]], vertices, triangles, grids)
        done = min(done + BATCH, len(checked))
    partial = done < len(checked)
    checked, within = checked[:done], within[:done]
    points = scan.points[checked]
    tree, _, _ = _surface_tree(vertices, triangles, key, kept)
    distance = tree.query(points)[0] if len(points) else np.zeros(0)
    surface = _brep(shape, part, key, kept)
    retaken = 0

    def taken_again(candidates: np.ndarray, deepest: bool) -> dict[str, Any] | None:
        """Of a few scan points, the one deepest in the part or nearest to it by the B-rep, with what it is under."""
        nonlocal retaken
        best = None
        for n in candidates:
            if retaken >= MAX_RETAKEN:
                break
            retaken += 1
            try:
                found = surface.nearest(part, key, _xyz(points[n]))
            except QueryError:
                continue
            if best is None or (found["distance"] > best[1]["distance"]) == deepest:
                best = (n, found)
        return None if best is None else {"at": _xyz(points[best[0]]), "on": best[1]["point"], "face": best[1]["ref"], "distance": best[1]["distance"]}

    inner = np.flatnonzero(within)
    label = clusters(points[inner])
    count = int(label.max()) + 1 if len(inner) else 0
    told = []
    for number in range(min(count, MAX_CLUSTERS)):
        members = inner[label == number]
        deep = taken_again(members[np.argsort(-distance[members])[:2]], True)
        told.append(
            {
                "count": len(members),
                "centre": _xyz(points[members].mean(axis=0)),
                "bbox": _box(points[members]),
                **({} if deep is None else {"depth": deep["distance"], "at": deep["at"], "under": deep["face"]}),
            }
        )
    deepest = taken_again(inner[np.argsort(-distance[inner])[:3]], True)
    for one in told:
        if "depth" in one and (deepest is None or one["depth"] > deepest["distance"]):
            deepest = {"distance": one["depth"], "at": one["at"], "face": one["under"]}
    outer = np.flatnonzero(~within)
    nearest = taken_again(outer[np.argsort(distance[outer])[:3]], False)
    # Triangles of the scan with a corner inside the part and a corner outside it go through its surface.
    place = np.full(len(scan.points), -1, dtype=np.int64)
    place[checked] = np.arange(len(checked))
    corners = place[scan.triangles[(place[scan.triangles[:, 0]] >= 0)]]
    corners = corners[(corners >= 0).all(axis=1)]
    sides = within[corners]
    crossing = int((sides.any(axis=1) & ~sides.all(axis=1)).sum()) if len(corners) else 0
    return {
        "part": part,
        "scan": scan.id,
        "points": {"scan": len(scan.points), "candidates": len(near), "checked": len(checked), "ignored": ignored},
        "inside": {"count": len(inner), "crossing": crossing, "clusters": told, "clustersOmitted": max(0, count - MAX_CLUSTERS)},
        "deepest": None if deepest is None else {"depth": deepest["distance"], "at": deepest["at"], "under": deepest["face"]},
        "nearest": None if nearest is None else {"distance": nearest["distance"], "at": nearest["at"], "on": nearest["on"], "face": nearest["face"]},
        "sampling": {
            "every": every,
            "cell": CELL,
            "surface": SURFACE,
            "deflection": kept.get(("deflection", key), tess.DEVIATION),
            "retaken": retaken,
            "partial": partial,
            "seconds": round(time.monotonic() - started, 2),
        },
        "how": "scan vertices inside the part, by ray parity on the mesh the part is drawn with; each depth and distance told is from that scan point to the part's B-rep",
        "exact": False,
    }


# scan_deviation


def _stats(distance: np.ndarray) -> dict[str, float]:
    p50, p90, p95 = (float(x) for x in np.percentile(distance, [50, 90, 95]))
    return {
        "min": float(distance.min()),
        "mean": float(distance.mean()),
        "max": float(distance.max()),
        "rms": float(np.sqrt((distance**2).mean())),
        "p50": p50,
        "p90": p90,
        "p95": p95,
    }


def _to_scan(samples: np.ndarray, scan: _Scan, within: float) -> tuple[np.ndarray, np.ndarray]:
    """How far each sample is from the scan's surface, and the point of it that is nearest: infinity where nothing is within ``within``."""
    low, high = samples.min(axis=0) - within, samples.max(axis=0) + within
    near = np.flatnonzero(scan.counts & ((scan.points >= low) & (scan.points <= high)).all(axis=1))
    far = np.full(len(samples), np.inf)
    if len(near) == 0:
        return far, samples.copy()
    points = scan.points[near]
    place = np.full(len(scan.points), -1, dtype=np.int64)
    place[near] = np.arange(len(near))
    corners = place[scan.triangles]
    corners = corners[(corners >= 0).all(axis=1)]
    # For each scan vertex, the triangles it is a corner of.
    order = np.argsort(corners.reshape(-1), kind="stable")
    of = order // 3
    start = np.searchsorted(corners.reshape(-1)[order], np.arange(len(near) + 1))
    apart, beside = _tree(points).query(samples, k=min(4, len(near)))
    apart, beside = apart.reshape(len(samples), -1), beside.reshape(len(samples), -1)
    best, at = apart[:, 0].copy(), points[beside[:, 0]].copy()
    for column in range(beside.shape[1]):
        vertex = beside[:, column]
        count = start[vertex + 1] - start[vertex]
        sample = np.repeat(np.arange(len(samples)), count)
        k = np.arange(len(sample)) - np.repeat(np.cumsum(count) - count, count)
        triangle = corners[of[np.repeat(start[vertex], count) + k]]
        distance, nearest = to_triangles(samples[sample], points[triangle[:, 0]], points[triangle[:, 1]], points[triangle[:, 2]])
        # The nearest triangle of each sample: the smallest distance first, and the first of each sample taken.
        ranked = np.lexsort((distance, sample))
        first = ranked[np.unique(sample[ranked], return_index=True)[1]]
        better = distance[first] < best[sample[first]]
        best[sample[first][better]] = distance[first][better]
        at[sample[first][better]] = nearest[first][better]
    best[best > within] = np.inf
    return best, at


def deviation(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    started = time.monotonic()
    layout, part, shape, key = _part(shapes, args)
    source = args.get("from", "part")
    if source not in ("part", "scan"):
        raise QueryError("bad_request", "from is part (points of the part, to the scan) or scan (points of the scan, to the part)")
    within = _number(args.get("within"), 50.0, 0.1, 1000.0, "within")
    wanted = int(_number(args.get("samples"), 20_000, 100, 100_000, "samples"))
    scan = _scan(args, kept)
    vertices, triangles, per_face = _mesh(shape, key, kept)
    faces = args.get("faces")
    chosen = np.ones(len(triangles), dtype=bool)
    if faces is not None:
        if not isinstance(faces, list) or not faces or not all(isinstance(f, int) and not isinstance(f, bool) and 0 <= f < len(per_face) for f in faces):
            raise QueryError("bad_ref", f"faces are numbers of faces of {part}, which has {len(per_face)}: F0 to F{len(per_face) - 1}")
        ends = np.cumsum(per_face)
        chosen[:] = False
        for face in faces:
            chosen[ends[face] - per_face[face] : ends[face]] = True
    solid = bool(topo.solids(shape))
    grids = kept.setdefault(("scan grids", key), {})
    surface = _brep(shape, part, key, kept)
    numbers = np.flatnonzero(chosen)
    if source == "part":
        points, owner = sampled(vertices, triangles[chosen])
        some = np.unique(np.linspace(0, len(points) - 1, min(wanted, len(points))).astype(np.int64))
        points, owner = points[some], numbers[owner[some]]
        distance, other = _to_scan(points, scan, within)
        how = f"from {len(points):,} points of the part's mesh to the scan's triangles"
    else:
        if faces is None:
            tree, _, on_triangle = _surface_tree(vertices, triangles, key, kept)
        else:
            on_points, on_triangle = sampled(vertices, triangles[chosen])
            tree, on_triangle = _tree(on_points), numbers[on_triangle]
        low, high = vertices[triangles[chosen]].reshape(-1, 3).min(axis=0) - within, vertices[triangles[chosen]].reshape(-1, 3).max(axis=0) + within
        near = np.flatnonzero(scan.counts & ((scan.points >= low) & (scan.points <= high)).all(axis=1))
        near = near[np.unique(np.linspace(0, len(near) - 1, min(wanted, len(near))).astype(np.int64))] if len(near) else near
        points = other = scan.points[near]
        distance, sample = tree.query(points, distance_upper_bound=within) if len(points) else (np.zeros(0), np.zeros(0, dtype=np.int64))
        owner = on_triangle[np.minimum(sample, len(on_triangle) - 1)]
        how = f"from {len(points):,} vertices of the scan to the part's mesh sampled every {SURFACE:g} mm"
    compared = np.isfinite(distance)
    said: dict[str, Any] = {"part": part, "faces": faces, "scan": scan.id, "from": source, "samples": len(points), "compared": int(compared.sum()), "beyond": int((~compared).sum())}
    if not compared.any():
        return {**said, "distance": None, "signed": None, "worst": None, "sampling": _sampling(key, kept, started), "how": f"{how}; nothing of the scan is within {within:g} mm", "exact": False}
    signed = None
    if solid:
        # The side is the scan's: where the scan's own point is inside the part, the distance counts as negative.
        scan_inside = inside(other[compared], vertices, triangles, grids)
        signs = np.where(scan_inside, -1.0, 1.0) * distance[compared]
        signed = {"min": float(signs.min()), "mean": float(signs.mean()), "max": float(signs.max()), "inside": int(scan_inside.sum())}
    worst = int(np.flatnonzero(compared)[np.argmax(distance[compared])])
    told = {"distance": float(distance[worst]), "at": _xyz(points[worst]), "on": _xyz(other[worst]), "face": f"{part}/F{_face_of(per_face, int(owner[worst]))}"}
    if source == "scan":
        # One point of the scan, taken again on the B-rep: that distance is the part's own.
        try:
            found = surface.nearest(part, key, _xyz(points[worst]))
            told = {"distance": found["distance"], "at": _xyz(points[worst]), "on": found["point"], "face": found["ref"]}
        except QueryError:
            pass
    return {
        **said,
        "distance": _stats(distance[compared]),
        "signed": signed,
        "worst": told,
        "sampling": _sampling(key, kept, started),
        "how": f"{how}; + where the scan is outside the part, − where it is inside" if solid else how,
        "exact": False,
    }


def _sampling(key: str, kept: dict[Any, Any], started: float) -> dict[str, Any]:
    return {"surface": SURFACE, "deflection": kept.get(("deflection", key), tess.DEVIATION), "partial": False, "seconds": round(time.monotonic() - started, 2)}


# scan_section


def outline(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    """Where a plane cuts a scan: polylines in the plane's own axes, as ``section`` gives a part's loops."""
    from .section import _Frame

    plane = args.get("plane")
    origin, normal = (plane or {}).get("origin") if isinstance(plane, dict) else None, (plane or {}).get("normal") if isinstance(plane, dict) else None
    fine = all(isinstance(v, list) and len(v) == 3 and all(isinstance(c, (int, float)) and not isinstance(c, bool) and np.isfinite(c) for c in v) for v in (origin, normal))
    if not fine or not any(normal):
        raise QueryError("bad_request", "scan_section needs args.plane, with origin and normal, three numbers each, the normal not all zeros")
    scan = _scan(args, kept)
    frame = _Frame(np.array(origin, dtype=np.float64), np.array(normal, dtype=np.float64) / np.linalg.norm(normal))
    side = (scan.points - frame.origin) @ frame.normal >= 0
    corners = scan.triangles[scan.counts[scan.triangles].all(axis=1)]
    corners = corners[side[corners].any(axis=1) & ~side[corners].all(axis=1)]
    # The corner that is alone on its side of the plane: the two edges from it go through the plane.
    alone = np.where(side[corners[:, 0]] != side[corners[:, 1]], np.where(side[corners[:, 0]] != side[corners[:, 2]], 0, 1), 2)
    rows = np.arange(len(corners))
    tip, left, right = corners[rows, alone], corners[rows, (alone + 1) % 3], corners[rows, (alone + 2) % 3]
    height = (scan.points - frame.origin) @ frame.normal

    def through(one: np.ndarray, other: np.ndarray) -> np.ndarray:
        share = (height[one] / (height[one] - height[other]))[:, None]
        return frame.flat(scan.points[one] + (scan.points[other] - scan.points[one]) * share)

    ends = np.stack([through(tip, left), through(tip, right)], axis=1)
    # Two segments meet where they cross the same edge of the scan: an edge is its two vertices, least first.
    edges = np.stack([np.minimum(tip, left) * len(scan.points) + np.maximum(tip, left), np.minimum(tip, right) * len(scan.points) + np.maximum(tip, right)], axis=1)
    at: dict[int, list[int]] = {}
    for segment, (one, other) in enumerate(edges.tolist()):
        at.setdefault(one, []).append(segment)
        at.setdefault(other, []).append(segment)
    unused = np.ones(len(edges), dtype=bool)
    lines = []
    for segment in range(len(edges)):
        if not unused[segment]:
            continue
        unused[segment] = False
        chain = [ends[segment, 0], ends[segment, 1]]
        closed = False
        for forwards in (True, False):
            edge = int(edges[segment, 1 if forwards else 0])
            while True:
                onward = [s for s in at[edge] if unused[s]]
                if not onward:
                    closed = closed or (forwards and edge == int(edges[segment, 0]))
                    break
                following = onward[0]
                unused[following] = False
                first = int(edges[following, 0]) == edge
                edge = int(edges[following, 1 if first else 0])
                point = ends[following, 1 if first else 0]
                chain.append(point) if forwards else chain.insert(0, point)
            if closed:
                break
        points = np.array(chain)
        if closed:
            points = points[:-1]
        lines.append((float(np.linalg.norm(np.diff(np.array(chain), axis=0), axis=1).sum()), closed, points))
    lines.sort(key=lambda line: -line[0])
    told, room = [], MAX_OUTLINE_POINTS
    for _, closed, points in lines:
        if len(points) > room:
            break
        room -= len(points)
        told.append({"points": [[float(u) + 0.0, float(v) + 0.0] for u, v in points], "closed": closed})
    every = np.concatenate([line[2] for line in lines[: len(told)]]) if told else None
    return {
        "scan": scan.id,
        "plane": {"origin": _xyz(frame.origin), "normal": _xyz(frame.normal), "x": _xyz(frame.x), "y": _xyz(frame.y)},
        "polylines": told,
        "omitted": len(lines) - len(told),
        "segments": len(edges),
        "bounds": None if every is None else {"min": [float(c) for c in every.min(axis=0)], "max": [float(c) for c in every.max(axis=0)]},
        "exact": False,
    }
```

Run: `(cd kernel && uv run pytest -q tests/test_scanclash.py)` Expected: PASS, 17 tests, in about 5 s.

- [ ] **Step 4: One test over the wire**

In `kernel/tests/test_supervisor.py`, after `test_measure_over_the_protocol_for_the_object_asked`:

```python
def test_scan_clash_over_the_protocol_for_the_object_asked(fresh, ws, tmp_path):
    import scanfix

    from torno_kernel import scanfile

    vertices, triangles = scanfix.grid(20)
    scanfile.write_bin(tmp_path / "S1.bin", vertices + [0, 0, 1], triangles)
    scan = {"id": "S1", "path": str(tmp_path / "S1.bin"), "transform": {"t": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1}}
    reply, _ = fresh.build(ws / "hollow", "hollow.py")
    assert reply["ok"], reply
    build_bracket(fresh, ws)
    # The sheet lies in the tub's floor, 2 mm thick from z = 0: each of its 400 vertices is 1 mm deep.
    floor = fresh.query(ws / "hollow", "scan_clash", {"layout": "assembly", "part": "tub", "scan": scan})
    assert floor["ok"] is True, floor
    assert floor["result"]["inside"]["count"] == 400 and floor["result"]["exact"] is False
    assert floor["result"]["deepest"]["depth"] == pytest.approx(1, abs=1e-9)
    # The bracket built last; each object is asked of its own worker.
    base = fresh.query(ws / "bracket", "scan_clash", {"layout": "assembly", "part": "base", "scan": scan})
    assert base["result"]["part"] == "base" and base["result"]["inside"]["count"] == 400
    # A scan that cannot be read is that query's failure: the worker goes on answering.
    gone = fresh.query(ws / "hollow", "scan_clash", {"layout": "assembly", "part": "tub", "scan": {**scan, "path": str(tmp_path / "gone.bin")}})
    assert gone["ok"] is False and gone["error"]["kind"] == "bad_request"
    assert fresh.query(ws / "hollow", "describe", {"ref": "assembly:tub"})["ok"] is True
```

Run: `(cd kernel && uv run pytest -q)` Expected: the whole kernel suite passes.

- [ ] **Step 5: Commit**

```bash
git add kernel/src/torno_kernel/scanclash.py kernel/src/torno_kernel/queries.py kernel/src/torno_kernel/tess.py kernel/tests/test_scanclash.py kernel/tests/test_queries.py kernel/tests/test_supervisor.py
git commit -m "Kernel: which scan points are inside a part, how far a part lies from a scan, and where a plane cuts one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The agent's tools for scans

**Files:**
- Create: `app/src/main/mcp/scanTools.ts`, `scanTools.test.ts`, `app/src/renderer/viewport/scanDeviation.ts`, `scanDeviation.test.ts`
- Modify: `app/src/main/mcp/tools.ts` (`ToolDeps`, schemas, descriptions, registration, `scene`, `look`, `show`), `tools.test.ts`, `mcp/markTools.ts` (`EndArg`, `endsOf`), `mcp/readTools.ts` (`measure` with a scan end, `section` with `scan`), `readTools.test.ts`, `app/src/main/index.ts` (`toolDeps`), `app/src/main/context.ts`, `context.test.ts`, `app/src/main/prompt.ts`, `prompt.test.ts`, `app/src/shared/geometry.ts` (reply types), `app/src/shared/view.ts`, `app/src/renderer/state/agent.ts`, `state/store.ts` (`showForAgent` with scans), `ui/ViewportPane.tsx` (`look` with `scans` and `scanColour`), `viewport/picture.ts`, `viewport/overlay.ts` (the legend), `viewport/sectionDrawing.ts`, `styles/tokens.css`, `app/src/main/mcp/server.itest.ts`, `app/e2e/mcp.spec.ts`

**Interfaces:**
- Consumes: the kernel's `scan_clash`, `scan_deviation`, `scan_section` (Task 6); `ScanStore.list`, `.paths` (Task 2); `alignmentOf`, `alignmentText`, `staleText`, `importText` (`shared/scans.ts`); `apply` (`shared/align.ts`); `isMoved` (`main/marks/spread.ts`); `ofBuild`, `built`, `layoutFor`, `failure`, `checkRef`, `ofOneBuild`'s pattern, `clean`, `thinned` (`mcp/tools.ts`, `markTools.ts`, `readTools.ts`); `LookRequest.scans`, `ImageRequest.scans` (Task 3).
- Produces:

```ts
// mcp/tools.ts
export interface ToolDeps {
  /* as now, and: */
  scans(objectId: string): Promise<ScanInfo[]>
  /** Where a scan's mesh and a region's mask are on the disk, for the kernel. */
  scanPaths(objectId: string, id: string): { mesh: string; mask(markId: string): string } | undefined
  query<T = unknown>(objectId: string, name: 'measure' | 'section' | 'check' | 'scan_clash' | 'scan_deviation' | 'scan_section', args: object): Promise<T>
}

// mcp/scanTools.ts
export const SCAN_APPROXIMATE = 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact'
export const PRINT_NOTE = 'layout print poses the parts for the bed: a part is where it is mounted only if the model leaves it there'
export interface ScansArgs { layout?: string }
export interface ScanClashArgs { part: string; scan?: string; ignore?: string[]; margin?: number; layout?: string }
export interface ScanDeviationArgs { part: string; faces?: string[]; scan?: string; region?: string; from?: 'part' | 'scan'; within?: number; layout?: string }
/** A scan as a tool tells it in a layout: how it is aligned there, and whether that may no longer hold. */
export function alignmentData(scan: ScanInfo, layout: string): { state: 'aligned' | 'not aligned'; by?: string; steps?: AlignStep[]; pairs?: number; rms?: number; worst?: number; scaled?: boolean; stale?: string }
/** The scan a tool is asked about, aligned in the layout, as the kernel is given it; or the refusal. */
export function scanFor(deps: ToolDeps, objectId: string, layout: string, asked: string | undefined): Promise<{ scan: ScanInfo; alignment: ScanAlignment; wire: { id: string; path: string; transform: ScanTransform } } | ToolResult>
/** Why a part cannot be checked against a scan where torno moved it, in full, or null. */
export function scanSpread(scene: Scene, layout: string, part: string): string | null
export function scansTool(deps: ToolDeps, objectId: string, args: ScansArgs): Promise<ToolResult>
export function scanClashTool(deps: ToolDeps, objectId: string, args: ScanClashArgs): Promise<ToolResult>
export function scanDeviationTool(deps: ToolDeps, objectId: string, args: ScanDeviationArgs): Promise<ToolResult>
export function clashReading(part: string, layout: string, revision: number, scan: ScanInfo, alignment: ScanAlignment, said: ScanClashed): string
export function deviationReading(of: string, layout: string, revision: number, scan: ScanInfo, said: ScanDeviated): string

// mcp/markTools.ts
export type EndArg = string | { ref?: string; point?: Vec3 } | { scan: string; point: Vec3 }
export interface End { /* as now */; scan?: string /* the end is a point of this scan, or the centroid of a region of it */ }

// shared/geometry.ts: ScanClashed, ScanDeviated, ScanSectioned, the kernel's replies as "Shared contracts" gives them.

// viewport/scanDeviation.ts
export type Rgb = [number, number, number]
/** The colour of a scan vertex `distance` mm from a part: `near` at 0, `far` at `range` and beyond, `inside` when it is in the part. */
export function deviationColour(distance: number, inside: boolean, range: number, colours: { near: Rgb; far: Rgb; inside: Rgb }): Rgb
/** The most scan vertices near a part that a picture colours. */
export const MAX_COLOURED = 300_000
/** Colours for every vertex of a scan by its distance to a part's mesh, as a `color` attribute's array; throws when more than `MAX_COLOURED` are within `range` of the part. */
export function deviationColours(scan: BuiltScan, part: BuiltPart, range: number, colours: { near: Rgb; far: Rgb; inside: Rgb }): Uint16Array
```

**The tools** (schemas in `mcp/tools.ts`, with these descriptions):

- `scans`, input `{ layout?: string }`:
  "Returns JSON and a reading of the scans the user imported into this object: each with its number (S1), name, source file and whether that is still there, triangle count, size in mm with the unit and up axis it was read with, whether it is on screen and how see-through, its regions, and how it is aligned in the layout: by a floor, by pairs of points with their rms, by hand, or not at all, with a stale note when the model has moved under it since. A scan is a mesh of the real surroundings, good to a few millimetres at best: nothing from it is exact. Call it before any check against a scan."
- `scan_clash`, input `{ part: string, scan?: string, ignore?: string[], margin?: number (0 to 50, default 5), layout?: string }`:
  "Returns JSON and a reading of what of a scan is inside a part of the last build: how many scan points, in which clusters (centre, box, count), the deepest of each with its depth and the face it is under, how many scan triangles cross the part's surface, and the scan point nearest to the part outside it. Counts are of scan vertices, decided on the mesh the part is drawn with; each depth and distance told is from that scan point to the part's B-rep. Approximate by nature: the scan is, and so is its alignment, whose rms the reply gives. ignore leaves out regions by mark number. Refused where the scan is not aligned, and for a part torno moved for display. Use it instead of a script that loads the scan."
- `scan_deviation`, input `{ part: string, faces?: string[] (refs of faces of that part), scan?: string, region?: string (a region mark: only that part of the scan), from?: 'part' | 'scan' (default part), within?: number (0.1 to 1000, default 50), layout?: string }`:
  "Returns JSON and a reading of how far a part, or some of its faces, lie from a scan: min, mean, max, rms and percentiles in mm over up to 20,000 sample points, signed where the part is a solid (+ where the scan is outside it, − where it is inside), the worst place, and how many samples had no scan within reach. from part samples the part and measures to the scan's triangles; from scan measures from the scan's vertices (of a region, if one is given) to the part. Approximate. Use it to judge an alignment against a reference part the scan contains, or how close the surroundings come to a face."
- `measure`: an end may also be `{"scan": "S1", "point": [x, y, z]}` (a point of the scan, in the frame of the layout, as `scan_clash` and `scan_deviation` give them) or the number of a region mark (its centroid). Only `distance` takes one. The reply then has `exact: false`, `approximate` and `≈`.
- `look`: `scans?: boolean | string[]` ("Which scans are drawn: true or absent, those on the user's screen; false, none; or their numbers.") and `scanColour?: { part: string, scan?: string, range?: number }` ("Colours one scan by its distance to a part, from 0 to range mm (default 20), with scan points inside the part marked: a picture for the eye, made from the meshes on screen; the numbers are scan_deviation's.").
- `show`: `scans?: string[]` (those left switched on; the others are hidden) and `scanOpacity?: number` (0.05 to 1, of those left on). For now only, never saved.
- `section`: `scan?: string`: the scan's polylines in the plane are added to the drawing as a hairline and to the JSON under `scan`, thinned to 2,000 points, with `exact: false`.
- `scene`: gains `scans: [{ id, name, triangles, aligned: boolean }]` (aligned in the layout it answers for) and, when there are any, the note "call scans for how each is aligned".

**Guards, in main, before the kernel is asked** (`scanFor`, `scanSpread`; exact texts):

| Condition | Answer (an error) |
|---|---|
| the object has no scans | `this object has no scans: the user imports one in the Scans panel of the torno window` |
| several scans, none named | `name the scan: S1 (Micra.glb), S2 (MikraK11_Hatch.stl)` |
| an unknown id | `no scan S9; scans: S1, S2` |
| `meshState: 'missing'` | `S1's mesh is gone from <path>: the user imports it again from its row in the Scans panel` |
| no alignment for the layout | `S1 is not aligned in layout print (it is aligned in: assembly), so nothing is checked against it there: the user aligns it with the Align tool, or ask in that layout`; with none anywhere `(it is aligned in no layout)` and no "or ask in that layout" |
| the part has `arranged`, other layouts place it unmoved | `In layout print torno moved lid for display (the parts overlapped as the model placed them), so where the scan is against it there is torno's, not the model's. Ask in a layout that places lid as the model does (layouts: assembly).` |
| the part has `arranged`, no layout places it unmoved | `In layout print torno moved lid for display (the parts overlapped as the model placed them), so where the scan is against it there is torno's, not the model's. This object has no layout that places lid as it is mounted: add one to the model (def assembly(p)), or check a part torno did not move (tub).` |
| `ignore` or `region` names a mark that is no region of that scan | `M3 is not a region of S1; its regions: M7, M9` |

**Every reply** of `scan_clash` and `scan_deviation` is `{ layout, revision, stale?, scan, alignment: alignmentData(...), ...clean(kernel reply), note?, approximate: SCAN_APPROXIMATE, reading }`: `note` is `PRINT_NOTE` in a layout named `print`, and the alignment's `stale` text when it has one. The whole is asked through the same "one build" loop as `check` (asked again once when a build lands meanwhile).

**Readings:**
- `scan_clash tub vs S1 (print, r12): ≈ 2,168 scan points inside the part in 11 clusters (the 8 largest are told), deepest 14.2 mm at (-96.1, 31, 40.2) under tub/F40; 310 scan triangles cross its surface; nearest scan point outside 0.9 mm from tub/F12. S1 is aligned by 4 pairs (rms 2.1 mm, worst 3.4 mm): a depth under that says nothing.`
- none inside: `scan_clash tub vs S1 (print, r12): no scan point is inside the part (≈ 13,476 checked within 5 mm of it); nearest 12 mm from tub/F3. S1 is aligned …`
- thinned: `…, every 3rd point checked`; partial: `…, stopped after 15 s with 100,000 of 180,000 points checked`; regions left out: `…, 4,812 points of M7 left out`.
- `scan_deviation plate/F5 vs S1 (assembly, r12): ≈ 1.3 mm median, 1.9 mm mean, 7.4 mm at most (95 % within 5.1 mm), from 18,840 points of the part to the scan; the scan is inside the part at 212 of them; 1,160 had no scan within 50 mm; furthest at (10, 4, 6) on plate/F5.`
- nothing within reach: `scan_deviation plate vs S1 (assembly, r12): nothing of the scan is within 50 mm of the part`.

**The picture by distance** (`look` with `scanColour`): the window colours the scan for that one picture and puts its own colours back (`ScanLayer.colourFor(id, colours | null)`, inside `asPictured`). `deviationColours`: scan vertices in the part's bbox grown by `range` are brought to the part's own frame; each one's distance is `part.mesh.geometry.boundsTree.closestPointToPoint(point).distance`; it is inside when the part is `solid` and a ray along +Z from it crosses the part's tree an odd number of times (`tree.raycast(ray, THREE.DoubleSide)`, crossings nearer than 1e-6 counted once); every other vertex has `far`. The caption gains ` · scan S1 coloured by distance to tub: 0 to 20 mm, inside the part marked`; the overlay draws a legend (a ramp 120 px long with `0` and `20 mm`, and a swatch "inside"). Tokens: `--deviation-near: #8A4594`, `--deviation-far: #D3D8DF`, `--deviation-inside: #22252A` (dark mode: `#C58BD0`, `#3A3F46`, `#E9E7E2`); none is a mark colour.

**The prompt's context** (`context.ts`): `contextFor(deps, objectId, marks, opts)` takes `opts.scans?: ScanInfo[]`; after the selection line, one line, at most 300 characters (`SCANS_LIMIT`, further scans counted: "and 2 more"), counted in what the marks have room for:

```
Scans: S1 Micra.glb, aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm), shown at 60 %; S2 MikraK11_Hatch.stl, not aligned in print.
```

A stale alignment says `S1 Micra.glb, aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm) but the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r4: check the alignment`. The layout is the one on screen when the object is open, else the first. What is said last of each is from the view main was last told (`shown`, `shown at 60 %` or `hidden`), and is left out for an object that is not open. Nothing for an object without scans. `index.ts` passes `scans: await scans.list(id).catch(() => [])`.

**The system prompt** gains, after the sentence on spread layouts:

```ts
  'A scan (S1, S2) is a mesh of the real surroundings that the user imported and aligned to the model: it is good to a few millimetres at best, shows only what the camera saw, and nothing taken from it is exact.',
  'mcp__torno__scans lists them with how each is aligned in a layout; mcp__torno__scan_clash {"part": "tub"} says which scan points are inside a part, in clusters with the deepest of each, and mcp__torno__scan_deviation {"part": "plate", "faces": ["plate/F5"]} how far a part or some of its faces lie from the scan: use them, and no script that loads the scan.',
  'A scan is checked only where it is aligned and only against parts torno did not move for display, so fit against the surroundings needs a layout that places the parts as mounted (def assembly(p)).',
  'A region mark is a part of a scan the user painted, with a note that says what it is: pass its number in ignore to leave it out of scan_clash, or in region to scan_deviation.',
```

- [ ] **Step 1: Write the failing tests of the tools**

`app/src/main/mcp/scanTools.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { BuildState } from '../../shared/build'
import type { Mark } from '../../shared/marks'
import type { Part, Scene } from '../../shared/scene'
import type { ScanAlignment, ScanInfo } from '../../shared/scans'
import type { Camera, ViewState } from '../../shared/view'
import { scanClashTool, scanDeviationTool, scansTool } from './scanTools'
import { type ToolDeps, type ToolResult, TOOLS } from './tools'

const part = (layout: string, name: string, more: Partial<Part> = {}): Part =>
  ({ key: `${layout}:${name}`, name, layout, bbox: { min: [-20, -15, -3], max: [20, 15, 3] }, volume: 6000, faceCount: 12, edgeCount: 30, valid: true, ...more }) as Part
const SCENE: Scene = { model: 'box.py', layouts: ['assembly', 'print'], parts: [part('assembly', 'tub'), part('assembly', 'lid'), part('print', 'tub'), part('print', 'lid', { arranged: [45, 0, 0] })], seconds: 1, output: '' }
/** As the owner's micra-intake: one layout, the first part where the model put it, the others moved. */
const PRINT_ONLY: Scene = { ...SCENE, layouts: ['print'], parts: [part('print', 'tub'), part('print', 'lid', { arranged: [45, 0, 0] })] }
const CAMERA: Camera = { position: [100, -80, 60], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const OK: BuildState = { objectId: 'box', status: 'ok', revision: 12, seconds: 1, stale: false }
const pairs = [1.8, 3.4, 0.9, 1.2].map((residual) => ({ scan: [0, 0, 0] as [number, number, number], model: [0, 0, 0] as [number, number, number], residual }))
const BY_PAIRS: ScanAlignment = { transform: { t: [1, 2, 3], q: [0, 0, 0, 1], s: 1 }, steps: ['pairs'], pairs, rms: 2.1, frame: {}, at: '' }
const scan = (id: string, alignments: Record<string, ScanAlignment> = {}, more: Partial<ScanInfo> = {}): ScanInfo =>
  ({ id, name: `${id}.glb`, source: { path: `/dl/${id}.glb`, bytes: 1, mtimeMs: 1, sha256: '' }, imported: { unit: 'm', up: 'y', assumed: { unit: true, up: true }, vertices: 936823, triangles: 1607144, colours: 'texture', bbox: { min: [-1258.9, -1175.3, 0], max: [1258.9, 1175.3, 1493.6] }, area: 1, at: '' }, alignments, sourceState: 'present', meshState: 'ok', checks: {}, ...more }) as ScanInfo
const REGION = { id: 'M7', kind: 'region', scan: 'S1', author: 'user', note: 'wiring loom', status: 'sent', anchorState: 'ok', layout: 'print', revision: 12, camera: CAMERA, createdAt: '', triangles: 4812, area: 31000, local: { centroid: [0, 0, 0], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], rms: 1 } } } as unknown as Mark
const CLASHED = {
  part: 'tub', scan: 'S1', points: { scan: 936823, candidates: 13476, checked: 13476, ignored: 0 },
  inside: { count: 2168, crossing: 310, clusters: [{ count: 1982, centre: [-98.1, 30.2, 44], bbox: { min: [-120, 10, 30], max: [-80, 52, 61] }, depth: 14.2, at: [-96.1, 31, 40.2], under: 'tub/F40' }], clustersOmitted: 3 },
  deepest: { depth: 14.2, at: [-96.1, 31, 40.2], under: 'tub/F40' },
  nearest: { distance: 0.9, at: [61, -12.2, 9.1], on: [60.1, -12.2, 9.1], face: 'tub/F12' },
  sampling: { every: 1, cell: 5, surface: 1, deflection: 0.1, retaken: 9, partial: false, seconds: 3.2 }, how: 'scan vertices inside the part…', exact: false
}

interface Fake extends ToolDeps { queries: Array<{ name: string; args: any }> }
function fake(scans: ScanInfo[], says: (name: string, args: never) => unknown = () => CLASHED, over: { scene?: Scene; layout?: string; marks?: Mark[] } = {}): Fake {
  const scene = over.scene ?? SCENE
  const view: ViewState = { objectId: 'box', layout: over.layout ?? scene.layouts[0], camera: CAMERA, visible: [], scans: scans.map((s) => ({ id: s.id, visible: true, opacity: 0.6 })) }
  const made = {
    queries: [] as Fake['queries'],
    object: (id: string) => (id === 'box' ? { id, name: id, dir: '/ws/box', model: 'box.py' } : undefined),
    build: () => OK,
    scene: () => ({ revision: 12, scene }),
    view: () => view,
    openObjectId: () => 'box',
    marks: async () => over.marks ?? [],
    scans: async () => scans,
    scanPaths: (_objectId: string, id: string) => ({ mesh: `/ws/box/.torno/scans/${id}/mesh.bin`, mask: (mark: string) => `/ws/box/.torno/scans/${id}/${mark}.mask` }),
    query: async (_objectId: string, name: string, args: object) => {
      made.queries.push({ name, args })
      const said = says(name, args as never)
      if (said instanceof Error) throw said
      return said
    }
  }
  return made as unknown as Fake
}
const text = (result: ToolResult): string => result.content.find((block) => block.type === 'text')!.text as string
const data = (result: ToolResult): any => JSON.parse(text(result))
const refused = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

describe('scans', () => {
  it('lists them with how each is aligned in the layout, and that nothing of them is exact', async () => {
    const said = data(await scansTool(fake([scan('S1', { assembly: BY_PAIRS }), scan('S2')], undefined, { marks: [REGION] }), 'box', {}))
    expect(said).toMatchObject({ layout: 'assembly', revision: 12, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(said.scans[0]).toMatchObject({
      id: 'S1', name: 'S1.glb', source: { path: '/dl/S1.glb', state: 'present' }, triangles: 1607144, unit: 'm', up: 'y', size: [2517.8, 2350.6, 1493.6], visible: true, opacity: 0.6,
      alignment: { state: 'aligned', by: 'by 4 pairs (rms 2.1 mm, worst 3.4 mm)', steps: ['pairs'], pairs: 4, rms: 2.1, worst: 3.4 },
      bbox: { min: [-1257.9, -1173.3, 3], max: [1259.9, 1177.3, 1496.6] }, regions: ['M7 "wiring loom"']
    })
    expect(said.scans[1]).toMatchObject({ id: 'S2', alignment: { state: 'not aligned' } })
    expect(said.scans[1].bbox).toBeUndefined()
    expect(said.reading).toBe('S1 S1.glb: 1,607,144 triangles, 2518 × 2351 × 1494 mm, aligned in assembly by 4 pairs (rms 2.1 mm, worst 3.4 mm), shown at 60 %, 1 region. S2 S2.glb: 1,607,144 triangles, 2518 × 2351 × 1494 mm, not aligned in assembly, shown at 60 %.')
  })

  it('says when there are none, and when the model has moved under one', async () => {
    expect(data(await scansTool(fake([]), 'box', {}))).toMatchObject({ scans: [], reading: 'no scans: the user imports one in the Scans panel of the torno window' })
    const stale = scan('S1', { assembly: BY_PAIRS }, { checks: { assembly: { revision: 12, of: 4, off: 2, worst: 6.2, moved: [] } } })
    expect(data(await scansTool(fake([stale]), 'box', {})).scans[0].alignment.stale).toBe('the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r12: check the alignment')
  })
})

describe('scan_clash', () => {
  it('gives the kernel the scan where it is aligned, and answers with its reply, the alignment and a reading', async () => {
    const deps = fake([scan('S1', { assembly: BY_PAIRS })])
    const result = await scanClashTool(deps, 'box', { part: 'tub' })
    expect(result.isError).toBeUndefined()
    expect(deps.queries).toEqual([{ name: 'scan_clash', args: { layout: 'assembly', part: 'tub', margin: 5, scan: { id: 'S1', path: '/ws/box/.torno/scans/S1/mesh.bin', transform: BY_PAIRS.transform, ignore: [], only: null } } }])
    expect(data(result)).toMatchObject({ layout: 'assembly', revision: 12, scan: 'S1', alignment: { state: 'aligned', rms: 2.1 }, inside: { count: 2168 }, exact: false, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact' })
    expect(data(result).reading).toBe(
      'scan_clash tub vs S1 (assembly, r12): ≈ 2,168 scan points inside the part in 4 clusters (the 1 largest is told), deepest 14.2 mm at (-96.1, 31, 40.2) under tub/F40; 310 scan triangles cross its surface; nearest scan point outside 0.9 mm from tub/F12. S1 is aligned by 4 pairs (rms 2.1 mm, worst 3.4 mm): a depth under that says nothing.'
    )
    expect(data(result).note).toBeUndefined()
  })

  it('reads a part the scan is clear of, a thinned answer and one that ran out of time', async () => {
    const clear = { ...CLASHED, inside: { count: 0, crossing: 0, clusters: [], clustersOmitted: 0 }, deepest: null, nearest: { ...CLASHED.nearest, distance: 12 } }
    const reading = async (said: object): Promise<string> => data(await scanClashTool(fake([scan('S1', { assembly: BY_PAIRS })], () => said), 'box', { part: 'tub' })).reading
    expect(await reading(clear)).toContain('no scan point is inside the part (≈ 13,476 checked within 5 mm of it); nearest 12 mm from tub/F12.')
    expect(await reading({ ...clear, points: { ...CLASHED.points, candidates: 540000, checked: 180000 }, sampling: { ...CLASHED.sampling, every: 3 } })).toContain('(≈ 180,000 checked within 5 mm of it, every 3rd point)')
    expect(await reading({ ...clear, points: { ...CLASHED.points, candidates: 180000, checked: 100000 }, sampling: { ...CLASHED.sampling, partial: true } })).toContain('stopped after 15 s with 100,000 of 180,000 points checked')
    expect(await reading({ ...clear, nearest: null })).toContain('nothing of the scan is within 5 mm of it')
  })

  it('is refused where the scan is not aligned, naming where it is', async () => {
    const elsewhere = fake([scan('S1', { assembly: BY_PAIRS })], undefined, { layout: 'print' })
    expect(await scanClashTool(elsewhere, 'box', { part: 'tub' })).toEqual(refused('S1 is not aligned in layout print (it is aligned in: assembly), so nothing is checked against it there: the user aligns it with the Align tool, or ask in that layout'))
    expect(await scanClashTool(fake([scan('S1')]), 'box', { part: 'tub' })).toEqual(refused('S1 is not aligned in layout assembly (it is aligned in no layout), so nothing is checked against it there: the user aligns it with the Align tool'))
    expect(elsewhere.queries).toEqual([])
  })

  it('answers for a part torno did not move in a spread layout, with a note, and refuses one it moved', async () => {
    const deps = fake([scan('S1', { print: BY_PAIRS })], undefined, { scene: PRINT_ONLY })
    const tub = data(await scanClashTool(deps, 'box', { part: 'tub' }))
    expect(tub).toMatchObject({ layout: 'print', inside: { count: 2168 }, note: 'layout print poses the parts for the bed: a part is where it is mounted only if the model leaves it there' })
    expect(await scanClashTool(deps, 'box', { part: 'lid' })).toEqual(
      refused("In layout print torno moved lid for display (the parts overlapped as the model placed them), so where the scan is against it there is torno's, not the model's. This object has no layout that places lid as it is mounted: add one to the model (def assembly(p)), or check a part torno did not move (tub).")
    )
    const both = fake([scan('S1', { print: BY_PAIRS })], undefined, { layout: 'print' })
    expect(await scanClashTool(both, 'box', { part: 'lid' })).toEqual(
      refused("In layout print torno moved lid for display (the parts overlapped as the model placed them), so where the scan is against it there is torno's, not the model's. Ask in a layout that places lid as the model does (layouts: assembly).")
    )
    expect(deps.queries).toHaveLength(1)
  })

  it('carries a stale alignment in the reply, and never hides it', async () => {
    const stale = scan('S1', { assembly: BY_PAIRS }, { checks: { assembly: { revision: 12, of: 4, off: 2, worst: 6.2, moved: [] } } })
    const said = data(await scanClashTool(fake([stale]), 'box', { part: 'tub' }))
    expect(said.alignment.stale).toBe('the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r12: check the alignment')
    expect(said.reading).toContain('but the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r12: check the alignment')
  })

  it('leaves out the regions it is told to, by their masks, and refuses what is no region of that scan', async () => {
    const deps = fake([scan('S1', { assembly: BY_PAIRS })], () => ({ ...CLASHED, points: { ...CLASHED.points, ignored: 4812 } }), { marks: [REGION] })
    const said = data(await scanClashTool(deps, 'box', { part: 'tub', ignore: ['M7'] }))
    expect(deps.queries[0].args.scan.ignore).toEqual(['/ws/box/.torno/scans/S1/M7.mask'])
    expect(said.reading).toContain(', 4,812 points of M7 left out')
    expect(await scanClashTool(deps, 'box', { part: 'tub', ignore: ['M3'] })).toEqual(refused('M3 is not a region of S1; its regions: M7'))
  })

  it('asks which scan when there are several, and says what there is of one that is not', async () => {
    const two = fake([scan('S1', { assembly: BY_PAIRS }), scan('S2', { assembly: BY_PAIRS })])
    expect(await scanClashTool(two, 'box', { part: 'tub' })).toEqual(refused('name the scan: S1 (S1.glb), S2 (S2.glb)'))
    expect(await scanClashTool(two, 'box', { part: 'tub', scan: 'S9' })).toEqual(refused('no scan S9; scans: S1, S2'))
    expect((await scanClashTool(two, 'box', { part: 'tub', scan: 'S2' })).isError).toBeUndefined()
    expect(await scanClashTool(fake([]), 'box', { part: 'tub' })).toEqual(refused('this object has no scans: the user imports one in the Scans panel of the torno window'))
    expect(await scanClashTool(fake([scan('S1', { assembly: BY_PAIRS }, { meshState: 'missing' })]), 'box', { part: 'tub' })).toEqual(
      refused("S1's mesh is gone from /ws/box/.torno/scans/S1/mesh.bin: the user imports it again from its row in the Scans panel")
    )
    expect(text(await scanClashTool(fake([scan('S1', { assembly: BY_PAIRS })]), 'box', { part: 'cap' }))).toBe("no part 'cap' in layout assembly (parts: tub, lid)")
  })
})

describe('scan_deviation', () => {
  const DEVIATED = {
    part: 'tub', faces: [5], scan: 'S1', from: 'part', samples: 20000, compared: 18840, beyond: 1160,
    distance: { min: 0, mean: 1.9, max: 7.4, rms: 2.4, p50: 1.3, p90: 4, p95: 5.1 }, signed: { min: -3.1, mean: 0.4, max: 7.4, inside: 212 },
    worst: { distance: 7.4, at: [10, 4, 6], on: [10, 4, 13.4], face: 'tub/F5' }, sampling: { surface: 1, deflection: 0.1, partial: false, seconds: 1.1 }, how: '…', exact: false
  }

  it('asks of faces by their numbers, of a region by its mask, and reads the answer', async () => {
    const deps = fake([scan('S1', { assembly: BY_PAIRS })], () => DEVIATED, { marks: [REGION] })
    const said = data(await scanDeviationTool(deps, 'box', { part: 'tub', faces: ['tub/F5'], region: 'M7' }))
    expect(deps.queries[0]).toMatchObject({ name: 'scan_deviation', args: { layout: 'assembly', part: 'tub', faces: [5], from: 'part', within: 50, scan: { only: '/ws/box/.torno/scans/S1/M7.mask' } } })
    expect(said.reading).toBe('scan_deviation tub/F5 vs S1 (assembly, r12): ≈ 1.3 mm median, 1.9 mm mean, 7.4 mm at most (95 % within 5.1 mm), from 18,840 points of the part to the scan; the scan is inside the part at 212 of them; 1,160 had no scan within 50 mm; furthest at (10, 4, 6) on tub/F5.')
    expect(said).toMatchObject({ exact: false, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact', alignment: { state: 'aligned' } })
  })

  it('says when nothing is within reach, and refuses faces of another part', async () => {
    const none = { ...DEVIATED, faces: null, compared: 0, beyond: 20000, distance: null, signed: null, worst: null }
    expect(data(await scanDeviationTool(fake([scan('S1', { assembly: BY_PAIRS })], () => none), 'box', { part: 'tub' })).reading).toBe('scan_deviation tub vs S1 (assembly, r12): nothing of the scan is within 50 mm of the part')
    expect(text(await scanDeviationTool(fake([scan('S1', { assembly: BY_PAIRS })]), 'box', { part: 'tub', faces: ['lid/F1'] }))).toBe('lid/F1 is not a face of tub: give refs such as tub/F0')
    expect(text(await scanDeviationTool(fake([scan('S1', { assembly: BY_PAIRS })]), 'box', { part: 'tub', faces: ['tub/F40'] }))).toBe('tub has 12 faces, F0 to F11: there is no F40')
  })
})

describe('the descriptions of the scan tools', () => {
  it('say that nothing from a scan is exact, and when each is refused', () => {
    for (const tool of [TOOLS.scans, TOOLS.scan_clash, TOOLS.scan_deviation]) expect(tool.description).toMatch(/[Aa]pproximate|nothing from it is exact/)
    expect(TOOLS.scan_clash.description).toContain('Refused where the scan is not aligned, and for a part torno moved for display')
  })
})
```

(In the first `scan_clash` reading the kernel told 1 cluster and omitted 3: "in 4 clusters (the 1 largest is told)".)

Add to `readTools.test.ts`, in `describe('measure')`:

```ts
  it('takes a point of an aligned scan as an end, and then says nothing is exact', async () => {
    const aligned = { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '' }
    const deps = fake(() => ({ kind: 'distance', value: 12.5, unit: 'mm', how: 'point to plane', points: [[0, 0, 15.5], [0, 0, 3]], exact: true }), { scans: async () => [{ id: 'S1', name: 'Micra.glb', alignments: { assembly: aligned }, meshState: 'ok', checks: {} }] as never })
    const result = await measureTool(deps, 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 15.5] }, b: 'tub/F5' })
    expect(deps.queries[0].args).toEqual({ kind: 'distance', a: { layout: 'assembly', point: [0, 0, 15.5] }, b: { ref: 'assembly:tub/F5' } })
    expect(data(result)).toMatchObject({ exact: false, approximate: 'a scan is a mesh measured by a phone or a scanner: nothing from it is exact', reading: '≈ 12.5 mm point to plane, approximate (S1 is a scan), (0, 0, 15.5) on S1 to tub/F5' })
    expect(text(await measureTool(deps, 'box', { kind: 'angle', a: { scan: 'S1', point: [0, 0, 1] }, b: 'tub/F5' }))).toBe('only a distance is measured to a point of a scan')
    expect(text(await measureTool(fake(), 'box', { kind: 'distance', a: { scan: 'S1', point: [0, 0, 1] }, b: 'tub/F5' }))).toBe('this object has no scans: the user imports one in the Scans panel of the torno window')
  })
```

and, in its `describe('section')`, one test: with `scan: 'S1'` the tool asks `scan_section` after `section` with the same plane and the scan's wire form, the JSON has `scan: { id: 'S1', polylines: [...], exact: false, approximate: … }`, the drawing request has `scan`, and an unaligned scan is the alignment refusal (no `section` query is made). Add to `tools.test.ts`: `scene` lists `scans: [{ id: 'S1', name, triangles, aligned: true }]`; `look` hands `scans: false`, `scans: ['S1']` and `scanColour: { scan: 'S1', part: 'tub', range: 20 }` on to the window and refuses a `scanColour` whose part is not of the layout; `show` hands `scans` and `scanOpacity` on and refuses an opacity outside 0.05 to 1.

`app/src/main/context.test.ts`, a `describe('scans')`: with the `deps` helper there and `scans` built as in `scanTools.test.ts`:

```ts
  it('says the scans in one line after the status, and nothing when there are none', () => {
    const view = { objectId: 'bracket', layout: 'print', camera: CAMERA, visible: [], scans: [{ id: 'S1', visible: true, opacity: 0.6 }, { id: 'S2', visible: false, opacity: 1 }] }
    const text = contextFor(deps({ build: OK, scene: SCENE, view }), 'bracket', [], { scans: [scan('S1', { print: BY_PAIRS }), scan('S2')] }).text
    expect(text.split('\n')[1]).toBe('Scans: S1 S1.glb, aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm), shown at 60 %; S2 S2.glb, not aligned in print, hidden.')
    expect(contextFor(deps({ build: OK, scene: SCENE, view }), 'bracket', [], { scans: [] }).text).not.toContain('Scans:')
  })

  it('says when the model has moved under one, and keeps to its room', () => {
    const stale = scan('S1', { print: BY_PAIRS }, { checks: { print: { revision: 4, of: 4, off: 2, worst: 6.2, moved: [] } } })
    expect(contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [], { scans: [stale] }).text).toContain('aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm) but the model is no longer under 2 of its 4 points (worst 6.2 mm off) on r4: check the alignment')
    const many = Array.from({ length: 30 }, (_, n) => scan(`S${n + 1}`))
    const line = contextFor(deps({ build: OK, scene: SCENE }), 'bracket', [], { scans: many }).text.split('\n').find((l) => l.startsWith('Scans:'))!
    expect(line.length).toBeLessThanOrEqual(300)
    expect(line).toMatch(/ and \d+ more\.$/)
  })
```

`prompt.test.ts`: the prompt names `mcp__torno__scans`, `mcp__torno__scan_clash` and `mcp__torno__scan_deviation`, says "nothing taken from it is exact" and "def assembly(p)".

`app/src/renderer/viewport/scanDeviation.test.ts`:

```ts
import { expect, it } from 'vitest'
import { deviationColour } from './scanDeviation'

const COLOURS = { near: [1, 0, 0] as [number, number, number], far: [0, 0, 1] as [number, number, number], inside: [0, 0, 0] as [number, number, number] }

it('runs from the near colour at the part to the far one at the range and beyond, and marks what is inside', () => {
  expect(deviationColour(0, false, 20, COLOURS)).toEqual([1, 0, 0])
  expect(deviationColour(10, false, 20, COLOURS)).toEqual([0.5, 0, 0.5])
  expect(deviationColour(20, false, 20, COLOURS)).toEqual([0, 0, 1])
  expect(deviationColour(500, false, 20, COLOURS)).toEqual([0, 0, 1])
  expect(deviationColour(3, true, 20, COLOURS)).toEqual([0, 0, 0])
})
```

Run: `pnpm -C app exec vitest run src/main/mcp src/main/context.test.ts src/main/prompt.test.ts src/renderer/viewport/scanDeviation.test.ts` Expected: FAIL.

- [ ] **Step 2: Implement** `scanTools.ts`, the schemas and registration (`server.registerTool('scans', …)`, `'scan_clash'`, `'scan_deviation'`), `endsOf` (a `{scan, point}` end: `scanFor`, then `{ point, scan, text: '(x, y, z) on S1' }`; a region mark: `{ point: apply(alignment.transform, mark.local.centroid), scan, text: 'the centroid of region M7 (S1)' }`), `measureTool` (an end with `scan`: only `distance`; the reply's `exact` forced false, `approximate` added, the reading made with `exact: false` and `, approximate (S1 is a scan)` in place of `, approximate`), `sectionTool` (`scan`), `sceneTool`, `lookTool`, `showTool`, `contextFor`, `SYSTEM_PROMPT`, `toolDeps` in `index.ts` (`scans: (id) => scans.list(id)`, `scanPaths: (id, scan) => scans.paths(id, scan)`).

Run the same command. Expected: PASS. Run `pnpm test`: the tests of Milestone 3 pass unchanged except those that list the tools or the query names, which gain the three.

- [ ] **Step 3: The window's side**: `look` with `scans` and `scanColour` (`ViewportPane`'s `picture`, `picture.ts`, `ScanLayer.colourFor`, the legend in `overlay.ts`), `show` with `scans` and `scanOpacity` (`state/agent.ts`; `actions.showForAgent` gains a fourth argument `scans?: Record<string, ScanView>` and `shownByAgent` gains `scans?: Record<string, ScanView | undefined>`, what the person had, which `sceneFileOf` goes on saving), the scan's polylines in `sectionDrawing.ts` (a hairline in `--muted`, dashed 4 2, with `S1 (scan, ≈)` in the legend). Unit tests beside each: `store.test.ts` (an agent's `show` with scans leaves `sceneFileOf(...).scans` as the person had it, and their own `setScanView` afterwards is theirs again), `sectionDrawing.test.ts` (a request with `scan` has its legend line and widens the bounds to hold the polylines).

- [ ] **Step 4: Through a real MCP client**

Add to `app/e2e/mcp.spec.ts` (its `connect`, `call`, `openObject`; `grid` and `stl` from `../src/test/scanFixtures`):

```ts
test('the agent lists a scan, is refused until it is aligned, and then reads a clash, a deviation and a cut of it', async () => {
  await openObject('hollow')
  const client = await connect('hollow')
  // A sheet in the tub's floor, which is 2 mm thick from z = 0: 400 vertices, each 1 mm deep.
  const file = join(root, 'sheet.stl')
  writeFileSync(file, stl(grid(20, 1, () => 1)))
  await app.evaluate((_electron, file) => (globalThis as any).__tornoMain.scans.import('hollow', file), file)
  const listed = JSON.parse((await call(client, 'scans')).text)
  expect(listed.scans).toMatchObject([{ id: 'S1', triangles: 722, alignment: { state: 'not aligned' } }])
  const early = await call(client, 'scan_clash', { part: 'tub' })
  expect(early.isError).toBe(true)
  expect(early.text).toBe('S1 is not aligned in layout assembly (it is aligned in no layout), so nothing is checked against it there: the user aligns it with the Align tool')
  // Aligned as the person would with typed values: where it was imported is where it belongs.
  await app.evaluate(() => (globalThis as any).__tornoMain.scans.align('hollow', 'S1', 'assembly', { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { tub: [0, 0, 0], lid: [0, 0, 0] }, at: new Date().toISOString() }))
  const clash = JSON.parse((await call(client, 'scan_clash', { part: 'tub' })).text)
  expect(clash).toMatchObject({ layout: 'assembly', scan: 'S1', exact: false, alignment: { state: 'aligned', by: 'by typed values' }, inside: { count: 400 }, points: { scan: 400 } })
  expect(clash.deepest.depth).toBeCloseTo(1, 6)
  expect(clash.reading).toContain('≈ 400 scan points inside the part in 1 cluster, deepest 1 mm')
  const lid = JSON.parse((await call(client, 'scan_clash', { part: 'lid' })).text)
  expect(lid.inside.count).toBe(0)
  // The lid's underside is at z = 38: the sheet is 37 mm under it.
  const far = JSON.parse((await call(client, 'scan_deviation', { part: 'lid', from: 'scan', within: 100 })).text)
  expect(far.distance.min).toBeGreaterThanOrEqual(37)
  expect(far.distance.min).toBeLessThan(37.2)
  expect(far.reading).toMatch(/^scan_deviation lid vs S1 \(assembly, r\d+\): ≈ /)
  const cut = await call(client, 'section', { plane: { axis: 'x', at: 0.25 }, scan: 'S1', size: 256 })
  const cutData = JSON.parse(cut.text)
  expect(cutData.scan).toMatchObject({ id: 'S1', exact: false })
  expect(cutData.scan.polylines).toHaveLength(1)
  expect(cut.content.some((block) => block.type === 'image')).toBe(true)
  const withScan = await call(client, 'look', { view: 'front', size: 256 })
  const without = await call(client, 'look', { view: 'front', size: 256, scans: false })
  expect(withScan.text).toContain('scans S1')
  expect(without.text).not.toContain('scans')
  const coloured = await call(client, 'look', { view: 'iso', size: 256, parts: ['tub'], scanColour: { part: 'tub' } })
  expect(coloured.text).toContain('scan S1 coloured by distance to tub: 0 to 20 mm, inside the part marked')
  const shown = await call(client, 'show', { scans: [] })
  expect(shown.isError).toBe(false)
  await expect.poll(async () => (await page.evaluate(() => window.__tornoTest!.scans()))[0].visible).toBe(false)
  // For now only: the person's scene file does not say the scan is hidden.
  const sceneFile = join(root, 'hollow', '.torno', 'scene.json')
  expect((existsSync(sceneFile) ? JSON.parse(readFileSync(sceneFile, 'utf8')) : {}).scans?.S1?.visible).not.toBe(false)
})

test('the prompt tells the agent of the scans, once and in a line', async () => {
  await prompt()
  expect(times(await said(), 'Scans: S1 sheet.stl, aligned in assembly by typed values')).toBe(1)
})
```

Add to `server.itest.ts`: the server lists `scans`, `scan_clash` and `scan_deviation` among its tools, each with a description and a schema.

Run: `pnpm build && pnpm -C app exec playwright test e2e/mcp.spec.ts` Expected: PASS.

- [ ] **Step 5: Suites, commit**

Run all four suites and the typecheck. Expected: pass.

```bash
git add app/src app/e2e/mcp.spec.ts
git commit -m "The agent lists the scans, asks what of one is inside a part and how far a part lies from it, and is told nothing of a scan as exact

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Regions

**Files:**
- Create: `app/src/shared/regions.ts`, `regions.test.ts`, `app/src/renderer/viewport/scanPaint.ts`, `scanPaint.test.ts`, `app/src/renderer/tools/regionTool.ts`, `app/src/renderer/tools/region.test.ts`, `app/src/renderer/ui/RegionBar.tsx`, `app/e2e/region.spec.ts`
- Modify: `app/src/shared/marks.ts`, `shared.test.ts`, `app/src/main/marks/file.ts`, `file.test.ts`, `marks/store.ts`, `store.test.ts`, `marks/describe.ts`, `describe.test.ts`, `app/src/main/scans/store.ts`, `store.test.ts` (`writeMask`, `mask`, `removeMask`), `app/src/main/ipc.ts`, `app/src/preload/index.ts`, `app/src/main/mcp/tools.ts` (`withLine` with scans; the `marks` description), `mcp/markTools.ts`, `app/src/main/context.ts`, `app/src/renderer/viewport/scans.ts`, `viewport/marks/MarkLayer.ts`, `viewport/marks/markObjects.ts`, `viewport/Viewport.ts`, `state/tools.ts` (`'region'`, key `B`), `ui/ToolPalette.tsx`, `ui/MarkRow.tsx`, `ui/ViewportPane.tsx`

**Interfaces:**
- Consumes: `ScanLayer.tree`, `ScanHit`, `pickScan` (Task 4); `parseScanMesh`, `maskFile`, `maskBits` (`shared/scans.ts`); `fitPlane`, `apply`, `rotate` (`shared/align.ts`); `scan_clash`'s `ignore` and `scan_deviation`'s `region` (Task 7, which already pass mask paths); `RegionMark`, `REGION_KEYS`, `NewRegion` ("Shared contracts").
- Produces:

```ts
// shared/regions.ts
export interface RegionStats { triangles: number; area: number; local: RegionMark['local'] }
export function popcount(bits: Uint8Array): number
/** What a region is, from the mesh and its bits: main's to say, never the window's. Null for no triangle. */
export function regionStats(mesh: Pick<ScanMesh, 'vertices' | 'triangles'>, bits: Uint8Array): RegionStats | null
/** A region's numbers in the object frame of a layout the scan is aligned in. */
export function regionInLayout(region: Pick<RegionMark, 'area' | 'local'>, transform: ScanTransform): { area: number; centroid: Vec3; bbox: { min: Vec3; max: Vec3 }; plane: { origin: Vec3; normal: Vec3; rms: number } }

// main/marks/store.ts
/** `before` is run once the mark has its number and before anything is written or told: a region's mask is written there. If it rejects, there is no mark. */
add(objectId: string, mark: NewMark, status?: 'draft' | 'sent', measured?: Measurement, region?: { stats: RegionStats; before(id: string): Promise<void> }): Promise<Mark>
/** The regions of a scan that is gone have nothing under them: `orphaned`. */
orphanRegions(objectId: string, scan: string): Promise<void>

// main/scans/store.ts
writeMask(objectId: string, id: string, markId: string, bits: Uint8Array): Promise<void>   // atomic; refuses bits of another length than ceil(T / 8)
mask(objectId: string, id: string, markId: string): Promise<Buffer>
removeMask(objectId: string, id: string, markId: string): Promise<void>

// main/marks/describe.ts
describeMark(mark: Mark, opts?: { tag?: string; revision?: number; scans?: readonly ScanInfo[] }): string
markData(mark: Mark, revision: number | undefined, scans?: readonly ScanInfo[]): object

// viewport/scanPaint.ts
/** A set of triangles of a scan as the bits of a `.mask`. */
export class TriangleSet {
  constructor(triangles: number, bits?: Uint8Array)
  readonly bits: Uint8Array
  readonly triangles: number
  count: number
  has(triangle: number): boolean
  add(triangle: number): boolean       // true when it was not in
  delete(triangle: number): boolean    // true when it was in
  clear(): void
}
/** Calls `each` with the triangles whose centroid is within `radius` of `centre` (the scan's own frame) and, when `towards` is given, that face it. */
export function gatherSphere(tree: MeshBVH, geometry: THREE.BufferGeometry, centre: THREE.Vector3, radius: number, towards: THREE.Vector3 | null, each: (triangle: number) => void): void
/** Calls `each` with the triangles whose centroid is on the inner side of every plane (a frustum through a rectangle of the screen, in the scan's own frame) and that face `eye`. */
export function gatherBox(tree: MeshBVH, geometry: THREE.BufferGeometry, planes: THREE.Plane[], eye: THREE.Vector3, each: (triangle: number) => void): void
/** Grows a set over what is flat with it: triangles within `reach` of one already in it, no further than `flat` from the set's best-fit plane and turned no more than `degrees` from it. At most `most` are added; returns how many were. */
export function growFlat(tree: MeshBVH, geometry: THREE.BufferGeometry, set: TriangleSet, opts?: { flat?: number; degrees?: number; reach?: number; most?: number }): number
/** The index that draws only a set's triangles over the scan's own positions. */
export function tintIndex(set: TriangleSet, index: ArrayLike<number>): Uint32Array

// ScanLayer / Viewport
/** The set being painted on a scan, drawn as a tint in the person's mark colour; null for none. Redrawn when `touched()` is called after it changed. */
paintScan(id: string | null, set: TriangleSet | null): { touched(): void } | null
/** The regions kept, to be tinted in their authors' colours: bits by mark id. */
setRegions(regions: Array<{ id: string; scan: string; author: 'user' | 'agent'; bits: Uint8Array }>): void
```

Behaviour:
- **A region is a mark.** `kind: 'region'` in the `Mark` union; ids in the same `M` sequence; `draft` until a prompt has carried it, then `sent`, then `resolved`, like any other; its note says what the place is. `markAnchors` returns `[]`, `translated` returns it as it is, `isUnchecked` is false of it (`mark.kind !== 'region' &&` in front), and `reanchorAll` gives it `checkedRevision` as it does an anchorless shape (add the case to `reanchor.test.ts`). `sanitiseMark` keeps one whose `scan` matches `/^S\d+$/`, whose `triangles` is a whole number from 1 and whose `area` and `local` numbers are finite; `MarkPatch` changes only its note and status.
- **Main says what it is.** The window sends `NewRegion`: the scan, the note, the layout, the revision, the camera and the bits. The `marks:addRegion` handler: the scan must be there with its mesh (`meshState: 'ok'`); the bits must be `ceil(T / 8)` bytes, with every bit past T cleared, and have at least one set ("a region needs at least one triangle"); `regionStats` on `parseScanMesh(await scans.mesh(…))`; `marks.add(objectId, { kind: 'region', author: 'user', … }, 'draft', undefined, { stats, before: (id) => scans.writeMask(objectId, scan, id, bits) })`. `MarkStore.add` drops `REGION_KEYS` from what it was given and puts `stats` in their place, as it does `MEASURED_KEYS` for a dimension. `marks.json` never holds the bits.
- **Its life with its scan.** Removing a region mark removes its mask. Removing a scan calls `marks.orphanRegions`: its regions keep their notes and say `[its scan is gone]`. `convert` (another unit or up axis) keeps regions: the triangles are the same. A mask whose length does not fit the mesh (the scan was imported again from a changed source) is refused by the tools that are given it, in the kernel's words.
- **Telling it** (`describeMark`, with the scans; numbers by `shared/format.ts`; in the object frame of the mark's layout, by the scan's transform there):
  - aligned: `M7 region on scan S1: 4,812 triangles, ≈ 31000 mm², centre (-120, 85, 40), box 180 × 90 × 60 mm, flat to 4.2 mm about a plane with normal (0, 0.1, 0.995): "wiring loom, can be pushed aside"`
  - not aligned in its layout, or no scans given: `M7 region on scan S1 (not aligned in print, so it has no place in the model’s frame): 4,812 triangles, ≈ 31000 mm²: "wiring loom"` (the apostrophe is the typographic one, as in the other sentences main says)
  - orphaned: `M7 region on scan S1 [its scan is gone]: "wiring loom"`
  - `markData` gives `scan`, `triangles`, `area`, and, when aligned, `centroid`, `bbox` and `plane` in the object frame; never `local` (it is main's and the window's).
  - `contextFor` and the `marks` and `describe` tools pass the scans, so a draft region is listed with the other marks, a line each.
- **The Region tool** (`B`; `Tool` id `region`; cursor `crosshair`). It paints on the scan the Align tool last worked on, else the only one, else the one under the pointer at the first press.
  - *Brush.* While the left button is held on the scan, every pointer event gathers `gatherSphere` at the hit (radius from the bar, default 3 % of the scan's bbox diagonal; `[` and `]` change it by a quarter; triangles facing the eye only) into a `TriangleSet`, or takes them out while "Erase" is on (`E`). The camera is not the pointer's meanwhile (`setNavigation(false)` from press to release, as the Draw tool does); `Alt`-drag still turns it. The tint follows in the viewport (`paintScan(...).touched()`); nothing of a stroke reaches React or the store but the count, once, on release.
  - *Box.* A drag that begins with `Shift` held draws a rectangle (a `div` over the canvas, the DOM's own) and on release adds every triangle `gatherBox` finds in it that faces the eye. It does not test what hides what: the bar says so ("A box takes what faces you, also behind other things").
  - *Grow to flat* (a button, and `F` is not used for it: `F` fits the view): `growFlat` with `flat` 2 mm, `degrees` 15, `reach` twice the brush radius, `most` 200,000.
  - *Keep* (a button, and `Enter`): `window.torno.marks.addRegion(...)`, then the note opens (`ctx.openNote`), the set is emptied. A rejection is said at the pointer. *Clear* and `Escape` empty the set.
  - With no scan: "Import a scan first". On a scan whose tree is not there yet: "The scan is still being indexed".
- **The bar** (`RegionBar`, class `regionbar`, `role="toolbar"`, `aria-label="Region"`), while the tool is in hand: "Brush radius" (mm, a field), "Erase" (`aria-pressed`), "Grow to flat", the count ("1,204 triangles" in `num`), "Keep", "Clear", and the line about the box.
- **Drawing.** The set in hand and every kept region of a scan that is drawn are tints over the scan's own positions (`tintIndex`): one `THREE.Mesh` each, `MeshBasicMaterial` at 40 %, `--user-mark` for the person's and `--agent-mark` for the agent's (they are marks), `polygonOffsetFactor: -1`, clipped by the section with the scan. A region's number is a label at its centroid in the layout shown (`MarkLayer`, which is given the scans' transforms); a region whose scan is not drawn, or whose layout is not the one shown, is not drawn, on screen or in a picture. The window fetches a region's bits once (`window.torno.scans.mask`), when the mark first appears.
- **`MarkRow`** shows a region as `M7 region · S1 · 4,812 triangles` with its note, and "Resolve" like any mark.

- [ ] **Step 1: Write the failing unit tests**

`app/src/shared/regions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { grid, meshBin } from '../test/scanFixtures'
import { popcount, regionInLayout, regionStats } from './regions'
import { parseScanMesh } from './scans'

// A sheet of 5 × 5 vertices 10 mm apart: 32 triangles of 50 mm² each, from -20 to 20.
const mesh = parseScanMesh(meshBin(grid(5, 10)))
const bits = (triangles: number[]): Uint8Array => {
  const made = new Uint8Array(4)
  for (const t of triangles) made[t >> 3] |= 1 << (t & 7)
  return made
}

describe('regionStats', () => {
  it('counts, measures and places a region from the mesh', () => {
    // The first cell of the sheet: triangles 0 and 1, the square from (-20, -20) to (-10, -10).
    const stats = regionStats(mesh, bits([0, 1]))!
    expect(stats.triangles).toBe(2)
    expect(stats.area).toBeCloseTo(100, 9)
    expect(stats.local.centroid.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([-15, -15, 0])
    expect(stats.local.bbox).toEqual({ min: [-20, -20, 0], max: [-10, -10, 0] })
    expect(Math.abs(stats.local.plane.normal[2])).toBeCloseTo(1, 9)
    expect(stats.local.plane.rms).toBeLessThan(1e-6)
    expect(regionStats(mesh, bits([]))).toBeNull()
    expect(popcount(bits([0, 1, 9, 31]))).toBe(4)
  })

  it('gives one triangle the plane it lies in', () => {
    const stats = regionStats(mesh, bits([5]))!
    expect(stats.triangles).toBe(1)
    expect(Math.abs(stats.local.plane.normal[2])).toBeCloseTo(1, 9)
    expect(stats.local.plane.rms).toBe(0)
  })
})

describe('regionInLayout', () => {
  it('puts a region where its scan stands, at the size a fit gave the scan', () => {
    const stats = regionStats(mesh, bits([0, 1]))!
    const there = regionInLayout(stats, { t: [100, 0, 5], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], s: 2 })
    expect(there.area).toBeCloseTo(400, 9)
    // (-15, -15, 0) turned a quarter about Z is (15, -15, 0); doubled and moved.
    expect(there.centroid.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([130, -30, 5])
    expect(there.bbox.min.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([120, -40, 5])
    expect(there.bbox.max.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([140, -20, 5])
    expect(Math.abs(there.plane.normal[2])).toBeCloseTo(1, 9)
  })
})
```

`app/src/renderer/viewport/scanPaint.test.ts`:

```ts
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { grid } from '../../test/scanFixtures'
import { TriangleSet, gatherBox, gatherSphere, growFlat, tintIndex } from './scanPaint'

function meshOf(made: { vertices: number[]; triangles: number[] }): { geometry: THREE.BufferGeometry; tree: MeshBVH; centroid(t: number): THREE.Vector3 } {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(made.vertices), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(made.triangles), 1))
  const corner = (t: number, k: number): THREE.Vector3 => new THREE.Vector3().fromArray(made.vertices, made.triangles[t * 3 + k] * 3)
  return { geometry, tree: new MeshBVH(geometry, { indirect: true }), centroid: (t) => corner(t, 0).add(corner(t, 1)).add(corner(t, 2)).divideScalar(3) }
}
const UP = new THREE.Vector3(0, 0, 1)

describe('TriangleSet', () => {
  it('keeps its triangles as the bits of a mask', () => {
    const set = new TriangleSet(12)
    expect(set.bits).toHaveLength(2)
    expect([set.add(0), set.add(9), set.add(9)]).toEqual([true, true, false])
    expect([...set.bits]).toEqual([0b00000001, 0b00000010])
    expect([set.count, set.has(9), set.has(3)]).toEqual([2, true, false])
    expect([set.delete(9), set.delete(9), set.count]).toEqual([true, false, 1])
    expect(new TriangleSet(12, new Uint8Array([3, 0])).count).toBe(2)
    set.clear()
    expect(set.count).toBe(0)
  })
})

describe('gathering triangles', () => {
  const sheet = meshOf(grid(30))

  it('takes those whose middle is within the brush, and only those that face the eye', () => {
    const centre = new THREE.Vector3(0.2, 0.3, 0)
    const got: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, UP, (t) => got.push(t))
    const expected = Array.from({ length: 1682 }, (_, t) => t).filter((t) => sheet.centroid(t).distanceTo(centre) <= 1.2)
    expect(got.sort((a, b) => a - b)).toEqual(expected)
    expect(expected.length).toBeGreaterThan(4)
    const fromBelow: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, new THREE.Vector3(0, 0, -1), (t) => fromBelow.push(t))
    expect(fromBelow).toEqual([])
    const either: number[] = []
    gatherSphere(sheet.tree, sheet.geometry, centre, 1.2, null, (t) => either.push(t))
    expect(either).toHaveLength(expected.length)
  })

  it('takes those inside a box of the screen', () => {
    // Four planes round the column x from 0 to 3, y from -2 to 2, seen from above.
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 3), new THREE.Plane(new THREE.Vector3(0, 1, 0), 2), new THREE.Plane(new THREE.Vector3(0, -1, 0), 2)]
    const got: number[] = []
    gatherBox(sheet.tree, sheet.geometry, planes, new THREE.Vector3(0, 0, 100), (t) => got.push(t))
    const expected = Array.from({ length: 1682 }, (_, t) => t).filter((t) => {
      const c = sheet.centroid(t)
      return c.x >= 0 && c.x <= 3 && c.y >= -2 && c.y <= 2
    })
    expect(got.sort((a, b) => a - b)).toEqual(expected)
  })
})

describe('growFlat', () => {
  it('spreads over what is flat with the set and stops at a step', () => {
    // Flat at 0 up to x = 5, then 10 higher: the cells that climb the step are steep.
    const stepped = meshOf(grid(30, 1, (x) => (x > 5 ? 10 : 0)))
    const set = new TriangleSet(1682)
    gatherSphere(stepped.tree, stepped.geometry, new THREE.Vector3(-10, 0, 0), 1.5, UP, (t) => set.add(t))
    const before = set.count
    const added = growFlat(stepped.tree, stepped.geometry, set, { flat: 2, degrees: 15, reach: 2 })
    expect(added).toBe(set.count - before)
    // The low part is the 20 columns of vertices from -14.5 to 4.5: 19 cells by 29, two triangles each.
    expect(set.count).toBe(19 * 29 * 2)
    for (let t = 0; t < 1682; t++) if (set.has(t)) expect(stepped.centroid(t).z).toBeLessThan(0.01)
  })

  it('adds no more than it is allowed', () => {
    const sheet = meshOf(grid(30))
    const set = new TriangleSet(1682)
    set.add(0)
    expect(growFlat(sheet.tree, sheet.geometry, set, { reach: 2, most: 100 })).toBe(100)
    expect(set.count).toBe(101)
  })
})

describe('tintIndex', () => {
  it('draws the set and nothing else', () => {
    const set = new TriangleSet(4)
    set.add(1)
    set.add(3)
    expect([...tintIndex(set, [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32])]).toEqual([10, 11, 12, 30, 31, 32])
  })
})
```

Add to `main/marks/describe.test.ts` (with `scan(...)` and an alignment as in `scanTools.test.ts`; the region has `local: { centroid: [-15, -15, 0], bbox: { min: [-20, -20, 0], max: [-10, -10, 0] }, plane: { origin: [-15, -15, 0], normal: [0, 0, 1], rms: 4.2 } }`, `triangles: 4812`, `area: 31000`, note `wiring loom`, layout `print`):

```ts
  it('tells a region where its scan is aligned, and says when that is nowhere', () => {
    const at = { print: { transform: { t: [100, 0, 5], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '' } }
    expect(describeMark(REGION, { scans: [scan('S1', at as never)] })).toBe('M7 region on scan S1: 4,812 triangles, ≈ 31000 mm², centre (85, -15, 5), box 10 × 10 × 0 mm, flat to 4.2 mm about a plane with normal (0, 0, 1): "wiring loom"')
    expect(describeMark(REGION, { scans: [scan('S1')] })).toBe('M7 region on scan S1 (not aligned in print, so it has no place in the model’s frame): 4,812 triangles, ≈ 31000 mm²: "wiring loom"')
    expect(describeMark(REGION)).toBe('M7 region on scan S1 (not aligned in print, so it has no place in the model’s frame): 4,812 triangles, ≈ 31000 mm²: "wiring loom"')
    expect(describeMark({ ...REGION, anchorState: 'orphaned' }, { scans: [] })).toBe('M7 region on scan S1 [its scan is gone]: "wiring loom"')
    // Nothing has checked a region against a build, and nothing needs to.
    expect(describeMark(REGION, { revision: 12, scans: [scan('S1', at as never)] })).not.toContain('not checked')
  })

  it('gives a region as data in the frame of its layout, never in that of its scan', () => {
    const at = { print: { transform: { t: [100, 0, 5], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: {}, at: '' } }
    const told = markData(REGION, 12, [scan('S1', at as never)]) as Record<string, unknown>
    expect(told).toMatchObject({ id: 'M7', kind: 'region', scan: 'S1', triangles: 4812, area: 31000, centroid: [85, -15, 5] })
    expect(told.local).toBeUndefined()
    expect((markData(REGION, 12, [scan('S1')]) as Record<string, unknown>).centroid).toBeUndefined()
  })
```

Add to `main/marks/store.test.ts`: a region is kept with main's numbers whatever the caller sent in their place (`triangles: 999999` given, `stats.triangles` kept); `before` is called with the new id before the file is written (the test's `before` reads `marks.json` and finds no such mark yet); when `before` rejects there is no mark, nothing was told, and the next mark gets that number; `orphanRegions('bracket', 'S1')` marks the regions of S1 and no other mark. Add to `main/marks/file.test.ts`: a region loads whole; one with `scan: 'lid'`, with `triangles: 0` or with a `local.centroid` that is not three finite numbers is dropped. Add to `main/scans/store.test.ts`: `writeMask` writes `<id>/<mark>.mask` with the header and the bits, refuses bits of another length ("M7 has 3 bytes of triangles, and S1 has 12 triangles: 2 bytes"), `mask` reads it back, `removeMask` removes that file only, and removing the scan removes its masks with its folder. Add to `shared.test.ts`: `markAnchors(region)` is `[]`, `translated(region, [1, 2, 3])` is the same mark, `isUnchecked(region, 12)` is false. Add to `reanchor.test.ts`: a check of marks that include a region asks the kernel nothing of it and stamps its `checkedRevision`.

`app/src/renderer/tools/region.test.ts` (a fake context as in `tools/align.test.ts`, with a real `MeshBVH` over `grid(30)` behind `pickScan` and `paintScan`): a press and three moves over the scan add triangles and call `touched()` each time, and turn navigation off until the release; with "Erase" on the same strokes take them out; `Alt` held leaves the press to the camera; `Enter` calls `addRegion` with the scan, the layout, the revision, the camera and bits whose `popcount` is the set's count, then `openNote`, and empties the set; a rejection is said at the pointer and the set is kept; `Escape` empties it; no scan says "Import a scan first".

Run: `pnpm -C app exec vitest run src/shared src/main/marks src/main/scans src/renderer/viewport/scanPaint.test.ts src/renderer/tools/region.test.ts` Expected: FAIL.

- [ ] **Step 2: Implement** `shared/regions.ts` (`regionStats`: one pass over the set's triangles for the area, the area-weighted centroid, the box of their corners and the centroids with their areas; `fitPlane` of those, or, when it is null, the first triangle's own normal with `rms: 0`; `regionInLayout`: `apply` for the centroid and the plane's point, `rotate` for its normal, the box of the eight corners moved, `area · s²`, `rms · s`), the mark kind in `shared/marks.ts` and `main/marks/*`, the masks in `ScanStore`, `marks:addRegion`, `scans:mask`, the removal rules, `describeMark` and `markData`.

`gatherSphere` is `tree.shapecast({ intersectsBounds: (box) => box.intersectsSphere(sphere), intersectsTriangle: (triangle, index) => { … return false } })` with the centroid test and `triangle.getNormal(n).dot(towards) > 0`. `growFlat`: fit the plane of the set's centroids (weights their areas; a set of one or two triangles uses the first's normal); then a queue of the set's triangles: for each, `gatherSphere` round its centroid with `reach`, taking a triangle that is not in the set, whose centroid is within `flat` of the plane and whose normal is within `degrees` of the plane's (either way round); each one taken joins the queue; stop at `most`.

Run the same command. Expected: PASS.

- [ ] **Step 3: Write the failing e2e**

`app/e2e/region.spec.ts` (head as `e2e/scan.spec.ts`, with `connect`, `call`, `prompt` and `said` as in `e2e/mcp.spec.ts`, and `import type { RegionMark } from '../src/shared/marks'`):

```ts
test('a part of a scan is painted, named, kept as a mark with its mask, told to the agent and left out of a clash', async () => {
  await open('hollow')
  // A sheet inside the lid, which is 2 mm thick from z = 38: all 900 of its vertices are in it.
  const file = join(root, 'sheet.stl')
  writeFileSync(file, stl(grid(30, 1, () => 39)))
  await pickFile(file)
  await page.getByRole('button', { name: 'Import scan…' }).click()
  await expect.poll(async () => (await scans())[0]?.ready).toBe(true)
  // The lid is in the way of the sheet: it is switched off to paint.
  await page.locator('.layer-row[data-layer="lid"]').getByRole('button', { name: 'Show lid' }).click()
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await page.keyboard.press('b')
  const bar = page.locator('.regionbar')
  await expect(bar).toBeVisible()
  await bar.getByRole('textbox', { name: 'Brush radius' }).fill('3')
  await bar.getByRole('textbox', { name: 'Brush radius' }).press('Enter')
  const canvas = (await page.locator('.viewport-canvas canvas').first().boundingBox())!
  const at = async (local: [number, number, number]): Promise<[number, number]> => {
    const [fx, fy] = await page.evaluate((local) => window.__tornoTest!.projectScan('S1', local), local)
    return [canvas.x + fx * canvas.width, canvas.y + fy * canvas.height]
  }
  // One stroke along the sheet's left side, from front to back.
  await page.mouse.move(...(await at([-10, -8, 39])))
  await page.mouse.down()
  for (const y of [-4, 0, 4, 8]) await page.mouse.move(...(await at([-10, y, 39])), { steps: 4 })
  await page.mouse.up()
  await expect(bar).toContainText(/\d+ triangles/)
  const camera = await page.evaluate(() => window.__tornoTest!.camera())
  await bar.getByRole('button', { name: 'Keep' }).click()
  // The stroke turned no camera, and the note of the new mark is open.
  expect(await page.evaluate(() => window.__tornoTest!.camera())).toEqual(camera)
  await page.keyboard.type('wiring loom, can be pushed aside')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).marks[0]).toMatchObject({ id: 'M1', kind: 'region', scan: 'S1', status: 'draft', author: 'user', note: 'wiring loom, can be pushed aside' })
  const region = (await state()).marks[0] as RegionMark
  expect(region.triangles).toBeGreaterThan(20)
  // About a 6 mm band 16 mm long.
  expect(region.area).toBeGreaterThan(60)
  expect(region.area).toBeLessThan(200)
  expect(Math.abs(region.local.plane.normal[2])).toBeCloseTo(1, 6)
  // Its triangles are a file beside the mesh, a bit each; the marks file holds none of them.
  const mask = readFileSync(join(root, 'hollow', '.torno', 'scans', 'S1', 'M1.mask'))
  expect(mask.length).toBe(16 + Math.ceil(1682 / 8))
  expect([...mask.subarray(16)].reduce((sum, byte) => sum + byte.toString(2).split('1').length - 1, 0)).toBe(region.triangles)
  expect(readFileSync(join(root, 'hollow', '.torno', 'marks.json'), 'utf8')).not.toContain('bits')

  // Not aligned: the agent is told the region with no place, and a clash is refused.
  await prompt()
  expect(await said()).toContain('M1regiononscanS1(notalignedinassembly,soithasnoplaceinthemodel’sframe)')
  await expect.poll(async () => (await state()).marks[0].status).toBe('sent')
  await app.evaluate(() => (globalThis as any).__tornoMain.scans.align('hollow', 'S1', 'assembly', { transform: { t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }, steps: ['typed'], frame: { tub: [0, 0, 0], lid: [0, 0, 0] }, at: new Date().toISOString() }))
  const client = await connect('hollow')
  const marks = JSON.parse((await call(client, 'marks')).text).marks
  expect(marks[0].line).toMatch(/^M1 region on scan S1: [\d,]+ triangles, ≈ [\d.]+ mm², centre \(-?[\d.]+, -?[\d.]+, 39\), box /)
  expect(marks[0].local).toBeUndefined()
  const all = JSON.parse((await call(client, 'scan_clash', { part: 'lid' })).text)
  expect(all.inside.count).toBe(900)
  const without = JSON.parse((await call(client, 'scan_clash', { part: 'lid', ignore: ['M1'] })).text)
  expect(without.points.ignored).toBeGreaterThan(10)
  expect(without.inside.count).toBe(900 - without.points.ignored)
  expect(without.reading).toMatch(/, \d+ points of M1 left out/)
  const only = JSON.parse((await call(client, 'scan_deviation', { part: 'lid', region: 'M1', from: 'scan' })).text)
  expect(only.samples).toBe(without.points.ignored)
})

test('a region goes on as a mark when its scan is removed, and says so', async () => {
  await row('S1').getByText('More').click()
  await row('S1').getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
  await expect.poll(async () => (await state()).marks[0].anchorState).toBe('orphaned')
  await expect(page.locator('section.marks')).toContainText('its scan is gone')
  expect(existsSync(join(root, 'hollow', '.torno', 'scans', 'S1'))).toBe(false)
})
```

Run: `pnpm build && pnpm -C app exec playwright test e2e/region.spec.ts` Expected: FAIL (`b` takes no tool).

- [ ] **Step 4: Implement** `regionTool.ts`, `RegionBar`, the palette entry, the tints and the label, the pane's wiring (the region tool in `tools`, the masks fetched when a region mark first appears, `viewport.setRegions`). Then the same command. Expected: PASS, 2 tests.

- [ ] **Step 5: Design pass** with `frontend-design:frontend-design`: `look` pictures of the sheet with a kept region and its number, in light and dark, and the bar's markup beside `.alignbar`'s. The tint must leave the scan's own colours readable under it, and a region of the person's and one of the agent's (made in the test through `__tornoMain.marks.add`) must be told apart at a glance.

- [ ] **Step 6: Suites, commit**

Run all four suites and the typecheck. Expected: pass.

```bash
git add app/src app/e2e/region.spec.ts
git commit -m "A part of a scan is painted and named as a mark, kept as a bitset beside the mesh, told to the agent and left out of a clash when it says so

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: `state.md`, the docs, and the owner's own scan

**Files:**
- Modify: `app/src/main/statefile.ts`, `statefile.test.ts`, `app/src/main/index.ts` (`StateFiles` is given the scans, and told when they change), `README.md`, `CLAUDE.md`
- Nothing else is committed: the sweep's script and its output stay outside the repository.

**Interfaces:**
- Consumes: everything above.
- Produces: `StateFileDeps.scans(objectId: string): Promise<ScanInfo[]>`; `stateText(obj, build, last, marks, scans?: readonly ScanInfo[])`.

- [ ] **Step 1: `state.md` says the scans** (test first)

Add to `statefile.test.ts`:

```ts
  it('lists the scans after the parts, each with how it is aligned in every layout, and tells regions with the marks', () => {
    const text = stateText(OBJ, OK, { revision: 12, scene: SCENE }, [REGION], [scan('S1', { print: BY_PAIRS }), scan('S2')])
    expect(text).toContain(
      ['## Scans', '', 'A scan is a mesh of the real surroundings: nothing from it is exact.', '',
       '- S1 S1.glb: 1,607,144 triangles, 2518 × 2351 × 1494 mm, from m, Y up (assumed); source /dl/S1.glb; aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm); not aligned in assembly.',
       '- S2 S2.glb: 1,607,144 triangles, 2518 × 2351 × 1494 mm, from m, Y up (assumed); source /dl/S2.glb; not aligned in assembly, print.'].join('\n')
    )
    expect(text).toContain('- M7 region on scan S1: 4,812 triangles')
    expect(stateText(OBJ, OK, { revision: 12, scene: SCENE }, [], [])).not.toContain('## Scans')
    expect(text.indexOf('## Scans')).toBeGreaterThan(text.indexOf('## Layouts and parts'))
    expect(text.indexOf('## Scans')).toBeLessThan(text.indexOf('## Marks'))
  })
```

(`OBJ`, `OK` and `SCENE` are that file's own; `scan`, `BY_PAIRS` and `REGION` as in `scanTools.test.ts`, with `SCENE.layouts` being `['assembly', 'print']`.) A source that is `missing` or `changed` says `source /dl/S1.glb (missing)`; a stale alignment has its `staleText` after it; a mesh that is gone says `MESH MISSING` in place of the triangles. Implement; in `index.ts`: `scans: (objectId) => scans.list(objectId)` and `scans.on('changed', ({ objectId }) => stateFiles.changed(objectId))`.

Run: `pnpm -C app exec vitest run src/main/statefile.test.ts` Expected: PASS.

- [ ] **Step 2: README**

- "Requirements": one line: "Importing a scan needs `trimesh` and `pillow`, which uv fetches the first time a scan is imported (the kernel itself does not need them)."
- "The window": a new subsection "### Scans" after "Pointing and marks": what a scan is here; importing by the button or by dropping a file on the view (GLB, glTF, OBJ, PLY, STL); that the source is only read and is found again by its path, and that the scan goes on working from `.torno/scans/<id>/mesh.bin` when the source moves; the row (size in mm, what was assumed, the chips, eye, opacity, "More": unit, up axis, colours, remove); that the section cuts a scan open; the Align tool (`L`): floor, pairs (clicked or typed model ends, residuals, "Fit size too", the unit hint), nudge (`G`, `R`, typed values), one alignment per layout, "not aligned here", "check alignment" and what triggers it; the Region tool (`B`): brush, erase, box, grow to flat, keep; and this paragraph, verbatim:

  > A scan is checked only against parts that are where the model puts them. A `print` layout whose parts overlap is spread by torno for display, and every part it moved is refused by the scan checks; a part it did not move (the first of the row) is answered, but a print layout poses parts for the bed, so the answer means something only if the model leaves that part where it is mounted. To check a fit against the car, the room or the machine, give the model an `assembly(p)` that places the parts as mounted, and align the scan in that layout.

- "What the agent gets": the three tools with one example reply each (the `scan_clash` and `scan_deviation` replies of this plan's "Shared contracts", wrapped as Task 7 wraps them), what `measure`, `look`, `show`, `section` and `scene` gained, the "Scans:" line of the prompt, and "nothing from a scan is exact" with what that means for `exact` and `≈`.
- "Files torno writes": `scans.json`, `scans/<id>/mesh.bin` (left out of git by `scans/.gitignore`), `scans/<id>/<mark>.mask`, and `scans` in `scene.json`.
- "Tests": nothing new to run; `e2e/scan.spec.ts`, `align.spec.ts`, `region.spec.ts` are named.
- "Next": Milestone 4 is taken out.

- [ ] **Step 3: CLAUDE.md**

In the first section, `app/`'s line gains "the scans (`src/main/scans`)" and `kernel/`'s "and imports scans, in a process of its own (`python -m torno_kernel.scans`)". In "Marks": the first bullet names the region as a seventh kind; the tools list gains `scans`, `scan_clash`, `scan_deviation`; "Tools and keys" gains `L` align and `B` region. A new section after "Section":

```markdown
## Scans

- A scan is one mesh in millimetres and Z up, `<object>/.torno/scans/<id>/mesh.bin` (layout: `kernel/src/torno_kernel/scanfile.py`, read alike by the kernel, main and the window through `shared/scans.ts` `parseScanMesh`). What is drawn is what is picked, painted and checked. A triangle's number is its place in that file and never changes while the file is the same.
- The source is only read: referenced by absolute path, size, modification time and SHA-256, never copied, moved or written. The scan works from `mesh.bin` when the source is gone (`sourceState`), and says what to do when `mesh.bin` is gone too (`meshState`).
- Import is a process of its own, `python -m torno_kernel.scans import|convert` (`main/scans/importer.ts`, `kernel/client.ts` `scanCommand`): never the supervisor, never a build worker, never the window. trimesh and pillow are the extra `scans` of the kernel package, asked for by that command only; the kernel starts without them. Its stdout is one line of JSON, its last.
- Unit and up axis are assumed from the format and the size (`scans.guess`), shown on the row, and changed there by `convert`, which rewrites `mesh.bin` from itself and drops the scan's alignments. Above 2,000,000 triangles the import reduces the mesh and says so.
- Main is the only writer of `.torno/scans.json` and of `.torno/scans/` (`src/main/scans/store.ts`): one change at a time per object, written atomically before it is told. Ids are `S1`, `S2`, … per object, never reused. Visibility, opacity and colour mode are view state, in `scene.json` (`scans`).
- One transform per layout (`Scan.alignments`), scan frame to object frame, `p' = s · R(q) · p + t`. No transform for a layout: "not aligned" there, drawn where it was imported, and refused by `scan_clash`, `scan_deviation`, `section`'s `scan` and a scan end of `measure`. The maths is `shared/align.ts`, pure, for both sides; main works out every residual and rms itself (`ScanStore.align`).
- After every build and every alignment the alignments are checked (`main/scans/alignCheck.ts`): the model points an alignment was tied to are looked for on their parts again, and `Part.arranged` is compared with what it was. What is found is told (`staleText`); nothing is ever re-fitted.
- A part torno moved for display is refused by the scan checks (`scanSpread`), naming the layouts that place it as the model does, or `def assembly(p)`.
- The kernel's scan queries (`scanclash.py`) run in the live build worker, which is given paths and never looks for a file: inside or outside by ray parity on the part's own tessellation, distances from a `cKDTree` over that mesh sampled every millimetre (scipy, from the workspace, imported when first needed), the points an answer names taken again on the B-rep. At most 200,000 candidates, 32 points retaken, 15 s; what was thinned or left undone is in `sampling`.
- **Nothing from a scan is ever said to be exact.** Every reply has `exact: false`, `approximate` and `≈`, the revision, the layout and the alignment with its rms.
- A region is a mark of kind `region`: its triangles are `<id>/<mark>.mask`, a bit each; its numbers (`REGION_KEYS`) are main's, worked out from the mesh (`shared/regions.ts`), held in the scan's own frame under `local` and told in the object frame of its layout.
- In the window a scan's bounds tree is built in a worker (`viewport/scanBvh.worker.ts`), indirect, so triangle numbers hold; a scan is drawn before it can be pointed at. Nothing of a brush stroke or of a drag of the gizmo goes through React or the store.
- A scan and a picture coloured by distance use tokens of their own (`--scan-plain`, `--deviation-*`); a region is a mark and is tinted in its author's mark colour.
- Tests make their scans in code (`kernel/tests/scanfix.py`, `app/src/test/scanFixtures.ts`). No scan file is committed.
```

- [ ] **Step 4: The owner's scan, by hand, in a hidden window**

On a temp copy, never on `/home/luisgonc/objects`, and never writing to `/home/luisgonc/Downloads`:

```sh
tmp=$(mktemp -d /tmp/torno-m4-XXXXXX)
cp -r /home/luisgonc/objects/common /home/luisgonc/objects/micra-intake /home/luisgonc/objects/pyproject.toml /home/luisgonc/objects/uv.lock "$tmp/"
ln -s /home/luisgonc/objects/.venv "$tmp/.venv"
mkdir "$tmp/scans" && cp "/home/luisgonc/Downloads/Telegram Desktop/Micra.glb" /home/luisgonc/objects/micra-spoiler/MikraK11_Hatch.stl "$tmp/scans/"
pnpm build
```

Drive it with a throwaway Playwright spec written as `app/e2e/sweep.local.spec.ts` (launch as every e2e does: `TORNO_TEST=1`, `TORNO_AGENT_CMD` the stand-in, `TORNO_WORKSPACE=$tmp`, `TORNO_BUILD_TIMEOUT=900`; timeout 20 minutes), run with `pnpm -C app exec playwright test e2e/sweep.local.spec.ts`, and **deleted before the commit** (`git status` must not show it). Pictures come from `window.__tornoTest.look` only and are written to `$tmp/pictures/` and looked at one by one. It does, and the report records, with numbers:

1. Open `micra-intake`; wait for the build. Import `$tmp/scans/Micra.glb` through the panel (`pickFile`): the seconds from the click to `loaded`, and from `loaded` to `ready`; `timeScanPicks(200)` (expected `how: worker`, mean well under 1 ms: E3 measured 0.07 ms in node); the size of `mesh.bin` (expected 34,274,960 bytes); the row's text (expected "2518 × 2351 × 1494 mm, from m, Y up (assumed)").
2. `window.__tornoTest.timeFrames(20)` with the scan hidden, shown at 100 % and at 50 %: the mean and the worst. **If the mean with the scan is over 33 ms, stop and report it before going on:** the cure (drawing the scan from a reduced index while the camera moves) is a decision for the controller, not for this task.
3. A `look` from `iso`, `top` and the person's view, with and without the scan: is the baked colour recognisable as the engine bay, is the part still the loudest thing?
4. Align in `print` with the owner's own frame, typed: the transform comes from `fitPairs` on four points put through the table of `micra-intake/docs/2026-10-06-micra-intake-design.md` ("Tray frame"), lowered by `Params().pad_t` (the print layout stands the tub that much lower), given to `__tornoMain.scans.align` with `steps: ['typed']`. Then through a real MCP client: `scans`; `scan_clash {part: "airbox-tub"}` (seconds, counts, clusters, the reading; E2 found 13,000 to 50,000 candidates and, with a first guess of the frame, 127 to 2,168 points inside: look at where they are before believing either); `scan_clash {part: "airbox-lid"}` (expected: the refusal naming `def assembly(p)`); `scan_deviation {part: "airbox-tub", from: "scan", within: 30}`; `look` with `scanColour: {part: "airbox-tub"}`; `section {plane: {axis: "y", at: 40}, scan: "S1"}`. Every reply is saved; every picture is looked at.
5. Align again by the tool, with real pointer events: a floor on the tray plate, then four pairs between the scan and the tub's mounting holes; record the rms and how far the result is from step 4's transform (translation in mm, rotation in degrees).
6. Paint a region over the washer bottle with the brush, keep it, note it; one prompt to the stand-in agent: the context the hook printed (the "Scans:" line and the region's line), copied into the report.
7. Move `$tmp/scans/Micra.glb` to another name: the row says "source missing", everything still works; delete `.torno/scans/S1/mesh.bin`: the row says "mesh missing" and `scan_clash` is refused with the path.
8. Import `MikraK11_Hatch.stl` into the same object: seconds, the plain grey look, both scans on screen, frame time again.
9. Memory: `process.memoryUsage().rss` of main (`app.evaluate`) before the import, after it, and after the scan is removed; the renderer's `performance.memory.usedJSHeapSize` at the same three moments.

The report lists what read badly, what was slower than this plan says, and every sentence the app said that a person would not understand.

- [ ] **Step 5: One check with the real CLI, by the controller, only on the owner's word**

Not run by an implementer and not by any test: it spends the owner's subscription. On the same temp copy, hidden, with the scan aligned as in step 4 of the sweep, one prompt: `Does the airbox tub run into anything in the scan of the engine bay, and how near does the bay come to it? Use the torno tools. Do not edit any file and do not write a script.` Record the context the hook sent, the tools called and the answer; judge whether the agent said nothing of the scan as exact, and whether it tried the lid and understood the refusal.

- [ ] **Step 6: All suites, commit**

Run: `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`, `pnpm -C app typecheck`. Expected: all pass. `git status`: no `sweep.local.spec.ts`, nothing under `/home/luisgonc/objects` touched (`find /home/luisgonc/objects -newer "$tmp" -not -path '*/.git/*'` prints nothing; do not run a plain `git status` there, which rewrites that repository's index: `GIT_OPTIONAL_LOCKS=0 git -C /home/luisgonc/objects status --short` if one is wanted).

```bash
git add app/src/main/statefile.ts app/src/main/statefile.test.ts app/src/main/index.ts README.md CLAUDE.md
git commit -m "Docs: scans, their alignment and their checks; state.md lists them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Order

Task 1 first (it also amends the spec). Task 6 needs only Task 1 and can run beside Tasks 2 to 5. Task 2 needs 1; Task 3 needs 2; Task 4 needs 3; Task 5 needs 4. Task 7 needs 5 and 6. Task 8 needs 7 (its tools already pass masks) and 4. Task 9 is last. The scan is on screen at the end of Task 3; the agent can use it at the end of Task 7.

## Self-review

- **Spec coverage.** Section 8's import (Task 1 and 2), display (3), alignment in its three ways (4 and 5), the transform kept with the object (2 and 5); section 5's region (8); section 4's and 6's `scan_clash` (6 and 7), with `scan_deviation` and `scans` added by ruling R7; section 7's "scans are clipped without caps" (3) and R9's `scan` in `section` (6 and 7); `state.md` (9); success criterion 4 (the sweep, 9). Deferred as the spec defers it: ICP. Departures from the spec's text are Decisions D1, D5, D6, D9, D10 and rulings R2 and R3, written into the spec by Task 1.
- **Rulings.** R1: Tasks 1, 2. R2: Task 1 (`reduce`), 3. R3: Task 2, 3. R4: Tasks 2, 5, 7 (`scanFor`, `scanSpread`), 9 (README paragraph, the sweep on `micra-intake`). R5: Tasks 4, 5. R6: Task 8. R7: Task 7. R8: Task 6. R9: Tasks 3, 6, 7. R10: Tasks 3, 5, 8.
- **Review Focus.** 1: Task 1 (`test_what_is_assumed_of_a_file`, `test_unit_and_up_are_changed_afterwards_without_the_source`), Task 3 (the row, the e2e that changes the unit with the source deleted), Task 4 (`unitHint`), Task 5 (`sizeNote`). 2: Task 2 (`store.test.ts`), Task 3 (e2e), Task 9 (sweep 7). 3: Task 7 (`PRINT_ONLY`), Task 5 (a model end on a moved part is refused), Task 9 (sweep 4). 4: Task 4 (the 200,000-triangle e2e, `how: 'worker'`), Task 9 (sweep 1, 2, 8). 5: Task 5 (`alignCheck.test.ts`, the `spread` e2e), Task 7 (the stale text in the reply and the context).
- **Verified before writing.** The Python of Tasks 1 and 6 and the TypeScript of `shared/align.ts` were run against the tests given here, in a scratch copy: 47 pytest and 16 vitest tests pass. Nothing else in this plan has been run: the other test files are specifications, and a test here that turns out to contradict the behaviour written beside it is to be reported, not bent.
- **Types.** `ScanTransform`, `ScanAlignment`, `NewAlignment`, `ScanInfo`, `ScanView`, `ScanHit`, `RegionMark.local`, `REGION_KEYS`, the kernel's `scan` argument (`id`, `path`, `transform`, `ignore`, `only`) and the replies' keys (`inside.count`, `deepest.depth`, `nearest.distance`, `sampling`, `exact`) are spelt the same in "Shared contracts", in the tasks that produce them and in the tests that read them.


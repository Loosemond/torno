# Torno Milestone 1 "Loop" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a workspace of build123d objects, see the parts rebuild on every save, and run a Claude Code session beside the viewport that can call `scene` and `look`.

**Architecture:** Electron main (TypeScript) owns the window, the file watcher, the PTY session, an HTTP server for MCP and hooks, and a client for the Python kernel. The kernel is a supervisor that forks one worker per build and sends tessellated parts as one binary frame. The renderer is React + Zustand around an imperative three.js viewport.

**Tech Stack:** Electron 44, electron-vite, React 19, Zustand 5, three 0.186, @xterm/xterm 6, node-pty 1.1, @modelcontextprotocol/sdk 1.32, zod 4, chokidar, vitest, Playwright. Python 3.12, build123d 0.13, ocp-tessellate 3.5, pytest, uv. pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (sections 3, 4, 6, 7, 10, 11, 12). Working spike code to consult: `/tmp/claude-1000/-home-luisgonc-projects-torno/473eeaff-8b21-4275-9442-2de6f3ef4ec1/scratchpad/spike-kernel/` (`klib.py`, `q4_fork.py`, `q5.py`) and `.../scratchpad/spike-shell/` (`main.cjs`, `server.cjs`, `renderer.ts`, `settings.json`, `mcp-config.json`, `package.json`). The spike directories are on tmpfs and may be gone; the plan repeats what matters.

Left for Milestone 2, though the spec lists them: `torno_scene()` and the `torno` helper package, the per-build contact sheet, `.torno/state.md`, picking, and more than one session per object.

How this plan is written: each task gives files, exact interfaces and the tests to write. Write each listed test first, watch it fail, then implement. Code is spelled out only where a spike showed a trap.

## Global Constraints

- Never write inside a user workspace except under `<object>/.torno/`. Never run `uv sync` there: always `uv run --no-sync`.
- The kernel supervisor only imports. It never loads a model, builds, tessellates or answers a query. Workers never fork.
- Kernel stdout carries protocol frames only. Model output goes to a captured buffer.
- Units are millimetres, Z up. Coordinates crossing a process boundary are in the object frame unless named `local`.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`. No per-frame state in React.
- HTTP server binds `127.0.0.1` only, on an OS-assigned port.
- Images for the agent: long edge at most 2000 px, default 1280.
- Do not copy nerv's look: no black/red/amber, no condensed uppercase labels, no corner-tick frames. Follow spec section 10 and the tokens in Task 4.
- UI text is sentence case. Every number and ref is set in the monospace face.
- Tests must not open a visible window: `show: false` when `TORNO_TEST=1`.
- Commit after every task with a message describing the change, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A model that prints to stdout** (most do, via `report`). Expected: the build succeeds and the text appears in the build output, with no protocol corruption. Test in Task 3.
2. **A save while a build is running** (airbox takes 30 s). Expected: the running build is cancelled and exactly one new build starts; the UI never shows the cancelled build's result. Tests in Tasks 3 and 5.
3. **A model that segfaults or hangs.** Expected: a failed build with a clear reason within the timeout, previous parts still on screen, and the next save builds normally. Tests in Tasks 3 and 5.
4. **An object folder with no model, two candidate models, or a model with no scene.** Expected: a plain message naming what was looked for, not a crash. Tests in Tasks 1 and 5.
5. **`look` or `scene` called before the first successful build, or with an unknown part name.** Expected: an MCP error result whose text names the valid parts or says no build exists. Test in Task 9.

## Shared contracts

These are fixed here so tasks can proceed in parallel.

### Kernel frame

`u32 BE headerLen | u32 BE blobLen | header (UTF-8 JSON) | blob`. Both directions. `blobLen` is 0 when there is no blob.

### Kernel messages

Requests (main → kernel):

```json
{"id": 1, "op": "build", "dir": "/abs/object", "model": "bracket.py", "timeout": 300}
{"id": 2, "op": "query", "name": "describe", "args": {"ref": "assembly:base/F0"}}
{"id": 3, "op": "cancel"}
{"id": 4, "op": "shutdown"}
```

Replies and events (kernel → main):

```json
{"event": "ready", "versions": {"build123d": "0.13.0", "python": "3.12.11"}}
{"id": 1, "event": "build.started"}
{"id": 1, "ok": true, "scene": { ...Scene... }}            // + blob
{"id": 1, "ok": false, "error": {"kind": "exception", "message": "...", "traceback": "...", "output": "..."}}
{"id": 2, "ok": true, "result": { ... }}
```

`error.kind` is one of `exception`, `no_model`, `no_scene`, `crash`, `timeout`, `cancelled`, `no_build` (query with no live worker), `bad_ref`, `bad_request`.

### Scene (TypeScript, `app/src/shared/scene.ts`; the Python side emits the same JSON)

```ts
export interface Buf { offset: number; length: number }        // bytes into the blob; offset % 4 === 0
export interface PartMesh {
  vertices: Buf          // float32 xyz, part-local
  normals: Buf           // float32 xyz
  triangles: Buf         // uint32, 3 per triangle
  edges: Buf             // float32, 6 per segment (x1 y1 z1 x2 y2 z2), part-local
  trianglesPerFace: Buf  // uint32, one per face, in face order
  segmentsPerEdge: Buf   // uint32, one per edge, in kernel edge order
  faceTypes: Buf         // uint32 GeomAbs_SurfaceType
  edgeTypes: Buf         // uint32 GeomAbs_CurveType
}
export interface Part {
  key: string            // `${layout}:${name}`, unique in a scene
  name: string
  layout: string         // "assembly" | "print" | "main"
  loc: { t: [number, number, number]; q: [number, number, number, number] }  // local → object frame, quaternion xyzw
  bbox: { min: [number, number, number]; max: [number, number, number] }      // object frame, from the mesh
  volume: number         // mm³, exact
  faceCount: number
  edgeCount: number
  triangleCount: number
  valid: boolean
  hash: string
  mesh: PartMesh
}
export interface Scene { model: string; layouts: string[]; parts: Part[]; seconds: number; output: string }
```

### Build state (`app/src/shared/build.ts`)

```ts
export type BuildStatus = 'idle' | 'building' | 'ok' | 'failed'
export interface BuildError { kind: string; message: string; traceback?: string; output?: string }
export interface BuildState {
  objectId: string
  status: BuildStatus
  revision: number            // last successful build; 0 if none
  startedAt?: number          // ms epoch, while building
  seconds?: number            // duration of the last finished build
  error?: BuildError          // when failed
  stale: boolean              // true when the parts on screen are older than the latest attempt
}
```

### Workspace (`app/src/shared/workspace.ts`)

```ts
export interface ObjectInfo { id: string; name: string; dir: string; model: string | null; problem?: string }
export interface WorkspaceInfo { root: string; hasProject: boolean; objects: ObjectInfo[] }
```

`id` is the folder name. `hasProject` is true when `<root>/pyproject.toml` exists.

### View and look (`app/src/shared/view.ts`)

```ts
export type ViewName = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
export interface Camera { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; ortho: boolean; fov: number; zoom: number }
export interface ViewState { objectId: string; layout: string; camera: Camera; visible: string[] /* part keys */ }
export interface LookRequest { view?: 'current' | ViewName | Camera; layout?: string; parts?: string[] /* names */; size?: number }
export interface LookResult { png: Uint8Array; width: number; height: number; caption: string }
```

### Preload bridge (`window.torno`, `app/src/shared/bridge.ts`)

```ts
export interface TornoBridge {
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    pick(): Promise<WorkspaceInfo | null>            // folder dialog
    open(root: string): Promise<WorkspaceInfo>
  }
  object: {
    open(id: string): Promise<BuildState>            // starts watching and building
    rebuild(id: string): Promise<void>
    onBuild(cb: (s: BuildState) => void): () => void
    onScene(cb: (m: { objectId: string; revision: number; scene: Scene; blob: ArrayBuffer }) => void): () => void
  }
  view: {
    report(v: ViewState): void
    onLook(cb: (m: { id: number; request: LookRequest }) => void): () => void
    lookReply(id: number, result: LookResult | { error: string }): void
  }
  session: {
    start(objectId: string, opts?: { resume?: boolean }): Promise<{ sessionId: string; cols: number; rows: number }>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    stop(sessionId: string): Promise<void>
    onData(cb: (m: { sessionId: string; data: string }) => void): () => void
    onStatus(cb: (m: { sessionId: string; status: SessionStatus }) => void): () => void
  }
}
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'exited'
```

---

### Task 1: Kernel package, frame codec, model loading

**Files:**
- Create: `kernel/pyproject.toml`, `kernel/src/torno_kernel/__init__.py`, `kernel/src/torno_kernel/frames.py`, `kernel/src/torno_kernel/loader.py`
- Create fixtures: `kernel/tests/fixtures/ws/bracket/bracket.py`, `.../ws/bracket/test_bracket.py` (empty), `.../ws/plain/plain.py`, `.../ws/broken/broken.py`, `.../ws/empty/README.md`, `.../ws/two/a.py`, `.../ws/two/b.py`, `.../ws/noscene/noscene.py`, `.../ws/chatty/chatty.py`
- Test: `kernel/tests/test_frames.py`, `kernel/tests/test_loader.py`

`pyproject.toml`: name `torno-kernel`, `requires-python = ">=3.11,<3.13"`, dependencies `ocp-tessellate>=3.5,<4` and `numpy`; dev group `build123d==0.13.0`, `pytest`; `src` layout with hatchling. build123d is a dev dependency only: at run time it comes from the user's workspace.

Fixtures:
- `bracket.py`: frozen `@dataclass Params` with `width: float = 40`; `assembly(p)` returns `{"base": Box(40, 30, 5), "post": Pos(0, 0, 12.5) * Cylinder(4, 20)}`; `printables(p)` returns the base as is and the post rotated 90° about X and moved to `Pos(60, 0, 4)`; `if __name__ == "__main__": raise SystemExit("must not run")`.
- `plain.py`: module level `plate = Box(20, 20, 2)` and `_hidden = Box(1, 1, 1)`, no functions.
- `broken.py`: `assembly` raises `ValueError("wall too thin")`.
- `noscene.py`: defines only `def helper(): ...` and `x = 3`.
- `chatty.py`: like `plain.py` but prints `"report line"` to stdout at import and inside `assembly`.
- `two/`: two non-test `.py` files. `empty/`: no `.py`.

**Interfaces:**
- Produces `frames.write_frame(fp, header: dict, blob: bytes = b"") -> None`, `frames.read_frame(fp) -> tuple[dict, bytes] | None` (None on clean EOF; raises `EOFError` on a truncated frame).
- Produces `loader.choose_model(dir: Path) -> Path` raising `LoadError("no_model", msg)`; `loader.load_scene(dir: Path, model: str) -> dict[str, dict[str, Shape]]` mapping layout → name → shape, raising `LoadError(kind, message, traceback="")`.

Loading rules (spec section 4):
1. Insert `dir` at `sys.path[0]`, load with `importlib.util.spec_from_file_location`, register in `sys.modules` before `exec_module` (dataclasses need it).
2. If the module has `Params` and `assembly` and/or `printables`/`printable`: call `Params()`, then `assembly(p)` → layout `assembly`, `printables(p)` or `printable(p)` → layout `print`.
3. Otherwise collect module-level names not starting with `_` whose value is a build123d `Shape` with at least one solid → layout `main`.
4. Nothing found → `LoadError("no_scene", "bracket.py defines no assembly(), printables() or top-level shapes")`.
- `choose_model`: top-level `*.py` not matching `test_*.py`, `*_test.py` or `conftest.py`. Zero → `no_model` "no model file in <dir>"; more than one → `no_model` naming them.
- An exception in the model → `LoadError("exception", str(e), traceback)`, with the traceback trimmed to frames from the model file onward.

- [ ] **Step 1:** Scaffold the package and fixtures; `cd kernel && uv sync` creates the dev venv.
- [ ] **Step 2:** Write `test_frames.py`: round trip header and blob through `io.BytesIO`; two frames back to back; `read_frame` returns None at EOF; raises `EOFError` on a frame cut mid-blob; a 3 MB blob survives.
- [ ] **Step 3:** Write `test_loader.py`: bracket gives layouts `assembly` and `print` each with `base` and `post`, and does not run `__main__`; plain gives `main` with only `plate`; broken raises kind `exception` with "wall too thin" and a traceback mentioning `broken.py`; noscene raises `no_scene`; `choose_model` picks `bracket.py` and ignores `test_bracket.py`; `empty` and `two` raise `no_model` with the candidates named.
- [ ] **Step 4:** Run `uv run pytest -q`; confirm the failures are missing-module failures.
- [ ] **Step 5:** Implement `frames.py` and `loader.py`; run until green.
- [ ] **Step 6:** Commit.

### Task 2: Tessellation to a scene payload

**Files:**
- Create: `kernel/src/torno_kernel/tess.py`, `kernel/src/torno_kernel/topo.py`
- Test: `kernel/tests/test_tess.py`

**Interfaces:**
- Consumes `load_scene` output.
- Produces `tess.build_scene(layouts: dict[str, dict[str, Shape]], model: str) -> tuple[dict, bytes, dict[str, Shape]]`: the Scene JSON dict (without `seconds` and `output`), the blob, and `shapes` mapping part key → shape for queries.
- Produces `topo.faces(shape) -> list[TopoDS_Face]`, `topo.edges(shape) -> list[TopoDS_Edge]` in the kernel's canonical order.

Notes from the spike:

```python
from ocp_tessellate.convert import to_ocpgroup, tessellate_group
group, instances = to_ocpgroup(*shapes, names=names)
meshed, tree, mapping = tessellate_group(group, instances, kwargs={"deviation": 0.1, "angular_tolerance": 0.2})
# tree["parts"][i]: {"name", "shape": {"ref": j}, "loc": [[tx,ty,tz],[qx,qy,qz,qw]], ...}
# meshed[j]: vertices/normals float32 flat, triangles int32 flat, edges float32 (2*nseg, 3),
#            triangles_per_face, segments_per_edge, face_types, edge_types int32
```

- Tessellate each layout separately so names can repeat across layouts.
- Vertices are part-local; `loc` carries the pose. Compute `bbox` by applying `loc` to the vertices (numpy), not from `tree["bb"]`.
- Convert int32 arrays to uint32 and flatten `edges` to 6 floats per segment. Pad the blob so every buffer starts on a 4-byte boundary.
- `topo.edges` uses `TopExp.MapShapes` over `TopAbs_EDGE` (via `ocp_tessellate.ocp_utils` shims for OCP 8 names) so the count equals `len(segments_per_edge)`, including degenerate edges. `topo.faces` likewise over `TopAbs_FACE`; its order equals `part.faces()`.
- `volume` is `shape.volume`; `valid` is `shape.is_valid`; `hash` is the `cache_id` from `mapping` when present, otherwise sha256 of the vertex bytes.

- [ ] **Step 1:** Write `test_tess.py` on the bracket fixture: four parts with keys `assembly:base`, `assembly:post`, `print:base`, `print:post`; for every part `sum(trianglesPerFace) == triangleCount == len(triangles)/3`, `len(trianglesPerFace) == faceCount == len(topo.faces(shape))`, `len(segmentsPerEdge) == edgeCount == len(topo.edges(shape))`; every `Buf.offset % 4 == 0` and within the blob; `assembly:base` bbox is (-20, -15, -2.5) to (20, 15, 2.5) within 1e-3; `assembly:post` bbox spans z 2.5 to 22.5 (pose applied); `assembly:base` volume is 6000 within 1e-6; the scene dict passes `json.dumps`.
- [ ] **Step 2:** Add a test with a sphere-topped part (`Cylinder(5, 10) + Pos(0, 0, 5) * Sphere(5)`) asserting the edge count equality still holds (degenerate edges).
- [ ] **Step 3:** Run, see failures, implement, run until green.
- [ ] **Step 4:** Commit.

### Task 3: Supervisor, forked workers, protocol

**Files:**
- Create: `kernel/src/torno_kernel/__main__.py`, `kernel/src/torno_kernel/supervisor.py`, `kernel/src/torno_kernel/worker.py`, `kernel/src/torno_kernel/queries.py`
- Create fixtures: `kernel/tests/fixtures/ws/crash/crash.py` (`os.kill(os.getpid(), signal.SIGSEGV)` inside `assembly`), `.../ws/slow/slow.py` (`time.sleep(60)` inside `assembly`)
- Test: `kernel/tests/test_supervisor.py` (drives `python -m torno_kernel` as a subprocess through the frame codec), `kernel/tests/kclient.py` (test helper: spawn, `send`, `recv(timeout)`)

**Interfaces:**
- Consumes `frames`, `loader`, `tess`, `topo`.
- Produces the message protocol in "Shared contracts", and the query `describe` with `args.ref` of the form `<layout>:<name>` or `<layout>:<name>/F<i>` or `/E<i>`:
  - part → `{kind: "part", key, bbox, volume, area, faceCount, edgeCount, valid}`
  - face → `{kind: "face", ref, type: "plane" | "cylinder" | ..., area, center: [x, y, z], normal: [x, y, z] | null, radius: number | null}` in the object frame
  - edge → `{kind: "edge", ref, type, length, center}`

Behaviour:
- `__main__` first does `proto_out = os.fdopen(os.dup(1), "wb")` then `os.dup2(2, 1)`, so anything printed by imports or models goes to stderr and the protocol stream stays clean. Then it imports `build123d` and `ocp_tessellate.convert`, calls `Text("warm", 10)` inside a try, and sends `ready`.
- The supervisor loop `select`s on stdin and on the worker sockets. It must not call anything in `loader`, `tess`, `topo` or `queries`.
- `build`: kill any building worker (reply `cancelled` to its request), `socket.socketpair()`, `os.fork()`. Child: `prctl(PR_SET_DUMPABLE, 0)` via `ctypes.CDLL(None).prctl(4, 0)`, close the supervisor's fds, redirect fds 1 and 2 into a temp file to capture model output, run `load_scene` then `build_scene`, send one frame to the supervisor, then loop serving query frames. Parent: reply `build.started`, and on the worker's result frame forward it with `seconds` and `output` (last 200 lines of the capture) filled in.
- A successful worker replaces the previous live worker, which gets SIGTERM. A failed worker exits and the previous live worker stays.
- Worker socket EOF before a result → reap; `error.kind = "crash"` with the signal name in the message. Deadline passed → SIGKILL; `timeout`.
- `query` with no live worker → `no_build`. Queries go to the live worker even while another build runs.
- `cancel` kills the building worker. `shutdown`, or EOF on stdin, kills all children and exits 0.
- Workers use `os._exit` so they never run the supervisor's cleanup.

- [ ] **Step 1:** Write `kclient.py` and `test_supervisor.py`:
  - `ready` arrives and includes the build123d version.
  - build bracket → `build.started`, then ok with four parts and a blob whose length covers every `Buf`.
  - build chatty → ok, `scene.output` contains "report line", and the next frame still parses (Review Focus 1).
  - build broken → `exception` with "wall too thin"; then build bracket → ok (supervisor survived).
  - build crash → `crash` mentioning SIGSEGV within 5 s; then bracket → ok (Review Focus 3).
  - build slow with `timeout: 2` → `timeout` within 4 s; then bracket → ok.
  - build slow, then build bracket 0.5 s later → first replies `cancelled`, second replies ok; exactly two final replies (Review Focus 2).
  - after bracket: `describe assembly:base` volume 6000; `describe assembly:base/F0` returns type `plane` and a unit normal; `describe assembly:post/F<i>` for the cylindrical face returns radius 4 (find `i` by scanning types); `describe assembly:nope` → `bad_ref` whose message lists the valid keys; `describe` before any build → `no_build`.
  - after bracket then broken: `describe assembly:base` still works (previous worker kept).
  - ten builds in a row succeed (no fork deadlock), each under 5 s.
  - closing stdin makes the process exit within 2 s and leaves no child processes (check with `psutil`-free logic: record worker pids from a debug `pid` field in `build.started` and assert `os.kill(pid, 0)` raises).
- [ ] **Step 2:** Run, see failures, implement, run until green. Run the whole file three times to catch flakiness.
- [ ] **Step 3:** Commit.

### Task 4: App scaffold, shared types, design tokens, shell layout

**Files:**
- Create: `package.json` (root: `"packageManager"`, scripts `dev`, `build`, `test`, `test:kernel`, `test:e2e`), `pnpm-workspace.yaml` (`packages: [app]`, `onlyBuiltDependencies: [electron, esbuild, node-pty]`)
- Create: `app/package.json`, `app/electron.vite.config.ts`, `app/tsconfig.json`, `app/vitest.config.ts`
- Create: `app/src/shared/{scene,build,workspace,view,bridge}.ts` exactly as in "Shared contracts"
- Create: `app/src/main/index.ts` (window), `app/src/preload/index.ts` (exposes `window.torno`; methods not yet backed throw `Error('not implemented')`), `app/src/renderer/index.html`, `app/src/renderer/main.tsx`, `app/src/renderer/App.tsx`, `app/src/renderer/styles/tokens.css`, `app/src/renderer/styles/app.css`
- Test: `app/src/shared/shared.test.ts`, `app/e2e/boot.spec.ts`, `app/playwright.config.ts`

**Interfaces:**
- Produces the shared type modules and the app shell regions later tasks fill: `<aside data-region="left">`, `<main data-region="viewport">`, `<aside data-region="session">`, `<footer data-region="status">`.
- Produces `TORNO_TEST=1` behaviour: window created with `show: false`; `TORNO_WORKSPACE=<path>` opens that workspace at start; `TORNO_AGENT_CMD` overrides the agent command (used in Task 8).

Window: 1440 × 900, `backgroundColor` from the surface token, `webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload }`, `autoHideMenuBar: true`.

Layout: the viewport fills the window. The left column (248 px) and the session dock (default 520 px, resizable by dragging its edge, collapsible) sit over it at the sides with a hairline border, and the status line is a 28 px strip at the bottom. In this task the regions hold placeholders: the app name in the left column, "No object open" centred in the viewport.

Design tokens (`tokens.css`), light by default and dark under `@media (prefers-color-scheme: dark)`:

| Token | Light | Dark |
|---|---|---|
| `--surface` (viewport ground) | `#F1EFEA` | `#1A1C1F` |
| `--panel` | `#FAF9F6` | `#222529` |
| `--ink` | `#22252A` | `#E9E7E2` |
| `--muted` | `#6C7178` | `#9A9FA6` |
| `--hairline` | `#DAD6CE` | `#33373C` |
| `--accent` (layout blue) | `#1D46B8` | `#7C9BF7` |
| `--accent-wash` | `#E3E9F8` | `#252F4A` |
| `--user-mark` (red pencil) | `#CF3F2C` | `#F0705E` |
| `--agent-mark` | `#2B8A5C` | `#5CC492` |
| `--ok` | `#2B8A5C` | `#5CC492` |
| `--warn` | `#B7791F` | `#E0A94A` |
| `--fail` | `#CF3F2C` | `#F0705E` |

Type: `IBM Plex Sans` for UI at 13 px/1.4, `IBM Plex Mono` with `font-variant-numeric: tabular-nums` for numbers and refs, both bundled through `@fontsource`. Radius 6 px on controls, 10 px on floating palettes. Dividers are 1 px `--hairline`. No shadows except one soft shadow on floating palettes. No gradients, no glow. Focus ring: 2 px `--accent`. Part palette, in order: `#7B93B4`, `#C28B6C`, `#8DA888`, `#C8A75B`, `#A48BA7`, `#6E8388`, `#B56F76`, `#7FA7A6`.

Use the `frontend-design:frontend-design` skill for the shell's visual details, within these tokens and spec section 10.

- [ ] **Step 1:** Scaffold with electron-vite's React + TypeScript layout; `pnpm install` at the root. Confirm `node-pty` built (`ls app/node_modules/node-pty/build/Release/pty.node`); if pnpm blocked the build script, fix `onlyBuiltDependencies` and reinstall.
- [ ] **Step 2:** Add the shared modules. `shared.test.ts`: a helper `bufView(blob, buf, Float32Array)` in `scene.ts` returns a typed view of the right length and throws on a misaligned offset or a range past the end.
- [ ] **Step 3:** Write `e2e/boot.spec.ts` with Playwright's `_electron.launch` and `TORNO_TEST=1`: the window loads, the four regions exist, `document.title` is "torno", and a canvas probe reports a WebGL2 renderer string that does not contain "SwiftShader" or "llvmpipe".
- [ ] **Step 4:** Run `pnpm test` and `pnpm test:e2e`; see the e2e fail; build the shell; run until green.
- [ ] **Step 5:** Commit.

### Task 5: Kernel client, workspace, watcher, build state

**Files:**
- Create: `app/src/main/kernel/frames.ts`, `app/src/main/kernel/client.ts`, `app/src/main/workspace.ts`, `app/src/main/builds.ts`, `app/src/main/paths.ts`, `app/src/main/ipc.ts`
- Modify: `app/src/main/index.ts`, `app/src/preload/index.ts` (back `workspace.*` and `object.*`)
- Test: `app/src/main/kernel/frames.test.ts`, `app/src/main/workspace.test.ts`, `app/src/main/builds.test.ts`, `app/src/main/kernel/client.itest.ts` (real kernel, fixture workspace; run by `pnpm test:kernel`)

**Interfaces:**
- Consumes the kernel protocol; fixtures in `kernel/tests/fixtures/ws`.
- Produces:

```ts
// frames.ts
export function encodeFrame(header: object, blob?: Uint8Array): Buffer
export class FrameDecoder { push(chunk: Buffer): Array<{ header: any; blob: Buffer }> }
// client.ts
export interface KernelClient {
  ready: Promise<{ versions: Record<string, string> }>
  build(dir: string, model: string, opts?: { timeout?: number; onStarted?: () => void }):
    Promise<{ ok: true; scene: Scene; blob: Buffer } | { ok: false; error: BuildError }>
  query<T = unknown>(name: string, args: object): Promise<T>     // rejects with KernelError(kind, message)
  cancel(): void
  dispose(): Promise<void>
  onExit(cb: (code: number | null) => void): void
}
export function startKernel(opts: { workspaceRoot: string; hasProject: boolean; kernelDir: string }): KernelClient
// workspace.ts
export function scanWorkspace(root: string): Promise<WorkspaceInfo>
// builds.ts
export class Builds {
  constructor(deps: { kernel: KernelClient; watch: (dir: string, onChange: () => void) => () => void; now?: () => number })
  open(obj: ObjectInfo): BuildState
  rebuild(objectId: string): void
  close(objectId: string): void
  state(objectId: string): BuildState | undefined
  scene(objectId: string): { revision: number; scene: Scene; blob: Buffer } | undefined   // last good
  on(event: 'build', cb: (s: BuildState) => void): void
  on(event: 'scene', cb: (m: { objectId: string; revision: number; scene: Scene; blob: Buffer }) => void): void
}
```

Behaviour:
- Kernel command: with a project, `uv run --no-sync --project <root> --with-editable <kernelDir> python -m torno_kernel`; without, `uv run --project <kernelDir> python -m torno_kernel`. `cwd` is the workspace root. `kernelDir` comes from `paths.ts` (repo `kernel/` in development). Kernel stderr is kept in a 200-line ring for diagnostics.
- If the kernel process exits unexpectedly, restart it once; pending requests fail with kind `crash`. A second exit within 30 s leaves every open object `failed` with "kernel stopped" and the stderr tail.
- `scanWorkspace`: one `ObjectInfo` per immediate subfolder that contains at least one `.py` file and whose name does not start with `.` or `_` and is not `common`, `tests` or `out`. `model` follows the same rule as the kernel's `choose_model`; when it cannot be chosen, `model` is null and `problem` says why (Review Focus 4).
- `Builds.open` starts a build at once and watches the object folder with chokidar: `*.py` and other non-ignored files, ignoring `out/`, `.torno/`, `__pycache__/`, dotfiles; 300 ms debounce. Files in `<root>/common/` also trigger a rebuild of every open object.
- A change during a build starts a new build; the kernel cancels the old one. A `cancelled` reply never changes state or emits anything (Review Focus 2).
- State transitions: start → `building` (keeps `revision`; `stale` true when `revision > 0`); success → `ok`, `revision + 1`, `stale` false, emit `scene`; failure → `failed` with `error`, `stale` true when `revision > 0`.
- An object with `model: null` goes straight to `failed` with `kind: "no_model"` and the `problem` text, without calling the kernel.
- IPC: `onScene` sends the blob as an `ArrayBuffer` copy. When a renderer subscribes after a build, `object.open` replays the last good scene.

- [ ] **Step 1:** `frames.test.ts`: encode/decode round trip; a frame split across three chunks; two frames in one chunk; a zero-length blob.
- [ ] **Step 2:** `workspace.test.ts` on the fixture workspace: lists `bracket`, `plain`, `broken`, `two`, `noscene`, `chatty`, `crash`, `slow`; skips `empty` (no `.py`); `bracket.model` is `bracket.py`; `two.model` is null with both file names in `problem`.
- [ ] **Step 3:** `builds.test.ts` with a fake kernel and a manual `watch`: the transitions above; a change mid-build yields one `scene` event, for the second build only; a failure after a success keeps `scene()` returning the old revision with `stale` true; a `no_model` object never calls `kernel.build`.
- [ ] **Step 4:** `client.itest.ts` with the real kernel: build bracket → four parts and `bufView` works on every buffer; build broken → `exception`; `query('describe', {ref: 'assembly:base'})` volume 6000; kill the kernel process → the next build succeeds after the automatic restart.
- [ ] **Step 5:** Run, see failures, implement, run until green.
- [ ] **Step 6:** Commit.

### Task 6: Viewport

**Files:**
- Create: `app/src/renderer/viewport/Viewport.ts`, `partMesh.ts`, `views.ts`, `overlay.ts`, `palette.ts`
- Test: `app/src/renderer/viewport/views.test.ts`, `partMesh.test.ts`, `palette.test.ts`

**Interfaces:**
- Consumes `Scene`, `Part`, `bufView`, `Camera`, `ViewName`, `LookRequest`, `LookResult`.
- Produces:

```ts
export class Viewport {
  constructor(canvas: HTMLCanvasElement)
  setScene(scene: Scene, blob: ArrayBuffer): void            // keeps camera unless this is the first scene
  setLayout(layout: string): void
  setLayer(key: string, s: { visible?: boolean; color?: string; opacity?: number }): void
  setStale(stale: boolean): void                             // dims parts
  setView(v: ViewName | Camera, animate?: boolean): void
  setOrtho(ortho: boolean): void
  fit(): void
  getCamera(): Camera
  onCameraSettled(cb: (c: Camera) => void): void             // fires 150 ms after movement stops
  renderImage(req: { view: 'current' | ViewName | Camera; layout: string; visibleKeys: string[]; size: number }): Promise<LookResult>
  resize(): void
  dispose(): void
}
// partMesh.ts
export function buildPart(part: Part, blob: ArrayBuffer): { mesh: THREE.Mesh; edges: THREE.LineSegments; faceStarts: Uint32Array }
export function faceOfTriangle(faceStarts: Uint32Array, triangle: number): number   // binary search
// views.ts
export function viewDirection(v: ViewName): { dir: [number, number, number]; up: [number, number, number] }
export function fitCamera(bbox: { min: number[]; max: number[] }, dir: number[], up: number[], aspect: number, fovDeg: number, ortho: boolean): Camera
// palette.ts
export function colorFor(name: string, index: number): string
```

Behaviour:
- Z up. `front` looks along +Y (camera at −Y), `right` looks along −X (camera at +X), `top` looks along −Z with +Y up, `iso` from (+1, −1, +0.8) normalised.
- Each part: one `Mesh` (`MeshStandardMaterial`, roughness 0.75, metalness 0, `flatShading: false`, `polygonOffset` so edges sit on top) plus `LineSegments` for B-rep edges in a darker tint of the part colour; both under a `Group` with position and quaternion from `part.loc`. `faceStarts` is the cumulative sum of `trianglesPerFace` × 3 with a leading 0.
- Lighting: a hemisphere light plus one key light fixed to the camera, so shading never goes black on the far side.
- Ground: a faint grid on z = min of the scene, step chosen as a power of ten or 5× that suits the size, drawn in `--hairline`. No hex pattern. Background is `--surface`, read from CSS at construction and on colour-scheme change.
- Controls: `OrbitControls` with `screenSpacePanning`, damping off; left drag orbits, right or middle drag pans, wheel zooms to cursor. Render on demand: one `requestAnimationFrame` per change, no loop.
- `setScene` reuses objects whose `part.hash` is unchanged, and disposes geometry and materials of removed parts.
- Only parts whose `layout` equals the current layout are shown. If the current layout no longer exists, switch to the first of `scene.layouts`.
- Colours: `colorFor(name, index)` picks from the Task 4 palette by the part's index among the sorted unique names, so `lid` keeps its colour across layouts and rebuilds.
- `renderImage` renders to a `WebGLRenderTarget` (4× MSAA) with a camera derived from the request without disturbing the user's camera, using an aspect of 4:3 for named views and the canvas aspect for `current`; reads pixels, flips rows, and composites onto a 2D canvas where `overlay.ts` draws an axis triad (X red, Y green, Z blue, lettered) bottom left and a scale bar bottom right labelled in mm (orthographic only; in perspective the caption says "perspective, no scale bar"). Returns PNG bytes and a caption such as `view iso · layout assembly · parts base, post · orthographic · 1280×960`. Named views are orthographic; `current` uses the user's projection.

- [ ] **Step 1:** `views.test.ts`: each named direction is unit length and perpendicular to its up; `fitCamera` on a 40 × 30 × 5 box from `front` in ortho puts the target at the centre and frames width 40 with a margin between 5% and 20%; perspective distance grows with the bounding sphere.
- [ ] **Step 2:** `partMesh.test.ts` with a hand-made blob (two faces: 2 and 4 triangles): `faceStarts` is `[0, 6, 18]`; `faceOfTriangle` maps triangles 0–1 to face 0 and 2–5 to face 1; geometry has the right vertex and index counts; the group carries `loc`.
- [ ] **Step 3:** `palette.test.ts`: stable for the same name and index; wraps after eight; returns valid hex.
- [ ] **Step 4:** Run, see failures, implement the pure modules, run until green.
- [ ] **Step 5:** Implement `Viewport.ts` and `overlay.ts`. Check by hand in `pnpm dev` with a temporary fixture scene only if Task 7 has not landed; otherwise Task 7's e2e covers it.
- [ ] **Step 6:** Commit.

### Task 7: UI wiring and the rebuild loop end to end

**Files:**
- Create: `app/src/renderer/state/store.ts`, `app/src/renderer/ui/ObjectList.tsx`, `Layers.tsx`, `ViewBar.tsx`, `BuildStatus.tsx`, `ViewportPane.tsx`, `BuildErrorSheet.tsx`
- Modify: `app/src/renderer/App.tsx`, `app/src/main/ipc.ts` (back `view.*`), `app/src/main/index.ts` (remember the last workspace in `~/.config/torno/config.json`)
- Create: `app/src/main/look.ts`, `app/src/main/scenefile.ts` (reads and writes `<object>/.torno/scene.json`)
- Test: `app/src/renderer/state/store.test.ts`, `app/src/main/scenefile.test.ts`, `app/e2e/loop.spec.ts`

**Interfaces:**
- Consumes `window.torno`, `Viewport`, `Builds`.
- Produces `look.ts`: `export function requestLook(win: BrowserWindow, req: LookRequest, timeoutMs = 10000): Promise<LookResult>` (rejects with the renderer's error text), and `latestView(objectId): ViewState | undefined`.
- Produces `scenefile.ts`: `loadSceneFile(dir): Promise<SceneFile>`, `saveSceneFile(dir, f): Promise<void>` with `interface SceneFile { layout?: string; layers: Record<string, { visible?: boolean; color?: string; opacity?: number }> }` keyed by part name. Writes are atomic (temp file then rename) and create `.torno/` on demand.
- Produces a test hook when `TORNO_TEST=1`: `window.__tornoTest = { state: () => store.getState(), look: (req) => viewport.renderImage(...) }`.

Behaviour:
- Left column: workspace name with a "Open folder" control; object list (objects with a `problem` are shown muted with the reason as a tooltip); below it, for the open object, the layers list: one row per part in the current layout with a colour swatch, name, visibility toggle, and an opacity control revealed on hover.
- Floating view bar at the top centre of the viewport: layout switch (shown only when there is more than one layout), view buttons (iso, front, right, top, and a menu for back, left, bottom), perspective/orthographic toggle, fit. Keys: `1` iso, `2` front, `3` right, `4` top, `F` fit, `O` projection.
- Status line: object name, build status with a small state dot (building shows elapsed seconds, updated once a second), revision as `r12`, part count, kernel version at the far right. A failed build shows "Build failed" in `--fail`; clicking it opens `BuildErrorSheet` with message, traceback and output in the mono face, and a copy button.
- While `stale`, parts are dimmed and the status line says "showing r11".
- The renderer answers `view.onLook` by calling `viewport.renderImage`, resolving `parts` names to keys in the requested layout; an unknown name yields `{ error: "unknown part 'x'; parts in layout assembly: base, post" }`.
- The renderer reports `ViewState` on camera settle and on layer or layout change.
- Layer and layout changes are saved to `scene.json` (debounced 500 ms) and restored when the object opens.
- First launch with no workspace shows a centred prompt with one "Open folder" button. `~/objects` is suggested when it exists.

- [ ] **Step 1:** `store.test.ts`: applying a scene sets layouts and keeps layer settings for names that persist; switching layout filters parts; a build state with `stale` keeps the old scene.
- [ ] **Step 2:** `scenefile.test.ts`: round trip in a temp dir; a missing file gives defaults; a corrupt file gives defaults and is not overwritten until the next save.
- [ ] **Step 3:** `e2e/loop.spec.ts`, in a temp copy of the fixture workspace with `TORNO_TEST=1` and `TORNO_WORKSPACE`:
  - the object list shows `bracket`; clicking it leads to status `ok`, revision 1, layers `base` and `post`;
  - `__tornoTest.look({view: 'iso'})` returns a PNG in which more than 2% of pixels differ from the background colour (the parts are drawn);
  - appending `# touch` to `bracket.py` leads to revision 2 within 15 s;
  - replacing the file with a syntax error leads to status `failed`, revision still 2, `stale` true, layers still listed; restoring it leads to revision 3 (Review Focus 3);
  - hiding `post` then `look` changes the image; `.torno/scene.json` records `post` as hidden;
  - opening `two` shows the no-model reason and no crash (Review Focus 4).
- [ ] **Step 4:** Run, see failures, implement, run until green.
- [ ] **Step 5:** Run the app by hand on `~/objects` (`TORNO_WORKSPACE=~/objects pnpm dev`), open `helmet-stand`, and take a screenshot through `__tornoTest.look` saved to the scratchpad; look at it and fix what looks wrong (shading, edges, grid scale).
- [ ] **Step 6:** Commit.

### Task 8: Session pane

**Files:**
- Create: `app/src/main/sessions/adapter.ts`, `claude.ts`, `manager.ts`, `status.ts`; `app/src/main/http.ts`; `app/src/renderer/ui/SessionPane.tsx`; `app/test/fake-agent.mjs`
- Modify: `app/src/main/ipc.ts`, `app/src/preload/index.ts` (back `session.*`), `app/src/renderer/App.tsx`
- Test: `app/src/main/sessions/claude.test.ts`, `status.test.ts`, `manager.itest.ts`, `app/e2e/session.spec.ts`

**Interfaces:**
- Produces:

```ts
// adapter.ts
export interface AgentLaunch { command: string; args: string[]; env: Record<string, string> }
export interface AgentAdapter {
  id: string
  launch(ctx: { sessionId: string; conversationId: string; resume: boolean; cwd: string; mcpUrl: string; hookUrl: (event: string) => string; systemPrompt: string }): AgentLaunch
}
// http.ts
export interface HttpRouter { port: number; url(path: string): string; route(prefix: string, h: (req: IncomingMessage, res: ServerResponse, rest: string[]) => void | Promise<void>): void; close(): Promise<void> }
export function startHttp(): Promise<HttpRouter>            // 127.0.0.1, port 0
// status.ts
export function reduceStatus(prev: SessionStatus, event: string): SessionStatus
// manager.ts
export class Sessions {
  constructor(deps: { http: HttpRouter; adapter: AgentAdapter; contextFor: (objectId: string) => string; systemPrompt: string; mcpUrlFor: (objectId: string) => string })
  start(obj: ObjectInfo, opts: { resume?: boolean; cols?: number; rows?: number }): { sessionId: string }
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  stop(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  on(event: 'data' | 'status', cb: (m: any) => void): void
}
```

Behaviour:
- Claude adapter arguments: `--session-id <conversationId>` or `--resume <conversationId>`; `--mcp-config '{"mcpServers":{"torno":{"type":"http","url":"<mcpUrl>"}}}'`; `--allowedTools mcp__torno__*`; `--append-system-prompt <systemPrompt>`; `--settings <json>` where the JSON registers `type: "http"` hooks with `timeout: 5` for `UserPromptSubmit`, `Stop`, `Notification`, `PermissionRequest` and `SessionEnd` at `hookUrl(event)`. The command is `claude`, or `TORNO_AGENT_CMD` split on spaces when set. `--strict-mcp-config` is not passed, so the user's own MCP servers keep working.
- PTY: `node-pty` with `name: 'xterm-256color'`, `COLORTERM=truecolor`, `cwd` the object folder, env plus `TORNO_OBJECT` and `TORNO_SESSION_ID`.
- Hook routes: `POST /hooks/<sessionId>/<event>`. `UserPromptSubmit` replies `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext": contextFor(objectId)}}`; all others reply `{}`. Unknown session → 404. Bodies over 1 MB → 413.
- `reduceStatus`: `UserPromptSubmit` → `working`; `Stop` → `idle`; `Notification` and `PermissionRequest` → `needs_input`; `SessionEnd` and PTY exit → `exited`; initial `starting`, first PTY output → `idle`.
- The conversation id for each object is stored in `<object>/.torno/session.json` (`{ "conversationId": "...", "updatedAt": "..." }`), and updated from the `session_id` field of every hook body, since `/clear` changes it. "Resume" is offered when the file exists.
- `SessionPane`: xterm.js with the fit addon and the WebGL addon (falling back silently), theme colours taken from the tokens (terminal ground `--panel`, text `--ink`, so the terminal belongs to the app in both colour schemes), mono face 13 px. Header row: agent name, status dot and word, "New session" and "Resume" buttons, a collapse control. When no session is running, the pane shows the two buttons centred with one line of explanation. `Shift+Enter` sends `\x1b\r`. `Ctrl+Shift+C` and `Ctrl+Shift+V` copy and paste. ``Ctrl+` `` moves focus between viewport and session.
- Closing the window stops all sessions (SIGHUP, then SIGKILL after 2 s).
- `fake-agent.mjs`: prints `READY <argv as JSON>`, echoes stdin lines back prefixed with `> `, and on the line `hook` POSTs a `UserPromptSubmit` body to the hook URL it finds in its `--settings` argument and prints the `additionalContext` it gets back.

- [ ] **Step 1:** `claude.test.ts`: new and resume argument lists; the `--mcp-config` and `--settings` values parse as JSON with the expected URLs; no `--strict-mcp-config`.
- [ ] **Step 2:** `status.test.ts`: the transitions above, and unknown events leave the status unchanged.
- [ ] **Step 3:** `manager.itest.ts` with `fake-agent.mjs` as the adapter command: `data` contains `READY`; writing `hello\r` echoes; writing `hook\r` prints the text from `contextFor`; status goes `starting` → `idle` → `working`; `stop` ends the process and emits `exited`; `session.json` is written.
- [ ] **Step 4:** `e2e/session.spec.ts` with `TORNO_AGENT_CMD="node <abs>/fake-agent.mjs"`: open `bracket`, click "New session", the terminal shows `READY`, typing `hi` and Enter shows `> hi`.
- [ ] **Step 5:** Run, see failures, implement, run until green.
- [ ] **Step 6:** Commit.

### Task 9: MCP server and prompt context

**Files:**
- Create: `app/src/main/mcp/server.ts`, `app/src/main/mcp/tools.ts`, `app/src/main/context.ts`, `app/src/main/prompt.ts`
- Modify: `app/src/main/index.ts` (wire `Sessions` with `contextFor`, `mcpUrlFor`, `systemPrompt`)
- Test: `app/src/main/context.test.ts`, `app/src/main/mcp/tools.test.ts`, `app/src/main/mcp/server.itest.ts`

**Interfaces:**
- Consumes `Builds`, `requestLook`, `latestView`, `HttpRouter`, `loadSceneFile`.
- Produces `mountMcp(http: HttpRouter, deps: ToolDeps): void` serving `POST /mcp/<objectId>` (stateless: a new `McpServer` and `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request, both closed on response close; GET → 405), `contextFor(objectId): string`, and `SYSTEM_PROMPT: string`.

```ts
export interface ToolDeps {
  object(objectId: string): ObjectInfo | undefined
  build(objectId: string): BuildState | undefined
  scene(objectId: string): { revision: number; scene: Scene } | undefined
  view(objectId: string): ViewState | undefined
  look(objectId: string, req: LookRequest): Promise<LookResult>
  saveImage(objectId: string, png: Uint8Array): Promise<string>     // writes .torno/views/<n>.png, keeps the newest 20, returns the path
}
```

Tools:
- `scene` (no input) → one text block of JSON: `{object, model, build: {status, revision, seconds, stale, error?}, layout, layouts, parts: [{name, layout, visible, size: [x, y, z], bbox, volume, faces, edges, valid}], camera}`. Sizes are rounded to 0.01 mm. `error` carries `kind`, `message` and the last 30 lines of the traceback.
- `look` input `{ view?: 'current' | ViewName | { position, target, up?, ortho? }, layout?: string, parts?: string[], size?: number (256–2000, default 1280) }` → an image block (`image/png`) and a text block with the caption, the revision, whether it is stale, and the saved file path.
- Tool descriptions say what each returns and when to use it, in two sentences each.
- Errors return `isError: true` with a text block: no object → "unknown object"; no successful build yet → "no build yet: <status and error message>"; an unknown part → the renderer's message listing valid names; look timeout → "the torno window did not answer within 10 s" (Review Focus 5).

`contextFor` (the text attached to every prompt), at most 1500 characters:
- ok: `[torno] bracket · build ok · r12 (0.8 s) · layout assembly · parts: base, post. Tools: mcp__torno__scene, mcp__torno__look.`
- building: `[torno] bracket · building (4 s so far) · showing r11.`
- failed: `[torno] bracket · BUILD FAILED · showing r11 (stale).` followed by the error message and the last 12 lines of the traceback.

`SYSTEM_PROMPT` (about 120 words): torno is the window the user sees the parts in; it rebuilds on every save of the model file, so there is no need to run the model to preview it; `scene` reports build status and parts; `look` returns an image of what the user sees or of a named view; always check the build status after editing; coordinates are millimetres, Z up; do not write to `.torno/`.

- [ ] **Step 1:** `context.test.ts`: the three forms above from hand-made states; the failed form is cut to 1500 characters keeping the last traceback lines.
- [ ] **Step 2:** `tools.test.ts` with fake deps: `scene` JSON shape and rounding; `look` passes the request through and clamps `size`; each error case returns `isError` with the stated text.
- [ ] **Step 3:** `server.itest.ts` using the SDK's `Client` with `StreamableHTTPClientTransport` against a real `HttpRouter` and fake deps: `listTools` returns `scene` and `look`; `callTool('look')` returns an image block whose bytes equal the fake PNG; a second client works at the same time; GET returns 405; an unknown object id returns the error result.
- [ ] **Step 4:** Run, see failures, implement, run until green.
- [ ] **Step 5:** Real check, once, from a terminal with the app running on the fixture workspace (print the MCP URL and settings JSON from main when `TORNO_DEBUG=1`):
  `claude -p "Call mcp__torno__scene, then mcp__torno__look with view iso. Say how many parts there are and describe the picture in one sentence." --model sonnet --mcp-config '<json>' --allowedTools 'mcp__torno__*' < /dev/null`
  Expected: it reports two parts and describes a plate with a post. Record the output in the commit message body.
- [ ] **Step 6:** Commit.

### Task 10: Run script, README, whole-loop check

**Files:**
- Create: `README.md`, `scripts/torno` (shell launcher: builds if needed and starts the app, passing a folder argument as the workspace), `CLAUDE.md` (how to run tests, the Global Constraints, the kernel invariants)
- Modify: `package.json` scripts if needed

- [ ] **Step 1:** Write `scripts/torno` and the README (what torno is, requirements, `pnpm install`, `pnpm dev`, `scripts/torno ~/objects`, how the three test suites run, where files are written).
- [ ] **Step 2:** Run all suites: `pnpm test`, `pnpm test:kernel`, `uv run --project kernel pytest -q`, `pnpm test:e2e`. All green.
- [ ] **Step 3:** Whole-loop check on real data, by driving the built app with Playwright in a hidden window against `~/objects`: open `helmet-stand`, wait for `ok`, save `look` images for iso, front and top to the scratchpad and inspect them; open `micra-intake`, confirm the status shows building with elapsed time and reaches `ok` (about 30 s) with six parts in layout `print`. Confirm `git -C ~/objects status --short` shows nothing new except `.torno/` folders.
- [ ] **Step 4:** Commit.

## Order and parallelism

Tasks 1 → 2 → 3 are one chain (Python). Task 4 is independent of them. After 3 and 4: Task 5. Task 6 needs only Task 4. Task 7 needs 5 and 6. Task 8 needs 4 and 5's IPC file. Task 9 needs 7 and 8. Task 10 is last.

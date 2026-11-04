# torno: Flow, air through and around a part (implementation plan)

Date: 2026-11-04. Spec: issue #142 (its body is the spec; this plan does not repeat its research). Background: the
design spec `docs/superpowers/specs/2026-10-08-torno-design.md`, and the `CLAUDE.md` of the repository root and of
each folder. Milestone: Later. Nothing here is scheduled until the owner has taken the decisions below and run the
spike (step 0): its numbers decide what a quick and a study run are, and whether there is a second solver.

A flow run: torno writes an OpenFOAM case from the last build, runs it in a process of its own, reads its numbers
and fields back, and shows them in the view; the agent starts one, follows it and reads it through MCP, choosing
from a closed set of setups and naming boundaries by ref. It never writes a solver dictionary.

## Global constraints

Copied from the root `CLAUDE.md`; they bind every task. Read the `CLAUDE.md` of every folder a task touches before
changing it.

- Never write inside a user workspace except under `<object>/.torno/`. A case lives in `<object>/.torno/flow/<id>/`;
  its `case/` folder (mesh, fields, logs) is left out of git (`ensureIgnored`, as a scan's `mesh.bin`); `run.json`
  is small text. Never `uv sync` in a workspace.
- The kernel supervisor only imports; workers never fork. The flow process is neither: main starts it, as the scan
  import (`python -m torno_kernel.flow`), in a process group of its own. Its stdout is one line of JSON, its last;
  stages on stderr; the solver's logs in its case folder.
- Units are millimetres, Z up, object frame. Metres exist only inside the solver's case, converted in one place in
  the kernel.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`. No per-frame state in
  React: a field is a buffer on the mesh, drawn on demand.
- Numbers shown go through `shared/format.ts`, in the monospace face. No control-room look; colours from
  `app/src/renderer/styles/tokens.css`, light and dark.
- Every number from a run is not exact and says so (`≈`, and its doubt). This is the second exception to the
  exactness rule, beside a scan.
- No cloud: the geometry never leaves the machine.
- Tests must not open a visible window. Never run a real agent CLI: `TORNO_AGENT_CMD` is `app/test/fake-agent.mjs`.
- **Never run a real solver in a test.** Tests set `TORNO_FLOW_CMD` to the stand-in solver,
  `app/test/fake-flow.mjs` (Task 2), which plays back a recorded case. A real OpenFOAM run is by hand only.
- `app/src/readme.test.ts` holds `docs/manual.md` to the code: a new MCP tool is in the manual's tool table and in
  `TOOLS`; a user-visible change gets its line in the manual.
- A task that changes a rule written in a `CLAUDE.md` updates that `CLAUDE.md` in the same commit, saying the new
  rule, not its history.

## How each task is done and committed

- One agent per task, in its own worktree, following the brief every implementation agent gets. Test first.
- One commit per task: a first line in the repository's style, a body, `Part of #142` (the last task: `Closes
  #142`, or the sub-issue it was split into), then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before the commit: `pnpm -C app typecheck`, `pnpm test`, the pytest files touched (all of `kernel` if kernel code
  changed), the itests touched, and the e2e specs touched.
- After the spike, the controller splits the tasks below into sub-issues of #142 (one per task), each body copied
  from its task here with the spike's numbers filled in.

## Decisions the owner takes (each with the issue's recommendation)

Before Task 1. Write the ruling under each, on #142, and copy it here.

1. **Solver, and how it is found.** Recommendation: OpenFOAM first, ESI's (openfoam.com, v2512), steady
   `simpleFoam`, k-ω SST, on a `snappyHexMesh` mesh. Found on `PATH` (`simpleFoam`, `snappyHexMesh`), else run in
   ESI's container `opencfd/openfoam-run` when Docker or Podman is there. Run as a separate program, never linked.
2. **foamlib.** Recommendation: no. Torno is Apache-2.0; importing a GPL-3 library into `torno_kernel` would put
   the kernel under GPL-3. Torno writes a few fixed dictionaries itself and reads `postProcessing/`'s plain text.
3. **XLB as a second, live solver.** Recommendation: decide after the spike. If yes, a kernel extra (as `scans`),
   told as a preview only, and a task after Task 9 (not planned here).
4. **Where cases live.** Recommendation: `<object>/.torno/flow/<id>/`, `case/` ignored by git, the last few runs
   kept (the number from the spike's sizes; start at 5). The other place is `userData`.
5. **Who starts a study.** Recommendation: the agent may start a quick run on its own; a study (two meshes, minutes,
   every core but one) waits for the person's OK in the window.
6. **Quick and study.** From the spike: the cell size at the wall of a quick run, the halving for a study, the
   iteration cap and the timeout of each.
7. **Milestone.** Stays Later until the owner wants the spoiler's `lift_coeff` guess replaced.

## Step 0: the spike, by hand, on the owner's machine

Owner only: needs OpenFOAM (and, for decision 3, XLB with an NVIDIA GPU) on the TITAN RTX box. No agent runs it.
The cases are written by hand (or with OpenFOAM's tutorials as a start), from STLs torno exports
(`export` with each part, at 0.05 mm tolerance; `export_check` says each is closed).

### Cases

| # | Case | Setup | Known answer to hold it against |
|---|---|---|---|
| S1 | Sphere, 50 mm diameter, free air | external, air 20 °C, speeds for Re 1e4, 3e4, 1e5 (≈ 3.0, 9.1, 30.3 m/s) | Cd ≈ 0.40 to 0.47 across that range |
| S2 | `spoiler`, free air | external, 140 km/h (38.9 m/s) along −X of the car, no ground | the model's `lift_coeff = 1.0  # GUESS` |
| S3 | `spoiler` over `Hatch.stl` | as S2, the hatch scan as a wall, a ground plane | S2: how far the car changes it |
| S4 | `intake` | internal: inlet the snorkel mouth, outlet the filter face, full-throttle flow rate (owner states it, m³/s) | pressure drop; does the diffuser over `max_taper_deg = 8` separate |

Each OpenFOAM case at two cell sizes at the wall (start 2 mm and 1 mm; S1 also 0.5 mm). XLB, if tried, on S1 and S2
only.

### What to record (a table on #142, one row per run)

- Solver and version, how it ran (PATH or container, which image), machine, cores used.
- Cell size at the wall, cells in the mesh, `snappyHexMesh` time, solve time, iterations to converge (residuals
  under 1e-4, forces within 1 % over 100 iterations) or that it did not.
- The numbers: drag, lift, side force (N) and Cd, Cl on the stated area; for S4 the pressure drop (Pa) and the mass
  balance (inlet against outlet).
- The area of each part's wall on the mesh against the B-rep's area (from `measure area`): the mesh-caught check.
  Try once to make it fail (a part with an open STL, or a cell size larger than a thin wall) and record what
  OpenFOAM said, if anything.
- y+ at the wall (min, mean, max).
- Disk used by the case folder, at each size.
- What failed and how it was fixed: every dictionary changed from the tutorial's, and why.
- For a Mac: what would be needed (container under Docker Desktop or Podman on Apple Silicon: does `openfoam-run`
  have an arm64 image; Multipass), without running it if no Mac is at hand.
- Copy the final, working dictionaries of S1 and S4 (`blockMeshDict`, `snappyHexMeshDict`, `controlDict`,
  `fvSchemes`, `fvSolution`, `0/*`) and the `postProcessing/` folders into the issue or a gist: Task 1's templates
  and Task 2's recorded fixture are made from them.

### What the spike decides

Decisions 3 and 6; whether the mesh-caught tolerance is "a few per cent" (which figure); the run's timeouts; the
number of runs kept.

# Tasks

Each after the one before it. Tasks 3 and 4 may go in parallel once Task 2 is in; Tasks 6, 7 and 8 likewise once
Task 5 is in.

## Task 1: Kernel: write a case from a setup and STLs

The pure part of `torno_kernel/flow/`: no process run, no solver.

- Files: new `kernel/src/torno_kernel/flow/__init__.py`, `flow/setup.py` (the setup: kind `external` or `internal`,
  parts, scans, inlets and outlets as refs, direction, speed or flow rate, fluid, fidelity; validated, closed set),
  `flow/case.py` (writes the dictionaries from templates in `flow/templates/`, made from the spike's S1 and S4;
  converts millimetres to metres in one place; the wind-tunnel box from the layout's box), `flow/units.py`.
- Tests: `kernel/tests/test_flow_case.py`: a snapshot of the case written for a sphere and for a two-face duct
  (`kernel/tests/fixtures/flow/`); refusal of a setup outside the set (unknown fluid, inlet that is not a face ref,
  zero speed); the box and the scale.
- CLAUDE.md: `kernel/CLAUDE.md` gains a section Flow: the flow process is a third process (not supervisor, not
  worker), metres only inside a case, torno never writes a dictionary the setup does not name.

## Task 2: Kernel: run a case, read its results, make the checks; the stand-in solver

- Files: `flow/__main__.py` (`python -m torno_kernel.flow <case dir>`: stages on stderr, one JSON line on stdout,
  last), `flow/run.py` (runs `snappyHexMesh` then `simpleFoam`, or the command in `TORNO_FLOW_CMD`, in the case
  folder; writes only there), `flow/results.py` (reads `postProcessing/` forces, residuals, surface field values;
  the surface and slice fields), `flow/checks.py` (converged; mesh caught the part, against the B-rep areas passed
  in the setup; mesh spread of a study; mass balance; y+). New `app/test/fake-flow.mjs`: the stand-in solver, which
  copies a recorded `postProcessing/` and fields from `app/test/fixtures/flow/` into the case, step by step, with a
  delay and a mode (`TORNO_FAKE_FLOW=converge|diverge|hang|miss-part|fail`).
- Tests: `kernel/tests/test_flow_results.py` on the recorded `postProcessing/` of the spike (fixture); the mesh
  check fails on the `miss-part` fixture; unconverged is never told as settled; `test_flow_run.py` runs the stand-in.
- CLAUDE.md: root "Never run a real agent CLI from tests" gains its twin: no test runs a solver; `TORNO_FLOW_CMD` is
  the stand-in.

## Task 3: Main: the setup store, the run's process, pruning

- Files: new `app/src/main/flow/store.ts` (`.torno/flow.json`, main the only writer, one change at a time, atomic,
  as `marks/store.ts`), `flow/runner.ts` (as `scans/importer.ts`: the command from `kernelRun`, a process group,
  killed on Stop, on its timeout, when the workspace is left and on quit (`quit.ts`); one run at a time on the
  machine), `flow/runs.ts` (`.torno/flow/<id>/run.json`: setup, revision, source hash, numbers, checks; `case/`
  through `ensureIgnored`; the last N kept), the geometry from the live worker by `export` and `export_check`.
  New types in `app/src/shared/flow.ts`.
- Tests: `flow/store.test.ts`, `flow/runner.test.ts` (with `node -e` scripts, as `importer.test.ts`),
  `flow/runner.itest.ts` under `test:kernel` with the stand-in: a run to the end, Stop, a timeout, the process group
  gone after each.
- CLAUDE.md: root Global constraints: `<object>/.torno/flow/` and its ignored `case/`; `app/src/main/CLAUDE.md` a
  section Flow (the store, the process, one run at a time).

## Task 4: Shared: the new quantities and how a run's number is told

- Files: `app/src/shared/format.ts` (speed m/s, pressure Pa, force N, moment N·mm, coefficients bare; always `≈`),
  `app/src/shared/flow.ts` (`toldFlowNumber`: the value, `≈`, and its doubt: "6 % apart between 2 mm and 1 mm
  cells", or "one mesh, not checked", or "not converged").
- Tests: `format.test.ts` additions; `shared/flow.test.ts`: no number of a run is ever told without `≈` and its
  doubt.
- CLAUDE.md: root "What crosses processes": the units line gains m/s, Pa, N, N·mm; the exactness paragraph names a
  run as the second exception beside a scan ("What is taken from a scan or a flow run is never said to be exact").
  `app/src/shared/CLAUDE.md`: the quantities.

## Task 5: Stale after a build, and the line in the next prompt

- Files: `app/src/main/flow/runs.ts` (a run is of one revision; stale after a new build), `app/src/main/context.ts`
  (the line "Flow F3 of r12: converged, drag ≈ 4.1 N, 6 % mesh spread" when a run ended since the last prompt),
  `statefile.ts` (the last run in `state.md`).
- Tests: `context.test.ts`, `statefile.test.ts`; `flow/runs.itest.ts`: a build after a run makes it stale.
- CLAUDE.md: `app/src/main/CLAUDE.md`, what the agent is told.

## Task 6: MCP: `flow_run`, `flow`, `flow_probe`

- Files: `app/src/main/mcp/schemas.ts` (`TOOLS`), new `mcp/flowTools.ts`, `docs/manual.md` (the tool table and a
  section Flow). `flow_run` returns an id at once; a `study` from the agent waits for the person's OK (decision 5).
  `flow_probe` bounded (points, a line, a plane; says when it thinned).
- Tests: `mcp/flowTools.test.ts` (bounds, refusals, a study not started without the OK, every number with `≈`);
  `readme.test.ts` passes; `mcp/flowTools.itest.ts` with the stand-in.
- CLAUDE.md: `app/src/main/CLAUDE.md`, the MCP tools; the manual's tool table.

## Task 7: Window: the Flow section, its chart, Run and Stop

- Files: new `app/src/renderer/ui/FlowPanel.tsx` (setup, inlets and outlets picked in the view by ref, Run, Stop,
  state, the residuals and force by iteration as a small chart, the runs kept, the OK for a study),
  `app/src/shared/bridge.ts` (flow calls and events), `app/src/main/ipc.ts`.
- Tests: unit tests of the panel's pure parts; `app/e2e/flow.spec.ts` with the stand-in: a run starts, its chart
  moves, Stop ends it.
- CLAUDE.md: `app/src/renderer/CLAUDE.md`, a section Flow; `docs/manual.md`.

## Task 8: Window: pressure on the part, the field in the section plane, the legend

- Files: new `app/src/renderer/viewport/flowField.ts` (Cp sampled on torno's tessellation, a buffer on the mesh;
  the field on the section cut, dragged with it), a legend; one perceptually even colour map in `tokens.css`, light
  and dark, clear of the marks' red and the agent's green (`shared/contrast.ts`). A stale run drawn dimmed.
- Tests: `flowField.test.ts` (sampling, the map's contrast against the mark colours); `e2e/flow.spec.ts`: the part
  is coloured and a legend drawn.
- CLAUDE.md: `app/src/renderer/CLAUDE.md`, the colours of a field.

## Task 9: Streamlines; `look` and `section` draw the field

- Files: `viewport/streamlines.ts` (from a rake placed with a gizmo, or from the inlet; lines that show their
  direction), `main/look.ts` and the `section` tool gain `flow`.
- Tests: `streamlines.test.ts`; `look.test.ts`; e2e as Task 8.

## Task 10: The first screen and the manual

- Files: `app/src/main/readiness.ts`, `app/src/main/ready.ts`, `ui/Readiness.tsx`: OpenFOAM looked for on `PATH`,
  or a container runtime, shown as optional with how to get it (Linux and macOS); nothing waits on it. Under
  `TORNO_TEST=1` only a lookup on `PATH`. `README.md` Requirements; `docs/manual.md`, and its last section gains the
  by-hand check: one real OpenFOAM run on `spoiler`, its lift held against the model's guess.
- Tests: `readiness.test.ts`, `ready.test.ts`, `readme.test.ts`.
- CLAUDE.md: root "Never run a real agent CLI from tests": the one thing torno asks of a solver before a run is
  whether it is there.

## Done when (from #142)

- Kernel: the case written from a setup is the one expected (snapshot); results read from a recorded
  `postProcessing/`; the area check fails a mesh made to miss a part. No test runs OpenFOAM.
- `pnpm test:kernel`: a run through the stand-in solver, stopped, timed out, made stale by a build.
- `flowTools.test.ts`: `flow`'s reading and its bounds, and no number told without `≈` and its doubt.
- e2e, in a hidden window: a run through the stand-in colours the part and draws a legend; Stop ends it.
- By hand, once: a real OpenFOAM run on `spoiler`, its lift held against the model's guess.

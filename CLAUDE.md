# torno

A desktop workbench for making CAD parts with an AI coding agent. `README.md`
says what it does and how to run it; the design is
`docs/superpowers/specs/2026-10-08-torno-design.md`.

- `app/`: the Electron app (pnpm, TypeScript, electron-vite). `src/main` is the
  shell, the kernel client, the sessions, the HTTP server with the MCP tools and
  the hooks. `src/renderer` is the UI and the three.js viewport. `src/shared`
  holds the types both sides use.
- `kernel/`: the Python package `torno_kernel` (uv). It loads build123d models
  and tessellates them, in forked workers.
- `scripts/torno`: the launcher. It rebuilds the app when a source is newer
  than `app/out/.built`, which it touches only after a build that succeeded.

## Tests

Run from the repository root.

```sh
pnpm test                          # app unit tests: app/src/**/*.test.ts (vitest)
pnpm test:kernel                   # app against the real kernel and a stand-in agent: app/src/**/*.itest.ts (vitest)
(cd kernel && uv run pytest -q)    # the kernel alone (pytest)
pnpm test:e2e                      # builds the app, then drives it in a hidden window: app/e2e/*.spec.ts (Playwright)
pnpm -C app typecheck
```

One file: `pnpm -C app exec vitest run src/main/context.test.ts`,
`pnpm -C app exec vitest run --mode kernel src/main/sessions/manager.itest.ts`,
`pnpm -C app exec playwright test e2e/loop.spec.ts` (after `pnpm build`).

While iterating run the focused test; run all four suites before a commit.

## Global Constraints

- Never write inside a user workspace except under `<object>/.torno/`. Never run `uv sync` there: always `uv run --no-sync`, and only when `<workspace>/.venv` exists: without it uv would create one, so no kernel is started and builds fail saying to run `uv sync`.
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

("The tokens in Task 4" are `app/src/renderer/styles/tokens.css`.)

## Kernel invariants

- **The supervisor only imports.** `python -m torno_kernel` imports build123d
  and ocp-tessellate so that every worker it forks has them loaded, and then
  only routes frames. It never loads a model, builds, tessellates or answers a
  query: one OCC operation in it would start OCC's thread pool, and every
  worker forked afterwards would deadlock.
- **Workers never fork.** One worker is forked per build. For each object
  folder, the last one that succeeded stays alive to answer queries about that
  object, and is replaced when the next build of that folder succeeds. At most
  four stay alive: a fifth folder retires the one least recently built or
  queried, whose queries are then `no_build`. A query names its folder (`dir`)
  and has 30 s, after which it is answered `timeout` and the worker left alone.
  A worker leaves through `os._exit`.
- **prctl.** Each worker sets `PR_SET_PDEATHSIG` to SIGKILL, so it dies with
  the supervisor even when that is killed, and `PR_SET_DUMPABLE` to 0, so a
  crashing model does not wait seconds on a core dump.
- **Timeouts.** Every build has one: 600 s unless the request names another
  (the app passes `TORNO_BUILD_TIMEOUT`), a day at most; one that is not a
  positive, finite number is a `bad_request`.
  A build past it is killed and answered with `error.kind: "timeout"`. A
  worker that crashes is answered with `crash`, one that is superseded with
  `cancelled`. The supervisor never blocks on a write.
- **A worker is not trusted.** A frame from the building worker that is not a
  result (not JSON, or without its scene or error) is a `crash` of that build;
  the supervisor carries on. Frames are written with `allow_nan=False`: a scene
  that holds a NaN is an `exception` reply, never bytes that are not JSON.
- **One geometry.** A `print` layout whose parts overlap in XY is spread along
  X in the worker, before tessellation (`arrange.py`). The shape itself is
  moved, so the mesh, the bounding box and the shape kept for queries agree;
  the part carries the translation as `arranged`. The viewport never moves a
  part.
- **stdout is the protocol.** The kernel keeps the real stdout for frames and
  points fd 1 at stderr; a worker points fd 1 and 2 at a capture buffer and
  stdin at `/dev/null`. What a model prints comes back as `output`.
- The app starts the kernel with `PYTHONDONTWRITEBYTECODE=1`, so importing a
  model writes no `__pycache__` into the workspace.

## Testing the app in a hidden window

The person is working on this desktop. No test, script or check may put a
window on it.

- Every Electron launch sets `TORNO_TEST=1`. Main then creates the window with
  `show: false` and never shows it, and exposes the test hooks.
- Never pass `--ozone-platform=headless`: Electron segfaults with it here.
- `page.screenshot()` never returns on a hidden window. Do not call it.
  `webContents.capturePage()` delivers one image per launch and hangs on the
  second call.
- Pictures of the parts come only from `window.__tornoTest.look(request)`, the
  same code the `look` tool uses; it renders to a target and does not wait for
  a frame.
- State is read through hooks, not pixels: `window.__tornoTest.state()` and
  `.camera()`, `.pickAt(fx, fy)` for what a point of the canvas is on and
  `.project(point)` for where a point of the object is drawn (both in fractions
  of the canvas, to aim `page.mouse` with), `window.__tornoTerm.text()` for what the terminal shows, and
  `globalThis.__tornoMain` in main (`app.evaluate`) for the MCP address.
- A test works on a temporary copy of `kernel/tests/fixtures/ws`, never on
  the fixtures themselves and never on a real workspace.
- Do not touch the clipboard.
- Never click "Open folder" unless main runs with `TORNO_TEST=1`: only then is
  the folder dialog replaced by `globalThis.__tornoMain.pickFolder` (the folder
  to answer with, or null), and `picks` counts the times it was asked.
- `TORNO_TEST=1` also skips the single-instance lock, so test launches can run
  side by side.

## Never run the real `claude` CLI from tests

Tests set `TORNO_AGENT_CMD` to the stand-in, `node app/test/fake-agent.mjs`,
which prints its arguments and posts hooks on request. The real CLI spends the
person's subscription, depends on their login and settings, and asks questions
in folders it has not seen. Checking torno against the real CLI is done by
hand, once per change that needs it.

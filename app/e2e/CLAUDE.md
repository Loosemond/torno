# torno: the app in a hidden window (`app/e2e`)

The Playwright specs, which start the built app. The rules here bind every launch of Electron, by a test, a
script or a check, whoever makes it.

What binds every part of torno is in the `CLAUDE.md` at the root of the repository: read that first.

## Testing the app in a hidden window

The person is working on this desktop. No test, script or check may put a
window on it.

- Every Electron launch sets `TORNO_TEST=1`. Main then creates the window with
  `show: false` and never shows it, and exposes the test hooks.
- Never pass `--ozone-platform=headless`: Electron segfaults with it here.
  `scripts/torno` never passes a platform when `TORNO_TEST=1`, and refuses
  `headless` whoever asks (`TORNO_OZONE` is `wayland` or `x11`, or unset).
- No test and no check runs `scripts/torno --install-desktop` or
  `--uninstall-desktop` with the person's own `HOME` or `XDG_DATA_HOME`:
  `src/launcher.test.ts` gives the script a temporary one of each. The entry
  is tested by `--print-desktop`, which writes nothing.
- `page.screenshot()` never returns on a hidden window. Do not call it.
  `webContents.capturePage()` delivers one image per launch and hangs on the
  second call.
- Pictures of the parts come only from `window.__tornoTest.look(request)`, the
  same code the `look` tool uses; it renders to a target and does not wait for
  a frame.
- A CSS animation that never ends grew the hidden window's memory by about
  3 MB a second for as long as it ran (146 MB to 2.5 GB in half an hour of
  the sweep). There is none any more, and `styles/styles.test.ts` fails for
  one. Nothing that is ready waits on `requestIdleCallback` or a frame
  either (`state/thumbs.ts`): a window nobody looks at is given frames late.
- State is read through hooks, not pixels: `window.__tornoTest.state()` and
  `.camera()`, `.pickAt(fx, fy)` for what a point of the canvas is on and
  `.project(point)` for where a point of the object is drawn (both in fractions
  of the canvas, to aim `page.mouse` with), `.markScreen(id)` for where a
  mark's label is, `.timePicks(count)` for what a pick costs and
  `.timeFrames(count)` a frame, `.scans()` for the scans as the viewport has
  them (`loaded`, `ready`, where each stands), `.pickScanAt(fx, fy)`,
  `.projectScan(id, local)` and `.timeScanPicks(count)` as the same for
  scans, `.regions()` for what is tinted,
  `window.__tornoTerm.text()` for what the terminal shows, and
  `globalThis.__tornoMain` in main (`app.evaluate`) for the MCP address, the
  mark store (to leave the marks an agent would), the scan store (`scans`),
  `marksChecks(objectId)`
  (started and finished counts: equal when no check of the marks is under way)
  and `letGo(objectId)`, which has an object's status say that the kernel let
  its build go to make room: no test's kernel is short of memory.
- `page.mouse` and `page.keyboard` work on the hidden window: marks are placed
  in tests with real pointer events through the tools.
- A test works on a temporary copy of `kernel/tests/fixtures/ws`, never on
  the fixtures themselves and never on a real workspace.
- Do not touch the clipboard.
- Never click "Open folder" unless main runs with `TORNO_TEST=1`: only then is
  the folder dialog replaced by `globalThis.__tornoMain.pickFolder` (the folder
  to answer with, or null), and `picks` counts the times it was asked. The
  same holds for "Import scan…": `pickFile` and `filePicks`.
- `TORNO_TEST=1` also skips the single-instance lock, so test launches can run
  side by side.

## Light and dark

- `e2e/themes.spec.ts` starts torno once in each theme, holds the tokens the
  window computes to the same ratios, and writes pictures of the parts and
  one of the window to `app/e2e/.results/themes/`. With `TORNO_SHOTS=<dir>`
  it also captures the window in every state worth looking at
  (`<dir>/ui-<state>-<theme>.png`), one launch each. After a change of a token or of a rule that
  colours something, look at them.

## The page of objects

- Tests: `__tornoMain.opened()` (the objects opened in this run: empty while only the page was looked at),
  `window.__tornoTest.timeThumbnail(count, given?)`. `TORNO_SHOTS=<dir>` has `e2e/show.spec.ts` write
  captures of the page, one launch each.

# torno

A desktop workbench for making CAD parts with an AI coding agent. `README.md`
says what it does and how to run it; the design is
`docs/superpowers/specs/2026-10-08-torno-design.md`.

- `app/`: the Electron app (pnpm, TypeScript, electron-vite). `src/main` is the
  shell, the kernel client, the sessions, the HTTP server with the MCP tools and
  the hooks, the marks (`src/main/marks`) and the scans (`src/main/scans`). `src/renderer` is the UI, the
  three.js viewport (`viewport/`) and the tools that point at it (`tools/`).
  `src/shared` holds the types both sides use; `shared/bridge.ts` is everything
  the renderer may ask of main.
- `kernel/`: the Python package `torno_kernel` (uv). It loads build123d models
  and tessellates them, in forked workers, and imports scans, in a process of
  its own (`python -m torno_kernel.scans`).
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

## Marks

- A mark is a pin, a pick, an arrow, a stroke, a shape, a dimension or a region
  of a scan, with a note (`app/src/shared/marks.ts`). Ids are `M1`, `M2`, … per object, never reused,
  given by main only.
- Main is the only writer of `<object>/.torno/marks.json`
  (`src/main/marks/store.ts`): one change at a time per object, written
  atomically before it is told. The renderer and the MCP tools go through it.
- Coordinates and refs of a mark are in the object frame of the mark's layout.
  A ref is `<part>`, `<part>/F<i>`, `<part>/E<i>` or `M<n>`; to the kernel it
  is sent with the layout in front (`assembly:lid/F12`).
- After every successful build, and when a mark is added, reopened or put
  somewhere else, the marks are checked against the build
  (`src/main/marks/reanchor.ts`, one `nearest` query per layout). A mark stays
  where it was put on its part; its ref and descriptor are refreshed;
  `anchorState` says `drifted` or `orphaned`. Whatever reports a mark says so:
  the agent is told nothing it cannot rely on.
  - The one way a mark moves: its anchor records how far its part was spread
    for display (`Anchor.arranged`, zeros for a part that was not moved), and
    when a build spreads the part otherwise, everything the mark holds moves
    by the difference before it is judged. An anchor that records none (a
    mark from before) is not moved: the check records it. Main sets
    `arranged` (`asPlaced`), never the window.
  - A check writes what it judged each mark from; `MarkStore.reanchor` passes
    over a mark whose anchors are no longer those (it was put somewhere else
    meanwhile).
  - `checkedRevision` is the build a mark was last checked against. An open
    mark with any other than the last build's is unchecked (`isUnchecked`),
    and every report of it says so. Revisions count from 1 in every run, so
    the store drops what a file says of it when the file is read. A check
    that could not say of every mark is tried again after 2, 10 and 30 s
    (`retrying`), until the workspace is closed; and every 30 s beyond that
    while the kernel only answers that its worker is still busy (`isBusy` in
    `kernel/client.ts`: the check resolves `'busy'`).
  - A pin whose point is on an edge is on that edge (`judgePin`): its anchor
    has `edge` and, when two faces meet there, `between`.
- Status: `draft` until a `UserPromptSubmit` hook has carried the mark to the
  agent of its own object (`src/main/context.ts`; turned `sent` only once the
  answer has left), then `resolved`. No other hook consumes drafts. A sent
  mark of the person's whose note or shape changes is a draft again
  (`sentBefore`: told as `(changed)`), as is a dimension of the agent's whose
  `expected` or `tolerance` the person changes; and one the person makes a
  draft again after it was resolved says so until it is sent (`reopened`:
  told as `(reopened by the user)`).
- What only main says of a mark (`MAIN_ONLY_KEYS` in `shared/marks.ts`:
  `resolvedBy`, `acknowledged`, `sentBefore`, `reopened`, `checkedRevision`) is never
  taken from the window or from a tool's arguments. A mark the agent resolved
  stays in the panel's main list until the person acknowledges it.
- A dimension is a mark that holds an exact value: a distance or an angle
  between its two ends (`a`, `b`), or a radius, a diameter or a wall thickness
  at its one. Main measures it with the kernel's `measure` as it is kept
  (`src/main/marks/measure.ts`: each end goes with its ref and its point, an
  end with no ref as a bare point). One the kernel refuses is not kept, nor
  one placed on another build than the last; one the kernel could not be
  asked about is kept without a value.
  `value`, `how`, `points`, `measuredRevision`, `refused` and `verdict`
  (`MEASURED_KEYS`) are main's alone, like `MAIN_ONLY_KEYS`. The verdict is
  never stored on anyone's word: the sanitiser works it out
  (`shared/dimension.ts`: pass when `|value − expected| <= tolerance`, 0.05 mm
  or 0.1° when none is given). A changed `expected` or `tolerance` is news of
  the mark (`(changed)`); a value measured again is not. Its ends are judged
  like pins. Numbers shown are written by `shared/format.ts` `number`, on
  both sides.
  - Dimensions are the person's checks of the part. After every successful
    build, once the marks are checked against it, every unresolved dimension
    is measured on it, in the same pass (`checkMarks`: `reanchorAll`, then
    `remeasureAll`; one write for all, under the guard of re-anchoring: a
    dimension whose ends or expectation changed meanwhile is passed over).
    Only from ends that check judged on that build (`checkedRevision`): never
    through a ref of an older build. A pass that could not measure every
    dimension is tried again like one that could not check every mark.
  - `measuredRevision` is the build the kernel last said of it on. A
    dimension whose value is not of the last build has no value there
    (`measuredValue(mark, revision)`, the one rule for `describeMark` and the
    tools' data, and through `shownDimension` in `shared/dimension.ts` for
    the row, the chip and the picture): it is `not measured on rN (was 6 mm
    on r11)`, with no verdict, and its line on the part is drawn dimmed
    (`staleValue`). Revisions are of this run, so on the first build of a
    run every dimension is measured; until then one read from its file is
    `not measured yet`, and what it holds is told to no one.
  - A resolved dimension is no longer measured. Whatever shows it gives what
    it holds as `as measured on rN`, stale, with no verdict
    (`shownDimension`; `[as measured on rN]` and `resolvedValue` in main).
    So `resolve_mark` refuses a dimension of the person's that has an
    `expected` (`resolveMarkTool`), saying how the check stands, and says of
    any other dimension it resolves that it is no longer measured.
  - An end the build moved (`drifted`) is measured from the face its
    refreshed ref names, and the mark says `[moved since it was placed: check
    it]`. Nothing is ever measured through a ref the check did not confirm or
    refresh: an end on an edge keeps the edge it was put on when that is no
    longer under it, and is then not measurable (`the edge plate/E7 it was on
    is not under its end on r12`), never measured by that number nor from the
    face under it. Whether an edge is under a point is one rule
    (`marks/tolerance.ts` `edgeIsUnder`), for judging an end and for
    measuring through it: the edge of that number is within
    `EDGE_TOLERANCE_MM` (0.5 mm) of the point, or the nearest point of the
    part is on that very edge and within the part's tolerance (`tolerance`:
    `max(0.5 mm, 0.5 % of the bbox diagonal)`). So a dimension between two
    edges of a plate that gets thinner by more than that, or whose edges are
    renumbered, is not measurable and has to be placed again, while one
    whose edge moved less is measured through it. Between the plate's faces
    it is measured again however thin the plate gets: faces are what to
    click for a check that must hold across edits. Besides
    that, only a lost part (`orphaned`) or a refusal by the kernel makes it
    `not measurable`; `refused` keeps the reason.
  - A measurement is of the build its refs are of: `measureDimension` is
    given that revision and rejects when the last build is another, before or
    after the kernel is asked. `MarkStore.reanchor` drops `measuredRevision`
    of a dimension when it gives an end another ref or point, and
    `MarkStore.measured` keeps nothing measured through other ends, or for a
    resolved mark.
  - Sent and unresolved, it is "pinned": with every prompt, under
    `Dimensions (measured on rN):` (`dimensionsHead`: it also says when a
    build is running or the latest failed, so that these are not of the last
    edit), each pinned dimension that fails, is not measurable or was
    not measured on the last build has its line, until it passes, and the
    number that pass is said, naming those among them that moved
    (`src/main/context.ts`). A draft dimension is
    told with the drafts. The status line counts every unresolved dimension
    that fails, sent or not.
- The MCP tools (`src/main/mcp/tools.ts`, which holds every input schema and
  description; those that place and resolve marks in `mcp/markTools.ts`; those
  that read the part in `mcp/readTools.ts`; those that ask about scans in
  `mcp/scanTools.ts`): `scene`, `look`, `marks`,
  `describe`, `highlight`, `show`, `add_mark`, `resolve_mark`, `measure`,
  `section`, `check`, `scans`, `scan_clash`, `scan_deviation`. `show` changes
  the view for now and is never saved to `scene.json`; it is refused while a
  button is held in the viewport. `marks`, `describe`, `add_mark`, `measure`,
  `section`, `check` and the three scan tools say which
  revision they answer from, and that it is stale while a newer build runs or
  has failed. `scene` counts the unresolved dimensions held to a value
  (`dimensions: {pass, fail, notMeasured}`).
  - Every tool is registered through `registerTools`, which refuses a key the
    tool's schema in `TOOLS` does not name (`refusedKeys`, `mcp/keys.ts`),
    naming the keys it takes: a dropped key would change what is measured. A
    new argument goes into the schema, or it is refused.
  - The schemas of a plane and of an end of a measurement refuse nothing
    (`planeInput`, `endInput`: a union that ends in `z.unknown()`): whatever
    is given reaches the handler, which answers with what one looks like
    (`NO_PLANE`, `noEnd`). Keep it so: the schema's own refusal says only
    "Invalid input".
  - `measure`, `section` and `check` answer with the kernel's reply and a
    `reading` of it in a line. Refs and marks are checked against the scene in
    main before the kernel is asked (`endsOf`: a mark stands for what it is on
    only when the last build's check confirmed it, and a dimension for
    neither of its ends), and nothing is said to be exact that the kernel
    does not say is: `≈` and `approximate` otherwise. A query that took its
    30 s is told as that; the answer of a worker still busy with one is told
    in the kernel's words (`refusal` in `mcp/readTools.ts`).
  - The picture `section` returns is a 2D drawing of the kernel's outlines
    (`src/renderer/viewport/sectionDrawing.ts`), made by the window on a
    canvas of its own whichever object it shows, on the light sheet whatever
    the theme, with what is up in the world up on it. The kernel is asked for
    outlines within 0.01 mm (`SECTION_DEFLECTION`; the agent may give
    `deflection`, 0.005 to 0.05), and the drawing is made from them in full.
    The JSON holds at most 4,000 points in all (`pointsFor`): each loop its
    share by its length, 8 at least, the shortest beyond 500 loops left out
    and counted (`loopsOmitted`); areas are the kernel's, never worked out
    from thinned points.
  - A plane is `{origin, normal}` or `{axis, at}` (`planeOf` in
    `shared/view.ts`): the latter has its normal along +axis.
  - `add_mark` with `kind: 'dimension'` goes through `addDimensionTold`, as
    the Measure tool's do through `addDimension`, kept `sent`. One kept
    without a value of the last build is answered `NOT MEASURED: …` first
    (`keptUnmeasured`), so that its line is not taken for a measurement.
- `<object>/.torno/state.md` says the same as the tools, as text
  (`src/main/statefile.ts`): the build, the parts, the scans with how each is
  aligned in every layout, the open marks. Its first line is when it was
  written.
- User marks are drawn in `--user-mark`, agent marks in `--agent-mark`, and
  nothing else in the UI uses those colours. A picture for the agent draws
  every mark alike: no active mark, no selection, no hover, no gizmo. A mark
  on a part that is not drawn is not drawn either, on screen or in a picture.
- Tools and keys: `V` select, `P` pin, `A` arrow, `D` draw, `S` shape, `X`
  section, `M` measure (`T` there: the wall under the pointer as of the key,
  picked anew where `Viewport.pointerAt` says the pointer is), `L` align a
  scan (`G`, `R` there for its handles), `B` region of a scan (`[`, `]`, `E`,
  `Z` there); `G`, `R`, `T` for the gizmo of the active shape. A slider is no field to type in
  (`ui/typing.ts`): the keys work with one in focus. The Measure tool is `tools/measureTool.ts`;
  what its clicks measure is chosen in the strip `MeasureChoice` of
  `ui/ToolPalette.tsx`, and a dimension's expectation is typed in
  `ui/DimensionFields.tsx`. A tool is a `Tool`
  (`src/renderer/tools/Tool.ts`) and gets every pointer event from the one
  subscription in `ui/ViewportPane.tsx`. Nothing of a pointer move goes
  through React or the store.

## Section

- One plane per object view (`SectionPlane` in `shared/view.ts`: `origin` and
  a unit `normal`, object frame; what is on the side the normal points to is
  not drawn). It is view state: `store.section`, saved in `scene.json`
  (`section`), reported in `ViewState`, drawn in `look` pictures unless they
  ask for another plane or none. The agent's `show` sets it for now, never in
  the saved file. It never changes geometry or marks.
- Drawing is `viewport/section.ts`: the parts' materials are clipped, and each
  closed solid (`BuiltPart.solid`) gets its cut face by stencil counting, per
  part, with an outline from the mesh. A part that is no closed solid is cut
  open. What lies in the plane is kept (`KEPT_WITHIN_MM`); a part the plane
  only touches or leaves nothing of is not drawn (`keepsNothing`). Marks,
  grid and gizmo are not cut; a mark anchored in the half taken away is drawn
  dimmed (`MarkLayer.setSection`).
- Picking sees what is drawn (`pickUnder`): on a cut face nothing is hit and
  the pointer says so.
- The Section tool (`tools/sectionTool.ts`) moves the plane only by a drag
  that starts on its handle; any other drag turns the camera. The bar is
  `ui/SectionBar.tsx`. The plane moves in the viewport during a drag and is
  kept in the store once, on release, to the millionth of a millimetre.
- Numbers shown or told of a section go through `shared/format.ts`.

## Scans

- A scan is one mesh in millimetres and Z up, `<object>/.torno/scans/<id>/mesh.bin`
  (layout: `kernel/src/torno_kernel/scanfile.py`, read alike by the kernel,
  main and the window through `shared/scans.ts` `parseScanMesh`). What is
  drawn is what is picked, painted and checked. A triangle's number is its
  place in that file and never changes while the file is the same.
- The source is only read: referenced by absolute path, size, modification
  time and SHA-256, never copied, moved or written. The scan works from its
  mesh when the source is gone (`sourceState`), and says what to do when the
  mesh is gone too (`meshState`).
- Import is a process of its own, `python -m torno_kernel.scans
  import|convert` (`main/scans/importer.ts`, `kernel/client.ts`
  `scanCommand`): never the supervisor, never a build worker, never the
  window. trimesh and pillow are the extra `scans` of the kernel package,
  asked for by that command only; the kernel starts without them. Its stdout
  is one line of JSON, its last; stages go to stderr. It runs in a process
  group of its own, and the group is killed on its timeout (300 s) and when
  the workspace is left. One file at a time.
- Unit and up axis are assumed from the format and the size (`scans.guess`),
  shown on the row, and changed there by `convert`. Above 2,000,000 triangles
  the import reduces the mesh and says so.
- Main is the only writer of `.torno/scans.json` and of `.torno/scans/`
  (`src/main/scans/store.ts`): one change at a time per object, written
  atomically before it is told. Ids are `S1`, `S2`, … per object, never
  reused, also when `scans.json` is lost and a folder `S<n>` is still there.
  Visibility, opacity and colour mode are view state, in `scene.json`
  (`scans`); what `show` sets of them never reaches that file.
  - A conversion or a re-import writes a new file, `mesh.<n>.bin`, and the
    record names it (`imported.mesh`; absent means `mesh.bin`): the write of
    `scans.json` is the commit, the old file goes after it. Never build a
    mesh's path by hand: `ScanStore.paths()`, after `list()`.
  - What may be deleted under `.torno/scans/` is in `meshfiles.ts` `sweep`:
    a folder only when it holds the `importing` marker of an import that
    never ended, an unnamed mesh only while the named one is there, nothing
    through a link, nothing beside a `scans.json` that was set aside.
  - Main alone names a mesh or a mask file. The one path the window gives is
    the source of an import, which main checks (`sourceOf`: absolute, one of
    the five formats, not inside the object's `.torno/`) and only reads.
- One transform per layout (`Scan.alignments`), scan frame to object frame,
  `p' = s · R(q) · p + t`. No transform for a layout: "not aligned" there,
  drawn where it was imported, and refused by `scan_clash`, `scan_deviation`,
  `section`'s `scan`, a scan end of `measure` and `look`'s `scanColour`. The
  maths is `shared/align.ts`, pure, for both sides.
  - What only main says of an alignment (`ALIGNMENT_MAIN_ONLY`: `frame`,
    `at`, `revision`, `fitRms`, `rough`, `sourceChanged`, `confirmed`,
    `before`) is never taken from the window; residuals, `rms` and `rough`
    are worked out by main (`reckoned`). Main refuses an alignment made on
    another build than the last, one tied to a part torno moved
    (`tiedToMoved`), and a rough or scaled one without the person's yes.
  - What an alignment rests on is `basisOf`: a fit of `pairs`, a `floor`
    only, or a `hand`, and whether a hand moved it afterwards. `rough` is of
    a fit of pairs alone (fewer than 3, almost in a line, or `fitRms` over
    5 mm), and a move by hand does not launder it.
  - `ScanLayerState.transform` is where the window draws the scan, which may
    be a preview. Nothing told to the agent or stored reads it.
- After every build and every alignment the alignments are checked
  (`main/scans/alignCheck.ts`): the model points an alignment is tied to
  (ends clicked on a part, a floor laid on a face) are looked for on their
  parts again with the kernel's `nearest`, and each part's `arranged` is
  compared with what it was. What is found is told; nothing is ever
  re-fitted. An alignment not checked against the last build is asked about
  again every 30 s and whenever the scans are listed for a tool, the prompt
  or the window (`keepChecking`, `recheckAlignments`), until it is. "Still
  right" (`alignmentHolds`) holds the alignment against the model as it is
  now (`confirmed.held`).
- **One notion, one wording.** How an alignment stands is `standingOf(scan,
  layout, revision)` in `shared/scans.ts` (`basis`, `rough`, `stale`,
  `unchecked`, `waiting`, `failed`, `note`), for the row, the bar and the
  picture's caption (`scansNote`). What main says of it to the agent is
  `alignmentSaid` in `main/scans/said.ts`, and nothing else in main words an
  alignment: the tools' `alignment`, the doubts that open a reading
  (`first`), its closing sentence (`last`), the `Scans:` line of the prompt,
  `state.md`. A tool reads it again once the kernel has answered (`saidNow`).
- A part torno moved for display is refused by the scan checks
  (`scanSpread`), naming the layouts that place it as the model does, or
  `def assembly(p)`, and the parts it did not move; so is a part that stood
  elsewhere when the scan was aligned (`scanFrame`). Other parts being spread
  otherwise is a doubt, said first, not a refusal. Refusals are made in main
  before the kernel is asked (`scanFor`).
- The kernel's scan queries (`scanclash.py`: `scan_clash`, `scan_deviation`,
  `scan_section`) run in the live build worker, which is given paths and
  never looks for a file: inside or outside by ray parity on the part's own
  tessellation, crossings by the edges of each mesh against the other's
  triangles, distances from a `cKDTree` over that mesh sampled every
  millimetre (scipy, from the workspace, imported when first needed), the
  points an answer names taken again on the B-rep. At most 200,000
  candidates, 32 points retaken, 8 clusters told, 10 s (`BUDGET`); a
  deviation takes 100 to 20,000 samples within 0.1 to 200 mm; a section
  tells 4,000 points, of which the tool's JSON keeps 2,000. What was thinned
  or left undone is in `sampling`, and a reading never tells an unfinished
  count as a no. A scan and its masks are kept by path, inode, times and
  size: a file written anew is read anew.
- **Nothing from a scan is ever said to be exact.** Every reply has `exact:
  false`, `approximate` (`SCAN_APPROXIMATE`) and `≈`, the revision, the
  layout and the alignment with its rms. `measure` with a scan end forces
  `exact` false whatever the kernel says of the distance.
- A region is a mark of kind `region` (`main/marks/regions.ts`): its
  triangles are `<id>/<mark>.mask`, a bit each, of the triangle count of the
  mesh it was painted on. The window sends the bits (`NewRegion.bits`), never
  a path; main checks them against the mesh, works out its numbers
  (`REGION_KEYS`, `shared/regions.ts`), held in the scan's own frame under
  `local` and told in the object frame of its layout, and writes the mask. A
  mask of another triangle count is never applied: the region is orphaned
  when its scan is removed, when the scan is imported again and the mesh or
  the source's hash changed, and when its mask is gone or does not fit
  (`orphanLost`). A conversion keeps the triangles and restates the numbers.
  `add_mark` has no such kind: only the person paints.
- In the window a scan's bounds tree is built in a worker
  (`viewport/scanBvh.worker.ts`), indirect, so triangle numbers hold; a scan
  is drawn before it can be pointed at. A scan drawn at 95 % or more blocks
  the pick of a part behind it; a thinner one does not. Nothing of a brush
  stroke or of a drag of the gizmo goes through React or the store. A picture
  coloured by distance is refused past 60,000 points or 1.5 s
  (`scanDeviation.ts`): it is worked out on the window's thread.
- What the window says of its scans (`ViewState.scans`) is sanitised in main
  (`scansOf` in `main/look.ts`) before anything is told of it.
- A scan and a picture coloured by distance use tokens of their own
  (`--scan-plain`, `--deviation-*`); a region is a mark and is tinted in its
  author's mark colour.
- Tests make their scans in code (`kernel/tests/scanfix.py`,
  `app/src/test/scanFixtures.ts`). No scan file is committed.
- What must never happen: a number of a scan told as exact; a preview told
  or stored as the alignment; a mask applied to another mesh than the one it
  was painted on; a mesh or mask path taken from the window or from a tool's
  arguments; a write outside `.torno/`, or to a scan's source.

## Exactness

- Lengths are millimetres, angles degrees, areas mm², volumes mm³, masses
  grams. Numbers shown go through `shared/format.ts` (four significant
  digits at most); numbers stored and returned as data are in full.
- Every number told to the agent is the kernel's, from the B-rep. The mesh
  drives only the estimate read out at the pointer while a measurement is
  pending (`≈`), which the kernel's value replaces. What is taken from a scan
  is the one exception, and is never said to be exact (see Scans).
- Areas and volumes are measured in one place, `kernel/src/torno_kernel/extent.py`.
  A volume is integrated by Gauss-Kronrod to 1e-9 of itself and given as
  exact. An area is exact of planes, cylinders, cones, spheres and tori, and
  of a curve extruded straight and not cut along its height. The area of any
  other face (loft, B-spline, revolved spline, offset) is never said to be
  exact: `exact: false` (`areaExact` in `describe` and `section`), and `how`
  says `approximate, good to about N significant digits` (2 to 6), or
  `approximate: its integrals differ by 2.1 %`, with no count of digits, when
  they are too far apart for two. A part's digits are of its own area (its
  faces' spreads summed, against the whole), so it may say N while one small
  face says none. The app reads neither: it tells `how` as it is.
  A bbox is exact only of planes and cylinders with straight and circular
  edges (`measure.py` `_boxed_exactly`).
- This costs time on freeform parts, at every build (each part's volume is in
  the scene) and in `describe`, `volume`, `mass` and `area` of a whole part:
  seconds on the first ask of a freeform part, then kept by the worker until
  the next build. A query has 30 s.
- `measure`'s `moved`, on a thickness, is how far the given point was from
  the face it was laid on; it says nothing of the value's precision.
- A `print` layout that was spread (`arrange.py`) has its parts where torno
  put them. Between two parts of which either was moved, `check overlap`,
  `check clearance` and `measure distance` are refused in main
  (`spreadApart` in `marks/spread.ts`), naming the layouts that place both
  as assembled; so is a distance from a bare point to a part that was moved.
  A dimension of such a distance is not kept, and one there already is not
  measurable on that build (`spreadReason`, with where to measure it). An
  angle is answered, since parts are moved and never turned: each end of a
  dimension moves with its own part (`shiftB`). The window says it in a line
  (`SPREAD_LINE` in `tools/measureTool.ts`), in place of the estimate. An answer of one part carries its `arranged`, and a `section` a
  note and each part's. Fit is checked in a layout that places the parts as
  assembled (`assembly(p)`).

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
  queried, whose queries are then `no_build`. A worker keeps what `nearest`
  worked out of each part it was asked about. A query names its folder (`dir`)
  and has 30 s, after which it is answered `timeout` and the worker left alone.
  Until that worker has answered every query that was given up on, new queries
  to it are answered `timeout` at once: it answers one at a time, and is still
  busy with those.
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
  of the canvas, to aim `page.mouse` with), `.markScreen(id)` for where a
  mark's label is, `.timePicks(count)` for what a pick costs and
  `.timeFrames(count)` a frame, `.scans()` for the scans as the viewport has
  them (`loaded`, `ready`, where each stands), `.pickScanAt(fx, fy)`,
  `.projectScan(id, local)` and `.timeScanPicks(count)` as the same for
  scans, `.regions()` for what is tinted,
  `window.__tornoTerm.text()` for what the terminal shows, and
  `globalThis.__tornoMain` in main (`app.evaluate`) for the MCP address, the
  mark store (to leave the marks an agent would), the scan store (`scans`) and
  `marksChecks(objectId)`
  (started and finished counts: equal when no check of the marks is under way).
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

## Never run the real `claude` CLI from tests

Tests set `TORNO_AGENT_CMD` to the stand-in, `node app/test/fake-agent.mjs`,
which prints its arguments and posts hooks on request. The real CLI spends the
person's subscription, depends on their login and settings, and asks questions
in folders it has not seen. Checking torno against the real CLI is done by
hand, once per change that needs it.

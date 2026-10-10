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
- The MCP tools (`src/main/mcp/schemas.ts` holds every input schema and
  description, and `TOOLS`; `mcp/tools.ts` registers them and holds what
  every tool shares, with `marks` and `describe`; `scene`, `look` and `show`
  are in `mcp/viewTools.ts`; those that place and resolve marks in
  `mcp/markTools.ts`; those that read the part in `mcp/readTools.ts`; those
  that ask about scans in `mcp/scanTools.ts`): `scene`, `look`, `marks`,
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
    The JSON holds at most 1,500 points in all (`MAX_SECTION_POINTS`,
    `pointsFor`), the parts' outlines and a scan's lines together: each loop
    its share by its length, 8 at least, the shortest beyond 187 loops left
    out and counted (`loopsOmitted`); the scan's share is asked of the kernel
    as `points` (`scanShare`), which thins its lines once and tells them to
    0.1 mm. The reading says what was thinned. Areas are the kernel's, never
    worked out from thinned points.
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
  scan (`G`, `R` there for its handles, `Tab` in Pairs for which end is asked first), `B` region of a scan (`[`, `]`, `E`,
  `Z` there); `G`, `R`, `T` for the gizmo of the active shape; `E` draws the parts apart or
  together (explode, below: offered to the tool in hand first, so the Region tool's `E` stays its own). A slider is no field to type in
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
- A section and an explode are never on together (Explode, below): cutting
  puts the parts of the layout shown together, and nothing is drawn apart
  while the section is there.

## Explode

Explode is view state per layout (`ExplodeState` in `shared/explode.ts`:
`amount` 0 to 1, a distance `scale` 0.25 to 4, an `axis`: from the centre, or
along x, y or z), kept in `scene.json` (`explode`, by layout name), never
geometry, never in a mark or a measurement. `explodeOffsets` says how far each
part of a layout is drawn from where it is: from the centre by
`(R + d) × amount × scale` along the line from the centre of the layout's box
to the centre of the part's (`R` half the diagonal of the layout's box, `d`
the part's distance from that centre; a part within `SHARED_CENTRE_MM`,
0.01 mm, of the centre stays); along an axis the parts are ranked by their
centres on it and set `2R × amount × scale` apart.

- **One rule says what is drawn apart: `explodeShown(explode, section,
  parts)`** (`shared/explode.ts`). Nothing is while there is a section, of a
  layout with fewer than two parts, or of parts that all share the centre
  they would go from: then nothing is apart, no tool is locked and nothing
  says exploded, whatever is kept for the layout. The window
  (`explodeNow(state, layout)`), a picture (`pictureExplode`) and main ask
  it; an exported page must too. `nothingApart` says which of the last two
  it is: the bar says `These parts share a centre: choose an axis`, and
  `look` or `show` asked for an explode there answers with
  `nothingApartText`.
- **Exploded is display only.** `Part.loc`, `Part.bbox`, every anchor, every
  `points` of a dimension and everything the kernel is asked are of the parts
  as built. `Viewport.setExplode` moves each part's group (`placePart`, the
  one place a group is put; `viewport/explode.ts` holds the offsets as drawn
  and as they will be once a move has ended, `PartsApart`), and nothing else:
  the scans and the grid stay. The slider moves the parts as it is dragged
  and the store keeps the amount once, on release (`actions.setExplode`);
  `E` and the agent's `show` go there over 220 ms, a step a frame, with no
  state in React.
- **A pick is of the part as built.** `Viewport.pick` takes the display
  offset of the part hit away from the point (`asBuilt`). Selecting,
  hovering, "Insert" and the readout at the pointer work exploded.
  `Viewport.project(point, part)` says where a point of a part is drawn;
  `bounds()`, `partBoxes()` and `sectionBox()` are of the parts as built,
  while `fit` and the named views frame them where they are drawn.
- **Nothing is marked, moved or measured from the window while the parts
  are drawn apart.** Pin, Arrow, Draw, Shape, Measure, Section, Align and
  Region are handed no pointer event and no key (`routePointer`,
  `ToolContext.exploded`), and the pointer says `EXPLODED_TOOLS`. The gate
  reads the store **and the screen** (`explodeNow(s) !== null ||
  viewport.exploded()`): the parts are still apart for a moment after the
  store says together, and under a slider being dragged before it says
  apart, and a pointer's ray is of the screen. What a tool had under way is
  dropped once when the parts go apart. "Note" on the selection, "Re-place"
  and a region's "Edit" are disabled with the same words, the gizmo holds
  nothing (a shape's or a scan's), and the points of an alignment and the
  brush ring are not drawn.
- **Marks are drawn moved with their part** (`viewport/marks/apart.ts`
  `markOffset`, `MarkLayer.setOffsets`): the mark's objects and its label,
  never the mark. A mark whose ends are on parts that moved differently
  (`'split'`: a dimension between two parts, an arrow whose head is at
  another part than its foot, by the parts' boxes) is drawn between them
  where they are drawn, dimmed and dashed (`spanning`, `setDashed`): the
  line is as long as the parts are apart, which measures nothing. Its row
  says `spans parts drawn apart`, the caption of a picture and of `show`
  names it (`spanningMarks`, `explodedNote`), and a dimension's value stays
  the kernel's, of the parts as built. A mark on no part, and a region, do
  not move.
- **A section is never drawn exploded (D2).** While there is a section
  nothing is drawn apart (the rule above). `actions.setExplode` answers
  `Take the section away to draw the parts apart` to an amount above 0;
  `actions.setSection` with a plane sets the `amount` of the layout shown to
  0, as if by hand. Another layout keeps its own, in the file too, and is
  drawn together while the section is there, apart again when it is gone.
  `sceneFileOf` never writes a section with an amount above 0 for the layout
  the file opens to. `look` and `show` refuse the two together
  (`NOT_EXPLODED_AND_CUT`), in main and again in the window. A picture that
  is cut by a plane of its own while the screen is exploded is drawn of the
  parts together; so is one that colours a scan by its distance to a part
  (`scanColour`), and its caption says so. Scans are not moved: a caption
  that draws both says `scans are where they are`, and so does the bar.
- **The agent.** `look` takes `explode` (a number, or `{amount, axis,
  scale}`; absent is as on screen for the layout on screen, `null` or `0`
  together); `show` sets it for now. What is nearly an explode is refused
  with what one is (`explodeAsked`, exported for `save_view`): an amount
  outside 0 to 1 (a percentage), a scale outside its range, an axis that is
  none, a key it does not take. Only a file and the window's own report are
  brought into range (`explodeOf`). `scene` reports `explode` and says so in
  its `note`; the first line of the prompt's context says `, exploded 40 %
  along z (display only)` after the layout. A picture drawn exploded, and
  what `show` answers, say `exploded 40 % along z` with `EXPLODED_NOTE`.
  Every other tool answers of the parts as built and says nothing of
  explode. The view the window reports (`ViewState.explode`) is kept by
  `reportView` only as what `explodeOf` makes of it.
- **What the agent shows is never the person's, field by field.**
  `shownByAgent.explode` holds, by layout, how the person had it (`theirs`).
  A field the person then sets by hand (the slider is `amount`, the bar's
  buttons `axis` and `scale`, a cut by hand is `amount: 0`) is theirs from
  then; the fields they did not set stay the agent's on screen, for now, and
  theirs as they had them in the file (`apartByHand`), as with a scan's
  view. A person who draws apart by hand a view the agent took the cut out
  of has no cut of theirs any more: the file holds one or the other.
- The control is `ui/ExplodeControl.tsx`: `ExplodeToggle`, one button in the
  view bar (pressed while the parts are apart or its bar is open, with the
  amount beside the word; pressed while apart it puts them together), and
  `ExplodeBar` under the view bar (`.viewbars` stacks them): the slider with
  the amount beside it, `From centre X Y Z`, `×0.5 ×1 ×2 ×4`, and a line
  with `role="status"` that says it is for display only, or why nothing is
  drawn apart. The bar is the notice that the parts are not where they are
  drawn. The view bar is one row at 1440 × 900 for an object with two
  layouts (`explode.spec.ts` holds it to that); in a narrower pane it wraps
  rather than run under the panels. `window.__tornoTest.exploded()` says
  whether the viewport draws the parts apart, or is on its way there or back.

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
  (`src/main/scans/store.ts`, with a region's mask files in
  `scans/masks.ts` and what an alignment becomes when it is kept, undone,
  held or checked in `scans/alignments.ts`, each a scan made of a scan):
  one change at a time per object, written atomically before it is told. Ids are `S1`, `S2`, … per object, never
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
    through a link, nothing beside a `scans.json` that was set aside. Nothing
    is written through a link either (`ownFolders`: `.torno`, `.torno/scans`,
    a scan's folder), and nothing else is deleted through one (`linkRefusal`
    in `masks.ts`): not a mask, not a scan's folder when the scan is removed
    (the removal is refused, saying to take the link away, and the scan kept), and the sweep clears nothing
    where `.torno` or `.torno/scans` is one. A re-import that a removal
    overtook takes away the folder it made again, only when it is empty.
  - What `scans.json` says is bounded as it is read (`scans/file.ts`): a
    layout name and a source path are one line, 200 and 4,096 characters at
    most; a mesh whose header gives no box is refused (`parseScanMesh`).
  - `list` and a failed read of a mesh tell the scans anew when a source or
    a mesh is found gone or back (`looked`), so a row never says "aligned"
    of a scan the tools refuse. The window asks for a mesh again when it is
    back, and after a failure only once the scans were told anew
    (`ui/scanMeshes.ts`).
  - Main alone names a mesh or a mask file. The one path the window gives is
    the source of an import, which main checks (`sourceOf` in `scans/source.ts`: absolute, one of
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
  - **No check by itself has an object built again.** A check after a build,
    on a timer or at a listing asks with `Builds.query(…, { restore: false
    })` (`checkingAlignments`, and the marks' `retrying`, whose `restore` is
    true only for the run a person's act or a tool asked for); when the
    kernel no longer holds the build it records why (`uncheckedFor`, `the
    kernel no longer holds this build`) and waits for the next `scene`. When
    the model, as it is, does not build either (`NotBuilding`, which
    `Builds.query` throws then, asked to restore or not), that is the reason
    recorded (`NOT_BUILDING`), and it is not tried again. The scans' store is
    looked up at each run of the check, as the marks' is.
  - `Builds.query` restores a build the kernel let go, for a tool or an act
    of the person; but not sources that have just failed to build
    (`Entry.failure`, until a source changes or a rebuild is asked for): it
    then rejects saying there is no build to answer from, and that one comes
    when a source changes or Rebuild is pressed. `BuildState.letGo`
    (`memory`) says the kernel let the object's build go to make room
    (`build.started`'s `retired`, or a `no_build` with `reason: "memory"`);
    `letGoText` words it for the status line and for `scene`.
- **One notion, one wording.** How an alignment stands is `standingOf(scan,
  layout, revision)` in `shared/scans.ts` (`basis`, `rough`, `stale`,
  `unchecked`, `waiting`, `failed`, `note`), for the row, the bar and the
  picture's caption (`scansNote`). What main says of it to the agent is
  `alignmentSaid` in `main/scans/said.ts`, and nothing else in main words an
  alignment: the tools' `alignment`, the doubts that open a reading
  (`first`), its closing sentence (`last`), the `Scans:` line of the prompt,
  `state.md`. A tool reads it again once the kernel has answered (`saidNow`).
- A part torno moved for display is refused by the scan checks
  (`scanSpread`), saying the whole way: a layout that places it as the model
  does and in which the scan is aligned, or `def assembly(p)`, a build, and
  the user aligning the scan in it (an alignment is of one layout); and the
  parts it did not move. A scan not aligned in the layout asked names only
  the layouts that would answer for that part (`notAligned`). So is a part
  that stood elsewhere when the scan was aligned (`scanFrame`). Other parts being spread
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
  tells as many points as it is asked for (`points`, 2 to 4,000), to 0.1 mm.
  The 10 s start once what is worked out once of the part and the scan is
  there (cut so that both stay within 20 s where they can: after one-off
  work longer than that the answer is partial and says so); when they run out before every point was
  measured (`sampling.measured`), depths and the nearest are of the points
  measured, and the reading says so. What was thinned or left undone is in
  `sampling`, and a reading never tells an unfinished count as a no. A scan and its masks are kept by path, inode, times and
  size: a file written anew is read anew.
- **Nothing from a scan is ever said to be exact.** Every reply has `exact:
  false`, `approximate` (`SCAN_APPROXIMATE`) and `≈`, the revision, the
  layout and the alignment with its rms. `measure` with a scan end forces
  `exact` false whatever the kernel says of the distance.
  - **A dimension is of the model.** `add_mark` with `kind: 'dimension'`
    refuses an end that is a point of a scan or a region (`dimensionFor`):
    it would be kept as a bare point, told as exact and checked on every
    build.
  - In a reading a length or a point taken from a scan is told to 0.1 mm
    (`scanNumber`, `scanVector`; under 0.05 mm is `under 0.1 mm`); the data
    keeps the kernel's. A reading closes with how the scan is aligned and,
    of a fit, that its RMS is of the clicked points (`RMS_OF_CLICKS`):
    never a word on how true the scan is. The fit's own figures (RMS, worst,
    where a hand left the pairs, a floor's plane) are told to 0.1 mm too in
    whatever the agent reads: what main says (`tenth` of `shared/format.ts`,
    given to `alignmentText`) and a caption, of a picture or of `show` (`standingOf`
    gives `basisText` the same). The bar and the row show the person theirs
    to the thousandth, and the data keeps them in full. What else is known of an
    alignment (`standing.note`) is said once a reply, in the reading.
    `scan_deviation` says the least distance, and that `within` is where the
    looking stops.
- A region is a mark of kind `region` (`main/marks/regions.ts`): its
  triangles are `<id>/<stem>.mask` (`maskStem`: `M7`, and `M7.2` once it was
  painted again), a bit each, of the triangle count of the mesh it was
  painted on. The window sends the bits (`NewRegion.bits`), never a path;
  main checks them against the mesh, works out its numbers (`REGION_KEYS`,
  `shared/regions.ts`), held in the scan's own frame under `local`, and
  writes the mask before the mark. `add_mark` has no such kind: only the
  person paints.
  - It is of its scan in every layout: `layout` is only where it was
    painted. It is drawn, numbered and listed in whichever layout is shown,
    and told in the layout asked (`describeMark`'s `layout`: the one on show
    for the prompt, a tool's `layout` argument), where the scan's alignment
    there puts it, or as having no place there.
  - Its size is that of its own box (`local.box`: the axes it spreads along,
    from the second moments of its surface), told as `≈ 200 × 10 × 2 mm, its
    long side along (…)`; the box along the layout's axes is told as what it
    lies `within`. Flat is thin against its lesser side (`isFlat`), the same
    however the scan is turned. Every number of it has `≈`.
  - The mark records the mesh it was painted on (`mesh`, `meshIdentity`: the
    source's hash, the counts, unit and up). `MarkStore.list` orphans a region
    whose scan is gone or has another mesh, whenever the marks are listed:
    there is no second step to skip. A mask that is gone or of another
    triangle count orphans too (`tendRegions`, when the window lists the
    scans); a mask that could not be read for any other reason leaves the
    region as it was and is said as a problem line. Orphaning is undone when
    its cause passes: `list` brings back an orphaned region whose scan is
    there again with the mesh the mark records and a mask that reads
    (`maskReads`), and says so once (`M7 is back: …`). A mask that did not
    read is not read again at every listing: one `stat` a listing
    (`maskStamp`) says whether its file is another than it was, and then it
    is, as when the scans are told anew (`MarkStore.scansChanged`); a read
    that failed for a reason that may pass (`maskReads` rejects) is
    remembered of nothing. One the window could not get for its tints is
    asked for again when the scans are told anew (`regionTints.ts`). A region's data says in a
    word how the alignment it is placed by stands (`alignment`, as
    `alignmentSaid().state`); a draft region of an object that is not the
    one open is told in the first layout of its build, and its line says
    which (`[in layout assembly]`).
  - A conversion keeps the triangles and restates the numbers and the mesh
    (`convertScan`); when that fails the scan's regions are orphaned, with why.
  - "Edit" on its row takes its mask in hand as a painting; "Keep" writes a
    new mask file, then the mark with its numbers anew (a sent one is a draft
    again, `(changed)`), then removes the old file (`repaintRegion`). A mask no
    mark names is cleared away by `tendRegions`.
  - The kernel leaves out of `ignore` only the scan vertices every triangle
    round which is painted, and as crossings only painted triangles: the rim
    of a region still counts. Asked for alone (`region`), its rim is its own.
  - The Region tool (`tools/regionTool.ts`; what is painted and not yet
    kept, and what the bar and a mark's row do with it, is the registry in
    `tools/regionPainting.ts`) takes the scan only where it is
    what is drawn at the pixel under the pointer: not behind a part in front
    of it, not in the half a section took away. The brush is a ball round
    that point. A stamp takes nothing a part hides: whenever the box of a
    part that is drawn meets the square round the stamp on the screen
    (`boxMeetsBrush`), each triangle the stamp would change is asked about
    at its middle, one pick of the parts' faces (`edges: false`: an edge is
    found 6 px off it, and is no part in front; the pointer's own pick is
    asked again so when it names an edge), and what a part is nearer than
    is left (`tools/stamp.ts` `stampTriangles`). What was asked is kept for
    the stroke while the camera is where it was. A stamp asks about 1,000
    anew at most (`STAMP_TESTS`) and takes none unasked: the bar then says,
    once the stroke has ended, that near a part the brush paints slower
    (`SLOWER`). With no part's box near, nothing is asked. When none is
    chosen the brush is a thirtieth of the scan, 25 mm at
    most (`usualRadius`); a box takes what faces the eye unless "Through"
    is chosen, and does not look at what hides what. It works while the build
    is stale. A painting is discarded by "Clear" alone, and `Z` brings that
    back; another tool, `Escape` or another object parks it (per object, in
    this run, not on the disk; it goes with its scan only once that object's
    scans are known, `scansKnown`, and with the workspace), the palette's
    Region button shows a dot, and `Escape` in the middle of a stroke gives
    up that stroke only. A kept region whose "Edit" is parked is drawn from
    its kept mask: it is left out of the tints only while the tool is in hand.
  - In Pairs (`tools/alignTool.ts`) a click gives the end that is asked for
    and no other (`expects`: the end the open pair lacks, else `first`, which
    `Tab` switches); the bar's line names the pair and the end (`nextLine`).
    A scan aligned in another layout offers that transform as a start, kept
    as by hand (`startedFrom`): never as a fit of this layout.
  - A press during a view move is answered from the camera as it is at the
    press (`CameraMove.drop`): nothing jumps the move to its end.
- In the window a scan's bounds tree is built in a worker
  (`viewport/scanBvh.worker.ts`), indirect, so triangle numbers hold; a scan
  is drawn before it can be pointed at. A scan drawn at 95 % or more blocks
  the pick of a part behind it, and the pointer says so (`hiddenByScan`); a
  thinner one does not. Seen through, a scan lays its depth down first
  (`depthOnly`), so only its nearest layer is blended. Nothing of a brush
  stroke or of a drag of the gizmo goes through React or the store. A picture
  coloured by distance is refused past 60,000 points or 1.5 s
  (`scanDeviation.ts`): it is worked out on the window's thread. It is lit,
  seen through beyond the range, and what is inside the part is drawn over
  it (`ScanLayer.colourFor`): its caption says the colours are approximate.
  A named view frames the parts; `look`'s `frame: 'all'` and "Frame" on a
  scan's row take the scans in, and a caption says when a scan reaches
  beyond the picture (`beyondNote`), when spread parts are not where a scan
  drawn has them (`spreadBesideScans`), and which scans have no mesh. The
  camera reaches for a scan no further than `SCAN_REACH` (200) times the
  sphere round the parts (`reaching`); a scan drawn of which some is outside
  the sphere the camera is then given is cut by the far plane, and says so
  (`beyondReach`, each scan against that one sphere: `ScanLayerState.clipped`,
  the chip "not all in view" on its row from `store.scansClipped`, which
  the viewport sets with every view it reports, and `reaches beyond the
  view: not all of it is drawn` in a picture's caption).
- The align bar is `ui/AlignBar.tsx`, its three bodies `ui/align/`
  (`FloorBody`, `PairsBody`, `NudgeBody`, and `format.ts` for what they
  share); the field one number is typed in is `ui/Field.tsx`, the Region
  bar's too, and what was typed is read by `ui/typed.ts`.
- Refs and numbers in a sentence are set in the monospace face by
  `ui/numbered.tsx`, a ref whole. `.torno/views/` ignores itself for git.
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
  worker forked afterwards would deadlock. It reads two files of `/proc`
  before a build (`meminfo` again after each worker it lets go) and nothing
  else of the system.
- **Workers never fork.** One worker is forked per build. For each object
  folder, the last one that succeeded stays alive to answer queries about that
  object, and is replaced when the next build of that folder succeeds. At most
  four stay alive: a fifth folder retires the one least recently built or
  queried, whose queries are then `no_build`. Fewer stay when memory is
  short: before a build is forked the supervisor reads `MemAvailable`
  (`/proc/meminfo`) and the `VmRSS` of the folder's live worker
  (`/proc/<pid>/status`), takes the build to need that (`ROOM_LEAST`, 2 GiB,
  at least) and `ROOM_SPARE` (2 GiB) more, and while less is available
  retires the live workers of other folders, least recently used first, then
  the folder's own (`Supervisor._make_room`). `build.started` carries
  `retired`, the folders let go; a query of one is `no_build` with `reason:
  "memory"` until a build of it succeeds. When `/proc` cannot be read nothing
  is retired; nor with `TORNO_KEEP_BUILDS=1`, which torno's own test suites
  set (`kernel/tests/conftest.py`, `app/vitest.config.ts`,
  `app/playwright.config.ts`) and nothing in use ever does. A worker keeps what `nearest`
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
  part, with one exception that is display only: explode (below).
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

## Never run the real `claude` CLI from tests

Tests set `TORNO_AGENT_CMD` to the stand-in, `node app/test/fake-agent.mjs`,
which prints its arguments and posts hooks on request. The real CLI spends the
person's subscription, depends on their login and settings, and asks questions
in folders it has not seen. Checking torno against the real CLI is done by
hand, once per change that needs it.

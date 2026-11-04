# torno: the window (`app/src/renderer`)

The UI (`ui/`), the three.js viewport (`viewport/`), the tools that point at it (`tools/`), the store
(`state/`) and the stylesheets (`styles/`: `tokens.css`, and `app.css`, which is nothing but the list of
the stylesheets by area in the order of the cascade; `styles.test.ts` holds it to that).

What binds every part of torno is in the `CLAUDE.md` at the root of the repository: read that first. Here
is the detail of this folder, under the headings it has there. Paths are from `app/`.

## Marks

- User marks are drawn in `--user-mark`, agent marks in `--agent-mark`, and
  nothing else in the UI uses those colours. A picture for the agent draws
  every mark alike: no active mark, no selection, no hover, no gizmo. A mark
  on a part that is not drawn is not drawn either, on screen or in a picture.
- Tools and keys: every key torno listens to is a row of `shared/keys.ts`
  (`KEYS`: its keys, what it does, the group the sheet lists it in, and the
  scope it is listened to in). A handler asks `pressed(e, id)` or
  `which(e, id)` and never names a key; a button or a tooltip takes its key
  from `hint(id)`; the palette's tools, the view bar's views and the gizmo's
  ways are `TOOL_KEYS`, `VIEW_KEYS` and `GIZMO_KEYS`; the sheet of keys (`?`,
  `ui/KeySheet.tsx`) is `cheatSheet()`. A tool's key is shown on its
  palette button and in its tooltip, and on the sheet of keys; nowhere else. The empty Marks section names no key: it
  says what a mark is and that it goes with the next prompt. A new key is added there first:
  `keys.test.ts` reads the sources of the window, the preload and
  `main/devkeys.ts` and fails for any read of `.key`, `.code`, `.keyCode` or
  `.which` outside `shared/keys.ts` (a handler hands the press whole to
  `pressed` or `which`; main through `pressOf`), for a key of the keyboard
  named in a source, for a key or a chord written out in a text, for two rows
  of one scope with the same key, for a key of the shape in hand that the
  viewport has too (`keyClashes`), and for a key heard while typing (scope
  `global`) that a field or the terminal would take (`typed`). The scan is by
  source text: what else in the window is called a key (a part's, a light's,
  a row's) is read through a receiver listed in the test (`NOT_A_PRESS`; a one-letter name only in the
  files `SHORT_NAMES` lists), a key taken apart (`({ key }) =>`, `const { key } = e`) is a read too, and
  its fixtures hold every spelling of a bypass it is to catch.
  `Ctrl+Shift+B` is "Rebuild" (`rebuild`, heard everywhere; while a build runs the button reads
  "Building…" and neither it nor the key nor `Builds.rebuild` starts one over; the button is in
  the status line, `ui/BuildStatus.tsx`); main's sentences name it by
  `REBUILD_HOW` in `shared/build.ts`. The button is the primary one (`data-primary`) only when `rebuildHelps`
  says building again may help: a failure outside the model (`crash`, `timeout`, `cancelled`) or a build let go
  for memory with nothing failed since; after an error in the model the same sources give the same error and it
  stays quiet. The build error sheet (`ui/BuildErrorSheet.tsx`) says what failed in words (`kindWords`, with
  the build as the chat's line names it: `Build after r2 failed`, `First build failed`, never the kernel's word
  alone) and who is told (`toldLine`: after the session's edit, found by the chat's build line that is still the
  latest, or with the next prompt, or no session). Its one primary button is "Ask Claude Code to fix it"
  (`fixPrompt`), which opens the dock, puts the text in the box of the chat (`insertIntoComposer`) or at the
  prompt of a terminal (`session.insert`, a paste, never Enter) and never sends; with no session it reads "Start a
  session to fix it" and asks the session pane to start one (`fixRequest` in the store), which leaves the text in
  the new chat's box (`holdDraft`) or types it at a terminal's prompt once its status is idle. After a failure
  outside the model "Rebuild" is the sheet's primary button and the ask is quiet; Copy is always quiet. The
  Composer's "Goes with your next prompt:" has a "build failed" chip while the build has failed. A tool in hand is offered a key before the viewport is, so the
  Region tool's `E` stays its own and explode's is the viewport's. Shift with
  a key is that key unless Shift with it has a row of its own in that scope.
  A slider is no field to type in (`ui/typing.ts`): the keys work with one in
  focus. After a click or an action the next letter is the view's (`e2e/focus.spec.ts` walks a session of
  work pressing `P` after each step): a field, a list being chosen in with the keys, and the session pane keep
  the keys (`TYPING`); what the pointer took up gives them back once done with: a choice made in a list
  (`pointerChoice`, `chosen`), the session pane's edge once dragged, as Enter and Escape do in a field
  (`giveKeysBack`). The exported page's own keys (`src/export/viewer`) are not in the
  table: it is another program. The palette's tools are `TOOL_KEYS` in the order of their groups (`group`:
  `inspect` Select, Measure, Section; `mark` Pin, Arrow, Draw, Shape, Region; `scan` Align), drawn as one
  `role="group"` each (`TOOL_GROUPS` in `state/tools.ts`, its `aria-label` the group's name) with a
  `toolbox-rule` between them; the sheet of keys and the manual's table follow that order. The Measure tool is
  `tools/measureTool.ts`; what its clicks measure is chosen in the strip `MeasureChoice` of
  `ui/ToolPalette.tsx`, and a dimension's expectation is typed in
  `ui/DimensionFields.tsx`. **A measurement is no mark**: the tool asks main (`ctx.measure`, `geometry.measure`)
  and nothing is committed; the kernel's value replaces the `≈` estimate at the pointer, and the last
  measurement is held in `state/measured.ts` (`Held`: its ends, kind, layout, build, camera, value and `how`),
  which changes once per measurement. The strip shows it (`Last: …`, only for the object and build on show)
  until the next first end, Escape with nothing under way or the tool put down. It is kept as a dimension only
  by `measure.keep` (Enter) or the strip's "Keep as a dimension", both `keepHeld`, which commits the same
  anchors through `commitMark` (main measures it again); the strip then says `Kept as M7`. A readout is not a
  mark and is never drawn in a mark's colour. In Angle, before the second click, an end the kernel takes by its axis, only if
  flat or straight, or never (`angleTaking`, by the descriptor's type, the kernel's rule) is said at the pointer
  in place of the `≈` estimate; it is a hint, never a gate: the click is sent whatever it says. A tool is a `Tool`
  (`src/renderer/tools/Tool.ts`) and gets every pointer event the chips of the marks do not take from the one
  subscription in `ui/ViewportPane.tsx`. Nothing of a pointer move goes
  through React or the store.
- **Learning the tools and the pointer without the manual** (`ui/ToolPalette.tsx`, `ui/ToolHint.tsx`,
  `state/step.ts`, `shared/pointer.ts`). The palette has no `title`: each button has torno's own tip beside it (`ToolTip`,
  at once on the pointer and on the keys' focus, `:focus-visible` only; any key puts it away; it takes no pointer
  and is `aria-hidden`, the button holding the same words as its `aria-description`): the name, the key cap from
  `hint`, what the tool does (`doesOf`, the `does` of `TOOL_KEYS` without its name) and, below, what else is worth
  knowing now (`noteOf`: a scan's tool with no scan says `Import a scan first`, a painting that waits on a scan, the
  shape the Shape tool places). A scan's tool (`SCAN_TOOLS`: Region, Align) with no scan in the object, once main has
  said so (`scansKnown`), is drawn quieter (`data-quiet`, the icon in `--muted`) and stays enabled: its click and its tip
  say why. The key letters are 11 px. The Keys button has the same tip.
  With a tool other than Select in hand one line at the foot of the view (`ToolHint`, `aria-live="polite"`, no
  animation, no pointer) says what the tool waits for next: `next` of the tool's row in `TOOL_KEYS`, with
  Measure's `then` once the first end is clicked (`stepStore.stage`, set by `measureTool` through `setFirst`, once
  per click, never per move), Pin's `click the part where M3 should be` while a mark is being put elsewhere, and
  `import a scan first` for a scan's tool with no scan (`stepFor`, `hintLine`). The line names no key of a tool: only
  `Esc` (`hint('escape')`), which steps back. The first time an object is drawn in this install the same line, with no
  tool in hand, says how the pointer moves the view (`pointerLine()`, and `?` from `hint('keys')`); a tool's step takes
  its place while it is in hand, and the hint goes at the first move of the camera the person makes with the pointer
  (a drag or the wheel: `Viewport.onNavigated`, not a view key, Fit or a click that moves nothing), remembered in
  the window's `localStorage` under `torno.pointerHint` (`pointerHintDue`, `rememberPointerHint`: a storage that is
  not there or refuses shows it again; never in a workspace). The line stands on `--bar-floor` and, while it is
  there (`:has(.tool-hint)`), lifts every bar at the foot of the view by a row (`--hint-lift`, 40 px) so that none meets it
  (`styles/layout.css`, held by `viewport/overlay.test.ts`). The sheet of keys starts with a group "Pointer"
  (`POINTER` in `shared/pointer.ts`: drag, right drag, scroll, double click with Measure; "In the view": with Arrow or
  Draw in hand a drag that starts on the part draws instead; the others' own press is in their step lines): gestures, no row of `KEYS`, searched with them and counted
  after them (the count line gives the keys, then `, N of the pointer`); the manual's table of them is held to it (`readme.test.ts`).
- A mark's row and its chip in the view point at each other. The pointer on a row or chip, or the keys' focus in a
  row (on one of its buttons, `:focus-visible` only: a click on a button focuses it too, and is the pointer's; a
  note being typed is not), is the store's
  `hoveredMark` (`hoverMark`/`unhoverMark` of `ui/markHover.ts`, called as they go on and off, never per move; the
  pointer's mark first, else the focus's, and each lets go only of its own): the row has its hover background
  (`data-hovered`), the chip a fainter ring than the active one's (`drawLabels`'s `hovered`), and the faces the
  mark is on are lit by `peek`, as a ref chip of the chat lights them: no agent line, no locked tools.
  A click on a row is `actions.selectMark` (the mark active, its layout shown): the camera moves to the view it was
  placed from only when its label is not in view (`markReveal`, `Viewport.revealMark`, `needsCamera`). "Go to its
  view", the reticle of the row, and a mark's chip in the chat are `actions.focusMark`, which always goes there.
- **The chips in the view answer the pointer before the tool in hand** (`tools/markChips.ts`, first in the one
  pointer subscription of `ViewportPane`; an event it takes, no tool is told of). Hit-testing is of the chips as the
  last frame placed and drew them (`OverlayPass.markAt`, `chipAt` of `viewport/marks/labels.ts`), never worked out
  again per move. On a chip the cursor is `pointer`, the mark is `hoverMark`ed as from its row, and the readout says
  `chipSays` (a note in the face of the UI, `Readout.note`, one line cut to its width; a dimension's numbers as a
  ref's). A click opens it whatever tool is in hand (the head ruling of #74): `goToRow` (active, row in view, the
  camera stays as it is in view) and, for a draft of the person's, `actions.openNote`. A drag that starts on a chip
  is the orbit's; a press that began beside one is the tool's to the end. A failing dimension's chip says by how
  much it misses after its cross, in `--fail` (`40 mm ✗ 2 under`: `labelValue`'s `off`, from `offBy`), on screen
  and in a picture for the agent alike. A spec that hands a tool a press at a point checks first that no chip is
  drawn there (`__tornoTest.chipAt`, `clearOfChips` in `e2e/tools.spec.ts` and `e2e/measure.spec.ts`).
- The Marks list is grouped by what is to be done (`ui/markGroups.ts`): "To send" (drafts), "With the agent"
  (sent), "To review" and the fold "Resolved"; a heading only for a group that has marks, and the heading says
  the status, so a row has no status word but a pinned dimension's `pinned`, which is never cut. "To review" is
  one summary (`ui/ResolvedSummary.tsx`): "The agent resolved N marks.", "Review" opening each row with its
  resolution, OK and Reopen, and "OK all" (`marks.acknowledge`, no key).
- A mark's row is one line, its note cut to the room there is, and the active row (`aria-current`) shows its
  note whole, wrapped on a line of its own (`late.css`). Its chip is the id alone (`rowLabel`): `~` and `?` are
  the view's chips' and the pictures' (`labelText`). What the last build did to its mark (`moved:
  check it`, `its part is gone`) is a line of its own under the note (`.mark-anchor`, `late.css`). The Marks list never scrolls sideways (`e2e/reanchor.spec.ts`, with a note longer
  than the column). A dimension opened out leaves its value and verdict to its fields under the first line, so
  that `Add a note` is whole beside the buttons of the row (`marks.css`, `e2e/measure.spec.ts`).

## Layers

- `ui/Layers.tsx`: the groups of the layout (`groupsIn`) come first, a header each (`li.layer-group`,
  `data-group`): a fold chevron (`aria-expanded`, `Fold flat` / `Unfold flat`), the name and the count in the
  monospace face, "Show only" (on hover, as the opacity slider; `actions.soloLayers`) and an eye whose
  `aria-pressed` is `true`, `false` or `mixed` (`groupVisibility`; `actions.setLayers` over the group, one edit).
  Its parts follow, indented, with `data-in-group`; a folded group draws none (`actions.setFolded`, kept in the
  scene file as `folded`, and dropped for a group the model no longer has). The parts in no group come last. A
  model without groups draws the list as it always was (`e2e/groups.spec.ts`).
- A part whose build says its shape is broken (`partDefects` of `shared/sanity.ts`: not valid, inside out, not
  closed, mesh disagrees) has its first defect in a word after its name (`.layer-defect`, `--fail`, `+N` for the
  others) and every one in the row's title; the status line counts the layout's broken parts after its parts
  (`.status-defects`, `defectsSaid` in its title). Of the build on show alone: whether a defect is new is for the
  agent's digest (`main/sanity.ts`) to say.

## Parameters

- `ui/ParamsPanel.tsx`: the fields of the model's `Params` as the kernel read them at the last build (`Scene.params`,
  as main sends the scene, unchanged), read only; torno never writes the model. A model with none (or a kernel that does
  not read them) has no section. A row (`paramRow` in `ui/paramRows.ts`, pure) is the name and the default in the
  monospace face (`shared/format.ts`, four digits at most, a list or a dict by its items, a bool as Python writes it;
  the whole value in the value's `title` where it differs, with the type as written in the row's), the comment (`doc`)
  as written, its numbers in the monospace face (`numbered`), cut to two lines (whole in the row's title), and, for a default that is not a literal, "worked out in the
  model" (its value too when the kernel has one). No unit is taken from a comment.
- A click on a row puts `Params.<name>` at the cursor of the open object's session by `insertIntoSession`
  (`ui/insertIntoSession.ts`, also the selection's "Insert" and the build error sheet's ask: the box of the chat,
  `insertIntoComposer`, else a paste at the terminal's prompt, never sent; it says whether it went in), and shows the
  dock first (`later`: a box in a hidden dock takes no focus), as the selection's "Insert" does; the box puts its cursor
  after the text once it is given the keys (`unfocused` in `Composer`: a hidden box loses the one it was given). `Params.x` names no geometry, so it is plain text in the
  prompt: `refsIn` and `RefChip` do not see it. A row's accessible name stays `Params.<name>`; its `aria-description` holds
  the row's title (type, value whole, comment) and then what a click does. With no session running a row is text, not a
  button, and the description says to start one (`e2e/params.spec.ts`, which writes its own `Params` into its copy of a
  fixture).

## Section

- Drawing is `viewport/section.ts`: the parts' materials are clipped, and each
  closed solid (`BuiltPart.solid`) gets its cut face by stencil counting, per
  part, with an outline from the mesh. A part that is no closed solid is cut
  open. What lies in the plane is kept (`KEPT_WITHIN_MM`); a part the plane
  only touches or leaves nothing of is not drawn (`keepsNothing`). Marks,
  grid and gizmo are not cut; a mark anchored in the half taken away is drawn
  dimmed (`MarkLayer.setSection`).
- Picking sees what is drawn (`pickUnder`): on a cut face nothing is hit and
  the pointer says so.
- Taken in hand with nothing cut (`X`), the Section tool cuts at once: `newCut` (`shared/cut.ts`) puts the
  plane through the middle of the parts (to 0.01 mm), across the axis the camera looks most along, open
  towards the viewer (`towardsViewer`: the half taken away is the one on the camera's side). The bar's X, Y
  and Z and an exported page's cut ask the same rule. What that rounding leaves is no distance: the bar tells a
  plane within 0.005 mm of the middle of the parts as at it, `0` (`sectionOffset`).
- A number field gives the keys back to the view on Enter and on Escape (`giveKeysBack` in `ui/typing.ts`),
  and keeps what was typed once (`toKeep` in `ui/Field.tsx`).
- The Section tool (`tools/sectionTool.ts`) moves the plane only by a drag
  that starts on its handle; any other drag turns the camera. The bar is
  `ui/SectionBar.tsx`. The plane moves in the viewport during a drag and is
  kept in the store once, on release, to the millionth of a millimetre. The
  bar's number and slider follow the plane as it is drawn, through
  `Viewport.onSectionMoved`, never through React. The cursor over the handle
  is the resize cursor nearest to the way its arrow points on screen
  (`handleCursor`), and `ns-resize` where the view looks along the normal and
  the drag goes by the pointer's height.

## Explode

- `E` on a layout of one part opens no bar: the button says why for a moment. The parts of a group of the model
  move as one body (`Part.group`, `explodeOffsets` in `shared/explode.ts`; `e2e/groups.spec.ts`).
  One rule for the camera when the parts are drawn apart, by whatever path (`E`, an axis or scale button, the
  slider let go, a layout, the agent's `show`, a saved view applied), in the window and in an exported page:
  the camera stays, and is framed anew only when a part would leave the view (`leavesView` in
  `shared/explode.ts`; `Viewport.keepApartInView`, asked by `ViewBar` once the explode bar is laid out, and by
  `ViewsStrip` after a view's camera); together again, it goes back to where it was before that, if nobody
  moved it meanwhile (`cameraBack`; a view key, Fit, Ortho or Frame make the camera the person's). In the
  window the view is what the bars over its top leave (`Viewport.setCoveredTop`, measured by `ViewBar`): a
  view key, Fit, a scan's Frame and that rule frame the parts below them (`fitBelow` in `viewport/views.ts`);
  a picture for the agent has no bars. Fit, Ortho and Frame act on where the camera is going when it is on its
  way (`cameraGoal`): a view key and then `F` at once is that view, fitted. While the parts are apart no shape
  is in hand (`connectShapeEdit`).
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

## Views

- **The person** saves what is on screen (`actions.saveView`, also where the
  agent's `show` has it otherwise: they save what they see), over any view
  of that name ("Replace"), which is theirs from then on; renames, updates
  to what is on screen and deletes (asked twice) from the chip's menu.
  `actions.applyView` is one edit of theirs: the layout first, every part of
  it on but those hidden, the section or none, the layout's explode or
  together, each scan still there as the view has it; `shownByAgent` is
  cleared, and what the view does not set is as the person had it
  (`sceneFileOf`). The caller then moves the camera
  (`viewport.setView(view.camera, true)`).
- **A focus** (`FocusBox`, `focusCamera` in `viewport/views.ts`): a picture for the agent, or `show`, is framed on
  a box and its margin by `fitCamera`, looking the way a standard view does (orthographic, as a picture of one is),
  or the way the camera on screen or the agent's own camera looks, with its projection kept. A picture says
  `framed on the focus` and which parts stand between the camera and the middle of the box (`hiddenBehind` in
  `viewport/focus.ts`: a line cast at the meshes of the parts drawn, both faces, what a cut takes away left out,
  the box's own surface not in the way). Parts are drawn together unless the picture says otherwise; `show`
  refuses a focus while the screen is exploded. All of it is synchronous once started, like the rest of a picture.
- **The frame in the view** (`drawFrameCues` in `viewport/overlay.ts`, drawn by `OverlayPass` with every frame on the
  canvas the labels are on, never through React): the axis triad bottom left, its arms about 32 px (`SCREEN_UNIT`)
  in `--axis-x`, `-y`, `-z`, and bottom right the scale bar in an orthographic view or, in perspective, where no one
  scale holds, the grid's step as `grid 5 mm` (`groundOf`'s `step`; the grid lies on the ground in the object frame, so
  its step is a true length in any projection). It is of the camera and the object frame only, so it stays while the
  parts are apart. A picture for the agent has the same triad and bar, and in perspective its note `perspective, no
  scale bar`, as before. The scale bar is 100 px at most on screen. The strip of the Measure tool stands above the
  triad, and the bars at the bottom of the view (the section's, the selection's, the Align and Region tools', the
  agent's line) keep `BAR_SIDE` in from each side, clear of the triad and of the scale; where the view is narrower than
  the widest of them needs (`NARROW_BELOW`, `data-narrow` on `.viewport-pane`, set by `ViewportPane` as the view is
  resized) they stand above the triad (`--bar-lift`) instead, and above the strip of the Measure tool while it is in hand (the strip is also above the triad, at the left, and the two never meet),
  the bars that stack there (the selection's, the section's, the agent's line, the step line, the Region tool's) 60 px in
  from each side (`--stack-side` of `[data-narrow]`), clear of the palette of tools, which a short view's stacked bars
  would reach; the Align tool's bar, which stands alone and whose rows need the width, keeps `--space-3`. In a wide view the bottom row stands below the strip, beside the triad, and a bar raised a row up (the
  section's over the selection or the agent's line, the agent's line over the selection) stands at `--strip-top` at the
  least while the strip is there, above it. `TRIAD_CLEAR`, `BAR_SIDE` and `NARROW_BELOW` are in
  `viewport/overlay.ts`, and `--triad-clear`, `--bar-side` in `styles/layout.css` are held to them by `overlay.test.ts`;
  `e2e/section.spec.ts` reads the bar's box against the corners, the palette and the strip, and the strip's against the
  selection's, at seven sizes, with a selection and without.
- **The strip** (`ui/ViewsStrip.tsx`, the last child of `.viewbars`,
  `role="toolbar"`): a chip per view (`button.view-chip[data-view]`), the
  one that is on marked (`aria-pressed`: `activeView`, while the screen
  still shows what it holds, `viewMatches`, and until the camera rests
  somewhere else, `actions.cameraSettled`), and "+ Save view" with one field.
  Six chips at most (`stripChips`: the one that is on, then the proposals,
  then the others as saved, shown in saved order), each name cut at 160 px
  and whole in the tooltip; with more views a chip `18 more` opens the list
  of all of them, a row each with what it holds. The strip is two rows at
  most at the default pane (`views.spec.ts` holds it to that with 26). Its
  menus take the focus, the arrows, Home and End; Escape and every action
  give the focus back to the chip, and never reach the pane's own Escape.
  A proposal is drawn dashed with the word `proposed`, "Keep" and
  "Discard": in no mark's colour, as a view is not a mark. The digits are
  not bound to the saved views: `1` to `4` are the standard views.

## The first screen

- With no folder open the window is `ui/Welcome.tsx`. On a first run (no recent folder): a line of what torno is,
  a three-row tree of the folder of objects, an object and its model, "Open folder" with a note that an empty
  folder is fine, and, where torno runs from its repository, a quiet "Open the example". Coming back: the recent
  folders first, no tree. One footer: torno writes only into `.torno`. Its head is the logo (`ui/Logo.tsx`) over the name: the vise in `--ink`, the part in `--accent`. The
  same logo is in `--muted` over an empty view or page, and plain (one colour) where a picture is missing.
- With a folder open, the folder button of the left column is a menu
  (`ui/FolderMenu.tsx`): the recent folders, "Open folder…", "Open the
  example". A folder torno is started with (`TORNO_WORKSPACE`) is added to the
  recent ones; the workspace to open next stays the one chosen in the window. The open folder's row is marked
  with a check and the word "current" in the muted face. A folder that cannot be opened (one gone since the menu
  was read, one main refuses) leaves the workspace as it is and is said under the folder's name, a `role="alert"`
  line with `openProblem`'s text, until the next action (`goTo` in `App.tsx` returns the problem).
- **The window's own questions are dialogs over the whole window, not strips of a panel.** Closing torno and
  opening another folder while something would be cut short ask in `ui/WorkspaceQuestion.tsx`, a centred
  `alertdialog` (modal: nothing behind it takes a click or a key, Tab goes round within it, "Keep it open" /
  "Stay here" in focus, Escape presses it, even with the focus elsewhere). Its keys are heard before any other
  listener's (`keyGate`, added to the window when the module is read, before the window's own keys and the view's):
  while it stands no key reaches anything behind it, wherever the focus is, and a press on its backdrop leaves the
  focus in it. It stands over the sheet of what torno needs, which shares its layer (`data-question`). It lists a line for each thing with the
  object it is of, as a link that goes to that object (or to the page of a new one) and puts the question away
  (`closingWhy`, `leavingWhy` in `closing.ts` return those items). `ui/Confirm.tsx` stays the strip for a question
  about one panel (a scan, a mark, the session).
- **What torno needs** is one block, "Ready to work" (`ui/Readiness.tsx`; its words are `ui/readyLines.ts`, pure and held by
  `readyLines.test.ts`; its state is `store.ready`, asked of main once and told on each change, `useReadyFeed`). A line each
  for Claude Code, uv (only when missing), a folder's own environment (only with a `pyproject.toml`) and the kernel; a dot
  in `--ok`, `--warn` or `--fail` (a wait is `--muted`), the label in the muted face, versions, paths and commands in
  the monospace face, and a note in the muted face under it. When every line is ready it folds to one quiet line ("Claude
  Code and build123d 0.13.0 are ready") that a click opens; a kernel that is only starting, its environment there, does
  not keep it open. Nothing is claimed until main has said. It is under the tagline of the first screen, in the empty
  workspace below "New project" and the example, on the page of a new object above Create in the `missing` form (only the lines that
  say something is amiss, none when none does, and for Claude Code a failure adds that the object will be made but the agent
  cannot start in it), and in the sheet of the folder menu ("Check what torno needs", a dialog over the window asked afresh,
  with "Check again"). "Make it now" is on the kernel's line when torno's own environment is not made, no workspace's kernel is
  starting and uv is there, and "Try again" when it failed. The status line says "Making torno's Python environment, first
  time only" in place of `Building N s` while the kernel is starting over an environment that was not made.
- A workspace with no object leads with making one (`ui/EmptyWorkspace.tsx`, in `ui/ShowPage.tsx`): "Make your first
  project" and a line on what it takes, "New project" (primary), under it "or open the example to look around" (only
  where `hasExample`), the readiness block, a line on scope (printed parts and small assemblies), and a fold,
  "Already have build123d models?", closed, which holds the folder rule (`part/part.py`) and, for a folder without a
  `pyproject.toml`, that its models are built with torno's own build123d. torno runs no `uv` command there: the note
  names them for the person to run. The session pane in that state says that Claude Code works there, one session per object.

## Light and dark

- The tokens (`app/src/renderer/styles/tokens.css`) are held to their
  contrasts by `shared/contrast.test.ts`, which reads the file: whatever is
  read as text is 4.5:1 on the ground it stands on (`--ink` 7:1; `--muted`,
  `--accent`, `--ok`, `--warn`, `--fail` on `--surface` and `--panel`; the
  accent on its wash; the sixteen terminal colours on the panel, but the dark
  theme's black); what is only drawn is 3:1 (the two mark colours on the
  surface); a hairline is between 1.15 and 2. A token is changed there first.
- A verdict (`--ok`, `--fail`) is no mark's colour to the eye, in both
  themes: 1.5:1 at least from the mark colour of its hue (`--agent-mark`,
  `--user-mark`), darker in light and lighter in dark. A verdict is read, a
  mark is drawn. Muted words and the verdicts are 4.5:1 on `--accent-wash`
  too. The dark `--warn` is an ochre, not an amber.
- An edit drawn as a diff has its own two washes, no red and no green (`--diff-removed-wash`, a grey between the panel and
  the hairline; `--diff-added-wash`, the value of `--accent-wash`): `--ink` 7:1 and `--muted` 4.5:1 on both, the blue 60° of hue
  at least from both marks and both verdicts (`contrast.test.ts`).
- A mark's lines (a pin's leader, an arrow's shaft, a stroke, a dimension's
  lines, a shape's outline) are drawn over a casing in `--panel`, 2 px wider
  (`MarkColours.casing`, `Parts.cased` in `viewport/marks/markObjects.ts`; in
  an exported page `.mark-casing` under `.mark-line`, as SVG over the
  canvas). The line is 3:1 on its casing; the casing is 3:1 on every part
  colour in dark and 2:1 in light, where no panel-coloured casing can do more
  against pastel parts.
- The person's ink on a picture of the view is `--drawing-ink`, magenta in both themes: 3:1 on its casing and on the
  ground, 30° of hue at least from either mark colour, and no axis's, the accent's or `--deviation-near`
  (`contrast.test.ts`). `ui/drawing/make.ts` writes the light values out for where the stylesheet cannot be read.
- What the system draws follows the theme: `color-scheme` is one scheme at a time, said outright in
  `tokens.css` (never `light dark`, which left the native light scrollbars in the dark theme), and every
  scroller of the window has the thin bar in `--scroll-thumb` (`late.css`). `e2e/themes.spec.ts` holds both.
- No text is dimmed by `opacity`, and nothing animates without end
  (`styles/styles.test.ts` reads the stylesheets): the dot of a session at
  work is still, and a build's beats with the count of its seconds
  (`data-beat`, set by `BuildStatus` once a second). The axes (`--axis-x`, `-y`, `-z`) are the gizmo's and the triad's, in the view and in a
  picture, and are neither mark colour.
- The light values are written out where no stylesheet is read
  (`viewport/theme.ts` `LIGHT_THEME`, `viewport/sectionDrawing.ts` `SHEET`,
  `viewport/overlay.ts` `AXIS_COLOURS`, `SURFACE` in `src/main/index.ts`,
  `src/export/page.css`): the same test, and `export/page.test.ts`, hold them
  to the tokens.

## The page of objects

- `ui/ShowPage.tsx`, over the 3D view (`store.page`: `'object' | 'objects'`; the view stays mounted under it,
  `inert` and not painted, and the open object keeps its selection, camera and note). A workspace of several
  objects, or of none, starts on it; one object alone is shown itself. `W` outside a field or "All projects"
  brings it up (not while a button of the pointer is held: a drag in the view is not over); a card, or Escape,
  leaves it, and what had the focus has it again. "All projects" is the first row of the list while no object is
  open, and beside the list's title while one is (`ofObject` in `ui/ObjectList.tsx`), the page up or not: the one
  control, so the focus it had comes back to it.
- **The left column gives the room to the marks** (`styles/panels.css`, `state/column.ts`). Objects, Layers,
  Parameters and Scans each have a title that folds them (`ui/SectionTitle.tsx`, `aria-expanded`; folded with the pointer, the
  keys go back to the view); folded, a section is its title row, which says what matters (`ui/sectionSaid.ts`, and `ParamsPanel`'s own count:
  `Layers 12 · 3 hidden`, `Parameters 5`, `Scans 1 · unaligned`, `Projects 17`), and Scans keeps only what is said of an import
  and the question it asks. Parameters, under the layers, starts folded. Marks never folds: it keeps `--marks-floor` (`MARKS_FLOOR`: its title, a group's
  heading and five rows), and every section above gives way before it, each down to its title. The splitter
  above Marks (`ui/ColumnSplit.tsx`, `role="separator"`, `column.resize` Up/Down) gives Marks more: its drag writes
  `--marks-h` on the column, nothing through React per move; a double click puts back the shares. The room is read
  from the column as it is laid out (`tallest`: the column less everything else in it, each section that gives way at
  its least), at the drag and whenever the column or a section in it is resized, comes or goes (a `ResizeObserver` and
  a `MutationObserver`): `--marks-h` is the height kept cut to that room, so a shorter window or Parameters coming
  above never push Marks under the status line, `aria-valuenow` is that height, and what is kept is not touched. What is
  folded and the splitter's height are the window's (`store.column`, in `localStorage` under `torno.column`, read
  and written in try/catch), never the workspace's.
- **Objects folds to a switcher by default** (`switcherShown`): folded, with an object open or a new one being
  made, in a workspace of more than one object, the list is one row, the open object's name in ink
  (`ObjectSwitcher`; "New project", pressed, on the page of a new object). Its accessible name is the object's
  name, as a row's is; what the sessions do is its `aria-description`. A click or Enter opens a menu
  (`role="menu"`, the keys of `FolderMenu`: `menu.next`, `menu.previous`, `menu.ends`, `menu.close`) of every
  object as the rows (the item's name is the object's; a muted one has its reason as a second line), then "New
  object". Chosen with the keys, the focus goes back to the switcher; with the pointer, the keys to the view.
  Unfolded, the list is as it always was and gives way first (a share of the column at most); with no object
  open, or the page up, it is whole and has the room of the layers, the parameters and the scans, every object in sight
  (`e2e/show.spec.ts`).
- **The keys on the page** are one capture-phase listener. Left alone: what is typed in a field or the
  terminal (`TYPING`), any `input` outside the page (a slider of the left column keeps its arrows), and
  whatever is inside a `[role="dialog"]` or `[role="alertdialog"]`. Everything else is the page's and goes no
  further, so no tool under it is handed a key: arrows from card to card (`ui/cards.ts` `stepCard`), Enter
  opens, `/` or a letter filters by name. **Escape goes to what is on top**: a sheet or a confirm that is
  there to be seen (not one of the view put away under the page) gets it first, as if pressed there; then the
  filter is emptied; then the page goes. A sheet opened over the page (the export's) needs one of those two
  roles and nothing more.
- **No build is ever started for a picture.** A thumbnail is made by the window when a build of an object
  opened in this run lands (`state/thumbs.ts` `connectThumbs`): one at a time, in an idle callback, the latest
  build of each object only, one sent again as it was passed over. It subscribes to nothing: the viewport's
  one handler of `object.onScene` (`ViewportPane.tsx`) hands it each message (`landed`), so a build's meshes
  cross the bridge once, and are held only until the picture is drawn. An object not built in this run keeps
  the picture it has on file, or has none and says `No picture yet`.
- **A card says how far its picture can be trusted** (`ui/cards.ts`): when it was made (with the year when
  that is not this one); what it draws otherwise than the object is (`cut by its section`, `parts drawn
  apart`, `1 part left out`); and `A source has changed since` (`thumbOf`: `behind`). The sources of an object
  are what a change in has it built again (`Builds.open`): the `.py` files directly in its folder and in
  `<workspace>/common` (`sourceFolders`, `newestPython`; the kernel does not say which files a model read, so
  there is nothing finer). `sourcesMtimeMs` is the newest of them when the picture was kept, and no later
  than when that build was started, so a source saved during the build is newer than its picture; a card is
  behind when the newest now is newer, when either cannot be said, or when the model is another file. When
  the last build failed the status says so in `--fail`, the picture is dimmed and is said to be `of the last
  build that worked`. A picture is asked of main only once its card is in view or near it
  (IntersectionObserver).

## A new object

- `ui/onboard/NewObject.tsx` is a page in place of the viewport (`store.page`: `'new'`; the view is `covered` and
  inert under it as under the page of objects, and the layers, parameters, scans and marks are hidden). No row of the list is
  current (the "New project" button is pressed; folded, the switcher reads "New project", pressed), and the status line is "New project" and the build123d version alone:
  no Rebuild, revision, parts or Export. The session pane shows `ui/onboard/DraftPane.tsx` (from `draftSummary`):
  what Claude Code will start with, live; unless the open object's session is live, which stays whole (see Agents).
  All of it reads `store.page`, and nothing under the page changes, so leaving it brings everything back as it was.
  The page is opened from "New project" at the foot of the list, in the head of the page of objects and in its empty
  state (`openNewObject`). It takes the focus (the name field) when it comes and gives it back to where it was when it goes. Leaving the workspace
  (opening another folder) asks when the draft has something: "A new project is set up here and not made yet".
- **The draft** (`state/onboard.ts`) lives in the window, for the workspace it was begun in, until the object is made
  or the person throws it away; nothing of it is on disk, and it is dropped when the workspace root changes. Caps
  are `MOST_REFERENCES` (shared with main), a photo or scan is refused as a duplicate by path and an object by id.
  A doodle keeps its strokes as vectors as well as its PNG, so that it is opened again to change. `epoch()` goes up
  at each discard: photos being read when the draft was thrown away are not put back. The held first prompt
  (`hold/take/dismiss`) is in the same store.
- **Keys** are rows of `shared/keys.ts`: `new.back` (Esc) in the scope `newobject`, and the board's `board.undo` (Ctrl+Z) in the scope `sheet`. The
  page listens in the capture phase and takes every key not meant for a field, so no tool of the view is handed
  one. In a field Esc leaves the field (the keys go back to the page) when the draft has something, and the page
  when it has not; elsewhere it leaves the page, asking first ("Discard this new project?") when there is something in
  it. A sheet or question asked over the page (the sheet of keys, the closing question) keeps its own keys.
  `export` and `rebuild` keys do nothing on this page.
- **Images are scaled in the window** (`images.ts`): the window decodes (WebP too), scales to a long edge of 1280
  px (a PNG stays PNG, anything else becomes JPEG at 0.85; a PNG already within 1280 px and 3.75 MB goes as is, a
  heavier one goes as a JPEG) and
  hands main the bytes. The header is read before anything is decoded (`headerSize`: PNG, JPEG, WebP): over 50
  megapixels is refused with its reason on the card, and a HEIC is refused with how to get a JPEG (`HEIC_REASON`). Main reads a chosen photo through `objects.readPhoto`, which serves only the paths its
  dialog offered; a dropped file is read by the window (`File.arrayBuffer`, at most 25 MB, checked before it is
  read) and its path comes from `objects.pathOf`. The copy in `reference/` is the original; the scaled picture is
  only the prompt's.
- **The board** (`Doodle.tsx`, a wrapper over `ui/board/Board.tsx`, which the chat's "Draw on view" uses too) is a sheet over the page: a canvas of 1200 x 800 board pixels, scaled to fit, pointer
  events and canvas only (no React state per move). A thin and a thick pen and an eraser; Undo takes the last
  stroke, Clear all of them; Done gives back the strokes and the PNG, Cancel and Esc leave, asking "Discard this
  doodle?" when the strokes are other than it was opened with. Its keys (Esc is `sheet.close`, Ctrl+Z `board.undo`)
  are heard in the capture phase before anything else, so that no tool under the board gets them. The PNG is made
  by `strokes.ts` with a white ground and dark ink whatever the theme: what is drawn on screen follows the theme,
  what Claude receives does not (`PNG_GROUND`).
- The name is checked against `objects.taken()` (every entry of the workspace folder, read when the page opens and
  after each create) as well as the objects. While `Creating…` shows, Escape, Cancel and the discard question do
  nothing. A note field is named by its card ("Note for photo desk.png"); numbers in the page's prose are set by
  `numbered`.
- **Create** is `ui/onboard/make.ts` (`makeObject`, tested with fakes, and guarded against a second call while one
  runs). The order is `objects.create`, the list is refreshed, the draft is spent, the object is opened as a click
  opens it, then `objects.onboard` once; the session main started is put into the store. A failure of `create`
  stays on the page with its reason and the draft intact. An error saying the object "was made, but ..." is never
  offered again: the draft is spent and the object opened if the workspace lists it. When `sessionId` is null or
  there is a `problem`, the object is open and `onboarding.hold` keeps the text: the session pane says why
  (`session-held`, with Dismiss) and the first chat's composer starts with the text, not sent. A held prompt that
  was not sent counts among what closing the window asks about (`closingWhy`'s `heldPrompt`), as does the draft.
- **The model and effort** of the new object's session are chosen beside Create (`ui/onboard/SessionChoice.tsx`,
  "Claude Code on"): "Your default model" and "Your default effort" pass nothing. The models are `chat.models()` (the
  last chat's list, or Claude Code's aliases), the CLI's own `default` row left out as the default is; the efforts
  `effortsOf` the model chosen (the `default` row's for the default), and an effort the model does not take is let
  go. The choice is `onboard.choice`, the person's, kept when a draft is spent or thrown away, and goes to
  `makeObject` and on to `objects.onboard` as `choice` (only when something is chosen).
- Styles are `styles/onboard.css`, on the tokens only; the page and the board are in `e2e/themes.spec.ts` as
  `onboard` and `onboard-board` in both themes.

## Scans

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
  the line "Not all in view" in its row's detail from `store.scansClipped`, which
  the viewport sets with every view it reports, and `reaches beyond the
  view: not all of it is drawn` in a picture's caption).
- A scan's row (`ScanRow` in `ui/ScansPanel.tsx`) is one line, as a layer's: id, name (`.row-name`, whole with
  its source in the `title`), a dot while how it was read is a guess, its state in one word, the opacity on
  hover, the eye, and the arrow that opens its detail beneath it (`.scan-detail`; one open at a time, the
  `open` of `ScansPanel`). Everything else is in the detail: how it was read, the state's sentence (with the
  basis, `.scan-basis`), Frame, Align, Rename (main's `scans.rename`), the fields. The word and its sentence
  come from `ui/scanState.ts` (`scanState`): `aligned`, `placed`, `pending`, `check`, `rough`, `unaligned`,
  `missing`. `placed` is an alignment tied to no point of the model (`tiedPoints` 0), which no build checks:
  it never reads as `aligned`. How a scan this window just imported is read, when its unit or up axis was
  assumed, is asked once by `ui/ScanReadSheet.tsx` at the top of the section, shown for `store.scanAsking`
  (set by `importScan`, cleared by Keep, Apply, Later or another object), with the size from `sizeAs`
  (`shared/scans.ts`).
- The align bar is `ui/AlignBar.tsx`, its three bodies `ui/align/`
  (`FloorBody`, `PairsBody`, `NudgeBody`, and `format.ts` for what they
  share); the field one number is typed in is `ui/Field.tsx`, the Region
  bar's too, and what was typed is read by `ui/typed.ts`.
- Refs and numbers in a sentence are set in the monospace face by
  `ui/numbered.tsx`, a ref whole. `.torno/views/` ignores itself for git.
- A scan and a picture coloured by distance use tokens of their own
  (`--scan-plain`, `--deviation-*`); a region is a mark and is tinted in its
  author's mark colour.

## Agents

- The agent's terminal (`ui/SessionPane.tsx`) has its inset in the pane in the terminal's ground: the panel's,
  or the one the agent paints the edges of its screen in, when it paints one. Most of the left column and the
  bottom row decides (`ui/termGround.ts` `edgeGround`, after every write parsed); the terminal's own ground and
  the inset then take it, so that the agent's screen fills the pane (`window.__tornoTerm.ground()`; the
  stand-in's `ground r g b`).
- A session away from its pane is told where the eye is (`ui/sessionSign.ts` the rule, `ui/SessionDot.tsx` the dot,
  still, 6 px, the status line's `.status-dot`). Only `working` and `needs_input` have a sign: `working` is a
  `--muted` dot with no words; `needs_input` is `--warn`, a larger dot on the dock's toggle and the words "needs you"
  on a row, never colour alone: the state is the element's `aria-description` and its `title`, and never part of its
  accessible name, which stays the object's name (a row) or `Show session` / `Hide session` (the toggle), so that a test
  and a person's tools find a row by its name whatever its session does: the row's description is `session needs you`
  (`is working`), the hidden dock's toggle's is `Claude Code needs you`. The status line's button (`.status-needs`,
  in a `role="status"` that is always there) names the first object of the list whose session waits, with "and N
  more"; it opens that object, shows the dock (`dockOpen` and `actions.setDockOpen` are in the store, not in
  `App.tsx`) and `focusAsk` takes the focus to the open card or the terminal once the pane is of that object. The
  toggle's dot is of the open object's session and only while the dock is hidden. The switcher the list folds to
  carries the dot of any object of the list whose session works or waits (`switcherSign`: a waiting one first);
  its words name the object whose session waits (`bracket needs you`), "needs you" alone when it is the open
  object's, and its description says each (`session is working; bracket needs you`); its menu has the rows' dots.
- On the New object page the pane is of the object being made (`drafting` in `SessionPane`): no status, no End,
  New session or Resume, no view switch, no held prompt, and `DraftPane` in the body; `.session-term` stays laid out.
  A live session (any status but `exited`) of the object that was open stays as it is, with the note
  `.session-aside` above it ("This is the session of …"); an ended one counts as none.
- The session header names Claude Code, the one agent there is; under it, "Chat · Terminal" chooses the view.
  When `.torno/agent.json` could not be followed (`note` of `session:current`) the pane says why, with "Use
  Claude Code", which writes the file anew and is disabled while a session runs.

- **The chat pane** (`ui/chat/`, `state/chat.ts`; a Claude Code session whose `view` is chat has no `.xterm`). The
  window draws what main's transcript says: `placed` and `drawn` in `state/chat.ts` reproduce main's order
  (an item keeps its place; a queued prompt is drawn after all the others; sent, it goes to the end), and items
  and metas are merged by `seq` with the history, so none is drawn twice or lost. Each `context` item is drawn
  under its prompt, as chips from its fields (marks, build, selection, and how many instruction files it named), never from its text. One made for a tool's
  card (`forTool`: the build an edit of the model started) is a build line under that card (`BuildLine`), drawn from
  its fields alone: `Built r2 · ok · 1.2 s`, or `Build after r2 failed: <the last line of the traceback>` in `--fail` (a revision names a build that worked, as
  `main/builds.ts` counts them: a failure has no number of its own and is the build after the one on show, `failedAfter`
  of `shared/build.ts`, which the Stop hook says too; the prompt's "torno added" line says it alike), or, of a build
  still running when the edit's answer could wait no longer (main writes that line once and never again), "Still
  building when Claude Code was answered", in the past so that it stays true, "Show
  error" while that failure is still the latest build, the dimensions whose verdict it changed (`digest.dimensions`,
  from `verdictChanges`, never worked out again here) as chips with `now passes` / `now fails`, and the parts it
  changed (`digest.parts[].text`, four at most, the rest counted), then "Show text". The sheet of a failed build is
  `errorOpen` in the store (`actions.setErrorOpen`): the status line, the viewport's "Show error" and the chat open
  it. An `Edit` or a `MultiEdit` is drawn as a diff (`ui/chat/Diff.tsx`, from the tool's own input by `ui/chat/lineDiff.ts`, never
  from the person's files), in the permission card (six lines removed and added, then "Show all") and, in place of the JSON, in the
  opened tool card (twelve): each line has a `−` or a `+` in the gutter, a removed one is struck through (`<del>`), an added one is
  `<ins>`; the washes behind them (`--diff-removed-wash`, a grey step of the hairline on the panel, and `--diff-added-wash`,
  the accent's wash) only group, and are neither mark colours nor verdicts (`contrast.test.ts`). The diff is of `old_string`
  against `new_string` alone, so its context lines and "N unchanged lines" are of the edit and have no place in the file: a
  caption on every diff says "Lines of the edit, not of the file: where it lands is not shown". An edit with `replace_all`
  says "Replaces every match in the file" (`Hunk.everywhere`), a card never understating a change. The cap of 400 lines is
  of what differs once the lines both texts share at their ends are left out; beyond it the text is not compared, and says
  "Too long to compare": every old line of it is shown removed and every new one added, so a large deletion is never out of
  sight. A `Write` keeps the first lines of what it holds, there being no old text to compare with. A tool card reads "denied" (the person refused its ask) or "cancelled" (its ask ended with the turn stopped) in the muted colour; "failed", in the fail colour, only for an error the person did not cause. Nothing is per frame
  in React, and there is no endless animation in it: a working indication is still, toggled once a second by
  `useBeat`, and only while something streams or runs (`styles.test.ts` fails for an endless one). The window holds
  at most `MAX_ITEMS` (2,000) as main does, dropping the oldest, and says once, at the top, "Earlier items are not
  shown"; a session no pane shows takes in no picture data, also from a history that was on its way.
  The chat that ended before the window was loaded is shown from main's transcript (`session:current`'s `ended`).
  Beside the model menu (`chat/ModelMenu.tsx`) the effort menu (`chat/EffortMenu.tsx`, `EFFORT_LABEL`): "Default
  effort" until one is set (`meta.effort`), then the levels the model takes (`effortsOf`; none for a model that takes
  none, and then no menu), `chat.setEffort` for the session only; a refusal takes the choice back and is said beside it.
  What the CLI says of itself comes as notes and as meta: the header's status word gains ", retrying (attempt 3)"
  while `meta.retrying` is set and the session works (the status itself is still the hooks'), and while
  `meta.pluginLoaded` is false a line above the box offers "Restart with the whole prompt" (disabled while the agent
  works), which starts the session again, resumed, with `session.start(…, { skills: false })`. A note with `action:
  'terminal'` (the chat could not use the login) has "Use the terminal" beside it (`ChatOffer` of `chat/offers.ts`,
  given by `ChatPane` to the session's own items only, never to "Earlier in this conversation"; disabled on the view
  switch's condition), `offerTerminal` of `SessionPane`: asked about first while the session is busy, as a view picked
  is; otherwise, and after that question, `applyView('terminal', true)`, which ends a live session, writes the view and
  starts a terminal session resuming the conversation whether the chat was live or had ended, and also when the
  choice already was the terminal. A note's `action` other than `terminal` is dropped when a log is read (`readLog`).
- Refs are chips (`RefChip`, `refs.ts` `refInfo`): hover lights the ref through `peek` in `state/agent.ts`, which
  is not an agent highlight (no agent line, no locked tools) and is drawn in the accent on a layer of its own
  (`point` in `viewport/highlight.ts`, `Viewport.setPointed`), never in a mark's colour, whoever made the mark it is
  of; what the agent points at keeps its own layer and colour meanwhile; click focuses a mark or selects a face or edge (the
  chip of the build on show, once the build after it has failed, opens the sheet of that failure; an older build
  is an inert chip), and
  a click with the pointer gives the keys back to the view (`giveKeysBack`), as every action on the view does. A
  ref that names nothing now is an inert span with the reason as its title. A ref in prose that names nothing the
  object has is not a chip at all (`RefInfo.plain`: a mark it has not, `M3` the screw; a build above the current or
  `r0`; a part the build has in no layout); a part in another layout, or a face it lacks, is an inert chip with
  its reason. Code is never searched for refs. Numbers in the person's prompt and in a card's questions and
  options are set in the monospace face like the rest.
- Keys of the chat are rows of `shared/keys.ts` in the scopes `composer` and `picture`: `chat.send` Enter,
  `chat.newline` Shift+Enter, `chat.command` Up/Down and `chat.complete` Tab (while `/` commands are offered),
  `chat.close` Esc (a picture shown large; the focus returns to its thumbnail). Escape in the box gives the keys
  back, except while the list of `/` commands is open: it closes the list. A card takes focus once per request, and
  only when the composer is empty and not focused. An unsent prompt in a chat that is not over is among what closing
  the window asks about (`closingWhy`'s `unsent`). "Attach view" is sent in order: main waits for the picture
  before taking the next prompt, so one sent meanwhile cannot overtake it.
- **The instruction files Claude Code reads** are one quiet line under the view's row in `SessionPane`
  (`.session-reads`, `role="note"`, shown for both views and with no session, not while a new object is being made;
  `session.instructions`, asked again when a session starts): "Claude Code also reads, by default" and, for each file, its name
  (`shared/instructions.ts` `named`, the home folder as `~`, a rules folder with its slash; a button that shows it in its
  folder by `session.revealInstruction` with the row's index, never a path) and what it weighs (`weighed`: sizes through
  `shared/format.ts` `bytes`, `a link, not followed`, `up to 3 files, 2.1 KB` for a rules folder: at most that many load), in the monospace face; its title says what the list
  is (`READS_TITLE`: by default, paths and sizes only, never read or changed). It is no question and nothing of it is stored:
  there is no "seen" state, and it is there each time the pane is of an object that has some (`e2e/instructions.spec.ts`; the
  capture `instructions` of `themes.spec.ts`).
- The chat is refused, with a question, for a folder that has Claude Code settings of its own and has not been let
  (`SessionPane`: `trusting`; main's refusal is `trustQuestion` of `shared/agents.ts`): "Start the chat" asks main
  to remember the folder and starts again, "Use the terminal" chooses that view and starts it.
- The agent's text is drawn by torno's own `markdown.tsx`: React text nodes, never raw HTML, a link shows its URL
  and is not an `<a>`. A picture without its data (`ui/chat/gone.ts` `goneText`): a reference of the person's
  (`ChatImage.file`, `reference/doodle-1.png`) is shown from that file, asked of main once through `chat.reference`
  and scaled by `ui/onboard/images.ts`, as an object URL (`state/chat.ts` `referenceUrl`: 40 at most, revoked when
  let go of, when its session is released or dropped), its file name as the thumbnail's title, the frame empty
  while it comes; one main has no plain file for says `reference/doodle-1.png is no longer there`, the path in the
  monospace face. A tool's picture says "Picture of an earlier build, not kept"; any other "Picture not kept".
- **"Draw on view"** (`ui/drawing/`, `state/drawing.ts`). The ground is the agent's own picture of the view
  (`picture({ view: 'current', size: 1280 })`, the code of `look`), opened on `ui/board/Board.tsx` by `ViewBoard`, over
  the whole window as the export sheet is. The ink is `--drawing-ink` over a casing in `--panel` (`InkLook`), read once
  when the picture is made: the picture is of that theme. "Done" (`finishDrawing` in `make.ts`) composes the PNG
  (`compose.ts`) and, only while the screen is what the picture was made of (`ViewHost.shows()`, registered by
  `ViewportPane`: object, build, layout, camera, canvas size, section, explode, parts and scans shown), picks the view
  along each pen stroke where ink is left (`under.ts`: every 6 board pixels, 48 points a stroke at most): a face
  (`edges: false`), else a section's cut face, by its part (`Viewport.pickedCutOf`, from `pickUnder`'s `cutOf`), else a
  scan, else nothing. `ViewHost.shows()` is `screenShows`: a scan counts by whether it is drawn, how thin, whether its
  mesh has come and where it stands, not by whether its tree is made. A point of the picture is the same fraction of the canvas: one camera,
  one aspect. The faces' descriptors are waited for 3 s. The drawing then waits per session above the composer's box
  ("Edit", "Remove"); the board put away, by Done or Cancel, gives the keys to the composer's box (its own giving back
  finds "Draw on view" disabled once a drawing waits). It is taken by the next send and given back if that fails, counts as an unsent prompt when the
  window is closed (`unsentSessions`), and goes with the workspace (`clearDrafts`). The composer's box takes the pane's
  width; its buttons are a row under it. The drawing's row says what its ink lies over, in live chips
  (`ui/chat/DrawnOver.tsx`, from `drawnOver` of `shared/drawing.ts`: the faces, `the cut face of lid`, scans, `stroke 1 partly over no part`, `stroke 2
  over no part`; the hover lights a face in the view as everywhere): one that was not worked out says so in `--warn` with
  "Draw again" (which drops it and opens a new board); one drawn on an earlier build says its faces are of that build.
  The sent prompt shows the same line under its picture (`drawing` on the user item). "Attach view", pressed, shows a
  thumbnail of the view as it is now in a row of its own beside the drawing's, with "Remove"; that very picture is the one
  sent (`attachedView` of `chat:send`, kept as bytes beside the thumbnail, shown again if the send fails), not another made as
  the prompt goes. The board is titled "Draw on view", as its button.

## Export

- "Export…" is a button in the status line for the open object, in the head of the page of objects for every
  object that can be exported, and on each card that has a build of this run, for that object. The sheet is
  modal (`aria-modal`, Tab stays in it, nothing behind it takes a click). `Ctrl+Shift+E` (the row `export` of
  `shared/keys.ts`, heard everywhere, the terminal included) brings it up: for the open object, or from the page
  of objects for any. There is no agent tool for it.
- Its format buttons (`HTML page`, `STEP`, `STL`, `3MF`) choose what is written; the HTML page is the default
  and its sheet is as it was. A file of the model is of one object (the objects are then radio buttons), one
  layout (`defaultLayout`: `assembly` for STEP, `print` for a mesh) and the parts ticked (one, by radio, for an
  STL; a part with no solid cannot be ticked for a mesh), each from the plan's `layoutParts`; a mesh has a
  tolerance and an angle typed in, and Export is off while either is out of its range. A 3MF has "Open it once
  saved", off by default. The window sends names and numbers and never a path; once saved, the sheet says where,
  of which build, and what the read-back checked (`ExportSaved.checked`), every number in the monospace face.
- **"Picture"** in the view bar (`ui/PictureMenu.tsx`, after the explode button) keeps the view as a PNG: a menu with the long
  edge (`PICTURE_SIZES`, 1280 to 4000), "Marks" and "Axes and scale bar" (both on), and "Save picture…". The window draws
  the picture itself (`pictureForPerson` in `state/agent.ts`, the code of `look` with `ImageRequest.person`) and hands main
  its bytes with the object's id (`export.savePicture`); main asks where to save, so the window names no path. `person` is
  set only there: a request of the agent's, which comes over `view:look`, is held to 2000 px (`connectLook`).

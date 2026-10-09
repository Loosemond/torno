# torno

Torno is a desktop workbench for making CAD parts with an AI coding agent. The
agent (Claude Code) writes build123d Python in a terminal inside the window.
Torno builds the model every time its file is saved, shows the parts in a 3D
viewport beside the terminal, and gives the agent tools to see what you see.
You point at the part to say what you mean: a pin, an arrow, a stroke or a
rough shape, each with a note, which the agent gets with your next prompt.
You measure it, and a measurement you give an expected value is checked on
every build and told to the agent until it holds. A 3D scan of where the part
goes can be laid over the model, and the agent can ask where the two run into
each other.

Torno is not a modeller. It has no sketcher, no feature tree and no way to edit
a solid by hand. The model is the Python file; torno shows it.

The name is Portuguese for lathe.

This is Milestones 1 to 4. The loop: open a workspace, rebuild on save, look
at the parts, talk to one agent session per object. Talk: point at the parts
and leave marks, which travel to the agent and which it can read, answer and
resolve. Read: measure the parts, pin dimensions that are measured again on
every build, cut them by a plane, and give the agent the same as tools. Scan:
import a scan of the surroundings, align it to the model, paint and name
parts of it, and let the agent check the model against it. What comes after
is listed under [Next](#next). The design is in
[docs/superpowers/specs/2026-10-08-torno-design.md](docs/superpowers/specs/2026-10-08-torno-design.md).

## Requirements

Linux. Developed on Arch with Wayland; nothing else has been tried.

- Node.js 22.12 or later (developed with 26) and pnpm 10
- [uv](https://docs.astral.sh/uv/)
- Python 3.11 or 3.12 (uv fetches one if none is installed)
- The `claude` CLI (Claude Code) on `PATH`, logged in
- A workspace: a folder of objects, each a subfolder with a Python model in
  it. If the workspace has a `pyproject.toml`, its environment must already
  exist and hold build123d (`uv sync` there once, yourself). Torno runs the
  kernel in that environment with `uv run --no-sync` and never changes it; if
  there is no `.venv` it starts no kernel, and every build fails telling you to
  run `uv sync`. A workspace with no `pyproject.toml` is built with the
  build123d of torno's own kernel environment.
- Importing a scan needs `trimesh` and `pillow`, which uv fetches the first
  time a scan is imported (the kernel itself does not need them). The checks
  against a scan use the `scipy` of the workspace's environment, which
  build123d brings.

## Install

```sh
git clone <this repository> torno
cd torno
pnpm install
```

The kernel's Python environment (`kernel/.venv`) is made by uv the first time
it is needed.

## Run

```sh
scripts/torno ~/objects     # open that folder as the workspace
scripts/torno               # open the workspace opened last
pnpm start                  # the same as the line above, from the repository; it takes no folder
```

`scripts/torno` works from any directory, and through a symlink. It installs
the dependencies if `node_modules` is missing, builds the app if it has not
been built since the sources last changed, and starts it. A build that fails
is tried again at the next start.

Only one torno runs at a time. Starting it again brings the window that is
already open to the front and says so on stderr; given a folder, that window
opens it, asking first if a session there is in the middle of its work.

For work on torno itself, `pnpm dev` runs the app from the Vite dev server.
`F12` and `Ctrl+Shift+I` open the developer tools whenever torno runs from the
repository; `F5` and `Ctrl+R` reload the window under `pnpm dev` only, because
in the app itself those keys belong to the agent's CLI.

Torno has no menu. The window is closed through the window manager, which
ends torno; `Ctrl+Q`, `Ctrl+W`, `F11` and the zoom shortcuts do not exist.

## The window

- **Left:** the objects of the workspace, the layers (parts) of the open one,
  each with a visibility switch, its scans, and its marks. "Open folder" chooses another
  workspace; that ends the sessions of this one, so torno asks first if one of
  them is working or waiting for an answer.
- **Centre:** the viewport. Drag to orbit, drag with the right or middle button
  to pan, scroll to zoom. The bar at the top
  switches layout (`assembly`, `print`) and view. Keys: `1` iso, `2` front,
  `3` right, `4` top, `F` fit, `O` orthographic or perspective. The tools are
  at its left edge; see [Pointing and marks](#pointing-and-marks).
- **Right:** the session. "New session" starts `claude` in the object's folder,
  in place of the session running there, if any; torno asks first if that one
  is working or waiting for an answer.
  "Resume" continues the last conversation had there. Each object has its own
  session, and it keeps running while another object is shown. Its status
  (idle, working, needs input, ended) follows the hooks Claude Code posts.
  `Ctrl+\`` moves between the session and the viewport. `Shift+Enter` is a new
  line. `Ctrl+Shift+C` and `Ctrl+Shift+V` copy and paste; torno has no menu,
  so nothing else answers to those keys.
- **Bottom:** the build status: building with the seconds elapsed, built with
  the time it took and the revision, or failed. A failed build keeps the last
  good parts on screen, and its status opens the error with the traceback.
  Beside it, how many dimensions that are not resolved fail on that build
  (`1 dimension fails`), sent or not, and how many have no value on it (`1
  dimension not measured`: not measured yet, or not measurable); a click goes
  to the first.

Saving a file in the object's folder (dotfiles, `out/`, `cache/`, `.torno/` and
`__pycache__/` are ignored, as are `build/`, `dist/`, `node_modules/`, `.venv/`
and `.git/`) or in the workspace's `common/` starts a build 300 ms later.
Saving a `.py` file during a build cancels that build and starts another. Any
other file changing during a build may be the model's own doing, so the build
is left to finish and one more follows it. A build that runs longer than 600 s
is stopped; `TORNO_BUILD_TIMEOUT` sets another limit.

### Pointing and marks

The pointer is told what it is on: a face (`lid/F12`), or an edge within reach
of it (`lid/E3`), with a line from the kernel on what that is, such as
`plane, normal +Z, z = 20, 1180 mm²`. Hidden parts are never picked. While the
parts on screen are older than the model (a build is running, or the last one
failed) nothing is picked, and the pointer says why.

The tools, each with its key:

| Key | Tool | What it does |
|---|---|---|
| `V` | Select | Click selects a face or an edge, Shift-click adds or takes out, `Esc` clears. "Insert" puts the selected refs in the session's prompt without sending it; "Note" leaves a mark on each. |
| `P` | Pin | Click a part: a pin there, and its note opens beside it. |
| `A` | Arrow | Drag from a part: an arrow of that length. With Shift it runs along the surface normal or a principal axis. |
| `D` | Draw | Press and draw. On a locked view (an orthographic front, back, left, right, top or bottom, not turned since; a padlock shows on its button) the stroke is a profile in millimetres on the plane that faces you. On any other view it lies on the surface. Alt-drag turns the camera with this tool in hand. |
| `S` | Shape | Click places a box, cylinder, sphere or plane, to add, remove, keep out or refer to. A gizmo moves it (`G`), turns it (`R`) or sizes it (`T`), and its row has the exact numbers. |
| `X` | Section | Cuts the parts by a plane, to look inside. A bar at the bottom of the viewport sets it. |
| `M` | Measure | Two clicks leave the distance or the angle between two faces or edges; a double click on something round its diameter or radius; `T` the thickness of the wall under the pointer. Each is a dimension, with a number like any mark. |
| `L` | Align scan | Puts a scan where it belongs against the model: by its floor, by pairs of points, or by hand. See [Scans](#scans). |
| `B` | Region of a scan | Paints a part of a scan, to name it with a note. See [Scans](#scans). |

**Section.** With `X` a bar appears at the bottom of the viewport: X, Y and Z
put a plane across that axis through the middle of the parts, "From face" puts
it on the next flat face you click, the slider and the number beside it say
how far along its normal the plane is from the middle of the parts, "Flip"
takes away the other side and "Off" shows the parts whole again. What is on
the side the plane's arrow points to is not drawn. Each solid part is closed
where it is cut, in its own colour a step darker; a part that is not a closed
solid (a scan, an open shell) is cut open. Drag the arrow on the plane to move
it; a drag anywhere else turns the camera as ever. The arrow keys move it by
1 mm, with Shift by 0.1 mm. On a cut face there is nothing of the model to
pick, and the pointer says so; a mark on what was cut away stays, drawn
faint. The bar stays while there is a section, whichever tool is in hand. The
pictures the agent takes are cut the same way.

**Measure.** With `M` a strip appears in the bottom corner of the viewport:
what two clicks measure (Distance or Angle), what a double click on a hole, a
cylinder or a circular edge measures (Diameter or Radius), and the key `T`,
which has no button: with the pointer on a face it measures the wall there,
from that point along the inward normal to where the part ends. `T` acts on
what is under the pointer at that moment, also straight after the tool was
taken up or the wheel zoomed. With Shift a click is a bare point, tied to no
face.
While the second click is pending the pointer reads out an estimate from the
mesh, marked `≈`. What is kept is never that: torno asks the kernel, which
measures on the exact geometry and says how (`6 mm between planes`, `axis to
axis`, `point to plane`, `minimum`). A distance between two parallel flat
faces is the distance between their planes, between two cylinders or circles
with parallel axes the distance between the axes, and of anything else the
least distance. When the kernel refuses (an angle between a flat face and a
cylinder), nothing is kept and its reason is read out at the pointer for four
seconds. Between two parts that torno spread apart in a `print` layout there
is no distance to measure (see [Measuring tools](#measuring-tools)): the
pointer says `Parts are spread for printing here: no distance between them.
Add assembly(p) to check fit.` in place of the estimate, and after a click
until the next click or `Esc`. `Esc` drops a first click; the tool stays in
hand.

**Dimensions.** What the Measure tool leaves is a dimension: a mark (`M4`)
with a value, drawn on the part with its number and value, and listed with
the marks. Its row, once clicked, shows the value in full, how it was taken,
and two fields: **Expected** and **Tolerance**, in mm or degrees. With an
expected value the dimension is a check: it passes when the value is within
the tolerance of it (0.05 mm, or 0.1° for an angle, when you give none) and
fails otherwise, and the row says `Passes` or `Fails: 2 under`. A failing
one is ringed on the part and in the agent's pictures.

- Like any mark, a dimension is a **draft** until a prompt has carried it to
  the agent. From then until it is resolved its row says **pinned**: it is
  one of the checks the agent is told about (see
  [What the agent gets](#what-the-agent-gets)). Changing what is expected or
  the tolerance makes it a draft again, sent as `(changed)`; so does changing
  them on a dimension the agent placed.
- A **resolved** dimension is no longer measured. Its row keeps the value it
  was last measured as, greyed, with no tick or cross, and says
  `as measured on r5`. So a dimension of yours that has an expected value is
  yours alone to resolve: the agent is refused, and told how the check
  stands. It may resolve a dimension it placed itself.
- After every build, every dimension that is not resolved is measured again
  on the new geometry, once its ends have been checked against it like any
  mark's. Until that has happened its row shows the old value greyed and says
  `not measured on r12: this is what it was on r11`, and its line on the part
  is drawn dimmed; it has no verdict meanwhile, and the agent is told
  `not measured on r12 (was 6 mm on r11)`. In a new run of torno every
  dimension is measured at the first build, and says `not measured yet` until
  then: what its file holds is of no build of this run.
- An end the build moved away from is measured from the face that is under
  it now, and the dimension says `measured from what is under its ends now`
  (to the agent: `[moved since it was placed: check it]`).
- A dimension is **not measurable** when the part of an end is gone, when
  the kernel refuses it on the new geometry (the hole is no longer round),
  or when an end that was put on an **edge** is no longer on that edge. It
  then has no value and no verdict, and the row and the agent are told why:
  `the edge plate/E7 it was on is not under its end on r12`. So is a distance
  between two parts on a build whose `print` layout torno spread, and one
  from a bare point to a part torno moved: the reason names the layout to
  measure it in, if the object has one that places the parts as assembled.
- Ends on faces and ends on edges behave differently when the part changes
  size. A face is found again under the point, so a thickness measured
  between the top and the bottom face follows the plate as it gets thinner.
  An edge is the edge of that number: its end still counts as on it while
  the edge is within 0.5 mm of the point, or while the nearest point of the
  part is on that very edge and within the part's tolerance,
  `max(0.5 mm, 0.5 % of the diagonal of its bounding box)`. On a part
  360 mm across that is 1.8 mm, so a small change is measured through; beyond
  it, or when the edges are renumbered, the dimension is not measurable and
  has to be measured again. For a check that must hold across edits, click
  faces, not edges.
- A dimension is not put somewhere else as a pin is: delete it and measure
  again.

`Esc` drops what is being dragged, then puts the tool down for Select. In a
note, `Enter` saves and `Esc` leaves it for later. A note is also kept when
you leave it any other way, such as `Ctrl+\`` to the terminal: what you typed
goes with the prompt you type next.

A pin on an edge is a pin on that edge: the pointer snaps to an edge within
reach, and the agent is told which edge it is and the two faces that meet
there. A mark on a part that is switched off in the layers is not drawn, in
the window or in the agent's pictures; its row stays and says "its part is
hidden".

Every mark has a number (`M1`, `M2`, never reused), a note, and a row in the
marks panel. Yours are drawn in red, the agent's in green. A mark is a
**draft** until a prompt has carried it to the agent, then **sent**, then
**resolved** by you or by the agent, with a line on what was done. Clicking a
row goes to the view the mark was placed from.

A mark you change after it was sent (its note, or a shape's place, size, kind
or intent) is a draft again, and the next prompt carries it once more, marked
`(changed)`.

A mark the agent resolves does not vanish: it stays in the list, its row
saying "Resolved by the agent" with the agent's line on what it did, until you
press **OK** (it goes under "Resolved") or **Reopen** (it is a draft again). A
mark of the agent's that you reopen is told to it with the next prompt as
`(yours, reopened by the user)`.

After every build each mark is checked against the new geometry. It stays at
its point; its ref is refreshed to the face now there. When the surface has
moved away from it the row says "moved: check it", and when its part is gone,
"its part is gone"; the agent is told the same. Such a pin, pick or arrow of
yours offers **Re-place** in its row: the next click on a part puts that mark
there, with its number and note, and `Esc` leaves it where it is.

In a `print` layout that torno spread along X (see below), a part that grows
pushes the parts after it along. A mark on one of those moves with its part,
by as much as the part was moved, and is checked there: it stays where you
put it on the part.

When a check cannot be made (the kernel did not answer in time, or could not
say where a point is), the marks it was about keep what the last check found
and say "not checked against r12", in their rows and wherever the agent reads
them, until a check succeeds. Torno tries again after 2, 10 and 30 seconds,
and at the next build; and every 30 seconds for as long as the kernel only
says it is still busy with an earlier question.

### Scans

A scan is a mesh of the real thing or of where the part goes: an engine bay,
a room, a machine, taken with a phone or a scanner. Torno draws it with the
parts, so that you and the agent can see and check the model against it. It
is good to a few millimetres at best and shows only what the camera saw.
**Nothing taken from a scan is exact**, and torno never says that it is.

**Importing.** "Import scan…" in the Scans panel, or a file dropped on the
view: GLB, glTF, OBJ, PLY or STL, with faces (a point cloud is refused). The
file is only read. Torno keeps its path, size, date and hash, and makes one
mesh of it in millimetres and Z up, `.torno/scans/<id>/mesh.bin`, baking a
texture into colours at the vertices. The scan goes on working from that mesh
when the file moves or is deleted (its row then says "source missing" or
"source changed", once the object is opened again); when the mesh is gone
too, the row says so and offers "Import again". A scan of more than 2,000,000
triangles is reduced to at most that many, and its row says from how many. One file
is read at a time, in a process of its own; the window stays free meanwhile,
and the scan can be pointed at about a second after it is drawn.

**Units.** A file does not always say its unit. glTF is read as metres and
Y up; the others as millimetres, or metres when the whole is under 20 units
across, with Y up for OBJ and Z up otherwise. The row says the size in
millimetres and what was assumed (`2518 × 2351 × 1494 mm, from m, Y up
(assumed)`) and asks "right?" until you say "Yes" or choose another unit or
axis under "More". Changing either turns the mesh as it is, without the
source file, and drops the scan's alignments, which torno says before it does
it.

**The Scans panel.** Each scan (`S1`, `S2`, never reused) has a row: its
name and size, how it stands in the layout on screen, a switch, an opacity
slider and "More" (unit, up axis, its own colours toned down or one plain
colour, remove). A scan drawn solid hides what is behind it and takes the
pointer; one drawn see-through lets you point at the part behind it. The
section cuts a scan open like the parts, with no cut face. `F` and the views
frame the parts, not the scan.

**Aligning** (`L`). A scan is aligned in one layout at a time; in a layout
where it is not, its row says "not aligned here", it is drawn where it was
imported, and nothing is checked against it. The bar at the bottom of the
viewport has three ways, which can follow one another:

- **Floor.** Click a flat patch of the scan (`[` and `]` change its size), or
  three points with Shift. "Ground" lays it at a height, "On a face" on the
  flat face of the model you click next; "Flip" turns it the other way up.
  The bar says how flat the patch is. A floor says how the scan lies, not
  where on that floor it is.
- **Pairs.** Click a point on the scan, then the same point on the model, or
  type the model point. From three pairs that are not in a line the scan is
  drawn where they put it, with how far each pair is left apart and the RMS
  of all. Nothing is kept until "Apply". When the fit says the scan is some
  10, 25.4 or 1000 times off, the bar says which unit that looks like and
  offers to read the scan as that; "Keep this scale" keeps a scale the fit
  found. With a part in front of the scan a click is taken for the part: look
  at the table's rows as you go.
- **Nudge.** Handles to move (`G`) and turn (`R`) the scan, and fields for
  where its origin is and how it is turned.

"Undo" puts back the alignment before the last one, "Clear" takes it away.
What the row then says of the scan is what the agent is told of it:

| Row | Meaning |
|---|---|
| `aligned`, `4 pairs, RMS 2.1 mm` | A fit of pairs, and how well they fitted. The RMS is of the points you clicked, not of the scan. |
| `floor only` | Laid on a floor and no more: where it is on that floor is as it was imported or put by hand. |
| `by hand` | Placed by the handles or typed values: no fit says how well. |
| `…, then moved by hand` | A fit or a floor that was moved afterwards; the row says how far apart the pairs now are. |
| `rough alignment` | A fit that cannot be relied on: fewer than three pairs, pairs almost in a line, or pairs left more than 5 mm apart. Torno asks before it keeps one. |
| `check alignment` | The model has moved since: a point you clicked on a part is no longer on it, torno spreads a part otherwise, or the scan was imported again from a changed file. The row says which. Align again, or press "Still right". |
| `not checked yet` | The last build has not been compared with the alignment yet, or the kernel could not say (the row gives the reason; it is tried again every 30 s). |
| `Tied to no point of the model` | No end of the alignment was clicked on a part, so no build can say whether it still holds. |

After every build torno looks for the model points of each alignment on their
parts again. It tells what it finds; it never moves a scan by itself.

**Regions** (`B`). Drag over a scan to paint a part of it: a brush whose
radius is in the bar (`[`, `]`), "Erase" (`E`, or Ctrl held), "Box"
(Shift-drag) for what a rectangle covers, "Grow to flat" to take in the flat
surface round what is painted, "Undo" (`Z`), "Clear". "Keep" (`Enter`) makes
it a mark with a number and a note, such as "wiring loom, can be pushed
aside"; `Esc` drops what was painted. A region is tinted on the scan in your
mark colour, travels to the agent like any mark, and is how you tell it what
a part of the scan is. Removing a scan leaves its regions as marks that say
their scan is gone.

**Where a scan can be checked.** A scan is checked only against parts that are
where the model puts them. A `print` layout whose parts overlap is spread by
torno for display, and every part it moved is refused by the scan checks; a
part it did not move (the first of the row) is answered, but a print layout
poses parts for the bed, so the answer means something only if the model
leaves that part where it is mounted. To check a fit against the car, the room
or the machine, give the model an `assembly(p)` that places the parts as
mounted, and align the scan in that layout.

### How a model is read

The kernel imports the model file as a module (`if __name__ == "__main__"` does
not run) and takes the first of:

1. `Params()` with `assembly(p)` (layout `assembly`) and `printables(p)` or
   `printable(p)` (layout `print`), each returning a dict of name to part.
2. `Params()` with functions named `make_<part>(p)`, defined in the model file
   and callable with the parameters alone: each one that returns a solid is the
   part `<part>` (layout `main`).
3. build123d shapes in module-level variables (layout `main`).

In the `print` layout a model usually poses every part for the bed at the
origin. When parts of that layout overlap seen from above, torno sets them
side by side along X, 10 mm apart, in the order the model gave them; each
keeps its own Y and Z. The picture, the bounding boxes and `scene` all show
the parts where torno put them, and `scene` says how far each was moved
(`arranged`). The model and what it exports are not changed.

A folder is an object when it holds a `.py` file; dotfiles and `__init__.py`
do not count, and folders whose names start with `.` or `_`, and `common`,
`tests` and `out`, are never objects. The model is the one `.py` file that is
not a test (`test_*.py`, `*_test.py`, `conftest.py`). Of several, it is the one
named after the folder, with `-` and `_` taken as the same:
`helmet-stand/helmet_stand.py`. Once an object is open, torno keeps building
the model it chose for as long as that file exists, so a scratch script saved
beside it later changes nothing. A folder where no model can be chosen, or a
model with none of the above, is listed with the reason it cannot be built.

## What the agent gets

Torno starts Claude Code with everything on the command line (`--mcp-config`,
`--settings`, `--append-system-prompt`, `--allowedTools mcp__torno__*`). Torno
does not read or change your Claude Code settings; Claude Code still applies
them.

- **`mcp__torno__scene`**: the build status and error, the layouts, every part
  with its size, bounding box, volume and whether it is visible, your camera
  and your section, if you have one. It notes when the parts of the print
  layout were spread along X, and counts the dimensions that are held to a
  value: `dimensions: {pass, fail, notMeasured}` on that build. It lists the
  scans (`scans`), each with whether it is aligned in the layout said for.
- **`mcp__torno__look`**: a picture from the renderer you are looking at. With
  no arguments it is exactly your view, cut by your section if you have one.
  It also takes a named view (`iso`, `front`, `back`, `left`, `right`, `top`,
  `bottom`), a camera, a layout, a list of parts, a size (long edge, 1280 by
  default, 2000 at most) and a `section`: `'current'` (yours, the default),
  `null` for the parts whole, or a plane of the agent's own. The caption
  names the revision that was drawn and the cut, and says when it is stale.
  Scans are drawn as you have them; `scans: false` leaves them out and a list
  of ids draws those. The caption names each scan drawn with how it is
  aligned. `scanColour: {part, range}` colours one scan by its distance to a
  part instead (see [Scan tools](#scan-tools)).
- **`mcp__torno__marks`**, **`mcp__torno__describe`**: your marks and the
  agent's as data, and the exact geometry of a part, a face or an edge
  (`lid`, `lid/F12`, `lid/E3`). Both say which revision they answer from, and
  say so when a newer build is running or has failed; `add_mark` does too.
- **`mcp__torno__highlight`**, **`mcp__torno__show`**: the agent tints faces
  or edges in your viewport with a note, to ask "this one?", until you click
  or a minute passes; or changes your camera, layout and visible parts to show
  you something. `show` also takes a `section`: a plane to cut your view by,
  or `null` to take your section away, `scans` (the ids to draw; none for an
  empty list) and `scanOpacity`. What `show` changes is for now: the
  layers, the layout, the section and the scans' looks you chose stay what
  `.torno/scene.json` keeps. While you hold a button in the viewport, `show` is refused and the
  agent is told to try again.
- **`mcp__torno__add_mark`**, **`mcp__torno__resolve_mark`**: the agent leaves
  marks of its own, in green, and resolves yours with a line on what it did,
  which you then confirm or reopen. With `kind: 'dimension'` (`measure`, `a`,
  for a distance or an angle `b`, and optionally `expected` and `tolerance`)
  it leaves a dimension, measured at once and on every build like yours. One
  that was kept but could not be measured yet (the kernel did not answer, or
  the model was rebuilt meanwhile) is answered `NOT MEASURED: …`, with when
  it will be. `resolve_mark` refuses a dimension of yours that has an
  expected value (`M1 is the person's check of the part: it stays measured on
  every build and only they resolve it. It passes on r5.`), and says of any
  other dimension it resolves that it is no longer measured.
- **`mcp__torno__measure`**, **`mcp__torno__section`**,
  **`mcp__torno__check`**: exact numbers from the geometry, so the agent
  need not work a size out from the code or write a script. See
  [Measuring tools](#measuring-tools).
- **`mcp__torno__scans`**, **`mcp__torno__scan_clash`**,
  **`mcp__torno__scan_deviation`**: the scans of the object and how each is
  aligned, what of a scan is inside a part, and how far a part lies from a
  scan. See [Scan tools](#scan-tools).
- **A few lines with every prompt**, added by a `UserPromptSubmit` hook:
  `[torno] bracket · build ok · r3 (1.2 s) · layout assembly · parts: base, post.`
  For a failed build it carries the error. For an object that is not the one
  open in the window it says so, and names no layout. Then, when the object
  has scans, one line of them:
  `Scans: S1 Micra.glb, aligned in print by 4 pairs (rms 2.1 mm, worst 3.4 mm), shown at 60 %.` Then what you have
  selected, when the parts on screen are those of the last build:
  `Selected: base/F5 (plane, normal +Z, z = 2.5, 1200 mm²), base/E5 (line, 30 mm)`,
  eight refs at most. Then each mark you left since the last prompt, a line
  each, such as
  `M3 pin on the edge lid/E40 between lid/F12 and lid/F40 (line, 40 mm) at (12, 40.5, 20): "this edge is ugly"`,
  and the numbers of the marks still open, each with what the last build did
  to it: `Open marks: M1 (moved), M4 (part gone), M6 (unchecked)`. A mark is
  told this way once: it then shows as sent. A mark you put somewhere else, or
  changed, is a draft again and is told again, the changed one as
  `(changed) M3 …`. After `/clear`, the first prompt of the new conversation
  lists your open marks once more, since it has seen none of them.

  A dimension that is still a draft is told with the marks, with its value
  and verdict:
  `M1 distance 6 mm between planes, plate/F2 to plate/F4 (expected 8 ± 0.05: FAIL, 2 under)`.
  Once sent it is pinned, and from then on every prompt carries a block for
  the pinned dimensions the last build does not meet: one line for each that
  fails, is not measurable or was not measured on that build, then how many
  pass.

  ```
  Dimensions (measured on r3):
  M1 distance 6 mm between planes, plate/F2 to plate/F4 (expected 8 ± 0.05: FAIL, 2 under)
  1 pinned dimension passes
  Open marks: M2
  ```

  The head names the build the values are of. While a newer build is running
  or has failed it says so
  (`Dimensions (measured on r3; a build is running, so these are not of your last edit):`),
  so that a FAIL of the build before is not read as a verdict on the edit.
  A line stays until its dimension passes or is resolved. A pinned dimension
  with no expected value has a line only while it has no value. Among those
  that pass, the ones whose end the build moved are named
  (`1 pinned dimension passes (1 measured from what is under its ends now: M9)`).

### Measuring tools

Lengths are millimetres, angles degrees, areas mm², volumes mm³ and masses
grams; Z is up. The three tools answer from the last build that worked and
say which revision that is, and that it is stale while a newer build runs or
has failed. Each reply is JSON with a `reading`: the answer in one line, such
as `6 mm between planes, plate/F2 to plate/F4`. A question the kernel has not
answered within 30 s is an error that says so; until it has finished with
that one, the next questions are answered at once that it is still busy, in
the kernel's words. An argument that is no plane or no end is answered with
what one looks like, such as `{"axis": "z", "at": 3}`.

**`measure`** takes `kind`, `a`, for a distance or an angle `b`, for a mass
`density`, and `layout`. An end is a ref (`lid/F12`, `lid/E3`, or a whole
part where the kind takes one), the number of a mark (`M3`: what it is on,
only if the last build's check confirmed it), `{point: [x, y, z]}`, or
`{ref, point}` for the feature the ref names, taken at that point.

| `kind` | Of | Reply |
|---|---|---|
| `distance` | `a` and `b` | `value` in mm, the two `points` it is between, and `how`: `between planes` (two parallel flat faces), `axis to axis` (two cylinders or circles with parallel axes), `point to plane`, between two points, else `minimum` |
| `angle` | `a` and `b` | degrees: between the outward normals of two flat faces (0 to 180), or between two straight edges, or a straight edge and a flat face (0 to 90) |
| `radius`, `diameter` | a cylindrical, spherical or toroidal face, or a circular edge | mm |
| `thickness` | a face of a solid, at a point of it (`{ref, point}`; the centre of the face when no point is given) | mm, from the point along the inward normal to where the part ends. The point must be on the face, give or take what a pick on the mesh is out by; it is laid on the face, and `moved` says how far in mm |
| `bbox` | a part, a face or an edge | `min`, `max`, `size` |
| `area` | a part or a face | mm² |
| `volume` | a part that is a solid | mm³ |
| `mass` | a part that is a solid | grams, with the `density` used (g/cm³; 1.24, PLA, when none is given, and the reply says so) and the `volume` |

**`section`** takes `plane`, and optionally `parts`, `layout`, `size` and
`deflection`. A
plane is `{origin, normal}`, or `{axis: 'x' | 'y' | 'z', at}` for the plane
across that axis at that coordinate, or `'current'` for your own section.
The reply has, for each part, the outlines the plane cuts of it as closed
loops of `[u, v]` points in mm along the plane's own axes (given as `x` and
`y`), each loop's `area` (negative round a hole), the part's `area`, how many
loops are `open`, and the extent of the whole cut. The outlines come from
the exact geometry, as polylines within 0.01 mm of it, or within the
`deflection` asked for (0.005 to 0.05 mm). A reply holds at most 4,000 points
in all, whether or not parts are named: beyond that each loop has its share
by its length, eight points at least, and says so (`thinned`, the `of` it
had and the `deflection` it then has), as does the reply (`thinned`, `points`,
`of`); beyond 500 loops the shortest are left out and counted
(`loopsOmitted`). Areas are the kernel's, of the true outlines, whatever was
thinned, and the drawing is always made from the outlines in full.
With it comes a 2D drawing of the cut on a millimetre grid, each part in its
colour, with what is up in the world up on the page; it is also saved under
`.torno/views/`. To see the cut in 3D the agent calls `look` with a
`section`.

**`check`** takes `kind`, `a`, for two parts `b`, and `layout`; `a` and `b`
are names of whole parts.

| `kind` | Reply |
|---|---|
| `overlap` | the `volume` two solid parts share, in mm³, and the box it lies in; 0 and no box when they share none |
| `clearance` | the least `distance` between two parts in mm and the `points` it is between. It is 0 when they touch, and when they overlap, which `overlapping: true` then says; of a part that is no solid the distance is told and `overlapping` is `null` |
| `mesh` | whether the mesh the part is drawn and exported with is closed (`watertight`), its `triangles`, the number of `openEdges` and where up to 20 of them are |

**Exact and approximate.** Every number these tools give is measured by the
kernel on the model's own B-rep, never on the mesh on screen. A reply says
`exact: true` when the value is exact; otherwise the reading starts with `≈`
and says `approximate`, and `how` says why:

- Distances, angles, radii, diameters and thicknesses are exact.
- A volume is integrated adaptively until it has converged to one part in
  10⁹, and is given as exact.
- An area is exact for planes, cylinders, cones, spheres and tori, and for a
  curve extruded straight and not cut along its height. The area of any other
  face (a loft, a B-spline surface, a revolved spline, an offset) is never
  said to be exact: no integral converges on every such face, and none says
  when it has not. `how` says `approximate, good to about N significant
  digits` (2 to 6), or, when its integrals are too far apart to vouch for
  two, `approximate: its integrals differ by 2.1 %`, with no count of digits.
  The area of a part is exact only when the area of every face is; otherwise
  its digits are of the whole, so a part may say N digits while one small face
  says none.
- A bounding box is exact when all the faces of what is boxed are planes or
  cylinders and all its edges lines or circles; of anything freeform it is
  approximate.
- The areas of a section say for themselves (`areaExact`).
- `moved`, on a thickness, is not an error bar: it is how far the point that
  was given lay from the face before it was laid on it. A pick from the mesh
  is a few thousandths of a millimetre off a curved face.

**What it costs.** Since volumes and areas are integrated, what is asked of a
whole part with many freeform faces (`describe`, `volume`, `mass`, `area`)
takes seconds on the first ask, and is then kept until the next build; of a
prismatic part, and of a single face, it takes milliseconds. The volume of
every part is also worked out during each build.

**Parts that fit together.** `overlap`, `clearance` and a distance between
two parts are of the parts where the layout has them, so fit can only be
checked in a layout that places the parts as assembled (`assembly(p)` in the
model). In a `print` layout that torno spread along X the parts are where
torno put them for display, not where the model has them: there these three
are refused between two parts, with a sentence that says why and names the
layouts that do place both parts, if the object has any. So is a distance
from a bare point to a part torno moved, and a dimension of either kind is
not kept: one that is there already is not measurable on such a build. What is of one part
is answered as ever (thickness, diameter, bbox, area, volume, mass, mesh, a
distance within the part, and an angle, which moving a part does not
change), with `arranged`, how far torno moved the part, beside any points.
A `section` of such a layout says so in a `note`, in its reading and on the
drawing, and gives each part's `arranged`. An object with only a print
layout can therefore be measured part by part, but not checked for fit
until its model has an assembly.

### Scan tools

The agent cannot import or align a scan: you do. It can ask about one. Every
reply names the revision, the layout and how the scan is aligned there, has
`exact: false` and `approximate`, and a `reading` whose numbers follow a `≈`
and which opens with whatever puts the alignment in doubt (`S1's alignment
may no longer hold: …`, `S1 is only roughly aligned: …`, `S1 was placed by
hand: no fit says how well.`). The one thing measured exactly is the distance from
a scan point that a reply names to the part's B-rep, and that point is still
a scan's. A tool given a key it does not take is refused, naming the keys it
takes.

The readings below are of a phone scan of an engine bay against the part
that goes in it, aligned by four typed points.

**`scans`** lists them: name, source and whether it is still there, triangle
count, size, unit and up axis and whether they were assumed, whether it is on
screen, its regions, its box in the layout and its alignment.

```
S1 Micra.glb: 1,607,144 triangles, 2518 × 2351 × 1494 mm, from m, Y up (assumed), aligned in print by 4 pairs (rms 0.003 mm, worst 0.005 mm) (tied to no point of the model: not checked against builds), shown, 1 region.
```

**`scan_clash`** takes `part`, and optionally `scan` (when there are
several), `margin` (how far round the part scan points are looked at, 0 to
50 mm, 5 by default), `ignore` (region marks to leave out) and `layout`. It
counts the scan's vertices inside the part, by ray parity on the mesh the
part is drawn with, groups them in clusters with the deepest point of each,
counts the scan's triangles that cross the part's surface, and names the
nearest scan point outside. It gives no volume: a scan is an open surface.

```
scan_clash airbox-tub vs S1 (print, r1): ≈ 125 scan points inside the part in 1 cluster, deepest 2.367 mm at (-95.63, 125.4, 12.76) under airbox-tub/F25; 145 scan triangles cross its surface; nearest scan point outside 0.008139 mm from airbox-tub/F57. S1 is aligned by 4 pairs (rms 0.003 mm, worst 0.005 mm): a depth under that says nothing (tied to no point of the model: not checked against builds).
```

**`scan_deviation`** takes `part`, and optionally `faces` (refs of faces of
that part), `from` (`part`, the default: from points of the part to the
scan's triangles; `scan`: from the scan's vertices to the part), `region`
(only that region of the scan), `within` (0.1 to 200 mm, 50 by default),
`samples` (100 to 20,000; 10,000 by default), `scan` and `layout`. It gives
the least, mean, greatest and RMS distance and percentiles, signed where the
part is a solid, the worst place, and how many samples had nothing within
reach.

```
scan_deviation airbox-tub vs S1 (print, r1): ≈ 24.14 mm median, 25.26 mm mean, 50 mm at most (95 % within 45.7 mm), from 8,802 points of the part to the scan; the scan is inside the part at 84 of them; 1,198 more had no scan within 50 mm; furthest at (-68.66, -57.4, 109.2) on airbox-tub/F71. S1 is aligned by 4 pairs (rms 0.003 mm, worst 0.005 mm): a distance under that says nothing (tied to no point of the model: not checked against builds).
```

**What the other tools gained.** An end of `measure` (a distance only) may
be `{scan: "S1", point: [x, y, z]}`, a point given in the frame of the
layout, or the number of a region, which stands for its centroid; the reply
is then approximate. `section` with `scan: "S1"` adds the lines the plane
cuts of the scan, dashed on the drawing and at most 2,000 points in the
JSON. `look` with `scanColour: {part: "tub", range: 20}` draws one scan
coloured by its distance to a part, from 0 to `range` mm (20 by default),
with the scan points inside the part marked and the colours named in the
caption; the numbers are `scan_deviation`'s.

**Limits, each said in the reply that meets it.**

- `scan_clash` checks at most 200,000 scan points near the part (beyond
  that every n-th), takes at most 32 of the points it names again on the
  B-rep, tells the 8 largest clusters and gives itself 10 s. `scan_deviation`
  gives itself 10 s too. What was thinned or left undone is in `sampling` and
  in the reading (`the time ran out: 18,000 of the 20,000 asked were
  measured`), and a count that was cut short is never told as a no.
- `scanColour` colours at most 60,000 scan points within the range, in 1.5 s
  at most, and is refused beyond that with `ask for a smaller range`.
- An alignment keeps 64 pairs at most.

**What is refused, and why.** A scan that is not aligned in the layout asked
(`S1 is not aligned in layout assembly (it is aligned in: print), so nothing
is checked against it there`); a part torno moved for display, naming the
layouts that place it as the model does, or `def assembly(p)`, and the parts
it did not move; a part that stood elsewhere when the scan was aligned; a
scan whose mesh is gone, with the path; a scan that is being imported or
converted; a region that no longer fits its scan's mesh.

The session's status follows the hooks Claude Code posts to torno:
`UserPromptSubmit`, `PreToolUse` and `PostToolUse` mean working, `Stop` idle,
`Notification` and `PermissionRequest` needs input.

The first time Claude Code runs in a folder it asks whether you trust the
folder. That question is Claude Code's own, and it is answered in the terminal.

## Files torno writes

Inside a workspace torno writes only under `<object>/.torno/`:

| File | What |
|---|---|
| `.torno/scene.json` | the layout, the layer visibility, the section (`section`: a plane's `origin` and `normal`) and how each scan is looked at (`scans`: switched on, opacity, colours) you last chose |
| `.torno/marks.json` | the marks of the object: yours and the agent's, with their notes, anchors and status; of a dimension also what is expected of it and the value last measured |
| `.torno/scans.json` | the scans of the object: where each source file is and its hash, how it was imported, and its alignment in each layout |
| `.torno/scans/<id>/mesh.bin` | the scan as torno draws and checks it, in millimetres and Z up (`mesh.<n>.bin` once it was converted or imported again). `.torno/scans/.gitignore` keeps the meshes out of git: a clone has the record, and its row offers "Import again" |
| `.torno/scans/<id>/<mark>.mask` | the triangles of a region, a bit each |
| `.torno/session.json` | the id of the conversation to resume |
| `.torno/views/<n>.png` | the pictures and section drawings the agent asked for, the latest 20 |
| `.torno/state.md` | the build, the parts, the scans and the open marks as text, for an agent without torno's tools. Its first line says when it was written: nothing keeps it current once torno has quit |

Add `.torno/` to the workspace's `.gitignore` if you do not want these in git.

Outside the workspace: `~/.config/torno/config.json` holds the workspace last
opened. Claude Code keeps its own records as it always does.

## Tests

```sh
pnpm test          # unit tests of the app (vitest), a few seconds
pnpm test:kernel   # the app against the real Python kernel and a stand-in agent (vitest)
pnpm test:e2e      # the built app in a hidden window (Playwright)
(cd kernel && uv run pytest -q)   # the kernel alone (pytest)
```

No test opens a window, and none runs the real `claude` CLI: a stand-in
(`app/test/fake-agent.mjs`) takes its place. The scans in the tests are made
by the test code; none is in the repository. Those of the window are in
`app/e2e/scan.spec.ts`, `align.spec.ts` and `region.spec.ts`.

## Environment variables

| Variable | Effect |
|---|---|
| `TORNO_WORKSPACE=<path>` | the workspace to open at start, instead of the one remembered. `scripts/torno <path>` sets it. |
| `TORNO_AGENT_CMD=<cmd>` | the command to run for a session instead of `claude`, split on spaces: `TORNO_AGENT_CMD="claude --model sonnet"` |
| `TORNO_BUILD_TIMEOUT=<seconds>` | how long a build may run before it is stopped: 600 by default, a day at most. `TORNO_BUILD_TIMEOUT=1800` for a model that needs up to half an hour. |
| `TORNO_CONFIG=<path>` | the config file to use instead of `~/.config/torno/config.json` |
| `TORNO_DEBUG=1` | print to stderr the workspace opened at start, the address of the MCP server, and the command line and hooks of every session |
| `TORNO_TEST=1` | create the window hidden and never show it; expose the test hooks. For tests only. |

The agent inherits torno's environment without these, and without the variables
a parent Claude Code session exports (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and
the like), so torno can be started from inside one. Variables you set yourself,
such as `CLAUDE_CODE_USE_BEDROCK`, are passed on.

## Next

5. **Show.** Explode, named views, HTML export, adapters for other agent CLIs.

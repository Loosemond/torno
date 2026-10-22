<img src="scripts/torno.svg" alt="" width="80" height="80">

# torno

Torno is a desktop workbench for making CAD parts with an AI coding agent: the
agent writes build123d Python in a terminal inside the window, torno builds the
model every time a file is saved and shows the parts beside the terminal. You
point at the parts to say what you mean, measure them, and hold them to
numbers; the agent is told what you pointed at and has tools to see what you
see.

The window has three columns. On the left, the objects of the folder you
opened, and under them the parts, scans and marks of the open one; the marks
have the room, and the sections above them fold. In the
middle, the parts in 3D, with a bar of views above them and the tools down the
left edge. On the right, the terminal the agent runs in. A line at the bottom
says how the last build went.

Torno is not a modeller. It has no sketcher, no feature tree and no way to edit
a solid by hand. The model is the Python file; torno shows it. It uploads
nothing and publishes nothing. The name is Portuguese for a bench vise, which the
logo is: one holding a part. The design is in
[docs/superpowers/specs/2026-10-08-torno-design.md](docs/superpowers/specs/2026-10-08-torno-design.md).

## Requirements

Linux or macOS. Developed on Arch with Wayland (Hyprland). macOS is tested on GitHub's macOS runners and not yet by eye.

- Node.js 22.12 or later (developed with 26) and pnpm 10
- [uv](https://docs.astral.sh/uv/)
- Python 3.11 or 3.12 (uv fetches one if none is installed)
- Claude Code (`claude`) on `PATH`, logged in (see [What Claude Code is
  given](#what-claude-code-is-given))
- A workspace: a folder of objects, each a subfolder with a Python model in
  it. If the workspace has a `pyproject.toml`, its environment must already
  exist and hold build123d (`uv sync` there once, yourself). Torno runs the
  kernel in that environment with `uv run --no-sync` and never changes it. A
  workspace with no `pyproject.toml` is built with the build123d of torno's
  own kernel environment (`kernel/.venv`, which uv makes the first time it is
  needed).
- Importing a scan needs `trimesh` and `pillow`, which uv fetches the first
  time a scan is imported. The checks against a scan use the `scipy` of the
  workspace's environment, which build123d brings.

Torno checks these when it starts, before anything fails, and says so in a block
called "Ready to work" on the first screen, in a workspace with no object and on
the page of a new object (below): a line for Claude Code, for `uv` when it is
missing, and for the kernel's Python environment. When everything is there the
block is one quiet line ("Claude Code and build123d 0.13.0 are ready"), and a
click opens it. It looks for `claude` and `uv` on the `PATH` torno was started
with. It also runs `claude --version` and `claude auth status`, once at start and
within 3 seconds each (nothing written, nothing of your Claude Code settings
read), to say its version and whether you are signed in, and `uv --version`;
under test it only looks on the `PATH` and never runs `claude`. "Check what torno
needs" in the folder menu opens the same lines in a dialog and asks again
("Check again"). The first time, torno's own Python environment is made by uv and
about 900 MB is fetched, so that first run needs the network; until then the
block says "Not made yet", and "Make it now" makes it (`uv sync` on torno's own
kernel project, never on a workspace) with uv's lines shown as it goes, so that
the first build does not have to. A workspace with its own `pyproject.toml` is
only reported on: whether its `.venv` is there. Torno never makes one.

## Install

```sh
git clone <this repository> torno
cd torno
pnpm install
```

## Run

```sh
scripts/torno ~/objects     # open that folder as the workspace
scripts/torno               # open the workspace opened last, or the first screen
pnpm start [folder]         # the same, from the repository
```

```sh
scripts/torno --print-command [folder]   # the command it would start, one argument a line, the folder first as TORNO_WORKSPACE=…; starts nothing
scripts/torno --print-desktop            # Linux only (macOS: see below). The desktop entry for this copy of torno; writes nothing
scripts/torno --install-desktop          # writes it: ~/.local/share/applications/torno.desktop, and nothing else
scripts/torno --uninstall-desktop        # removes that file
TORNO_OZONE=wayland scripts/torno        # or x11: the platform Electron is told to draw on
```

`scripts/torno` works from any directory, and through a symlink. It installs
the dependencies if `node_modules` is missing, builds the app if it has not
been built since the sources last changed, and starts it. A build that fails
is tried again at the next start. It knows a build by `app/out/.built`, a hash of
what the sources held when its last build that succeeded began: a checkout or a
touch that leaves every source as it was builds nothing, and any change does.
Only the launcher writes it: after a `pnpm build` or a test run of your own on
changed sources, the first start from the launcher builds again (some ten
seconds, written into `app/out`).

With no folder to open, the first screen says what torno is, says what is ready
and what is missing (see Requirements), draws how a folder
of objects is laid out and offers "Open folder" (an empty one is fine) and
"Open the example"; coming back, it lists the folders opened lately first. The
example is four small objects
of the repository's test workspace, copied to a temporary folder. That copy is
removed when torno quits, with whatever was made in it, and the window says so
under the workspace's name for as long as it is open; one that a crash left is
removed at the next start. A folder given to `scripts/torno` is added to the
folders opened lately, as one opened from the window is.

Once a folder is open, the folder button at the top left opens a menu with the
same ways to another: the folders opened lately (one that is not found is
struck and can be removed), "Open folder…" and "Open the example", and "Check what torno needs".

Left alone, Electron chooses whether to draw on Wayland or X11. If the window
does not come up, or comes up wrong, `TORNO_OZONE=wayland` or `TORNO_OZONE=x11`
has the launcher pass `--ozone-platform` for it. Any other value is refused,
`headless` among them: Electron crashes with it here.

On macOS Electron has one platform: `TORNO_OZONE` is checked but then ignored,
with a line on stderr, and `--print-desktop`, `--install-desktop` and
`--uninstall-desktop` write nothing and exit 2 (make `torno.app` with
`pnpm dist:mac` instead). The launcher hashes the sources with `sha256sum` or,
failing that, `shasum -a 256`, which a Mac has.

`--install-desktop` (Linux) writes one file and only when you run it: `torno.desktop`
under `$XDG_DATA_HOME/applications` (`~/.local/share` when that is not set),
after printing the path and the entry. It refuses to run as root. The entry
starts this script, and names its icon, by their whole paths: run it again
after moving the repository. It names no platform: a launcher that should use
one needs `TORNO_OZONE` in the environment it starts programs with. Started
from the entry (`--from-desktop`), what goes wrong is also shown as a desktop
notice (`notify-send`), or, where there is none, written to
`~/.local/state/torno/launcher.log`: nobody reads what a launcher prints.

Only one torno runs at a time. Starting it again brings the window that is
already open to the front and says so on stderr; given a folder, that window
opens it, asking first if a session there is in the middle of its work.

On Linux torno has no menu. The window is closed through the window manager, which
ends torno and the sessions in it. When that would cut something short, torno
asks first, in a dialog over the window ("Close torno?", with "Keep it open" in
focus) that names each object and what would be cut short, as a link to the
object: a session working or waiting for an answer, a prompt written and not
sent, a region painted on a scan and not kept, a scan being imported or an
export being written. With none of that it closes at once. `Ctrl+Q`, `Ctrl+W`, `F11` and
the zoom shortcuts do not exist. For work on torno itself, `pnpm dev` runs the app from
the Vite dev server, where `F5` and `Ctrl+R` reload the window.

On macOS the menu bar is global, so torno has one there: the app menu (About, Hide, Quit), Edit and Window. Copy,
paste, cut, select all and undo (`⌘C`, `⌘V`, `⌘X`, `⌘A`, `⌘Z`) come from the Edit menu, in fields and in the
terminal. `⌘Q` asks first, as closing the window does ("Close torno?" while something would be cut short);
the Dock's Quit and a logout do not ask. There is no Close item, no reload and no zoom. Run from the
repository, the menu bar names the app "Electron" (the bundle of `node_modules/electron`); a packaged app is
"torno". On a Mac torno asks your login shell for its `PATH` at start, so `uv` and `claude` are found when torno
is started from the Finder or the Dock.

On macOS, `pnpm dist:mac` makes `torno.app` in `app/dist/`: `mac-arm64/torno.app` on Apple silicon (and a zip
beside it), `mac/torno.app` on an Intel Mac (`pnpm dist:mac -- --x64`). Copy it to `/Applications` and open it from
the Finder or the Dock. It carries the kernel's source, torno's skills for Claude Code, the icon and the example, and
still needs `uv` and `claude` installed; it finds them through your login shell's `PATH` (above). Its Python environment for
a workspace with no `pyproject.toml` is made at the first build of one, in
`~/Library/Application Support/torno/kernel-env`, and never inside the app. The app is signed ad hoc and not
notarized: one built on your own Mac opens as it is; one that was downloaded (the zip a CI run uploads, say) is
quarantined, so right-click it and choose Open, or run `xattr -dr com.apple.quarantine torno.app`. Updating means
building again. (`pnpm pack:check` builds the same files as a folder on Linux, `app/dist/linux-unpacked`, to check
the packaging with `TORNO_PACKAGED=… pnpm -C app exec playwright test e2e/packaged.spec.ts`; it is no way to install
torno on Linux.)

## Five minutes with torno

This walk-through uses the small models torno is tested with, on a copy, so
nothing of yours is touched. Every step of it was done as written, in a window
that was not shown; step 7 with a stand-in for the agent.

1. Make a workspace from the test models and open it:

   ```sh
   cp -r kernel/tests/fixtures/ws /tmp/torno-tour
   scripts/torno /tmp/torno-tour
   ```

   The window opens on a page of cards, one per object. None has a picture
   yet: a picture is made when an object is built here. Some of these objects
   are there to fail; leave them.

2. Click `hollow`. It is built (a second or two; longer the very first time,
   while uv makes torno's own Python environment, which the status line says:
   "Making torno's Python environment, first time only") and drawn: a tub and its
   lid. Drag to turn it, drag with the right button to pan, scroll to zoom,
   `F` to fit. `1` to `4` are the iso, front, right and top views. The window
   says how the pointer moves the view once, in a line at the foot of the view
   that goes at your first move of the camera, and keeps it, with the keys, in
   the sheet of keys (`?`), where the pointer is the first group. Point at a
   tool in the palette for what it does; with a tool in hand that same line
   says what it waits for next.

3. Press `E`. The lid lifts off the tub: the parts are drawn apart, for
   looking only. Press `E` again to put them together.

4. Press `P` and click the top of the lid. A pin is left there, numbered
   `M1`, and its note opens: type "too thin here" and press Enter. The pin is
   red: it is yours. Press `Esc` to put the Pin tool down.

5. Press `M`, hold the pointer on the top of the lid and press `T`: the wall
   under the pointer is measured by the kernel, exactly, `2 mm`, and stays on
   the part as the dimension `M2`. Click its row in the Marks list and type
   `2` under "Should be", then Enter: the row says `Passes`. Type `3`
   instead and it says `Fails: 1 under`, and the line at the bottom counts it
   (`1 dimension fails`). Enter gave the keys back to the view: press `Esc` to
   put the tool down.

6. Press `X`. A plane cuts the parts in half at once, open towards you, so
   that you see the post inside the tub; a bar appears under the view. Drag
   the arrow on the plane, or use the arrow keys, to move it. "Off" in the bar
   takes the cut away, and `Esc` puts the tool down.

7. In the pane on the right, press "New session". With Claude Code, type
   "what did I mark?" and press Enter: your two marks go with the prompt, as
   text: the face, the point, your note, the measured value and whether it
   passes. From then on they show as sent. The agent can ask torno for a
   picture (`look`), a measurement (`measure`) and a cut (`section`), and it
   edits `hollow/hollow.py`; every save is built and drawn.

8. Under the bar of views, "+ Save view" keeps how you are looking at the
   part under a name. "Export…" at the bottom right (or `Ctrl+Shift+E`)
   writes one HTML file that someone without torno can open: it needs
   nothing else.

9. Press `?` for every key, and `W` for the page of objects. Then open your
   own folder with the folder button at the top left.

To clean up: close torno and `rm -r /tmp/torno-tour`. Torno wrote only in
`/tmp/torno-tour/hollow/.torno/`.

## Objects and builds

A folder is an object when it holds a `.py` file; dotfiles and `__init__.py`
do not count, and folders whose names start with `.` or `_`, and `common`,
`tests` and `out`, are never objects. The model is the one `.py` file that is
not a test (`test_*.py`, `*_test.py`, `conftest.py`). Of several, it is the one
named after the folder, with `-` and `_` taken as the same:
`helmet-stand/helmet_stand.py`. Once an object is open, torno keeps building
the model it chose for as long as that file exists. A folder where no model
can be chosen, or a model with none of the forms below, is listed with the
reason it cannot be built.

With an object open in a folder of several, the list of objects is folded to one row, the
switcher: the open object's name, and "All objects `W`" beside the title. A click on the name,
or `Enter`, opens a menu of every object (a dot for a session that works or waits, the reason
under one that cannot be built) with "New object" at its foot; the arrows, `Home` and `End`
move in it, `Enter` opens one, `Esc` puts it away. When a session of another object waits for
you, the switcher has its dot and says so ("bracket needs you"). The "Objects" title unfolds the
whole list in place. With no object open, or the page of objects up, the list is whole.

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

**Builds.** Saving a file in the object's folder (dotfiles, `out/`, `cache/`,
`.torno/` and `__pycache__/` are ignored, as are `build/`, `dist/`,
`node_modules/`, `.venv/` and `.git/`) or in the workspace's `common/` starts
a build 300 ms later. Saving a `.py` file during a build cancels that build
and starts another. Any other file changing during a build may be the model's
own doing, so the build is left to finish and one more follows it. A build
that runs longer than 600 s is stopped; `TORNO_BUILD_TIMEOUT` sets another
limit. The line at the bottom says building with the seconds elapsed, built
with the time it took and the revision (`r3`), or failed. A failed build keeps
the last good parts on screen, and its status opens the error with the
traceback.

**A failed fillet or chamfer.** build123d and OpenCascade say only that a fillet
or a chamfer could not be made, naming neither the edges nor the radius. When a
build fails inside one, the kernel tries it again in parts before it reports the
failure, for 5 s at most (less when the build's own limit is nearer, and it says
when it ran out): each edge alone at the radius asked; if each works alone, the
pairs, those that share a face first; and the largest radius that works for all
of them, and for each edge that fails alone, to 0.001 mm. The error says it
under its message, such as `fillet R6 of 8 edges: each works alone; 4 pairs of
adjacent edges fail (edges 4-5, 4-6, 5-7, 6-7: 12 mm apart, two R6 need more);
the 8 together work up to R5.999`, then a line for each edge of the failures.
The shape being filleted is not a part on screen, so its edges are numbered by
their place in the call, from 0, and their ends are in its own frame (`local`);
one that is exactly an edge of one part of the last good build (its ends, its
length and the points along it) is also named by that ref, as of that build. Nothing is retried in the model. The agent is told the same with
the result of its edit and in `scene`, and can try a fillet on the last good
build with `try_fillet` before it edits the model again.

**The window.** On the left, the list of objects, then the layers, the parameters and the scans of the
open object, then its marks. Objects, Layers, Parameters and Scans each fold by their title; folded, the
title says what matters (`Layers 12 · 3 hidden`, `Scans 1 · unaligned`). Marks never folds:
it keeps room for five rows at least, and the sections above give way first. Drag the line
above Marks up for more (`Up` and `Down` with it in focus), double click it for the shares
again. What is folded and where the line is are kept by the window, not in the folder. The
layers (parts) of the open object each have a visibility switch. Parameters lists the fields of
the model's `Params` (folded to its title at first; a model with none has no section): each
field's name, its default in the monospace face (four digits at most, the whole value on hover) and
its comment as the model has it, and, for a default the model works out (an expression, not a
number written in), that it is worked out in the model. It is read only: torno never writes
the model. With a session running, a click on a row puts `Params.wall` in its prompt at the
cursor, never sent, so you can write "make Params.wall 2.4" around it; with no session the rows say
to start one. A model that says which of its parts belong together (an optional
`groups(p)` beside `assembly`, group name to part names) has them listed under a
header each, which folds the group, hides or shows all of it, or, on "Show only",
shows that group alone in the layout; ask the agent to group parts and it edits
`groups(p)`. In the viewport, drag to orbit, drag with the right or
middle button to pan, scroll to zoom; a triad in the bottom left corner shows which way X
(red), Y (green) and Z (blue) run in the object's own frame, as the agent's pictures
do, and in the bottom right corner are a scale bar (orthographic) or the step of the grid,
`grid 5 mm` (perspective); the bar at the top switches layout
(`assembly`, `print`), view and projection. The folder button (top left)
opens a menu of the folders opened lately (the open one marked "current"),
"Open folder…" and the example; opening another ends the sessions of this one,
so torno asks first, in a dialog that names the objects, if one of them is
working or waiting for an answer. A folder that cannot be opened is said under
the folder's name, and the workspace stays as it was.

"Rebuild", in the line at the bottom beside how the build stands, builds the
open object again from its sources as they are (`Ctrl+Shift+B` from anywhere).
It is always there, and it is the main button when the last build failed for a
reason outside the model (the build took too long, stopped, or was cancelled) or
was let go to make room: building the same sources again may work. After an error
in the model it stays quiet, since the same sources give the same error. While a
build runs it reads "Building…" and takes no press: that build is of the sources
as they are.

"Build failed" opens the error: what happened in words ("Python error in the
model", "The build took too long (timeout)", "The build process stopped
(crash)"), the message, why a fillet or a chamfer failed, the traceback and what
the model printed. It says who is told: Claude Code is told this with your next
prompt, or was told after its own edit, so there is no need to paste it into the
chat. "Ask Claude Code to fix it" puts a short request in the message box, opens
the session pane if it was away, and never sends it: you read it and press Enter.
With no session running it reads "Start a session to fix it" and starts one with
the request waiting in its box. After a failure outside the model "Rebuild" is the
main button of the sheet instead. "Copy" takes the whole error as text. The line
above the box of the chat says "build failed" among what goes with the next prompt.

A part the build says is broken (not valid, inside out, not closed, or with a
mesh that disagrees with its volume) has the word beside its name in the
layers, with every defect it has in its tooltip, and the line at the bottom
counts such parts ("1 part has a defect"). The agent is told the same after its
edit (What the agent is told).

The pointer is told what it is on: a face (`lid/F12`), or an edge within reach
of it (`lid/E3`), with a line from the kernel on what that is, such as
`plane, normal +Z, z = 20, 1180 mm²`. Hidden parts are never picked. While the
parts on screen are older than the model (a build is running, or the last one
failed) nothing is picked, and the pointer says why.

### Making a new object

"New object" starts one from what you have. It is at the foot of the list of objects (of the switcher's menu when the list is folded), in the header of the page
of objects and in its empty state: a folder with no object in it leads with "Make your first object", "New object" and,
where torno runs from its repository, "open the example to look around". The way for models you already have (a folder
such as `part/part.py`, and the note on `pyproject.toml` and `uv`) is in a fold, "Already have build123d models?". The page asks for a name and "What is it?" (what it is for, what it must fit or
hold, sizes you know, how it will be made), and then for what you have, each with a note for Claude:

- **Photos** ("Add photos…", or dropped on the page): PNG, JPEG or WebP, at most 12, 25 MB each and 50 megapixels
  (a larger picture is refused with a reason on the card, before it is decoded). HEIC, the iPhone's default, is
  not read: set the phone to Most compatible, or export as JPEG. Claude gets each one attached to its first prompt, after a line naming it ("Picture 1: reference/photo-1.jpg"),
  scaled to 1280 px on its long edge; the original is copied to `reference/photo-<n>.<ext>` in the object.
- **Doodles** ("Draw…"): up to 6, drawn on a board (below). Claude gets each as a PNG with dark ink on white,
  whichever theme you drew it in, and `reference/` keeps it.
- **Scans** ("Add a scan…", or dropped): up to 4. They are imported into the object as "Import scan…" does, not
  copied and not aligned; Claude is told each scan's file name and id, and that it is not aligned (you align it in
  torno); `brief.md` keeps the path it came from, with `~` for your home folder.
- **Other objects** (a menu of the objects of the workspace): up to 8. Claude is told to look in `../<name>/` and
  gets the object's summary (its parts and box, with whether the kernel says it is exact; "not built in this run"
  if it has not been built) and its thumbnail.

At most 6 pictures go with the prompt, photos and doodles first, then the thumbnails of other objects; a picture
beyond that, or one that fails the checks (PNG or JPEG, 2000 px at most, 3.75 MB, so that it is under 5 MB as
the API takes it; a PNG over that is sent as a JPEG), is named in the prompt as not attached, with the file in `reference/` to read. Notes are kept to a line each and the description to 20,000
characters.

The name is the folder's and its model's: letters, digits, `-` and `_` (no dots), starting with a letter or digit, at
most 64 characters, and not one that is there already (compared without regard to case, and `a-b` is `a_b`). Torno
refuses a name that would stand in for a library (`json`, `typing`, `numpy`, `build123d`, any module of Python's
standard library), since a model's folder leads the import path and its file would be imported in the library's
place; also Python keywords, the workspace's own `common`, `tests`, `out` and `docs`, `tools`, `reference`, and a
name whose model file would be taken for a test (`test_*`, `*_test`). The page says why while you type.

"Create" writes one new folder in the workspace and nothing else: `<name>/<module>.py` (a placeholder, a 20 mm
cube, to be replaced), `brief.md` (your words and a line for each reference with its note) and `reference/`. The
`.torno/` folder is made as for any object. It is made in a hidden temporary folder beside it and renamed into
place as the last step, so it is whole or not there, and it never goes into or over a folder that exists (an
empty one of that name is used). A temporary folder a crash left is swept away at the next opening of the
workspace once it is ten minutes old, unless it holds files in `reference/` (your doodles may be nowhere else):
such a leftover, a hidden `.<name>.torno-new-<hex>` folder in the workspace, is yours to look at and delete. Then torno opens the object, imports the scans, starts Claude Code in a
chat and sends one prompt with everything. The prompt asks Claude to list the sizes that decide fit or function and
say where each comes from (your words, a note, a scan, another object, or nowhere), and to ask you for those that come
from nowhere in one round (a card in the chat, at most four questions, each with a typical value among its options;
"build with assumptions" is an answer) before it builds. What it builds without an answer is marked "assumed" in the
model, and its reply lists those. If Claude Code cannot start (the command is not found, or the
trust question stands, or the CLI starts and leaves at once because it is signed out or too old), the object is made
and open anyway: the pane says why and the text of the prompt waits in the message box for you to send. Where
torno already knows Claude Code is not found or not signed in, the page says so above "Create", before the folder is made. The
pictures are not sent then: the text says each is "not attached" and names the file in `reference/` (and the
`.torno/thumb.png` of another object) for Claude to read. If the object was made but the workspace does not list it,
the scans were not imported, and the page says so and where the folder is. While "Creating…" shows, `Esc`, Cancel
and Discard do nothing.

While the page is up the window is about the object being made: no object of the list is selected (folded, the
list reads "New object"), the Marks
section gives way, and the status line says "New object" with the build123d version alone. The session pane says
what Claude Code will start with once you create the object (the name, whether you said what it is, and how many
photos, doodles, scans and objects you gave), filled in as you go. A session of the object that was open that is
still running stays as it is, a question waiting in it included, under a note saying whose it is: it goes on, and
the new object gets its own. Cancel or `Esc` brings everything back as it was.

The doodle board (the same board as the chat's "Draw on view") has a thin pen, a thick pen and an eraser, "Undo" and `Ctrl+Z`, "Clear", and "Done" and "Cancel".
`Esc` puts the board away; if strokes were drawn since it was opened it asks "Discard this doodle?" first. A
doodle can be opened again from its card and changed.

What you have entered is a draft, kept while the window lives: you can leave the page, open another object and
come back. `Esc` on the page leaves it, asking first when something is in it; so does leaving the workspace, and so
does closing the window ("A new object is set up here and not made yet"). Nothing of the draft is written until
"Create".

## The agent

Each object has its own session: Claude Code running in the object's folder.
It opens in a chat, a pane of torno's own, or in a terminal when you switch to
it. It keeps running while another object is shown. A session that works or
that waits for your answer (a permission, a question, a plan) says so wherever
you are, not only in its own pane. In the list of objects its row has a dot
after the name: a quiet one while it works, and, in the warning colour with the
words "needs you", while it waits. Folded, the list's one row has the dot of any
session of the folder that works or waits, and names the object of one that
waits ("bracket needs you"); its menu has a dot on each row as the list does. Nothing is shown for a session that is idle
or ended. When the session pane is hidden, its button has the same dot for the
open object's session. And when any session of the folder waits for you, the
status line has a button "*bracket* needs you" (with "and N more" if several do,
the first in the list named): it opens that object, shows the pane and takes you
to the card. If the window is not the one in use when a session starts to wait,
its frame flashes (the dock icon bounces on a Mac), once for each question; torno
posts no system notification. "New session"
starts one, in place of the session running there, if any; torno asks first if
that one is in the middle of its work. "End" ends the session and starts
none, asking first in the same way. "Resume" continues the last
conversation Claude Code had there. ``Ctrl+` `` moves between the session and
the viewport. In a terminal `Shift+Enter` is a new line, `Ctrl+Shift+C` and
`Ctrl+Shift+V` copy and paste.

### The chat

The chat is your own `claude`, under your own login, started in its headless
mode (JSON on pipes instead of a screen). Torno draws what it says and does;
nothing of Claude Code's settings is read or changed (torno lists the paths and sizes of the instruction files Claude Code reads, never their text). `Enter` sends, `Shift+Enter`
is a new line, and a prompt sent while the agent is at work waits its turn
("Queued"; "Stop" interrupts the turn, and what was queued still runs after it).

- **What torno added.** Under each prompt, a "torno added" line shows what went
  with it: the marks sent, as chips in their colours, the build (`r12 ok`, or
  `build after r12 failed`), and the selection; "Show text" opens the exact text the agent was given. Above the
  box, "Goes with your next prompt" says what will go.
- **The build an edit started.** When the agent edits the model, the build that
  follows is a line of its own under the edit's card: `Built r2 · ok · 1.2 s`,
  or `Build after r2 failed: NameError: name 'WAL' is not defined` in the fail
  colour (the last line of the traceback), with "Show error" opening the sheet of that
  failure while it is the latest build. Under it, the dimensions whose verdict
  that build changed (`M3 now passes`, `M2 now fails`) and the parts it changed,
  a line each as the kernel said them (`tub: volume 14710 → 20460 mm³ (+5752, +39
  %)`, with `≈` where the number is not exact), four at most. "Show text" opens
  the exact text the agent was given. A revision names a build that worked: a
  failure has no number of its own, and is told as the build after the one still
  on show (the first build, when none has worked), in the window and in what
  the agent is told. Once a build has failed, the chip of the build still on
  show opens the same sheet.
- **What the agent pulled from torno.** Every tool of torno's it calls is a card
  of its own, with its input, its result and its pictures as thumbnails that
  open large; the turn ends with a line such as "Pulled from torno: scene, 2
  pictures, measure ×3". Other tools are one line each, opened for their input
  and result.
- **Refs are live.** `M4`, `lid/F12` and `lid/E3` in the agent's text and in
  the cards are chips: hovering one lights it in the view, clicking a mark
  focuses it, clicking a face or an edge selects it. A ref that names nothing
  now (a mark that is gone, a part not shown) says why and does nothing. What is
no ref of this object is only text: an `M3` clearance hole when the object has
no mark `M3`, a build `r9` that has not been made, a part the build does not have.
- **When it asks.** A permission is a card in the conversation: "Allow",
  "Allow for this session" (offered when Claude Code suggests a rule; the rule
  holds for this session only and is never written to any settings file) and
  "Deny", with a reason if you give one. A change to a file (`Edit`, `MultiEdit`)
  is shown as lines removed (struck through, with a "−") and lines added (with a
  "+"), the first six of them and "Show all"; the same lines are in its tool card
  when you open it. They are the lines of the edit, not of the file: where in the
  file it lands is not shown (the card says so), and an edit that replaces every
  match says that. A text of more than 400 differing lines is not compared: all
  its old lines are shown removed and all the new ones added. A `Write` shows the first lines of what it will hold. A question of the agent's is a card with
  its options and an "Other" line; a plan is shown to be approved or kept
  planning. The session reads "Needs input" while a card is open. "Stop" with a
  card open ends the turn and the card reads "Cancelled: the turn was stopped";
  nothing is run.
- **Subagents.** What a subagent (`Task`) says is not drawn as the agent's own
  words: its card counts the steps it took ("12 steps") and, opened, lists the
  tools it used.
- **"Attach view"** adds a picture of the viewport as you see it to the next
  prompt only. Pressed, it shows a small picture of the view as it is now above
  the box, with "Remove", beside the drawing's row when there is one; the
  picture that goes with the prompt is the one shown, whatever the view does
  meanwhile.
- **"Draw on view"** opens a board over a picture of the view: the very picture
  the agent's `look` makes of it, with the axes, the scale bar and the marks
  numbered. Draw on it as on the doodle board (two pens, an eraser that takes
  away only your ink, "Undo" and `Ctrl+Z`, "Clear"); the ink is magenta, edged
  with a thin line, which no mark is drawn in. "Done" puts the drawing above the
  box, with "Edit" and "Remove", and the box has the keys again, for the prompt
  it goes with; it goes with your next prompt only. The row says what the ink
  lies over, before anything is sent: `Over tub/F3, tub/F1, the cut face of lid
  · stroke 1 partly over no part · stroke 2 over no part`, the refs as chips that light their face in the view
  when the pointer is on them. If the view moved while you drew, it says in
  amber that this was not worked out, with "Draw again"; if the model has been
  built again since, it says the faces are of the build you drew on. The prompt,
  once sent, shows the same line under its picture. Claude
  Code gets the picture with your ink, and before it a caption torno writes: that
  the strokes are your drawing, which build it was drawn on, the camera it was
  seen from (so that it can `look` from there again), and stroke by stroke the
  faces of the parts, the cut faces of a section ("the cut face of lid") and the
  scans your ink lies over, by ref with the kernel's line for each face
  (`lid/F12 (plane, normal +Z, z = 20, 1180 mm²)`). No
  coordinate is taken from the drawing. If the view moved while you drew (the
  agent's `show`, a build), the caption says what lies under the ink was not
  worked out; if the model was built again before you sent it, it says the refs
  are of the build you drew on. The terminal view has no "Draw on view". The
  picture is never written to disk; the line of what it lies over, refs only, is
  text in the chat's log like the rest of the prompt.
- **What Claude Code says of itself.** torno reads the account the CLI gives at
  the start of a turn and says what a person would miss: a warning when torno's
  tools did not connect, with what the CLI said; a warning when torno's skills
  did not load, with "Restart with the whole prompt" above the box, which ends the session and
  goes on with the same conversation told in the prompt what the skills would say; a quiet
  line, once a session, when the chat is billed to an API key (it says
  what Claude Code names as its source) and when the CLI is older than 2.1.300 or of a
  newer minor than 2.1.x (torno was checked with 2.1.300 and 2.1.301; any other 2.1 is quiet). While the API is being retried the status
  at the top reads "Working, retrying (attempt 3)". A permission the CLI
  refused by itself, with no card to show it, is one warning at the end of the
  turn. When the CLI says a turn could not authenticate (it marks its answer
  `authentication_failed`, as it would should `claude -p` stop reading your
  login), a warning says the chat could not use your login, once a session, with
  "Use the terminal", which runs this object's sessions in Claude Code's own
  terminal, the conversation going on there. A field the CLI does not print is not a warning. Nothing of your settings is read.
- **`/` commands.** Typing `/` offers the commands Claude Code has; `Up` and
  `Down` choose, `Tab` completes, `Esc` closes the list. `/compact` leaves one
  note with the tokens before and after. What you type is sent to Claude Code as
  typed; `/model` is not one of the commands torno has checked in the chat, so
  use the model menu for the model of the session.
- **The model** is chosen in the menu under the header. It changes the model of
  this session only; `/model` typed in a terminal session changes your default
  (see below). A line under the box shows the rate limit once more than half of
  it is used.

"Chat · Terminal" under the header switches the same conversation between the
two: the session is ended (torno asks first if it is busy) and started again,
resuming it. With no session it sets what the next one will be; the choice is
kept in `.torno/agent.json`. What the chat showed is kept as text in
`.torno/chat/`, and a resumed conversation shows it under "Earlier in this
conversation"; pictures are never written. The photos and doodles you gave when
you made the object are shown again from `reference/`, by the name the log
keeps (one you have since deleted says `reference/doodle-1.png is no longer
there`); a picture a tool gave says "Picture of an earlier build, not kept",
and any other "Picture not kept".

### What Claude Code is given

Torno runs Claude Code, and changes nothing of its settings: everything it
gives it is on the command line, in the environment, or in a file of torno's
own that holds no secret. It reads none of its settings either. Of the
instruction files Claude Code reads on its own, it lists the paths and sizes
(next paragraphs) and never their text.

- Torno's tools: `--mcp-config` (the path of a file under torno's own data
  folder that names torno's MCP server), `--allowedTools mcp__torno__*`.
- The session's token: `TORNO_SESSION` in the environment, which Claude Code
  sends in the `X-Torno-Session` header of every request to torno. It is never
  on the command line (see "Limits and exactness").
- Torno's instructions: `--append-system-prompt`, and torno's skills with
  `--plugin-dir`. They give the loop: after an edit, numbers first
  (`measure`, `check`, `section`, `diff`), then one look with the marks drawn.
- Hooks: `--settings`; it posts them to torno, which follows its status by
  them (idle, working, needs input, ended) and adds to its prompts.
- What you marked goes with your next prompt, by itself, and counts as sent
  once the prompt's hook has been answered with it.
- The instruction files Claude Code reads for the object are listed in the
  session pane, in a quiet line under the view's buttons ("Claude Code also
  reads, by default, `~/objects/CLAUDE.md` 7 KB"), for the chat and for the terminal. It is
  what Claude Code loads by default when it starts in the object's folder:
  `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the folder and in
  every folder above it, `.claude/rules/` there (one entry: the folder, "up to"
  how many `.md` files, their size: a rule that names `paths` in its frontmatter
  loads only when matching files are used, which torno cannot tell without
  reading it), your own `~/.claude/CLAUDE.md` and
  `~/.claude/rules/`, and an organisation's file (`/etc/claude-code/CLAUDE.md`
  on Linux, `/Library/Application Support/ClaudeCode/CLAUDE.md` on a Mac). An
  `AGENTS.md` or `.claude/AGENTS.md` is listed only when none of the first
  three is in the folder or above it, as Claude Code reads it only then. Only
  paths and sizes are looked at, never a file's text, and a link is listed by
  its own name and not followed. A name is a button that shows the file in its
  folder in your file manager. It is a list of what Claude Code reads by
  default: `@path` imports, files of subfolders (which it loads when it works
  there) and the settings that leave files out (`claudeMdExcludes`,
  `--setting-sources`, "Project instructions") are not followed. The first
  prompt of every session, and the first after `/clear` (when Claude Code loads
  the files again), says the same to the agent, with the paths and sizes (a
  "torno added" line also says how many, without opening it),
  and that what torno's tools say of the build is current: a `CLAUDE.md` that
  names another viewer, report or export step is about another way of working,
  so its advice on how to model stands and its way of seeing the build does not.

`.torno/agent.json` keeps the view, chat or terminal, with `"agent":
"claude"`. A file that names another agent is not followed: Claude Code is
used, in the chat, and the pane says so, with "Use Claude Code" to write the
file anew. One that names Copilot CLI, which torno also ran until 16 October
2026, says that torno no longer supports it. The `.torno/prompt.md` and
`.torno/agent/` such sessions left are neither read nor removed.

Claude Code is also given torno's skills, a plugin that comes with torno
(`app/resources/agent-plugin`) and is loaded for that session only, with
`--plugin-dir`: nothing is installed in your Claude Code. A skill costs a line
until the agent decides to read it. `torno:torno-model` is the model file
contract in full (which file, `Params`, `assembly`, `printables`, `make_<part>`)
with a template; `torno:build123d` the idioms of build123d 0.13, the failures
that leave a valid but wrong part (a boolean that lost volume, an edge taken from
an older shape), the usual OCCT errors (fillets, booleans, `StdFail_NotDone`; of a
failed fillet, to read why and try one with `try_fillet` before editing again), an
API reference of build123d 0.13.0 that the agent searches offline in any
workspace, and the sizes of screw, nut and insert holes (`bd_warehouse` is not in
torno's kernel); `torno:scans` and `torno:dimensions` what the
instructions would otherwise say of scans and of dimensions. So Claude Code's
instructions are shorter: they keep what torno is, refs, marks, the loop and
the model file in short, and name the skills.

Claude Code is also given a subagent, `torno-reviewer`, on its command line
(`--agents`; nothing is written to `.claude/agents/`). It has only the tools
that read (`scene`, `look`, `marks`, `measure`, `check`, `section`,
`describe`, and `Read`), checks the current build against what you asked,
every open mark and every dimension, and reports what holds and what does not
with numbers from `measure`. It changes nothing. Claude Code is told to call
it after a change of several steps, before saying it is done.

The status follows the hooks Claude Code posts: `UserPromptSubmit`,
`PreToolUse` and `PostToolUse` mean working, `Stop` idle, `PermissionRequest`
and a `Notification` that asks something needs input. A `Notification` that
only says Claude Code has been waiting at its prompt for a while (or has
signed in) leaves the status as it was. In a terminal, the first time Claude
Code runs in a folder it asks whether you trust the folder; that question is its
own, and it is answered there. Run headless, as the chat runs it, Claude Code
skips that question, so torno asks instead: before the first chat in an object
whose folder, or a folder above it up to your home, has settings Claude Code
would load (`.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`),
the pane names those files and asks "Start the chat anyway?". "Start the chat"
remembers the folder (its real path, in torno's own data beside the recent folders,
never in the workspace) and does not ask again, whatever those files later say;
"Use the terminal" starts Claude Code in the terminal view, which asks its own
question. Your own `~/.claude` is never one of the settings files looked at for it.

`/model` typed in a terminal session of torno's changes the model of that
session and also your default for every Claude Code session from then on:
Claude Code writes it to `~/.claude/settings.json`, torno's or not. The model
menu of the chat does not; nor does starting torno with
`TORNO_AGENT_CMD="claude --model sonnet"`, which saves nothing.

### What the agent is told

With every prompt, a few lines:

```
[torno] bracket · build ok · r3 (1.2 s) · layout assembly · parts: base, post.
Scans: S1 Micra.glb, aligned in print by 4 pairs (RMS 2.1 mm, worst 3.4 mm), shown at 60 %.
Selected: base/F5 (plane, normal +Z, z = 2.5, 1200 mm²), base/E5 (line, 30 mm)
Marks from the user (drawn in look pictures with these numbers):
M3 pin on the edge lid/E40 between lid/F12 and lid/F40 (line, 40 mm) at (12, 40.5, 20): "this edge is ugly"
M4 thickness 8 mm wall, along the normal, plate/F2 at (30, 0, -10) (expected 10 ± 0.05: FAIL, 2 under)
Dimensions (measured on r3):
M1 distance 6 mm between planes, plate/F2 to plate/F4 (expected 8 ± 0.05: FAIL, 2 under)
1 pinned dimension passes
Open marks: M2 (moved), M6 (unchecked)
```

- The first line is the build: for a failed build it carries the error; for
  an object that is not the one open in the window it says so, and names no
  layout; with the parts drawn apart it says `exploded 40 % along z (display
  only)` after the layout.
- `Scans` is there when the object has scans, and `Selected` when you have
  faces or edges selected and the parts on screen are those of the last build
  (eight refs at most).
- Each mark you left since the last prompt has a line, once: it then shows as
  sent. A mark you changed or put somewhere else is told again, as `(changed)
  M3 …`; one you reopened as `(reopened by the user)`. A dimension that is
  still a draft is told here with its value and verdict.
- `Dimensions` lists, with every prompt, each dimension the agent was sent
  that fails, is not measurable or was not measured on the last build, and how
  many pass. The head names the build the values are of, and says so while a
  newer build is running or has failed, so that a FAIL of the build before is
  not read as a verdict on the edit. A line stays until its dimension passes
  or is resolved.
- `Open marks` are the numbers of the marks still open, each with what the
  last build did to it. After `/clear`, the first prompt of the new
  conversation lists your open marks once more.
- The first prompt of a new conversation (a session that was not resumed, or
  after `/clear`) ends with a line naming the files in `reference/` (twelve at
  most, then how many more), to read when they matter.
- The first prompt of every session, resumed or not, and the first after
  `/clear`, ends with a line naming the instruction files Claude Code reads
  there by default (six at most, with their sizes;
  see "What Claude Code is given") and saying which wins for seeing the build:
  torno's tools. It is under "Show text" in "torno added". Nothing is said when
  there are none.

When Claude Code has edited the model, the answer to that edit says how the
build ended, the same first lines and the dimensions. Between them, of a build
that worked, torno says what the build did to the parts and what is wrong with
them, which it checks at every build from the numbers the kernel worked out of
the shape:

```
[torno] tub · build ok · r8 (0.9 s) · layout assembly · parts: tub, lid.
Changed since r7: tub: volume 28400 → 26100 mm³ (-2300, -8.1 %), faces 14 → 22, solids 1 → 2; 1 part unchanged.
Check: tub is 2 solids (was 1); the face or edge numbers of tub may name others now (describe refs again).
Dimensions (measured on r8):
M4 thickness 2 mm wall, along the normal, tub/F2 at (30, 0, -10) (expected 3 ± 0.05: FAIL, 1 under)
```

- `Changed since` is each part whose volume, size, place, face, edge or solid
  count changed since the last good build, in the words of `diff`, with `≈`
  where either build's number is not exact; the parts that did not change are
  counted. A number that is not exact (a freeform part's volume or box) may
  differ in its last digits from one build to the next: it counts as changed
  only by more than the kernel says each build's is in doubt.
- `Check` names a part that is not valid (OCC's check finds a defect), one with
  a solid inside out, one with no solid, one of more than one solid or of
  another number of them than before, one with an open shell, one whose mesh
  encloses another volume than its own (by more than the mesh explains), a part
  that came or went, the parts whose refs may now name other faces, and a
  dimension that passed on the build before and fails now. With nothing to name
  it says so. A change of volume is told, never judged: torno cannot know
  whether a pocket was meant.
- At most 1,200 characters, cut by whole parts, with what was left out counted
  and the tool to read it with. The first build of a run has only `Check`.
- A part that is not valid, has a solid inside out, came apart into more solids
  or has a mesh that disagrees with it, where the build the turn began with did
  not, holds Claude Code back once when it would stop, if the turn caused that
  build (see below): it is asked
  to mend the model or to say why that is meant. A change of volume alone never
  does.
- The chat shows it under the edit's card (the build line: the parts that
  changed, the dimensions that changed verdict), the whole text behind "Show text",
  and `state.md` carries it under the build. It is not told with a prompt.

When Claude Code would stop, torno holds it back for what the turn itself did:
once for each reason, and twice in a turn at most. Every reason is for a build
the turn caused: one that began after the turn first
changed a source, by an edit of a `.py` of the object or a Bash command after
which one is newer. The first build of an object you have just opened, a save of
yours in your own editor before the agent's first edit, and any build in a turn
that changed no source are told to the agent as ever but never hold it back. It
first waits, up to twenty seconds, for such a build that is still running and
for the dimensions to be measured. Then, by the first that applies:

1. The build is still running. It is asked to read the result with `scene` and
   to look.
2. The build after the one on show failed (`The build after r7 failed: ...`), and
   it is asked to fix it or say it is still broken.
3. A part has a defect the build the turn began with had not (above).
4. A dimension that passed on the build the turn began with fails on the latest:
   `M4 passed on r7 and fails on r9 (6 mm, expected 8 ± 0.05). Fix it, or say
   why it must change.` A dimension that already failed when the turn began
   never holds it back; the agent may rightly stop to ask about it.
5. A build the turn caused ended after its last `look`: `r9 was built during
   this turn, and you have not looked at it since.` This is however the file was
   written, by the agent's editing tool or through Bash. A
   `look` by the reviewer counts. When nothing in the parts changed since the
   turn began (a comment, a rename: every part is the same shape, by the
   kernel's hash of it, in the same place), there is nothing to look at and it
   does not hold. A volume, size and count that stayed as they were do not
   say so: a hole moved is another shape.

A reason already held is not waited for again: a `Stop` after one that was held for a running build
does not wait again.

A hold for a defect or a dimension that finds the build unlooked says so too, and
counts for both. A hold is said to the agent and changes no status.

The answer waits for the dimensions to be measured on the new build, ten
seconds at most, and ends with what the model printed: `Model printed (last 2 lines):` and the end of it, fifteen
lines and a thousand characters at most, with a note when earlier output was
cut, and nothing when the model printed nothing. It is the output of the
build that ended last, failed or good, and build123d's own warnings are in it.
So a `print()` in the model is how the agent sees a value, since it may not run
the model itself; `scene` gives the same as `output`. `state.md` does not
carry what the model printed.

`.torno/state.md` says the same as text, for an agent without torno's tools:
the build, the layouts and parts, the saved views, the scans and every open
mark. Its first line says when it was written: nothing keeps it current once
torno has quit.

### Tools

Torno's MCP server (on `127.0.0.1`, a port of its own choosing, answering only
requests that carry the token of the object's session) gives the
agent of an object these tools for that object. They answer from the last
build that worked, say which revision that is, and say so when a newer build
is running or has failed. A tool given a key it does not take is refused,
naming the keys it takes.

The tools that only read (`scene`, `look`, `marks`, `describe`, `measure`, `section`, `check`, `diff`,
`try_fillet`, `scans`, `scan_clash`, `scan_deviation`) say so, and Claude Code may call several at once. The server also tells Claude
Code at the start, in a few lines, what each tool is for. Claude Code's tool search keeps an MCP server's tools out
of the model's sight until it searches for them; five are loaded from the start because nearly every turn uses
them: `scene`, `look`, `marks`, `describe` and `measure`. The others are found by that search.

| Tool | What it gives |
|---|---|
| `mcp__torno__scene` | The build status and error, what the model printed in the last build (`output`), the layouts, every part with its size, bounding box, volume and whether it is visible, the model's groups of parts, your camera, section and explode, the saved views, the scans, and how many dimensions pass, fail and are not measured. It notes when the parts of the print layout were spread along X. |
| `mcp__torno__look` | A picture from the renderer you are looking at, with the marks drawn. With no arguments it is your view, cut by your section or drawn apart as you have it. It takes `view` (`iso`, `front`, `back`, `left`, `right`, `top`, `bottom`, the name of a saved view, or a camera), `layout`, `parts`, `size` (long edge, 1280 by default, 2000 at most), `marks` (false leaves them out), `section` (`'current'`, `null`, or a plane), `explode` (0 to 1, or `{amount, axis, scale}`; `null` together), `scans`, `scanColour` and `frame`. With `focus` (a ref such as `lid/F12` or `lid/E3`, a part, a group, a mark such as `M4`, or a box `{min, max}` in mm) and `margin` (a share of the box, 0.3 by default) it frames a detail up close: from the side `view` names (`front`, `iso`, …; without one, the way your camera looks), at the picture's whole resolution, with the parts drawn together. The caption says what was drawn, and, with a focus, what was framed and when the middle of it is hidden behind other parts. Also saved under `.torno/views/`. |
| `mcp__torno__marks` | Your marks and the agent's as data, each with a line of text. |
| `mcp__torno__describe` | The geometry of a part, a face or an edge (`lid`, `lid/F12`, `lid/E3`), or of a group of parts by its name: the box of its parts and their volume. |
| `mcp__torno__highlight` | Tints faces or edges in your viewport with a note, to ask "this one?", until you click or a minute passes. A group's name tints all of its parts. |
| `mcp__torno__show` | Changes your camera, layout, visible parts (a group's name stands for its parts), section, explode and scans to show you something, or puts a saved view on screen by its name; with `focus` and `margin`, as `look` takes them, it puts your camera on a ref, a mark or a box. For now only: what `.torno/scene.json` keeps stays yours. Refused while you hold a button in the viewport. |
| `mcp__torno__save_view` | Proposes a saved view: it appears in your strip marked "proposed" until you keep or discard it. Nothing on screen changes. |
| `mcp__torno__add_mark` | Leaves a mark of the agent's, in green: a pin, a pick, an arrow, a shape, or with `kind: 'dimension'` a dimension, measured at once and on every build like yours. A point that is not on the part is refused, saying how far off it is. |
| `mcp__torno__resolve_mark` | Resolves a mark with a line on what was done, which you then confirm or reopen. A dimension of yours with an expected value is refused: it is your check, and only you resolve it. |
| `mcp__torno__measure` | An exact number from the geometry. See [Measuring and dimensions](#measuring-and-dimensions). |
| `mcp__torno__section` | The outlines a plane cuts of the parts, with their areas, and a 2D drawing of the cut. See [Section](#section). |
| `mcp__torno__check` | Whether two parts overlap, how far apart they are, whether a part's mesh is closed, and whether it prints: overhangs, thin walls, the fit on a bed. |
| `mcp__torno__diff` | What changed between the last two successful builds (or the two revisions given as `from` and `to`): for each layout the parts added and removed, and for each part its volume (and its change in percent), box size and min corner before and after, with whether each is exact, and its face, edge and solid counts, a hint that refs may name other faces now. The answer to an edit gives the same of each part that changed. Only the last two builds are kept. |
| `mcp__torno__try_fillet` | Tries a fillet (or a chamfer, `kind: 'chamfer'`) of `radius` mm of some edges of a part (`part`, `edges` as refs such as `lid/E3`) on the last good build and throws it away: whether it works, and when it does not, the edges that fail alone or in pairs and the largest radius that works, as a failed build's error says it. It changes nothing. |
| `mcp__torno__scans` | The scans of the object and how each is aligned. |
| `mcp__torno__scan_clash` | What of a scan is inside a part. |
| `mcp__torno__scan_deviation` | How far a part lies from a scan. |

There is no tool that exports, imports or aligns a scan, or writes a file:
those are yours.

### Prompts

The same server offers requests that come up again and again as MCP prompts.
Claude Code lists them as slash commands, and the chat's command menu shows
them when you type `/`:

| Command | What it asks the agent |
|---|---|
| `/mcp__torno__review` | Go through every open mark and every unmet dimension against the current build: measure, look, and resolve the marks that are done. |
| `/mcp__torno__printable` | Check the `print` layout for 3D printing: thin walls, overhangs, closed meshes, and whether it fits your bed, given as an argument (`/mcp__torno__printable 256x256x256`, in mm). |
| `/mcp__torno__explain` | Describe the model for someone new to it: its parts, its `Params` and how the parts relate. |

## Marks

The tools, each with its key (all keys are under [Keys](#keys)):

| Key | Tool | What it does |
|---|---|---|
| `V` | Select | Click selects a face or an edge, Shift-click adds or takes out, `Esc` clears. "Insert" puts the selected refs in the session's prompt without sending it; "Note" leaves a mark on each. |
| `P` | Pin | Click a part: a pin there, and its note opens beside it. A pin on an edge is a pin on that edge: the pointer snaps to an edge within reach, and the agent is told which edge it is and the two faces that meet there. |
| `A` | Arrow | Drag from a part: an arrow of that length. With Shift it runs along the surface normal or a principal axis. |
| `D` | Draw | Press and draw. On a locked view (an orthographic front, back, left, right, top or bottom, not turned since; a padlock shows on its button) the stroke is a profile in millimetres on the plane that faces you. On any other view it lies on the surface. Alt-drag turns the camera with this tool in hand. |
| `S` | Shape | Click places a box, cylinder, sphere or plane, to add, remove, keep out or refer to. A gizmo moves it (`G`), turns it (`R`) or sizes it (`T`), and its row has the exact numbers. |
| `X` | Section | Cuts the parts by a plane. See [Section](#section). |
| `M` | Measure | Measures; `Enter` keeps a dimension. See [Measuring and dimensions](#measuring-and-dimensions). |
| `L`, `B` | Align scan, Region of a scan | See [Scans](#scans). |

`Esc` drops what is being dragged, then puts the tool down for Select. In a
note, `Enter` saves and `Esc` leaves it for later. A note is also kept when
you leave it any other way, such as ``Ctrl+` `` to the terminal: what you
typed goes with the prompt you type next.

Every mark has a number (`M1`, `M2`, never reused), a note, and a row in the
Marks list. Yours are drawn in red, the agent's in green. A mark is a **draft**
until it has been carried to the agent (see [Choosing an agent](#choosing-an-agent)),
then **sent**, then **resolved** by you or by the agent, with a line on what
was done. Clicking a row makes its mark the active one and opens the row; the
camera goes to the view the mark was placed from only when the mark is out of
view, and the reticle at the end of the row ("Go to its view") always goes
there. The pointer on a row, or the keys' focus in it, rings the mark's chip in the view, more faintly than the
active one's, and lights the face it is on, as a mention of it in the chat
does.

The chips in the view answer the pointer too. On a chip the pointer is a hand,
the mark's row lights, and its note is read out beside the pointer on one line
(`M1 too thin here`; for a dimension its numbers, `M3 40 mm, expected 42 ±
0.05, 2 under`). A click on a chip makes its mark the active one and brings
its row into view, opened, without moving the camera; for a mark of yours not
yet sent, its note opens beside it to be written. A click on a chip is the
chip's whatever tool is in hand: no pin is left under it. A drag that starts on
a chip turns the camera, as anywhere else.

- A mark you change after it was sent (its note, or a shape's place, size,
  kind or intent) is a draft again, and is told once more as `(changed)`.
- The Marks list is grouped: **To send**, **With the agent**, **To review**,
  then **Resolved**, folded. The active row shows its note whole.
- A mark the agent resolves does not vanish: "To review" says "The agent
  resolved 2 marks." **Review** opens each, saying "Resolved by the agent"
  with the agent's line, with **OK** (it goes under "Resolved") and
  **Reopen** (it is a draft again); **OK all** says you have seen them all.
- A mark on a part that is switched off in the layers is not drawn, in the
  window or in the agent's pictures; its row stays and says "its part is
  hidden".
- After every build each mark is checked against the new geometry. It stays
  at its point; its ref is refreshed to the face now there. When the surface
  has moved away from it the row says "moved: check it", and when its part is
  gone, "its part is gone"; the agent is told the same. Such a pin, pick or
  arrow of yours offers **Re-place**: the next click on a part puts that mark
  there, with its number and note.
- In a `print` layout that torno spread along X, a mark moves with its part
  when a part that grew pushes it along: it stays where you put it on the
  part.
- When a check cannot be made (the kernel did not answer in time), the marks
  it was about keep what the last check found and say "not checked against
  r12", in their rows and wherever the agent reads them. Torno tries again
  after 2, 10 and 30 seconds, and at the next build.

## Measuring and dimensions

Lengths are millimetres, angles degrees, areas mm², volumes mm³ and masses
grams; Z is up.

**The Measure tool** (`M`). A strip in the corner of the viewport chooses what
two clicks measure (Distance or Angle) and what a double click on a hole, a
cylinder or a circular edge measures (Diameter or Radius). `T` has no button:
with the pointer on a face it measures the wall there, from that point along
the inward normal to where the part ends. With Shift a click is a bare point,
tied to no face. While the second click is pending the pointer reads out an
estimate from the mesh, marked `≈`. What is measured is never that: torno asks the
kernel, which measures on the exact geometry and says how (`6 mm between
planes`, `axis to axis`, `point to plane`, `minimum`). A distance between two
parallel flat faces is the distance between their planes, between two
cylinders or circles with parallel axes the distance between the axes, and of
anything else the least distance. An angle is between flat faces, straight
edges and the axes of cylinders, cones, tori and circles (`between axes` of two
bores, `axis to plane` of a bore and a face); a face that is flat, or an edge
that is straight, within 1e-6 mm but stored as a spline or an extrusion is
taken too, and its angle is not said to be exact. Before the second click of an
angle the pointer says, in place of the estimate, when an end is taken by its
axis (no estimate from the mesh), only if it is flat or straight (a spline),
or not at all (a sphere); the click is sent all the same. When the kernel
refuses (an angle to a sphere), its reason is read out at the
pointer. `Esc` drops a first click; the tool stays in hand.

**A measurement leaves nothing.** The kernel's value is read out at the pointer
and stays in the strip as `Last: 6 mm between planes` until the next
measurement, `Esc` with nothing under way, another tool, a new build or another
object. It is no mark, and the agent is not told of it: not with the next
prompt, not in `state.md`, not in a picture. To keep it, press `Enter` or
"Keep as a dimension" in the strip: it becomes a dimension, measured again by
main as it is kept, and the strip says `Kept as M4`.

**Dimensions.** What you keep of a measurement is a dimension: a mark (`M4`)
with a value, drawn on the part and listed with the marks. Its row, once
clicked, shows the value, how it was taken, and under "Should be" two fields:
what is expected (`=`) and the tolerance (`±`), in mm or degrees. With an
expected value the dimension is a check: it passes when the value is within
the tolerance of it (0.05 mm, or 0.1° for an angle, when you give none) and
fails otherwise, and the row says `Passes` or `Fails: 2 under`. A failing one
is ringed on the part and in the agent's pictures, its chip saying by how much
it misses after the cross (`40 mm ✗ 2 under`), and the line at the bottom
counts those that fail and those with no value.

- Once sent, its row says **pinned**: it is one of the checks the agent is
  told about with every prompt until it passes. Changing what is expected or
  the tolerance makes it a draft again, sent as `(changed)`.
- A **resolved** dimension is no longer measured. A dimension of yours that
  has an expected value is yours alone to resolve.
- After every build, every dimension that is not resolved is measured again
  on the new geometry, once its ends have been checked against it. Until then
  its row shows the old value greyed and says `not measured on r12: this is
  what it was on r11`, with no verdict. In a new run of torno every dimension
  is measured at the first build.
- An end the build moved away from is measured from the face that is under it
  now, and the dimension says `measured from what is under its ends now` (to
  the agent: `[moved since it was placed: check it]`).
- A dimension is **not measurable** when the part of an end is gone, when the
  kernel refuses it on the new geometry (the hole is no longer round), or when
  an end that was put on an **edge** is no longer on that edge: an edge is the
  edge of that number, and its end counts as on it while the edge is within
  0.5 mm of the point, or the nearest point of the part is on that very edge
  and within `max(0.5 mm, 0.5 % of the diagonal of the part's box)`. A face is
  found again under the point, so for a check that must hold across edits,
  click faces, not edges.
- A dimension is not put somewhere else as a pin is: delete it and measure
  again.

**`measure`** (the agent's) takes `kind`, `a`, for a distance or an angle `b`,
for a mass `density`, and `layout`. An end is a ref (`lid/F12`, `lid/E3`, or a
whole part where the kind takes one), the number of a mark (`M3`: what it is
on, only if the last build's check confirmed it; a dimension is refused, with
a line that says to name its end), `{point: [x, y, z]}`, or `{ref, point}`. Each reply is JSON with a `reading`: the
answer in one line.

| `kind` | Of | Reply |
|---|---|---|
| `distance` | `a` and `b` | mm, the two `points` it is between, and `how` |
| `angle` | `a` and `b` | degrees: between the outward normals of two flat faces (0 to 180), or between two straight edges or axes, or a straight edge or axis and a flat face (0 to 90); the axis of a cylinder, cone, torus or circle is taken as a line, and a face flat or an edge straight within 1e-6 mm as a plane or a line, not exact |
| `radius`, `diameter` | a cylindrical, spherical or toroidal face, or a circular edge | mm |
| `thickness` | a face of a solid, at a point of it (the centre of the face when none is given) | mm, along the inward normal to where the part ends; `moved` says how far the point was from the face before it was laid on it |
| `bbox` | a part, a face or an edge | `min`, `max`, `size` |
| `area` | a part or a face | mm² |
| `volume` | a part that is a solid | mm³ |
| `mass` | a part that is a solid | grams, with the `density` used (g/cm³; 1.24, PLA, when none is given, and the reply says so) |

**`check`** takes `kind`, `a`, for two parts `b`, and `layout`; `a` and `b`
are names of whole parts. `overhang`, `thin` and `bed` ask whether it prints:
they are of the `print` layout when the model has one and no other is named.

| `kind` | Reply |
|---|---|
| `overlap` | the `volume` two solid parts share, in mm³, and the box it lies in |
| `clearance` | the least `distance` between two parts and the `points` it is between; 0 when they touch, and when they overlap, which `overlapping: true` then says |
| `mesh` | whether the mesh the part is drawn and exported with is closed (`watertight`), its `triangles`, the number of `openEdges` and where up to 20 of them are |
| `overhang` | with `angle` (degrees from vertical, 45 when none is given): the `faces` of `a` that face down steeper than that, each a `ref` (`tray/F7`) with its `area` and `steepest` lean, and their whole `area`; faces on the bed are left out. Planes are exact; a curved face is judged by its normals at sampled points and is not |
| `thin` | with `min` (mm): the `faces` of `a` where the wall, measured along the inward normal at sampled points of each face, is under `min`, with the `thinnest` of each and of the part; always approximate, and `sampling` says what was measured |
| `bed` | with `size` ([x, y, z] mm), no part: whether the layout's box `fits` the bed, its `size`, and by how much it is `over` along each axis; exact only when every part's box is |

What is exact, what is approximate and what is refused is under
[Limits and exactness](#limits-and-exactness).

## Section

`X` cuts at once when nothing is cut yet: a plane through the middle of the
parts, across the axis you look most along, open towards you (the half taken
away is the one on your side). A bar appears at the bottom of the viewport: X,
Y and Z put the plane across that axis, again open towards you, "From face" puts it on the
next flat face you click, the slider and the number beside it say how far
along its normal the plane is from the middle of the parts, "Flip" takes away
the other side and "Off" shows the parts whole again. What is on the side the
plane's arrow points to is not drawn. Each solid part is closed where it is cut, in its
own colour a step darker; a part that is not a closed solid (a scan, an open
shell) is cut open. Drag the arrow on the plane to move it; a drag anywhere
else turns the camera. The arrow keys move it by 1 mm, with Shift by 0.1 mm.
On a cut face there is nothing of the model to pick, and the pointer says so;
a mark on what was cut away stays, drawn faint. The bar stays while there is a
section, whichever tool is in hand, and the section is kept with the object.
The pictures the agent takes are cut the same way.

**`section`** (the agent's) takes `plane`, and optionally `parts`, `layout`,
`size`, `deflection` and `scan`. A plane is `{origin, normal}`, or `{axis: 'x'
| 'y' | 'z', at}`, or `'current'` for your own section. The reply has, for
each part, the outlines the plane cuts of it as closed loops of `[u, v]`
points in mm along the plane's own axes, each loop's `area` (negative round a
hole), the part's `area`, how many loops are `open`, and the extent of the
whole cut. The outlines come from the exact geometry, as polylines within
0.01 mm of it, or within the `deflection` asked for (0.005 to 0.05 mm). A
reply holds at most 1,500 points: beyond that the loops are thinned, and say
so. Areas are the kernel's, of the true outlines, whatever was thinned.
With it comes a 2D drawing of the cut on a millimetre grid, each part in its
colour, with what is up in the world up on the page. To see the cut in 3D the
agent calls `look` with a `section`.

## Scans

A scan is a mesh of the real thing or of where the part goes: an engine bay,
a room, a machine, taken with a phone or a scanner. Torno draws it with the
parts, so that you and the agent can check the model against it. It is good to
a few millimetres at best and shows only what the camera saw. **Nothing taken
from a scan is exact**, and torno never says that it is.

**Importing.** "Import scan…" in the Scans panel, or a file dropped on the
view: GLB, glTF, OBJ, PLY or STL, with faces (a point cloud is refused). The
file is only read. Torno keeps its path, size, date and hash, and makes one
mesh of it in millimetres and Z up under `.torno/scans/`, baking a texture
into colours at the vertices. The scan goes on working from that mesh when the
file moves or is deleted (its row then says "source missing" or "source
changed"); when the mesh is gone too, the row offers "Import again". A scan of
more than 2,000,000 triangles is reduced to that many, and its row says from
how many.

**Units.** glTF is read as metres and Y up; the others as millimetres, or
metres when the whole is under 20 units across, with Y up for OBJ and Z up
otherwise. Right after an import in the window, when either was assumed, a
short sheet at the top of the Scans panel asks once: `How is S1 read?`, with the
unit and the up axis and the size the scan would have read so (`Its size would
be 120 × 120 × 0 mm`); the scan is drawn in the view meanwhile. "Keep" says the
guess is right, "Apply" reads it as chosen, "Later" puts the question away. Until
it is answered the row has a dot after the name, and its detail says the size and
what was assumed (`120 × 120 × 0 mm, from m, Z up (assumed)`) and asks
`Read as metres, Z up: right?` with "Yes" and the unit and axis under it.
Changing either drops the scan's alignments, which torno says before it does it.

**The Scans panel.** Each scan (`S1`, `S2`, never reused) has a row of one
line, built like a layer's: its id, its name (whole, with the path of its source,
in the tooltip), how it stands in the layout on screen in one word (its sentence
in the tooltip), an opacity slider when pointed at, and a switch. The arrow at
the end, or a click on the name, opens its detail beneath it, one scan at a time:
its size and how it was read, how it stands in a sentence, what it rests on,
"Frame" (bring it into view: `F` and the views frame the parts only), "Align",
"Rename" (its name in torno: Enter keeps it, Esc leaves it), the unit and up
axis, its colours, and "Remove". A scan drawn solid hides what is
behind it and takes the pointer; one drawn see-through lets you point at the
part behind it. The section cuts a scan open like the parts.

**Aligning** (`L`). A scan is aligned in one layout at a time; in a layout
where it is not, its row says `unaligned` and nothing is checked
against it. The bar at the bottom of the viewport has three ways, which can
follow one another:

- **Floor.** Click a flat patch of the scan (`[` and `]` change its size), or
  three points with Shift. "Ground" lays it at a height, "On a face" on the
  flat face of the model you click next; "Flip" turns it the other way up. A
  floor says how the scan lies, not where on that floor it is.
- **Pairs.** Click a point on the scan, then the same point on the model, or
  type the model point. The bar says which end of which pair it asks for
  (`Tab` switches which is asked first). From three pairs that are not in a
  line the scan is drawn where they put it, with how far each pair is left
  apart and the RMS of all. Nothing is kept until "Apply". When the fit says
  the scan is some 10, 25.4 or 1000 times off, the bar says which unit that
  looks like and offers to read the scan as that.
- **Nudge.** Handles to move (`G`) and turn (`R`) the scan, and fields for
  where its origin is and how it is turned.

"Undo" puts back the alignment before the last one, "Clear" takes it away.
What the row then says of the scan is what the agent is told of it:

| Row | Meaning |
|---|---|
| `aligned` | Tied to points of the model and checked against the last build. Its detail says what it rests on: `4 pairs, RMS 2.1 mm` is a fit of pairs and how well they fitted (the RMS is of the points you clicked, not of the scan); `…, then moved by hand` is a fit or a floor moved afterwards. |
| `placed` | Tied to no point of the model: placed by the handles or typed values (`by hand`), laid on the ground (`floor only`), or pairs whose model ends were typed. No build can say whether it still holds, so none is checked. |
| `pending` | Nothing is built in this run yet, or the last build has not been compared with the alignment yet. Torno never builds the model again by itself to make that check. |
| `check` | The model has moved since: a point you clicked on a part is no longer on it, torno spreads a part otherwise, or the scan was imported again from a changed file. Align again, or press "Still right" in the detail. |
| `rough` | Fewer than three pairs, pairs almost in a line, or pairs left more than 5 mm apart. Torno asks before it keeps one. |
| `unaligned` | Not aligned in the layout on screen. |
| `missing` | Its mesh is gone from the disk; the detail offers "Import again". |

After every build torno looks for the model points of each alignment on their
parts again. It tells what it finds; it never moves a scan by itself. A scan
aligned in another layout offers "Use this alignment in *layout*": it is put
where it stands there, as a start, and kept as placed by hand.

**Regions** (`B`). Drag over a scan to paint a part of it: a brush whose
radius is in the bar (`[`, `]`), "Erase" (`E`, or Ctrl held), "Box"
(Shift-drag), "Grow to flat", "Undo" (`Z`), "Clear". What is seen is what is
painted: the brush takes nothing behind a part, nor of what a section has cut
away. "Keep" (`Enter`) makes it a mark with a number and a note, such as
"wiring loom, can be pushed aside": it is how you tell the agent what a part of
the scan is. A painting waits until you keep or clear it, whatever tool or
object you go to meanwhile. "Edit" on a region's row takes it in hand again.
Removing a scan leaves its regions as marks that say their scan is gone.

**The scan tools.** The agent cannot import or align a scan: you do. It can
ask about one. Every reply names the revision, the layout and how the scan is
aligned there, has `exact: false`, and a `reading` whose numbers follow a `≈`
and which opens with whatever puts the alignment in doubt. Lengths taken from
a scan are told to 0.1 mm.

- **`scans`** lists them: name, source, triangles, size, unit and up axis and
  whether they were assumed, whether it is on screen, its regions and its
  alignment.
- **`scan_clash`** takes `part`, and optionally `scan`, `margin` (0 to 50 mm,
  5 by default), `ignore` (region marks to leave out) and `layout`. It counts
  the scan's vertices inside the part, in clusters with the deepest point of
  each, and the scan's triangles that cross the part's surface. It gives no
  volume: a scan is an open surface. It reads, for a flat sheet stood 0.8 mm
  inside a plate: `≈ 2,157 scan points inside the part in 1 cluster, deepest
  0.8 mm at (8, 0.8, 58) under stand/F2; 298 scan triangles cross its surface`,
  after `S1 was placed by hand: no fit says how well.`
- **`scan_deviation`** takes `part`, and optionally `faces`, `from` (`part`,
  the default: from points of the part to the scan; `scan`: from the scan's
  vertices to the part), `region`, `within` (0.1 to 200 mm, 50 by default),
  `samples` (100 to 20,000), `scan` and `layout`. It gives the least, median,
  mean and greatest distance and percentiles of the points that have the other
  within `within`, the worst place, and how many had nothing within reach.
- `measure` takes `{scan: "S1", point: [x, y, z]}` or the number of a region
  as an end of a distance (then approximate); `section` with `scan: "S1"` adds
  the lines the plane cuts of the scan; `look` with `scanColour: {part: "tub",
  range: 20}` colours one scan by its distance to a part.

Limits, each said in the reply that meets it: `scan_clash` checks at most
200,000 scan points near the part and tells the 8 largest clusters; both
checks give themselves 10 s, and a count that was cut short is never told as a
no; `scanColour` colours at most 60,000 points; an alignment keeps 64 pairs.
Refused, with the way out: a scan that is not aligned in the layout asked; a
part torno moved for display (see [Limits and exactness](#limits-and-exactness));
a scan whose mesh is gone or that is being imported; a region that no longer
fits its scan's mesh.

## Explode and saved views

**Explode.** `E`, or "Explode" in the bar of views, draws the parts of the
layout apart; a bar under the views has the slider, the direction (from the
centre, or along X, Y or Z) and the distance (×0.5 to ×4). It is for display
only: the parts are where they were built, and every pick, ref and number is
of the parts as assembled.

- While the parts are apart nothing is marked, measured or cut: Pin, Arrow,
  Draw, Shape, Measure, Section, Align and Region take no click, and the
  pointer says `The parts are drawn apart: put them together (E, or the slider
  at 0) to mark, measure or cut`. Select still works, and what it picks is the
  true point.
- A mark is drawn with its part. A dimension between two parts is drawn
  dashed between them and keeps its value. Scans and the grid stay where they
  are.
- A section is never drawn exploded. Making a cut puts the parts together;
  while there is a section the slider says `Take the section away to draw the
  parts apart`.
- The camera stays where it is, unless a part drawn apart would leave the
  view or go under the bars at its top: then the parts are framed anew, and
  put together again they are seen from where they were before, if you have
  not moved the camera meanwhile.
- An object of one part has nothing to draw apart, and the bar says so; parts
  that share a centre need an axis.
- The agent's `look` and `show` take `explode`; a picture drawn apart says so
  in its caption. Every other tool answers of the parts as built.

**Saved views.** "+ Save view" in the strip under the bars keeps what is on
screen under a name: the camera, the layout, which parts are switched off, the
section or the explode (never both), and how each scan is shown. A click on a
chip brings it back; the chip's menu renames it, updates it to what is on
screen, or deletes it. A name is 1 to 40 characters and not that of a standard
view. An object keeps 24 views; the strip shows six and the rest behind
"*n* more". Applying a view changes no geometry and no mark and starts no
build. What a view names that is gone (a part, a layout, a scan) is passed
over and said on its chip.

The agent sees the views in `scene`, draws one with `look {"view": "Web
cut"}` whatever is on your screen, puts one on screen with `show`, and
proposes its own with `save_view`: a dashed chip that says "proposed", with
"Keep" and "Discard". A proposal is the agent's until you keep it; it can
replace its own proposals (12 at most) and never a view of yours.

## The page of objects

`W`, or "All objects" at the top of the list (beside its title once an object is open), shows every object of the folder
as a card; a workspace of several objects starts there. `/` or a letter
filters by name, the arrows move, `Enter` opens, `Esc` goes back. A card has:

- **A picture** of the object's last build as you last looked at it (its
  layout, the parts switched on, its section or explode), 480 × 360, without
  marks or scans. It is made when a build lands in torno and kept in
  `.torno/thumb.png`. No build is ever started for a picture: an object that
  was never built in torno says `No picture yet`. The card says when the
  picture was made, what it leaves out (`cut by its section`), and `A source
  has changed since` when a `.py` file of the object or of `common/` is newer.
- **How the build stands**, for an object opened in this run: `Built, r6`,
  building, or failed, with the picture of the last build that worked dimmed.
  Otherwise `Not opened in this run`.
- **Marks and dimensions**: how many marks are open and how many are not sent
  yet; how many dimensions fail and pass. Of an object not opened in this run
  there is no verdict, only `1 dimension failed as of its last run`.
- **The session**, if one runs.

Looking at the page builds nothing, opens nothing and writes nothing.

## Export

"Export…" in the line at the bottom (the open object), in the head of the page
of objects (any of them), on a card, or `Ctrl+Shift+E`, writes **one HTML
file** for someone who has no torno, or a **STEP, STL or 3MF** file of one
object (below). It is made from the last build of this run, so an object must
have been opened first. Nothing is uploaded: the file goes where the save
dialog says, which opens in `.torno/exports/`.

The sheet lists what would go, with counts and the size, and what is ticked is
what is in the file:

| In the file | |
|---|---|
| always | the parts of every layout, in their colours; the explode kept for each layout; the views you saved or kept |
| only when ticked | marks and their notes (drafts go with them, and the sheet says how many); resolved marks; parts that are switched off; each scan, by its own tick, reduced to at most 60,000 triangles |
| never | where anything is on this computer; the model's source; what a model printed; the session with the agent; `state.md`; a view the agent proposed and you did not keep; what was painted on a scan |

The page opens from `file://` with the network off: its script, style and
fonts are inside it, and its policy lets it load and send nothing. It has the
parts with a switch each, the layouts, an explode slider, a section (parts are
drawn open, without cut faces), the saved and the standard views, the marks as
labels and a list with each dimension as torno measured it, and light and
dark. It measures nothing and says so. With several objects, each is unpacked
when it is first shown.

A part costs about 10 bytes a triangle on top of 0.7 MB for the page itself:
an object of one part and 12,000 triangles in two layouts is 1 MB. Over 12 MB
the largest scan is reduced further, then left out, and the sheet says so;
above 64 MB nothing is written. The file is written whole or not at all, and a
name without `.html` gets it.

### STEP, STL and 3MF

The sheet's format buttons write a file of the model instead, of one object:

| Format | What is in it | Layout unless you pick another |
|---|---|---|
| STEP | the exact shape, each part a named body in its colour | `assembly` |
| STL | one part, as triangles | `print` |
| 3MF | a plate: each part a named object in its colour | `print` |

Every file is in millimetres, with the parts where the layout has them: a
plate's parts are where torno set them apart, as on screen. You tick the parts
that go; an STL or a 3MF is of solids alone. A part of several solids is, in a
3MF, one object made of a mesh of each; an STL of solids that touch is refused,
saying to fuse them in the model or export 3MF. Their triangles are made for the
file, not taken from the screen: none further than the tolerance from the
faces (0.01 mm unless you type another, 0.001 to 1 mm), nor turning more than
the angle (5°, 0.5 to 45°). A tolerance that would make more than 500,000
triangles is refused before anything is made: past that the kernel could not
make the file in the time it has.

The kernel makes the file from the last build, and torno writes it beside the
name you chose. Before the file takes that name, the kernel reads it back and
checks it:

- **STEP**: the same parts by name, each with as many solids, a volume within
  a millionth of the model's, and the same box.
- **STL and 3MF**: each object closed (every edge of two triangles, wound
  one way), no triangle without area, in as many pieces as the part has
  shells, facing out, its box the part's, and its volume within what the
  tolerance can cut off the model's.

A file that fails is not saved, and the sheet says why. One that passes is
named, and the sheet says what was checked: `Checked: 3MF, 2 objects, 184,220
triangles, closed, volume within 0.04 % of the model`. Checked, not printed. A
3MF can be opened once saved in the program your system opens 3MF files with,
your slicer, when "Open it once saved" is ticked.

## Keys

`?` shows this table in the window, and searches it. Above the keys the sheet lists
the pointer, which has no keys:

<!-- pointer: generated from POINTER in app/src/shared/pointer.ts; `TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts` writes it -->
| Pointer | What it does |
|---|---|
| Drag | Turn the view; with Arrow or Draw in hand, a drag that starts on the part draws instead |
| Right drag | Pan the view (a middle drag does too) |
| Scroll | Zoom, towards the pointer |
| Double click | With Measure in hand: measure something round, its diameter or its radius |
<!-- pointer: end -->

Point at a tool of the palette and a panel beside it says, at once, what the tool does and its key. With a
tool in hand (not Select) a quiet line at the foot of the view says what the tool waits for next: for Measure
`click the first end`, then `click the second end`; for Arrow `press on the part and drag to where it should go`.
Region of a scan and Align scan, with no scan in the object, are drawn quieter and say `Import a scan first`.
The line that tells how the pointer moves the view shows the first time an object is drawn in this install,
until the camera is first moved; the window remembers that in its own storage, never in a workspace.

<!-- keys: generated from cheatSheet() in app/src/shared/keys.ts; `TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts` writes it -->
| Where | Keys | What it does |
|---|---|---|
| Everywhere | `?` | This sheet of keys, outside a field and the terminal |
| Everywhere | `` Ctrl+` `` | To the session, and from it back to the view |
| Everywhere | `Ctrl+Shift+E` | Export to one HTML file, or to STEP, STL or 3MF: the open object, or from the page of objects any of them |
| Everywhere | `Ctrl+Shift+B` | Rebuild: build the open object again, as the button in the status line does |
| Viewport | `V` | Select: click a face, an edge or a part |
| Viewport | `M` | Measure: two clicks, or a double click on a round thing; nothing is kept unless you keep it |
| Viewport | `X` | Section: cut the parts by a plane |
| Viewport | `P` | Pin: click a point and leave a note |
| Viewport | `A` | Arrow: drag from a point |
| Viewport | `D` | Draw: a stroke on the surface, or on a locked view |
| Viewport | `S` | Shape: place a box, a cylinder, a sphere or a plane |
| Viewport | `B` | Region of a scan: paint what something is |
| Viewport | `L` | Align scan: stand a scan where the model is |
| Viewport | `1` `2` `3` `4` | Iso, front, right and top view |
| Viewport | `F` | Fit the parts in view |
| Viewport | `O` | Perspective or orthographic |
| Viewport | `E` | Draw the parts apart, or together again |
| Viewport | `W` | All objects of the folder, on one page (there a letter filters them by name) |
| Viewport | `Esc` | Step back: what is under way, then the tool in hand, then the selection |
| With a tool in hand | `T` | Measure: the wall under the pointer |
| With a tool in hand | `Enter` | Measure: keep the last measurement as a dimension |
| With a tool in hand | `Left` `Right` `Up` `Down` | Section: move the plane by 1 mm |
| With a tool in hand | `Shift+Left` `Shift+Right` `Shift+Up` `Shift+Down` | Section: move the plane by 0.1 mm |
| With a tool in hand | `Tab` | Align, pairs: which end is asked for first |
| With a tool in hand | `Backspace` | Align, pairs: take the last end back |
| With a tool in hand | `[` `]` | Align, floor: a smaller or larger patch |
| With a tool in hand | `G` `R` | Align, by hand: move or turn the scan |
| With a tool in hand | `[` `]` | Region: a smaller or larger brush |
| With a tool in hand | `E` | Region: paint or rub out |
| With a tool in hand | `Z` | Region: undo the last stroke |
| With a tool in hand | `Enter` | Region: keep what is painted |
| With a shape in hand | `G` `R` `T` | Move, rotate or size the shape with its handles |
| Page of objects | `Left` `Right` `Up` `Down` `Home` `End` | Move among the cards |
| Page of objects | `Enter` | Open the card in focus |
| Page of objects | `/` | Filter by name: a letter or a figure does too |
| Page of objects | `Esc` | Clear the filter, then back to the open object |
| Page of objects | `Enter` | In the filter: open the first card |
| Page of objects | `Down` | In the filter: down to the cards |
| New object | `Esc` | Leave the page, asking first when something is in it; on the doodle board, put the board away |
| Session | `Shift+Enter` | A new line in the prompt, not a send |
| Session | `Ctrl+Shift+C` | Copy what is selected in the terminal |
| Session | `Ctrl+Shift+V` | Paste into the terminal |
| Session | `Enter` | Chat: send the prompt |
| Session | `Shift+Enter` | Chat: a new line in the prompt, not a send |
| Session | `Up` `Down` | Chat: choose among the / commands offered while one is typed |
| Session | `Tab` | Chat: complete the / command chosen |
| Session | `Esc` | Chat: put away a picture shown large |
| Session | `Left` `Right` | On the edge of the session pane: wider or narrower |
| In a field, a menu or a sheet | `Enter` | Field: keep what was typed |
| In a field, a menu or a sheet | `Esc` | Field: leave it as it was |
| In a field, a menu or a sheet | `Shift+Enter` | Note: a new line |
| In a field, a menu or a sheet | `Down` `Right` | Menu: the next item |
| In a field, a menu or a sheet | `Up` `Left` | Menu: the one before |
| In a field, a menu or a sheet | `Home` `End` | Menu: the first or the last |
| In a field, a menu or a sheet | `Esc` `Tab` | Menu: close it |
| In a field, a menu or a sheet | `Up` `Down` | On the line above the marks: more room for them, or less |
| In a field, a menu or a sheet | `Esc` | Sheet or question: put it away |
| In a field, a menu or a sheet | `Ctrl+Z` | Drawing board (a doodle, or a drawing on the view): undo the last stroke |
| For working on torno | `F12` `Ctrl+Shift+I` | Developer tools |
<!-- keys: end -->

A tool in hand is offered a key before the viewport is. `F12` and
`Ctrl+Shift+I` open the developer tools whenever torno runs from the
repository.

## Files torno writes

Inside a workspace torno writes only under `<object>/.torno/`, with one exception: "Create" on the page of a new
object (see "Making a new object") writes the new object's folder, `<name>/<module>.py`, `brief.md` and `reference/`.
Those are the object's own, in git like its model, and torno never writes into them again. It writes under `.torno/` only when
that is a real folder inside the object: where a link or a file is in its
place (a workspace copied from elsewhere may hold one) torno writes nothing
there, and says so once in the Marks panel, until a real folder is put in its
place.

| File | What | In git |
|---|---|---|
| `scene.json` | how you last looked at the object: the layout, the layer visibility, the section, the explode of each layout, how each scan is shown, and the saved views (`views`) | travels with the object |
| `marks.json` | the marks of the object: yours and the agent's, with their notes, anchors and status; of a dimension also what is expected of it and the value last measured | travels |
| `scans.json` | the scans of the object: where each source file is and its hash, how it was imported, and its alignment in each layout | travels |
| `scans/<id>/mesh.bin`, `<mark>.mask` | the scan as torno draws and checks it, and the triangles of each region | the meshes are ignored (`scans/.gitignore`): a clone has the record, and the row offers "Import again" |
| `agent.json` | whether Claude Code is shown as a chat or a terminal; without it, in a chat | travels |
| `chat/<conversation>.jsonl` | what a chat session said and did, as text; no picture data, no address (a picture of `reference/` by its path) | ignored |
| `session.json` | the conversation to resume | ignored |
| `state.md` | the build, the parts, the views, the scans and the open marks as text | ignored |
| `thumb.png`, `thumb.json` | the card's picture, and what it is of | ignored |
| `views/<n>.png` | the pictures and section drawings the agent asked for, the latest 20 | ignored (a picture of a scan may show the real world) |
| `exports/` | where the save dialog of an export opens; empty unless you save there | ignored |

"Ignored" is by `.torno/.gitignore` (or one inside the folder), which torno
adds lines to and never rewrites; a line you negate there (`!state.md`) is
yours, and is not added against. What travels with the object in git is what
is the object's: `scene.json`, `marks.json`, `scans.json` and `agent.json`.
What changes with every build or session, or is of this machine, is
ignored: `state.md`, `session.json`, `chat/`, the thumbnail, `views/` and
`exports/`. Add `.torno/` to the workspace's `.gitignore` if you
want none of it in git.

Outside the workspace:

- `~/.config/torno/` (on macOS `~/Library/Application Support/torno/`): `config.json` holds the workspace last opened and the
  folders opened lately (eight at most); the rest is Electron's own cache.
- `~/.config/torno/agent/<session>.mcp.json` (on macOS under `~/Library/Application Support/torno/`): the file
  `--mcp-config` names, which tells a session where torno's MCP server is. It holds the placeholder
  `${TORNO_SESSION}`, never the token, and is removed when the session ends (and at the next start after a crash).
- `~/Library/Application Support/torno/kernel-env` on macOS, for the packaged app only: the kernel's Python
  environment, made at the first build of a workspace with no `pyproject.toml`. Never inside `torno.app`.
- The one file an export writes, at the path you choose.
- `torno.desktop`, only by `scripts/torno --install-desktop`.
- A copy of the example in the system's temporary folder, removed when torno
  quits, or at the next start after a crash (only folders its own marker file
  names).
- `~/.local/state/torno/launcher.log`, only when torno was started from its
  desktop entry, something went wrong and there was no `notify-send` to show it.

The agent's CLI keeps its own records as it always does.

## Limits and exactness

**Exact and approximate.** Every number the tools give is measured by the
kernel on the model's own B-rep, never on the mesh on screen. A reply says
`exact: true` when the value is exact; otherwise the reading starts with `≈`
and says `approximate`, and `how` says why.

- Distances, angles, radii, diameters and thicknesses are exact. An angle to a
  face or an edge that is flat or straight only within 1e-6 mm (a B-spline, a
  surface of extrusion) is not: `how` ends `flat within 1e-6 mm`.
- A volume is exact only of a part all of whose faces are planes, cylinders,
  cones, spheres and tori. Of any other part (a loft, a spline, an offset) it
  is integrated and never said to be exact: `≈`, `volumeExact: false` in
  `scene` and `describe`, `exact: false` in `measure`, with `how` saying
  `of the solid, approximate, good to about N significant digits` (two to
  six: what two integrals that differ agree to, one digit fewer), or, when
  they agree to fewer than two, `of the solid, approximate: in doubt by X %`.
  That is agreement, not proof, and the last digits of a freeform volume may
  differ from one build to the next, within what it says. A mass follows its
  volume (`…; volume approximate, good to about N significant digits`), and
  so does what two parts share (`check overlap`: `of what the two share,
  approximate, …`).
- A solid turned inside out (its faces point inward, which OCC integrates as
  a negative volume and still calls valid) is told for what it is. Each solid
  of a part is measured alone, with its sign: the volume is the sum of their
  sizes, and `reversed` lists the solids that were negative, their numbers
  counted from 0 among the part's solids, in the order faces are numbered
  (`reversed: [2]` in `scene` and `describe`, with `solid 2 reversed` in the
  descriptor; `describe` of a group names the part; `measure volume` and
  `mass` say so in `how`; `check overlap` and `check clearance` name the
  parts). A sound part has no `reversed`. torno never mends the
  shape: the volume of a part with a reversed solid is the material it
  encloses, not a sign that the part is sound, and the model is to be fixed.
  A cavity whose shell faces into it is counted as material, and positive: what
  says it is broken is OCC's check, and the part is told as not valid.
- What a part's own mesh encloses (`meshVolume`) is a sum over the triangles it
  is drawn with, never exact and never a number to rely on: it is told, with
  `≈`, only where it and the volume are further apart than the mesh explains,
  as a sign that one of them is wrong.
- An area is exact for planes, cylinders, cones, spheres and tori, and for a
  curve extruded straight. The area of any other face (a loft, a B-spline
  surface, an offset) is never said to be exact: `how` says `approximate, good
  to about N significant digits`, or `approximate: its integrals differ by
  0.14 %`.
- A bounding box from `measure` is exact when all the faces of what is boxed
  are planes or cylinders and all its edges lines or circles; of anything
  freeform it is approximate and says so. A part has one box, and `scene`,
  `describe`, `state.md` and `measure bbox` tell the same numbers of it, with
  `≈` (`sizeExact: false` in `scene`, `bboxExact: false` in `describe`) where
  it is not exact. The sizes in `scene` are for orientation: `measure` is for
  a number to rely on.
- The areas of a section say for themselves (`areaExact`).
- Nothing taken from a scan is exact.
- The mesh drives only the estimate at the pointer while a measurement is
  pending (`≈`), which the kernel's value replaces.

**What it costs.** The volume and the box of every part are worked out during
each build. On prismatic parts that is nothing: the test models build in a
tenth of a second. On a freeform part it is about a second for the volume and
up to a second for the box: an object of three lofted parts of about 90 faces
each, whose model runs in 10 s, builds in 17 s, 5 s of it for volumes and
boxes. `area` of the whole of such a part takes a second or two on the first
ask (three integrals of every freeform face, to say how many digits agree);
`describe` of the part takes one integral a face and says its area with `≈`.
Both are then kept until the next build. A question the kernel has not answered within
30 s is an error that says so.

**The agent's tools are for its session alone.** The MCP server and the
address the agent's hooks post to listen on `127.0.0.1` alone, check that a
request comes from no web page (`Origin`, `Host`), and answer 404 to any
request without its session's token in the `X-Torno-Session` header: 32
random bytes made when the session starts, which open that session's hooks
and its object's tools, and nothing once the session has ended. The token is
in the agent's environment (`TORNO_SESSION`) and nowhere else: not in the
arguments it is started with, which every user of this machine can read (`ps`),
and not in the file `--mcp-config` names, which holds only the placeholder
`${TORNO_SESSION}` that Claude Code expands. Torno does not log it and writes
it to no file. That keeps out another user of this machine, any program that
only finds the port or reads the agent's command line, and the session of
another object. It does not keep out a program running as you, which can read
the agent's environment, nor a script the agent runs, which inherits it: such
a program can call `show`, `add_mark`, `resolve_mark` and `save_view` of that
object, and post its hooks, while the session lasts.

**Parts that fit together.** `overlap`, `clearance` and a distance between two
parts are of the parts where the layout has them, so fit can only be checked
in a layout that places the parts as assembled (`assembly(p)` in the model).
In a `print` layout that torno spread along X the parts are where torno put
them for display: there these three are refused between two parts, with a
sentence that says why and names the layouts that do place both parts; a
dimension between them is not kept, and one that is there already is not
measurable on such a build; a scan is not checked against a part torno moved.
What is of one part is answered as ever (thickness, diameter, bbox, area,
volume, mass, mesh, a distance within the part, an angle), with `arranged`,
how far torno moved the part. An object with only a print layout can
therefore be measured part by part, but not checked for fit until its model
has an assembly.

**Memory.** The last build of an object stays in memory, in a process of its
own, to answer what is measured and checked of it: half a gigabyte for a small
part, and many gigabytes for a large model. At most four are kept. Before a
build is started the kernel looks at how much memory is free: when there is
less than the last build of that object holds (2 GiB at least) and 2 GiB more,
it lets go the builds of other open objects first, the one least recently
used first, and then that object's own. The line at the bottom then says "The
last build was let go to make room (memory): tools answer when this one
lands". An object whose build was let go is built again when something is
asked of it, never by a check on a timer; and a model that has just failed to
build is not built again until a source changes.

## Troubleshooting

- **Every build fails saying to run `uv sync`.** The workspace has a
  `pyproject.toml` and no `.venv`. Torno never makes one: run `uv sync` in the
  workspace once, then open it again.
- **A build fails.** The last good parts stay on screen, the pointer says
  that picks wait for a build that works, and "Build failed" at the bottom
  opens the error with the traceback. The agent is told the same, after its own
  edit and with your next prompt, and its tools answer from the last build that
  worked, saying so. "Ask Claude Code to fix it" in that sheet puts the request in
  the box for you to send. Save the model again once it is mended: every save is
  built.
- **The chat says "This chat is billed to an API key".** The CLI reported a key
  as the source of its credentials, and names the source (`user`, `project`, `org`,
  `temporary`); a key is billed per token and not to your Claude login. In the
  chat's mode an `ANTHROPIC_API_KEY` in your environment wins over your login, so
  unsetting it where you start torno is one way to use your subscription; a key
  from a helper or a setting of Claude Code is for you to find in its settings.
- **The chat says "Claude Code's chat could not use your login".** The CLI's
  headless mode, which the chat runs (`claude -p`), answered the turn that it
  was not authenticated. `--bare` (or `CLAUDE_CODE_SIMPLE=1`) makes `-p` read no
  login, and Claude Code says `--bare` will become the default for `-p` in a
  future release. "Use the terminal" runs
  `claude` as you run it, under your login; `claude auth status` in a terminal
  says whether you are signed in.
- **A build takes minutes.** It is the model that takes them: see "What it
  costs" above. `TORNO_BUILD_TIMEOUT` raises the limit of 600 s.
- **The agent says to press Rebuild, or a build failed for no reason of the
  model's** (the kernel stopped, a build was let go and the model has since
  failed). "Rebuild" is in the line at the bottom, beside how the build
  stands; `Ctrl+Shift+B` does the same from anywhere.
- **Nothing is kept of an object: no mark, no view, no picture.** Its `.torno`
  is a link or a file; the Marks panel says so. Put a real folder in its place.
  A link in the place of `.torno/views`, `.torno/exports`, `.torno/scans` or
  `.torno/chat` stops only what goes there (the agent's pictures, an export,
  the scans, the log of a chat): torno writes nothing through it and deletes
  nothing behind it. Take the link away.
- **The first screen says Claude Code is not found on `PATH`, or not signed
  in.** Install Claude Code and log in (`claude` in a terminal), then reopen torno,
  or press "Check again" in the sheet of the folder menu ("Check what torno needs").
  Torno looks on the `PATH` it was started with, which the line shows, and which a
  desktop launcher may have shorter than your shell's. The page of a new object
  says the same above "Create": the object is made all the same, but Claude Code
  cannot start in it.
- **The first screen says `uv` is not found.** Install it from
  [docs.astral.sh/uv](https://docs.astral.sh/uv/) and reopen torno. Without it no
  build can run: the kernel is started by uv.
- **The first build is slow, or fails offline.** The first time, uv makes torno's
  own Python environment and fetches about 900 MB. The first screen says so
  ("Not made yet"); "Make it now" does it before the first build, and the status
  line says "Making torno's Python environment, first time only" if the build does
  it. Offline it fails with uv's reason, which the kernel's line shows; press
  "Make it now" again, or rebuild, once there is a network.
- **"New session" says the agent's command was not found on PATH.** Torno
  looks for `claude` on the `PATH` it was started with. Started from a desktop launcher, that may
  not be your shell's: start torno from a terminal, or set
  `TORNO_AGENT_CMD`. On macOS torno asks your login shell for its `PATH` (and adds `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin` and `~/.claude/local` where they exist); if that fails it says so on stderr.
- **The window does not come up, or stays blank.** Try
  `TORNO_OZONE=x11 scripts/torno`, then `TORNO_OZONE=wayland`. Torno draws
  with WebGL 2; `F12` opens the developer tools, whose console says when the
  graphics card gave it no context.
- **On Wayland every start prints `'--ozone-platform=wayland' is not
  compatible with Vulkan`.** It is harmless: WebGL goes through ANGLE on
  OpenGL ES, and WebGL, GPU compositing and rasterization are all on with or
  without it. `--disable-features=Vulkan` does not silence it, so torno passes
  nothing for it.
- **An exported page says it cannot draw the parts.** That browser gives the
  page no WebGL 2, took it away, or drew a frame with nothing of the parts in
  it (the page looks at its own view three seconds after it began to unpack
  the parts, and says which): open the file in a current Chrome, Edge, Firefox
  or Safari with hardware acceleration on. `firefox --headless --screenshot`
  takes its picture before the first frame is drawn, so it shows the page
  without its parts: that is the screenshot, not the page.
- **`TORNO_DEBUG=1`** prints the workspace opened at start, the address of
  the MCP server, and the command line and hooks of every session.

## Tests

```sh
pnpm test          # unit tests of the app (vitest), a few seconds
pnpm test:kernel   # the app against the real Python kernel and a stand-in agent (vitest)
pnpm test:e2e      # the built app in a hidden window (Playwright)
(cd kernel && uv run pytest -q)   # the kernel alone (pytest)
```

GitHub Actions runs the suites on macOS (`.github/workflows/macos.yml`), with the e2e suite only when asked.

No test opens a window, and none runs a real agent CLI: a stand-in
(`app/test/fake-agent.mjs`) takes its place. Under test Electron keeps its own
files (cache, storage, crash dumps) in a folder of the run in the temporary
folder, removed once it has quit, and nothing in `~/.config/torno` (on macOS `~/Library/Application Support/torno`). The scans in the tests are made
by the test code; none is in the repository. A test holds this file to the
code: its table of keys, and the tools it names.

## Environment variables

| Variable | Effect |
|---|---|
| `TORNO_WORKSPACE=<path>` | the workspace to open at start, instead of the one remembered. `scripts/torno <path>` sets it. |
| `TORNO_AGENT_CMD=<cmd>` | the command to run for a session in place of `claude`, split on spaces and given Claude Code's arguments: `TORNO_AGENT_CMD="claude --model sonnet"` |
| `TORNO_BUILD_TIMEOUT=<seconds>` | how long a build may run before it is stopped: 600 by default, a day at most |
| `TORNO_OZONE=wayland` or `x11` | read by `scripts/torno` only, on Linux: the platform Electron is told to draw on. Unset, Electron chooses. On macOS it is ignored, with a line on stderr. |
| `TORNO_CONFIG=<path>` | the config file to use instead of `~/.config/torno/config.json` (on macOS `~/Library/Application Support/torno/config.json`) |
| `TORNO_DEBUG=1` | print to stderr the workspace opened at start, the address of the MCP server, and the command line and hooks of every session |
| `TORNO_TEST=1` | create the window hidden and never show it; keep Electron's own files in a temporary folder of the run; expose the test hooks; look for `claude` on the `PATH` without running it. For tests only. |

The agent inherits torno's environment without these, and without the variables
a parent Claude Code session exports (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and
the like), so torno can be started from inside one. Variables you set yourself,
such as `CLAUDE_CODE_USE_BEDROCK`, are passed on. It is given `TORNO_SESSION`,
its session's token, which no address and no argument holds. A torno started
from inside a session of another torno passes that session's `TORNO_SESSION`,
`TORNO_OBJECT` and `TORNO_SESSION_ID` to nothing it starts: not to the agent,
the kernel, the import of a scan or the checks of what torno needs.

## Not yet verified on a visible screen

Torno was built and tested in a window that is never shown, with a stand-in
for the agent.

**Verified on a real compositor output (Hyprland, NVIDIA; the session was
locked, so not by eye).** On 10 October 2026 torno ran as a real, mapped window
on a Hyprland output, on Wayland and on X11, with the real agents (Copilot CLI too, which
torno has since stopped running); what it drew
was taken from the compositor and looked at afterwards. The first start drew
the parts on the GPU at 60 frames a second on both platforms. Only one torno:
a second start exited and the first opened the folder it was given. There is
no menu, also on Alt. Alt-drag with the Draw tool turned the camera and drew
nothing (sent as events; no binding of the compositor's was in the way).
`hyprctl clients` showed class `torno`. Light and dark were legible in both
themes. A large object's thumbnail was on its card at once and the window did
not stall. `Ctrl+Shift+E` with Claude Code's prompt in focus brought up the
export sheet and nothing reached the CLI; `?` outside a field and the terminal
brought up the sheet of keys. Left alone for five minutes with a large object
open, torno's memory stayed flat and its processes idled near zero. With
Claude Code a pin was told with the next prompt and turned from draft to sent,
and `scene`, `look`, `marks`, `save_view` and `add_mark` ran without a
permission question. What that run found wrong is mended: closing the
window now asks first when something would be cut short, the Marks list no
longer runs out of its column when a mark has moved, "Needs input" is no longer
shown while Claude Code is only idle, a session can be ended from its header,
and tests no longer write into `~/.config/torno`. An exported file showed no
parts in `firefox --headless --screenshot`, which takes its picture before the
first frame; driven in headless Firefox instead, the page drew the parts.

The chat was driven once with the real Claude Code (Haiku, 15 October 2026) in a hidden window on a temporary copy of `micra-intake`: a pin was sent with the prompt and shown under it, a torno `look` came back with its picture and the "Pulled from torno" line, a ref in the reply was a chip, a Write was allowed by the CLI without asking under the person's permission mode (so there was no card), and no `.claude/` folder was written in the object. It was not looked at on a visible screen, so the items listed below stay to check.

What remains is yours to try once. Each says what to try and what should
happen.

On the screen:

- **macOS.** Nobody has run torno on a Mac by eye. Try once: `⌘V` and `⌘Z` in the chat composer and in a note, and `⌘C`/`⌘V` in the terminal view (`spawn-helper` of node-pty must be executable, or every terminal fails with `posix_spawnp failed`); `⌘Q` with a session working asks "Close torno?"; the Dock shows torno's icon when run from the repository; start torno from the Finder or the Dock and a session finds `claude` and a build finds `uv` (the login shell's `PATH`); on a trackpad a two-finger scroll zooms, `⌘`-drag or `⇧`-drag pans (OrbitControls' own), and Ctrl-click is a secondary click.
- **Resizing.** `scripts/torno ~/objects` on Hyprland: drag the window wider and narrower, or retile it: it redraws without flicker. If the window does not come up right, `TORNO_OZONE=x11`, then `TORNO_OZONE=wayland`, and keep the one that works.
- **Focus.** Start torno a second time with another folder: the window that is open comes to the front (on Hyprland only where `focus_on_activate` is on). Start dragging the section's arrow, switch workspace, come back: the plane is where it was before the drag, and the next drag turns the camera.
- **Closing.** With a session working, close the window through the window manager: torno asks "Close torno?", "Keep it open" keeps everything as it was, "Close torno" ends torno and the session. With nothing under way it closes at once.
- **A session that needs you, away from its pane.** In two objects, ask Claude Code in one for something that needs a permission, then open the other (and again with the session pane hidden): the first one's row has a dot and "needs you" in the warning colour, the status line has the button "*name* needs you", which opens it and brings you to the card, and a working session's dot is a quiet grey. In a window that is not in front (another window on top, or a workspace switched away) the frame should flash on Linux, and the dock icon bounce once on a Mac: no test shows a window, so only the rule is tested.
- **The left column.** With a folder of many objects, open one: the list is one row, "All objects `W`" beside its
  title. Its menu, by the mouse and by the keys, opens another; folding Layers and Scans gives their room to the
  marks, and their titles say how many parts and scans there are. Drag the line above Marks up and down, and double
  click it: it moves without lag, the sections above give way down to their titles, and the shares come back.
  Start torno again: what was folded, and where the line was, are as you left them. Legible in light and dark.
- **Parameters.** In an object whose model has a `Params` dataclass with comments and one default that is an
  expression, unfold Parameters under the layers: a row for each field in the model's order, the value in the
  monospace face, the comment as written (cut to two lines, whole on hover), "worked out in the model" on the expression's.
  With a real session running, in the chat and then in the terminal view, a click on a row puts `Params.wall` at the
  cursor of the box (or the prompt) and sends nothing, with the dock hidden as well; with no session the rows are
  not clickable. Legible in light and dark, and Marks keeps its five rows with the section open.
- **The clipboard in the terminal.** Select text in a session and press `Ctrl+Shift+C`, then `Ctrl+Shift+V`: it is copied and pasted. No test touches the clipboard. "Copy" on the build error sheet likewise.
- **By eye.** On a monitor, in dark and in light: text, marks, part edges and the terminal's colours are legible; the scrollbars are the thin grey ones, also in the list of objects and on the page of objects in the dark theme; a mark that has moved says so on a line under its note. `?` typed in a field on your own keyboard (with its dead keys) is a question mark.
- **The doodle board with a mouse and a pen.** Draw with a mouse, a tablet pen and a touch screen: the line follows the pointer without lag, the eraser takes away what it crosses, `Ctrl+Z` takes the last stroke back, and the PNG Claude gets is dark on white in both themes. Tests drew with synthetic pointer events only. A photo dropped from the file manager on the new object's page is taken too; a test cannot drop a file with a path.
- **The Scans panel.** Import a scan of your own: the sheet `How is S1 read?` is at the top of the Scans panel with the size it would have; "Later" leaves a dot on the row. The row is one line at the column's default width, the name cut with an ellipsis and whole in its tooltip, the word legible in both themes, the dot and a `check` or `rough` word told apart from the rest. Open its detail and another's: one is open at a time, and Frame, Align and Rename are on one line.
- **Drawing on the view with the real Claude Code.** In a chat, "Draw on view", ring a face and draw an arrow to it with a mouse and with a tablet pen, "Done", then a prompt ("make this thicker"): the ink follows the pointer, the eraser takes ink and never the picture, the row above the box names the faces the ink lies over before anything is sent (and says so, in amber, when it could not be worked out), "Attach view" shows a small picture of the view before it goes, the chat shows the picture and that line with the prompt, and Claude Code's reply speaks of the ringed place and names the face the caption gave. Tests drew with synthetic pointer events and the stand-in agent.
- **A broken part in the layers.** Build a model with a cavity whose shell faces into it, or a part made of a shell
  with a face left out: its layer row says "not valid" (or "not closed") after its name in the colour of a failure,
  with what that means in its tooltip, and the line at the bottom says "1 part has a defect"; legible in light and
  dark, and the row still one line in a narrow column.
- **Why a fillet failed, in the error sheet.** Build a model whose fillet fails (a 20 mm plate with a 12 mm pocket
  through it, its eight vertical edges at R6): the status line says the build failed, and the error sheet shows, under
  the message, a "Why" section with the line and a line for each edge, in the face of numbers, legible in light and
  dark and in a narrow window; Copy takes it with the rest.
- **"Ask Claude Code to fix it" with the real Claude Code.** Break the model in a chat, open "Build failed" and press
  the button: the dock opens if it was hidden, the box holds "Fix the build of *name*: see the error." and nothing is
  sent; Enter sends it, and Claude Code answers from the error it was told (the sheet says whether after its edit or
  with the next prompt). Again in the terminal view: the words are at the CLI's prompt, unsent. With no session, "Start
  a session to fix it" starts one and leaves the words in its box. Tests used the stand-in agent. After a crash or a
  timeout of the build (stop the kernel's process, or lower `TORNO_BUILD_TIMEOUT`) "Rebuild" is the main button in the
  status line and in the sheet; after a Python error it is not.
- **A scan file dropped on the view.** Drag a GLB or STL from the file manager onto the parts: it is imported as "Import scan…" would.
- **The folder dialog.** "Open folder" on the first screen, and "Open folder…" in the menu of the folder button at the top left: the system's folder dialog opens, and the folder chosen is opened.
- **The save dialog of an export.** "Export…", then "Export": the system's save dialog opens in `.torno/exports/` with a name offered, and the file is written where you say.
- **The replace question.** Save an export as `x` where `x.html` exists: torno asks before it replaces that file, and "Cancel" writes nothing.
- **A 3MF opened in a slicer.** Export a 3MF of a plate of two parts or more and open it in PrusaSlicer, Bambu Studio, OrcaSlicer and Cura: each part is an object of its name, in millimetres, where torno set it; it slices with no repair asked for. "Open it once saved" opens it in the slicer the system gives `.3mf` files to. Tests read the file back with lib3mf only.
- **An STL in a slicer, a STEP in a CAD program.** Open an STL of a round part in a slicer: no facets you can see on its holes at 0.01 mm. Open a STEP in FreeCAD and in Fusion or Onshape: the parts are named bodies in their colours, in millimetres, and a volume measured there is the one torno told; a part named with an accent (`tampa ção`) keeps it there, as torno writes names in UTF-8. Tests read it back with OCC only.
- **Torno left on another workspace with a session working.** Give the agent something that takes minutes, or start a long build, and switch to another workspace for ten minutes, watching `ps -o rss -p <pid of the window>`: its memory stays flat and torno idles near zero. Idle with a large object it did; with a session working nobody has watched it.
- **An exported file elsewhere.** Open one from `file://` in Firefox, in Safari and on a phone, with the network off, and look: parts, layouts, the explode slider, the section, a saved view and the marks work. Headless Firefox drew the parts; nobody has looked at it by eye there, or anywhere but in Electron's Chromium.
- **The desktop entry.** `scripts/torno --install-desktop`, then start torno from your launcher: it is listed with its icon, the window comes up and is grouped under the entry (`StartupWMClass=torno`) with torno's icon. Given a folder (`gtk-launch torno ~/objects`) it opens that folder; given two, it refuses. With `claude` only on the `PATH` of a login shell, "New session" says it was not found there: start torno from a terminal, or put the command on the launcher's `PATH`.

With a real agent:

- **Claude Code and the trust question.** In a folder never opened before, with a `.claude/settings.json` that holds a hook (or a `.mcp.json`), either in the object or in a folder above it: "New session" asks "Start the chat anyway?" and starts nothing; "Start the chat" starts it (and the hook runs, as Claude Code's documentation says it does without a question when run non-interactively), and the next session there is not asked; "Use the terminal" shows Claude Code's own trust question. The measuring on 2026-10-15 (Claude Code 2.1.300) only read the documentation for this.
- **The instruction files, with the real Claude Code.** In an object whose workspace folder holds a `CLAUDE.md` (the person's real `~/objects` has one that names `out/nerv/report.json`), the session pane lists it with its size and your own `~/.claude/CLAUDE.md`, in the chat and in the terminal view, and a click on a name shows the file in your file manager (nothing is opened or run); `/memory` in a terminal session lists the same files and no others (an `AGENTS.md` only where no `CLAUDE.md` is above the object). After the first prompt, ask what it reads of the build: the real CLI in `~/objects` no longer reads `out/nerv/report.json` to see the shape but uses `scene`, `look` and `measure`, while it still follows the file's advice on how to model (caliper numbers first, blockouts first). The stand-in agent cannot show what the model chooses.
- **The prompts in the command menu.** In a chat, type `/mcp`: `/mcp__torno__review`, `/mcp__torno__printable` and `/mcp__torno__explain` are offered, and choosing one sends it; the stand-in names none of them, so no test has seen them in Claude Code's own list.
- **A failed or old Claude Code in the chat.** A `claude` that does not know one of the chat's flags, or is signed out: the pane says "Claude Code stopped (exit code 1)" with the last line it wrote, and "It did not start: is `claude` up to date and signed in?". Not yet seen with a real old CLI; the stand-in prints to stderr and exits 1.
- **A chat that could not use the login, with the real CLI.** The stand-in plays it (`FAKE_AGENT_AUTH_ERROR`) in the shape of the Agent SDK's types (an assistant message with `error: "authentication_failed"`, then a `result` with `is_error: true`); no real CLI has been seen to print it. Start torno with `CLAUDE_CODE_SIMPLE=1` (what `--bare` sets) and no `ANTHROPIC_API_KEY`, send a prompt in a chat: the CLI's words, then the warning "Claude Code's chat could not use your login" with "Use the terminal", once. Note what the CLI prints then (`claude -p --bare --output-format stream-json --verbose hello` in a terminal, with no key: the assistant message's `error`, the `result`'s `subtype`, `is_error` and `api_error_status`) and whether a signed-out `claude` (`claude auth logout`) or a login that ran out answers the same way or exits (an exit leaves the chat ended, and its "Use the terminal" still starts the terminal). Then start torno without the variable: "Use the terminal" ends the chat and the same conversation goes on in the terminal.
- **Subagents and thinking.** A turn with a subagent (`Task`; newer versions may call the tool `Agent`) and one with extended thinking: the card counts steps and lists the tools, "Thought for N s" shows after a thought. The number was worked out from a recording; nobody has looked at it with the real CLI.
- **The chat with the real Claude Code.** In a session in chat: a prompt with a pin or two marked (the "torno added" line shows them and they turn to sent); a command that asks permission, answered "Allow", then another with "Allow for this session" (the next like it is not asked, and `~/.claude/settings.json` and the object's `.claude/` are as they were), then one "Deny"; a question (`AskUserQuestion`) answered with an option and with "Other"; a plan in plan mode approved; "Attach view" (the agent describes what you see); the model menu (the next answer is from that model, and `/model` in the terminal still shows your default); `/compact` (one note, the conversation goes on); "Terminal", then "Chat" again: the same conversation, its earlier part shown.
- **Making a new object with the real Claude Code.** "New object" with a name, a description, two photos from a phone (one large), a doodle, a scan and a reference to another object, each with a note, then "Create": the object is opened, its chat shows the one prompt with the pictures, Claude Code's reply speaks of them and of the notes, the scan is in the Scans list, `reference/` holds the original photos, and nothing else was written in the workspace. The stand-in agent has taken the prompt; the real CLI has not.
- **Asking for the missing sizes, with the real Claude Code.** Make an object whose description gives one size and leaves out the rest (a lid for a box of an unnamed size, screws not named): before the first write of the model, Claude Code asks once, in a card with at most four questions, each with a typical value among its options and "Other" taking "build with assumptions"; it asks nothing about a fillet radius; after the answers it builds, and a size you did not give is a field of `Params` commented "assumed" and listed in its reply. Then ask for a new feature with no key size (a hole for "a screw"): it asks once, not again. The stand-in agent only plays the card; the real model's choice to ask has not been seen, and the eval harness (#121) does not yet measure it.
- **Claude Code and torno's skills.** `--plugin-dir` works under `-p` (chat) and in the terminal view: in each, `/skills` (or asking the agent) lists `torno:torno-model`, `torno:build123d`, `torno:scans` and `torno:dimensions`, a model written in an empty object uses `torno-model` and builds with both layouts on the first try, and nothing was written under `~/.claude` or in the object's `.claude/`. The stand-in only shows the flag is passed. Asked how an argument of build123d is written, the agent searches `reference/api-0.13.0.txt` of the `build123d` skill (its `${CLAUDE_SKILL_DIR}` is filled in with the real folder, in the packaged app too) instead of running Python, and `claude plugin validate app/resources/agent-plugin` passes.
- **A failed fillet, with the real Claude Code.** Ask for a fillet that cannot be made as asked (the plate above, all
  its vertical edges at R6): the result of the edit says why under the error, and the agent reads it, calls
  `try_fillet` on the last good build with the edges it names before it edits again, and changes the radius of the
  edges that need it (or the selection) in `Params`, saying so; it does not wrap the fillet in `try`, lower every
  radius, or call `max_fillet()`. The stand-in agent cannot show what the model chooses.
- **What Claude Code says of itself, with the real CLI.** The stand-in plays each case (`FAKE_AGENT_INIT`); the real CLI has not: with `ANTHROPIC_API_KEY` set the chat says it is billed to an API key and names what `apiKeySource` is then (look at the value in a real `init`: `user`, `project`, `org`, `temporary`, or another), with it unset and logged in it says nothing (`none` or `oauth`); in a new session with torno's plugin, `init` lists `torno` among its `plugins` and no warning appears, and `/skills` lists the four skills (what `skills` holds with a `--plugin-dir` plugin is not recorded: the recordings' lists hold no plugin skill at all, so torno judges the skills only when `skills` shows some with a `plugin:` name); a `claude` of another minor than 2.1 (or older than 2.1.300) says so once; with the torno server made to fail the warning carries what the CLI said; a real overload shows "retrying (attempt N)" and it goes with the answer; a command refused by a rule of `settings.json` leaves the warning "Permission denied: …" (and the fields `mcp_server_errors`, `plugin_errors` and `permission_denials` are read as their form is guessed from the documentation). When the CLI moves, record a new stream (`app/test/fixtures/RECORDING.md`) and move the range.
- **The torno-reviewer subagent.** One run with the real CLI, in chat and in the terminal: after a change of several steps Claude Code calls `torno-reviewer`, which uses only its read-only tools, reports with numbers from `measure` and changes nothing; whether the subagent's MCP calls go through `--allowedTools 'mcp__torno__*'` without a permission prompt; and that an invalid `--agents` would have stopped the start (it did not). The stand-in only shows the argument is passed.
- **Pictures of a resumed chat, with the real Claude Code.** Make an object with one photo and one doodle and send the first prompt; let Claude Code take one `look`; quit torno. Start it again and open the object (the chat resumes): the photo and the doodle show, and the `look` picture says "Picture of an earlier build, not kept". Ask "Without reading any file, describe the doodle I gave at the start": a right answer confirms that `--resume` gives the model its pictures again. Then `/clear` and ask what references the object has: it names them from the line in `reference/`. The stand-in agent shows only that the window reads the files and the line is sent.
- **The session's token with the real Claude Code.** Start a chat and a terminal session: torno's tools connect (no
  "torno's tools are not connected" warning; `look` answers) and the hooks arrive (the status moves to working and
  back, a pin turns to sent), all with the token in the `X-Torno-Session` header. `ps -eo args` shows the `--mcp-config`
  path and no token. The documentation says `${VAR}` is expanded in the `headers` of a `.mcp.json`, and an http hook
  interpolates `$VAR` for the names in its `allowedEnvVars`; that a file given to `--mcp-config` is expanded the same way
  it only implies. If it is not, Claude Code sends the placeholder, torno answers 404 and the chat warns that the tools
  are not connected; the way out would be a small stdio bridge that reads the token from its environment.
- **The digest of a build with the real Claude Code.** Ask it to raise a boss off a plate until it no longer touches
  it: the answer to its edit says `Changed since rN:` and `Check: plate is 2 solids (was 1)`, the chat shows it under
  the edit's card behind "Show text", and when Claude Code would stop it is held back once and either mends the
  model or says why two solids are meant. Then ask for a pocket: the volume falls in `Changed since`, nothing is
  held, and it reads the line rather than asking for a picture first. Whether it heeds the line is the agent's;
  no test has seen a real CLI read it.
- **The holds of a `Stop` with the real Claude Code.** Have it edit the model and say it is done without a `look`
  (once through its editing tool, once with `cat > model.py` in Bash): the `Stop` is held with the reason about the
  build "built during this turn", the agent looks, and the turn ends. Open an object and ask something that
  changes nothing while its first build runs, then save the file in your editor in the middle of a turn: neither holds it. Pin a dimension, then have it change the model
  so that it fails: it is held once and names it. Let a build run for twenty seconds while it would stop: the `Stop`
  waits, and the hook's 25 s limit is enough (the stand-in cannot tell). Whether the second `Stop` of a turn that was
  held arrives with `stop_hook_active` and is held again for another reason is what the code assumes; the stand-in
  plays it as the documentation says. Whether the hooks of a `torno-reviewer`'s `look` arrive on the session's
  address (so that its look counts) has not been seen.
- **Claude Code and the newer tools.** Ask it to cut the part, to look at it drawn apart and to check a part against a scan: `section`, `look` with `explode`, `scan_clash` and `scan_deviation` are called without a permission prompt and their replies are used.
- **What torno says it needs, with the real CLI, a machine without `claude` and one without `uv`.** Tests look for `claude` on the `PATH` and never run it; the stand-in plays `--version` and `auth status`. With the real CLI: the first screen says `claude` is found, its version (`claude --version` prints it first, as `2.1.307 (Claude Code)`) and "signed in" (look at the real output of `claude auth status`: torno reads `loggedIn` and `authMethod` of its JSON, and says nothing of the account where it finds neither); signed out (`claude auth logout`) the line says so and the page of a new object warns above "Create"; a `claude` that hangs or is too old to know `auth status` is said to have not answered, within 3 seconds. On a machine without `claude` on the `PATH` the line says "Not found on PATH", and without `uv` the uv line does and the kernel's is left out. With no `kernel/.venv` (or no `kernel-env` under torno's data folder, packaged), "Not made yet" and "Make it now" run `uv sync` on the network and show its lines, then the line says torno's environment is made; offline the reason is uv's. Started from the Finder or a desktop launcher the `PATH` shown is the one torno has.

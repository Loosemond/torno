# torno

Torno is a desktop workbench for making CAD parts with an AI coding agent. The
agent (Claude Code) writes build123d Python in a terminal inside the window.
Torno builds the model every time its file is saved, shows the parts in a 3D
viewport beside the terminal, and gives the agent tools to see what you see.
You point at the part to say what you mean: a pin, an arrow, a stroke or a
rough shape, each with a note, which the agent gets with your next prompt.

Torno is not a modeller. It has no sketcher, no feature tree and no way to edit
a solid by hand. The model is the Python file; torno shows it.

The name is Portuguese for lathe.

This is Milestones 1 and 2. The loop: open a workspace, rebuild on save, look
at the parts, talk to one agent session per object. And talk: point at the
parts and leave marks, which travel to the agent and which it can read, answer
and resolve. What comes after is listed under [Next](#next). The design is in
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
  each with a visibility switch, and its marks. "Open folder" chooses another
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
and at the next build.

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
  with its size, bounding box, volume and whether it is visible, and your
  camera. It notes when the parts of the print layout were spread along X.
- **`mcp__torno__look`**: a picture from the renderer you are looking at. With
  no arguments it is exactly your view. It also takes a named view (`iso`,
  `front`, `back`, `left`, `right`, `top`, `bottom`), a camera, a layout, a
  list of parts, and a size (long edge, 1280 by default, 2000 at most). The
  caption names the revision that was drawn, and says when it is stale.
- **`mcp__torno__marks`**, **`mcp__torno__describe`**: your marks and the
  agent's as data, and the exact geometry of a part, a face or an edge
  (`lid`, `lid/F12`, `lid/E3`). Both say which revision they answer from, and
  say so when a newer build is running or has failed; `add_mark` does too.
- **`mcp__torno__highlight`**, **`mcp__torno__show`**: the agent tints faces
  or edges in your viewport with a note, to ask "this one?", until you click
  or a minute passes; or changes your camera, layout and visible parts to show
  you something. What `show` changes is for now: the layers and layout you
  chose stay what `.torno/scene.json` keeps. While you hold a button in the
  viewport, `show` is refused and the agent is told to try again.
- **`mcp__torno__add_mark`**, **`mcp__torno__resolve_mark`**: the agent leaves
  marks of its own, in green, and resolves yours with a line on what it did,
  which you then confirm or reopen.
- **A few lines with every prompt**, added by a `UserPromptSubmit` hook:
  `[torno] bracket · build ok · r3 (1.2 s) · layout assembly · parts: base, post.`
  For a failed build it carries the error. For an object that is not the one
  open in the window it says so, and names no layout. Then what you have
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

The session's status follows the hooks Claude Code posts to torno:
`UserPromptSubmit`, `PreToolUse` and `PostToolUse` mean working, `Stop` idle,
`Notification` and `PermissionRequest` needs input.

The first time Claude Code runs in a folder it asks whether you trust the
folder. That question is Claude Code's own, and it is answered in the terminal.

## Files torno writes

Inside a workspace torno writes only under `<object>/.torno/`:

| File | What |
|---|---|
| `.torno/scene.json` | the layout, the layer visibility and the section (`section`: a plane's `origin` and `normal`) you last chose |
| `.torno/marks.json` | the marks of the object: yours and the agent's, with their notes, anchors and status |
| `.torno/session.json` | the id of the conversation to resume |
| `.torno/views/<n>.png` | the pictures the agent asked for, the latest 20 |
| `.torno/state.md` | the build, the parts and the open marks as text, for an agent without torno's tools. Its first line says when it was written: nothing keeps it current once torno has quit |

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
(`app/test/fake-agent.mjs`) takes its place.

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

3. **Read.** Measure, pinned dimensions, section cuts; `measure`, `section`, `check` for overlap, clearance and mesh.
4. **Scan.** Import a scan, align it, overlay it, check clearance against it.
5. **Show.** Explode, named views, HTML export, adapters for other agent CLIs.

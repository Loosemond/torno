# torno

Torno is a desktop workbench for making CAD parts with an AI coding agent. The
agent (Claude Code) writes build123d Python in a terminal inside the window.
Torno builds the model every time its file is saved, shows the parts in a 3D
viewport beside the terminal, and gives the agent tools to see what you see.

Torno is not a modeller. It has no sketcher, no feature tree and no way to edit
a solid by hand. The model is the Python file; torno shows it.

The name is Portuguese for lathe.

This is Milestone 1, the loop: open a workspace, rebuild on save, look at the
parts, talk to one agent session per object. What comes after is listed under
[Next](#next). The design is in
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
already open to the front; given a folder, that window opens it, asking first
if a session there is in the middle of its work.

For work on torno itself, `pnpm dev` runs the app from the Vite dev server.

## The window

- **Left:** the objects of the workspace, and the layers (parts) of the open
  one, each with a visibility switch. "Open folder" chooses another workspace;
  that ends the sessions of this one, so torno asks first if one of them is
  working or waiting for an answer.
- **Centre:** the viewport. Drag to orbit, drag with the right or middle button
  to pan, scroll to zoom. The bar at the top
  switches layout (`assembly`, `print`) and view. Keys: `1` iso, `2` front,
  `3` right, `4` top, `F` fit, `O` orthographic or perspective.
- **Right:** the session. "New session" starts `claude` in the object's folder,
  in place of the session running there, if any; torno asks first if that one
  is working or waiting for an answer.
  "Resume" continues the last conversation had there. Each object has its own
  session, and it keeps running while another object is shown. Its status
  (idle, working, needs input, ended) follows the hooks Claude Code posts.
  `Ctrl+\`` moves between the session and the viewport. `Shift+Enter` is a new
  line. `Ctrl+Shift+C` and `Ctrl+Shift+V` copy and paste.
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
  (`lid`, `lid/F12`, `lid/E3`).
- **`mcp__torno__highlight`**, **`mcp__torno__show`**: the agent tints faces
  or edges in your viewport with a note, to ask "this one?", until you click
  or a minute passes; or changes your camera, layout and visible parts to show
  you something.
- **`mcp__torno__add_mark`**, **`mcp__torno__resolve_mark`**: the agent leaves
  marks of its own, in green, and resolves yours with a line on what it did.
- **A few lines with every prompt**, added by a `UserPromptSubmit` hook:
  `[torno] bracket · build ok · r3 (1.2 s) · layout assembly · parts: base, post.`
  For a failed build it carries the error. For an object that is not the one
  open in the window it says so, and names no layout. Then each mark you left
  since the last prompt, a line each, such as
  `M3 pin on lid/F12 (plane, normal +Z, z = 20, 1180 mm²) at (12, 40.5, 20): "this edge is ugly"`,
  and the numbers of the marks still open. A mark is told this way once: it
  then shows as sent.

The first time Claude Code runs in a folder it asks whether you trust the
folder. That question is Claude Code's own, and it is answered in the terminal.

## Files torno writes

Inside a workspace torno writes only under `<object>/.torno/`:

| File | What |
|---|---|
| `.torno/scene.json` | the layout and layer visibility you last chose |
| `.torno/session.json` | the id of the conversation to resume |
| `.torno/views/<n>.png` | the pictures the agent asked for, the latest 20 |
| `.torno/state.md` | the build, the parts and the open marks as text, for an agent without torno's tools |

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

2. **Talk.** Click a spot on a part and mark it; marks and the selection reach the agent with the next prompt; `describe`, `marks`, `highlight`, `show`.
3. **Read.** Measure, pinned dimensions, section cuts; `measure`, `section`, `check` for overlap, clearance and mesh.
4. **Scan.** Import a scan, align it, overlay it, check clearance against it.
5. **Show.** Explode, named views, HTML export, adapters for other agent CLIs.

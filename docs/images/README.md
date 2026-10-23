# Images for the README

The README has a place for each of these, commented out until the file is here. Add the file under the name
given, then take the `<!--` and `-->` off its block in `README.md`.

## How to take them

- Run from the repository, not under test: `scripts/torno /tmp/torno-shots` on a copy of the test models
  (`cp -r kernel/tests/fixtures/ws /tmp/torno-shots`), or on a workspace of your own whose parts look like
  something real. A part that looks like a real part (a bracket, a lid, a mount) sells it better than a test cube.
- The window at about 1600 × 1000 points. On a HiDPI screen the picture is twice that, which is right: GitHub
  scales it down.
- The light theme, unless the shot says dark. Nothing personal on screen: no home folder path in the title,
  no account name in the chat, no notifications.
- PNG, cropped to the window (no desktop around it), under 1 MB each (`oxipng -o 4` or `pngquant` if not).
- Alt text is in the README already. If a shot shows something else, change its alt text to match.

## The shots

| # | File | What it shows | How to set it up |
|---|---|---|---|
| 1 | `hero.png` | **The whole window, mid-conversation.** The objects on the left, a part in the middle with two or three marks on it (a red pin with a note, a dimension that passes), the chat on the right with a prompt, the "torno added" line under it and the agent's answer using `look` or `measure`. The status line at the bottom says built. | Open an object, leave a pin and a dimension, start a session and ask "what did I mark?". Wait for the answer, then take the shot. This one matters most: it's the first thing people see. |
| 2 | `marks.png` | **Marks and dimensions.** A part with a pin, an arrow and a dimension, its note open; the Marks list with one dimension "Passes" and one "Fails: 1 under". | Steps 4 and 5 of the walk-through in `docs/manual.md`, with a second dimension set to fail. Crop to the view and the Marks list. |
| 3 | `chat.png` | **The agent's view.** The chat pane only: a prompt, the "torno added" line opened to show the marks as text, and the agent's tool calls (`look`, `measure`) with the picture `look` gave. | After shot 1, open "torno added". Crop to the right column. |
| 4 | `section.png` | **Section.** `hollow` cut in half, the post visible inside the tub, the section bar under the view. | Open `hollow`, press `X`. Turn the camera a little off-axis so the cut reads as 3D. Crop to the view. |
| 5 | `scan.png` | **A scan.** A part shown in a real scan of where it goes (an engine bay, a shelf, a machine), aligned, the scan partly see-through. | Needs a scan of your own (phone or scanner). Import it, align it, set it to about 60 %. Optional: leave it out if no scan looks good. |
| 6 | `objects.png` | **The page of objects.** Several cards with their pictures. | Press `W` in a workspace of five or more objects, each built once so it has a picture. |
| 7 | `export.png` | **An exported page** open in a browser: the part, the marks, nothing else installed. | "Export…", HTML, then open the file in Firefox or Safari. Crop to the browser's page, not its toolbar. |
| 8 | `first-screen.png` | **The first screen**, with "Ready to work" all ready and "Open the example". | Start with no workspace remembered: `TORNO_CONFIG=/tmp/torno-fresh.json scripts/torno`, a config file that does not exist yet. |
| 9 | `hero-dark.png` | **Shot 1 in the dark theme.** Optional. With it, the README can show the dark one to readers whose GitHub is dark (`<picture>` with `prefers-color-scheme`). | The same setup as shot 1, the system in dark mode. |

## A short recording

| # | File | What it shows |
|---|---|---|
| 10 | `demo.mp4` (or `demo.gif`) | **The loop, 20 to 40 seconds.** Pin a face, "too thin here"; ask the agent to fix it; it edits the model; the part rebuilds and the wall is thicker; the dimension turns to "Passes". |

GitHub plays an MP4 that is dragged into an issue or a pull request and the link put in the README; a GIF works
anywhere but is large (keep it under 10 MB, 800 px wide, 10–15 fps). Speed up the agent's thinking in the edit.

## The social preview

| # | File | What it shows |
|---|---|---|
| 11 | `social-preview.png` | **1280 × 640**, for Settings → General → Social preview on GitHub: the logo, "torno", the one-line description, and a crop of shot 1. Not used in the README. |

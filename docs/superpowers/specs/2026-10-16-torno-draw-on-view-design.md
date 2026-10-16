# torno: drawing on the view

Date: 2026-10-16. Status: decided without a review round (the request was a goal to work to, not a conversation);
everything below is open to change.

## What it is for

The person asked for "a way to doodle on top of a view so that we can use that as context for Claude as well".
The design's own evidence (section 1 of `2026-10-08-torno-design.md`) is the same thing seen from the other side:
in the micra-intake session 9 of 22 pictures were screenshots of a viewer with red ink on them, and two freehand
sketches ended misunderstandings that text had not. Marks give the agent the location; a drawing gives it the
gesture: a ring round a feature, a profile beside the part, an arrow, a cross. Torno can give it both at once: the
picture with the ink, and what the ink lies over, by ref.

What the person said: doodle on top of a view, and the agent gets it as context. What is assumed here: the view is
the one on screen; the drawing goes with one prompt of the chat, like "Attach view"; it is not a mark and is kept
nowhere on disk.

Success: in a chat, "Draw on view" opens a board over a picture of the view; the person draws; the next prompt
carries that picture with the ink on it, a caption that says what the ink is, where the view was seen from, and
which faces, parts and scans each stroke lies over.

## Decisions

1. **The ground is the agent's own picture, not the screen.** The board shows the picture `look` would return for
   the view on screen (`view: 'current'`, 1280 px on the long edge: axes, scale bar, mark numbers, no hover, no
   selection, no bars). What is drawn on is exactly what is sent. Drawing over the live viewport was rejected: the
   screen is not the picture (bars over the top, selection, the gizmo), and the camera, a build landing or the
   agent's `show` would move what is under the ink while it is drawn.
2. **One board.** The doodle board of a new object (`ui/onboard/Doodle.tsx`) becomes `ui/Board.tsx`, given its size,
   a ground, its ink and its words. The new object's doodle is a thin wrapper over it, unchanged to the person; the
   drawing on the view is another. Same pens, eraser, Undo, Clear, Done, Cancel, discard question and keys.
3. **The ink is a colour of its own**, `--drawing-ink`: magenta (`#B5127A` light, `#F25FB7` dark), drawn over a
   casing in `--panel` as a mark's lines are, so it reads on any part. Not the person's red: user marks are red in
   the same picture, and nothing but a mark is drawn in a mark's colour. Not an axis colour, not the accent. The
   picture is in the theme of the screen, so the ink is the theme's, read once when the board opens.
4. **What the ink lies over is worked out in the window**, at Done, by picking the view along each stroke (every
   6 board pixels, 64 points a stroke at most) where ink is still left (the eraser is honoured by reading the ink
   layer's alpha). The picture and the canvas share camera and aspect (`setProjection` takes the frustum from the
   camera alone; the extent only sets near and far), so a point of the picture is the same fraction of the canvas.
   Faces only (`edges: false`); where no part is hit, a scan if one is drawn there; else nothing. This is said only
   when the view is still what the picture was made of (a fingerprint of object, revision, layout, camera, canvas
   size, section, explode, parts and scans shown): otherwise the caption says it was not worked out. Each ref
   gets the kernel's descriptor when it comes within 3 s. No coordinate is told: a hit point is of the mesh, and
   only refs and the kernel's descriptors cross to the agent (the exactness rule).
5. **Main words it.** The window sends data (`ViewDrawing` in `shared/drawing.ts`: the PNG, the picture's caption,
   object, revision, layout, camera, size, ink, and per stroke its box in picture pixels with the refs and scans
   under it). Main checks every field (`main/sessions/drawing.ts` `drawingOf`: a PNG of at most 2000 px and
   3.75 MB, a caption of one line, refs of the ref grammar, caps on strokes and refs) and writes the caption
   (`drawingText`). The prompt is the person's text, the caption, the picture: the transcript already shows the
   first text and the pictures, and hides a caption right before a picture.
6. **The revision is said.** The caption names the build the drawing was made on; when the model has been built
   again by the time it is sent, it says so: the refs are of that build.
7. **One prompt, no file.** The drawing waits in the composer (a chip with its thumbnail, "Edit", "Remove") until
   it is sent, then is gone; it is kept per session in the window's store while the pane shows something else, and
   counts as an unsent prompt when the window is closed. Nothing is written under `.torno/` (the chat log keeps
   text only, as for every picture).
8. **Where it is**: "Draw on view" beside "Attach view" in the chat's composer. The terminal view has neither: a
   picture reaches the CLI only through the chat's stream.
9. **Keys**: `board.undo` (`Ctrl+Z`) moves from the scope `newobject` to `sheet`: the board is a sheet wherever it
   is opened. `Esc` is `sheet.close`, as it was.

## What the agent reads

```
Picture: the view as the person saw it when they drew on it, on r3 (view current · layout assembly · parts lid,
base · perspective · 1280×853). The strokes in magenta (#B5127A), cased in a light line, are the person's drawing
over the picture: not the model, and not marks. Marks in it are numbered as in the list of marks.
It was seen from {"position":[…],"target":[…],"up":[0,0,1],"ortho":false,"fov":35,"zoom":1}: mcp__torno__look
with that view draws it again.
Under the ink, stroke by stroke (x and y are pixels of the picture; refs are of r3):
- stroke 1, x 412–630, y 220–301: lid/F12 (plane, normal +Z, z = 20, 1180 mm²), lid/F3 (cylinder, r 3, axis Z); partly over nothing
- stroke 2, x 80–140, y 600–690: over no part
```

## Out of scope

Drawing on a saved view that is not on screen (apply it first); drawing in the terminal view; keeping drawings
as marks or files; telling the agent coordinates of the ink.

## Testing

- `shared/contrast.test.ts`: the ink is 3:1 on the surface and on its casing, and no mark's or axis's colour.
- `ui/drawing/under.test.ts`: samples along a stroke, the eraser's ink left out, refs in order without repeats,
  the caps, the box.
- `main/sessions/drawing.test.ts`: every refusal of `drawingOf`; the caption with and without what is under the
  ink, with a newer build.
- `manager.itest.ts`: a prompt with a drawing reaches the stand-in as text, caption and picture; the user item shows
  the text and the picture; a drawing of another object is refused.
- `e2e/chatask.spec.ts`: "Draw on view" opens the board over a 1280 px picture; a stroke drawn across a part; Done;
  the chip; the stand-in gets one picture of that size and a caption naming a face of that part; the next prompt
  carries none; Edit and Remove; Esc asks before a drawing is thrown away.
- `e2e/onboard.spec.ts` unchanged and passing: the new object's board is the same board.
- `e2e/themes.spec.ts`: a `view-board` state for `TORNO_SHOTS`, to look at in both themes.

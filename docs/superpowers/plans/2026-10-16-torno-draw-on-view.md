# Drawing on the view: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Draw on view" in the chat's composer opens a board over the agent's picture of the view; the drawing goes
with the next prompt as that picture with the ink on it, and a caption that says what the ink lies over by ref.

**Architecture:** The window makes the picture with the same code as `look` (`picture()` in `state/agent.ts`), draws
on it with the new object's board made generic (`ui/board/Board.tsx`), composes the PNG, and picks the view along each
stroke while the screen is still what the picture was made of. It sends a `ViewDrawing` (data) with `chat.send`; main
checks it (`main/sessions/drawing.ts` `drawingOf`), words the caption (`drawingText`) and puts text, caption and
picture into the prompt (`Sessions.sendOne`).

**Tech Stack:** Electron, TypeScript, React, zustand (vanilla stores), three.js picking already in the viewport,
OffscreenCanvas; vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-torno-draw-on-view-design.md`

## Global Constraints

- Never write inside a user workspace except under `<object>/.torno/`; this feature writes nothing at all.
- Images for the agent: long edge at most 2000 px, default 1280 (`checkedImage`: PNG, ≤ 2000 px, ≤ 3.75 MB).
- Nothing but a mark is drawn in `--user-mark` or `--agent-mark`; the ink is `--drawing-ink`.
- No coordinate of the model taken from the mesh is told to the agent: refs and the kernel's descriptors only.
- UI text is sentence case; numbers and refs in the monospace face (`numbered`, class `num`).
- Every key is a row of `shared/keys.ts`; handlers use `pressed`/`which`, never `.key`.
- No per-frame or per-pointer-move state in React; pointer moves draw on the canvas only.
- Tests never open a visible window (`TORNO_TEST=1`), never call `page.screenshot()`, never run the real `claude`.
- `.torno/chat/` holds text only: the picture's data is never logged.
- Commit after every task, message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The view moves while the board is open (the agent's `show`, a build landing, the window resized): the drawing is
   still sent, and the caption says what lies under the ink was not worked out, never refs of another view
   (Task 7 makes `under` null; Task 9's e2e resizes nothing but the unit test of `drawingText` pins the wording).
2. Ink rubbed out with the eraser: what is under rubbed-out ink is not told, and a stroke rubbed out whole is not
   a stroke (Task 5 `underInk` with `inked`).
3. A drawing made, then the model built again before Send: the caption says the refs are of the older build
   (Task 2 `drawingText` with `now.revision`).
4. Sending fails (session ended, picture refused): the drawing is given back to the composer, not lost (Task 8).
5. Closing the window or the workspace with a drawing waiting: closing asks, as for an unsent prompt; a closed
   workspace lets the drawing go (Task 8, `unsentPrompts` and `clearDrafts`).

---

### Task 1: The ink, a colour of its own

**Files:**
- Modify: `app/src/renderer/styles/tokens.css` (light block after `--deviation-inside`, dark block likewise)
- Test: `app/src/shared/contrast.test.ts`

**Interfaces:** Produces the CSS custom property `--drawing-ink` (light `#B5127A`, dark `#F25FB7`).

- [ ] **Step 1: Write the failing test** in `contrast.test.ts`, a helper above `describe.each` and a case inside it:

```ts
/** How far apart two colours are in hue, in degrees: 0 to 180. */
function hueApart(a: string, b: string): number {
  const hue = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    const max = Math.max(r, g, bl)
    const span = max - Math.min(r, g, bl)
    if (span === 0) return 0
    const h = max === r ? (g - bl) / span : max === g ? 2 + (bl - r) / span : 4 + (r - g) / span
    return (h * 60 + 360) % 360
  }
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}
```

```ts
  it('draws the person\'s ink on a picture of the view in a colour of its own, which reads on its casing and on the ground', () => {
    // Drawn, not read: 3:1, as a mark's line is, on its casing in the panel's colour and on the ground.
    for (const ground of ['--panel', '--surface']) expect([ground, contrast(t['--drawing-ink'], t[ground]) >= 3]).toEqual([ground, true])
    // In the same picture as the marks: no mark's colour, nor near one in hue; and no axis's, the accent's or a scan's distance.
    for (const mark of ['--user-mark', '--agent-mark']) expect([mark, hueApart(t['--drawing-ink'], t[mark]) >= 30]).toEqual([mark, true])
    for (const other of ['--axis-x', '--axis-y', '--axis-z', '--accent', '--deviation-near']) expect([other, t['--drawing-ink'] === t[other]]).toEqual([other, false])
  })
```

- [ ] **Step 2: Run, expect FAIL** (`t['--drawing-ink']` undefined): `pnpm -C app exec vitest run src/shared/contrast.test.ts`
- [ ] **Step 3: Add the token** to `tokens.css`, light:

```css
  /* The person's drawing on a picture of the view (the chat's "Draw on view"): drawn over a casing in --panel, as a
     mark's line is. Neither mark colour (user marks are red in the same picture), nor an axis's, nor the accent. */
  --drawing-ink: #B5127A;
```

and in the dark block `--drawing-ink: #F25FB7;`.
- [ ] **Step 4: Run, expect PASS.** Also `pnpm -C app exec vitest run src/renderer/styles` (the stylesheet tests).
- [ ] **Step 5: Commit** `git commit -m "Token --drawing-ink: magenta, for the person's drawing on a picture of the view; held to 3:1 and away from the mark colours"`.

### Task 2: The drawing as data, checked and worded by main

**Files:**
- Create: `app/src/shared/drawing.ts`, `app/src/main/images.ts`, `app/src/main/sessions/drawing.ts`
- Modify: `app/src/main/onboard.ts` (the image check moves to `images.ts`; onboard imports and re-exports it)
- Test: `app/src/main/sessions/drawing.test.ts`

**Interfaces:**
- Produces (`shared/drawing.ts`): `DRAWING_INK_NAME = 'magenta'`, `MOST_STROKES_TOLD = 16`, `MOST_REFS_TOLD = 6`,
  `MOST_SCANS_TOLD = 4`, `interface StrokeUnder { box: [number, number, number, number]; refs: Array<{ ref: string;
  descriptor?: string }>; moreRefs?: number; scans: string[]; bare: boolean }`, `interface ViewDrawing { objectId;
  revision; layout; caption; camera: Camera; png: Uint8Array; width; height; ink; under: StrokeUnder[] | null;
  moreStrokes?: number }`.
- Produces (`main/images.ts`): `MAX_EDGE`, `MAX_IMAGE_BYTES`, `interface ImageBytes`, `checkedImage(bytes: unknown):
  ImageBytes | null` (moved verbatim from `onboard.ts`).
- Produces (`main/sessions/drawing.ts`): `drawingOf(value: unknown): ViewDrawing | string` (a string is the reason to
  refuse), `drawingText(d: ViewDrawing, now: { revision?: number; toolName: (tool: string) => string }): string`.

- [ ] **Step 1: Move `checkedImage`.** Cut `MAX_EDGE`, `MAX_IMAGE_BYTES`, `ImageBytes` and `checkedImage` (with their
  comments) from `onboard.ts` into `main/images.ts` under a header comment ("What main attaches to a prompt as a
  picture…"). In `onboard.ts`: `import { type ImageBytes, MAX_IMAGE_BYTES, checkedImage } from './images'` (what it
  uses) and `export { type ImageBytes, MAX_EDGE, MAX_IMAGE_BYTES, checkedImage } from './images'`. Run
  `pnpm -C app exec vitest run src/main/onboard.test.ts`: PASS.
- [ ] **Step 2: Write `shared/drawing.ts`:**

```ts
import type { Camera } from './view'

// A drawing on the view (the chat's "Draw on view"): the picture the agent's `look` makes of the view on screen, with
// the person's ink on it, and what that ink lies over. The window makes it; main checks it and words it for the agent
// (`main/sessions/drawing.ts`). It goes with one prompt and is kept nowhere.

/** The hue of `--drawing-ink` in both themes, as the agent is told it beside the very colour. */
export const DRAWING_INK_NAME = 'magenta'
/** The most strokes the agent is told of, the most faces of one and the most scans of one; the rest are counted. */
export const MOST_STROKES_TOLD = 16
export const MOST_REFS_TOLD = 6
export const MOST_SCANS_TOLD = 4

/** What one stroke of ink lies over in the picture, where ink is still left of it. */
export interface StrokeUnder {
  /** Its box in pixels of the picture: left, top, right, bottom. */
  box: [number, number, number, number]
  /** The faces under it (`lid/F12`), in the order the stroke first crosses them, each with the kernel's line when it came. */
  refs: Array<{ ref: string; descriptor?: string }>
  /** How many more faces it crosses than `refs` holds. */
  moreRefs?: number
  /** The scans under it where no part is (`S1`). */
  scans: string[]
  /** Some of it lies over no part (nor a scan). */
  bare: boolean
}

/** A drawing on the view, as the window gives it to main with a prompt. */
export interface ViewDrawing {
  objectId: string
  /** The build it was drawn on, and the layout. */
  revision: number
  layout: string
  /** The caption of the picture, as `look` made it. */
  caption: string
  /** Where the view was seen from. */
  camera: Camera
  /** The picture with the ink on it: a PNG of `width` × `height`. */
  png: Uint8Array
  width: number
  height: number
  /** The ink, `#rrggbb`. */
  ink: string
  /** Stroke by stroke, what the ink lies over; null when the screen changed while it was drawn and it could not be said. */
  under: StrokeUnder[] | null
  /** Strokes not in `under`, beyond `MOST_STROKES_TOLD`. */
  moreStrokes?: number
}
```

- [ ] **Step 3: Write the failing tests** `main/sessions/drawing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MOST_REFS_TOLD, MOST_STROKES_TOLD, type ViewDrawing } from '../../shared/drawing'
import { png } from '../../test/pngFixtures'
import { drawingOf, drawingText } from './drawing'

const camera = { position: [100, -100, 80], target: [0, 0, 10], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 }
const given = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  objectId: 'bracket', revision: 3, layout: 'assembly', caption: 'view current · layout assembly · parts base · perspective · 64×48',
  camera, png: new Uint8Array(png(64, 48)), width: 64, height: 48, ink: '#B5127A',
  under: [{ box: [10, 12, 40, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], scans: [], bare: true }],
  ...over
})
const ok = (over: Record<string, unknown> = {}): ViewDrawing => {
  const d = drawingOf(given(over))
  if (typeof d === 'string') throw new Error(d)
  return d
}

describe('drawingOf', () => {
  it('takes a whole drawing, and only what a drawing has', () => {
    const d = ok({ extra: 'dropped' })
    expect(d).toMatchObject({ objectId: 'bracket', revision: 3, layout: 'assembly', width: 64, height: 48, ink: '#B5127A' })
    expect(Object.keys(d).sort()).toEqual(['camera', 'caption', 'height', 'ink', 'layout', 'objectId', 'png', 'revision', 'under', 'width'])
    expect(d.under).toEqual([{ box: [10, 12, 40, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], scans: [], bare: true }])
  })
  it('folds the caption and a descriptor to one line, and cuts a long descriptor', () => {
    const d = ok({ caption: 'view current\n· layout assembly', under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/F1', descriptor: `plane\n${'x'.repeat(300)}` }], scans: [], bare: false }] })
    expect(d.caption).toBe('view current · layout assembly')
    expect(d.under![0].refs[0].descriptor).toHaveLength(200)
    expect(d.under![0].refs[0].descriptor).not.toContain('\n')
  })
  it('takes a drawing whose ink could not be looked under, and the count of strokes not told', () => {
    expect(ok({ under: null }).under).toBeNull()
    expect(ok({ moreStrokes: 3 }).moreStrokes).toBe(3)
  })
  it.each([
    ['not an object', null],
    ['no object', given({ objectId: '' })],
    ['no build', given({ revision: 0 })],
    ['a build that is no count', given({ revision: 1.5 })],
    ['a camera that looks nowhere', given({ camera: { ...camera, target: camera.position } })],
    ['a camera with no projection', given({ camera: { ...camera, ortho: 'no' } })],
    ['a camera beyond reach', given({ camera: { ...camera, position: [1e10, 0, 0] } })],
    ['a picture that is no PNG', given({ png: new Uint8Array([1, 2, 3]) })],
    ['a picture of another size than it says', given({ width: 65 })],
    ['an ink that is no colour', given({ ink: 'red' })],
    ['strokes that are no list', given({ under: 'all of it' })],
    ['too many strokes', given({ under: Array.from({ length: MOST_STROKES_TOLD + 1 }, () => ({ box: [0, 0, 1, 1], refs: [], scans: [], bare: true })) })],
    ['a stroke outside the picture', given({ under: [{ box: [0, 0, 65, 1], refs: [], scans: [], bare: true }] })],
    ['an edge where a face is said', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'base/E3' }], scans: [], bare: false }] })],
    ['a mark where a face is said', given({ under: [{ box: [0, 0, 1, 1], refs: [{ ref: 'M3' }], scans: [], bare: false }] })],
    ['too many faces', given({ under: [{ box: [0, 0, 1, 1], refs: Array.from({ length: MOST_REFS_TOLD + 1 }, (_, i) => ({ ref: `base/F${i + 1}` })), scans: [], bare: false }] })],
    ['a scan that is no scan', given({ under: [{ box: [0, 0, 1, 1], refs: [], scans: ['scan one'], bare: false }] })],
    ['a stroke over something it does not name', given({ under: [{ box: [0, 0, 1, 1], refs: [], scans: [], bare: false }] })],
    ['a count of strokes that is no count', given({ moreStrokes: -1 })]
  ])('refuses %s, saying it could not be sent', (_what, value) => {
    const d = drawingOf(value)
    expect(typeof d).toBe('string')
    expect(d).toMatch(/^The drawing on the view could not be sent: /)
  })
})

describe('drawingText', () => {
  const toolName = (tool: string): string => `mcp__torno__${tool}`
  it('says what the picture is, whose the ink is and its colour, where it was seen from and how to see it again', () => {
    const text = drawingText(ok(), { revision: 3, toolName })
    expect(text).toMatch(/^Picture: the view as the person saw it when they drew on it, on r3 \(view current · layout assembly/)
    expect(text).toContain('The strokes in magenta (#B5127A)')
    expect(text).toContain('not the model, and not marks')
    expect(text).toContain(`It was seen from ${JSON.stringify(camera)}: mcp__torno__look with that as its view draws it again.`)
    expect(text).not.toContain('built again')
  })
  it('says stroke by stroke what the ink lies over: faces with their lines, scans, and what is over no part', () => {
    const text = drawingText(ok({ under: [
      { box: [10.4, 12, 40.6, 30], refs: [{ ref: 'base/F12', descriptor: 'plane, normal +Z, z = 20' }, { ref: 'base/F3' }], moreRefs: 2, scans: ['S1'], bare: true },
      { box: [0, 0, 5, 5], refs: [], scans: ['S1', 'S2'], bare: false },
      { box: [1, 2, 3, 4], refs: [], scans: [], bare: true }
    ], moreStrokes: 1 }), { revision: 3, toolName })
    expect(text).toContain('Under the ink, stroke by stroke (x and y are pixels of the 64×48 picture; faces are of r3):')
    expect(text).toContain('- stroke 1, x 10–41, y 12–30: base/F12 (plane, normal +Z, z = 20), base/F3, and 2 more faces; scan S1 where no part is; partly over no part')
    expect(text).toContain('- stroke 2, x 0–5, y 0–5: over no part: scan S1, S2')
    expect(text).toContain('- stroke 3, x 1–3, y 2–4: over no part')
    expect(text).toContain('(1 more stroke, not told)')
  })
  it('says when the model was built again since it was drawn: the refs are of the build it was drawn on', () => {
    expect(drawingText(ok(), { revision: 5, toolName })).toContain('The model has been built again since: r5 is the latest, and the faces below are of r3: they may name other faces now.')
  })
  it('says when what the ink lies over was not worked out, and when no ink is left', () => {
    expect(drawingText(ok({ under: null }), { revision: 3, toolName })).toContain('What the ink lies over was not worked out: the view on screen changed while it was drawn.')
    expect(drawingText(ok({ under: [] }), { revision: 3, toolName })).toContain('No ink is left on the picture.')
  })
  it('starts no line with a word the stand-in agent would take for a command', () => {
    for (const line of drawingText(ok({ under: null }), { revision: 5, toolName }).split('\n')) expect(line).not.toMatch(/^(say|tool|ask|slow|work|rate|images|garbage)\b/)
  })
})
```

- [ ] **Step 4: Run, expect FAIL** (no module): `pnpm -C app exec vitest run src/main/sessions/drawing.test.ts`
- [ ] **Step 5: Write `main/sessions/drawing.ts`:**

```ts
import { DRAWING_INK_NAME, MOST_REFS_TOLD, MOST_SCANS_TOLD, MOST_STROKES_TOLD, type StrokeUnder, type ViewDrawing } from '../../shared/drawing'
import type { Camera } from '../../shared/view'
import { checkedImage } from '../images'

// A drawing on the view comes from the window with a prompt (`chat:send`): it is checked here field by field, and
// worded for the agent. Nothing of it is written anywhere.

/** A face of a part, as the window's pick names it. */
const FACE = /^[^\s/]{1,200}\/F[1-9][0-9]{0,6}$/
const SCAN = /^S[1-9][0-9]{0,6}$/
const INK = /^#[0-9a-fA-F]{6}$/
/** The longest caption, and object id or layout, taken after folding to one line; a longer descriptor is cut. */
const MAX_CAPTION = 4000
const MAX_NAME = 200
const MAX_DESCRIPTOR = 200
/** Beyond this a coordinate of a camera is no place (as of a saved view). */
const MAX_COORDINATE = 1e9
const NOT = 'The drawing on the view could not be sent'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
/** Every run of white space, line breaks too, as one space. */
const folded = (v: string): string => v.replace(/\s+/g, ' ').trim()
/** A text of one line, `most` characters at most once folded; null for anything else. */
function line(v: unknown, most: number): string | null {
  if (typeof v !== 'string') return null
  const one = folded(v)
  return one !== '' && one.length <= most ? one : null
}

function cameraOf(v: unknown): Camera | null {
  if (!isRecord(v)) return null
  const triple = (t: unknown): [number, number, number] | null => (Array.isArray(t) && t.length === 3 && t.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE) ? [t[0], t[1], t[2]] : null)
  const position = triple(v.position)
  const target = triple(v.target)
  const up = triple(v.up)
  if (!position || !target || !up || typeof v.ortho !== 'boolean') return null
  if (typeof v.fov !== 'number' || !(v.fov >= 1 && v.fov <= 120)) return null
  if (typeof v.zoom !== 'number' || !Number.isFinite(v.zoom) || v.zoom <= 0) return null
  if (position.every((c, i) => c === target[i]) || up.every((c) => c === 0)) return null
  return { position, target, up, ortho: v.ortho, fov: v.fov, zoom: v.zoom }
}

/** One stroke of what the window says is under the ink, within a picture of that size; null when it is not one. */
function strokeOf(v: unknown, width: number, height: number): StrokeUnder | null {
  if (!isRecord(v) || !Array.isArray(v.box) || v.box.length !== 4 || !v.box.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [left, top, right, bottom] = v.box as number[]
  if (left < 0 || top < 0 || right > width || bottom > height || left > right || top > bottom) return null
  if (!Array.isArray(v.refs) || v.refs.length > MOST_REFS_TOLD || !Array.isArray(v.scans) || v.scans.length > MOST_SCANS_TOLD || typeof v.bare !== 'boolean') return null
  if (v.moreRefs !== undefined && !isCount(v.moreRefs)) return null
  const refs: StrokeUnder['refs'] = []
  for (const one of v.refs) {
    if (!isRecord(one) || typeof one.ref !== 'string' || !FACE.test(one.ref)) return null
    const descriptor = typeof one.descriptor === 'string' ? folded(one.descriptor).slice(0, MAX_DESCRIPTOR) : ''
    refs.push(descriptor !== '' ? { ref: one.ref, descriptor } : { ref: one.ref })
  }
  const scans = v.scans
  if (!scans.every((s): s is string => typeof s === 'string' && SCAN.test(s))) return null
  // Over something, and nothing of it named: no stroke the window would say.
  if (refs.length === 0 && scans.length === 0 && !v.bare) return null
  return { box: [left, top, right, bottom], refs, ...(v.moreRefs ? { moreRefs: v.moreRefs } : {}), scans: [...scans], bare: v.bare }
}

/**
 * The drawing the window sent, checked: every field what it says it is, the picture a PNG main may attach and of the
 * size it says, the strokes within it. Otherwise the reason, to refuse the prompt with: then nothing is sent.
 */
export function drawingOf(value: unknown): ViewDrawing | string {
  if (!isRecord(value)) return `${NOT}: it is not one`
  const objectId = line(value.objectId, MAX_NAME)
  const layout = line(value.layout, MAX_NAME)
  const caption = line(value.caption, MAX_CAPTION)
  if (objectId === null || layout === null || caption === null) return `${NOT}: it does not say what it is of`
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) return `${NOT}: it names no build`
  const camera = cameraOf(value.camera)
  if (!camera) return `${NOT}: its camera is not one`
  const image = checkedImage(value.png)
  if (!image || image.mediaType !== 'image/png') return `${NOT}: its picture is not a PNG of at most 2000 px and 3.75 MB`
  if (image.width !== value.width || image.height !== value.height) return `${NOT}: its picture is not of the size it says`
  if (typeof value.ink !== 'string' || !INK.test(value.ink)) return `${NOT}: its ink is not a colour`
  const wrong = `${NOT}: what is under its ink is not said as it should be`
  let under: StrokeUnder[] | null = null
  if (value.under !== null) {
    if (!Array.isArray(value.under) || value.under.length > MOST_STROKES_TOLD) return wrong
    under = []
    for (const one of value.under) {
      const stroke = strokeOf(one, image.width, image.height)
      if (!stroke) return wrong
      under.push(stroke)
    }
  }
  if (value.moreStrokes !== undefined && !isCount(value.moreStrokes)) return wrong
  return { objectId, revision: value.revision, layout, caption, camera, png: image.bytes, width: image.width, height: image.height, ink: value.ink, under, ...(value.moreStrokes ? { moreStrokes: value.moreStrokes } : {}) }
}

/** Where in the picture, as the agent reads it: `412–630`. */
const span = (from: number, to: number): string => `${Math.round(from)}–${Math.round(to)}`
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What one stroke lies over, as a line of the caption. */
function strokeLine(stroke: StrokeUnder, n: number): string {
  const [left, top, right, bottom] = stroke.box
  const faces = stroke.refs.map((r) => (r.descriptor ? `${r.ref} (${r.descriptor})` : r.ref))
  if (stroke.moreRefs) faces.push(`and ${counted(stroke.moreRefs, 'more face', 'more faces')}`)
  const scans = stroke.scans.length > 0 ? `scan ${stroke.scans.join(', ')}` : ''
  let over: string
  if (faces.length > 0) over = `${faces.join(', ')}${scans ? `; ${scans} where no part is` : ''}${stroke.bare ? '; partly over no part' : ''}`
  else if (scans) over = `over no part: ${scans}${stroke.bare ? ', and partly over nothing' : ''}`
  else over = 'over no part'
  return `- stroke ${n}, x ${span(left, right)}, y ${span(top, bottom)}: ${over}`
}

/**
 * What the agent reads right before the picture of a drawing on the view: what the picture is and on which build,
 * which strokes are the person's and in what colour, where it was seen from and how to draw it again, and stroke by
 * stroke what the ink lies over, by ref with the kernel's line. `now.revision` is the object's last build: when it
 * is another, that is said. No line begins with a word the stand-in agent takes for a command.
 */
export function drawingText(d: ViewDrawing, now: { revision?: number; toolName: (tool: string) => string }): string {
  const lines = [
    `Picture: the view as the person saw it when they drew on it, on r${d.revision} (${d.caption}). The strokes in ${DRAWING_INK_NAME} (${d.ink}), each edged by a thin line, are the person's drawing over the picture: not the model, and not marks. The marks in it are torno's, numbered as in the list of marks.`,
    `It was seen from ${JSON.stringify(d.camera)}: ${now.toolName('look')} with that as its view draws it again.`
  ]
  const faces = d.under !== null && d.under.some((s) => s.refs.length > 0)
  if (now.revision !== undefined && now.revision !== d.revision) lines.push(`The model has been built again since: r${now.revision} is the latest${faces ? `, and the faces below are of r${d.revision}: they may name other faces now` : ''}.`)
  if (d.under === null) lines.push('What the ink lies over was not worked out: the view on screen changed while it was drawn.')
  else if (d.under.length === 0) lines.push('No ink is left on the picture.')
  else {
    lines.push(`Under the ink, stroke by stroke (x and y are pixels of the ${d.width}×${d.height} picture; faces are of r${d.revision}):`)
    d.under.forEach((stroke, i) => lines.push(strokeLine(stroke, i + 1)))
    if (d.moreStrokes) lines.push(`(${counted(d.moreStrokes, 'more stroke', 'more strokes')}, not told)`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 6: Run, expect PASS**; then `pnpm -C app typecheck`.
- [ ] **Step 7: Commit** `"A drawing on the view as data (shared/drawing.ts); main checks it (drawingOf) and words it for the agent (drawingText); checkedImage moves to main/images.ts"`.

### Task 3: A prompt carries a drawing

**Files:**
- Modify: `app/src/shared/bridge.ts` (`chat.send`), `app/src/main/ipc.ts` (`chat:send`), `app/src/main/sessions/manager.ts` (`send`, `sendOne`)
- Test: `app/src/main/sessions/manager.itest.ts`

**Interfaces:**
- Consumes: `drawingOf`, `drawingText`, `ViewDrawing` (Task 2).
- Produces: `window.torno.chat.send(sessionId, { text, attachView?, drawing?: ViewDrawing })`; `Sessions.send(id, { text, attachView?, drawing? })`.

- [ ] **Step 1: Write the failing itests** in the transcript `describe` of `manager.itest.ts`, after "sends nothing, and says why, when the picture cannot be made"; widen `send`'s `extra` to `{ attachView?: boolean; drawing?: ViewDrawing }`:

```ts
  const drawingFor = (objectId: string, revision = 1): ViewDrawing => ({
    objectId, revision, layout: 'assembly', caption: 'view current · layout assembly · parts a · perspective · 4×4',
    camera: { position: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], ortho: false, fov: 35, zoom: 1 },
    png: new Uint8Array(PNG_4X4), width: 4, height: 4, ink: '#B5127A',
    under: [{ box: [0, 0, 3, 3], refs: [{ ref: 'a/F1', descriptor: 'plane, normal +Z' }], scans: [], bare: true }]
  })

  it('adds a drawing on the view to the prompt: the text, the caption, then the picture; the prompt shows the text and the picture', async () => {
    const c = await start()
    await c.send('images', { drawing: drawingFor(c.obj.id) })
    const user = c.items()[0] as { kind: string; text: string; images: Array<{ width?: number; height?: number }> }
    expect(user).toMatchObject({ kind: 'user', text: 'images' })
    expect(user.images).toEqual([expect.objectContaining({ width: 4, height: 4 })])
    await expect.poll(() => c.turns(), { timeout: 5000 }).toBe(1)
    // The stand-in says what came: one picture, and each line of the caption (a line that is no command is said).
    const said = c.items().filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text)
    expect(said).toContain('images: 1 4x4')
    expect(said.some((t) => t.startsWith('Picture: the view as the person saw it when they drew on it, on r1'))).toBe(true)
    expect(said).toContain('- stroke 1, x 0–3, y 0–3: a/F1 (plane, normal +Z); partly over no part')
  })

  it('refuses a drawing of another object than the session is of, sending nothing', async () => {
    const c = await start()
    await expect(c.send('images', { drawing: drawingFor('another') })).rejects.toThrow('The drawing is of another, not of')
    expect(c.items()).toEqual([])
  })
```

Import `type ViewDrawing` from `'../../shared/drawing'` at the top of the itest.
- [ ] **Step 2: Run, expect FAIL**: `pnpm -C app exec vitest run --mode kernel src/main/sessions/manager.itest.ts -t drawing`
- [ ] **Step 3: Implement.** `bridge.ts`:

```ts
    /**
     * Sends a prompt; with `attachView`, main adds a picture of the viewport as the person sees it now; with `drawing`,
     * the person's drawing on the view, after a caption main writes. Rejects, sending nothing, when a picture cannot be
     * made or the drawing is not one.
     */
    send(sessionId: string, prompt: { text: string; attachView?: boolean; drawing?: ViewDrawing }): Promise<void>
```

(`import type { ViewDrawing } from './drawing'`). `ipc.ts` (`import { drawingOf } from './sessions/drawing'`):

```ts
  handle('chat:send', async (_event, sessionId: string, prompt: { text?: unknown; attachView?: unknown; drawing?: unknown }) => {
    if (!ofThisWorkspace(String(sessionId))) throw new Refusal('This session has ended')
    if (typeof prompt?.text !== 'string' || prompt.text.length > MAX_PROMPT_CHARS) throw new Refusal('Nothing to send')
    // The window's drawing is taken only once it is what one is: main words what the agent reads of it.
    const drawing = prompt.drawing === undefined ? undefined : drawingOf(prompt.drawing)
    if (typeof drawing === 'string') throw new Refusal(drawing)
    await requireSessions().send(String(sessionId), { text: prompt.text, attachView: prompt.attachView === true, ...(drawing ? { drawing } : {}) })
  })
```

`manager.ts` (`import type { ViewDrawing } from '../../shared/drawing'`, `import { drawingText } from './drawing'`): both
`send` and `sendOne` take `prompt: { text: string; attachView?: boolean; drawing?: ViewDrawing }`; the doc of `send`
adds "and the person's drawing on the view after its caption when `drawing`"; in `sendOne`, right after the text block:

```ts
    if (prompt.drawing) {
      // Drawn on the view of this session's object, or not sent.
      if (prompt.drawing.objectId !== s.object.id) throw new Error(`The drawing is of another, not of ${s.object.id}`)
      // What the agent reads of it right before it: the transcript shows the text and the picture, not a caption.
      content.push({ type: 'text', text: drawingText(prompt.drawing, { revision: this.deps.build?.(s.object.id)?.revision, toolName: this.deps.adapter.toolName }) })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(prompt.drawing.png).toString('base64') } })
    }
```

- [ ] **Step 4: Run, expect PASS**; `pnpm -C app typecheck`.
- [ ] **Step 5: Commit** `"A chat prompt carries a drawing on the view: main checks it in chat:send and puts the text, its caption and its picture in the prompt"`.

### Task 4: One board for a doodle and a drawing

**Files:**
- Move: `app/src/renderer/ui/onboard/strokes.ts` → `app/src/renderer/ui/board/strokes.ts` (`git mv`); update imports in `ui/onboard/Doodle.tsx`, `ui/onboard/images.test.ts`
- Create: `app/src/renderer/ui/board/Board.tsx`, `app/src/renderer/ui/board/strokes.test.ts`
- Modify: `app/src/renderer/ui/onboard/Doodle.tsx` (a wrapper over `Board`), `app/src/renderer/styles/onboard.css` (board canvas aspect, ground, problem line), `app/src/shared/keys.ts` (`board.undo` to scope `sheet`), `README.md` (keys table, written by the readme test)

**Interfaces:**
- Produces (`ui/board/strokes.ts`): `CASING_PX = 2`, `interface InkLook { ink: string; casing?: string }`,
  `paintStroke(ctx, stroke, look: InkLook, from = 0)`, `paintStrokes(ctx, strokes, look: InkLook)` (clears the
  context's own canvas size); `BOARD`, `PEN_WIDTHS`, `ERASER_WIDTH`, `addPoint`, `doodlePng` as before.
- Produces (`ui/board/Board.tsx`): `Board(props: BoardProps)` with `title`, `label`, `hint`, `size`, `ground?: string`
  (object URL), `look: () => InkLook`, `initial: Stroke[]`, `discard: { label: string; text: string }`,
  `onDone: (strokes: Stroke[]) => Promise<void>`, `onCancel: () => void`.

- [ ] **Step 1: Write the failing test** `ui/board/strokes.test.ts` with a context that records what is drawn:

```ts
import { describe, expect, it } from 'vitest'
import type { Stroke } from '../../state/onboard'
import { CASING_PX, paintStroke, paintStrokes } from './strokes'

/** A 2D context that writes down what is drawn with it. */
function recorder(width = 120, height = 80) {
  const ops: string[] = []
  const ctx = {
    canvas: { width, height }, lineWidth: 1, strokeStyle: '', fillStyle: '', globalCompositeOperation: 'source-over', lineCap: '', lineJoin: '',
    save: () => void ops.push('save'), restore: () => void ops.push('restore'), beginPath: () => {},
    moveTo: (x: number, y: number) => void ops.push(`move ${x},${y}`), lineTo: (x: number, y: number) => void ops.push(`line ${x},${y}`),
    arc: () => void ops.push('arc'),
    fill(this: { fillStyle: string; lineWidth: number }) { ops.push(`fill ${this.fillStyle}`) },
    stroke(this: { strokeStyle: string; lineWidth: number; globalCompositeOperation: string }) { ops.push(`stroke ${this.strokeStyle} ${this.lineWidth} ${this.globalCompositeOperation}`) },
    clearRect: (x: number, y: number, w: number, h: number) => void ops.push(`clear ${x},${y},${w},${h}`)
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops }
}
const pen = (points: Array<[number, number]>, width = 3): Stroke => ({ tool: 'pen', width, points })

describe('paintStroke', () => {
  it('draws a pen in its ink alone when there is no casing', () => {
    const { ctx, ops } = recorder()
    paintStroke(ctx, pen([[0, 0], [10, 0]]), { ink: '#111111' })
    expect(ops.filter((o) => o.startsWith('stroke'))).toEqual(['stroke #111111 3 source-over'])
  })
  it('draws the casing under the ink, wider on each side', () => {
    const { ctx, ops } = recorder()
    paintStroke(ctx, pen([[0, 0], [10, 0]]), { ink: '#b5127a', casing: '#fafaf6' })
    expect(ops.filter((o) => o.startsWith('stroke'))).toEqual([`stroke #fafaf6 ${3 + 2 * CASING_PX} source-over`, 'stroke #b5127a 3 source-over'])
  })
  it('draws what was added from a point back, the ink from one further back, so that the casing covers no ink drawn before', () => {
    const { ctx, ops } = recorder()
    paintStroke(ctx, pen([[0, 0], [10, 0], [20, 0], [30, 0]]), { ink: '#b5127a', casing: '#fafaf6' }, 3)
    const moves = ops.filter((o) => o.startsWith('move'))
    expect(moves).toEqual(['move 20,0', 'move 10,0'])
  })
  it('rubs out with the eraser, and never cases it', () => {
    const { ctx, ops } = recorder()
    paintStroke(ctx, { tool: 'eraser', width: 28, points: [[0, 0], [10, 0]] }, { ink: '#b5127a', casing: '#fafaf6' })
    expect(ops.filter((o) => o.startsWith('stroke'))).toEqual(['stroke #b5127a 28 destination-out'])
  })
  it('draws a stroke of one point as a dot, cased', () => {
    const { ctx, ops } = recorder()
    paintStroke(ctx, pen([[5, 5]]), { ink: '#b5127a', casing: '#fafaf6' })
    expect(ops.filter((o) => o.startsWith('fill'))).toEqual(['fill #fafaf6', 'fill #b5127a'])
  })
})

it('paints every stroke on a canvas cleared to its own size', () => {
  const { ctx, ops } = recorder(1280, 853)
  paintStrokes(ctx, [pen([[0, 0], [1, 1]]), pen([[2, 2], [3, 3]])], { ink: '#111111' })
  expect(ops[0]).toBe('clear 0,0,1280,853')
  expect(ops.filter((o) => o.startsWith('stroke'))).toHaveLength(2)
})
```

- [ ] **Step 2: `git mv` strokes.ts, run, expect FAIL** (`CASING_PX` missing; `paintStroke` takes a string):
  `pnpm -C app exec vitest run src/renderer/ui/board`
- [ ] **Step 3: Change `ui/board/strokes.ts`:** add `CASING_PX`, `InkLook`; replace `paintStroke` and `paintStrokes`:

```ts
/** How much wider a casing is than its line, on each side, in board pixels. */
export const CASING_PX = 2
/** How strokes are drawn: in their ink, over a casing when there is one (as a mark's line is). */
export interface InkLook { ink: string; casing?: string }

/**
 * Draws one stroke (or the rest of one, from point `from`): a pen in the ink, over its casing when there is one; the
 * eraser takes away what is under it, casing and all. What is added is drawn from a point back, and its ink from one
 * further back, so that the casing of what is added does not cover the end of the ink drawn before.
 */
export function paintStroke(ctx: Ctx, stroke: Stroke, look: InkLook, from = 0): void {
  const points = stroke.points
  if (points.length === 0 || from >= points.length) return
  const pen = stroke.tool !== 'eraser'
  const cased = pen && look.casing !== undefined
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.globalCompositeOperation = pen ? 'source-over' : 'destination-out'
  if (cased) trace(ctx, points, Math.max(0, from - 1), stroke.width + 2 * CASING_PX, look.casing!)
  trace(ctx, points, Math.max(0, from - (cased ? 2 : 1)), stroke.width, look.ink)
  ctx.restore()
}

/** One colour along the points from `start`; a stroke of one point is a dot. */
function trace(ctx: Ctx, points: Stroke['points'], start: number, width: number, colour: string): void {
  ctx.lineWidth = width
  ctx.strokeStyle = colour
  ctx.fillStyle = colour
  ctx.beginPath()
  if (points.length === 1) {
    ctx.arc(points[0][0], points[0][1], width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.moveTo(points[start][0], points[start][1])
  for (let i = start + 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1])
  ctx.stroke()
}

/** All the strokes, in order, on the canvas cleared. */
export function paintStrokes(ctx: Ctx, strokes: readonly Stroke[], look: InkLook): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  for (const stroke of strokes) paintStroke(ctx, stroke, look)
}
```

In `doodlePng`: `paintStrokes(layer.getContext('2d')!, strokes, { ink: PNG_INK })`. Header comment: "A board draws
strokes (a new object's doodle, a drawing on the view)…".
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Write `ui/board/Board.tsx`** from `ui/onboard/Doodle.tsx`: the same component with these changes,
  the rest (keys, focus, Tab round, discard question, pointer handlers) kept as it is:
  - props `BoardProps` (Interfaces above); `hint` destructured as `hint: words` (the key helper `hint` is imported);
  - `inkNow()` calls become `look()`; `paintStrokes(ctx, strokes.current, look())`, `paintStroke(ctx, stroke, look())`,
    `paintStroke(ctx, d.stroke, look(), d.painted)`;
  - `BOARD.width/height` become `size.width/height`;
  - `done`: `await onDone(strokes.current)`; on rejection `saved.current = false`, `setSaving(false)` and
    `setProblem(message)`; `const [problem, setProblem] = useState<string | null>(null)`; the foot shows
    `<p className="board-problem" role="alert">{problem}</p>` in place of the size while there is one;
  - the head: `<h2>{title}</h2><p className="board-hint">{words}</p>`; the sheet's `aria-label={label}`; the question
    `label={discard.label}` with `{discard.text}`;
  - the canvas: `style={{ '--board-aspect': String(size.width / size.height), ...(ground ? { backgroundImage: \`url("${ground}")\` } : {}) } as CSSProperties}`
    and `data-ground={ground ? '' : undefined}`; the foot's size `{size.width} × {size.height}`.
  The doc comment: "A board to draw on: a sheet over the window with a canvas of `size` board pixels, scaled to fit,
  on the panel's ground or on a picture (`ground`), which the eraser leaves alone…".
- [ ] **Step 6: `Doodle.tsx` becomes the wrapper:**

```tsx
import type { Stroke } from '../../state/onboard'
import { Board } from '../board/Board'
import { BOARD, doodlePng } from '../board/strokes'

/** The ink as the theme has it now: the board's strokes are drawn in it; the PNG is made in its own. */
const inkNow = (): string => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#22252A'

/**
 * The doodle board of a new object: 1200 x 800 board pixels on the panel's ground, in the theme's ink. "Done" gives
 * the strokes back with the PNG made of them, dark on white whatever the theme (`doodlePng`).
 */
export function Doodle({ initial, onDone, onCancel }: { initial: Stroke[]; onDone: (strokes: Stroke[], png: Uint8Array) => void; onCancel: () => void }) {
  return (
    <Board
      title="Doodle"
      label="Doodle board"
      hint="Draw what you mean: a shape, where it goes, a size. Claude sees it as a picture."
      size={BOARD}
      look={() => ({ ink: inkNow() })}
      initial={initial}
      discard={{ label: 'Discard this doodle?', text: 'Discard this doodle? What was drawn since it was opened is not kept.' }}
      onDone={async (strokes) => onDone(strokes, await doodlePng(strokes))}
      onCancel={onCancel}
    />
  )
}
```

- [ ] **Step 7: CSS** in `onboard.css` (header comment: "the board, a sheet over the window: a new object's doodle,
  a drawing on the view"): `.board-canvas` takes `width: min(100%, calc((100vh - 230px) * var(--board-aspect, 1.5)));`
  and `aspect-ratio: var(--board-aspect, 1.5);`, and:

```css
/* A picture under the ink (a drawing on the view): stretched to the board, which is its very size. */
.board-canvas[data-ground] {
  background-size: 100% 100%;
  background-repeat: no-repeat;
}

.board-problem {
  margin-right: auto;
  color: var(--fail);
  font-size: var(--text-small);
}
```

- [ ] **Step 8: Keys.** In `shared/keys.ts` remove the `board.undo` row from the New object group and add after
  `sheet.close`: `row('board.undo', ['Ctrl+Z'], 'Drawing board (a doodle, or a drawing on the view): undo the last stroke', 'In a field, a menu or a sheet', 'sheet'),`;
  in the `KeyScope` comment `newobject` is "on the page of a new object". Write the README table:
  `TORNO_README=write pnpm -C app exec vitest run src/readme.test.ts`.
- [ ] **Step 9: Run** `pnpm -C app exec vitest run src/shared/keys.test.ts src/readme.test.ts src/renderer` and
  `pnpm -C app typecheck`: PASS. The new object's board is held by `e2e/onboard.spec.ts` (run in Task 10).
- [ ] **Step 10: Commit** `"One board for a new object's doodle and a drawing on the view (ui/board/Board.tsx): its size, a ground, its ink and a casing; Ctrl+Z is a sheet's key"`.

### Task 5: What the ink lies over, in pure functions

**Files:**
- Create: `app/src/renderer/ui/drawing/under.ts`, `app/src/renderer/ui/drawing/under.test.ts`

**Interfaces:**
- Consumes: `Stroke` (`state/onboard.ts`), `StrokeUnder`, `MOST_STROKES_TOLD`, `MOST_REFS_TOLD`, `MOST_SCANS_TOLD`.
- Produces: `SAMPLE_STEP = 6`, `MOST_SAMPLES = 48`, `type Under = { ref: string } | { scan: string } | null`,
  `samplesOf(points, step?, most?): Array<[number, number]>`, `boxOf(stroke, size): [number, number, number, number]`,
  `strokeUnder(box, found: readonly Under[]): StrokeUnder`, `underInk(strokes, size, inked: (x: number, y: number) =>
  boolean, look: (points: Array<[number, number]>) => Under[]): { under: StrokeUnder[]; more: number }`.

- [ ] **Step 1: Write the failing test** `under.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MOST_REFS_TOLD, MOST_STROKES_TOLD } from '../../../shared/drawing'
import type { Stroke } from '../../state/onboard'
import { MOST_SAMPLES, boxOf, samplesOf, strokeUnder, underInk } from './under'

const pen = (points: Array<[number, number]>, width = 3): Stroke => ({ tool: 'pen', width, points })
const size = { width: 200, height: 100 }

describe('samplesOf', () => {
  it('is a point every step along the stroke, the first and the last with them', () => {
    expect(samplesOf([[0, 0], [30, 0]], 6)).toEqual([[0, 0], [6, 0], [12, 0], [18, 0], [24, 0], [30, 0]])
    expect(samplesOf([[0, 0], [10, 0], [10, 10]], 6)).toEqual([[0, 0], [6, 0], [10, 2], [10, 8], [10, 10]])
  })
  it('is the one point of a dot', () => {
    expect(samplesOf([[5, 7]])).toEqual([[5, 7]])
  })
  it('is at most so many points, spread evenly, the first and the last kept', () => {
    const many = samplesOf([[0, 0], [6000, 0]], 6)
    expect(many).toHaveLength(MOST_SAMPLES)
    expect(many[0]).toEqual([0, 0])
    expect(many.at(-1)).toEqual([6000, 0])
  })
})

it('boxes a stroke with half its width round it, within the picture, in whole pixels', () => {
  expect(boxOf(pen([[10.2, 20], [50, 30.6]], 4), size)).toEqual([8, 18, 52, 33])
  expect(boxOf(pen([[1, 1], [199, 99]], 9), size)).toEqual([0, 0, 200, 100])
})

describe('strokeUnder', () => {
  it('names the faces in the order first crossed, each once; the scans; and whether some lies over nothing', () => {
    expect(strokeUnder([0, 0, 1, 1], [{ ref: 'a/F2' }, { ref: 'a/F2' }, null, { ref: 'b/F1' }, { ref: 'a/F2' }, { scan: 'S1' }])).toEqual({ box: [0, 0, 1, 1], refs: [{ ref: 'a/F2' }, { ref: 'b/F1' }], scans: ['S1'], bare: true })
  })
  it('counts the faces beyond the most it names', () => {
    const found = Array.from({ length: MOST_REFS_TOLD + 3 }, (_, i) => ({ ref: `a/F${i + 1}` }))
    const under = strokeUnder([0, 0, 1, 1], found)
    expect(under.refs).toHaveLength(MOST_REFS_TOLD)
    expect(under.moreRefs).toBe(3)
  })
})

describe('underInk', () => {
  const look = (points: Array<[number, number]>) => points.map(([x]) => (x < 100 ? { ref: 'a/F1' } : null))
  it('looks under the pen strokes only, where ink is left', () => {
    const strokes: Stroke[] = [pen([[10, 50], [190, 50]]), { tool: 'eraser', width: 28, points: [[150, 50], [190, 50]] }]
    const { under, more } = underInk(strokes, size, (x) => x < 140, look)
    expect(more).toBe(0)
    expect(under).toEqual([{ box: [8, 48, 192, 52], refs: [{ ref: 'a/F1' }], scans: [], bare: true }])
  })
  it('tells no stroke of which no ink is left', () => {
    expect(underInk([pen([[10, 50], [90, 50]])], size, () => false, look).under).toEqual([])
  })
  it('tells at most so many strokes, and counts the rest', () => {
    const strokes = Array.from({ length: MOST_STROKES_TOLD + 2 }, (_, i) => pen([[i, 10], [i, 20]]))
    const { under, more } = underInk(strokes, size, () => true, look)
    expect(under).toHaveLength(MOST_STROKES_TOLD)
    expect(more).toBe(2)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**: `pnpm -C app exec vitest run src/renderer/ui/drawing`
- [ ] **Step 3: Write `under.ts`:**

```ts
import { MOST_REFS_TOLD, MOST_SCANS_TOLD, MOST_STROKES_TOLD, type StrokeUnder } from '../../../shared/drawing'
import type { Stroke } from '../../state/onboard'

// What the person's ink lies over in a drawing on the view: points along each pen stroke where ink is still left,
// looked under in the view (the caller picks there), and said per stroke as faces, scans and what is over nothing.

/** Board pixels between two points looked under along a stroke, and the most points of one stroke looked under. */
export const SAMPLE_STEP = 6
export const MOST_SAMPLES = 48

/** What is under a point of the view: a face of a part, a scan where no part is, or nothing. */
export type Under = { ref: string } | { scan: string } | null

/** Points `step` apart along a stroke, its first and last among them; at most `most`, spread evenly. */
export function samplesOf(points: ReadonlyArray<readonly [number, number]>, step = SAMPLE_STEP, most = MOST_SAMPLES): Array<[number, number]> {
  if (points.length === 0) return []
  const out: Array<[number, number]> = [[points[0][0], points[0][1]]]
  let carried = 0
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const length = Math.hypot(bx - ax, by - ay)
    let at = step - carried
    while (at <= length) {
      const t = at / length
      out.push([Math.round((ax + (bx - ax) * t) * 10) / 10, Math.round((ay + (by - ay) * t) * 10) / 10])
      at += step
    }
    carried = length - (at - step)
  }
  const last = points[points.length - 1]
  const end = out[out.length - 1]
  if (points.length > 1 && (end[0] !== last[0] || end[1] !== last[1])) out.push([last[0], last[1]])
  if (out.length <= most) return out
  return Array.from({ length: most }, (_, i) => out[Math.round((i * (out.length - 1)) / (most - 1))])
}

/** The box of a stroke, half its width round its points, within the picture, in whole pixels: left, top, right, bottom. */
export function boxOf(stroke: Stroke, size: { width: number; height: number }): [number, number, number, number] {
  const half = stroke.width / 2
  const xs = stroke.points.map((p) => p[0])
  const ys = stroke.points.map((p) => p[1])
  return [Math.max(0, Math.floor(Math.min(...xs) - half)), Math.max(0, Math.floor(Math.min(...ys) - half)), Math.min(size.width, Math.ceil(Math.max(...xs) + half)), Math.min(size.height, Math.ceil(Math.max(...ys) + half))]
}

/** What one stroke lies over, from what is under each of its points: faces in the order first crossed, the scans, and whether any is over nothing. */
export function strokeUnder(box: [number, number, number, number], found: readonly Under[]): StrokeUnder {
  const faces: string[] = []
  const scans: string[] = []
  let bare = false
  for (const one of found) {
    if (one === null) bare = true
    else if ('ref' in one) {
      if (!faces.includes(one.ref)) faces.push(one.ref)
    } else if (!scans.includes(one.scan)) scans.push(one.scan)
  }
  const more = faces.length - MOST_REFS_TOLD
  return { box, refs: faces.slice(0, MOST_REFS_TOLD).map((ref) => ({ ref })), ...(more > 0 ? { moreRefs: more } : {}), scans: scans.slice(0, MOST_SCANS_TOLD), bare }
}

/**
 * Stroke by stroke, what the ink lies over: pen strokes only, at their points where ink is still left (`inked`: what
 * the eraser took is not looked under); a stroke of which no ink is left is no stroke. At most `MOST_STROKES_TOLD`,
 * the rest counted. `look` is given points of the picture, in its pixels.
 */
export function underInk(
  strokes: readonly Stroke[],
  size: { width: number; height: number },
  inked: (x: number, y: number) => boolean,
  look: (points: Array<[number, number]>) => Under[]
): { under: StrokeUnder[]; more: number } {
  const under: StrokeUnder[] = []
  let more = 0
  for (const stroke of strokes) {
    if (stroke.tool !== 'pen') continue
    const points = samplesOf(stroke.points).filter(([x, y]) => inked(x, y))
    if (points.length === 0) continue
    if (under.length >= MOST_STROKES_TOLD) {
      more += 1
      continue
    }
    under.push(strokeUnder(boxOf(stroke, size), look(points)))
  }
  return { under, more }
}
```

- [ ] **Step 4: Run, expect PASS** (adjust the expected samples in the test only if the walk's arithmetic is right and
  the expectation was not: the second example's corner point `[10, 2]` is 6 px from `[6, 0]` along the path).
- [ ] **Step 5: Commit** `"What the ink of a drawing lies over: points along each pen stroke where ink is left, said per stroke as faces, scans and what is over no part"`.

### Task 6: The viewport says what is under a point, and what it shows

**Files:**
- Create: `app/src/renderer/state/drawing.ts` (the store, the host registration, the simple actions)
- Modify: `app/src/renderer/ui/ViewportPane.tsx` (`setViewHost` in `connect`, `null` in its teardown)

**Interfaces:**
- Consumes: `Under` (Task 5); `Viewport.pick(x, y, { edges: false })`, `Viewport.pickScan`, `getCamera`, `scanState`, `exploded`; `explodeNow`, `visibleKeys`, `store`.
- Produces (`state/drawing.ts`): `interface ViewHost { camera(): Camera; shows(): string; under(points: ReadonlyArray<readonly [number, number]>): Under[] }`,
  `setViewHost(h)`, `viewHost(): ViewHost | null`, `interface Pictured`, `interface Drawn`, `drawingStore`,
  `useDrawing(pick)`, `drawingActions: { openOn(sessionId, picture), edit(sessionId), cancel(), keep(sessionId, drawn), remove(sessionId), taken(sessionId), giveBack(sessionId, drawn), spent(drawn), clear() }`,
  `drawingWaits(sessionId): boolean`.

- [ ] **Step 1: Write `state/drawing.ts`:**

```ts
import { useStore as useZustand } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ViewDrawing } from '../../shared/drawing'
import type { Camera } from '../../shared/view'
import type { Under } from '../ui/drawing/under'
import type { Stroke } from './onboard'

// A drawing on the view (the chat's "Draw on view"): the board open over a picture of the view, and by session the
// drawing that goes with its next prompt. Nothing of it is on disk; a closed workspace lets it go. What makes a
// picture and a drawing is `ui/drawing/make.ts`.

/** What the viewport tells of itself for a drawing, while there is one (`ui/ViewportPane.tsx`). */
export interface ViewHost {
  /** The camera on screen. */
  camera(): Camera
  /** What the screen shows, as one string: while it is the same, a point of the canvas is over what it was. */
  shows(): string
  /** What is under each point of the canvas, given as fractions of its width and height: faces only, then scans. */
  under(points: ReadonlyArray<readonly [number, number]>): Under[]
}

let host: ViewHost | null = null
export function setViewHost(of: ViewHost | null): void {
  host = of
}
export function viewHost(): ViewHost | null {
  return host
}

/** The picture a drawing is made on: the agent's picture of the view, with what it is of. */
export interface Pictured {
  /** The PNG, as an object URL for the board's ground, and decoded for the drawing's picture. */
  url: string
  bitmap: ImageBitmap
  width: number
  height: number
  objectId: string
  revision: number
  layout: string
  caption: string
  camera: Camera
  /** The ink and its casing, read from the theme the picture was made in. */
  ink: string
  casing: string
  /** What the screen showed as the picture was made; null when it changed meanwhile. */
  shows: string | null
}

/** A drawing done, waiting for its prompt: the picture and the strokes (to open it again), what goes, and a thumbnail. */
export interface Drawn { picture: Pictured; strokes: Stroke[]; drawing: ViewDrawing; thumb: string }

interface DrawingState {
  /** The board open: for which session, on which picture, with what drawn when it was opened. */
  board: { sessionId: string; picture: Pictured; strokes: Stroke[] } | null
  /** By session: the drawing that goes with its next prompt. */
  drawn: Record<string, Drawn>
  /** The session a picture is being made for. */
  opening: string | null
}

export const drawingStore = createStore<DrawingState>(() => ({ board: null, drawn: {}, opening: null }))

export function useDrawing<T>(pick: (s: DrawingState) => T): T {
  return useZustand(drawingStore, pick)
}

/** Lets go of a picture that no board and no drawing holds. */
function release(p: Pictured): void {
  const s = drawingStore.getState()
  if (s.board?.picture === p || Object.values(s.drawn).some((d) => d.picture === p)) return
  URL.revokeObjectURL(p.url)
  p.bitmap.close()
}

function without(sessionId: string): void {
  drawingStore.setState((s) => {
    const drawn = { ...s.drawn }
    delete drawn[sessionId]
    return { drawn }
  })
}

export const drawingActions = {
  /** A picture is being made for a session (null: no longer). */
  opening(sessionId: string | null): void {
    drawingStore.setState({ opening: sessionId })
  },
  /** The board, over this picture, for this session. */
  openOn(sessionId: string, picture: Pictured): void {
    drawingStore.setState({ board: { sessionId, picture, strokes: [] } })
  },
  /** The board again over the drawing that waits, with its strokes. */
  edit(sessionId: string): void {
    const s = drawingStore.getState()
    const d = s.drawn[sessionId]
    if (!d || s.board || s.opening) return
    drawingStore.setState({ board: { sessionId, picture: d.picture, strokes: d.strokes } })
  },
  /** The board put away; what waited before it was opened still waits. */
  cancel(): void {
    const board = drawingStore.getState().board
    if (!board) return
    drawingStore.setState({ board: null })
    release(board.picture)
  },
  /** The board put away, and this drawing waits for the session's next prompt, in place of any that did. */
  keep(sessionId: string, d: Drawn): void {
    const before = drawingStore.getState().drawn[sessionId]
    drawingStore.setState((s) => ({ board: null, drawn: { ...s.drawn, [sessionId]: d } }))
    if (before && before !== d) drawingActions.spent(before)
  },
  remove(sessionId: string): void {
    const d = drawingStore.getState().drawn[sessionId]
    if (!d) return
    without(sessionId)
    drawingActions.spent(d)
  },
  /** The drawing that goes with the prompt being sent: no longer waiting. */
  taken(sessionId: string): Drawn | undefined {
    const d = drawingStore.getState().drawn[sessionId]
    if (d) without(sessionId)
    return d
  },
  /** A prompt that was not sent: its drawing waits again, unless another was drawn meanwhile. */
  giveBack(sessionId: string, d: Drawn): void {
    if (drawingStore.getState().drawn[sessionId]) return drawingActions.spent(d)
    drawingStore.setState((s) => ({ drawn: { ...s.drawn, [sessionId]: d } }))
  },
  /** Done with: what it holds of the window's memory is let go. */
  spent(d: Drawn): void {
    URL.revokeObjectURL(d.thumb)
    release(d.picture)
  },
  /** The workspace is closed: every drawing, and the board, go. */
  clear(): void {
    const s = drawingStore.getState()
    drawingStore.setState({ board: null, drawn: {}, opening: null })
    for (const d of Object.values(s.drawn)) drawingActions.spent(d)
    if (s.board) release(s.board.picture)
  }
}

/** Whether a drawing waits for this session's next prompt: closing the window would lose it. */
export function drawingWaits(sessionId: string): boolean {
  return drawingStore.getState().drawn[sessionId] !== undefined
}
```

- [ ] **Step 2: Register the host** in `ViewportPane.tsx` `connect()`, after `setPictures(...)`:

```ts
  // What a drawing on the view asks of it: the camera, what the screen shows (while that holds, a point of the
  // picture is the same point of the canvas: the picture has the canvas's camera and aspect), and what is under points.
  setViewHost({
    camera: () => viewport.getCamera(),
    shows: () => {
      const s = store.getState()
      const box = canvasBox(viewport)
      const scans = viewport.scanState().map(({ id, visible, opacity }) => [id, visible, opacity])
      return JSON.stringify([s.objectId, s.revision, s.layout, viewport.getCamera(), Math.round(box.width), Math.round(box.height), s.section, explodeNow(s), viewport.exploded(), visibleKeys(s), scans])
    },
    under: (points) => {
      const box = canvasBox(viewport)
      return points.map(([fx, fy]) => {
        const x = box.left + fx * box.width
        const y = box.top + fy * box.height
        const hit = viewport.pick(x, y, { edges: false })
        if (hit) return { ref: hit.ref }
        const scan = viewport.pickScan(x, y)
        return scan ? { scan: scan.scan } : null
      })
    }
  })
```

and `setViewHost(null)` beside `setPictures(null)` in the teardown. Import `setViewHost` from `'../state/drawing'`.
- [ ] **Step 3: Run** `pnpm -C app typecheck` and `pnpm -C app exec vitest run src/renderer`: PASS.
- [ ] **Step 4: Commit** `"The drawing's store, and what the viewport tells a drawing: its camera, what it shows and what is under a point"`.

### Task 7: Making a picture and a drawing, and the board over the view

**Files:**
- Create: `app/src/renderer/ui/drawing/compose.ts`, `app/src/renderer/ui/drawing/make.ts`, `app/src/renderer/ui/drawing/ViewBoard.tsx`
- Modify: `app/src/renderer/App.tsx` (`<ViewBoard />` beside `<ExportSheet />`)

**Interfaces:**
- Consumes: `picture` (`state/agent.ts`), `describe` (`state/descriptors.ts`), `viewHost`, `drawingActions`,
  `drawingStore` (Task 6), `underInk` (Task 5), `paintStrokes`, `InkLook` (Task 4), `Board` (Task 4).
- Produces: `drawingPng(ground, size, strokes, look): Promise<{ png: Uint8Array; inked(x, y): boolean }>`;
  `openDrawing(sessionId): Promise<void>` (rejects with why); `finishDrawing(strokes): Promise<void>`; `ViewBoard()`.

- [ ] **Step 1: `compose.ts`:**

```ts
import type { Stroke } from '../../state/onboard'
import { type InkLook, paintStrokes } from '../board/strokes'

/**
 * The picture of a drawing on the view: the ground (the agent's picture of the view) with the ink over it, a PNG of
 * its size; and where ink is left, read from the ink alone, so that what the eraser took is not looked under.
 */
export async function drawingPng(ground: CanvasImageSource, size: { width: number; height: number }, strokes: readonly Stroke[], look: InkLook): Promise<{ png: Uint8Array; inked: (x: number, y: number) => boolean }> {
  const ink = new OffscreenCanvas(size.width, size.height)
  const inkCtx = ink.getContext('2d')!
  paintStrokes(inkCtx, strokes, look)
  const alpha = inkCtx.getImageData(0, 0, size.width, size.height).data
  const inked = (x: number, y: number): boolean => {
    const px = Math.round(x)
    const py = Math.round(y)
    return px >= 0 && py >= 0 && px < size.width && py < size.height && alpha[(py * size.width + px) * 4 + 3] > 0
  }
  const sheet = new OffscreenCanvas(size.width, size.height)
  const ctx = sheet.getContext('2d')!
  ctx.drawImage(ground, 0, 0, size.width, size.height)
  ctx.drawImage(ink, 0, 0)
  const blob = await sheet.convertToBlob({ type: 'image/png' })
  return { png: new Uint8Array(await blob.arrayBuffer()), inked }
}
```

- [ ] **Step 2: `make.ts`:**

```ts
import type { ViewDrawing } from '../../../shared/drawing'
import { picture } from '../../state/agent'
import { describe } from '../../state/descriptors'
import { type Pictured, drawingActions, drawingStore, viewHost } from '../../state/drawing'
import type { Stroke } from '../../state/onboard'
import { store } from '../../state/store'
import { drawingPng } from './compose'
import { underInk } from './under'

/** The long edge of the picture drawn on: the agent's picture at its default. */
const DRAWING_SIZE = 1280
/** How long the kernel's lines for the faces under the ink are waited for. */
const DESCRIBE_MS = 3000
const ELSEWHERE = 'The view shows another object than this chat is of'

const token = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/**
 * Opens the board over the picture the agent's `look` makes of the view as it is now, for a chat of the object
 * open. Rejects with why there is none (no build, no 3D view, another object), opening nothing.
 */
export async function openDrawing(sessionId: string): Promise<void> {
  const s = drawingStore.getState()
  if (s.board || s.opening) return
  const { objectId, sessions } = store.getState()
  if (objectId === null || sessions[objectId]?.sessionId !== sessionId) throw new Error(ELSEWHERE)
  drawingActions.opening(sessionId)
  try {
    const host = viewHost()
    if (!host) throw new Error('the torno window has no 3D view to draw it with')
    const before = host.shows()
    const look = await picture({ view: 'current', size: DRAWING_SIZE })
    const after = host.shows()
    if (look.objectId !== objectId || store.getState().objectId !== objectId) throw new Error(ELSEWHERE)
    const blob = new Blob([look.png as BlobPart], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const pictured: Pictured = {
      url: URL.createObjectURL(blob), bitmap, width: look.width, height: look.height,
      objectId, revision: look.revision, layout: look.layout ?? store.getState().layout, caption: look.caption, camera: host.camera(),
      ink: token('--drawing-ink', '#B5127A'), casing: token('--panel', '#FAF9F6'),
      // The camera may have been on its way somewhere: then no point of the picture is known to be over what it shows.
      shows: before === after ? after : null
    }
    drawingActions.openOn(sessionId, pictured)
  } finally {
    drawingActions.opening(null)
  }
}

/** The kernel's line for each face, those that come within `DESCRIBE_MS`. */
async function described(p: Pictured, refs: string[]): Promise<Map<string, string>> {
  const lines = new Map<string, string>()
  const asked = Promise.all(refs.map(async (ref) => {
    const line = await describe(p.objectId, p.revision, p.layout, ref)
    if (line) lines.set(ref, line)
  }))
  await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, DESCRIBE_MS))])
  return new Map(lines)
}

/**
 * "Done" on the board over the view: the picture with the ink is made, and, while the screen is what the picture was
 * made of, what the ink lies over; the drawing then waits for the session's next prompt.
 */
export async function finishDrawing(strokes: Stroke[]): Promise<void> {
  const board = drawingStore.getState().board
  if (!board) return
  const p = board.picture
  const size = { width: p.width, height: p.height }
  const { png, inked } = await drawingPng(p.bitmap, size, strokes, { ink: p.ink, casing: p.casing })
  let under: ViewDrawing['under'] = null
  let more = 0
  const host = viewHost()
  if (host && p.shows !== null && host.shows() === p.shows) {
    const found = underInk(strokes, size, inked, (points) => host.under(points.map(([x, y]) => [x / p.width, y / p.height] as const)))
    const lines = await described(p, [...new Set(found.under.flatMap((s) => s.refs.map((r) => r.ref)))])
    under = found.under.map((s) => ({ ...s, refs: s.refs.map((r) => (lines.has(r.ref) ? { ref: r.ref, descriptor: lines.get(r.ref)! } : r)) }))
    more = found.more
  }
  const drawing: ViewDrawing = { objectId: p.objectId, revision: p.revision, layout: p.layout, caption: p.caption, camera: p.camera, png, width: p.width, height: p.height, ink: p.ink, under, ...(more > 0 ? { moreStrokes: more } : {}) }
  drawingActions.keep(board.sessionId, { picture: p, strokes, drawing, thumb: URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })) })
}
```

- [ ] **Step 3: `ViewBoard.tsx`:**

```tsx
import { drawingActions, useDrawing } from '../../state/drawing'
import { Board } from '../board/Board'
import { finishDrawing } from './make'

/**
 * The board over a picture of the view (the chat's "Draw on view"), while one is open: the agent's own picture of the
 * view under the ink, which is a colour of its own over a casing. Over the whole window, as the export sheet is.
 */
export function ViewBoard() {
  const board = useDrawing((s) => s.board)
  if (!board) return null
  const { picture } = board
  return (
    <Board
      title="Draw on the view"
      label="Drawing on the view"
      hint="Ring it, point at it, sketch beside it. Claude gets this picture with your ink, and what the ink lies over."
      size={{ width: picture.width, height: picture.height }}
      ground={picture.url}
      look={() => ({ ink: picture.ink, casing: picture.casing })}
      initial={board.strokes}
      discard={{ label: 'Discard this drawing?', text: 'Discard this drawing? What was drawn since it was opened is not kept.' }}
      onDone={finishDrawing}
      onCancel={() => drawingActions.cancel()}
    />
  )
}
```

- [ ] **Step 4: Mount** in `App.tsx`, inside `<main className="viewport">` after `<ExportSheet />`: `{/* Over the view: a drawing on it for the chat, while its board is open. */}` `<ViewBoard />`.
- [ ] **Step 5: Run** `pnpm -C app typecheck` and `pnpm -C app exec vitest run src/renderer`: PASS.
- [ ] **Step 6: Commit** `"The board over the view: the agent's picture of it as the ground; Done makes the picture with the ink and what the ink lies over, while the screen still shows what it was made of"`.

### Task 8: "Draw on view" in the composer

**Files:**
- Modify: `app/src/renderer/ui/chat/Composer.tsx`, `app/src/renderer/styles/chat.css`

**Interfaces:**
- Consumes: `openDrawing` (Task 7), `useDrawing`, `drawingActions`, `drawingWaits` (Task 6), `chat.send` with `drawing` (Task 3).

- [ ] **Step 1: Composer.** Imports: `import { drawingActions, drawingWaits, useDrawing } from '../../state/drawing'`, `import { openDrawing } from '../drawing/make'`.
  - `unsentPrompts`: `if ((drafts.get(id) ?? '').trim() !== '' || drawingWaits(id)) n += 1`; its doc: "a prompt written in their box, or a drawing on the view waiting for it, and not sent".
  - `clearDrafts`: also `drawingActions.clear()`; its doc names the drawings.
  - In `Composer`: `const drawn = useDrawing((s) => s.drawn[sessionId])` and `const opening = useDrawing((s) => s.opening === sessionId)`.
  - `send()`:

```ts
  async function send(): Promise<void> {
    const prompt = text.trim()
    if (prompt === '' || !live) return
    const withView = attach
    // The drawing goes with this prompt and with no other; given back if the prompt is not sent.
    const drawing = drawingActions.taken(sessionId)
    setText('')
    setAttach(false)
    setProblem(null)
    onSent()
    try {
      await window.torno.chat.send(sessionId, { text: prompt, attachView: withView, ...(drawing ? { drawing: drawing.drawing } : {}) })
      if (drawing) drawingActions.spent(drawing)
    } catch (e) {
      // Nothing was sent: what was written is given back, unless more has been written since.
      setText((now) => (now === '' ? prompt : now))
      setAttach(withView)
      if (drawing) drawingActions.giveBack(sessionId, drawing)
      setProblem(reason(e))
    }
  }
```

  - Above `<div className="chat-composer">`, the drawing that waits:

```tsx
      {drawn && (
        <div className="chat-drawing" role="group" aria-label="Drawing on the view">
          <img src={drawn.thumb} alt="" draggable={false} />
          <span className="chat-drawing-what">Your drawing on the view goes with your next prompt</span>
          <button type="button" className="button button-quiet" onClick={() => drawingActions.edit(sessionId)}>
            Edit
          </button>
          <button type="button" className="button button-quiet" onClick={() => drawingActions.remove(sessionId)}>
            Remove
          </button>
        </div>
      )}
```

  - After "Attach view":

```tsx
          <button
            type="button"
            className="button"
            disabled={!live || opening || drawn !== undefined}
            title={drawn ? 'A drawing goes with your next prompt: edit it or remove it above' : 'Draw over a picture of the view as it is now; the picture goes with the next prompt'}
            onClick={() => {
              setProblem(null)
              openDrawing(sessionId).catch((e: unknown) => setProblem(reason(e)))
            }}
          >
            Draw on view
          </button>
```

  - The doc comment of `Composer` adds: "'Draw on view' opens a board over a picture of the view; the drawing waits above the box until it goes with the next prompt."
- [ ] **Step 2: CSS** in `chat.css` after `.chat-actions`:

```css
/* A drawing on the view that goes with the next prompt: its picture small, what it is, Edit and Remove. */
.chat-drawing {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.chat-drawing img {
  flex: none;
  height: 40px;
  border: var(--divider);
  border-radius: 4px;
}

.chat-drawing-what {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: var(--text-small);
}
```

  If the four buttons do not fit beside the box at the default pane (look at the `chat` capture in Task 10),
  `.chat-actions` gets `flex-wrap: wrap; justify-content: flex-end; max-width: 50%`.
- [ ] **Step 3: Run** `pnpm -C app typecheck`, `pnpm -C app exec vitest run src/renderer`: PASS.
- [ ] **Step 4: Commit** `"Draw on view in the chat's composer: the drawing waits above the box with Edit and Remove, goes with the next prompt only, and is given back if the prompt is not sent"`.

### Task 9: In the hidden window

**Files:**
- Modify: `app/e2e/chatask.spec.ts` (after the "Attach view" test), `app/e2e/themes.spec.ts` (state `view-board`)

- [ ] **Step 1: Write the e2e tests** in `chatask.spec.ts` (the session of `bracket` is live after the Attach view test):

```ts
/** Draws a line on the board between two fractions of its canvas, with real pointer events. */
async function line(board: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await board.locator('canvas').boundingBox())!
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 10 })
  await page.mouse.up()
}
const drawingBoard = () => page.getByRole('dialog', { name: 'Drawing on the view' })
const drawButton = () => dock().getByRole('button', { name: 'Draw on view' })
const waiting = () => dock().getByRole('group', { name: 'Drawing on the view' })

test('Draw on view: a board over the agent\'s picture of the view; the drawing goes with the next prompt only, with what its ink lies over', async () => {
  // Where the view draws a part: the middle of its box, as a fraction of the canvas, which is the same fraction of the picture.
  const s = await state()
  const part = s.scene!.parts.find((p) => p.layout === s.layout)!
  const middle = part.bbox.min.map((v, i) => (v + part.bbox.max[i]) / 2) as [number, number, number]
  const [fx, fy] = await page.evaluate((point) => window.__tornoTest!.project(point), middle)
  const hit = await page.evaluate(([x, y]) => window.__tornoTest!.pickAt(x, y), [fx, fy])
  expect(hit?.part).toBe(part.name)

  await drawButton().click()
  await expect(drawingBoard()).toBeVisible()
  const canvas = drawingBoard().locator('canvas')
  expect(Math.max(Number(await canvas.getAttribute('width')), Number(await canvas.getAttribute('height')))).toBe(1280)
  await line(drawingBoard(), [fx - 0.03, fy], [fx + 0.03, fy])
  await expect(canvas).toHaveAttribute('data-strokes', '1')
  // Escape asks before what was drawn is thrown away; "Keep drawing" goes on.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Keep drawing' }).click()
  await expect(drawingBoard()).toBeVisible()
  await drawingBoard().getByRole('button', { name: 'Done' }).click()
  await expect(drawingBoard()).toHaveCount(0)
  await expect(waiting()).toBeVisible()
  await expect(drawButton()).toBeDisabled()

  await say('images')
  await expect(waiting()).toHaveCount(0)
  const user = chat().locator('.chat-user').last()
  await expect(user.locator('.chat-thumb')).toHaveCount(1, { timeout: 20_000 })
  await expect(user).not.toContainText('Picture:')
  // The stand-in says the size of each picture, then each line of the caption.
  await expect(chat()).toContainText(/images: 1 (1280x\d+|\d+x1280)/, { timeout: 20_000 })
  await expect(chat()).toContainText('Picture: the view as the person saw it when they drew on it')
  await expect(chat()).toContainText('Under the ink, stroke by stroke')
  await expect(chat()).toContainText(new RegExp(`stroke 1, x \\d+–\\d+, y \\d+–\\d+: ${part.name}/F\\d+`))
  await finished()
  await expect(drawButton()).toBeEnabled()

  // The next prompt carries none.
  await say('images')
  await expect(chat().locator('.chat-text').last()).toContainText('images: 0')
  await finished()
})

test('a drawing waits in the composer: Edit opens it with its strokes, Remove takes it away, and a board left alone keeps nothing', async () => {
  await drawButton().click()
  await line(drawingBoard(), [0.2, 0.2], [0.4, 0.3])
  await drawingBoard().getByRole('button', { name: 'Done' }).click()
  await waiting().getByRole('button', { name: 'Edit' }).click()
  await expect(drawingBoard().locator('canvas')).toHaveAttribute('data-strokes', '1')
  // Nothing drawn since it was opened: Escape puts it away without asking, and the drawing still waits.
  await page.keyboard.press('Escape')
  await expect(drawingBoard()).toHaveCount(0)
  await expect(waiting()).toBeVisible()
  await waiting().getByRole('button', { name: 'Remove' }).click()
  await expect(waiting()).toHaveCount(0)

  // A board with a stroke that is discarded leaves nothing waiting.
  await drawButton().click()
  await line(drawingBoard(), [0.2, 0.2], [0.4, 0.3])
  await drawingBoard().getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(drawingBoard()).toHaveCount(0)
  await expect(waiting()).toHaveCount(0)
})
```

- [ ] **Step 2: `themes.spec.ts`:** add `'view-board'` to `STATES`; its branch, beside `chat`:

```ts
        } else if (shot === 'view-board') {
          // The board over the view, a ring and an arrow drawn on it, from the chat's "Draw on view".
          await page.locator('[data-region="session"]').getByRole('button', { name: 'New session' }).click()
          await expect(page.locator('[data-chat-composer]')).toBeFocused()
          await page.locator('[data-region="session"]').getByRole('button', { name: 'Draw on view' }).click()
          const board = page.getByRole('dialog', { name: 'Drawing on the view' })
          const box = (await board.locator('canvas').boundingBox())!
          const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]
          await board.getByRole('button', { name: 'Thick pen' }).click()
          const ring = Array.from({ length: 25 }, (_, i) => [0.5 + 0.12 * Math.cos((i / 24) * Math.PI * 2), 0.5 + 0.16 * Math.sin((i / 24) * Math.PI * 2)])
          for (const points of [ring, [[0.85, 0.15], [0.66, 0.36]], [[0.66, 0.36], [0.72, 0.36]], [[0.66, 0.36], [0.66, 0.3]]]) {
            await page.mouse.move(...at(points[0][0], points[0][1]))
            await page.mouse.down()
            for (const [fx, fy] of points.slice(1)) await page.mouse.move(...at(fx, fy), { steps: 4 })
            await page.mouse.up()
          }
```

- [ ] **Step 3: Build and run:** `pnpm -C app build` then `pnpm -C app exec playwright test e2e/chatask.spec.ts`: PASS.
- [ ] **Step 4: Commit** `"e2e: Draw on view, from the composer's button to what the stand-in agent is given; a themes capture of the board over the view"`.

### Task 10: Documented, looked at, and every suite

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `app/src/main/CLAUDE.md`, `app/src/renderer/CLAUDE.md`, `app/e2e/CLAUDE.md`, `docs/superpowers/specs/2026-10-08-torno-design.md`

- [ ] **Step 1: README.** In "The chat", after "Attach view": a bullet **"Draw on view"**: a board over the
  picture of the view the agent would get (axes, scale bar, mark numbers), pens, eraser, Undo/`Ctrl+Z`, Clear; the ink
  is magenta, no mark's colour; Done puts it above the box with Edit and Remove; it goes with the next prompt only,
  with a caption saying it is your drawing, where the view was seen from, and stroke by stroke the faces, parts and
  scans the ink lies over (by ref with the kernel's line; no coordinates), and when the model was built since. Not
  in the terminal view; never written. "Making a new object": the doodle board is the same board. "Not yet verified on
  a visible screen": a bullet for drawing on the view with a mouse and a pen and the real Claude Code.
- [ ] **Step 2: CLAUDE.md files.** Root, under "What crosses processes", the Claude Code bullet: a drawing on the
  view goes with one prompt of the chat as a picture after a caption main writes (`main/sessions/drawing.ts`); it
  carries refs and the kernel's lines, never a coordinate of the mesh; kept nowhere. `app/src/main/CLAUDE.md`
  (Agents): `chat:send`'s `drawing`, `drawingOf`, `drawingText`, the order text, caption, picture, attach-view picture;
  the object check in `sendOne`; `checkedImage` in `main/images.ts`. `app/src/renderer/CLAUDE.md`: under "A new
  object" the board is `ui/board/Board.tsx` (Ctrl+Z `board.undo` in the scope `sheet`); under "Agents" the chat pane's
  "Draw on view" (`state/drawing.ts`, `ui/drawing/`: the ground is the agent's picture, the ink `--drawing-ink` over a
  casing, what the ink lies over only while `ViewHost.shows()` holds, faces only then scans, the descriptors waited 3 s,
  the drawing waits per session, counts as unsent, cleared with the workspace); under "Light and dark" the token.
  `app/e2e/CLAUDE.md`: the `view-board` state.
- [ ] **Step 3: Design spec,** section 6, under "Three ways information reaches the agent": a dated line pointing to
  `2026-10-16-torno-draw-on-view-design.md`.
- [ ] **Step 4: Every suite:** `pnpm test`, `pnpm test:kernel`, `(cd kernel && uv run pytest -q)`, `pnpm test:e2e`,
  `pnpm -C app typecheck`. All PASS, output read.
- [ ] **Step 5: Look at it:** `TORNO_SHOTS=<scratch dir> pnpm -C app exec playwright test e2e/themes.spec.ts -g "view-board|chat"`
  and open `ui-view-board-light.png`, `ui-view-board-dark.png`, `ui-chat-*.png`: the ink reads on parts and ground
  in both themes, the board's picture is not stretched, the composer's buttons fit.
- [ ] **Step 6: Commit** `"Docs: drawing on the view (README, CLAUDE.md of the root, main, the window and e2e; the design spec)"`.
